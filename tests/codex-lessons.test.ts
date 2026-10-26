import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { pcmWave, waveDuration } from '../server/cinema.js';
import { codexScriptSchema, cueTtsBody, type CodexScriptRequest } from '../server/codex-lessons.js';

test('Uzbek narration uses the selected Google Flash/Puck profile and preserves Russian/Karakalpak cue formats',()=>{
  const cue={id:'cue',text:'Hosila tezlikning o‘zgarishini ifodalaydi.',visualAction:'Show a moving model.'};
  for(const model of ['gemini-3.8-flash-tts','gemini-2.5-pro-preview-tts']){
    const body=cueTtsBody(cue,'uz',model,'Puck'),text=JSON.stringify(body);
    assert.ok(text.includes(cue.text));assert.match(text,/Speak only natural Uzbek/);assert.match(text,/Do not translate to Russian, Karakalpak/);assert.match(text,/Puck/);
    assert.deepEqual(model.startsWith('gemini-3.8-')?body.generationConfig.speechConfig.voiceConfig:{voice:'Puck'}, {voice:'Puck'});
  }
  const russian=JSON.stringify(cueTtsBody(cue,'ru','gemini-3.8-flash-tts','Puck'));
  const karakalpak=JSON.stringify(cueTtsBody(cue,'kaa','gemini-3.8-flash-tts','Puck'));
  assert.match(russian,/Speak natural Russian, preserving the exact supplied transcript/);assert.match(karakalpak,/Speak only natural Karakalpak \(Qaraqalpaq tili\)/);
  assert.ok(!russian.includes('Speak only natural Uzbek'));assert.ok(!karakalpak.includes('Speak only natural Uzbek'));
});

test('provider underscore IDs are safely canonicalized while paths and identifier collisions are rejected',()=>{
  const script=()=>({title:'Проверка идентификаторов',summary:'Содержание не меняется.',direction:'Авторская объёмная постановка.',chapters:Array.from({length:3},(_,chapter)=>({id:` Chapter_${chapter+1} `,title:`Глава ${chapter+1}`,scene:'custom',headline:'Учебная тема',visualDirection:'Камера следует за объектом.',cues:Array.from({length:4},(_,cue)=>({id:` CUE_${chapter+1}_${cue+1} `,text:'Производная описывает скорость изменения.',visualAction:'Показать модель в пространстве.'}))}))});
  const original=script(),parsed=codexScriptSchema.parse(original);
  assert.equal(parsed.chapters[0].id,'chapter-1');assert.equal(parsed.chapters[0].cues[0].id,'cue-1-1');assert.equal(parsed.chapters[0].cues[0].text,original.chapters[0].cues[0].text);assert.equal(parsed.chapters[0].visualDirection,original.chapters[0].visualDirection);
  const valid=script();valid.chapters[0].id='already-valid';valid.chapters[0].cues[0].id='road-01';assert.equal(codexScriptSchema.parse(valid).chapters[0].cues[0].id,'road-01');
  const collision=script();collision.chapters[0].cues[0].id='road_01';collision.chapters[0].cues[1].id='road-01';assert.equal(codexScriptSchema.safeParse(collision).success,false);
  const chapterCollision=script();chapterCollision.chapters[0].id='same_name';chapterCollision.chapters[1].id='same-name';assert.equal(codexScriptSchema.safeParse(chapterCollision).success,false);
  for(const unsafe of ['../road','road/01','road\\01','дорога_01','road.01','_road','road 01']){const invalid=script();invalid.chapters[0].cues[0].id=unsafe;assert.equal(codexScriptSchema.safeParse(invalid).success,false,unsafe);}
});

test('voice provenance prevents stale 600-second reuse after model or voice changes while preserving cache and ready films',{timeout:60000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'codex-voice-provenance-'));
  const pro='gemini-2.5-pro-preview-tts',flash='gemini-3.8-flash-tts';let model=pro,voice='Puck',voiceCalls=0,visualCalls=0,failVisual=true,partialCalls=0;
  const scriptRequests:CodexScriptRequest[]=[];
  const generation=()=>({voiceModel:model,voice,
    codexScriptProvider:async(request:CodexScriptRequest)=>{scriptRequests.push(request);return{title:request.title,summary:'Контракт изолированного теста.',direction:'Пространственное объяснение.',chapters:Array.from({length:3},(_,chapter)=>({id:`chapter-${chapter}`,title:'Учебная сцена',scene:'custom' as const,headline:'Изменение',labels:[],values:[],palette:'dark' as const,visualDirection:'Камера следует за объёмным объектом.',cues:Array.from({length:4},(_,cue)=>({id:`cue-${chapter}-${cue}`,text:`${request.title}: пример ${chapter}, фраза ${cue}, производная показывает скорость изменения.`,visualAction:'Объёмный объект меняется вместе с объяснением.'}))}))};},
    voiceProvider:async(chapter:any)=>{voiceCalls++;if(model===pro&&chapter.narration.includes('partial-case')&&++partialCalls===3)throw new Error('GENERATION_HTTP_429');return pcmWave(Buffer.alloc(48000*(model===flash&&voice==='Puck'?47:48)));},
    codexVisualProvider:async({lesson,dataDir}:any)=>{visualCalls++;assert.equal(lesson.voiceProfile.model,model);assert.equal(lesson.voiceProfile.voice,voice);assert.equal(lesson.duration,600);if(failVisual)throw new Error('CODEX_RENDER_FAILED');
      // Explicit trusted-renderer mock; no claim of a real rendered film.
      const bytes=Buffer.alloc(2048);bytes.write('ftyp',4);const file=path.join(dataDir,'generated',lesson.id,'film.mp4');await writeFile(file,bytes);return{file,duration:600,width:1280,height:720,fps:24,sha256:createHash('sha256').update(bytes).digest('hex')};},
  });
  let app=await createApp({dataDir:temporary,seedDemo:true,generation:generation()}),server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string};let teacher:Client;
  const call=async(client:Client|undefined,url:string,method='GET',body?:any)=>{const response=await fetch(base+url,{method,headers:{...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json() as any,response};};
  const login=async(email:string,password:string)=>{const result=await call(undefined,'/api/auth/login','POST',{email,password});assert.equal(result.status,200);return{cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken};};
  const wait=async(id:string,status:string)=>{for(let count=0;count<300;count++){const result=await call(teacher,`/api/generated-lessons/${id}`);if(result.data.status===status)return result.data;if(result.data.status==='failed'&&status!=='failed')assert.fail(result.data.error);await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generation status timeout');};
  const create=async(title:string,language='ru')=>{const result=await call(teacher,'/api/generated-lessons','POST',{title,language});assert.equal(result.status,202);return result.data.id as string;};
  const retry=async(lesson:any)=>{assert.equal((await call(teacher,`/api/generated-lessons/${lesson.id}/retry`,'POST',{revision:lesson.revision})).status,202);};
  const restart=async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();app=await createApp({dataDir:temporary,seedDemo:false,generation:generation()});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');};
  try{
    teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');const admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');assert.equal((await call(admin,'/api/institutions/demo-school','PATCH',{settings:{allowExternalAI:true}})).status,200);
    let full=await wait(await create('full-case'),'failed'),partial=await wait(await create('partial-case'),'failed');const oldFullHash=full.chapters[0].cues[0].audioHash,oldPartialHash=partial.chapters[0].cues[0].audioHash;
    assert.equal(full.duration,600);assert.equal(partial.duration,0);assert.equal(partial.progress.completed,2);assert.equal(full.voiceProfile.model,pro);assert.equal(partial.voiceProfile.model,pro);assert.equal(scriptRequests.length,2);
    // Reproduce an already persisted pilot from before provenance was introduced.
    delete partial.voiceProfile;await app.locals.db.query('UPDATE generated_lessons SET data=$1 WHERE id=$2',[partial,partial.id]);
    await t.test('Flash retry measures the existing script again instead of reusing Pro timings or asking for another initial script',async()=>{
      model=flash;await restart();const before=voiceCalls;await retry(full);full=await wait(full.id,'failed');assert.equal(voiceCalls-before,12);assert.equal(full.voiceProfile.model,flash);assert.equal(full.chapters[0].cues[0].audioDuration,47);assert.notEqual(full.chapters[0].cues[0].audioHash,oldFullHash);assert.equal(scriptRequests.length,2);
      await readFile(path.join(temporary,'generated',full.id,'cue-cache',oldFullHash+'.wav'));
      // Legacy 600-second audio can be adopted only when every cue hash proves the active profile.
      delete full.voiceProfile;await app.locals.db.query('UPDATE generated_lessons SET data=$1 WHERE id=$2',[full,full.id]);
      failVisual=false;const cachedCalls=voiceCalls;await retry(full);full=await wait(full.id,'ready');assert.equal(voiceCalls,cachedCalls,'Same voice profile must reuse all measured audio');
      assert.equal(full.voiceProfile.model,flash);
    });
    await t.test('a partial model switch preserves script and cache, and future new script requests carry the current TTS model',async()=>{
      failVisual=true;const before=voiceCalls;await retry(partial);partial=await wait(partial.id,'failed');assert.equal(voiceCalls-before,12);assert.equal(scriptRequests.length,2);assert.equal(partial.voiceProfile.model,flash);assert.notEqual(partial.chapters[0].cues[0].audioHash,oldPartialHash);await readFile(path.join(temporary,'generated',partial.id,'cue-cache',oldPartialHash+'.wav'));
    });
    const kaa=await wait(await create('language-case','kaa'),'failed');assert.equal(kaa.languageReview,undefined);assert.equal(scriptRequests.at(-1)!.voiceModel,flash);assert.equal(scriptRequests[0].voiceModel,pro);
    await t.test('changing a voice refreshes failed Karakalpak timings automatically while ready historical films remain untouched',async()=>{
      voice='Charon';await restart();assert.deepEqual((await call(teacher,`/api/generated-lessons/${full.id}`)).data,full);const before=voiceCalls;await retry(partial);partial=await wait(partial.id,'failed');assert.equal(voiceCalls-before,12);assert.equal(partial.voiceProfile.voice,'Charon');assert.equal(partial.chapters[0].cues[0].audioDuration,48);
      const beforeApproval=voiceCalls,beforeVisuals=visualCalls;await retry(kaa);const refreshed=await wait(kaa.id,'failed');assert.equal(voiceCalls-beforeApproval,12);assert.equal(visualCalls,beforeVisuals+1);assert.equal(refreshed.voiceProfile.voice,'Charon');assert.equal(refreshed.languageReview,undefined);
      failVisual=false;await retry(refreshed);assert.equal((await wait(kaa.id,'ready')).voiceProfile.voice,'Charon');assert.equal(voiceCalls-beforeApproval,12);assert.equal(scriptRequests.length,3);
      assert.deepEqual((await call(teacher,`/api/generated-lessons/${full.id}`)).data,full);
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});}
});

test('topic authoring keeps optional sources, measured 600-second timing, automatic languages and independent publication durable',{timeout:120000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'codex-lessons-'));
  const requests:Omit<CodexScriptRequest,'signal'>[]=[],voiceRequests:string[]=[];let visualRequests=0,visualFailure=true,shortVoice=false;
  const scriptFor=(title:string)=>({title,summary:'Авторский учебный сценарий для проверки.',direction:'Единая лаборатория, движение камеры связывает реальные примеры и математические модели.',chapters:Array.from({length:6},(_,chapter)=>({id:`chapter-${chapter+1}`,title:`Сцена ${chapter+1}`,scene:'custom' as const,headline:`Пример ${chapter+1}`,labels:[],values:[],palette:'dark' as const,visualDirection:'Авторская объёмная постановка: камера следует за пространственными объектами.',cues:Array.from({length:4},(_,cue)=>({id:`cue-${chapter+1}-${cue+1}`,text:`Реплика ${chapter+1} ${cue+1} для темы ${title}. Производная показывает мгновенную скорость изменения.`,visualAction:`Показать отдельный пример ${chapter+1} ${cue+1}, синхронно с соответствующей фразой.`}))}))});
  const generation={
    codexScriptProvider:async(request:CodexScriptRequest)=>{const {signal:_,onProgress:__,...record}=request;requests.push(structuredClone(record));return scriptFor(request.title);},
    voiceProvider:async(chapter:any)=>{voiceRequests.push(chapter.narration);return pcmWave(Buffer.alloc(24000*2*(shortVoice?20:23)));},
    codexVisualProvider:async({lesson,dataDir}:any)=>{visualRequests++;if(visualFailure)throw new Error('CODEX_RENDER_FAILED');
      assert.equal(lesson.duration,600);assert.ok(lesson.chapters.every((chapter:any)=>chapter.scene==='custom'));let end=0;for(const chapter of lesson.chapters){assert.equal(chapter.start,end);const wave=await readFile(path.join(dataDir,'generated',lesson.id,chapter.id+'.wav'));assert.equal(waveDuration(wave),chapter.duration);for(const cue of chapter.cues){assert.equal(cue.start,end);assert.equal(cue.audioDuration,23);assert.equal(cue.duration,25);end+=cue.duration;}}assert.equal(end,600);
      // Mock the trusted, separately validated renderer contract. This is not a real film or a provider success claim.
      const bytes=Buffer.alloc(2048);bytes.writeUInt32BE(32,0);bytes.write('ftyp',4);bytes.write('isom',8);const directory=path.join(dataDir,'generated',lesson.id);await mkdir(directory,{recursive:true});const file=path.join(directory,'mock-renderer-artifact.mp4');await writeFile(file,bytes);return{file,duration:600,width:1280,height:720,fps:30,sha256:createHash('sha256').update(bytes).digest('hex')};},
  };
  let app=await createApp({dataDir:temporary,seedDemo:true,generation}),server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string};
  const request=async(client:Client|null,url:string,method='GET',body?:any)=>{const headers:Record<string,string>={};if(client){headers.Cookie=client.cookie;if(method!=='GET')headers['X-CSRF-Token']=client.csrf;}if(body!==undefined&&!(body instanceof FormData))headers['Content-Type']='application/json';const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());return{status:response.status,data,response};};
  const login=async(email:string,password:string):Promise<Client>=>{const result=await request(null,'/api/auth/login','POST',{email,password});assert.equal(result.status,200);return{cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken};};
  const waitStatus=async(client:Client,id:string,status:string)=>{for(let i=0;i<500;i++){const result=await request(client,`/api/generated-lessons/${id}`);if(result.data.status===status)return result.data;if(result.data.status==='failed'&&status!=='failed')assert.fail(result.data.error);await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for '+status);};
  let teacher:Client,admin:Client,other:Client,ru:any,kaa:any,material:any;
  try{
    teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');other=await login('other@aiteacher.local','PepeOnly-external-teacher-2026!');
    assert.equal((await request(admin,'/api/institutions/demo-school','PATCH',{settings:{allowExternalAI:true}})).status,200);
    await t.test('a topic needs no documents or subject and concurrent duplicate submissions share one job',async()=>{
      const before=(await app.locals.db.query("SELECT COUNT(*)::int AS count FROM entities WHERE kind='schedule'")).rows[0].count;
      const body={title:'Производная по названию темы',language:'ru',idempotencyKey:'same-request-topic-001'};const submitted=await Promise.all([request(teacher,'/api/generated-lessons','POST',body),request(teacher,'/api/generated-lessons','POST',body)]);assert.deepEqual(submitted.map(item=>item.status).sort(),[200,202]);assert.equal(submitted[0].data.id,submitted[1].data.id);ru=await waitStatus(teacher,submitted[0].data.id,'failed');
      assert.equal(ru.engine,'codex');assert.equal(ru.language,'ru');assert.equal(ru.targetDuration,600);assert.equal(ru.materialId,undefined);assert.deepEqual(ru.materialIds,[]);assert.equal(requests.length,1);assert.equal(requests[0].source,'');assert.equal(ru.duration,600);assert.equal(ru.status,'failed');assert.match(ru.error,/Сборка.*ошибкой/);assert.equal(ru.errorCode,'CODEX_RENDER_FAILED');assert.equal(ru.errorStage,'visuals');assert.equal(ru.artifact,undefined);assert.equal((await request(teacher,`/api/generated-lessons/${ru.id}/manifest`)).status,409);
      assert.equal((await app.locals.db.query("SELECT COUNT(*)::int AS count FROM entities WHERE kind='schedule'")).rows[0].count,before);assert.equal((await request(other,`/api/generated-lessons/${ru.id}`)).status,403);
      const neutral=(await app.locals.db.query('SELECT data FROM entities WHERE id=$1',[ru.subjectId])).rows[0].data;assert.equal(neutral.name,'Авторские уроки');
    });
    await t.test('retrying a failed render reuses all measured audio and author history is permanent',async()=>{
      const voices=voiceRequests.length;visualFailure=false;const retried=await request(teacher,`/api/generated-lessons/${ru.id}/retry`,'POST',{revision:ru.revision});assert.equal(retried.status,202);ru=await waitStatus(teacher,ru.id,'ready');assert.equal(voiceRequests.length,voices);assert.equal(requests.length,1);assert.equal(ru.artifact.duration,600);assert.equal(visualRequests,2);assert.equal((await request(teacher,`/api/generated-lessons/${ru.id}/manifest`)).data.engine,'codex');assert.equal((await request(teacher,ru.artifact.videoUrl)).status,200);assert.equal((await request(null,ru.artifact.videoUrl)).status,401);assert.equal((await request(other,ru.artifact.videoUrl)).status,403);
      assert.equal((await request(teacher,'/api/lesson-publications')).data.some((item:any)=>item.id===ru.id),false);assert.equal((await request(teacher,'/api/generated-lessons')).data.some((item:any)=>item.id===ru.id),true);
    });
    await t.test('publication dates affect Today without changing the schedule or deleting the author film',async()=>{
      const before=(await app.locals.db.query("SELECT data FROM entities WHERE kind='schedule' ORDER BY id")).rows;
      const at=Date.now(),published=await request(teacher,`/api/generated-lessons/${ru.id}/publication`,'PATCH',{revision:ru.revision,startsAt:new Date(at-60000).toISOString(),endsAt:new Date(at+60000).toISOString(),timezone:'Asia/Tashkent'});assert.equal(published.status,200);ru=published.data;assert.equal((await request(teacher,'/api/lesson-publications')).data.some((item:any)=>item.id===ru.id),true);
      assert.equal((await request(teacher,`/api/generated-lessons/${ru.id}/publication`,'PATCH',{revision:ru.revision-1,startsAt:null,endsAt:null})).status,409);assert.equal((await request(teacher,`/api/generated-lessons/${ru.id}/publication`,'PATCH',{revision:ru.revision,startsAt:'2027-01-02T00:00:00Z',endsAt:'2027-01-01T00:00:00Z'})).status,400);
      const ended=await request(teacher,`/api/generated-lessons/${ru.id}/publication`,'PATCH',{revision:ru.revision,startsAt:new Date(at-120000).toISOString(),endsAt:new Date(at-60000).toISOString(),timezone:'Asia/Tashkent'});assert.equal(ended.status,200);ru=ended.data;assert.equal((await request(teacher,'/api/lesson-publications')).data.some((item:any)=>item.id===ru.id),false);assert.equal((await request(teacher,ru.artifact.videoUrl)).status,200);
      const cleared=await request(teacher,`/api/generated-lessons/${ru.id}/publication`,'PATCH',{revision:ru.revision,startsAt:null,endsAt:null});assert.equal(cleared.status,200);ru=cleared.data;assert.equal(ru.publication,undefined);assert.deepEqual((await app.locals.db.query("SELECT data FROM entities WHERE kind='schedule' ORDER BY id")).rows,before);
    });
    await t.test('optional files are supplemental ideas and never require an unrelated subject',async()=>{
      const form=new FormData();form.set('title','Дополнительная учебная идея');form.set('files',new Blob(['Дополнительный пример: производная координаты равна мгновенной скорости.']),'ideas.txt');const stored=await request(teacher,'/api/lesson-materials','POST',form);assert.equal(stored.status,201,JSON.stringify(stored.data));material=stored.data;assert.equal(material.subjectId,ru.subjectId);
      const created=await request(teacher,'/api/generated-lessons','POST',{title:'Qaraqalpaq tilinde sabaq',language:'kaa',materialIds:[material.id]});assert.equal(created.status,202);kaa=await waitStatus(teacher,created.data.id,'ready');assert.equal(kaa.language,'kaa');assert.equal(kaa.status,'ready');assert.equal(kaa.artifact.duration,600);assert.equal(kaa.languageReview,undefined);assert.ok(requests.at(-1)!.source.includes('additionalTeachingIdeas'));assert.equal(kaa.duration,600);assert.equal((await request(teacher,kaa.chapters[0].audioUrl)).status,200);assert.equal((await request(teacher,kaa.chapters[0].cues[0].audioUrl)).status,200);assert.equal((await request(teacher,`/api/generated-lessons/${kaa.id}/manifest`)).status,200);
      assert.equal((await request(other,`/api/generated-lessons/${kaa.id}/language-approval`,'POST',{revision:kaa.revision})).status,403);assert.equal((await request(teacher,`/api/generated-lessons/${kaa.id}/language-approval`,'POST',{revision:kaa.revision-1})).status,409);
      assert.equal((await request(teacher,`/api/generated-lessons/${kaa.id}/language-approval`,'POST',{revision:kaa.revision})).status,409);assert.equal(kaa.languageReview,undefined);
      assert.equal((await request(other,'/api/generated-lessons','POST',{title:'Foreign access',language:'ru',institutionId:'demo-school',materialIds:[material.id]})).status,403);
    });
    await t.test('duration correction is bounded to three passes and never pads minutes of silence',async()=>{
      shortVoice=true;const scriptCount=requests.length,voices=voiceRequests.length;const result=await request(teacher,'/api/generated-lessons','POST',{title:'Слишком короткая озвучка',language:'ru'});assert.equal(result.status,202);const failed=await waitStatus(teacher,result.data.id,'failed');assert.equal(failed.fitAttempts,3);assert.equal(requests.length-scriptCount,3);assert.equal(voiceRequests.length-voices,24);assert.ok(requests.at(-1)!.currentScript);assert.equal(requests.at(-1)!.measuredDuration,480);assert.equal(failed.artifact,undefined);assert.match(failed.error,/три попытки/);shortVoice=false;
    });
    await t.test('restart preserves source associations, automatic language completion and 600-second artifact metadata',async()=>{
      await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();app=await createApp({dataDir:temporary,seedDemo:false,generation});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');assert.deepEqual((await request(teacher,`/api/generated-lessons/${ru.id}`)).data,ru);assert.deepEqual((await request(teacher,`/api/generated-lessons/${kaa.id}`)).data,kaa);assert.equal((await request(teacher,kaa.artifact.videoUrl)).status,200);
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});}
});
