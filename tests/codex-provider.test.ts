import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCodexProviders } from '../server/codex-provider.js';
import { pcmWave } from '../server/cinema.js';

function reversedObjectKeys(value:any):any {
  if(Array.isArray(value))return value.map(reversedObjectKeys);
  return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reversedObjectKeys(item)])):value;
}

test('private Codex broker adapter validates assets, authorization and the actual downloaded artifact', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'codex-provider-')), token='test-worker-token-'+'a'.repeat(48);
  const previous={url:process.env.CODEX_WORKER_URL,file:process.env.CODEX_WORKER_TOKEN_FILE};
  let behavior='ready',authCount=0,uploads=0,scriptCalls=0,transientCalls=0,progressPolls=0,onUnavailable:()=>void=()=>{};const scriptPayloads:any[]=[],scriptPaths:string[]=[],scriptBodies:Buffer[]=[],visualPayloads:any[]=[],visualPaths:string[]=[],visualBodies:Buffer[]=[];const movie=Buffer.alloc(4096);movie.write('ftyp',4);
  const hash=createHash('sha256').update(movie).digest('hex');
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);authCount++;
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
    res.setHeader('Content-Type','application/json');
    if(req.url?.endsWith('.wav')){uploads++;assert.equal(createHash('sha256').update(body).digest('hex'),req.headers['x-content-sha256']);res.end('{}');return;}
    if(req.url?.endsWith('/artifact')){res.setHeader('Content-Type','video/mp4');res.end(movie);return;}
    if(req.url?.endsWith('/script')){scriptCalls++;scriptPayloads.push(JSON.parse(body.toString()));scriptPaths.push(req.url);scriptBodies.push(body);if(behavior==='auth'){res.statusCode=401;res.end(JSON.stringify({error:{code:'AUTH'}}));return;}if(behavior==='network'&&transientCalls++===0){res.destroy();return;}if(behavior==='transient'&&transientCalls++===0||behavior==='unavailable'){res.statusCode=503;res.end(JSON.stringify({error:{code:'BUSY'}}));onUnavailable();return;}res.end(JSON.stringify({status:'ready',result:{title:JSON.parse(body.toString()).title,chapters:[]}}));return;}
    if(req.url?.endsWith('/visuals')){
      if(req.method==='POST'){visualPayloads.push(JSON.parse(body.toString()));visualPaths.push(req.url);visualBodies.push(body);}
      if(behavior==='failure-detail'){res.end(JSON.stringify({status:'failed',progress:{stage:'rendering',completed:4,total:6},error:{code:'RENDER',reason:'RENDER_TIMEOUT',stage:'rendering',message:'PRIVATE_WORKER_LOG_DO_NOT_EXPOSE'}}));return;}
      if(behavior==='alignment-detail'||behavior==='images-detail'){const alignment=behavior==='alignment-detail';res.end(JSON.stringify({status:'failed',error:{code:'VALIDATION',reason:alignment?'ALIGNMENT_FAILED':'IMAGE_GENERATION_FAILED',stage:alignment?'alignment':'images',message:'PRIVATE_MEDIA_LOG_DO_NOT_EXPOSE'}}));return;}
      if(behavior==='progress'&&progressPolls++<2){res.end(JSON.stringify({status:'running',progress:progressPolls===1?{stage:'queued',completed:0,total:6}:{stage:'rendering',completed:4,total:6,frames:{completed:7200,total:14400},privateToken:'NEVER_PUBLIC'}}));return;}
      res.end(JSON.stringify({status:'ready',result:{duration:behavior==='duration'?601:600,width:1280,height:720,fps:24,sha256:behavior==='hash'?'0'.repeat(64):hash}}));return;
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.CODEX_WORKER_URL=`http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CODEX_WORKER_TOKEN_FILE=path.join(root,'worker-token');await writeFile(process.env.CODEX_WORKER_TOKEN_FILE,token,{mode:0o600});
  const provider=createCodexProviders(root), voiceModel='gemini-3.8-flash-tts',lesson:any={id:'sample-lesson',title:'Производная',language:'ru',duration:600,voiceProfile:{model:voiceModel,voice:'Puck',language:'ru',styleVersion:'authoring-cue-v1'},chapters:[{id:'chapter-1',start:0,duration:600}]};
  await mkdir(path.join(root,'generated',lesson.id),{recursive:true});await writeFile(path.join(root,'generated',lesson.id,'chapter-1.wav'),pcmWave(Buffer.alloc(48000)));
  try {
    await t.test('sends the selected language and preserves flat script responses',async()=>{const result=await provider.codexScriptProvider!({lessonId:lesson.id,title:lesson.title,language:'kaa',source:'',targetDuration:600,voiceModel});assert.equal(result.title,lesson.title);assert.equal(scriptCalls,1);assert.equal(scriptPayloads.at(-1).voiceModel,voiceModel);});
    await t.test('passes Uzbek to the same author without substituting the voice model',async()=>{const result=await provider.codexScriptProvider!({lessonId:lesson.id,title:'Hosila va harakat',language:'uz',source:'',targetDuration:600,voiceModel});assert.equal(result.title,'Hosila va harakat');assert.equal(scriptPayloads.at(-1).language,'uz');assert.equal(scriptPayloads.at(-1).voiceModel,voiceModel);});
    await t.test('downloads and verifies a content hash before publishing a private artifact',async()=>{const result=await provider.codexVisualProvider!({lesson,dataDir:root});assert.equal(result.sha256,hash);assert.deepEqual(await readFile(result.file),movie);assert.equal(uploads,1);assert.ok(authCount>=4);assert.deepEqual(visualPayloads.at(-1).voiceProfile,lesson.voiceProfile);});
    await t.test('rejects forged render metadata before fetching an artifact',async()=>{behavior='duration';await assert.rejects(provider.codexVisualProvider!({lesson,dataDir:root}),/CODEX_VALIDATION_FAILED/);});
    await t.test('rejects a mismatched stream hash and removes its partial file',async()=>{behavior='hash';await assert.rejects(provider.codexVisualProvider!({lesson,dataDir:root}),/CODEX_VALIDATION_FAILED/);await assert.rejects(access(path.join(root,'generated',lesson.id,'film.mp4.download')));});
    await t.test('forwards real bounded broker phases and frame checkpoints while excluding callbacks from submitted bytes',async()=>{
      behavior='progress';progressPolls=0;const updates:any[]=[];
      await provider.codexVisualProvider!({lesson,dataDir:root,onProgress:async progress=>{updates.push(structuredClone(progress));}});
      assert.deepEqual(updates.map(progress=>progress.phase),['queued','rendering','downloading']);assert.deepEqual(updates[1].frames,{completed:7200,total:14400});
      assert.ok(!JSON.stringify(updates).includes('NEVER_PUBLIC'));assert.equal(visualPayloads.at(-1).onProgress,undefined);
    });
    await t.test('preserves a typed failure reason and phase without forwarding worker log text',async()=>{
      behavior='failure-detail';await assert.rejects(provider.codexVisualProvider!({lesson,dataDir:root}),(error:any)=>error.message==='CODEX_RENDER_TIMEOUT'&&error.generationStage==='rendering'&&!error.message.includes('PRIVATE_WORKER_LOG'));
    });
    await t.test('keeps bounded alignment and image-generation failures separate without exposing provider logs',async()=>{
      for(const [fixture,code,stage] of [['alignment-detail','CODEX_ALIGNMENT_FAILED','alignment'],['images-detail','CODEX_IMAGE_GENERATION_FAILED','images']]){
        behavior=fixture;await assert.rejects(provider.codexVisualProvider!({lesson,dataDir:root}),(error:any)=>error.message===code&&error.generationStage===stage&&!error.message.includes('PRIVATE_MEDIA_LOG'));
      }
    });
    await t.test('maps missing authorization without retrying a semantic failure',async()=>{behavior='auth';const before=scriptCalls;await assert.rejects(provider.codexScriptProvider!({lessonId:lesson.id,title:'Topic',language:'ru',source:'',targetDuration:600,voiceModel}),/CODEX_AUTH_REQUIRED/);assert.equal(scriptCalls-before,1);});
    await t.test('retries a transient HTTP 503 and returns the original idempotent job',async()=>{behavior='transient';transientCalls=0;const before=scriptCalls;const result=await provider.codexScriptProvider!({lessonId:lesson.id,title:'Transient topic',language:'ru',source:'',targetDuration:600,voiceModel});assert.equal(result.title,'Transient topic');assert.equal(scriptCalls-before,2);});
    await t.test('retries a dropped broker connection without changing the submitted job',async()=>{behavior='network';transientCalls=0;const before=scriptCalls;const result=await provider.codexScriptProvider!({lessonId:lesson.id,title:'Socket reset topic',language:'ru',source:'',targetDuration:600,voiceModel});assert.equal(result.title,'Socket reset topic');assert.equal(scriptCalls-before,2);});
    await t.test('bounds persistent service failures to three attempts',async()=>{behavior='unavailable';const before=scriptCalls;await assert.rejects(provider.codexScriptProvider!({lessonId:lesson.id,title:'Unavailable topic',language:'ru',source:'',targetDuration:600,voiceModel}),/CODEX_BUSY/);assert.equal(scriptCalls-before,3);});
    await t.test('an already aborted parent performs no broker request or retry',async()=>{behavior='ready';const controller=new AbortController();controller.abort();const before=authCount,started=Date.now();await assert.rejects(provider.codexScriptProvider!({lessonId:lesson.id,title:'Aborted topic',language:'ru',source:'',targetDuration:600,voiceModel,signal:controller.signal}),(error:any)=>error?.name==='AbortError');assert.equal(authCount,before);assert.ok(Date.now()-started<300);});
    await t.test('parent cancellation interrupts retry backoff before another request',async()=>{behavior='unavailable';const controller=new AbortController(),before=scriptCalls;onUnavailable=()=>setTimeout(()=>controller.abort(),20);const started=Date.now();try{await assert.rejects(provider.codexScriptProvider!({lessonId:lesson.id,title:'Cancel retry topic',language:'ru',source:'',targetDuration:600,voiceModel,signal:controller.signal}),(error:any)=>error?.name==='AbortError');assert.equal(scriptCalls-before,1);assert.ok(Date.now()-started<500);}finally{onUnavailable=()=>{};}});
    await t.test('TTS model context participates in script idempotency without changing unchanged requests',async()=>{behavior='ready';const body={lessonId:lesson.id,title:'Voice-aware plan',language:'ru' as const,source:'',targetDuration:600 as const,voiceModel};await provider.codexScriptProvider!(body);await provider.codexScriptProvider!(body);await provider.codexScriptProvider!({...body,voiceModel:'gemini-2.5-pro-preview-tts'});assert.equal(scriptPaths.at(-3),scriptPaths.at(-2));assert.notEqual(scriptPaths.at(-2),scriptPaths.at(-1));assert.equal(scriptPayloads.at(-1).voiceModel,'gemini-2.5-pro-preview-tts');});
    await t.test('deep object key reordering preserves script job ID and byte-identical broker body, while text and cue order remain meaningful',async()=>{
      behavior='ready';
      const context:any={lessonId:lesson.id,title:'Stable script',language:'ru',source:'Учебные данные.',targetDuration:600,voiceModel,measuredDuration:529.32,currentScript:{title:'Производная',summary:'Точная модель.',direction:'Дорожная лаборатория.',chapters:[{id:'chapter-1',title:'Путь',scene:'custom',headline:'Скорость',labels:['Путь','Время'],values:[9,3],palette:'dark',visualDirection:'Показать график.',cues:[{id:'first',text:'Путь равен квадрату времени.',visualAction:'Показать параболу.'},{id:'second',text:'Производная равна удвоенному времени.',visualAction:'Показать касательную.'}]}]}};
      await provider.codexScriptProvider!(context);const firstPath=scriptPaths.at(-1),firstBody=scriptBodies.at(-1)!;
      await provider.codexScriptProvider!(reversedObjectKeys(context));assert.equal(scriptPaths.at(-1),firstPath);assert.deepEqual(scriptBodies.at(-1),firstBody);assert.deepEqual(scriptPayloads.at(-1),context);
      // These are exactly the bytes the broker hashes after JSON decoding, too.
      assert.equal(createHash('sha256').update(JSON.stringify(JSON.parse(firstBody.toString()))).digest('hex'),createHash('sha256').update(JSON.stringify(scriptPayloads.at(-1))).digest('hex'));
      const changed=structuredClone(context);changed.currentScript.chapters[0].cues[0].text='Путь равен кубу времени.';await provider.codexScriptProvider!(changed);assert.notEqual(scriptPaths.at(-1),firstPath);assert.notDeepEqual(scriptBodies.at(-1),firstBody);
      const reordered=structuredClone(context);reordered.currentScript.chapters[0].cues.reverse();await provider.codexScriptProvider!(reordered);assert.notEqual(scriptPaths.at(-1),firstPath);assert.deepEqual(scriptPayloads.at(-1).currentScript.chapters[0].cues.map((cue:any)=>cue.id),['second','first']);
    });
    await t.test('JSONB-style nested reordering preserves visual job ID and raw body, but voice, numeric values and array order change the job',async()=>{
      behavior='ready';
      const original={...lesson,summary:'Проверка стабильности.',direction:'Единая лаборатория.',chapters:[{...lesson.chapters[0],title:'График',labels:['Начало','Конец'],values:[25,55],cues:[{id:'cue-a',start:0,duration:300,audioDuration:299,text:'Первая реплика.',visualAction:'Первый объект.'},{id:'cue-b',start:300,duration:300,audioDuration:299,text:'Вторая реплика.',visualAction:'Второй объект.'}]}]};
      await provider.codexVisualProvider!({lesson:original,dataDir:root});const firstPath=visualPaths.at(-1),firstBody=visualBodies.at(-1)!;
      await provider.codexVisualProvider!({lesson:reversedObjectKeys(original),dataDir:root});assert.equal(visualPaths.at(-1),firstPath);assert.deepEqual(visualBodies.at(-1),firstBody);assert.deepEqual(visualPayloads.at(-1).chapters,original.chapters);assert.deepEqual(visualPayloads.at(-1).voiceProfile,original.voiceProfile);
      const changedVoice=structuredClone(original);changedVoice.voiceProfile.voice='Charon';await provider.codexVisualProvider!({lesson:changedVoice,dataDir:root});assert.notEqual(visualPaths.at(-1),firstPath);assert.notDeepEqual(visualBodies.at(-1),firstBody);
      const changedValue=structuredClone(original);changedValue.chapters[0].values[0]=26;await provider.codexVisualProvider!({lesson:changedValue,dataDir:root});assert.notEqual(visualPaths.at(-1),firstPath);
      const changedOrder=structuredClone(original);changedOrder.chapters[0].cues.reverse();await provider.codexVisualProvider!({lesson:changedOrder,dataDir:root});assert.notEqual(visualPaths.at(-1),firstPath);assert.deepEqual(visualPayloads.at(-1).chapters[0].cues.map((cue:any)=>cue.id),['cue-b','cue-a']);
    });
    await t.test('does not create a provider without a configured worker',async()=>{delete process.env.CODEX_WORKER_URL;assert.deepEqual(createCodexProviders(root),{});});
  } finally {
    if(previous.url===undefined)delete process.env.CODEX_WORKER_URL;else process.env.CODEX_WORKER_URL=previous.url;
    if(previous.file===undefined)delete process.env.CODEX_WORKER_TOKEN_FILE;else process.env.CODEX_WORKER_TOKEN_FILE=previous.file;
    await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});
