import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const {createAmbientBed,cinematicAudioFilter,muxLessonAudio}=await import(process.env.RENDER_MODULE||new URL('../render.mjs',import.meta.url));
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lesson-audio-'));
const ffmpeg=process.env.FFMPEG_BIN||'ffmpeg',ffprobe=process.env.FFPROBE_BIN||'ffprobe';
const run=(command,args)=>execFileSync(command,args,{maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
const ff=(...args)=>run(ffmpeg,['-hide_banner','-loglevel','error','-y',...args]);
const readFloat=bytes=>Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(i*4));
const rms=(samples,from,to)=>Math.sqrt(samples.slice(Math.round(from*48000),Math.round(to*48000)).reduce((sum,value)=>sum+value*value,0)/(Math.round((to-from)*48000)));
try{
  const duration=2,manifest={chapters:[{start:0},{start:1}]},bed=path.join(directory,'bed.wav'),voice=path.join(directory,'voice.wav'),silent=path.join(directory,'silent.mp4'),concat=path.join(directory,'voice.ffconcat'),target=path.join(directory,'film.mp4');
  const stats=await createAmbientBed(bed,manifest,duration),first=await fs.readFile(bed);
  await createAmbientBed(bed,manifest,duration);
  assert.equal(createHash('sha256').update(first).digest('hex'),createHash('sha256').update(await fs.readFile(bed)).digest('hex'),'Sound design must be deterministic');
  assert.equal(stats.samples,48000);assert.equal(stats.transitions,1);assert(stats.peak<.04&&stats.rms<.008,'Bed must remain quiet before ducking');
  // A clean, gated synthetic voice reference leaves measurable pauses and edges.
  ff('-f','lavfi','-i',"aevalsrc=if(between(t\\,0.6\\,1.05)\\,0.87*sin(2*PI*880*t)\\,if(between(t\\,1.75\\,1.95)\\,0.5*sin(2*PI*440*t)\\,0)):s=24000:d=2",'-c:a','pcm_s16le',voice);
  ff('-f','lavfi','-i','color=c=blue:s=1280x720:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p','-frames:v','48',silent);
  await fs.writeFile(concat,`ffconcat version 1.0\nfile '${voice.replaceAll("'","'\\''")}'\n`);
  const graph=cinematicAudioFilter(duration);
  const mixed=readFloat(ff('-i',silent,'-f','concat','-safe','0','-i',concat,'-i',bed,'-filter_complex',graph,'-map','[mixed]','-c:a','pcm_f32le','-f','f32le','pipe:1'));
  const reference=readFloat(ff('-i',voice,'-ar','48000','-c:a','pcm_f32le','-f','f32le','pipe:1'));
  assert.equal(mixed.length,96000,'Limiter compensation must preserve exact sample count');
  const residual=mixed.map((value,index)=>value-reference[index]),quietRms=rms(residual,.35,.5),speechRms=rms(residual,.75,.9),peak=Math.max(...mixed.map(Math.abs));
  assert(speechRms<quietRms*.4,`Bed must duck under voice: speech=${speechRms}, quiet=${quietRms}`);
  assert(rms(residual,.65,.95)<.002,'Voice gain and alignment must be preserved');
  assert(peak<.971&&peak>.86,'Voice must retain its level without clipping');
  let bestLag=0,bestError=Infinity;for(let lag=-12;lag<=12;lag++){let error=0;for(let i=28000;i<53000;i++){const delta=mixed[i]-reference[i+lag];error+=delta*delta;}if(error<bestError){bestError=error;bestLag=lag;}}
  assert.equal(bestLag,0,'Limiter lookahead must not shift the voice');
  const soundDesign=await muxLessonAudio({silent,concat,manifest,output:directory,duration,ffmpeg,target});
  const media=JSON.parse(run(ffprobe,['-v','error','-show_format','-show_streams','-count_frames','-of','json',target]));
  const video=media.streams.find(stream=>stream.codec_type==='video'),audio=media.streams.find(stream=>stream.codec_type==='audio');
  assert.equal(Number(video.nb_read_frames),48);assert.equal(video.width,1280);assert.equal(video.height,720);
  for(const value of [video.duration,audio.duration,media.format.duration])assert(Math.abs(Number(value)-2)<.05,'Mux must preserve exact A/V duration');
  assert.equal(audio.sample_rate,'48000');await assert.rejects(fs.stat(path.join(directory,'.render-soundbed.wav')),{code:'ENOENT'});
  console.log(JSON.stringify({passed:true,duration:Number(media.format.duration),frames:Number(video.nb_read_frames),voiceLagSamples:bestLag,peak,bedQuietRms:quietRms,bedDuringVoiceRms:speechRms,duckDb:20*Math.log10(speechRms/quietRms),soundDesign}));
}finally{await fs.rm(directory,{recursive:true,force:true});}
