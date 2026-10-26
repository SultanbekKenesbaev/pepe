import 'dotenv/config';
import { mkdir, mkdtemp, readFile, writeFile, rename, chmod, lstat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCinemaLesson, voiceSourceHash, pcmWave, waveDuration, type CinemaChapter, type CinemaVoice } from '../server/cinema.js';
import { requestGoogleSpeech } from '../server/google-request.js';
export { generatedWave } from '../server/tts-output.js';

// Official API contract: https://ai.google.dev/gemini-api/docs/speech-generation
export const NARRATOR_DIRECTION=`Audio profile: an original Russian-speaking science presenter, charismatic, bright, playful and warm. A lively conversational male voice with a smile, precise articulation and genuine curiosity. Never imitate any real person.
Scene: an energetic cinematic university lesson about derivatives. A sports car, a cup of coffee and a flying ball become animated mathematical ideas. Speak directly to intelligent young adults as if demonstrating something fascinating in front of them.
Director's notes: contemporary native Russian. Use expressive changes of emphasis, short suspense before a reveal, and an audible smile when an idea clicks. Start immediately with energy. Give questions an inviting rise; make short discoveries crisp and vivid. Pace around 135–145 words per minute. Keep the momentum between sentences; leave only short natural breaths at paragraph changes. Slow slightly for a numerical calculation, then pick the pace back up. No solemn documentary delivery, drawn-out vowels, whispering, shouting, radio-announcer voice or theatrical laughter. Pronounce mathematical expressions clearly as spoken Russian. No background music, sound effects, extra introduction, or singing. Read only the exact text between TRANSCRIPT tags; do not read these instructions or tags. Preserve all meaning and every sentence.`;

const MODELS=new Set(['gemini-2.5-pro-preview-tts','gemini-2.5-flash-preview-tts','gemini-3.1-flash-tts-preview','gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts']);
const VOICES=new Set(['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat']);
const runFile=promisify(execFile);
export const CINEMA_AUDIO_TEMPO=1.1;

async function checkAudioTools() {
  try{await runFile('ffmpeg',['-version'],{timeout:10000,maxBuffer:64*1024});}
  catch{throw new Error('FFmpeg is required to prepare narration audio. Install FFmpeg before generating new voice.');}
}

/** One constant gain per clip preserves the narrator's expressive dynamics. */
export function normalizeNarrationPcm(pcm:Buffer) {
  if(!pcm.length||pcm.length%2)throw new Error('Invalid narration PCM');
  let peak=0,sum=0;
  for(let offset=0;offset<pcm.length;offset+=2){const sample=pcm.readInt16LE(offset);peak=Math.max(peak,Math.abs(sample));sum+=sample*sample;}
  const rms=Math.sqrt(sum/(pcm.length/2));
  if(!peak||rms<1)throw new Error('Narration audio is silent');
  const target=32768*Math.pow(10,-21/20),peakCap=32768*Math.pow(10,-1.5/20);
  const gain=Math.min(target/rms,Math.pow(10,4/20),peakCap/peak),output=Buffer.allocUnsafe(pcm.length);
  for(let offset=0;offset<pcm.length;offset+=2)output.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(pcm.readInt16LE(offset)*gain))),offset);
  return {pcm:output,gainDb:20*Math.log10(gain),rmsDb:20*Math.log10(rms*gain/32768),peakDb:20*Math.log10(peak*gain/32768)};
}

/** Pitch-preserving tempo, then gentle level matching. No compression or limiting. */
export async function finishCinemaWave(wave:Buffer) {
  waveDuration(wave);
  const temp=await mkdtemp(path.join(os.tmpdir(),'cinema-audio-'));
  try{
    await chmod(temp,0o700);
    const input=path.join(temp,'raw.wav'),output=path.join(temp,'tempo.pcm');
    await writeFile(input,wave,{mode:0o600});
    await runFile('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',input,'-af',`atempo=${CINEMA_AUDIO_TEMPO}`,'-ar','24000','-ac','1','-c:a','pcm_s16le','-f','s16le',output],{timeout:60000,maxBuffer:64*1024});
    const normalized=normalizeNarrationPcm(await readFile(output));
    const finished=pcmWave(normalized.pcm,24000,1);
    return {wave:finished,duration:waveDuration(finished),gainDb:normalized.gainDb,rmsDb:normalized.rmsDb,peakDb:normalized.peakDb};
  }finally{await rm(temp,{recursive:true,force:true});}
}

export function ttsRequest(chapter:Pick<CinemaChapter,'narration'>,model:string,voice:string) {
  if(!MODELS.has(model)||!VOICES.has(voice))throw new Error('Unsupported Gemini TTS model or voice');
  if(model.startsWith('gemini-3.8-'))return {contents:[{role:'user',parts:[{text:chapter.narration,speech_metadata:{style:NARRATOR_DIRECTION}}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{voice}}}};
  return {contents:[{role:'user',parts:[{text:`${NARRATOR_DIRECTION}\n\n<TRANSCRIPT>\n${chapter.narration}\n</TRANSCRIPT>`}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}}}};
}

async function atomic(filename:string,data:string|Buffer) {
  const temp=filename+'.tmp';await writeFile(temp,data,{mode:0o600});await rename(temp,filename);await chmod(filename,0o600);
}

export async function generateCinemaVoice(args=process.argv.slice(2)) {
  const dataDir=path.resolve(process.env.DATA_DIR||'data'),directory=path.join(dataDir,'cinema','derivative');
  const model=process.env.GEMINI_TTS_MODEL||'gemini-2.5-pro-preview-tts',voice=process.env.GEMINI_TTS_VOICE||'Puck';
  if(!MODELS.has(model)||!VOICES.has(voice))throw new Error('Choose a supported GEMINI_TTS_MODEL and GEMINI_TTS_VOICE');
  const lesson=await readCinemaLesson();
  const selected=args.find(arg=>arg.startsWith('--chapter='))?.slice('--chapter='.length);
  if(selected&&!lesson.chapters.some(chapter=>chapter.id===selected))throw new Error('Unknown chapter');
  const chapters=lesson.chapters.filter(chapter=>!selected||chapter.id===selected);
  if(args.includes('--dry-run')){console.log(`Voice plan: ${model}, ${voice}, ${chapters.length} chapters; no external requests.`);return;}
  let key=process.env.GEMINI_API_KEY?.trim();
  if(!key){try{key=(await readFile(path.join(dataDir,'secrets','google-ai.key'),'utf8')).trim();}catch{}}
  if(!key||key.length<20)throw new Error('GEMINI_API_KEY is missing; set it privately or use DATA_DIR/secrets/google-ai.key');
  await mkdir(directory,{recursive:true,mode:0o700});
  const filename=path.join(directory,'voice.json');let manifest:CinemaVoice={model,voice,chapters:[]};
  try{const previous=JSON.parse(await readFile(filename,'utf8'));if(previous.model===model&&previous.voice===voice&&Array.isArray(previous.chapters))manifest=previous;}catch{}
  Object.assign(manifest,{tempo:CINEMA_AUDIO_TEMPO});
  let audioToolsReady=false;
  for(const chapter of chapters){
    const sourceHash=voiceSourceHash(chapter,model,voice),file=chapter.id+'.wav',target=path.join(directory,file);
    const previous=manifest.chapters.find(entry=>entry.id===chapter.id&&entry.sourceHash===sourceHash);
    if(previous&&!args.includes('--force')){
      try{if((await lstat(target)).isSymbolicLink())throw new Error('Invalid audio file');waveDuration(await readFile(target));console.log(`Cached ${chapter.id}`);continue;}catch{}
    }
    // Fail before a paid request if the local finishing tool is missing.
    if(!audioToolsReady){await checkAudioTools();audioToolsReady=true;}
    console.log(`Generating ${chapter.id} (${model}, ${voice})`);
    const raw=await requestGoogleSpeech({apiKey:key,model,body:ttsRequest(chapter,model,voice),timeoutMs:180000});
    const {wave,duration,gainDb}=await finishCinemaWave(raw);
    if(duration<2)throw new Error('TTS clip is unexpectedly short');
    await atomic(target,wave);
    manifest.chapters=manifest.chapters.filter(entry=>entry.id!==chapter.id);
    manifest.chapters.push({id:chapter.id,file,duration,sourceHash});manifest.updatedAt=new Date().toISOString();
    let start=0;for(const authored of lesson.chapters){const entry=manifest.chapters.find(entry=>entry.id===authored.id);if(entry)entry.start=start;start+=entry?entry.duration+2.5:authored.duration;}
    await atomic(filename,JSON.stringify(manifest,null,2)+'\n');
    console.log(`Saved ${chapter.id}: ${duration.toFixed(1)} seconds, tempo ${CINEMA_AUDIO_TEMPO}, gain ${gainDb.toFixed(1)} dB`);
  }
  console.log(`Voice saved privately in DATA_DIR/cinema/derivative (${manifest.chapters.length}/${lesson.chapters.length} chapters).`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))generateCinemaVoice().catch(error=>{console.error(error?.name==='TimeoutError'?'Google TTS timed out. Rerun to resume cached chapters.':error instanceof Error?error.message:'Voice generation failed');process.exitCode=1;});
