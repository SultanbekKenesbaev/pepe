/** Bounded stock-media capability for the author. No shell, credentials or arbitrary hosts. */
import readline from 'node:readline';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {constants} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';

const job=path.resolve(process.env.MEDIA_JOB_DIR||process.env.CODEX_JOB_DIR||'/job');
const maximumVideo=80*1024*1024,maximumPage=3*1024*1024;
const sourceHost='www.pexels.com',videoHost='videos.pexels.com';
const tools=[{name:'download_stock_video',description:'Download a relevant licensed Pexels video found with native web search. Supply a public Pexels source page and matching videos.pexels.com/video-files/ID/...mp4 URL. The tool validates both hosts and matching source ID, limits size and records credits. Use short clips only when educationally relevant.',inputSchema:{type:'object',additionalProperties:false,required:['sourceUrl','downloadUrl','filename','creator'],properties:{sourceUrl:{type:'string'},downloadUrl:{type:'string'},filename:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,47}\\.mp4$'},creator:{type:'string',minLength:1,maxLength:100}}}}];
function check(value,message){if(!value)throw Error(message);}
function publicURL(value,host){const u=new URL(value);check(u.protocol==='https:'&&u.hostname===host&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash,'Only the approved HTTPS stock host is allowed');return u;}
async function regularDirectory(directory){const info=await fs.lstat(directory);check(info.isDirectory()&&!info.isSymbolicLink(),'Invalid media directory');}
async function bytes(response,maximum){check(response.ok,'Stock source unavailable');const reader=response.body?.getReader();check(reader,'Empty stock source');const chunks=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=maximum,'Stock file exceeds size limit');chunks.push(part.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}return Buffer.concat(chunks);}
export async function downloadStockVideo(input,{fetcher=fetch,jobDirectory=job}={}){
 check(input&&typeof input==='object'&&Object.keys(input).every(k=>['sourceUrl','downloadUrl','filename','creator'].includes(k)),'Invalid media request');
 const source=publicURL(input.sourceUrl,sourceHost),video=publicURL(input.downloadUrl,videoHost);
 const sourceID=source.pathname.match(/^\/video\/(?:[a-z0-9-]*-)?(\d{3,14})\/?$/)?.[1],videoID=video.pathname.match(/^\/video-files\/(\d{3,14})\/[a-zA-Z0-9_./-]+\.mp4$/)?.[1];
 check(sourceID&&sourceID===videoID&&!video.pathname.includes('..'),'Source and download must identify the same Pexels video');
 check(typeof input.filename==='string'&&/^[a-z0-9][a-z0-9-]{0,47}\.mp4$/.test(input.filename),'Invalid local media filename');
 check(typeof input.creator==='string'&&input.creator.trim().length>=1&&input.creator.length<=100&&!/[\x00-\x1f]/.test(input.creator),'Invalid attribution');
 check(process.platform==='linux','Stock download requires the isolated Linux worker');
 const root=path.resolve(jobDirectory),handles=[];let pinned;
 try{
  const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
  const rootHandle=await fs.open(root,flags);handles.push(rootHandle);
  const outputHandle=await fs.open(`/proc/self/fd/${rootHandle.fd}/output`,flags);handles.push(outputHandle);
  const outputPath=`/proc/self/fd/${outputHandle.fd}`;
  try{await fs.mkdir(outputPath+'/assets',{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const assetsHandle=await fs.open(outputPath+'/assets',flags);handles.push(assetsHandle);pinned=`/proc/self/fd/${assetsHandle.fd}`;
  check((await fs.realpath(pinned)).startsWith((await fs.realpath(root))+path.sep),'Media path leaves the job');
 const ledgerFile=pinned+'/stock-ledger.json';let ledger=[];
 try{const handle=await fs.open(ledgerFile,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();check(stat.isFile()&&stat.size<=128*1024,'Invalid media ledger');ledger=JSON.parse(await handle.readFile('utf8'));check(Array.isArray(ledger)&&ledger.length<=4,'Media limit reached');}finally{await handle.close();}}catch(error){if(error.code!=='ENOENT')throw error;}
 check(ledger.length<4,'Use at most four stock sources per film');
 const pageResponse=await fetcher(source,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Routemotion-Educational-Media/1.0'}});
 const page=(await bytes(pageResponse,maximumPage)).toString('utf8');
 check(/pexels/i.test(page)&&page.includes(sourceID),'Source page could not be verified');
 const response=await fetcher(video,{redirect:'error',signal:AbortSignal.timeout(90000)});
 check((response.headers.get('content-type')||'').split(';')[0].toLowerCase()==='video/mp4','Stock source is not an MP4');
 const data=await bytes(response,maximumVideo);check(data.length>1024&&data.toString('ascii',4,8)==='ftyp','Invalid stock video');
 check((await fs.realpath(pinned)).startsWith((await fs.realpath(root))+path.sep),'Media directory moved outside the job');
 const filename=pinned+'/'+input.filename,handle=await fs.open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(data);}finally{await handle.close();}
 const entry={file:'assets/'+input.filename,source:source.href,download:video.href,creator:input.creator.trim(),license:'Pexels Content License',licenseUrl:'https://www.pexels.com/license/',sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};
 ledger.push(entry);const temporary=ledgerFile+'.'+randomBytes(4).toString('hex')+'.tmp';await fs.writeFile(temporary,JSON.stringify(ledger,null,2),{mode:0o600});await fs.rename(temporary,ledgerFile);
 return entry;
 }finally{for(const handle of handles.reverse())await handle.close();}
}
async function dispatch(message){
 if(message.method==='initialize')return{protocolVersion:message.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'routemotion-media',version:'1.0.0'}};
 if(message.method==='ping')return{};
 if(message.method==='tools/list')return{tools};
 if(message.method==='tools/call'){
  if(message.params?.name!=='download_stock_video')throw Error('Unknown media tool');
  try{return{content:[{type:'text',text:JSON.stringify(await downloadStockVideo(message.params.arguments))}]};}
  catch(error){return{isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Stock media unavailable'}]};}
 }
 throw Error('Unknown method');
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const reader=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 for await(const line of reader){if(!line.trim())continue;let message;try{check(Buffer.byteLength(line)<64*1024,'Request too large');message=JSON.parse(line);if(message.id===undefined)continue;const result=await dispatch(message);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');}catch{if(message?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Invalid media request'}})+'\n');}}
}
