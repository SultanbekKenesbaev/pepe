import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import type { IntegrationTransport } from '../server/integrations.js';
import { webhookSignature } from '../server/integration-security.js';
import { uid, now } from '../server/security.js';

test('HTTP integration webhooks persist, retry, isolate configuration, survive restart and close without AI',{timeout:60000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'integration-webhooks-'));
  type Delivery={url:string;secret:string;id:string;body:string;aborted:boolean};
  type Receipt={id:string;body:string;signature:string};
  const deliveries:Delivery[]=[],receipts:Receipt[]=[];
  let receiverStatus=204,mode:'http'|'hang'='http',started:(()=>void)|undefined,providerCalls=0;
  const receiver=createServer(async(req,res)=>{
    const bytes:Buffer[]=[];for await(const chunk of req)bytes.push(Buffer.from(chunk));
    receipts.push({id:String(req.headers['x-routemotion-event-id']),signature:String(req.headers['x-routemotion-signature']),body:Buffer.concat(bytes).toString('utf8')});
    res.writeHead(receiverStatus);res.end();
  });
  receiver.listen(0,'127.0.0.1');await new Promise<void>(resolve=>receiver.on('listening',resolve));
  const receiverUrl=`http://127.0.0.1:${(receiver.address() as any).port}/events`;
  const integrationTransport:IntegrationTransport={disableTimer:true,
    resolve:async value=>({url:new URL(value),address:'8.8.8.8',family:4}),
    deliver:async(url,secret,id,body,signal)=>{
      const delivery={url,secret,id,body,aborted:!!signal?.aborted};deliveries.push(delivery);
      signal?.addEventListener('abort',()=>{delivery.aborted=true;},{once:true});started?.();
      // Test-only constructor transport: real local HTTP, without weakening production HTTPS/DNS policy.
      if(mode==='hang')return new Promise<number>(()=>{}); // Deliberately ignores abort; the outbox must still close.
      const timestamp=Math.floor(Date.now()/1000),response=await fetch(receiverUrl,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Routemotion-Event-Id':id,'X-Routemotion-Signature':webhookSignature(secret,timestamp,body)},body});
      await response.arrayBuffer();return response.status;
    },
  };
  const options={dataDir:temporary,seedDemo:true,integrationTransport,generation:{
    codexScriptProvider:async()=>{providerCalls++;throw new Error('Unexpected AI request in an outbox fixture');},
    codexVisualProvider:async()=>{providerCalls++;throw new Error('Unexpected render request in an outbox fixture');},
    voiceProvider:async()=>{providerCalls++;throw new Error('Unexpected voice request in an outbox fixture');},
  }};
  let app=await createApp(options),server=app.listen(0,'127.0.0.1'),closed=false;
  await new Promise<void>(resolve=>server.on('listening',resolve));let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string};let admin:Client;
  const call=async(client:Client|undefined,url:string,method='GET',body?:unknown,bearer?:string)=>{
    const response=await fetch(base+url,{method,headers:{...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return{status:response.status,data:response.status===204?undefined:await response.json() as any,response};
  };
  const login=async()=>{const result=await call(undefined,'/api/auth/login','POST',{email:'admin@aiteacher.local',password:'PepeOnly-admin-2026!'});assert.equal(result.status,200);return{cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken};};
  const makeIntegration=async(name:string)=>{const result=await call(admin,'/api/integrations','POST',{name});assert.equal(result.status,201);const key=await call(admin,`/api/integrations/${result.data.id}/keys`,'POST',{});assert.equal(key.status,201);return{id:result.data.id,key:key.data.key as string};};
  const configure=async(id:string,url:string|null)=>{const result=await call(admin,`/api/integrations/${id}/webhook`,'POST',{url});assert.equal(result.status,200);return result.data.signingSecret as string|undefined;};
  const fixtureJob=async(integrationId:string,status:'ready'|'failed'|'language_review'|'generating',tx:DB=app.locals.db,createdAt=now())=>{
    // Explicit persisted outbox fixtures; no model, audio or renderer is invoked or claimed to have run.
    const id='gen_'+uid(),generationId=uid(),revision=7;
    const input={topic:'Производная — Қарақалпақ',language:status==='language_review'?'kaa':'ru',file_ids:[],metadata:{course:'Математика',note:'first\nsecond'}};
    const lesson={id:generationId,institutionId:'demo-school',teacherId:'demo-admin',subjectId:'demo-biology',title:input.topic,summary:'Synthetic webhook fixture',engine:'codex',language:input.language,status,revision,chapters:status==='language_review'?[{id:'chapter-1',title:'Глава',narration:'Текст для языковой проверки',audioUrl:'/synthetic-not-a-real-audio-file'}]:[],duration:600,progress:{stage:status,completed:1,total:1},createdAt,updatedAt:createdAt,...(status==='ready'?{artifact:{duration:600,width:1280,height:720,fps:24,sha256:'a'.repeat(64)}}:{}),...(status==='failed'?{error:'Synthetic preparation failure'}:{})};
    await tx.query('INSERT INTO generated_lessons(id,institution_id,teacher_id,material_id,revision,data) VALUES($1,$2,$3,NULL,$4,$5)',[generationId,'demo-school','demo-admin',revision,lesson]);
    await tx.query('INSERT INTO api_integration_jobs(id,integration_id,generation_id,created_at,data) VALUES($1,$2,$3,$4,$5)',[id,integrationId,generationId,createdAt,{input,createdAt,updatedAt:createdAt,dispatchStatus:'accepted',operationActive:false}]);
    return{id,generationId,revision};
  };
  const event=async(jobId:string)=>(await app.locals.db.query('SELECT * FROM api_webhook_events WHERE job_id=$1',[jobId])).rows[0];
  const due=async(eventId:string)=>app.locals.db.query("UPDATE api_webhook_events SET next_at=NOW()-INTERVAL '1 second' WHERE id=$1",[eventId]);
  const reopen=async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();closed=true;
    app=await createApp({...options,seedDemo:false});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;closed=false;admin=await login();
  };
  try{
    admin=await login();const integration=await makeIntegration('Webhook fixture'),foreign=await makeIntegration('Separate partner');
    let signingSecret=(await configure(integration.id,'https://callbacks.example.com/first'))!;
    await t.test('terminal states produce one signed HTTP notification per revision and remain scoped',async()=>{
      const jobs=await Promise.all(['ready','failed','language_review'].map(status=>fixtureJob(integration.id,status as any)));
      const active=await fixtureJob(integration.id,'generating');
      await Promise.all([app.locals.integrationTick(),app.locals.integrationTick(),app.locals.integrationTick()]);
      assert.equal(receipts.length,3);assert.equal(deliveries.length,3);assert.equal(await event(active.id),undefined);
      for(const job of jobs){const stored=await event(job.id);assert.equal(stored.status,'delivered');assert.equal(stored.attempts,1);assert.equal(stored.last_status,204);
        const received=receipts.find(item=>item.id===stored.id)!;assert.equal(received.body,stored.body);const parsed=JSON.parse(received.body);
        assert.equal(parsed.data.id,job.id);assert.equal(parsed.data.revision,job.revision);assert.equal(parsed.data.topic,'Производная — Қарақалпақ');assert.equal(parsed.data.metadata.note,'first\nsecond');
        const [timestamp,signature]=received.signature.split(',');assert.match(timestamp,/^t=\d+$/);assert.equal(signature,'v1='+createHmac('sha256',signingSecret).update(timestamp.slice(2)+'.').update(Buffer.from(received.body)).digest('hex'));
        assert.equal((await call(undefined,`/api/v1/generations/${job.id}`,'GET',undefined,integration.key)).status,200);assert.equal((await call(undefined,`/api/v1/generations/${job.id}`,'GET',undefined,foreign.key)).status,404);
      }
      await app.locals.integrationTick();assert.equal(deliveries.length,3);
      await app.locals.db.query('DELETE FROM api_integration_jobs WHERE id=$1',[active.id]);await app.locals.db.query('DELETE FROM generated_lessons WHERE id=$1',[active.generationId]);
      const adminEvents=await call(admin,`/api/integrations/${integration.id}/events`);assert.equal(adminEvents.status,200);assert.equal(JSON.stringify(adminEvents.data).includes(signingSecret),false);
    });
    await t.test('503 is durable backoff and retry keeps exactly the same event ID and UTF-8 body',async()=>{
      receiverStatus=503;const job=await fixtureJob(integration.id,'failed'),before=deliveries.length;await app.locals.integrationTick();
      const first=await event(job.id);assert.equal(first.status,'pending');assert.equal(first.attempts,1);assert.equal(first.last_status,503);assert.ok(Date.parse(first.next_at)>Date.now());
      await app.locals.integrationTick();assert.equal(deliveries.length,before+1,'Future backoff must not be delivered early');
      await due(first.id);receiverStatus=204;await app.locals.integrationTick();const second=await event(job.id);
      assert.equal(second.status,'delivered');assert.equal(second.attempts,2);assert.equal(second.id,first.id);assert.equal(second.body,first.body);
      assert.deepEqual(deliveries.slice(before).map(({id,body})=>({id,body})),[{id:first.id,body:first.body},{id:first.id,body:first.body}]);
    });
    await t.test('eight failed deliveries terminate instead of becoming an endless retry',async()=>{
      receiverStatus=500;const job=await fixtureJob(integration.id,'failed'),before=deliveries.length;
      for(let attempt=1;attempt<=8;attempt++){if(attempt>1)await due((await event(job.id)).id);await app.locals.integrationTick();const current=await event(job.id);assert.equal(current.attempts,attempt);assert.equal(current.status,attempt===8?'failed':'pending');}
      await app.locals.integrationTick();assert.equal(deliveries.length,before+8);assert.equal((await event(job.id)).last_status,500);receiverStatus=204;
    });
    await t.test('rotation cancels old pending events and disabling an integration prevents delivery',async()=>{
      receiverStatus=503;const old=await fixtureJob(integration.id,'failed');await app.locals.integrationTick();const oldEvent=await event(old.id),before=deliveries.length;
      const previous=signingSecret;signingSecret=(await configure(integration.id,'https://callbacks.example.com/rotated'))!;assert.notEqual(signingSecret,previous);assert.equal((await event(old.id)).status,'cancelled');
      await due(oldEvent.id);receiverStatus=204;await app.locals.integrationTick();assert.equal(deliveries.length,before);
      const fresh=await fixtureJob(integration.id,'ready');await app.locals.integrationTick();assert.equal((await event(fresh.id)).status,'delivered');assert.equal(deliveries.at(-1)!.secret,signingSecret);assert.equal(deliveries.at(-1)!.url,'https://callbacks.example.com/rotated');
      receiverStatus=503;const disabled=await fixtureJob(integration.id,'failed');await app.locals.integrationTick();const disabledEvent=await event(disabled.id);assert.equal(disabledEvent.status,'pending');
      assert.equal((await call(admin,`/api/integrations/${integration.id}`,'PATCH',{active:false})).status,200);await due(disabledEvent.id);const count=deliveries.length;await app.locals.integrationTick();assert.equal(deliveries.length,count);assert.equal((await event(disabled.id)).status,'cancelled');
      assert.equal((await call(admin,`/api/integrations/${integration.id}`,'PATCH',{active:true})).status,200);receiverStatus=204;
    });
    await t.test('restart recovers an interrupted delivery with its original body and signing vault',async()=>{
      receiverStatus=503;const job=await fixtureJob(integration.id,'ready');await app.locals.integrationTick();const first=await event(job.id);
      await app.locals.db.query("UPDATE api_webhook_events SET status='sending',next_at=NOW() WHERE id=$1",[first.id]);
      await reopen();assert.equal((await event(job.id)).status,'pending');receiverStatus=204;await app.locals.integrationTick();const recovered=await event(job.id);
      assert.equal(recovered.status,'delivered');assert.equal(recovered.attempts,2);assert.equal(recovered.body,first.body);assert.equal(deliveries.at(-1)!.secret,signingSecret);assert.equal(deliveries.at(-1)!.id,first.id);assert.equal(providerCalls,0);
    });
    await t.test('more than 200 historical terminal jobs cannot starve a new terminal notification',async()=>{
      const config=(await app.locals.db.query('SELECT data FROM api_integrations WHERE id=$1',[integration.id])).rows[0].data;
      await app.locals.db.transaction(async(tx:DB)=>{for(let index=0;index<205;index++){
        const job=await fixtureJob(integration.id,'ready',tx,'2026-01-01T00:00:00.000Z');
        await tx.query("INSERT INTO api_webhook_events(id,integration_id,job_id,revision,kind,body,config_version,status,attempts) VALUES($1,$2,$3,$4,'generation.ready',$5,$6,'delivered',1)",['evt_'+uid(),integration.id,job.id,job.revision,JSON.stringify({fixture:true}),config.webhook.version]);
      }});
      const job=await fixtureJob(integration.id,'ready'),before=deliveries.length;await app.locals.integrationTick();assert.equal((await event(job.id)).status,'delivered');assert.equal(deliveries.length,before+1);
    });
    await t.test('shutdown aborts a noncooperative transport and persists a retriable event without starting AI',async()=>{
      mode='hang';const job=await fixtureJob(integration.id,'failed'),startedPromise=new Promise<void>(resolve=>{started=resolve;});
      const tick=app.locals.integrationTick();await startedPromise;started=undefined;
      await new Promise<void>(resolve=>server.close(()=>resolve()));const began=Date.now();await app.locals.close();closed=true;await tick;assert.ok(Date.now()-began<1500);assert.equal(deliveries.at(-1)!.aborted,true);
      app=await createApp({...options,seedDemo:false});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;closed=false;
      const saved=await event(job.id);assert.equal(saved.status,'pending');assert.equal(saved.attempts,1);assert.equal(saved.last_status,0);assert.equal(providerCalls,0);
    });
  }finally{
    if(!closed){await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();}
    await new Promise<void>(resolve=>receiver.close(()=>resolve()));await rm(temporary,{recursive:true,force:true});
  }
});
