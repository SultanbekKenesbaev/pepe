import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { createApp } from '../server/app.js';
import { pcmWave } from '../server/cinema.js';
import { passwordHash, hashToken, uid, now } from '../server/security.js';
import { canonicalJson } from '../server/integration-security.js';
import type { CodexScriptRequest } from '../server/codex-lessons.js';

// This suite exercises the complete HTTP/auth/database adapters. Providers below are trusted,
// synthetic local fixtures: the MP4-shaped bytes test streaming, not rendering or film quality.
test('external integration HTTP contract preserves organization scope, idempotency, quotas and restart',{timeout:120000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'integration-contract-'));
  const scripts:CodexScriptRequest[]=[],voices:string[]=[],visuals:string[]=[];
  const releases=new Map<string,()=>void>();let failRetryVisual=true;
  const videoBytes=Buffer.alloc(4096);videoBytes.writeUInt32BE(32,0);videoBytes.write('ftyp',4);videoBytes.write('isom',8);
  for(let index=32;index<videoBytes.length;index++)videoBytes[index]=index%251;
  const generation={voiceModel:'gemini-3.8-flash-tts',voice:'Puck',
    codexScriptProvider:async(request:CodexScriptRequest)=>{
      scripts.push(request);
      if(request.title.startsWith('Hold '))await new Promise<void>((resolve,reject)=>{
        const stop=()=>reject(new DOMException('Fixture stopped','AbortError'));
        request.signal.addEventListener('abort',stop,{once:true});
        releases.set(request.title,()=>{request.signal.removeEventListener('abort',stop);releases.delete(request.title);resolve();});
      });
      if(request.title.startsWith('Fail ')||request.title.startsWith('Hold '))throw new Error('Synthetic script failure; /private/provider-path and secret must never leak');
      return{title:request.title,summary:'Synthetic local integration fixture.',direction:'Пространственная учебная модель.',chapters:Array.from({length:3},(_,chapter)=>({id:`chapter-${chapter}`,title:`Глава ${chapter+1}`,scene:'custom' as const,headline:'Скорость изменения',labels:[],values:[],palette:'dark' as const,visualDirection:'Камера следует за моделью.',cues:Array.from({length:4},(_,cue)=>({id:`cue-${chapter}-${cue}`,text:`${request.title}. Учебный пример ${chapter+1}, реплика ${cue+1}: производная описывает скорость изменения.`,visualAction:'Модель показывает изменение синхронно с объяснением.'}))}))};
    },
    voiceProvider:async(chapter:any)=>{voices.push(chapter.narration);return pcmWave(Buffer.alloc(48000*48));},
    codexVisualProvider:async({lesson,dataDir}:any)=>{
      visuals.push(lesson.title);assert.equal(lesson.duration,600);
      if(lesson.title==='Retry fixture'&&failRetryVisual)throw new Error('Synthetic renderer failure');
      const file=path.join(dataDir,'generated',lesson.id,'fixture-artifact.mp4');await writeFile(file,videoBytes);
      return{file,duration:600,width:1280,height:720,fps:24,sha256:createHash('sha256').update(videoBytes).digest('hex')};
    },
  };
  const options={dataDir:temporary,seedDemo:true,generation,integrationTransport:{disableTimer:true,
    resolve:async()=>{assert.fail('No test may resolve a public webhook');},
    deliver:async()=>{assert.fail('No test may contact a webhook');},
  }};
  let app=await createApp(options),server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.on('listening',resolve));let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string};type Integration={id:string;key:string;keyId:string};
  type CallOptions={method?:string;body?:unknown;token?:string;session?:Client;headers?:Record<string,string>;raw?:string};
  const call=async(url:string,options:CallOptions={})=>{
    const method=options.method||'GET',body=options.raw??(options.body===undefined?undefined:options.body instanceof FormData?options.body:JSON.stringify(options.body));
    const response=await fetch(base+url,{method,headers:{...(options.session?{Cookie:options.session.cookie,'X-CSRF-Token':options.session.csrf}:{}),...(options.token?{Authorization:'Bearer '+options.token}:{}),...(body!==undefined&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers},body});
    const data=method==='HEAD'||response.status===204?undefined:(response.headers.get('content-type')||'').includes('application/json')?await response.json() as any:Buffer.from(await response.arrayBuffer());
    if(url==='/api/v1'||url.startsWith('/api/v1/')){assert.match(response.headers.get('X-Request-Id')||'',/^[-A-Za-z0-9_]{8,64}$/);assert.equal(response.headers.get('Cache-Control'),'no-store');}
    return{status:response.status,data,response};
  };
  const api=(integration:Integration|undefined,url:string,options:CallOptions={})=>call('/api/v1'+url,{...options,token:integration?.key});
  const error=(result:Awaited<ReturnType<typeof call>>,status:number,code?:string)=>{
    assert.equal(result.status,status,JSON.stringify(result.data));assert.equal(typeof result.data.error,'object');
    if(code)assert.equal(result.data.error.code,code);assert.equal(typeof result.data.error.message,'string');assert.equal(typeof result.data.error.retryable,'boolean');
    assert.equal(result.data.error.request_id,result.response.headers.get('X-Request-Id'));return result.data.error;
  };
  const login=async(email='admin@aiteacher.local',password='PepeOnly-admin-2026!'):Promise<Client>=>{
    const result=await call('/api/auth/login',{method:'POST',body:{email,password}});assert.equal(result.status,200,JSON.stringify(result.data));
    return{cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken};
  };
  let admin:Client,foreignAdmin:Client,teacher:Client;
  const makeIntegration=async(name:string,limits:Record<string,number>={},owner=admin):Promise<Integration>=>{
    const created=await call('/api/integrations',{method:'POST',session:owner,body:{name,limits:{requestsPerMinute:600,maxConcurrentJobs:4,jobsPerDay:1000,...limits}}});assert.equal(created.status,201,JSON.stringify(created.data));
    const issued=await call(`/api/integrations/${created.data.id}/keys`,{method:'POST',session:owner,body:{name:'HTTP fixture key'}});assert.equal(issued.status,201);
    assert.match(issued.data.key,/^rm_live_[A-Za-z0-9_-]{43}$/);return{id:created.data.id,key:issued.data.key,keyId:issued.data.record.id};
  };
  const upload=async(integration:Integration,text:string|Uint8Array,name='notes.txt',field='file')=>{
    const body=new FormData();body.append(field,new Blob([typeof text==='string'?text:new Uint8Array(text)]),name);return api(integration,'/files',{method:'POST',body});
  };
  const create=(integration:Integration,topic:string,key:string,extra:Record<string,unknown>={})=>api(integration,'/generations',{method:'POST',body:{topic,language:'ru',...extra},headers:{'Idempotency-Key':key}});
  const wait=async(integration:Integration,id:string,status:string)=>{
    for(let count=0;count<500;count++){const result=await api(integration,`/generations/${id}`);assert.equal(result.status,200,JSON.stringify(result.data));
      if(result.data.status===status)return result.data;if(result.data.status==='failed'&&status!=='failed')assert.fail(JSON.stringify(result.data));await new Promise(resolve=>setTimeout(resolve,25));}
    assert.fail('Timed out waiting for fixture status '+status);
  };
  let own:Integration,sameOrg:Integration,foreign:Integration,shared:Integration,material:any,ready:any,retryJob:any,kaa:any,kaaIntegration:Integration;
  const reopen=async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();
    app=await createApp({...options,seedDemo:false});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;
    admin=await login();foreignAdmin=await login('foreign-admin@example.test','Foreign2026!');
  };
  try{
    admin=await login();teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');
    const foreignUser={id:'integration-foreign-admin',institutionId:'demo-university',name:'Foreign administrator',email:'foreign-admin@example.test',role:'ADMIN',active:true};
    await app.locals.db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)',[foreignUser.id,foreignUser.institutionId,foreignUser.email,passwordHash('Foreign2026!'),foreignUser]);foreignAdmin=await login(foreignUser.email,'Foreign2026!');
    assert.equal((await call('/api/institutions/demo-school',{method:'PATCH',session:admin,body:{settings:{allowExternalAI:true}}})).status,200);
    assert.equal((await call('/api/institutions/demo-university',{method:'PATCH',session:foreignAdmin,body:{settings:{allowExternalAI:true}}})).status,200);
    own=await makeIntegration('Primary partner');sameOrg=await makeIntegration('Other partner same university');foreign=await makeIntegration('Foreign university',{},foreignAdmin);
    const second=await call(`/api/integrations/${own.id}/keys`,{method:'POST',session:admin,body:{name:'Rotated key'}});assert.equal(second.status,201);shared={id:own.id,key:second.data.key,keyId:second.data.record.id};

    await t.test('public specification is reachable without cookies and every failure has a request ID',async()=>{
      assert.equal((await api(undefined,'/health')).data.status,'ok');const docs=await api(undefined,'/docs');assert.equal(docs.status,200);assert.match(docs.data.toString(),/Routemotion API/);
      const spec=await api(undefined,'/openapi.json');assert.equal(spec.status,200);assert.equal(spec.data.openapi,'3.1.0');assert.ok(spec.data.paths['/generations']);
      error(await api(undefined,'/account'),401,'API_KEY_REQUIRED');error(await api(undefined,'/account',{session:admin}),401,'API_KEY_REQUIRED');
      for(const header of ['Bearer invalid','Basic abc','Bearer rm_live_'+'x'.repeat(43)])error(await call('/api/v1/account',{headers:{Authorization:header}}),401,'API_KEY_INVALID');
      const echoed=await api(own,'/account',{headers:{'X-Request-Id':'client-request-001'}});assert.equal(echoed.response.headers.get('X-Request-Id'),'client-request-001');
      const replaced=await api(own,'/account',{headers:{'X-Request-Id':'invalid spaces'}});assert.notEqual(replaced.response.headers.get('X-Request-Id'),'invalid spaces');
      error(await api(own,'/missing-route'),404,'NOT_FOUND');error(await api(own,'/generations',{method:'POST',raw:'{"topic":'}),400,'INVALID_JSON');
      error(await api(own,'/generations',{method:'POST',body:{topic:'x'.repeat(140000),language:'ru'}}),413,'PAYLOAD_TOO_LARGE');
      assert.equal((await call('/api/integrations',{token:own.key})).status,401);assert.equal((await call('/api/integrations',{session:teacher})).status,403);
      assert.equal((await call(`/api/integrations/${own.id}/keys`,{method:'POST',session:foreignAdmin,body:{}})).status,403);
      assert.equal((await call(`/api/integrations/${own.id}/webhook`,{method:'POST',token:own.key,body:{url:null}})).status,401);
    });

    await t.test('uploads retain exact private bytes, actual SHA, UTF-8 extraction and key sharing',async()=>{
      const text='Производная: мгновенная скорость.\nҚарақалпақ тілі — 2/3.\n';const result=await upload(own,text);assert.equal(result.status,201,JSON.stringify(result.data));material=result.data;
      assert.equal(material.object,'file');assert.equal(material.name,'notes.txt');assert.equal(material.size,Buffer.byteLength(text));assert.equal(material.textAvailable,true);assert.equal(material.extracted_characters,text.trim().length);assert.equal(material.sha256,createHash('sha256').update(text).digest('hex'));
      assert.equal(material.filename,undefined);assert.equal((await api(shared,`/files/${material.id}`)).data.id,material.id);
      const content=await api(shared,`/files/${material.id}/content`);assert.equal(content.status,200);assert.deepEqual(content.data,Buffer.from(text));
      error(await api(undefined,`/files/${material.id}/content`),401,'API_KEY_REQUIRED');
      for(const partner of [sameOrg,foreign]){error(await api(partner,`/files/${material.id}`),404,'NOT_FOUND');error(await api(partner,`/files/${material.id}/content`),404,'NOT_FOUND');}
      assert.equal((await upload(own,'value,unit\n12,m/s\n','measurements.csv')).status,201);
      const docx=zipSync({'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>Derivative &amp; motion</w:t></w:r></w:p></w:body></w:document>')});assert.equal((await upload(own,docx,'notes.docx')).status,201);
      assert.equal(scripts.length,0,'Uploading sources must not start a provider');
    });

    await t.test('upload parser rejects extra fields, invalid bytes, empty documents and exact size boundaries',async()=>{
      error(await api(own,'/files',{method:'POST',body:new FormData()}),400,'FILE_REQUIRED');error(await upload(own,'valid text','notes.txt','files'),400,'INVALID_UPLOAD');
      error(await upload(own,'image bytes','image.png'),415,'UNSUPPORTED_FILE');error(await upload(own,'   \n\t'),422,'NO_EXTRACTABLE_TEXT');
      error(await upload(own,new Uint8Array([0xff,0xfe,0x80])),422,'INVALID_DOCUMENT');error(await upload(own,new Uint8Array([97,0,98])),422,'INVALID_DOCUMENT');
      const exact=await upload(own,'x'.repeat(150000),'exact-text-limit.txt');assert.equal(exact.status,201);assert.equal(exact.data.extracted_characters,150000);
      error(await upload(own,'x'.repeat(150001)),422,'DOCUMENT_TOO_LARGE');error(await upload(own,new Uint8Array(25*1024*1024+1)),413,'FILE_TOO_LARGE');
      const multiple=new FormData();multiple.append('file',new Blob(['first']),'a.txt');multiple.append('file',new Blob(['second']),'b.txt');error(await api(own,'/files',{method:'POST',body:multiple}),400,'INVALID_UPLOAD');
      const extraField=new FormData();extraField.append('file',new Blob(['text']),'a.txt');extraField.append('institutionId','demo-university');error(await api(own,'/files',{method:'POST',body:extraField}),400,'INVALID_UPLOAD');
      assert.equal(scripts.length,0);
    });

    await t.test('strict generation validation and required idempotency headers reserve no work',async()=>{
      const valid={topic:'Производная',language:'ru'};
      for(const key of [undefined,'short','contains space','x'.repeat(129),'key.with.period'])error(await api(own,'/generations',{method:'POST',body:valid,headers:key?{'Idempotency-Key':key}:{}}),400,'IDEMPOTENCY_REQUIRED');
      const invalid=[{topic:' x '},{topic:'x'.repeat(201)},{language:'de'},{video_mode:'4d'},{file_ids:Array(13).fill(material.id)},{file_ids:[material.id,material.id]},{file_ids:['../escape']},{external_teacher_id:''},{external_teacher_id:'x'.repeat(201)},{institutionId:'demo-university'},{teacherId:'demo-teacher'},{metadata:{deep:{nested:true}}},{metadata:Object.fromEntries(Array.from({length:21},(_,index)=>['k'+index,index]))},{metadata:{['x'.repeat(65)]:true}},{metadata:{a:'x'.repeat(501)}},{metadata:Object.fromEntries(Array.from({length:10},(_,index)=>['k'+index,'x'.repeat(450)]))}];
      for(let index=0;index<invalid.length;index++)error(await api(own,'/generations',{method:'POST',body:{...valid,...invalid[index]},headers:{'Idempotency-Key':'invalid-body-'+index}}),422,'INVALID_REQUEST');
      error(await create(sameOrg,'Forbidden source','foreign-source-001',{file_ids:[material.id]}),404,'NOT_FOUND');
      assert.equal(scripts.length,0);assert.equal((await api(own,'/account')).data.usage.totalJobs,0);
    });

    await t.test('combined source and storage budgets reject instead of truncating or launching work',async()=>{
      const first=await upload(own,'a'.repeat(100000),'large-a.txt'),second=await upload(own,'b'.repeat(90000),'large-b.txt');assert.equal(first.status,201);assert.equal(second.status,201);
      error(await create(own,'Too much source','combined-source-001',{file_ids:[first.data.id,second.data.id]}),422,'SOURCE_TOO_LARGE');
      // Quota boundary fixtures change only persisted accounting, avoiding a 500-MiB test upload.
      const row=(await app.locals.db.query('SELECT bytes FROM api_integration_files WHERE id=$1',[material.id])).rows[0];
      await app.locals.db.query('UPDATE api_integration_files SET bytes=$1 WHERE id=$2',[50*1024*1024+1,material.id]);
      error(await create(own,'Too many bytes','attached-source-001',{file_ids:[material.id]}),422,'SOURCE_TOO_LARGE');
      await app.locals.db.query('UPDATE api_integration_files SET bytes=$1 WHERE id=$2',[500*1024*1024,material.id]);error(await upload(own,'Another document'),429,'STORAGE_QUOTA_EXCEEDED');
      await app.locals.db.query('UPDATE api_integration_files SET bytes=$1 WHERE id=$2',[row.bytes,material.id]);
      await app.locals.db.query("INSERT INTO api_integration_files(id,integration_id,material_id,bytes,data) SELECT 'quota_fixture_'||n,$1,f.material_id,0,f.data FROM api_integration_files f CROSS JOIN generate_series(1,1000-(SELECT COUNT(*)::int FROM api_integration_files WHERE integration_id=$1)) AS n WHERE f.id=$2",[own.id,material.id]);
      try{assert.equal((await app.locals.db.query('SELECT COUNT(*)::int AS n FROM api_integration_files WHERE integration_id=$1',[own.id])).rows[0].n,1000);error(await upload(own,'Count quota document'),429,'STORAGE_QUOTA_EXCEEDED');}
      finally{await app.locals.db.query("DELETE FROM api_integration_files WHERE integration_id=$1 AND id LIKE 'quota_fixture_%'",[own.id]);}
      assert.equal(scripts.length,0);
    });

    await t.test('concurrent equivalent JSON creates one durable job and conflicts on changed content',async()=>{
      const body={topic:'Производная HTTP',language:'ru',file_ids:[material.id],external_teacher_id:'other-teacher',metadata:{course:'Математика',semester:1,enabled:true,optional:null}};
      const submitted=await Promise.all(Array.from({length:4},()=>api(own,'/generations',{method:'POST',body,headers:{'Idempotency-Key':'same-create-request-001'}})));
      assert.ok(submitted.every(result=>[200,202].includes(result.status)),JSON.stringify(submitted.map(result=>result.data)));assert.equal(new Set(submitted.map(result=>result.data.id)).size,1);assert.equal(submitted.filter(result=>result.status===202).length,1);
      ready=await wait(own,submitted[0].data.id,'ready');assert.equal(scripts.filter(request=>request.title===body.topic).length,1);assert.equal(voices.length,12);assert.equal(visuals.length,1);
      assert.equal(ready.duration_seconds,600);assert.equal(ready.video_mode,'2d');assert.equal(scripts[0].videoMode,'2d');assert.equal(ready.object,'generation');assert.equal(ready.external_teacher_id,'other-teacher');assert.equal(ready.video.url,`/api/v1/generations/${ready.id}/video`);assert.equal(ready.video.sha256,createHash('sha256').update(videoBytes).digest('hex'));
      assert.ok(scripts[0].source.includes('Қарақалпақ'));assert.equal(scripts[0].targetDuration,600);
      const reordered={metadata:{optional:null,enabled:true,semester:1,course:'Математика'},external_teacher_id:'other-teacher',file_ids:[material.id],language:'ru',topic:body.topic};
      const replay=await api(shared,'/generations',{method:'POST',body:reordered,headers:{'Idempotency-Key':'same-create-request-001'}});assert.equal(replay.status,200);assert.equal(replay.data.id,ready.id);assert.equal(replay.data.status,'ready');assert.equal(replay.data.revision,ready.revision);assert.equal(replay.response.headers.get('Idempotent-Replayed'),'true');
      error(await api(own,'/generations',{method:'POST',body:{...body,topic:'Changed topic'},headers:{'Idempotency-Key':'same-create-request-001'}}),409,'IDEMPOTENCY_CONFLICT');
      error(await api(own,'/generations',{method:'POST',body:{...body,video_mode:'3d'},headers:{'Idempotency-Key':'same-create-request-001'}}),409,'IDEMPOTENCY_CONFLICT');
      const account=(await api(own,'/account')).data;assert.deepEqual(account.video_modes,['2d','3d']);assert.equal(account.default_video_mode,'2d');assert.deepEqual(account.usage,{jobsToday:1,totalJobs:1,readyJobs:1,failedJobs:0});assert.equal(account.quota_timezone,'UTC');
      const mapped=(await app.locals.db.query('SELECT g.teacher_id,g.institution_id FROM api_integration_jobs j JOIN generated_lessons g ON g.id=j.generation_id WHERE j.id=$1',[ready.id])).rows[0];assert.deepEqual(mapped,{teacher_id:'demo-admin',institution_id:'demo-school'});
      for(const forbidden of ['teacherId','institutionId','generation_id','materialIds','voiceProfile','/private/'])assert.equal(JSON.stringify(ready).includes(forbidden),false);
    });

    await t.test('integration scope remains strict for job detail, audio, video, cursors and foreign keys',async()=>{
      assert.equal((await api(shared,`/generations/${ready.id}`)).data.id,ready.id);
      for(const partner of [sameOrg,foreign])for(const suffix of ['', '/video','/audio/chapter-0'])error(await api(partner,`/generations/${ready.id}${suffix}`),404,'NOT_FOUND');
      for(const partner of [sameOrg,foreign])error(await api(partner,`/generations?cursor=${ready.id}`),404,'NOT_FOUND');
      error(await api(own,'/generations/gen_'+'f'.repeat(32)),404,'NOT_FOUND');
      assert.equal((await call(`/api/integrations/${own.id}/keys/${foreign.keyId}`,{method:'DELETE',session:admin})).status,404);
      const mainList=await api(own,'/generations');assert.deepEqual(mainList.data.data.map((row:any)=>row.id),[ready.id]);assert.deepEqual((await api(sameOrg,'/generations')).data.data,[]);
    });

    await t.test('ready video supports real byte ranges, HEAD, unsatisfiable ranges and rechecked revocation',async()=>{
      const url=`/generations/${ready.id}/video`,full=await api(own,url);assert.equal(full.status,200);assert.deepEqual(full.data,videoBytes);assert.equal(full.response.headers.get('content-type'),'video/mp4');assert.equal(full.response.headers.get('accept-ranges'),'bytes');
      const range=await api(shared,url,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.deepEqual(range.data,videoBytes.subarray(0,8));assert.equal(range.response.headers.get('Content-Range'),'bytes 0-7/4096');assert.equal(range.response.headers.get('Content-Length'),'8');
      const suffix=await api(shared,url,{headers:{Range:'bytes=-17'}});assert.equal(suffix.status,206);assert.deepEqual(suffix.data,videoBytes.subarray(-17));
      const head=await api(shared,url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.data,undefined);assert.equal(head.response.headers.get('content-length'),'4096');assert.equal(head.response.headers.get('ETag'),'"'+ready.video.sha256+'"');
      const invalid=await api(shared,url,{headers:{Range:'bytes=999999-'}});error(invalid,416);assert.equal(invalid.response.headers.get('Content-Range'),'bytes */4096');
      assert.equal((await api(undefined,url,{method:'HEAD'})).status,401);
      const spare=await call(`/api/integrations/${own.id}/keys`,{method:'POST',session:admin,body:{name:'Temporary streaming key'}});assert.equal(spare.status,201);const temporaryKey={id:own.id,key:spare.data.key,keyId:spare.data.record.id};
      assert.equal((await api(temporaryKey,url,{headers:{Range:'bytes=0-7'}})).status,206);assert.equal((await call(`/api/integrations/${own.id}/keys/${temporaryKey.keyId}`,{method:'DELETE',session:admin})).status,204);
      error(await api(temporaryKey,url,{headers:{Range:'bytes=8-15'}}),401,'API_KEY_INVALID');assert.equal((await api(temporaryKey,url,{method:'HEAD'})).status,401);assert.equal((await api(shared,url,{headers:{Range:'bytes=8-15'}})).status,206);
    });

    await t.test('explicit failed-job retry is revision-safe, idempotent and reuses measured audio',async()=>{
      const created=await create(own,'Retry fixture','retry-create-001',{video_mode:'3d'});assert.equal(created.status,202);retryJob=await wait(own,created.data.id,'failed');assert.equal(retryJob.video_mode,'3d');assert.equal(scripts.find(request=>request.title==='Retry fixture')?.videoMode,'3d');
      error(await api(own,`/generations/${retryJob.id}/retry`,{method:'POST',body:{revision:retryJob.revision}}),400,'IDEMPOTENCY_REQUIRED');
      error(await api(own,`/generations/${retryJob.id}/retry`,{method:'POST',body:{revision:retryJob.revision-1},headers:{'Idempotency-Key':'stale-retry-001'}}),409,'REVISION_CONFLICT');
      const before=[scripts.length,voices.length,visuals.length],revision=retryJob.revision;failRetryVisual=false;
      const results=await Promise.all(Array.from({length:3},()=>api(own,`/generations/${retryJob.id}/retry`,{method:'POST',body:{revision},headers:{'Idempotency-Key':'retry-operation-001'}})));
      assert.ok(results.every(result=>[200,202].includes(result.status)),JSON.stringify(results.map(result=>result.data)));assert.equal(results.filter(result=>result.status===202).length,1);
      retryJob=await wait(own,retryJob.id,'ready');assert.deepEqual([scripts.length,voices.length,visuals.length],[before[0],before[1],before[2]+1]);
      const replay=await api(own,`/generations/${retryJob.id}/retry`,{method:'POST',body:{revision},headers:{'Idempotency-Key':'retry-operation-001'}});assert.equal(replay.status,200);assert.equal(replay.data.revision,retryJob.revision);assert.equal(replay.data.status,'ready');
      error(await api(own,`/generations/${retryJob.id}/retry`,{method:'POST',body:{revision:retryJob.revision},headers:{'Idempotency-Key':'retry-operation-001'}}),409,'IDEMPOTENCY_CONFLICT');
      error(await api(own,`/generations/${ready.id}/retry`,{method:'POST',body:{revision:ready.revision},headers:{'Idempotency-Key':'ready-retry-001'}}),409,'GENERATION_NOT_FAILED');
      assert.deepEqual((await api(own,'/account')).data.usage,{jobsToday:3,totalJobs:2,readyJobs:2,failedJobs:0});
    });

    const restoreLegacyWaitingRow=async(publicId:string)=>{
      // Explicit pre-upgrade fixture: new Karakalpak jobs have already completed automatically.
      const id=(await app.locals.db.query('SELECT generation_id FROM api_integration_jobs WHERE id=$1',[publicId])).rows[0].generation_id;
      const lesson=(await app.locals.db.query('SELECT data FROM generated_lessons WHERE id=$1',[id])).rows[0].data;
      lesson.status='language_review';lesson.languageReview={required:true};lesson.progress={stage:'language_review',completed:0,total:1};lesson.revision++;delete lesson.artifact;
      await app.locals.db.query('UPDATE generated_lessons SET revision=$1,data=$2 WHERE id=$3',[lesson.revision,lesson,id]);
    };
    await t.test('Karakalpak completes automatically and legacy continuation still works at daily quota one',async()=>{
      kaaIntegration=await makeIntegration('Karakalpak daily-one fixture',{jobsPerDay:1,maxConcurrentJobs:1});const visualBefore=visuals.length;
      const created=await create(kaaIntegration,'Qaraqalpaq sabaq','kaa-create-001',{language:'kaa'});assert.equal(created.status,202);kaa=await wait(kaaIntegration,created.data.id,'ready');
      assert.equal(visuals.length,visualBefore+1);assert.equal(kaa.language_review,undefined);assert.equal(kaa.language,'kaa');assert.equal(kaa.video.duration_seconds,600);
      await restoreLegacyWaitingRow(kaa.id);kaa=await wait(kaaIntegration,kaa.id,'language_review');
      assert.equal(kaa.language_review.required,true);assert.equal(kaa.language_review.chapters.length,3);assert.equal(kaa.video,undefined);
      for(const chapter of kaa.language_review.chapters){assert.equal(typeof chapter.transcript,'string');assert.equal(chapter.audio_url,`/api/v1/generations/${kaa.id}/audio/${chapter.id}`);const audio=await call(chapter.audio_url,{token:kaaIntegration.key,headers:{Range:'bytes=0-43'}});assert.equal(audio.status,206);assert.equal(audio.data.toString('ascii',0,4),'RIFF');assert.equal(audio.data.toString('ascii',8,12),'WAVE');}
      error(await api(own,`/generations/${kaa.id}/audio/chapter-0`),404,'NOT_FOUND');error(await api(kaaIntegration,`/generations/${kaa.id}/video`),409,'LESSON_NOT_READY');
      const route=`/generations/${kaa.id}/language-approval`,revision=kaa.revision;
      error(await api(kaaIntegration,route,{method:'POST',body:{revision}}),400,'IDEMPOTENCY_REQUIRED');error(await api(kaaIntegration,route,{method:'POST',body:{revision:revision-1},headers:{'Idempotency-Key':'kaa-stale-001'}}),409,'REVISION_CONFLICT');
      const approved=await Promise.all(Array.from({length:3},()=>api(kaaIntegration,route,{method:'POST',body:{revision},headers:{'Idempotency-Key':'kaa-approve-001'}})));assert.ok(approved.every(result=>[200,202].includes(result.status)),JSON.stringify(approved.map(result=>result.data)));assert.equal(approved.filter(result=>result.status===202).length,1);
      kaa=await wait(kaaIntegration,kaa.id,'ready');assert.equal(visuals.length,visualBefore+2);const replay=await api(kaaIntegration,route,{method:'POST',body:{revision},headers:{'Idempotency-Key':'kaa-approve-001'}});assert.equal(replay.status,200);assert.equal(replay.data.status,'ready');
      assert.deepEqual((await api(kaaIntegration,'/account')).data.usage,{jobsToday:1,totalJobs:1,readyJobs:1,failedJobs:0});error(await create(kaaIntegration,'Another lesson','kaa-over-budget-001'),429,'DAILY_QUOTA_EXCEEDED');
    });

    await t.test('language continuation skips daily attempts but still requires a free concurrency slot',async()=>{
      const integration=await makeIntegration('Busy language approval',{jobsPerDay:2,maxConcurrentJobs:1});
      const created=await create(integration,'Qaraqalpaq concurrent sabaq','kaa-concurrent-001',{language:'kaa'});assert.equal(created.status,202);await wait(integration,created.data.id,'ready');await restoreLegacyWaitingRow(created.data.id);const review=await wait(integration,created.data.id,'language_review');
      const held=await create(integration,'Hold approval slot','kaa-hold-slot-001');assert.equal(held.status,202);
      for(let count=0;!releases.has('Hold approval slot')&&count<100;count++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(releases.has('Hold approval slot'));
      assert.equal((await call(`/api/integrations/${integration.id}`,{method:'PATCH',session:admin,body:{limits:{jobsPerDay:1}}})).status,200);
      const route=`/generations/${review.id}/language-approval`,body={revision:review.revision},headers={'Idempotency-Key':'kaa-busy-approval-001'};
      error(await api(integration,route,{method:'POST',body,headers}),429,'CONCURRENCY_LIMIT');assert.deepEqual((await api(integration,'/account')).data.usage,{jobsToday:2,totalJobs:2,readyJobs:0,failedJobs:0});
      const unchanged=await api(integration,`/generations/${review.id}`);assert.equal(unchanged.data.status,'language_review');assert.equal(unchanged.data.revision,review.revision);
      releases.get('Hold approval slot')!();await wait(integration,held.data.id,'failed');
      const approved=await api(integration,route,{method:'POST',body,headers});assert.equal(approved.status,202,JSON.stringify(approved.data));await wait(integration,review.id,'ready');
      assert.deepEqual((await api(integration,'/account')).data.usage,{jobsToday:2,totalJobs:2,readyJobs:1,failedJobs:1});
    });

    await t.test('Uzbek is advertised and completes automatically with the selected language',async()=>{
      const integration=await makeIntegration('Uzbek automatic fixture',{jobsPerDay:1,maxConcurrentJobs:1});
      assert.deepEqual((await api(integration,'/account')).data.languages,['ru','kaa','uz']);
      const created=await create(integration,'Hosila va harakat','uz-create-001',{language:'uz'});assert.equal(created.status,202);
      const done=await wait(integration,created.data.id,'ready');assert.equal(done.language,'uz');assert.equal(done.language_review,undefined);assert.equal(done.video.duration_seconds,600);
      assert.equal(scripts.find(request=>request.title==='Hosila va harakat')?.language,'uz');assert.equal((await api(integration,`/generations/${done.id}/video`)).status,200);
      assert.deepEqual((await api(integration,'/account')).data.usage,{jobsToday:1,totalJobs:1,readyJobs:1,failedJobs:0});
    });

    await t.test('cursor pagination, request-key case and integration scope are independent',async()=>{
      const main=await create(own,'Fail case lower','CaseSensitiveKey'),lower=await create(own,'Fail case upper','casesensitivekey');assert.equal(main.status,202);assert.equal(lower.status,202);assert.notEqual(main.data.id,lower.data.id);await wait(own,main.data.id,'failed');await wait(own,lower.data.id,'failed');
      const separate=await create(sameOrg,'Fail separate integration','same-create-request-001');assert.equal(separate.status,202);await wait(sameOrg,separate.data.id,'failed');
      const seen=new Set<string>();let cursor:string|null=null,pages=0;
      do{const result=await api(own,'/generations?limit=1'+(cursor?'&cursor='+cursor:''));assert.equal(result.status,200);assert.equal(result.data.object,'list');assert.equal(result.data.data.length,1);const row=result.data.data[0];assert.equal(seen.has(row.id),false);seen.add(row.id);cursor=result.data.next_cursor;assert.equal(result.data.has_more,!!cursor);pages++;}while(cursor&&pages<10);
      assert.equal(seen.size,4);assert.equal(seen.has(separate.data.id),false);assert.equal(pages,4);
      for(const query of ['limit=0','limit=101','limit=1.5','cursor=invalid','limit=1&unknown=x'])error(await api(own,'/generations?'+query),422,'INVALID_REQUEST');
      const failed=await api(own,`/generations/${main.data.id}`);assert.equal(failed.data.error.code,'GENERATION_FAILED');assert.equal(JSON.stringify(failed.data).includes('/private/provider-path'),false);
    });

    await t.test('concurrency, request limits and UTC attempt quotas are durable integration-wide budgets',async()=>{
      const limited=await makeIntegration('Concurrent fixture',{maxConcurrentJobs:1,jobsPerDay:10});const held=await create(limited,'Hold one lesson','hold-concurrency-001');assert.equal(held.status,202);
      for(let count=0;!releases.has('Hold one lesson')&&count<100;count++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(releases.has('Hold one lesson'));
      error(await create(limited,'Fail second lesson','hold-concurrency-002'),429,'CONCURRENCY_LIMIT');const replay=await create(limited,'Hold one lesson','hold-concurrency-001');assert.equal(replay.status,200);assert.equal(replay.data.id,held.data.id);assert.equal((await api(limited,'/account')).data.usage.jobsToday,1);
      releases.get('Hold one lesson')!();const failed=await wait(limited,held.data.id,'failed');
      assert.equal((await call(`/api/integrations/${limited.id}`,{method:'PATCH',session:admin,body:{limits:{jobsPerDay:1}}})).status,200);
      error(await api(limited,`/generations/${failed.id}/retry`,{method:'POST',body:{revision:failed.revision},headers:{'Idempotency-Key':'hold-retry-over-001'}}),429,'DAILY_QUOTA_EXCEEDED');
      // Move only the synthetic accepted-attempt accounting to yesterday; no global clock mock.
      await app.locals.db.query("UPDATE api_integration_attempts SET created_at=NOW()-INTERVAL '1 day' WHERE integration_id=$1",[limited.id]);assert.equal((await api(limited,'/account')).data.usage.jobsToday,0);
      const next=await create(limited,'Fail next UTC day','next-day-attempt-001');assert.equal(next.status,202);await wait(limited,next.data.id,'failed');assert.equal((await api(limited,'/account')).data.usage.jobsToday,1);
      const rate=await makeIntegration('Rate fixture',{requestsPerMinute:2});const first=await api(rate,'/account');assert.equal(first.status,200);assert.equal(first.response.headers.get('X-RateLimit-Limit'),'2');assert.equal((await api(rate,'/account')).status,200);
      const denied=await api(rate,'/account');error(denied,429,'REQUEST_RATE_LIMITED');assert.ok(Number(denied.response.headers.get('Retry-After'))>0);assert.equal(denied.data.error.retryable,true);assert.equal((await api(sameOrg,'/account')).status,200);
    });

    await t.test('disable/revoke and restart keep key secrets out of storage and preserve current replays',async()=>{
      const before=[scripts.length,voices.length,visuals.length],usage=(await api(own,'/account')).data.usage;
      const records=(await app.locals.db.query('SELECT token_hash,data FROM api_integration_keys WHERE integration_id=$1',[own.id])).rows;
      for(const record of records){assert.match(record.token_hash,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(record).includes(own.key),false);assert.equal(JSON.stringify(record).includes(shared.key),false);}
      const listed=await call('/api/integrations',{session:admin});assert.equal(JSON.stringify(listed.data).includes(own.key),false);assert.equal(JSON.stringify(listed.data).includes(shared.key),false);
      assert.equal((await call(`/api/integrations/${own.id}`,{method:'PATCH',session:admin,body:{active:false}})).status,200);error(await api(own,'/account'),403,'INTEGRATION_DISABLED');assert.equal((await call(`/api/integrations/${own.id}`,{method:'PATCH',session:admin,body:{active:true}})).status,200);
      assert.equal((await call(`/api/integrations/${own.id}/keys/${own.keyId}`,{method:'DELETE',session:admin})).status,204);error(await api(own,'/account'),401,'API_KEY_INVALID');
      await reopen();error(await api(own,'/account'),401,'API_KEY_INVALID');assert.equal((await api(shared,'/account')).data.integration.id,own.id);assert.deepEqual((await api(shared,'/account')).data.usage,usage);
      assert.equal((await api(shared,`/files/${material.id}`)).data.sha256,material.sha256);assert.equal((await api(shared,`/files/${material.id}/content`)).status,200);assert.deepEqual((await api(shared,`/generations/${ready.id}/video`,{headers:{Range:'bytes=32-63'}})).data,videoBytes.subarray(32,64));
      const replay=await create(shared,'Производная HTTP','same-create-request-001',{file_ids:[material.id],external_teacher_id:'other-teacher',metadata:{course:'Математика',semester:1,enabled:true,optional:null}});assert.equal(replay.status,200);assert.equal(replay.data.id,ready.id);assert.equal(replay.data.status,'ready');assert.equal(replay.data.revision,ready.revision);assert.deepEqual([scripts.length,voices.length,visuals.length],before);
      for(const partner of [sameOrg,foreign])error(await api(partner,`/generations/${ready.id}`),404,'NOT_FOUND');
      const publicJob=await api(kaaIntegration,`/generations/${kaa.id}`);assert.equal(publicJob.data.status,'ready');assert.equal((await readFile(path.join(temporary,'generated',(await app.locals.db.query('SELECT generation_id FROM api_integration_jobs WHERE id=$1',[ready.id])).rows[0].generation_id,'film.mp4'))).length,4096);
    });

    await t.test('restart exposes a stranded committed reservation as failed and only explicit retry starts it',async()=>{
      const integration=await makeIntegration('Interrupted dispatch fixture'),id='gen_'+uid(),generationId=uid(),timestamp=now(),key='stranded-dispatch-001';
      const input={topic:'Fail stranded dispatch',language:'ru',file_ids:[]},internalRequestKey=`partner_${integration.id}_${hashToken(key)}`;
      // Simulate the precise crash boundary after durable acceptance, before calling the authoring service.
      await app.locals.db.transaction(async(tx:any)=>{
        await tx.query('INSERT INTO api_integration_jobs(id,integration_id,generation_id,created_at,data) VALUES($1,$2,$3,$4,$5)',[id,integration.id,generationId,timestamp,{input,materialIds:[],internalRequestKey,createdAt:timestamp,updatedAt:timestamp,dispatchStatus:'creating',operationActive:true}]);
        await tx.query('INSERT INTO api_integration_requests(integration_id,route,request_hash,body_hash,job_id) VALUES($1,$2,$3,$4,$5)',[integration.id,'POST /generations',hashToken(key),createHash('sha256').update(canonicalJson(input)).digest('hex'),id]);
        await tx.query('INSERT INTO api_integration_attempts(id,integration_id,job_id) VALUES($1,$2,$3)',[uid(),integration.id,id]);
      });
      const before=[scripts.length,voices.length,visuals.length];await reopen();const recovered=await api(integration,`/generations/${id}`);assert.equal(recovered.status,200);assert.equal(recovered.data.status,'failed');assert.equal(recovered.data.revision,0);assert.equal(recovered.data.error.code,'GENERATION_INTERRUPTED');
      const replay=await create(integration,input.topic,key);assert.equal(replay.status,200);assert.equal(replay.data.id,id);assert.equal(replay.data.error.code,'GENERATION_INTERRUPTED');assert.deepEqual([scripts.length,voices.length,visuals.length],before);
      assert.deepEqual((await api(integration,'/account')).data.usage,{jobsToday:1,totalJobs:1,readyJobs:0,failedJobs:1});
      const retried=await api(integration,`/generations/${id}/retry`,{method:'POST',body:{revision:0},headers:{'Idempotency-Key':'stranded-retry-001'}});assert.equal(retried.status,202);assert.equal(retried.data.id,id);await wait(integration,id,'failed');
      assert.deepEqual([scripts.length,voices.length,visuals.length],[before[0]+1,before[1],before[2]]);assert.deepEqual((await api(integration,'/account')).data.usage,{jobsToday:2,totalJobs:1,readyJobs:0,failedJobs:1});
    });
  }finally{
    for(const release of [...releases.values()])release();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});
  }
});
