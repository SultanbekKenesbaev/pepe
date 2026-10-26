import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const root=path.resolve(process.env.WORKER_JOBS||'/jobs');
const privateRoot=path.join(root,'.broker-state');
const hostJobs=process.env.WORKER_HOST_JOBS||'/opt/ai-teacher/author-jobs';
const hostAuth=process.env.WORKER_HOST_CODEX_AUTH||'/opt/ai-teacher/codex-auth';
const hostKey=process.env.WORKER_HOST_OPENAI_KEY||'';
const tokenFile=process.env.WORKER_TOKEN_FILE||'/run/secrets/author-worker.token';
const authorImage=process.env.WORKER_AUTHOR_IMAGE||'routemotion-lesson-author:latest';
const renderImage=process.env.WORKER_RENDER_IMAGE||'routemotion-lesson-render:latest';
const authorSeccomp=process.env.WORKER_SECCOMP_PROFILE||'/run/security/worker-seccomp.json';
const authorAppArmor=process.env.WORKER_APPARMOR_PROFILE||'routemotion-lesson-author';
const renderCpus=Number(process.env.WORKER_RENDER_CPUS||6);
if(!Number.isFinite(renderCpus)||renderCpus<1||renderCpus>8)throw new Error('WORKER_RENDER_CPUS must be between 1 and 8');
const docker=process.env.WORKER_DOCKER_BIN||'docker';
const videoMode=process.env.WORKER_VIDEO_MODE||'3d';
if(!['2d','3d'].includes(videoMode))throw new Error('Invalid worker video mode');
const illustrated=videoMode==='2d';
const owner='routemotion-ai-teacher-authoring'+(illustrated?'-2d':'');
const containerPrefix=illustrated?'aiteacher2d':'aiteacher';
const maxFile=60*1024*1024,maxAudio=80*1024*1024,maxJson=2*1024*1024;
const ids=/^[a-f0-9]{64}$/;
const files=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.wav$/;
const queue=[],children=new Set(),uploads=new Set(),submissions=new Set();
let authPending=null;
let active=null,closing=false,authCache={until:0,value:{configured:false,mode:'none'}};
for(const value of [hostJobs,hostAuth,hostKey].filter(Boolean))if(!path.isAbsolute(value)||/[\n\r,\0]/.test(value))throw new Error('Invalid worker host mount');
await fs.mkdir(root,{recursive:true,mode:0o700});
await fs.mkdir(privateRoot,{recursive:true,mode:0o700});
const token=(await fs.readFile(tokenFile,'utf8')).trim();
if(token.length<32)throw new Error('Worker token is not configured');

function failure(code='VALIDATION',message='Задание не выполнено',reason){const error=new Error(message);error.code=code;if(reason)error.reason=reason;return error;}
function publicError(error,stage){const code=['AUTH','MODEL','RENDER','VALIDATION','BUSY'].includes(error?.code)?error.code:'VALIDATION';const reasons=['AUTHOR_TIMEOUT','SCRIPT_TIMEOUT','REVIEW_TIMEOUT','RENDER_TIMEOUT','SCRIPT_INVALID','SCENE_CHECK_FAILED','ARTIFACT_INVALID','WORKER_INTERRUPTED','ALIGNMENT_FAILED','IMAGE_GENERATION_FAILED'];return {code,message:({AUTH:'Требуется авторизация Codex',MODEL:'Codex не завершил подготовку урока',RENDER:'Не удалось собрать видео',VALIDATION:'Материалы не прошли проверку',BUSY:'Задание было прервано. Повторите запуск'})[code],...(reasons.includes(error?.reason)?{reason:error.reason}:{}),...(['queued','alignment','images','authoring','checking','reviewing','rendering','validating'].includes(stage)?{stage}:{})};}
function directory(id){if(!ids.test(id))throw failure();return path.join(root,id);}
function privateDirectory(id){directory(id);return path.join(privateRoot,id);}
function statePath(id,stage){return path.join(privateDirectory(id),`state-${stage}.json`);}
async function safeFile(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw failure();const relative=path.relative(root,path.resolve(file));const id=relative.split(path.sep)[0];const base=ids.test(id)?directory(id):privateRoot;const actual=await fs.realpath(file),allowed=await fs.realpath(base);if(!actual.startsWith(allowed+path.sep))throw failure();return stat;}
async function safeJobDirectory(id,file){const stat=await fs.lstat(file);if(!stat.isDirectory()||stat.isSymbolicLink())throw failure();const actual=await fs.realpath(file),allowed=await fs.realpath(directory(id));if(!actual.startsWith(allowed+path.sep))throw failure();}
async function atomic(file,value){const temp=`${file}.${randomBytes(6).toString('hex')}.tmp`;await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);}
async function readJson(file){const stat=await safeFile(file);if(stat.size>maxJson)throw failure();return JSON.parse(await fs.readFile(file,'utf8'));}
async function loadState(id,stage){try{return await readJson(statePath(id,stage));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function saveState(state){state.updatedAt=new Date().toISOString();await atomic(statePath(state.jobId,state.stage),state);}
async function expose(state){if(!state)return null;const progress={...state.progress};
 if(illustrated&&state.status==='running'&&progress.stage==='authoring')try{
  const file=path.join(directory(state.jobId),'output','author-progress.json'),info=await safeFile(file);
  if(info.size<=16384&&(!progress.stageStartedAt||info.mtimeMs>=Date.parse(progress.stageStartedAt)-1000)){
   const p=JSON.parse(await fs.readFile(file,'utf8'));
   if(p.stage==='images'&&Number.isInteger(p.completed)&&Number.isInteger(p.total)&&p.total>=1&&p.total<=16&&p.completed>=0&&p.completed<=p.total)Object.assign(progress,{stage:'images',completed:p.completed,total:p.total});
  }
 }catch{}
 if(state.status==='running'&&progress.stage==='rendering')try{
  const file=path.join(directory(state.jobId),'output','render-progress.json'),info=await safeFile(file);
  if(info.size<=16384&&(!progress.stageStartedAt||info.mtimeMs>=Date.parse(progress.stageStartedAt)-1000)){
   const p=JSON.parse(await fs.readFile(file,'utf8'));
   if(Number.isInteger(p.completed)&&Number.isInteger(p.total)&&p.total>=12000&&p.total<=72000&&p.completed>=0&&p.completed<=p.total)progress.frames={completed:p.completed,total:p.total};
  }
 }catch{} // Telemetry cannot make a checked render fail or become ready.
 return {jobId:state.jobId,stage:state.stage,status:state.status,progress,...(state.result?{result:state.result}:{}),...(state.error?{error:state.error}:{})};}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function authorized(req){const supplied=req.headers.authorization;if(typeof supplied!=='string'||!supplied.startsWith('Bearer '))return false;const candidate=Buffer.from(supplied.slice(7));const expected=Buffer.from(token);return candidate.length===expected.length&&timingSafeEqual(candidate,expected);}
async function bodyJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxJson)throw failure();chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure();}}
async function hashFile(file){await safeFile(file);const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file)){hash.update(chunk);bytes+=chunk.length;}return {sha256:hash.digest('hex'),bytes};}

async function dockerCommand(args,timeout=30_000){return new Promise((resolve,reject)=>{const child=spawn(docker,args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin'}});let text='',error='';let settled=false;const timer=setTimeout(()=>{child.kill('SIGKILL');if(!settled){settled=true;reject(failure('BUSY'));}},timeout);child.stdout.on('data',chunk=>{if(text.length<65536)text+=chunk;});child.stderr.on('data',chunk=>{if(error.length<2048)error+=chunk;});child.on('error',()=>{clearTimeout(timer);if(!settled){settled=true;reject(failure('BUSY'));}});child.on('close',code=>{clearTimeout(timer);if(!settled){settled=true;resolve({code,text,error});}});});}
async function removeContainer(name){const result=await dockerCommand(['rm','--force',name],30_000);if(result.code!==0){const lookup=await dockerCommand(['ps','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}']);if(lookup.code!==0||lookup.text.trim())throw failure('BUSY');}}
function containerArgs(id,kind,mode){
 const name=`${containerPrefix}-${kind}-${id.slice(0,12)}-${randomBytes(3).toString('hex')}`;
 const args=['run','--rm','--name',name,'--label',`com.routemotion.authoring=${owner}`,'--label',`com.routemotion.job=${id}`,'--init','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit',kind==='render'&&illustrated?'768':'256','--cpus',kind==='render'?String(renderCpus):'2','--memory',kind==='render'?'6g':'4g','--tmpfs','/tmp:rw,nosuid,nodev,size=1g,mode=1777','--mount',`type=bind,src=${path.join(hostJobs,id)},dst=/job`,'--workdir','/job'];
 if(kind==='render')args.push('--network','none');
 else{
  args.push('--security-opt',`seccomp=${authorSeccomp}`,'--security-opt',`apparmor=${authorAppArmor}`);
  args.push('--mount',`type=bind,src=${hostAuth},dst=/codex`,'--env','CODEX_HOME=/codex','--env',`CODEX_MODEL=${process.env.CODEX_MODEL||'gpt-6-astra'}`,'--env',`CODEX_REASONING_EFFORT=${process.env.CODEX_REASONING_EFFORT||'ultra'}`);
  if(illustrated)args.push('--mount',`type=bind,src=${path.join(hostJobs,id,'generated-images')},dst=/codex/generated_images`);
  if(illustrated&&['visuals','review'].includes(mode))for(const relative of ['audio','.trusted-asr','input.json','output/voice-alignment.json','output/assets/voice-full.wav'])args.push('--mount',`type=bind,src=${path.join(hostJobs,id,relative)},dst=/job/${relative},readonly`);
  if(hostKey)args.push('--mount',`type=bind,src=${hostKey},dst=/run/secrets/openai-api.key,readonly`,'--env','CODEX_API_KEY_FILE=/run/secrets/openai-api.key');
 }
 args.push(kind==='render'?renderImage:authorImage,'node',`/runtime/${kind}${illustrated?'2d':''}.mjs`,mode);
 return {name,args};
}
async function runContainer(id,kind,mode,timeout,optional=false){
 if(active?.deadlineAt)timeout=Math.max(1,Math.min(timeout,Date.parse(active.deadlineAt)-Date.now()));
 const {name,args}=containerArgs(id,kind,mode);children.add(name);
 const log=await fs.open(path.join(privateDirectory(id),'private-worker.log'),'a',0o600);
 try{
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(docker,args,{stdio:['ignore',log.fd,log.fd],env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin'}});
   let ended=false;const timer=setTimeout(()=>{if(ended)return;ended=true;child.kill('SIGTERM');void removeContainer(name).catch(()=>{});reject(failure(kind==='render'?'RENDER':'MODEL','Задание превысило время ожидания',kind==='render'?'RENDER_TIMEOUT':mode==='review'?'REVIEW_TIMEOUT':mode==='script'?'SCRIPT_TIMEOUT':'AUTHOR_TIMEOUT'));},timeout);
   child.on('error',()=>{clearTimeout(timer);if(!ended){ended=true;reject(failure('BUSY'));}});
   child.on('close',code=>{clearTimeout(timer);if(!ended){ended=true;resolve({code});}});
  });
  if(result.code!==0&&!optional){
   let reason=illustrated&&mode==='prepare'?'ALIGNMENT_FAILED':undefined;
   if(illustrated&&kind==='author'&&['visuals','review'].includes(mode))try{const diagnostic=await readJson(path.join(directory(id),'output/author-error.json'));if(diagnostic.reason==='IMAGE_GENERATION_FAILED')reason=diagnostic.reason;}catch{}
   throw failure(kind==='render'?'RENDER':'MODEL',undefined,reason);
  }
  return result;
 }finally{try{await removeContainer(name);}catch{closing=true;setTimeout(()=>process.exit(1),1000).unref();throw failure('BUSY');}finally{children.delete(name);await log.close();}}
}
async function refreshAuthStatus(){
 if(Date.now()<authCache.until)return authCache.value;
 const id='0'.repeat(64);await fs.mkdir(directory(id),{recursive:true,mode:0o700});
 if(illustrated)await fs.mkdir(path.join(directory(id),'generated-images'),{recursive:true,mode:0o700});
 try{
  const {name,args}=containerArgs(id,'author','auth');children.add(name);
  try{const result=await dockerCommand(args,15_000);let parsed;try{parsed=JSON.parse(result.text.trim().split('\n').at(-1));}catch{};authCache.value={configured:result.code===0&&parsed?.configured===true,mode:['api','chatgpt'].includes(parsed?.mode)?parsed.mode:'none',...(illustrated?{imageGeneration:parsed?.imageGeneration===true}:{})};}
  finally{await removeContainer(name).catch(()=>{});children.delete(name);}
 }catch{authCache.value={configured:false,mode:'none'};}
 authCache.until=Date.now()+30_000;return authCache.value;
}
async function authStatus(){if(Date.now()<authCache.until)return authCache.value;if(authPending)return authPending;authPending=refreshAuthStatus();try{return await authPending;}finally{authPending=null;}}
async function update(state,stage,completed,total){state.progress={stage,completed,total,stageStartedAt:state.progress?.stage===stage&&state.progress.stageStartedAt?state.progress.stageStartedAt:new Date().toISOString()};await saveState(state);}
async function fileExists(file){try{await safeFile(file);return true;}catch{return false;}}
async function existingVisualProject(id){
 const output=path.join(directory(id),'output'),scene=path.join(output,illustrated?'index.html':'scene.js');
 try{await fs.lstat(scene);}catch(error){if(error.code==='ENOENT')return false;throw error;}
 await safeJobDirectory(id,output);const stat=await safeFile(scene);
 return stat.size>0&&stat.size<=maxJson;
}
async function checkJob(id){
 await safeJobDirectory(id,path.join(directory(id),'output'));
 const report=path.join(directory(id),'output','check.json');
 await fs.rm(report,{force:true});
 await runContainer(id,'render','check',5*60_000,true);
 return readJson(report);
}
async function processJob(state){
 const id=state.jobId,dir=directory(id);state.status='running';state.deadlineAt=new Date(Date.now()+2*60*60_000).toISOString();delete state.error;await update(state,'authoring',0,state.stage==='script'?1:6);
 try{
  if(!(await authStatus()).configured)throw failure('AUTH');
  await atomic(path.join(dir,'input.json'),await readJson(path.join(privateDirectory(id),`input-${state.stage}.json`)));
  await fs.mkdir(path.join(dir,'output'),{recursive:true,mode:0o700});
  if(illustrated)await fs.mkdir(path.join(dir,'generated-images'),{recursive:true,mode:0o700});
  await safeJobDirectory(id,path.join(dir,'output'));
  if(state.stage==='script'){
   await runContainer(id,'author','script',30*60_000);
   const script=await readJson(path.join(dir,'output','script.json'));
   if(!script||typeof script!=='object'||Array.isArray(script)||typeof script.title!=='string'||!Array.isArray(script.chapters)||script.chapters.length<3||script.chapters.length>16||script.chapters.some(chapter=>!chapter||typeof chapter.id!=='string'||!Array.isArray(chapter.cues)||chapter.cues.some(cue=>!cue||typeof cue.id!=='string'||typeof cue.text!=='string'||!cue.text.trim()))||script.chapters.reduce((sum,chapter)=>sum+chapter.cues.length,0)<12||script.chapters.reduce((sum,chapter)=>sum+chapter.cues.length,0)>40)throw failure('VALIDATION','Сценарий не прошёл проверку','SCRIPT_INVALID');
   state.result=script;await update(state,'complete',1,1);
  }else{
   if(illustrated){
    await update(state,'alignment',0,6);
    await runContainer(id,'render','prepare',25*60_000);
    await update(state,'authoring',0,6);
   }
   if(!state.resumeExistingProject){
    try{await runContainer(id,'author','visuals',30*60_000);}
    catch(error){
     // A timed-out author may have completed a useful project. Its presence is
     // only a reason to try the normal trusted checks, never evidence of readiness.
     if(closing||error.code!=='MODEL'||error.reason==='IMAGE_GENERATION_FAILED'||!await existingVisualProject(id))throw error;
     state.continuedAfterAuthorFailure=true;
    }
   }
   if(!await fileExists(path.join(dir,'output',illustrated?'index.html':'scene.js')))throw failure('VALIDATION');
   await update(state,'checking',1,6);
   let checked=await checkJob(id);
   for(let repair=0;repair<2;repair++){
    await update(state,'reviewing',2+repair,6);
    await runContainer(id,'author','review',45*60_000);
    checked=await checkJob(id);
    if(checked.passed===true)break;
   }
   if(checked.passed!==true)throw failure('VALIDATION','Сцены не прошли проверку','SCENE_CHECK_FAILED');
   await safeJobDirectory(id,path.join(dir,'output'));
   await fs.rm(path.join(dir,'output','render-progress.json'),{force:true});
   await update(state,'rendering',4,6);
   await fs.rm(path.join(dir,'output','validation.json'),{force:true});
   await fs.rm(path.join(dir,'output','film.mp4'),{force:true});
   await runContainer(id,'render','render',90*60_000);
   await update(state,'validating',5,6);
   const validation=await readJson(path.join(dir,'output','validation.json'));
   const movie=path.join(dir,'output','film.mp4');
   if(validation.passed!==true||!['duration','width','height','fps','frameCount'].every(key=>Number.isFinite(validation[key])&&validation[key]>0)||!await fileExists(movie))throw failure('VALIDATION','Готовый файл не прошёл проверку','ARTIFACT_INVALID');
   const artifact=await hashFile(movie);if(artifact.bytes<1024||artifact.bytes>2*1024*1024*1024)throw failure('VALIDATION');
   state.result={...validation,sha256:artifact.sha256,artifactSha256:artifact.sha256,artifactBytes:artifact.bytes};await update(state,'complete',6,6);
  }
  state.status='ready';await saveState(state);
 }catch(error){state.status='failed';state.error=publicError(error,state.progress?.stage);await saveState(state);}
}
async function drain(){if(active||closing)return;const next=queue.shift();if(!next)return;active=next;try{await processJob(next);}finally{active=null;void drain();}}
async function recover(){
 const running=await dockerCommand(['ps','--all','--filter',`label=com.routemotion.authoring=${owner}`,'--format','{{.Names}}']);
 if(running.code!==0)throw failure('BUSY');
 for(const name of running.text.split('\n').filter(Boolean)){if(new RegExp(`^${containerPrefix}-(author|render)-[a-f0-9]{12}-[a-f0-9]{6}$`).test(name))await removeContainer(name);}
 for(const item of await fs.readdir(privateRoot,{withFileTypes:true})){
  if(!item.isDirectory()||!ids.test(item.name))continue;
  for(const stage of ['script','visuals']){const state=await loadState(item.name,stage);if(state&&['queued','running'].includes(state.status)){state.status='failed';state.error=publicError(failure('BUSY','Генерация прервана перезапуском','WORKER_INTERRUPTED'),state.progress?.stage);await saveState(state);}}
 }
}
await recover();

const server=http.createServer(async(req,res)=>{
 try{
  if(!authorized(req)){json(res,401,{error:{code:'AUTH',message:'Unauthorized'}});req.resume();return;}
  const url=new URL(req.url,'http://worker');
  if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{ok:true,...await authStatus(),videoMode,busy:!!active,queued:queue.length});return;}
  const asset=url.pathname.match(/^\/jobs\/([a-f0-9]{64})\/assets\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.wav)$/);
  if(req.method==='PUT'&&asset){
   const [,id,name]=asset;if(!files.test(name))throw failure();
   const expected=req.headers['x-content-sha256'];if(typeof expected!=='string'||!ids.test(expected))throw failure();
   if(uploads.has(id)||submissions.has(`${id}:visuals`)){json(res,409,{error:publicError(failure('BUSY'))});req.resume();return;}
   uploads.add(id);let temp;
   try{
    const visuals=await loadState(id,'visuals');
    if(visuals&&['queued','running','ready','failed'].includes(visuals.status)){
     const stored=path.join(directory(id),'audio',name);
     if(await fileExists(stored)){
      const actual=await hashFile(stored);
      if(actual.sha256===expected&&actual.bytes<=maxFile){req.resume();uploads.delete(id);json(res,200,{filename:name,sha256:actual.sha256,bytes:actual.bytes});return;}
     }
     if(visuals.status!=='failed'){json(res,409,{error:publicError(failure('BUSY'))});req.resume();return;}
    }
    const dir=path.join(directory(id),'audio');await fs.mkdir(dir,{recursive:true,mode:0o700});await safeJobDirectory(id,dir);
    const target=path.join(dir,name);temp=`${target}.${randomBytes(6).toString('hex')}.part`;
    let other=0;for(const item of await fs.readdir(dir,{withFileTypes:true})){if(item.isFile()&&item.name!==name&&files.test(item.name))other+=(await fs.stat(path.join(dir,item.name))).size;}
    let count=0;const hash=createHash('sha256'),first=[];let firstBytes=0;const output=createWriteStream(temp,{flags:'wx',mode:0o600});
    await pipeline(req,async function*(source){for await(const chunk of source){count+=chunk.length;if(count>maxFile||other+count>maxAudio)throw failure();if(firstBytes<12){first.push(chunk.subarray(0,12-firstBytes));firstBytes+=Math.min(chunk.length,12-firstBytes);}hash.update(chunk);yield chunk;}},output);
    const header=Buffer.concat(first);if(count<44||hash.digest('hex')!==expected||header.subarray(0,4).toString()!=='RIFF'||header.subarray(8,12).toString()!=='WAVE')throw failure();
    await fs.rename(temp,target);temp=undefined;uploads.delete(id);json(res,200,{filename:name,sha256:expected,bytes:count});
   }finally{if(temp)await fs.rm(temp,{force:true});uploads.delete(id);}return;
  }
  const artifact=url.pathname.match(/^\/jobs\/([a-f0-9]{64})\/artifact$/);
  if(req.method==='GET'&&artifact){const state=await loadState(artifact[1],'visuals');if(state?.status!=='ready'){json(res,404,{error:publicError(failure('VALIDATION'))});return;}const file=path.join(directory(artifact[1]),'output','film.mp4');const stat=await safeFile(file);res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-SHA256':state.result.artifactSha256});await pipeline(createReadStream(file),res);return;}
  const match=url.pathname.match(/^\/jobs\/([a-f0-9]{64})\/(script|visuals)$/);
  if(match&&req.method==='GET'){const state=await loadState(match[1],match[2]);json(res,state?200:404,state?await expose(state):{error:publicError(failure())});return;}
  if(match&&req.method==='POST'){
   const [,id,stage]=match;const payload=await bodyJson(req);const submissionKey=`${id}:${stage}`;if(submissions.has(submissionKey)){json(res,409,{error:publicError(failure('BUSY'))});return;}submissions.add(submissionKey);try{if(!payload||typeof payload!=='object'||Array.isArray(payload))throw failure();if((payload.videoMode||'3d')!==videoMode)throw failure();const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');const existing=await loadState(id,stage);
   if(existing&&existing.payloadDigest!==digest){json(res,409,{error:publicError(failure('VALIDATION'))});return;}
   if(existing&&['queued','running','ready'].includes(existing.status)){json(res,existing.status==='ready'?200:202,await expose(existing));return;}
   if(queue.length>=10){json(res,429,{error:publicError(failure('BUSY'))});return;}
   if(uploads.has(id)){json(res,409,{error:publicError(failure('BUSY'))});return;}
   await fs.mkdir(directory(id),{recursive:true,mode:0o700});await fs.mkdir(privateDirectory(id),{recursive:true,mode:0o700});await atomic(path.join(privateDirectory(id),`input-${stage}.json`),payload);
   const resumeExistingProject=stage==='visuals'&&existing?.status==='failed'&&await existingVisualProject(id);
   const state={jobId:id,stage,status:'queued',payloadDigest:digest,createdAt:new Date().toISOString(),...(resumeExistingProject?{resumeExistingProject:true}:{}),progress:{stage:'queued',completed:0,total:stage==='script'?1:6}};
   await saveState(state);queue.push(state);json(res,202,await expose(state));void drain();return;
   }finally{submissions.delete(submissionKey);}
  }
  json(res,404,{error:{code:'VALIDATION',message:'Not found'}});
 }catch(error){if(!res.headersSent)json(res,400,{error:publicError(error)});else res.destroy();}
});
server.requestTimeout=5*60_000;server.headersTimeout=20_000;
server.listen(Number(process.env.PORT)||8080,process.env.HOST||'0.0.0.0',()=>console.log('Authoring broker ready'));
async function close(){if(closing)return;closing=true;server.close();for(const name of children)await removeContainer(name).catch(()=>{});if(active){active.status='failed';active.error=publicError(failure('BUSY','Генерация прервана перезапуском','WORKER_INTERRUPTED'),active.progress?.stage);await saveState(active);}process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
