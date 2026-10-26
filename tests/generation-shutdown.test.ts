import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';

test('shutdown aborts in-flight provider calls and queued voices, then persists failed jobs before closing',{timeout:30000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'generation-shutdown-')),originalFetch=globalThis.fetch;
  const script={title:'Проверка остановки',summary:'Учебный материал.',chapters:[{id:'first',title:'Первый пример',narration:'Производная координаты по времени равна мгновенной скорости.',scene:'concept',headline:'Скорость изменения',labels:['Координата','Время'],values:[],palette:'dark'},{id:'second',title:'Второй пример',narration:'Если координата равна квадрату времени, скорость равна удвоенному времени.',scene:'concept',headline:'Пример движения',labels:['Координата','Скорость'],values:[],palette:'light'}]};
  let blockScript=true,providerStarted:()=>void=()=>{},aborted=0,voiceRequests=0;
  globalThis.fetch=async(input,init)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(!url.startsWith('https://generativelanguage.googleapis.com/'))return originalFetch(input,init);
    const voice=url.includes('-tts:');if(voice)voiceRequests++;
    if(blockScript||voice){
      providerStarted();return new Promise<Response>((_resolve,reject)=>{
        const abort=()=>{aborted++;reject(new DOMException('Test provider stopped','AbortError'));};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(script)}]}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const options={dataDir:temporary,seedDemo:true,generation:{apiKey:'isolated-placeholder-never-sent-to-network',scriptModel:'gemini-3.8-flash',voiceModel:'gemini-2.5-pro-preview-tts',voice:'Puck'}};
  let app=await createApp(options),server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));let base=`http://127.0.0.1:${(server.address() as any).port}`,closed=false;
  type Client={cookie:string;csrf:string};
  const login=async(email:string,password:string):Promise<Client>=>{const response=await originalFetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(response.status,200);const body:any=await response.json();return{cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:body.csrfToken};};
  const request=async(client:Client,url:string,method='GET',body?:any)=>{const headers:Record<string,string>={Cookie:client.cookie};if(method!=='GET')headers['X-CSRF-Token']=client.csrf;if(body!==undefined&&!(body instanceof FormData))headers['Content-Type']='application/json';const response=await originalFetch(base+url,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});return{status:response.status,data:await response.json() as any};};
  const source=async(client:Client,title:string)=>{const body=new FormData();body.set('title',title);body.set('subjectId','demo-biology');body.set('files',new Blob(['Производная координаты — мгновенная скорость движения. Для координаты t² скорость равна2t.']),'source.txt');const response=await request(client,'/api/lesson-materials','POST',body);assert.equal(response.status,201);return response.data;};
  const waitDraft=async(client:Client,id:string)=>{for(let i=0;i<100;i++){const result=await request(client,`/api/generated-lessons/${id}`);if(result.data.status==='draft')return result.data;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Draft did not finish');};
  const close=async()=>{const started=Date.now();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();closed=true;assert.ok(Date.now()-started<2000,'Shutdown must abort rather than wait for the 180-second provider timeout');};
  const reopen=async()=>{app=await createApp({...options,seedDemo:false});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;closed=false;};
  try{
    let admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!'),teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');assert.equal((await request(admin,'/api/institutions/demo-school','PATCH',{settings:{allowExternalAI:true}})).status,200);
    const material=await source(teacher,'Остановка подготовки сценария');let firstStarted=new Promise<void>(resolve=>providerStarted=resolve);
    const started=await request(teacher,`/api/lesson-materials/${material.id}/draft`,'POST',{});assert.equal(started.status,202);await firstStarted;await close();assert.equal(aborted,1);
    await reopen();teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');let stopped=await request(teacher,`/api/generated-lessons/${started.data.id}`);assert.equal(stopped.data.status,'failed');assert.match(stopped.data.error,/прервана перезапуском/);assert.equal(stopped.data.chapters.length,0);
    blockScript=false;const resumed=await request(teacher,`/api/lesson-materials/${material.id}/draft`,'POST',{});assert.equal(resumed.status,202);const first=await waitDraft(teacher,started.data.id);
    const secondMaterial=await source(teacher,'Остановка очереди озвучки'),secondStarted=await request(teacher,`/api/lesson-materials/${secondMaterial.id}/draft`,'POST',{});assert.equal(secondStarted.status,202);const second=await waitDraft(teacher,secondStarted.data.id);
    const voiceStarted=new Promise<void>(resolve=>providerStarted=resolve);const approved=await request(teacher,`/api/generated-lessons/${first.id}/generate`,'POST',{revision:first.revision});assert.equal(approved.status,202);await voiceStarted;
    assert.equal((await request(teacher,`/api/generated-lessons/${second.id}/generate`,'POST',{revision:second.revision})).status,202);await close();assert.equal(aborted,2);assert.equal(voiceRequests,1,'The queued second voice request must not run after shutdown');
    await reopen();teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');for(const id of [first.id,second.id]){stopped=await request(teacher,`/api/generated-lessons/${id}`);assert.equal(stopped.data.status,'failed');assert.equal(stopped.data.progress.stage,'failed');assert.match(stopped.data.error,/прервана перезапуском/);assert.equal(stopped.data.lessonId,undefined);assert.equal((await request(teacher,`/api/generated-lessons/${id}/manifest`)).status,409);}
  }finally{if(!closed){await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();}globalThis.fetch=originalFetch;await rm(temporary,{recursive:true,force:true});}
});
