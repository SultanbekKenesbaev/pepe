import type { Express } from 'express';
import { z } from 'zod';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, copyFile, lstat, realpath, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import type { GeneratedLesson, GeneratedLessonChapter, GeneratedLessonCue, GeneratedLessonLanguage, GeneratedLessonVideoMode, GeneratedLessonVoiceProfile, GeneratedLessonWorkerProgress, Lesson, LessonMaterialDetail, LessonPublication, User } from '../shared/types.js';
import type { LessonGenerationConfig } from './generated-lessons.js';
import { permitted, tenant } from './access.js';
import { ApiError, uid, now } from './security.js';
import { parse } from './validation.js';
import { resolveAuthoringSubject } from './platform.js';
import { localDate, timeAt } from './university.js';
import { pcmWave, waveDuration } from './cinema.js';
import { stampGenerationProgress } from './generation-progress.js';
import { googleSpeechBody } from './tts-output.js';

const identifier=z.string().trim().transform(value=>value.toLowerCase().replace(/_/g,'-')).pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/));
const cueSchema=z.object({id:identifier,text:z.string().trim().min(5).max(2000),visualAction:z.string().trim().min(5).max(3000)});
const chapterSchema=z.object({id:identifier,title:z.string().trim().min(1).max(200),narration:z.string().trim().max(12000).optional(),scene:z.literal('custom').default('custom'),headline:z.string().trim().min(1).max(200),formula:z.string().max(1000).optional(),labels:z.array(z.string().max(200)).max(30).default([]),values:z.array(z.number().finite()).max(30).default([]),example:z.string().max(3000).optional(),palette:z.enum(['light','dark']).default('dark'),visualDirection:z.string().trim().min(5).max(8000),cues:z.array(cueSchema).min(1).max(10)});
export const codexScriptSchema=z.object({title:z.string().trim().min(1).max(200),summary:z.string().max(2000),direction:z.string().trim().min(5).max(12000),chapters:z.array(chapterSchema).min(3).max(16)}).superRefine((script,ctx)=>{
  const chapterIds=script.chapters.map(chapter=>chapter.id),cueIds=script.chapters.flatMap(chapter=>chapter.cues.map(cue=>cue.id));
  if(new Set(chapterIds).size!==chapterIds.length||new Set(cueIds).size!==cueIds.length)ctx.addIssue({code:'custom',message:'Идентификаторы глав и реплик должны быть уникальны'});
  if(cueIds.length<12||cueIds.length>40)ctx.addIssue({code:'custom',message:'Для десятиминутного фильма нужно от 12 до 40 реплик'});
  if(script.chapters.flatMap(chapter=>chapter.cues).reduce((total,cue)=>total+cue.text.length,0)>35000)ctx.addIssue({code:'custom',message:'Сценарий содержит более 35 000 символов озвучки'});
});
export type CodexScript=z.infer<typeof codexScriptSchema>;
export interface CodexScriptRequest {lessonId:string;title:string;language:GeneratedLessonLanguage;videoMode?:GeneratedLessonVideoMode;source:string;targetDuration:600;voiceModel:string;signal:AbortSignal;currentScript?:CodexScript;measuredDuration?:number;onProgress?:(progress:GeneratedLessonWorkerProgress)=>Promise<void>}
export interface CodexVisualRequest {lesson:GeneratedLesson;dataDir:string;signal:AbortSignal;onProgress?:(progress:GeneratedLessonWorkerProgress)=>Promise<void>}
export interface CodexVisualArtifact {file:string;duration:number;width:number;height:number;fps:number;sha256:string}
interface Services {
  dataDir:string;config:LessonGenerationConfig;signal:AbortSignal;ensureRunning:()=>void;
  runJob:(id:string,operation:()=>Promise<void>)=>void;
  serializeVoice:<T>(operation:()=>Promise<T>)=>Promise<T>;
  speechRequest:(config:LessonGenerationConfig,text:string,instructions:string)=>Promise<Buffer>;
  loadGenerated:(db:DB,user:User,id:string,allowSharedReady?:boolean)=>Promise<GeneratedLesson>;
  saveGenerated:(db:DB,lesson:GeneratedLesson)=>Promise<void>;
  voiceConfigured:()=>Promise<boolean>;
}
const zone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Неизвестный часовой пояс');
const publicationSchema=z.object({startsAt:z.string().datetime({offset:true}).nullable().optional(),endsAt:z.string().datetime({offset:true}).nullable().optional(),timezone:zone.optional()}).superRefine((value,ctx)=>{if(value.startsAt&&value.endsAt&&Date.parse(value.endsAt)<=Date.parse(value.startsAt))ctx.addIssue({code:'custom',message:'Окончание должно быть позже начала'});});
const createSchema=z.object({title:z.string().trim().min(2).max(200),language:z.enum(['ru','kaa','uz']),videoMode:z.enum(['2d','3d']).default('2d'),subjectId:z.string().min(1).max(128).optional(),materialIds:z.array(z.string().min(1).max(128)).max(12).default([]),idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(),publication:publicationSchema.optional()});
export type CodexLessonCreateInput=z.input<typeof createSchema>&{institutionId?:string};
export type CodexLessonAudioSelector={chapterId:string;cueId?:never}|{cueId:string;chapterId?:never};
export interface CodexLessonAudio {file:string;contentType:'audio/wav';bytes:number}
export interface CodexLessonVideo {file:string;contentType:'video/mp4';bytes:number;sha256:string}
export interface CodexLessonService {
  /** A reserved ID is accepted only from trusted server code, never from the HTTP body. */
  create(user:User,input:CodexLessonCreateInput,options?:{id?:string}):Promise<{lesson:GeneratedLesson;created:boolean}>;
  get(user:User,id:string):Promise<GeneratedLesson>;
  retry(user:User,id:string,revision:number):Promise<GeneratedLesson>;
  approveLanguage(user:User,id:string,revision:number):Promise<GeneratedLesson>;
  /** Continue pre-upgrade waiting rows; ready/failed jobs are never restarted. */
  resumeWaitingLanguageLessons():Promise<{started:number;skipped:number}>;
  getAudio(user:User,id:string,selector:CodexLessonAudioSelector):Promise<CodexLessonAudio>;
  getVideo(user:User,id:string):Promise<CodexLessonVideo>;
  checkAvailable(user:User,institutionId?:string,videoMode?:GeneratedLessonVideoMode):Promise<void>;
  /** Internal integration preflight; the caller must authenticate and scope the institution first. */
  assertAllowed(institutionId:string,videoMode?:GeneratedLessonVideoMode):Promise<void>;
}
function publicationValue(input:z.infer<typeof publicationSchema>|undefined):LessonPublication|undefined {
  if(!input?.startsAt&&!input?.endsAt)return undefined;
  return {...(input.startsAt?{startsAt:new Date(input.startsAt).toISOString()}:{}),...(input.endsAt?{endsAt:new Date(input.endsAt).toISOString()}:{}),timezone:input.timezone||'Asia/Tashkent'};
}
async function sourcesFor(db:DB,user:User,ids:string[]):Promise<{source:string;materials:LessonMaterialDetail[]}> {
  const materials:LessonMaterialDetail[]=[];
  for(const id of [...new Set(ids)]){
    const material=(await db.query('SELECT data FROM lesson_materials WHERE id=$1',[id])).rows[0]?.data as LessonMaterialDetail|undefined;
    if(!material)throw new ApiError(404,'Дополнительный материал не найден','NOT_FOUND');tenant(user,material.institutionId);
    if(user.role==='TEACHER'&&material.teacherId!==user.id)throw new ApiError(403,'Материалы другого преподавателя','FORBIDDEN');materials.push(material);
  }
  const source=materials.map(material=>JSON.stringify({title:material.title,additionalTeachingIdeas:material.documents.map(document=>document.text).filter(Boolean)})).join('\n');
  if(source.length>180000)throw new ApiError(400,'Дополнительные материалы превышают 180 000 символов. Выберите меньше файлов.','SOURCE_TOO_LARGE');return {source,materials};
}
function copyScript(lesson:GeneratedLesson):CodexScript {
  return codexScriptSchema.parse({title:lesson.title,summary:lesson.summary,direction:lesson.direction,chapters:lesson.chapters});
}
function storeScript(lesson:GeneratedLesson,script:CodexScript) {
  lesson.title=script.title;lesson.summary=script.summary;lesson.direction=script.direction;
  lesson.chapters=script.chapters.map(chapter=>({...chapter,narration:chapter.cues.map(cue=>cue.text).join('\n\n'),start:0,duration:0}));
}
function voiceProfile(config:LessonGenerationConfig,lesson:GeneratedLesson):GeneratedLessonVoiceProfile {
  return {model:config.voiceModel!,voice:config.voice!,language:lesson.language||'ru',styleVersion:'authoring-cue-v1',...(config.voiceBackend==='openrouter'?{backend:'openrouter' as const}:{})};
}
function cueVoiceHash(cue:GeneratedLessonCue,profile:GeneratedLessonVoiceProfile) {
  // Keep this key order and style version compatible with existing per-cue cache files.
  return createHash('sha256').update(JSON.stringify({text:cue.text,model:profile.model,voice:profile.voice,language:profile.language,style:profile.styleVersion,...(profile.backend?{backend:profile.backend}:{})})).digest('hex');
}
function currentAudio(lesson:GeneratedLesson,profile:GeneratedLessonVoiceProfile) {
  const previous=lesson.voiceProfile;
  if(previous&&(previous.model!==profile.model||previous.voice!==profile.voice||previous.language!==profile.language||previous.styleVersion!==profile.styleVersion||(previous.backend||'google')!==(profile.backend||'google')))return false;
  return lesson.duration===600&&lesson.chapters.length>0&&lesson.chapters.every(chapter=>chapter.audioUrl&&chapter.cues?.length&&chapter.cues.every(cue=>cue.start!==undefined&&cue.duration!==undefined&&cue.audioHash===cueVoiceHash(cue,profile)));
}
function clearAudio(lesson:GeneratedLesson) {
  lesson.duration=0;delete lesson.artifact;delete lesson.approvedAt;
  delete lesson.languageReview;
  for(const chapter of lesson.chapters){chapter.start=0;chapter.duration=0;delete chapter.audioUrl;delete chapter.audioDuration;
    for(const cue of chapter.cues||[]){delete cue.start;delete cue.duration;delete cue.audioDuration;delete cue.audioUrl;delete cue.audioHash;}
  }
}
/** PCM speech output is joined without resampling; timing is exact to a 24 kHz sample. */
function pcm24k(wave:Buffer):Buffer {
  waveDuration(wave);let format=false;const data:Buffer[]=[];
  for(let offset=12;offset+8<=wave.length;){const name=wave.toString('ascii',offset,offset+4),size=wave.readUInt32LE(offset+4),start=offset+8;if(start+size>wave.length)throw new Error('GENERATION_PCM_INVALID');
    if(name==='fmt '){if(size<16||wave.readUInt16LE(start)!==1||wave.readUInt16LE(start+2)!==1||wave.readUInt32LE(start+4)!==24000||wave.readUInt16LE(start+14)!==16)throw new Error('GENERATION_PCM_FORMAT');format=true;}
    if(name==='data')data.push(wave.subarray(start,start+size));offset=start+size+size%2;
  }
  const bytes=Buffer.concat(data);if(!format||!bytes.length||bytes.length%2)throw new Error('GENERATION_PCM_INVALID');return bytes;
}
export function cueSpeechInstructions(language:GeneratedLessonLanguage) {
  const direction=language==='kaa'?'Speak only natural Karakalpak (Qaraqalpaq tili), preserving the supplied script and its Latin or Cyrillic writing system. Do not translate to Russian, Kazakh, Uzbek or Turkish. If pronunciation is uncertain, preserve the written words.':language==='uz'?'Speak only natural Uzbek (O‘zbek tili), preserving the supplied script and its Latin or Cyrillic writing system. Do not translate to Russian, Karakalpak, Kazakh or Turkish. Pronounce mathematical formulas clearly. Read the supplied Uzbek words exactly.':'Speak natural Russian, preserving the exact supplied transcript. Pronounce mathematical formulas clearly.';
  return `An original charismatic university science presenter. Warm, clear, energetic, conversational; short natural breaths, no background audio, no extra words or introduction. ${direction} Read only the exact transcript.`;
}
export function cueTtsBody(cue:GeneratedLessonCue,language:GeneratedLessonLanguage,model:string,voice:string) {
  return googleSpeechBody(cue.text,cueSpeechInstructions(language),model,voice);
}
async function writeAtomic(file:string,bytes:Buffer|string){await writeFile(file+'.tmp',bytes,{mode:0o600});await rename(file+'.tmp',file);}

export function installCodexLessons(app:Express,db:DB,ctx:any,services:Services):CodexLessonService {
  const {dataDir,config,signal,ensureRunning,runJob,serializeVoice,speechRequest,loadGenerated,saveGenerated,voiceConfigured}=services;
  async function allowed(institutionId:string,videoMode:GeneratedLessonVideoMode='3d'){
    const institution=(await db.query('SELECT data FROM institutions WHERE id=$1',[institutionId])).rows[0]?.data;
    if(institution?.settings?.allowExternalAI!==true)throw new ApiError(403,'Администратор должен разрешить AI в настройках университета','EXTERNAL_AI_DISABLED');
    if(!config.codexScriptProvider||!config.codexVisualProvider)throw new ApiError(503,'Авторская генерация ещё не настроена администратором','AUTHORING_NOT_CONFIGURED');
    if(config.codexVideoModes&&!config.codexVideoModes.includes(videoMode))throw new ApiError(503,`${videoMode.toUpperCase()}-генерация ещё не настроена администратором`,videoMode==='2d'?'CODEX_2D_WORKER_NOT_CONFIGURED':'CODEX_WORKER_NOT_CONFIGURED');
    if(!await voiceConfigured())throw new ApiError(503,'Озвучка ещё не настроена администратором','GENERATION_NOT_CONFIGURED');ensureRunning();
  }
  async function buildVisuals(lesson:GeneratedLesson) {
    ensureRunning();lesson.status='generating';lesson.progress={stage:'visuals',completed:0,total:1};await saveGenerated(db,lesson);
    const artifact=await config.codexVisualProvider!({lesson:structuredClone(lesson),dataDir,signal,onProgress:async progress=>{ensureRunning();lesson.progress={stage:'visuals',...progress};await saveGenerated(db,lesson);}});ensureRunning();
    lesson.progress={stage:'checking',completed:0,total:1};await saveGenerated(db,lesson);
    if(!Number.isFinite(artifact.duration)||Math.abs(artifact.duration-600)>.05||!Number.isInteger(artifact.width)||artifact.width<640||!Number.isInteger(artifact.height)||artifact.height<360||!Number.isFinite(artifact.fps)||artifact.fps<20||artifact.fps>120||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new Error('GENERATION_ARTIFACT_INVALID');
    const info=await lstat(artifact.file);if(!info.isFile()||info.isSymbolicLink()||info.size<1024||info.size>512*1024*1024)throw new Error('GENERATION_ARTIFACT_INVALID');
    const directory=path.join(dataDir,'generated',lesson.id);await mkdir(directory,{recursive:true,mode:0o700});
    const actual=await realpath(artifact.file),root=await realpath(directory);if(!actual.startsWith(root+path.sep))throw new Error('GENERATION_ARTIFACT_PATH');
    const handle=await open(actual,'r'),head=Buffer.alloc(8);try{await handle.read(head,0,8,0);}finally{await handle.close();}
    const digest=createHash('sha256');for await(const chunk of createReadStream(actual)){ensureRunning();digest.update(chunk);}if(head.toString('ascii',4,8)!=='ftyp'||digest.digest('hex')!==artifact.sha256)throw new Error('GENERATION_ARTIFACT_INVALID');
    const target=path.join(directory,'film.mp4');if(actual!==target){await copyFile(actual,target+'.tmp');await rename(target+'.tmp',target);}
    ensureRunning();const timestamp=now(),stored:Lesson={id:lesson.lessonId||uid(),institutionId:lesson.institutionId,name:lesson.title,description:lesson.summary,subjectId:lesson.subjectId,duration:10,language:lesson.language||'ru',approved:true,cinemaId:`generated:${lesson.id}`,sections:lesson.chapters.map(chapter=>({id:chapter.id,title:chapter.title,content:chapter.narration,materialIds:[]})),quiz:[],createdAt:timestamp,updatedAt:timestamp};
    stored.videoMode=lesson.videoMode||'3d';
    await db.transaction(async tx=>{ensureRunning();await tx.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[stored.id,stored.institutionId,'lessons',stored]);ensureRunning();lesson.lessonId=stored.id;lesson.duration=600;lesson.artifact={videoUrl:`/api/generated-lessons/${lesson.id}/video?v=${artifact.sha256.slice(0,16)}`,duration:600,width:artifact.width,height:artifact.height,fps:artifact.fps,sha256:artifact.sha256};lesson.status='ready';lesson.progress={stage:'ready',completed:1,total:1};await saveGenerated(tx,lesson);});
  }
  async function pipeline(lesson:GeneratedLesson,user:User) {
    ensureRunning();const {source}=await sourcesFor(db,user,lesson.materialIds||[]),directory=path.join(dataDir,'generated',lesson.id),cache=path.join(directory,'cue-cache');await mkdir(cache,{recursive:true,mode:0o700});
    let script:CodexScript|undefined=lesson.chapters.length?copyScript(lesson):undefined;let measuredDuration:number|undefined;
    const profile=voiceProfile(config,lesson);
    if(currentAudio(lesson,profile)){
      lesson.voiceProfile=profile;delete lesson.languageReview;await saveGenerated(db,lesson);
      await buildVisuals(lesson);return;
    }
    clearAudio(lesson);lesson.voiceProfile=profile;await saveGenerated(db,lesson);
    for(let attempt=0;attempt<3;attempt++){
      ensureRunning();
      if(!script||measuredDuration!==undefined){lesson.status='drafting';lesson.progress={stage:'script',completed:attempt,total:3};await saveGenerated(db,lesson);
        script=codexScriptSchema.parse(await config.codexScriptProvider!({lessonId:lesson.id,title:lesson.title,language:lesson.language||'ru',...(lesson.videoMode?{videoMode:lesson.videoMode}:{}),source,targetDuration:600,voiceModel:profile.model,signal,onProgress:async progress=>{ensureRunning();lesson.progress={stage:'script',...progress};await saveGenerated(db,lesson);},...(script?{currentScript:script}:{}),...(measuredDuration!==undefined?{measuredDuration}:{})}));ensureRunning();storeScript(lesson,script);await saveGenerated(db,lesson);}
      lesson.status='generating';lesson.progress={stage:'voice',completed:0,total:script.chapters.reduce((total,chapter)=>total+chapter.cues.length,0)};lesson.fitAttempts=(lesson.fitAttempts||0)+1;await saveGenerated(db,lesson);
      const cueBytes=new Map<string,Buffer>();let speechSamples=0,done=0;
      for(const chapter of lesson.chapters)for(const cue of chapter.cues||[]){
        ensureRunning();const hash=cueVoiceHash(cue,profile),file=path.join(cache,hash+'.wav');let wave:Buffer|undefined;
        try{const info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink())wave=await readFile(file);if(wave)pcm24k(wave);}catch{wave=undefined;}
        if(!wave){wave=await serializeVoice<Buffer>(()=>config.voiceProvider?config.voiceProvider({...chapter,narration:cue.text}):speechRequest(config,cue.text,cueSpeechInstructions(lesson.language||'ru')));ensureRunning();pcm24k(wave);await writeAtomic(file,wave);}
        const pcm=pcm24k(wave),duration=pcm.length/48000;if(duration<1||duration>180)throw new Error('GENERATION_CUE_DURATION');
        cueBytes.set(cue.id,pcm);speechSamples+=pcm.length/2;cue.audioDuration=duration;cue.audioHash=hash;cue.audioUrl=`/api/generated-lessons/${lesson.id}/cue-audio/${cue.id}?v=${hash.slice(0,16)}`;
        lesson.progress={stage:'voice',completed:++done,total:lesson.progress.total};await saveGenerated(db,lesson);
      }
      measuredDuration=speechSamples/24000;const cueCount=cueBytes.size,minVoice=Math.max(540,600-3*cueCount);
      if(measuredDuration>600||measuredDuration<minVoice){if(attempt===2)throw new Error('GENERATION_DURATION_FIT');continue;}
      const remaining=600*24000-speechSamples,baseHold=Math.floor(remaining/cueCount);let remainder=remaining%cueCount,totalSamples=0;
      for(const chapter of lesson.chapters){const segments:Buffer[]=[],chapterStart=totalSamples;
        for(const cue of chapter.cues||[]){const pcm=cueBytes.get(cue.id)!,hold=baseHold+(remainder-->0?1:0),samples=pcm.length/2;cue.start=totalSamples/24000;cue.duration=(samples+hold)/24000;segments.push(pcm,Buffer.alloc(hold*2));totalSamples+=samples+hold;}
        const wave=pcmWave(Buffer.concat(segments));chapter.start=chapterStart/24000;chapter.duration=(totalSamples-chapterStart)/24000;chapter.audioDuration=chapter.duration;chapter.audioUrl=`/api/generated-lessons/${lesson.id}/audio/${chapter.id}?v=${createHash('sha256').update(wave).digest('hex').slice(0,16)}`;await writeAtomic(path.join(directory,chapter.id+'.wav'),wave);
      }
      if(totalSamples!==600*24000)throw new Error('GENERATION_DURATION_FIT');lesson.duration=600;lesson.approvedAt=now();
      delete lesson.languageReview;
      await saveGenerated(db,lesson);await buildVisuals(lesson);return;
    }
  }
  const principal=(user:User)=>{permitted(user,['ADMIN','TEACHER']);if(!user.active)throw new ApiError(403,'Пользователь отключён','FORBIDDEN');};
  const revisionValue=(value:number)=>parse<number>(z.number().int().nonnegative(),value);
  async function outputFile(lesson:GeneratedLesson,file:string,maxBytes=Infinity){
    const directory=path.join(dataDir,'generated',lesson.id),info=await lstat(file),directoryInfo=await lstat(directory);
    if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes||!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw new Error('INVALID_OUTPUT');
    const [actual,root,generatedRoot]=await Promise.all([realpath(file),realpath(directory),realpath(path.join(dataDir,'generated'))]);
    if(!root.startsWith(generatedRoot+path.sep)||!actual.startsWith(root+path.sep))throw new Error('INVALID_OUTPUT');return{file:actual,bytes:info.size};
  }
  const service:CodexLessonService={
    assertAllowed:allowed,
    async checkAvailable(user,institutionId,videoMode='2d'){principal(user);await allowed(tenant(user,institutionId),videoMode);},
    async create(user,value,options){
    principal(user);const institutionId=tenant(user,value?.institutionId),input=parse<z.infer<typeof createSchema>>(createSchema,value);
    // An unchanged pre-upgrade replay still belongs to its original 3D queue.
    const previous=input.idempotencyKey?(await db.query('SELECT data FROM generated_lessons WHERE institution_id=$1 AND teacher_id=$2 AND request_key=$3',[institutionId,user.id,input.idempotencyKey])).rows[0]?.data as GeneratedLesson|undefined:undefined;
    await allowed(institutionId,previous&&previous.videoMode===undefined&&value.videoMode===undefined?'3d':input.videoMode);
    const reservedId=options?.id===undefined?undefined:parse<string>(z.string().regex(/^[a-f0-9]{32}$/),options.id);
    const {materials}=await sourcesFor(db,user,input.materialIds);const timestamp=now();
    const requestFingerprint=createHash('sha256').update(JSON.stringify({title:input.title,language:input.language,videoMode:input.videoMode,subjectId:input.subjectId||null,materialIds:[...new Set(input.materialIds)].sort(),publication:publicationValue(input.publication)||null})).digest('hex');
    const result=await db.transaction(async tx=>{
      await tx.query('SELECT id FROM institutions WHERE id=$1 FOR UPDATE',[institutionId]);
      if(input.idempotencyKey){const existing=(await tx.query('SELECT data FROM generated_lessons WHERE institution_id=$1 AND teacher_id=$2 AND request_key=$3',[institutionId,user.id,input.idempotencyKey])).rows[0]?.data as GeneratedLesson|undefined;if(existing){
        if(existing.requestFingerprint?existing.requestFingerprint!==requestFingerprint:(value.videoMode!==undefined||existing.videoMode!==undefined)&&(existing.videoMode||'3d')!==input.videoMode)throw new ApiError(409,'Этот ключ уже использован для другого запроса','IDEMPOTENCY_CONFLICT');
        return{lesson:existing,created:false};}}
      if(reservedId&&(await tx.query('SELECT id FROM generated_lessons WHERE id=$1',[reservedId])).rows.length)throw new ApiError(409,'Идентификатор урока уже используется','LESSON_ID_CONFLICT');
      const subjectId=await resolveAuthoringSubject(tx,institutionId,input.subjectId||materials[0]?.subjectId),lesson:GeneratedLesson={id:reservedId||uid(),institutionId,teacherId:user.id,subjectId,title:input.title,summary:'',status:'drafting',revision:0,chapters:[],duration:0,progress:{stage:'planning',completed:0,total:1},createdAt:timestamp,updatedAt:timestamp,generationStartedAt:timestamp,engine:'codex',language:input.language,videoMode:input.videoMode,requestFingerprint,targetDuration:600,materialIds:[...new Set(input.materialIds)],...(materials[0]?{materialId:materials[0].id}:{}),publication:publicationValue(input.publication)};
      stampGenerationProgress(lesson,undefined,Date.parse(timestamp));ensureRunning();try{await tx.query('INSERT INTO generated_lessons(id,institution_id,teacher_id,material_id,revision,request_key,data) VALUES($1,$2,$3,$4,$5,$6,$7)',[lesson.id,institutionId,lesson.teacherId,lesson.materialId||null,0,input.idempotencyKey||null,lesson]);}catch(error:any){if(reservedId&&error.code==='23505')throw new ApiError(409,'Идентификатор урока уже используется','LESSON_ID_CONFLICT');throw error;}return{lesson,created:true};
    });
    const response=structuredClone(result.lesson);if(result.created)runJob(result.lesson.id,()=>pipeline(result.lesson,user));await ctx.audit(user,'generated-lesson.topic',result.lesson.id,institutionId);return{lesson:response,created:result.created};
    },
    async get(user,id){principal(user);const lesson=await loadGenerated(db,user,id);return{...lesson,videoMode:lesson.videoMode||'3d'};},
    async retry(user,id,revision){
      principal(user);revision=revisionValue(revision);const lesson=await loadGenerated(db,user,id);if(lesson.engine!=='codex')throw new ApiError(400,'Этот урок использует прежний формат');
      if(lesson.revision!==revision)throw new ApiError(409,'Урок изменился. Обновите страницу.','REVISION_CONFLICT');if(lesson.status!=='failed')throw new ApiError(409,'Урок уже готовится или готов','GENERATION_BUSY');await allowed(lesson.institutionId,lesson.videoMode||'3d');
      lesson.status='drafting';lesson.generationStartedAt=now();lesson.progress={stage:'planning',completed:0,total:1};delete lesson.error;delete lesson.errorCode;delete lesson.errorStage;await saveGenerated(db,lesson);const response=structuredClone(lesson);runJob(lesson.id,()=>pipeline(lesson,user));return response;
    },
    async approveLanguage(user,id,revision){
      principal(user);revision=revisionValue(revision);const lesson=await loadGenerated(db,user,id);
      if(lesson.revision!==revision)throw new ApiError(409,'Урок изменился. Обновите страницу.','REVISION_CONFLICT');if(lesson.engine!=='codex'||lesson.status!=='language_review')throw new ApiError(409,'Урок уже готовится или готов','LANGUAGE_REVIEW_REQUIRED');await allowed(lesson.institutionId,lesson.videoMode||'3d');
      const cached=currentAudio(lesson,voiceProfile(config,lesson));delete lesson.languageReview;delete lesson.error;delete lesson.errorCode;delete lesson.errorStage;
      lesson.generationStartedAt=now();lesson.status=cached?'generating':'drafting';lesson.progress={stage:cached?'visuals':'voice',completed:0,total:cached?1:lesson.chapters.flatMap(chapter=>chapter.cues||[]).length};
      await saveGenerated(db,lesson);const response=structuredClone(lesson);runJob(lesson.id,()=>pipeline(lesson,user));await ctx.audit(user,'generated-lesson.language-continue',lesson.id,lesson.institutionId);return response;
    },
    async resumeWaitingLanguageLessons(){
      ensureRunning();let started=0,skipped=0;
      const rows=(await db.query("SELECT data FROM generated_lessons WHERE data->>'engine'='codex' AND data->>'status'='language_review' ORDER BY data->>'createdAt',id")).rows;
      for(const row of rows){
        ensureRunning();const lesson=row.data as GeneratedLesson;
        if(!['ru','kaa','uz'].includes(lesson.language||'ru')){skipped++;continue;}
        try{
          const user=(await db.query('SELECT data FROM users WHERE id=$1',[lesson.teacherId])).rows[0]?.data as User|undefined;
          if(!user){skipped++;continue;}
          await service.approveLanguage(user,lesson.id,lesson.revision);started++;
        }catch(error){
          ensureRunning();if(!(error instanceof ApiError))throw error;skipped++;
          console.warn('Waiting lesson continuation skipped:',error.code);
        }
      }
      return{started,skipped};
    },
    async getAudio(user,id,selector){
      principal(user);const selection=z.union([z.object({chapterId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)}).strict(),z.object({cueId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)}).strict()]).safeParse(selector);
      if(!selection.success)throw new ApiError(404,'Озвучка ещё не подготовлена','AUDIO_NOT_READY');const selected=selection.data;
      const chapterId='chapterId' in selected?selected.chapterId:undefined,cueId='cueId' in selected?selected.cueId:undefined;
      const lesson=await loadGenerated(db,user,id,!!chapterId);let file:string;
      if(!['ready','language_review'].includes(lesson.status))throw new ApiError(404,'Озвучка ещё не подготовлена','AUDIO_NOT_READY');
      if(chapterId){const chapter=lesson.chapters.find(chapter=>chapter.id===chapterId);if(!chapter?.audioUrl)throw new ApiError(404,'Озвучка ещё не подготовлена','AUDIO_NOT_READY');file=path.join(dataDir,'generated',lesson.id,chapter.id+'.wav');}
      else{const cue=lesson.chapters.flatMap(chapter=>chapter.cues||[]).find(cue=>cue.id===cueId);if(!cue?.audioHash||!/^[a-f0-9]{64}$/.test(cue.audioHash))throw new ApiError(404,'Реплика ещё не подготовлена','AUDIO_NOT_READY');file=path.join(dataDir,'generated',lesson.id,'cue-cache',cue.audioHash+'.wav');}
      try{return{...await outputFile(lesson,file,60*1024*1024),contentType:'audio/wav'};}catch{throw new ApiError(404,'Аудио не найдено','NOT_FOUND');}
    },
    async getVideo(user,id){
      principal(user);const lesson=await loadGenerated(db,user,id,true);if(lesson.status!=='ready'||!lesson.artifact)throw new ApiError(409,'Фильм ещё не готов','LESSON_NOT_READY');
      const file=path.join(dataDir,'generated',lesson.id,'film.mp4');
      try{return{...await outputFile(lesson,file),contentType:'video/mp4',sha256:lesson.artifact.sha256};}catch{throw new ApiError(404,'Фильм не найден','NOT_FOUND');}
    },
  };
  app.post('/api/generated-lessons',async(req:any,res)=>{
    const result=await service.create(req.user,req.body);res.status(result.created?202:200).json(result.lesson);
  });
  app.post('/api/generated-lessons/:id/retry',async(req:any,res)=>{
    const input=parse<{revision:number}>(z.object({revision:z.number().int().nonnegative()}),req.body);res.status(202).json(await service.retry(req.user,req.params.id,input.revision));
  });
  app.patch('/api/generated-lessons/:id/publication',async(req:any,res)=>{
    const input=parse<z.infer<typeof publicationSchema>&{revision:number}>(publicationSchema.and(z.object({revision:z.number().int().nonnegative()})),req.body),lesson=await loadGenerated(db,req.user,req.params.id);
    if(lesson.revision!==input.revision)throw new ApiError(409,'Урок изменился. Обновите страницу.','REVISION_CONFLICT');if(['drafting','generating'].includes(lesson.status))throw new ApiError(409,'Дождитесь подготовки урока','GENERATION_BUSY');
    lesson.publication=publicationValue(input);await saveGenerated(db,lesson);await ctx.audit(req.user,'generated-lesson.publication',lesson.id,lesson.institutionId);res.json(lesson);
  });
  app.get('/api/lesson-publications',async(req:any,res)=>{
    permitted(req.user,['ADMIN','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId),date=req.query.date?parse<string>(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value),req.query.date):undefined;
    const rows=(await db.query('SELECT data FROM generated_lessons WHERE institution_id=$1 ORDER BY data->>\'updatedAt\' DESC',[institutionId])).rows.map(row=>row.data as GeneratedLesson);
    res.json(rows.filter(lesson=>{if(lesson.status!=='ready'||!lesson.publication||req.user.role==='TEACHER'&&lesson.teacherId!==req.user.id)return false;const publication=lesson.publication,at=Date.now();
      if(!date||date===localDate(new Date(),publication.timezone))return(!publication.startsAt||Date.parse(publication.startsAt)<=at)&&(!publication.endsAt||at<Date.parse(publication.endsAt));
      const from=Date.parse(timeAt(date,'00:00',publication.timezone)),next=new Date(Date.parse(date)+86400000).toISOString().slice(0,10),to=Date.parse(timeAt(next,'00:00',publication.timezone));return(!publication.startsAt||Date.parse(publication.startsAt)<to)&&(!publication.endsAt||Date.parse(publication.endsAt)>from);
    }));
  });
  app.post('/api/generated-lessons/:id/language-approval',async(req:any,res)=>{
    const input=parse<{revision:number}>(z.object({revision:z.number().int().nonnegative()}),req.body);res.status(202).json(await service.approveLanguage(req.user,req.params.id,input.revision));
  });
  app.get('/api/generated-lessons/:id/video',async(req:any,res,next)=>{
    const video=await service.getVideo(req.user,req.params.id);res.type(video.contentType);res.set('Cache-Control','private, max-age=3600');res.sendFile(video.file,{acceptRanges:true,dotfiles:'deny'},(error:any)=>{if(error)next(error);});
  });
  app.get('/api/generated-lessons/:id/cue-audio/:cueId',async(req:any,res,next)=>{
    const audio=await service.getAudio(req.user,req.params.id,{cueId:req.params.cueId});res.type(audio.contentType);res.set('Cache-Control','private, max-age=3600');res.sendFile(audio.file,{acceptRanges:true,dotfiles:'deny'},(error:any)=>{if(error)next(error);});
  });
  return service;
}
