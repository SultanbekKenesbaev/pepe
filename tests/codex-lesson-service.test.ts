import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { migrateUniversity } from '../server/university-migration.js';
import { migratePlatform } from '../server/platform.js';
import { installGeneratedLessons } from '../server/generated-lessons.js';
import type { CodexLessonService, CodexScriptRequest } from '../server/codex-lessons.js';
import type { GeneratedLesson, User } from '../shared/types.js';
import { pcmWave, waveDuration } from '../server/cinema.js';
import { ApiError } from '../server/security.js';

test('shared Codex service preserves direct/HTTP authorization, idempotency, retry, automatic languages and safe artifacts',{timeout:60000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'codex-service-'));
  const db=await openDatabase(path.join(temporary,'postgres'));
  const owner:User={id:'owner-admin',name:'Owner',email:'owner@example.test',role:'ADMIN',institutionId:'own',active:true};
  // Partner jobs use an existing owner's FK, with teacher scope rather than administrator access.
  const partner:User={...owner,role:'TEACHER'};
  const other:User={...partner,id:'other-teacher',email:'other@example.test'};
  const foreign:User={...partner,id:'foreign-teacher',institutionId:'foreign',email:'foreign@example.test'};
  const principals:Record<string,User>={partner,owner,other,foreign};
  for(const institutionId of ['own','foreign'])await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)',[institutionId,{id:institutionId,name:institutionId,type:'UNIVERSITY',settings:{allowExternalAI:false}}]);
  for(const user of [owner,other,foreign])await db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)',[user.id,user.institutionId,user.email,'unused-test-hash',user]);
  await migrateUniversity(db,false);await migratePlatform(db);
  let scriptCalls=0,voiceCalls=0,visualCalls=0,failVisual=true;
  const app=express();app.use(express.json());
  app.use((req:any,_res,next)=>{req.user=principals[req.get('X-Test-Principal')||'partner'];next();});
  const audits:string[]=[];
  const ctx:any={dataDir:temporary,audit:async(_user:User,action:string)=>{audits.push(action);}};
  installGeneratedLessons(app,db,ctx,{
    voiceModel:'gemini-3.8-flash-tts',voice:'Puck',
    codexScriptProvider:async(request:CodexScriptRequest)=>{scriptCalls++;return{title:request.title,summary:'Explicit isolated service fixture.',direction:'Пространственное объяснение изменения.',chapters:Array.from({length:3},(_,chapter)=>({id:`chapter-${chapter}`,title:'Глава',scene:'custom' as const,headline:'Изменение',labels:[],values:[],palette:'dark' as const,visualDirection:'Камера следует за моделью.',cues:Array.from({length:4},(_,cue)=>({id:`cue-${chapter}-${cue}`,text:`${request.title}: учебный пример ${chapter}, реплика ${cue}.`,visualAction:'Модель изменяется вместе с объяснением.'}))}))};},
    voiceProvider:async()=>{voiceCalls++;return pcmWave(Buffer.alloc(48000*48));},
    codexVisualProvider:async({lesson,dataDir})=>{visualCalls++;if(failVisual)throw new Error('CODEX_RENDER_FAILED');
      // Trusted artifact mock only: no renderer, model or external request is run by this test.
      const bytes=Buffer.alloc(2048);bytes.write('ftyp',4);const file=path.join(dataDir,'generated',lesson.id,'film.mp4');await writeFile(file,bytes);return{file,duration:600,width:1280,height:720,fps:24,sha256:createHash('sha256').update(bytes).digest('hex')};},
  });
  app.use((error:any,_req:any,res:any,_next:any)=>{if(!res.headersSent)res.status(error instanceof ApiError?error.status:500).json({code:error.code||'INTERNAL_ERROR'});});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`,service=ctx.codexLessons as CodexLessonService;
  const request=async(url:string,method='GET',body?:unknown,principal='partner')=>fetch(base+url,{method,headers:{'X-Test-Principal':principal,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const status=async(id:string,expected:string)=>{for(let count=0;count<500;count++){const lesson=await service.get(partner,id);if(lesson.status===expected)return lesson;if(lesson.status==='failed'&&expected!=='failed')assert.fail(lesson.error);await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for '+expected);};
  const rejects=(operation:Promise<unknown>,code:string)=>assert.rejects(operation,(error:unknown)=>error instanceof ApiError&&error.code===code);
  let ru:GeneratedLesson,kaa:GeneratedLesson;
  try{
    await t.test('direct calls enforce AI permission, roles, tenant and payload validation before a job exists',async()=>{
      assert.equal(ctx.generationIsClosing(),false);
      await rejects(service.assertAllowed('own'),'EXTERNAL_AI_DISABLED');
      await rejects(service.create(partner,{title:'Производная',language:'ru'}),'EXTERNAL_AI_DISABLED');
      await db.query("UPDATE institutions SET data=jsonb_set(data,'{settings,allowExternalAI}','true'::jsonb) WHERE id='own'");
      await service.checkAvailable(partner);await service.assertAllowed('own');
      const unavailable:any={dataDir:temporary,audit:ctx.audit};installGeneratedLessons(express(),db,unavailable,{voiceProvider:async()=>{throw new Error('Must not be called');},codexScriptProvider:undefined,codexVisualProvider:undefined});
      await rejects(unavailable.codexLessons.assertAllowed('own'),'AUTHORING_NOT_CONFIGURED');await unavailable.finishGeneratedJobs();
      await rejects(service.checkAvailable(partner,'foreign'),'FORBIDDEN');
      await rejects(service.create({...partner,role:'STUDENT'},{title:'Производная',language:'ru'}),'FORBIDDEN');
      await rejects(service.create({...partner,active:false},{title:'Производная',language:'ru'}),'FORBIDDEN');
      await rejects(service.create(partner,{title:'Производная',language:'ru',institutionId:'foreign'}),'FORBIDDEN');
      await rejects(service.create(partner,{title:'x',language:'ru'}),'VALIDATION_ERROR');
      await rejects(service.create(partner,{title:'Производная',language:'ru'},{id:'../escape'}),'VALIDATION_ERROR');
      await rejects(service.create(partner,{title:'Производная',language:'ru',materialIds:['missing']}),'NOT_FOUND');
      assert.equal((await db.query('SELECT id FROM generated_lessons')).rows.length,0);assert.equal(scriptCalls,0);
    });
    await t.test('a reserved partner ID, concurrent replay and old HTTP POST all share the same persisted job',async()=>{
      const input={title:'Производная',language:'ru' as const,idempotencyKey:'partner-scoped-request-001'},id='1'.repeat(32);
      const results=await Promise.all([service.create(partner,input,{id}),service.create(partner,input,{id})]);
      assert.deepEqual(results.map(result=>result.created).sort(),[false,true]);assert.ok(results.every(result=>result.lesson.id===id));
      ru=await status(id,'failed');assert.equal(ru.teacherId,owner.id);assert.equal(ru.duration,600);assert.equal(scriptCalls,1);assert.equal(voiceCalls,12);assert.equal(visualCalls,1);
      const replay=await request('/api/generated-lessons','POST',input);assert.equal(replay.status,200);assert.equal((await replay.json()).id,id);assert.equal(scriptCalls,1);
      await rejects(service.create(partner,{...input,idempotencyKey:'different-request-002'},{id}),'LESSON_ID_CONFLICT');
      await rejects(service.get(other,id),'FORBIDDEN');await rejects(service.get(foreign,id),'FORBIDDEN');
      await rejects(service.getVideo(partner,id),'LESSON_NOT_READY');await rejects(service.getAudio(partner,id,{chapterId:'chapter-0'}),'AUDIO_NOT_READY');
      assert.equal((await db.query('SELECT data FROM users WHERE id=$1',[owner.id])).rows[0].data.role,'ADMIN');
    });
    await t.test('explicit revision-safe retry reuses audio and exposes the same ready film to both adapters',async()=>{
      await rejects(service.retry(other,ru.id,ru.revision),'FORBIDDEN');await rejects(service.retry(partner,ru.id,ru.revision-1),'REVISION_CONFLICT');
      failVisual=false;const voices=voiceCalls;await service.retry(partner,ru.id,ru.revision);ru=await status(ru.id,'ready');
      assert.equal(voiceCalls,voices);assert.equal(scriptCalls,1);assert.equal(visualCalls,2);
      const video=await service.getVideo(partner,ru.id);assert.equal(video.contentType,'video/mp4');assert.equal(video.bytes,2048);assert.equal(video.sha256,createHash('sha256').update(await readFile(video.file)).digest('hex'));
      const response=await request(`/api/generated-lessons/${ru.id}/video`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(video.file));
      const detail=await request(`/api/generated-lessons/${ru.id}`);assert.equal(detail.status,200);assert.equal((await detail.json()).id,ru.id);
      const manifest=await request(`/api/generated-lessons/${ru.id}/manifest`);assert.equal(manifest.status,200);assert.equal((await manifest.json()).id,ru.id);
      await rejects(service.retry(partner,ru.id,ru.revision),'GENERATION_BUSY');
      const before=[scriptCalls,voiceCalls,visualCalls];assert.equal((await service.create(partner,{title:'Производная',language:'ru',idempotencyKey:'partner-scoped-request-001'})).created,false);assert.deepEqual([scriptCalls,voiceCalls,visualCalls],before);
    });
    await t.test('Karakalpak runs directly to ready with protected narration and no human approval',async()=>{
      const created=await service.create(partner,{title:'Qaraqalpaq sabaq',language:'kaa'},{id:'2'.repeat(32)});kaa=await status(created.lesson.id,'ready');
      assert.equal(visualCalls,3);assert.equal((await service.getVideo(partner,kaa.id)).contentType,'video/mp4');assert.equal(kaa.languageReview,undefined);
      const chapter=await service.getAudio(partner,kaa.id,{chapterId:kaa.chapters[0].id}),cue=await service.getAudio(partner,kaa.id,{cueId:kaa.chapters[0].cues![0].id});
      assert.equal(chapter.contentType,'audio/wav');assert.equal(waveDuration(await readFile(cue.file)),48);assert.ok(chapter.bytes>cue.bytes);
      for(const url of [kaa.chapters[0].audioUrl!,kaa.chapters[0].cues![0].audioUrl!]){const response=await request(url);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>44);}
      await rejects(service.getAudio(other,kaa.id,{cueId:kaa.chapters[0].cues![0].id}),'FORBIDDEN');await rejects(service.approveLanguage(other,kaa.id,kaa.revision),'FORBIDDEN');
      await rejects(service.approveLanguage(partner,kaa.id,kaa.revision),'LANGUAGE_REVIEW_REQUIRED');
      assert.equal(kaa.languageReview,undefined);assert.equal(visualCalls,3);assert.ok(!audits.includes('generated-lesson.language-approve'));
    });
    await t.test('artifact helpers reject symlinks and path selectors and never start a generation on reads',async()=>{
      const before=[scriptCalls,voiceCalls,visualCalls],video=await service.getVideo(partner,ru.id),original=video.file+'.saved';
      await rename(video.file,original);await symlink(original,video.file);await rejects(service.getVideo(partner,ru.id),'NOT_FOUND');await rm(video.file);await rename(original,video.file);
      const chapter=await service.getAudio(partner,kaa.id,{chapterId:kaa.chapters[0].id});await rename(chapter.file,chapter.file+'.saved');await symlink(chapter.file+'.saved',chapter.file);await rejects(service.getAudio(partner,kaa.id,{chapterId:kaa.chapters[0].id}),'NOT_FOUND');
      await rejects(service.getAudio(partner,kaa.id,{chapterId:'../escape'}),'AUDIO_NOT_READY');
      await service.get(partner,ru.id);assert.deepEqual([scriptCalls,voiceCalls,visualCalls],before);
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await ctx.finishGeneratedJobs();assert.equal(ctx.generationIsClosing(),true);await assert.rejects(service.checkAvailable(partner),{name:'AbortError'});await db.close();await rm(temporary,{recursive:true,force:true});}
});
