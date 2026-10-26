import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAlignment } from '../render2d.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function sourceWave(){
  const pcm=Buffer.alloc(48000);
  for(let sample=0;sample<19200;sample++)pcm.writeInt16LE(Math.round(Math.sin(sample*.1)*2000),sample*2);
  const bytes=Buffer.alloc(44+pcm.length);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(pcm.length,40);pcm.copy(bytes,44);
  return {bytes,pcm};
}
async function fixture(t){
  const job=await fs.mkdtemp(path.join(os.tmpdir(),'cue-alignment-contract-'));t.after(()=>fs.rm(job,{recursive:true,force:true}));
  const output=path.join(job,'output');await fs.mkdir(output);await fs.mkdir(path.join(job,'audio'));
  const {bytes,pcm}=sourceWave(),text='Ájiniyaz el hám jer haqqında sóyleydi.';
  const manifest={duration:1,language:'kaa',chapters:[{id:'intro',start:0,duration:1,cues:[{id:'intro-01',start:0,duration:1,audioDuration:.8,text,visualAction:'Úy giltin kórsetiw'}]}]};
  const report={passed:true,version:2,language:'kaa',timingGranularity:'cue',method:'measured PCM cue boundaries',sampleRate:24000,channels:1,bitsPerSample:16,cues:[{id:'intro-01',chapter:'intro',chapterAudioSha256:hash(bytes),referenceTextSha256:hash(text),referenceText:text,duration:.8,words:[],anchors:[],segments:[{text,start:0,end:.8}],cutSampleStart:0,cutSampleEnd:19200,cuePcmSha256:hash(pcm.subarray(0,38400))}],summary:{allReady:true,completed:1,expected:1}};
  await fs.writeFile(path.join(job,'audio/intro.wav'),bytes);
  const save=value=>fs.writeFile(path.join(output,'voice-alignment.json'),JSON.stringify(value));await save(report);
  return {job,output,manifest,report,save,bytes};
}

test('Karakalpak cue timing proves exact source PCM cuts without claiming word accuracy',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.job,'audio/intro.wav'));
  const report=await validateAlignment(f.job,f.output,f.manifest);
  assert.equal(report.timingGranularity,'cue');assert.deepEqual(report.cues[0].words,[]);assert.deepEqual(report.cues[0].anchors,[]);
  assert.equal(report.cues[0].segments[0].text,f.manifest.chapters[0].cues[0].text);
  assert.deepEqual(await fs.readFile(path.join(f.job,'audio/intro.wav')),before);
});

test('cue mode cannot replace Russian or Uzbek ASR validation',async t=>{
  const f=await fixture(t);
  for(const language of ['ru','uz']){
    const manifest=structuredClone(f.manifest);manifest.language=language;
    const report=structuredClone(f.report);report.language=language;await f.save(report);
    await assert.rejects(validateAlignment(f.job,f.output,manifest),/ALIGNMENT_FAILED/);
  }
});

test('cue report rejects invented ASR claims, an incorrect format or incomplete coverage',async t=>{
  const f=await fixture(t);
  for(const mutate of [
    r=>{r.model='small';},r=>{r.engine='offline whisper.cpp';},r=>{r.summary.minimumLexicalCoverage=1;},
    r=>{r.cues[0].matchStats={lexicalCoverage:1};},r=>{r.version=1;},r=>{r.sampleRate=16000;},
    r=>{r.channels=2;},r=>{r.method='ASR';},r=>{r.summary.expected=2;},r=>{r.cues=[];},
    r=>{r.cues.push(structuredClone(r.cues[0]));},r=>{r.cues[0].words=[{text:r.cues[0].referenceText,start:0,end:.8}];},
    r=>{r.cues[0].anchors=[{at:0}];},
  ]){
    const report=structuredClone(f.report);mutate(report);await f.save(report);
    await assert.rejects(validateAlignment(f.job,f.output,f.manifest),/ALIGNMENT_/);
  }
});

test('cue timing rejects stale text, changed voice bytes and forged sample boundaries',async t=>{
  const f=await fixture(t);
  for(const mutate of [
    r=>{r.cues[0].chapterAudioSha256='0'.repeat(64);},r=>{r.cues[0].referenceTextSha256='0'.repeat(64);},
    r=>{r.cues[0].referenceText+=' qosımsha';},r=>{r.cues[0].segments[0].text+=' qosımsha';},
    r=>{r.cues[0].segments[0].start=.01;},r=>{r.cues[0].segments[0].end=.79;},
    r=>{r.cues[0].duration=1;},r=>{r.cues[0].cutSampleStart=1;},
    r=>{r.cues[0].cutSampleEnd=19201;},r=>{r.cues[0].cutSampleEnd=19200.5;},
    r=>{r.cues[0].cuePcmSha256='0'.repeat(64);},
  ]){
    const report=structuredClone(f.report);mutate(report);await f.save(report);
    await assert.rejects(validateAlignment(f.job,f.output,f.manifest),/ALIGNMENT_/);
  }
  const changed=Buffer.from(f.bytes);changed[44]^=1;
  await fs.writeFile(path.join(f.job,'audio/intro.wav'),changed);
  const report=structuredClone(f.report);report.cues[0].chapterAudioSha256=hash(changed);await f.save(report);
  await assert.rejects(validateAlignment(f.job,f.output,f.manifest),/ALIGNMENT_STALE/);
});

test('cue timing retains measured hold and contiguous chapter constraints',async t=>{
  const f=await fixture(t);
  const discontinuous=structuredClone(f.manifest);discontinuous.chapters[0].cues[0].start=.1;
  await assert.rejects(validateAlignment(f.job,f.output,discontinuous),/timing/);
  const padded=structuredClone(f.manifest);padded.duration=5;padded.chapters[0].duration=5;padded.chapters[0].cues[0].duration=5;
  await assert.rejects(validateAlignment(f.job,f.output,padded),/timing/);
});

test('word timing retains the 65 percent gate, immutable reference and monotonic bounds',async t=>{
  const f=await fixture(t),manifest=structuredClone(f.manifest);manifest.language='ru';manifest.chapters[0].cues[0].text='Привет мир';
  const report={passed:true,version:1,language:'ru',summary:{allReady:true,minimumLexicalCoverage:.65},cues:[{id:'intro-01',chapter:'intro',chapterAudioSha256:hash(f.bytes),referenceTextSha256:hash('Привет мир'),words:[{text:'Привет',start:0,end:.4},{text:'мир',start:.4,end:.8}]}]};
  await f.save(report);assert.equal((await validateAlignment(f.job,f.output,manifest)).version,1);
  for(const mutate of [r=>{r.summary.minimumLexicalCoverage=.649;},r=>{r.cues[0].words[1].start=.2;},r=>{r.cues[0].words[1].end=.9;},r=>{r.cues[0].words[0].text='Изменено';}]){
    const changed=structuredClone(report);mutate(changed);await f.save(changed);
    await assert.rejects(validateAlignment(f.job,f.output,manifest),/ALIGNMENT_/);
  }
});

test('the author receives full-cue caption rules only for the measured Karakalpak mode',async t=>{
  const f=await fixture(t),native=path.join(f.job,'native-images'),assets=path.join(f.output,'assets');
  await fs.mkdir(native);await fs.mkdir(assets);
  for(let i=0;i<4;i++){
    const bytes=Buffer.from('EXPLICIT_TEST_IMAGE_'+i);await fs.writeFile(path.join(native,`image-${i}.png`),bytes);await fs.writeFile(path.join(assets,`image-${i}.png`),bytes);
  }
  const cli=path.join(f.job,'fake-codex.mjs'),promptFile=path.join(f.job,'received-prompt.txt'),hook=path.join(f.job,'isolated-images.mjs');
  await fs.writeFile(cli,'#!/usr/bin/env node\nimport{promises as fs}from"node:fs";let prompt="";for await(const part of process.stdin)prompt+=part;await fs.writeFile(process.env.TEST_PROMPT_PATH,prompt);\n',{mode:0o755});
  await fs.writeFile(hook,`import{promises as fs}from'node:fs';const base=${JSON.stringify(native)};const map=file=>typeof file==='string'&&(file==='/codex/generated_images'||file.startsWith('/codex/generated_images/'))?base+file.slice('/codex/generated_images'.length):file;for(const name of ['readdir','lstat','stat','readFile']){const original=fs[name];fs[name]=function(file,...args){return original.call(this,map(file),...args);};}`);
  const author=fileURLToPath(new URL('../author2d.mjs',import.meta.url));
  async function run(language,report){
    await fs.writeFile(path.join(f.job,'input.json'),JSON.stringify({...f.manifest,language}));await f.save(report);
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--import',hook,author,'review'],{env:{...process.env,CODEX_JOB_DIR:f.job,CODEX_BIN:cli,CODEX_MODEL:'gpt-6-astra',CODEX_REASONING_EFFORT:'ultra',TEST_PROMPT_PATH:promptFile},stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',bytes=>error+=bytes);child.on('error',reject);child.on('close',code=>resolve({code,error}));
    });
    assert.equal(result.code,0,result.error);return fs.readFile(promptFile,'utf8');
  }
  const cuePrompt=await run('kaa',f.report);
  assert.match(cuePrompt,/FULL exact cue\.text/);assert.match(cuePrompt,/bottom 270px/);assert.match(cuePrompt,/at most five lines/);assert.match(cuePrompt,/Do not split text into invented timed sentences/);
  assert.match(cuePrompt,/normally after that cue's measured audio end/);assert.doesNotMatch(cuePrompt,/Reveal conclusions at their actual spoken result words/);
  const wordPrompt=await run('ru',{version:1,timingGranularity:'word'});
  assert.match(wordPrompt,/Reserve bottom170px/);assert.match(wordPrompt,/Reveal conclusions at their actual spoken result words/);assert.doesNotMatch(wordPrompt,/FULL exact cue\.text/);
});
