/** Isolated orchestration regression. The Docker executable is a test double;
 * its mock MP4/report are never a claim of a real renderer or author success. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const temporary=await mkdtemp(path.join(tmpdir(),'broker-resume-')),jobs=path.join(temporary,'jobs'),privateRoot=path.join(jobs,'.broker-state'),callsFile=path.join(temporary,'calls.jsonl'),docker=path.join(temporary,'docker.mjs');
const token='isolated-broker-test-token-'+'t'.repeat(40);await mkdir(privateRoot,{recursive:true});await writeFile(path.join(temporary,'token'),token,{mode:0o600});
// Delay the obsolete .part cleanup to reproduce the response-before-unlock
// race deterministically, rather than relying on local filesystem timing.
const cleanupHook=path.join(temporary,'slow-upload-cleanup.mjs');
await writeFile(cleanupHook,`import{promises as fs}from'node:fs';const remove=fs.rm;fs.rm=async function(file,...args){if(String(file).endsWith('.part'))await new Promise(resolve=>setTimeout(resolve,250));return remove.call(this,file,...args);};`);
await writeFile(docker,`#!/usr/bin/env node
import{promises as fs}from'node:fs';import path from'node:path';
const args=process.argv.slice(2);if(args[0]==='ps'||args[0]==='rm')process.exit(0);if(args[0]!=='run')process.exit(1);
const mode=args.at(-1);if(mode==='auth'){console.log(JSON.stringify({configured:true,mode:'chatgpt'}));process.exit(0);}
const mount=args.find(value=>value.startsWith('type=bind,src=')&&value.endsWith('dst=/job')),job=mount.slice('type=bind,src='.length).split(',dst=')[0],id=path.basename(job),out=path.join(job,'output');
await fs.appendFile(${JSON.stringify(callsFile)},JSON.stringify({id,mode})+'\\n');
const input=JSON.parse(await fs.readFile(path.join(job,'input.json'),'utf8'));await fs.mkdir(out,{recursive:true});
if(mode==='visuals'){if(!input.authorFailsWithoutScene)await fs.writeFile(path.join(out,'scene.js'),'export const mockProject = true;');if(input.authorFailsAfterScene||input.authorFailsWithoutScene)process.exit(42);}
if(mode==='check'){let count=0;try{count=Number(await fs.readFile(path.join(out,'mock-check-count'),'utf8'));}catch{}count++;await fs.writeFile(path.join(out,'mock-check-count'),String(count));await fs.writeFile(path.join(out,'check.json'),JSON.stringify({passed:!input.checkAlwaysFails&&!(input.firstCheckFails&&count===1),frames:[{file:'output/frames/mock.png'}],issues:input.checkAlwaysFails?['Mock failing check']:[]}));}
if(mode==='review'){if(input.reviewFails)process.exit(43);await fs.writeFile(path.join(out,'review.json'),JSON.stringify({reviewed:['output/frames/mock.png'],issues:[],corrections:[]}));}
if(mode==='render'){await fs.writeFile(path.join(out,'film.mp4'),Buffer.alloc(2048,7));await fs.writeFile(path.join(out,'validation.json'),JSON.stringify({passed:true,duration:600,width:1280,height:720,fps:24,frameCount:14400}));}
`,{mode:0o755});

const free=createServer();await new Promise(resolve=>free.listen(0,'127.0.0.1',resolve));const port=free.address().port;await new Promise(resolve=>free.close(resolve));
const base=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};let child;
const id=number=>number.toString(16).padStart(64,'0');
const digest=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
async function seed(number,payload,{status='failed',scene=true,code='MODEL',stale=false,unsafe=false}={}){
  const key=id(number),directory=path.join(jobs,key),priv=path.join(privateRoot,key);await mkdir(path.join(directory,'output'),{recursive:true});await mkdir(priv,{recursive:true});
  await writeFile(path.join(priv,'input-visuals.json'),JSON.stringify(payload));
  await writeFile(path.join(priv,'state-visuals.json'),JSON.stringify({jobId:key,stage:'visuals',status,payloadDigest:digest(payload),createdAt:new Date().toISOString(),progress:{stage:'authoring',completed:0,total:6},error:{code,message:'Mock previous failure'}}));
  if(unsafe){const outside=path.join(temporary,'outside.js');await writeFile(outside,'PRIVATE_OUTSIDE');await symlink(outside,path.join(directory,'output','scene.js'));}
  else if(scene)await writeFile(path.join(directory,'output','scene.js'),'export const existingMockProject = true;');
  if(stale){await writeFile(path.join(directory,'output','check.json'),JSON.stringify({passed:true}));await writeFile(path.join(directory,'output','validation.json'),JSON.stringify({passed:true,duration:600}));await writeFile(path.join(directory,'output','film.mp4'),Buffer.alloc(2048,1));}
  return key;
}
const recoveredPayload={topic:'interrupted-existing-project'};await seed(2,recoveredPayload,{status:'running',code:'BUSY'});
async function start(){
  const broker=fileURLToPath(new URL('../broker.mjs',import.meta.url));
  child=spawn(process.execPath,['--import',cleanupHook,broker],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),WORKER_JOBS:jobs,WORKER_HOST_JOBS:jobs,WORKER_HOST_CODEX_AUTH:path.join(temporary,'auth'),WORKER_TOKEN_FILE:path.join(temporary,'token'),WORKER_DOCKER_BIN:docker},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
  for(let attempt=0;attempt<200;attempt++){try{if((await fetch(base+'/health')).status===401)return;}catch{}if(child.exitCode!==null)throw new Error(output);await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Broker startup timeout: '+output);
}
const request=(key,method='GET',body)=>fetch(base+`/jobs/${key}/visuals`,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
async function wait(key){for(let attempt=0;attempt<400;attempt++){const response=await request(key),state=await response.json();if(['ready','failed'].includes(state.status))return state;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Job did not finish');}
async function modes(key){try{return(await readFile(callsFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(call=>call.id===key).map(call=>call.mode);}catch{return[];}}
async function submit(key,payload){assert.equal((await request(key,'POST',payload)).status,202);return wait(key);}
async function state(key){return JSON.parse(await readFile(path.join(privateRoot,key,'state-visuals.json'),'utf8'));}
const waves=Array.from({length:8},(_,index)=>{const bytes=Buffer.alloc(4096,index);bytes.write('RIFF',0);bytes.write('WAVE',8);return{name:`chapter-${index+1}.wav`,bytes,hash:createHash('sha256').update(bytes).digest('hex')};});
const put=(key,wave,hash=wave.hash)=>fetch(base+`/jobs/${key}/assets/${wave.name}`,{method:'PUT',headers:{Authorization:headers.Authorization,'Content-Type':'audio/wav','X-Content-SHA256':hash},body:wave.bytes});
let checks=0;
try{
  await start();
  const interrupted=await (await request(id(2))).json();assert.equal(interrupted.status,'failed');assert.equal(interrupted.error.reason,'WORKER_INTERRUPTED');assert.equal(interrupted.error.stage,'authoring');checks++;
  const payload={topic:'failed-author-project',firstCheckFails:true},failed=await seed(1,payload);
  assert.equal((await submit(failed,payload)).status,'ready');assert.equal((await state(failed)).resumeExistingProject,true);assert.deepEqual(await modes(failed),['check','review','check','render']);checks++;
  assert.equal((await submit(id(2),recoveredPayload)).status,'ready');assert.deepEqual(await modes(id(2)),['check','review','check','render']);checks++;

  const absentPayload={topic:'missing-project'},absent=await seed(3,absentPayload,{scene:false});assert.equal((await submit(absent,absentPayload)).status,'ready');assert.equal((await state(absent)).resumeExistingProject,undefined);assert.deepEqual(await modes(absent),['visuals','check','review','check','render']);checks++;

  // Client body cannot opt into the private resume flag, even with leftover files.
  const fresh=id(4),forged={topic:'fresh',resumeExistingProject:true};await mkdir(path.join(jobs,fresh,'output'),{recursive:true});await writeFile(path.join(jobs,fresh,'output','scene.js'),'export const preexisting = true;');assert.equal((await submit(fresh,forged)).status,'ready');assert.equal((await state(fresh)).resumeExistingProject,undefined);assert.equal((await modes(fresh))[0],'visuals');checks++;

  const mismatch=await seed(5,{topic:'original'});assert.equal((await request(mismatch,'POST',{topic:'changed'})).status,409);assert.deepEqual(await modes(mismatch),[]);checks++;
  const unsafePayload={topic:'unsafe-project'},unsafe=await seed(6,unsafePayload,{unsafe:true});const unsafeResponse=await request(unsafe,'POST',unsafePayload);assert.equal(unsafeResponse.status,400);assert(!(await unsafeResponse.text()).includes('PRIVATE_OUTSIDE'));assert.deepEqual(await modes(unsafe),[]);checks++;

  const badPayload={topic:'bad-check',checkAlwaysFails:true},bad=await seed(7,badPayload,{stale:true});const badState=await submit(bad,badPayload);assert.equal(badState.status,'failed');assert.equal(badState.error.code,'VALIDATION');assert.equal(badState.error.reason,'SCENE_CHECK_FAILED');assert.equal(badState.error.stage,'reviewing');assert.deepEqual(await modes(bad),['check','review','check','review','check']);assert.equal((await fetch(base+`/jobs/${bad}/artifact`,{headers})).status,404);checks++;
  const reviewPayload={topic:'bad-review',reviewFails:true},review=await seed(8,reviewPayload);assert.equal((await submit(review,reviewPayload)).status,'failed');assert.deepEqual(await modes(review),['check','review']);checks++;

  const partial=id(9),partialPayload={topic:'initial-author-timeout',authorFailsAfterScene:true};assert.equal((await submit(partial,partialPayload)).status,'ready');assert.equal((await state(partial)).continuedAfterAuthorFailure,true);assert.equal((await state(partial)).resumeExistingProject,undefined);assert.deepEqual(await modes(partial),['visuals','check','review','check','render']);checks++;
  const empty=id(10),emptyPayload={topic:'initial-author-no-project',authorFailsWithoutScene:true};assert.equal((await submit(empty,emptyPayload)).status,'failed');assert.deepEqual(await modes(empty),['visuals']);checks++;
  const unverified=id(11),unverifiedPayload={topic:'failed-author-unverified-project',authorFailsAfterScene:true,checkAlwaysFails:true};assert.equal((await submit(unverified,unverifiedPayload)).status,'failed');assert.deepEqual(await modes(unverified),['visuals','check','review','check','review','check']);assert.equal((await fetch(base+`/jobs/${unverified}/artifact`,{headers})).status,404);checks++;

  const before=await modes(failed);assert.equal((await request(failed,'POST',payload)).status,200);assert.deepEqual(await modes(failed),before);checks++;
  const rapid=id(12),rapidPayload={topic:'rapid-eight-WAV-upload'};
  for(const wave of waves){const response=await put(rapid,wave);assert.equal(response.status,200,await response.text());assert.deepEqual(await readFile(path.join(jobs,rapid,'audio',wave.name)),wave.bytes);}
  assert.equal((await submit(rapid,rapidPayload)).status,'ready');assert.equal((await modes(rapid))[0],'visuals');checks++;

  const retryPayload={topic:'failed-eight-WAV-retry'},retry=await seed(13,retryPayload);
  for(const wave of waves){const response=await put(retry,wave);assert.equal(response.status,200,await response.text());}
  const priorStats=await Promise.all(waves.map(wave=>stat(path.join(jobs,retry,'audio',wave.name),{bigint:true})));
  for(let pass=0;pass<3;pass++)for(const wave of waves){const response=await put(retry,wave);assert.equal(response.status,200,await response.text());}
  for(const[index,wave]of waves.entries()){const current=await stat(path.join(jobs,retry,'audio',wave.name),{bigint:true});assert.equal(current.ino,priorStats[index].ino,'Same-hash failed retries must not replace cached WAVs');assert.equal(current.mtimeNs,priorStats[index].mtimeNs);assert.deepEqual(await readFile(path.join(jobs,retry,'audio',wave.name)),wave.bytes);}
  assert.equal((await submit(retry,retryPayload)).status,'ready');assert.deepEqual(await modes(retry),['check','review','check','render']);checks++;

  const rejected=id(14);assert.equal((await put(rejected,waves[0],'f'.repeat(64))).status,400);assert.equal((await put(rejected,waves[0])).status,200);assert.equal((await put(rejected,waves[1])).status,200);assert.equal((await readdir(path.join(jobs,rejected,'audio'))).some(name=>name.endsWith('.part')),false);checks++;

  // A numerical checkpoint is observation only: even 100% encoded frames cannot
  // expose an artifact or make an unvalidated job ready. Raw report data is private.
  const telemetry=await seed(15,{topic:'bounded-frame-telemetry'}),checkpoint=path.join(jobs,telemetry,'output','render-progress.json'),privateState=await state(telemetry);
  privateState.status='running';privateState.progress={stage:'rendering',completed:4,total:6,stageStartedAt:new Date().toISOString()};
  await writeFile(path.join(privateRoot,telemetry,'state-visuals.json'),JSON.stringify(privateState));
  await writeFile(checkpoint,JSON.stringify({completed:3600,total:14400,elapsedSeconds:123,privateToken:'NEVER_PUBLIC'}));
  let observed=await (await request(telemetry)).json();assert.deepEqual(observed.progress.frames,{completed:3600,total:14400});assert.equal(observed.status,'running');assert.ok(!JSON.stringify(observed).includes('NEVER_PUBLIC'));checks++;
  for(const value of [{completed:14401,total:14400},{completed:-1,total:14400},{completed:'3600',total:14400},{completed:1,total:999999999},{completed:1,total:0}]){await writeFile(checkpoint,JSON.stringify(value));observed=await (await request(telemetry)).json();assert.equal(observed.progress.frames,undefined);}checks++;
  await writeFile(checkpoint,JSON.stringify({completed:14400,total:14400}));observed=await (await request(telemetry)).json();assert.equal(observed.status,'running');assert.equal((await fetch(base+`/jobs/${telemetry}/artifact`,{headers})).status,404);
  const old=new Date(Date.now()-60000);await utimes(checkpoint,old,old);observed=await (await request(telemetry)).json();assert.equal(observed.progress.frames,undefined);checks++;
  await rm(checkpoint);const outside=path.join(temporary,'outside-checkpoint.json');await writeFile(outside,JSON.stringify({completed:100,total:14400}));await symlink(outside,checkpoint);observed=await (await request(telemetry)).json();assert.equal(observed.progress.frames,undefined);checks++;
  console.log(`Broker resume fixture passed ${checks} cases: trusted resume and mandatory checks/review/render, plus rapid eight-WAV PUTs with delayed cleanup, failed same-hash cache reuse and error unlock. Mock Docker only.`);
}finally{
  if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  await rm(temporary,{recursive:true,force:true});
}
