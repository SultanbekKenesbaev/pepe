import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requestGoogleSpeech, googlePublicError } from '../server/google-request.js';
import { generatedWave } from '../server/tts-output.js';
import { pcmWave } from '../server/cinema.js';
import { cueTtsBody } from '../server/codex-lessons.js';
import { createApp } from '../server/app.js';

const cue={id:'cue',text:'Ájiniyaz el hám insan haqqında pikir etedi.',visualAction:'A clear historical illustration.'};
const request={apiKey:'isolated-never-sent-key',model:'gemini-2.5-pro-preview-tts',body:cueTtsBody(cue,'kaa','gemini-2.5-pro-preview-tts','Puck')};
const empty={candidates:[{finishReason:'OTHER',content:{parts:[]},finishMessage:'PRIVATE_PROVIDER_TEXT'}]};
const pcm=Buffer.alloc(48000),audio={candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'audio/L16;codec=pcm;rate=24000',data:pcm.toString('base64')}}]}}]};

test('empty OTHER and missing STOP audio retry the identical speech request before returning valid WAV',async()=>{
  const responses=[empty,{candidates:[{finishReason:'STOP',content:{parts:[{text:'PRIVATE_PROVIDER_TEXT'}]}}]},audio],waits:number[]=[],bodies:string[]=[];
  const wave=await requestGoogleSpeech(request,{fetch:async(url,options)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-tts:generateContent');
    assert.equal(new Headers(options?.headers).get('x-goog-api-key'),request.apiKey);bodies.push(String(options?.body));return Response.json(responses.shift());
  },sleep:async ms=>{waits.push(ms);}});
  assert.deepEqual(wave,pcmWave(pcm));assert.deepEqual(waits,[1000,2000]);assert.equal(bodies.length,3);assert.ok(bodies.every(body=>body===JSON.stringify(request.body)));
  const text=request.body.contents[0].parts[0].text;
  assert.equal(text.split('<TRANSCRIPT>\n')[1].split('\n</TRANSCRIPT>')[0],cue.text);
});

test('persistent empty speech responses stop after three calls with a safe specific public error',async()=>{
  let calls=0;const waits:number[]=[];
  await assert.rejects(requestGoogleSpeech(request,{fetch:async()=>{calls++;return Response.json(empty);},sleep:async ms=>{waits.push(ms);}}),{message:'GENERATION_TTS_EMPTY'});
  assert.equal(calls,3);assert.deepEqual(waits,[1000,2000]);assert.match(googlePublicError(new Error('GENERATION_TTS_EMPTY'))!,/Google.*озвучку.*реплики.*сохранены/);
  assert.doesNotMatch(googlePublicError(new Error('GENERATION_TTS_EMPTY'))!,/PRIVATE|isolated/);
});

test('blocked, truncated, partial and invalid Google speech are terminal and never retried',async()=>{
  const cases:[unknown,string][]=[
    [{promptFeedback:{blockReason:'SAFETY',blockReasonMessage:'PRIVATE_PROVIDER_TEXT'}},'GENERATION_TTS_BLOCKED'],
    [{candidates:[{finishReason:'SAFETY'}]},'GENERATION_TTS_BLOCKED'],
    [{candidates:[{finishReason:'MAX_TOKENS',content:audio.candidates[0].content}]},'GENERATION_TTS_INCOMPLETE'],
    [{candidates:[{finishReason:'OTHER',content:audio.candidates[0].content}]},'GENERATION_TTS_INCOMPLETE'],
    [{candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'text/html',data:'SGVsbG8='}}]}}]},'GENERATION_TTS_FORMAT'],
    [{candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'audio/wav',data:'SGVsbG8='}}]}}]},'GENERATION_TTS_INVALID'],
    [{candidates:[{content:{parts:[{inlineData:{mimeType:'audio/pcm',data:'***'}}]}}]},'GENERATION_TTS_INVALID'],
    [{candidates:[{content:{parts:{private:'PRIVATE_PROVIDER_TEXT'}}}]},'GENERATION_TTS_INVALID'],
  ];
  for(const [payload,code]of cases){let calls=0;await assert.rejects(requestGoogleSpeech(request,{fetch:async()=>{calls++;return Response.json(payload);},sleep:async()=>assert.fail('Terminal TTS response must not retry')}),{message:code});assert.equal(calls,1);assert.ok(googlePublicError(new Error(code)));}
  let invalidCalls=0;await assert.rejects(requestGoogleSpeech(request,{fetch:async()=>{invalidCalls++;return new Response('PRIVATE_INVALID_JSON');},sleep:async()=>assert.fail('Invalid response must not retry')}),{message:'GENERATION_TTS_INVALID'});assert.equal(invalidCalls,1);
  assert.deepEqual(generatedWave({candidates:[{content:{parts:[{inline_data:{mime_type:'audio/wav',data:pcmWave(pcm).toString('base64')}}]}}]}),pcmWave(pcm));
});

test('empty audio retries share the HTTP call budget and preserve daily quota failures',async()=>{
  let calls=0;const replies=[Response.json({}, {status:503}),Response.json(empty),Response.json(empty),Response.json(audio)],waits:number[]=[];
  assert.deepEqual(await requestGoogleSpeech(request,{fetch:async()=>{calls++;return replies.shift()!;},sleep:async ms=>{waits.push(ms);},random:()=>0}),pcmWave(pcm));
  assert.equal(calls,4);assert.deepEqual(waits,[1000,1000,2000]);
  let quotaCalls=0;
  await assert.rejects(requestGoogleSpeech(request,{fetch:async()=>++quotaCalls===1?Response.json(empty):Response.json({error:{message:'PRIVATE_PROVIDER_TEXT',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel'}]}]}},{status:429}),sleep:async()=>{}}),{message:'GENERATION_QUOTA_DAILY'});
  assert.equal(quotaCalls,2);
  let bounded=0;await assert.rejects(requestGoogleSpeech(request,{fetch:async()=>++bounded<4?Response.json({},{status:503}):Response.json(empty),sleep:async()=>{},random:()=>0}),{message:'GENERATION_TTS_EMPTY'});assert.equal(bounded,4);
});

test('shutdown interrupts empty-response backoff and a single deadline bounds all attempts',async()=>{
  const before=new AbortController();before.abort();let calls=0;
  await assert.rejects(requestGoogleSpeech({...request,signal:before.signal},{fetch:async()=>{calls++;return Response.json(audio);}}),{name:'AbortError'});assert.equal(calls,0);
  const abort=new AbortController(),started=Date.now();let announce!:()=>void;const waiting=new Promise<void>(resolve=>{announce=resolve;});
  const pending=requestGoogleSpeech({...request,signal:abort.signal},{fetch:async()=>{calls++;announce();return Response.json(empty);}}),check=assert.rejects(pending,{name:'AbortError'});
  await waiting;abort.abort();await check;assert.equal(calls,1);assert.ok(Date.now()-started<500);
  let timedCalls=0;await assert.rejects(requestGoogleSpeech({...request,timeoutMs:1000},{fetch:async()=>{timedCalls++;return Response.json(empty);}}),{name:'TimeoutError'});assert.equal(timedCalls,1);
});

test('a failed speech cue exposes its safe code and retry resumes from the two existing cached cues',{timeout:60000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'google-tts-resume-'));let failThird=true,scriptCalls=0,visualCalls=0;
  const calls=new Map<string,number>(),spoken=pcmWave(Buffer.alloc(48000*48));
  const generation={voiceModel:request.model,voice:'Puck',
    codexScriptProvider:async({title}:any)=>{scriptCalls++;return{title,summary:'Exact speech retry fixture.',direction:'Clear educational scenes.',chapters:Array.from({length:3},(_,chapter)=>({id:`chapter-${chapter}`,title:'Сцена',scene:'custom' as const,headline:'Пример',labels:[],values:[],palette:'dark' as const,visualDirection:'Show a meaningful learning illustration.',cues:Array.from({length:4},(_,index)=>({id:`cue-${chapter}-${index}`,text:`${chapter}-${index}: ${cue.text}`,visualAction:'Move the relevant object with the spoken explanation.'}))}))};},
    voiceProvider:async(chapter:any)=>requestGoogleSpeech({...request,body:cueTtsBody({...cue,text:chapter.narration},'kaa',request.model,'Puck')},{fetch:async()=>{
      const text=chapter.narration;calls.set(text,(calls.get(text)||0)+1);
      return Response.json(failThird&&text.startsWith('0-2:')?empty:{candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'audio/wav',data:spoken.toString('base64')}}]}}]});
    },sleep:async()=>{}}),
    codexVisualProvider:async({lesson,dataDir}:any)=>{visualCalls++;const file=path.join(dataDir,'generated',lesson.id,'test-film.mp4'),bytes=Buffer.alloc(2048);bytes.write('ftyp',4);await writeFile(file,bytes);return{file,duration:600,width:1280,height:720,fps:30,sha256:createHash('sha256').update(bytes).digest('hex')};},
  };
  const app=await createApp({dataDir:temporary,seedDemo:true,generation}),server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const call=async(client:any,url:string,method='GET',body?:any)=>{const response=await fetch(base+url,{method,headers:{...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json() as any,response};};
  const login=async(email:string,password:string)=>{const result=await call(null,'/api/auth/login','POST',{email,password});assert.equal(result.status,200);return{cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken};};
  try{
    const teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!'),admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');assert.equal((await call(admin,'/api/institutions/demo-school','PATCH',{settings:{allowExternalAI:true}})).status,200);
    const created=await call(teacher,'/api/generated-lessons','POST',{title:'Kaa speech retry',language:'kaa',videoMode:'2d'});assert.equal(created.status,202);
    const wait=async(status:string)=>{for(let index=0;index<400;index++){const result=await call(teacher,`/api/generated-lessons/${created.data.id}`);if(result.data.status===status)return result.data;if(result.data.status==='failed'&&status!=='failed')assert.fail(result.data.error);await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Lesson status timeout');};
    const failed=await wait('failed');assert.equal(failed.errorCode,'GENERATION_TTS_EMPTY');assert.equal(failed.errorStage,'voice');assert.equal(failed.progress.completed,2);assert.match(failed.error,/Google.*озвучку.*сохранены/);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_PROVIDER_TEXT/);assert.equal(visualCalls,0);
    const directory=path.join(temporary,'generated',failed.id,'cue-cache'),before=new Map<string,string>();for(const file of await readdir(directory))before.set(file,createHash('sha256').update(await readFile(path.join(directory,file))).digest('hex'));assert.equal(before.size,2);
    failThird=false;assert.equal((await call(teacher,`/api/generated-lessons/${failed.id}/retry`,'POST',{revision:failed.revision})).status,202);const ready=await wait('ready');
    assert.equal(scriptCalls,1);assert.equal(visualCalls,1);assert.equal(ready.voiceProfile.model,request.model);assert.equal(ready.voiceProfile.voice,'Puck');assert.equal(ready.duration,600);
    for(const [text,count]of calls)assert.equal(count,text.startsWith('0-2:')?4:1,`Unexpected requests for ${text}`);assert.equal(calls.size,12);
    for(const [file,hash]of before)assert.equal(createHash('sha256').update(await readFile(path.join(directory,file))).digest('hex'),hash);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});}
});
