import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DB } from './db.js';
import { ApiError } from './security.js';

const chapterId=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const chapterSchema=z.object({
  id:chapterId,title:z.string().min(1).max(200),scene:z.string().min(1).max(100),
  start:z.number().finite().min(0),duration:z.number().finite().min(1).max(300),
  formula:z.string().max(1000).optional(),caption:z.string().max(1000).optional(),
  beats:z.array(z.object({
    at:z.number().finite().min(0),kicker:z.string().max(120).optional(),
    headline:z.string().min(1).max(200),formula:z.string().max(1000).optional(),
    note:z.string().max(300).optional(),emphasis:z.enum(['hero','equation','number']).optional(),
  })).max(30).optional(),
  cues:z.array(z.unknown()).max(100).optional(),narration:z.string().min(1).max(20000),
}).passthrough();
const lessonSchema=z.object({id:chapterId,title:z.string().min(1).max(200),duration:z.number().finite().positive().max(7200),chapters:z.array(chapterSchema).min(1).max(40)}).passthrough();
const voiceSchema=z.object({
  model:z.string().max(100),voice:z.string().max(100),updatedAt:z.string().optional(),
  chapters:z.array(z.object({id:chapterId,file:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\.wav$/),duration:z.number().finite().positive().max(600),start:z.number().finite().min(0).optional(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),beatTimes:z.array(z.number().finite().min(0)).max(30).optional()})).max(40),
});
export type CinemaLesson=z.infer<typeof lessonSchema>;
export type CinemaChapter=z.infer<typeof chapterSchema>;
export type CinemaVoice=z.infer<typeof voiceSchema>;
export const DEFAULT_CINEMA_LESSON=fileURLToPath(new URL('../content/derivative/lesson.json',import.meta.url));
export const BUNDLED_CINEMA_VOICE=fileURLToPath(new URL('../content/derivative/voice/',import.meta.url));
export const CINEMA_PROMPT_VERSION='cinema-russian-v2-action-tempo110';

export function voiceSourceHash(chapter:Pick<CinemaChapter,'narration'>,model:string,voice:string):string {
  return createHash('sha256').update(JSON.stringify({narration:chapter.narration,model,voice,prompt:CINEMA_PROMPT_VERSION})).digest('hex');
}

export async function readCinemaLesson(filename=DEFAULT_CINEMA_LESSON):Promise<CinemaLesson> {
  const lesson=lessonSchema.parse(JSON.parse(await readFile(filename,'utf8')));
  const ids=new Set<string>();let end=0;
  for(const chapter of lesson.chapters){
    if(ids.has(chapter.id)||Math.abs(chapter.start-end)>.05)throw new Error('Cinema chapters must be unique and contiguous');
    if(chapter.beats?.length&&(chapter.beats[0].at!==0||chapter.beats.some((beat,index,beats)=>beat.at>=chapter.duration||(index>0&&beat.at<=beats[index-1].at))))throw new Error('Cinema beats must be ordered within their chapter');
    ids.add(chapter.id);end=chapter.start+chapter.duration;
  }
  if(Math.abs(lesson.duration-end)>.05)throw new Error('Cinema lesson duration must match chapter timeline');
  return lesson;
}

/** Read RIFF chunks rather than assuming every WAV has a 44-byte header. */
export function waveDuration(wave:Buffer):number {
  if(wave.length<44||wave.toString('ascii',0,4)!=='RIFF'||wave.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid WAV');
  let byteRate=0,dataLength=0;let pcm=false;
  for(let offset=12;offset+8<=wave.length;){
    const tag=wave.toString('ascii',offset,offset+4),size=wave.readUInt32LE(offset+4),start=offset+8;
    if(start+size>wave.length)throw new Error('Truncated WAV');
    if(tag==='fmt '){if(size<16)throw new Error('Invalid WAV format');pcm=[1,3].includes(wave.readUInt16LE(start));byteRate=wave.readUInt32LE(start+8);}
    if(tag==='data')dataLength+=size;
    offset=start+size+(size%2);
  }
  const duration=dataLength/byteRate;
  if(!pcm||!Number.isFinite(duration)||duration<=0||duration>600)throw new Error('Invalid WAV duration');
  return duration;
}

export function pcmWave(pcm:Buffer,rate=24000,channels=1,bits=16):Buffer {
  if(!pcm.length||pcm.length%(channels*bits/8)||!Number.isInteger(rate)||rate<8000||rate>96000||![1,2].includes(channels)||bits!==16)throw new Error('Invalid PCM audio');
  const header=Buffer.alloc(44);header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*channels*bits/8,28);header.writeUInt16LE(channels*bits/8,32);header.writeUInt16LE(bits,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);
}

async function safeWave(directory:string,filename:string):Promise<{file:string;duration:number;hash:string}> {
  const file=path.join(directory,filename),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<44||stat.size>60*1024*1024)throw new Error('Invalid audio file');
  const [actual,root]=await Promise.all([realpath(file),realpath(directory)]);
  if(path.dirname(actual)!==root)throw new Error('Audio path outside lesson');
  const bytes=await readFile(actual);
  return {file:actual,duration:waveDuration(bytes),hash:createHash('sha256').update(bytes).digest('hex')};
}

export async function loadCinemaManifest(dataDir:string,lessonFile=DEFAULT_CINEMA_LESSON) {
  const lesson=await readCinemaLesson(lessonFile);let directory=path.join(path.resolve(dataDir),'cinema','derivative');
  let voice:CinemaVoice|null=null;
  try{voice=voiceSchema.parse(JSON.parse(await readFile(path.join(directory,'voice.json'),'utf8')));}catch{}
  // Portable exports may carry only the approved lesson's finished voice assets.
  // An existing private manifest takes priority, even while generation is partial.
  if(!voice&&path.resolve(lessonFile)===path.resolve(DEFAULT_CINEMA_LESSON)){
    try{voice=voiceSchema.parse(JSON.parse(await readFile(path.join(BUNDLED_CINEMA_VOICE,'voice.json'),'utf8')));directory=BUNDLED_CINEMA_VOICE;}catch{}
  }
  let time=0;
  const chapters=[];
  for(const chapter of lesson.chapters){
    let audio:{file:string;duration:number;hash:string}|undefined;
    const entry=voice?.chapters.find(entry=>entry.id===chapter.id&&entry.sourceHash===voiceSourceHash(chapter,voice!.model,voice!.voice));
    if(entry){try{audio=await safeWave(directory,entry.file);}catch{}}
    // Actual narration determines pacing, with a short breath before the next scene.
    const duration=audio?audio.duration+2.5:chapter.duration;
    const cues=chapter.cues?.map(cue=>typeof cue==='object'&&cue!==null&&'at'in cue&&typeof cue.at==='number'?{...cue,at:cue.at*duration/chapter.duration}:cue);
    const aligned=audio&&entry?.beatTimes&&entry.beatTimes.length===chapter.beats?.length
      &&entry.beatTimes[0]===0&&entry.beatTimes.every((at,index,times)=>at<audio!.duration&&(index===0||at>times[index-1]))
      ?entry.beatTimes:undefined;
    const beats=chapter.beats?.map((beat,index)=>({...beat,at:aligned?.[index]??beat.at*duration/chapter.duration}));
    chapters.push({...chapter,...(cues?{cues}:{}),...(beats?{beats}:{}),start:time,duration,...(audio?{audioUrl:`/api/cinema/derivative/audio/${chapter.id}?v=${audio.hash.slice(0,16)}`,audioDuration:audio.duration}:{})});time+=duration;
  }
  const publicManifest={...lesson,duration:time,chapters,voice:{status:chapters.every(chapter=>'audioUrl'in chapter)?'ready' as const:'missing' as const,model:voice?.model||null,voice:voice?.voice||null}};
  return {manifest:publicManifest,voice,directory};
}

/** Mount after installAuth; files never enter the public static directory. */
export function installCinema(app:Express,_db:DB,ctx:any) {
  const dataDir=ctx.dataDir||path.dirname(ctx.uploadDir);
  const authorize=(req:any)=>{if(!req.user||!['ADMIN','TEACHER'].includes(req.user.role))throw new ApiError(403,'Нет доступа','FORBIDDEN');};
  app.get('/api/cinema/derivative',async(req:any,res)=>{
    authorize(req);const {manifest}=await loadCinemaManifest(dataDir,ctx.cinemaLessonFile);res.json(manifest);
  });
  app.get('/api/cinema/derivative/audio/:chapterId',async(req:any,res,next)=>{
    authorize(req);
    if(!chapterId.safeParse(req.params.chapterId).success)throw new ApiError(404,'Аудио не найдено','NOT_FOUND');
    const {manifest,voice,directory}=await loadCinemaManifest(dataDir,ctx.cinemaLessonFile);
    const chapter=manifest.chapters.find(chapter=>chapter.id===req.params.chapterId&&'audioUrl'in chapter);
    const entry=voice?.chapters.find(entry=>entry.id===chapter?.id);
    if(!chapter||!entry)throw new ApiError(404,'Озвучка ещё не подготовлена','AUDIO_NOT_READY');
    const {file}=await safeWave(directory,entry.file);
    res.type('audio/wav');res.set('Cache-Control','private, max-age=86400');res.set('X-Content-Type-Options','nosniff');
    // Express sendFile supports byte ranges, HEAD and conditional requests.
    res.sendFile(file,{acceptRanges:true,dotfiles:'deny'},(error:any)=>{
      if(!error)return;
      if(error.status===416&&!res.headersSent){if(error.headers?.['Content-Range'])res.set('Content-Range',error.headers['Content-Range']);res.status(416).end();return;}
      next(error.status===404?new ApiError(404,'Аудио не найдено','NOT_FOUND'):error);
    });
  });
}
