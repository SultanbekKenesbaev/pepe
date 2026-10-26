import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { installCinema, readCinemaLesson, loadCinemaManifest, pcmWave, waveDuration, voiceSourceHash, type CinemaChapter } from '../server/cinema.js';
import { generatedWave, ttsRequest } from '../scripts/generate-cinema-voice.js';

const model='gemini-2.5-pro-preview-tts',voice='Charon';
const chapter={id:'one',title:'Мгновение',scene:'intro',start:0,duration:60,narration:'Производная — скорость изменения.',cues:[{at:30,text:'Изменение'}]} as CinemaChapter;
const lesson={id:'derivative-cinema-v1',title:'Производная',duration:120,chapters:[chapter,{...chapter,id:'two',start:60}]};
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'cinema-test-'));const filename=path.join(root,'lesson.json');await writeFile(filename,JSON.stringify(lesson));const audio=path.join(root,'cinema','derivative');await mkdir(audio,{recursive:true});return {root,filename,audio};}

test('cinema authored timeline is unique, contiguous and exactly matches total duration',async()=>{
  const f=await fixture();try{
    assert.equal((await readCinemaLesson(f.filename)).duration,120);
    for(const bad of [{...lesson,duration:121},{...lesson,chapters:[chapter,{...chapter,start:60}]},{...lesson,chapters:[chapter,{...chapter,id:'two',start:61}]}]){
      await writeFile(f.filename,JSON.stringify(bad));await assert.rejects(readCinemaLesson(f.filename));
    }
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('Gemini PCM gets a real WAV header and incomplete or unsupported outputs are rejected',()=>{
  const pcm=Buffer.alloc(48000);const wave=pcmWave(pcm);assert.equal(waveDuration(wave),1);assert.equal(wave.toString('ascii',0,4),'RIFF');
  const payload={candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'audio/L16;codec=pcm;rate=24000',data:pcm.toString('base64')}}]}}]};
  assert.deepEqual(generatedWave(payload),wave);
  assert.throws(()=>generatedWave({candidates:[{...payload.candidates[0],finishReason:'MAX_TOKENS'}]}),{message:'GENERATION_TTS_INCOMPLETE'});
  assert.throws(()=>generatedWave({candidates:[{content:{parts:[{inlineData:{mimeType:'text/html',data:'SGVsbG8='}}]}}]}),{message:'GENERATION_TTS_FORMAT'});
  assert.throws(()=>waveDuration(wave.subarray(0,80)),/Truncated/);
  assert.throws(()=>pcmWave(Buffer.alloc(3)),/Invalid PCM/);
  const legacy=ttsRequest(chapter,model,voice);assert.equal((legacy.generationConfig.speechConfig.voiceConfig as any).prebuiltVoiceConfig.voiceName,voice);
  const modern=ttsRequest(chapter,'gemini-3.8-flash-tts',voice);assert.equal(modern.contents[0].parts[0].text,chapter.narration);assert.ok('speech_metadata'in modern.contents[0].parts[0]);
  assert.throws(()=>ttsRequest(chapter,'https://external.test/model',voice));
});

test('missing or stale voice never reports ready; valid WAV lengths drive scene timing and cue timing',async()=>{
  const f=await fixture();try{
    const missing=(await loadCinemaManifest(f.root,f.filename)).manifest;assert.equal(missing.voice.status,'missing');assert.ok(!('audioUrl'in missing.chapters[0]));
    const entries=lesson.chapters.map(chapter=>({id:chapter.id,file:chapter.id+'.wav',duration:20,sourceHash:voiceSourceHash(chapter,model,voice)}));
    await writeFile(path.join(f.audio,'voice.json'),JSON.stringify({model,voice,chapters:entries}));
    await writeFile(path.join(f.audio,'one.wav'),pcmWave(Buffer.alloc(48000*4)));
    await writeFile(path.join(f.audio,'two.wav'),pcmWave(Buffer.alloc(48000*6)));
    const ready=(await loadCinemaManifest(f.root,f.filename)).manifest;assert.equal(ready.voice.status,'ready');assert.equal(ready.duration,15);assert.equal(ready.chapters[0].duration,6.5);assert.equal(ready.chapters[1].start,6.5);assert.equal((ready.chapters[0].cues![0] as any).at,3.25);assert.equal((ready.chapters[0] as any).audioDuration,4);
    const edited={...lesson,chapters:[{...chapter,narration:'Новый сценарий'},lesson.chapters[1]]};await writeFile(f.filename,JSON.stringify(edited));
    const stale=(await loadCinemaManifest(f.root,f.filename)).manifest;assert.equal(stale.voice.status,'missing');assert.ok(!('audioUrl'in stale.chapters[0]));assert.ok('audioUrl'in stale.chapters[1]);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('voice path traversal and audio symlinks cannot expose another private file',async()=>{
  const f=await fixture();try{
    const outside=path.join(f.root,'outside.wav');await writeFile(outside,pcmWave(Buffer.alloc(48000)));
    const base={model,voice,chapters:[{id:'one',file:'../outside.wav',duration:1,sourceHash:voiceSourceHash(chapter,model,voice)}]};
    await writeFile(path.join(f.audio,'voice.json'),JSON.stringify(base));assert.ok(!('audioUrl'in (await loadCinemaManifest(f.root,f.filename)).manifest.chapters[0]));
    await symlink(outside,path.join(f.audio,'one.wav'));await writeFile(path.join(f.audio,'voice.json'),JSON.stringify({...base,chapters:[{...base.chapters[0],file:'one.wav'}]}));assert.ok(!('audioUrl'in (await loadCinemaManifest(f.root,f.filename)).manifest.chapters[0]));
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('aligned narration beats use measured speech times; invalid timing falls back safely',async()=>{
  const f=await fixture();try{
    const authored={...lesson,chapters:lesson.chapters.map(c=>({...c,beats:[{at:0,headline:'Старт'},{at:12,headline:'Скорость'},{at:24,headline:'График'}]}))};
    await writeFile(f.filename,JSON.stringify(authored));
    for(const c of authored.chapters)await writeFile(path.join(f.audio,c.id+'.wav'),pcmWave(Buffer.alloc(48000*30)));
    const entries=authored.chapters.map(c=>({id:c.id,file:c.id+'.wav',duration:30,sourceHash:voiceSourceHash(c,model,voice),beatTimes:[0,7.2,19.8]}));
    await writeFile(path.join(f.audio,'voice.json'),JSON.stringify({model,voice,chapters:entries}));
    const aligned=(await loadCinemaManifest(f.root,f.filename)).manifest;
    assert.deepEqual(aligned.chapters[0].beats?.map(b=>b.at),[0,7.2,19.8]);
    entries[0].beatTimes=[0,19.8,7.2];
    await writeFile(path.join(f.audio,'voice.json'),JSON.stringify({model,voice,chapters:entries}));
    const fallback=(await loadCinemaManifest(f.root,f.filename)).manifest;
    assert.deepEqual(fallback.chapters[0].beats?.map(b=>b.at),[0,6.5,13]);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('private cinema routes enforce roles and stream seekable WAV ranges with no secret paths',async()=>{
  const f=await fixture();const app=express();app.use((req:any,_res,next)=>{if(req.get('x-test-role'))req.user={role:req.get('x-test-role')};next();});
  installCinema(app,{} as any,{dataDir:f.root,cinemaLessonFile:f.filename});app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}`;
  try{
    const wave=pcmWave(Buffer.alloc(48000));await writeFile(path.join(f.audio,'one.wav'),wave);await writeFile(path.join(f.audio,'voice.json'),JSON.stringify({model,voice,chapters:[{id:'one',file:'one.wav',duration:1,sourceHash:voiceSourceHash(chapter,model,voice)}]}));
    assert.equal((await fetch(url+'/api/cinema/derivative')).status,403);assert.equal((await fetch(url+'/api/cinema/derivative',{headers:{'x-test-role':'STUDENT'}})).status,403);
    for(const role of ['TEACHER','ADMIN']){
      const response=await fetch(url+'/api/cinema/derivative',{headers:{'x-test-role':role}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.chapters[0].audioUrl.startsWith('/api/cinema/'),true);assert.equal(JSON.stringify(body).includes(f.root),false);
    }
    const audio=await fetch(url+'/api/cinema/derivative/audio/one',{headers:{'x-test-role':'TEACHER',Range:'bytes=0-43'}});assert.equal(audio.status,206);assert.equal(audio.headers.get('accept-ranges'),'bytes');assert.match(audio.headers.get('content-range')!,/^bytes 0-43\//);assert.match(audio.headers.get('cache-control')!,/^private/);assert.equal(Buffer.from(await audio.arrayBuffer()).toString('ascii',0,4),'RIFF');
    const outside=await fetch(url+'/api/cinema/derivative/audio/one',{headers:{'x-test-role':'TEACHER',Range:'bytes=999999-'}});assert.equal(outside.status,416);assert.equal(outside.headers.get('content-range'),`bytes */${wave.length}`);
    assert.equal((await fetch(url+'/api/cinema/derivative/audio/unknown',{headers:{'x-test-role':'TEACHER'}})).status,404);assert.equal((await fetch(url+'/api/cinema/derivative/audio/two',{headers:{'x-test-role':'TEACHER'}})).status,404);
    const head=await fetch(url+'/api/cinema/derivative/audio/one',{method:'HEAD',headers:{'x-test-role':'ADMIN'}});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(wave.length));
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(f.root,{recursive:true,force:true});}
});
