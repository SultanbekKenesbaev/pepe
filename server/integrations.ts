import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.js';
import type { User, GeneratedLesson, LessonMaterialDetail } from '../shared/types.js';
import { ApiError, uid, now, hashToken, publicUser, adminRoles } from './security.js';
import { permitted, tenant } from './access.js';
import { resolveAuthoringSubject } from './platform.js';
import { integrationDocumentMimes as documentMimes, extractIntegrationDocument } from './integration-document.js';
import { canonicalJson, signingVault, resolveWebhook, deliverWebhook, bounded, webhookUrl } from './integration-security.js';
import { integrationOpenApi, integrationDocsHtml } from './integration-openapi.js';
import { refreshGenerationProgress } from './generation-progress.js';

const maxFileBytes=25*1024*1024,maxStorageBytes=500*1024*1024,maxFiles=1000;
const limitsSchema=z.object({requestsPerMinute:z.number().int().min(1).max(600),maxConcurrentJobs:z.number().int().min(1).max(4),jobsPerDay:z.number().int().min(1).max(1000)}).strict();
const defaultLimits={requestsPerMinute:30,maxConcurrentJobs:1,jobsPerDay:10};
const metadataSchema=z.record(z.string().min(1).max(64),z.union([z.string().max(500),z.number().finite(),z.boolean(),z.null()])).refine(value=>Object.keys(value).length<=20&&Buffer.byteLength(JSON.stringify(value))<=4096,'Metadata exceeds its limit');
const generationSchema=z.object({topic:z.string().trim().min(2).max(200),language:z.enum(['ru','kaa','uz']),video_mode:z.enum(['2d','3d']).optional(),file_ids:z.array(z.string().regex(/^file_[a-f0-9]{32}$/)).max(12).refine(ids=>new Set(ids).size===ids.length,'file_ids must be unique').default([]),external_teacher_id:z.string().trim().min(1).max(200).optional(),metadata:metadataSchema.optional()}).strict();
const revisionSchema=z.object({revision:z.number().int().nonnegative()}).strict();
type Integration={id:string;institutionId:string;ownerId:string;name:string;active:boolean;createdAt:string;updatedAt:string;limits:z.infer<typeof limitsSchema>;webhook:{url:string|null;configured:boolean;version?:string;updatedAt?:string};webhookCipher?:string};
type PartnerRequest=Request&{partner:Integration;apiKeyId:string;apiRequestId:string};
type JobRow={id:string;integration_id:string;generation_id:string;created_at:string;data:any};
type Row={data:Integration};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const dayStart=()=>new Date().toISOString().slice(0,10)+'T00:00:00.000Z';
const terminal=new Set(['ready','failed','language_review']);

function validate<T>(schema:z.ZodType<T>,value:unknown):T {
  const parsed=schema.safeParse(value);if(!parsed.success){const error=new ApiError(422,'Request fields are invalid','INVALID_REQUEST') as any;error.details=parsed.error.issues.map(issue=>({field:issue.path.join('.'),message:issue.message}));throw error;}return parsed.data;
}
function idempotency(req:Request) {
  const value=req.get('Idempotency-Key');if(!value||!/^[-A-Za-z0-9_]{8,128}$/.test(value))throw new ApiError(400,'Supply an Idempotency-Key of 8–128 letters, digits, underscores or hyphens','IDEMPOTENCY_REQUIRED');return hashToken(value);
}
export function integrationRequestContext(req:any,res:Response,next:()=>void) {
  const supplied=req.get('X-Request-Id');req.apiRequestId=typeof supplied==='string'&&/^[-A-Za-z0-9_]{8,64}$/.test(supplied)?supplied:uid();
  const started=Date.now();res.once('finish',()=>console.info(JSON.stringify({event:'integration.request',requestId:req.apiRequestId,integrationId:req.partner?.id,method:req.method,route:typeof req.route?.path==='string'?req.route.path:'unmatched',status:res.statusCode,elapsedMs:Date.now()-started})));
  res.set('X-Request-Id',req.apiRequestId);res.set('Cache-Control','no-store');next();
}
export function integrationError(error:any,req:any,res:Response) {
  if(res.headersSent)return;
  let status=error instanceof ApiError?error.status:500,code=error instanceof ApiError?error.code:'INTERNAL_ERROR',message=error instanceof ApiError?error.message:'The request could not be completed';
  if(error.name==='MulterError'){status=error.code==='LIMIT_FILE_SIZE'?413:400;code=error.code==='LIMIT_FILE_SIZE'?'FILE_TOO_LARGE':'INVALID_UPLOAD';message=error.code==='LIMIT_FILE_SIZE'?'Maximum file size is 25 MiB':'Upload exactly one document using the file field';}
  if(error.type==='entity.too.large'){status=413;code='PAYLOAD_TOO_LARGE';message='JSON request exceeds 128 KiB';}
  if(error instanceof SyntaxError){status=400;code='INVALID_JSON';message='Malformed JSON request';}
  if(error.status===416){status=416;code='RANGE_NOT_SATISFIABLE';message='Requested byte range is outside this file';}
  if(error.status===404||error.code==='ENOENT'){status=404;code='NOT_FOUND';message='Resource not found';}
  if(status===429&&!res.getHeader('Retry-After'))res.set('Retry-After','60');
  res.removeHeader('Content-Disposition');res.removeHeader('Content-Length');
  res.status(status).type('application/json').json({error:{code,message,request_id:req.apiRequestId||uid(),retryable:status===429||status===503,...(error.details?{details:error.details}:{})}});
}

async function migrate(db:DB) {
  await db.transaction(async tx=>{
    for(const sql of [
      'CREATE TABLE IF NOT EXISTS api_integrations(id TEXT PRIMARY KEY,institution_id TEXT NOT NULL REFERENCES institutions(id),owner_id TEXT NOT NULL REFERENCES users(id),data JSONB NOT NULL)',
      'CREATE TABLE IF NOT EXISTS api_integration_keys(id TEXT PRIMARY KEY,integration_id TEXT NOT NULL REFERENCES api_integrations(id),token_hash TEXT NOT NULL UNIQUE,data JSONB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS api_integration_keys_scope ON api_integration_keys(integration_id)',
      'CREATE TABLE IF NOT EXISTS api_integration_files(id TEXT PRIMARY KEY,integration_id TEXT NOT NULL REFERENCES api_integrations(id),material_id TEXT NOT NULL REFERENCES lesson_materials(id),bytes INTEGER NOT NULL,data JSONB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS api_integration_files_scope ON api_integration_files(integration_id)',
      'CREATE TABLE IF NOT EXISTS api_integration_jobs(id TEXT PRIMARY KEY,integration_id TEXT NOT NULL REFERENCES api_integrations(id),generation_id TEXT NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),data JSONB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS api_integration_jobs_scope ON api_integration_jobs(integration_id,created_at,id)',
      'CREATE TABLE IF NOT EXISTS api_integration_requests(integration_id TEXT NOT NULL REFERENCES api_integrations(id),route TEXT NOT NULL,request_hash TEXT NOT NULL,body_hash TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES api_integration_jobs(id),error JSONB,PRIMARY KEY(integration_id,route,request_hash))',
      'CREATE TABLE IF NOT EXISTS api_integration_attempts(id TEXT PRIMARY KEY,integration_id TEXT NOT NULL REFERENCES api_integrations(id),job_id TEXT NOT NULL REFERENCES api_integration_jobs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
      'CREATE INDEX IF NOT EXISTS api_integration_attempts_scope ON api_integration_attempts(integration_id,created_at)',
      'CREATE TABLE IF NOT EXISTS api_webhook_events(id TEXT PRIMARY KEY,integration_id TEXT NOT NULL REFERENCES api_integrations(id),job_id TEXT NOT NULL REFERENCES api_integration_jobs(id),revision INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,config_version TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_status INTEGER,UNIQUE(job_id,revision,kind))',
      'CREATE INDEX IF NOT EXISTS api_webhook_events_pending ON api_webhook_events(status,next_at)',
    ])await tx.query(sql);
    // A committed reservation must remain discoverable even if the process stopped before authoring began.
    await tx.query(`UPDATE api_integration_jobs SET data=jsonb_set(jsonb_set(jsonb_set(data,'{dispatchStatus}','"failed"'::jsonb),'{operationActive}','false'::jsonb),'{dispatchError}','{"code":"GENERATION_INTERRUPTED","message":"Preparation was interrupted; retry explicitly","retryable":false}'::jsonb) WHERE data->>'operationActive'='true' OR data->>'dispatchStatus'='creating'`);
    await tx.query("UPDATE api_webhook_events SET status='pending',next_at=NOW() WHERE status='sending'");
  });
}

/** Transport injection is constructor-only for isolated tests; no HTTP or environment override exists. */
export interface IntegrationTransport {resolve?:typeof resolveWebhook;deliver?:typeof deliverWebhook;disableTimer?:boolean}
export async function createIntegrationApi(db:DB,ctx:any,transport:IntegrationTransport={}) {
  await migrate(db);const vault=await signingVault(ctx.dataDir),router=express.Router(),windows=new Map<string,{start:number;count:number}>();
  let closed=false,ticking:Promise<void>|undefined;const shutdown=new AbortController(),uploading=new Set<string>();
  const publicIntegration=async(integration:Integration)=>{
    const keys=(await db.query('SELECT data FROM api_integration_keys WHERE integration_id=$1 ORDER BY data->>\'createdAt\' DESC',[integration.id])).rows.map(row=>row.data);
    return {id:integration.id,name:integration.name,active:integration.active,createdAt:integration.createdAt,updatedAt:integration.updatedAt,limits:integration.limits,webhook:{url:integration.webhook.url,configured:integration.webhook.configured,updatedAt:integration.webhook.updatedAt},usage:await usage(integration.id),keys};
  };
  async function usage(id:string) {
    const attempts=(await db.query('SELECT COUNT(*)::int AS n FROM api_integration_attempts WHERE integration_id=$1 AND created_at>=$2',[id,dayStart()])).rows[0].n;
    const counts=(await db.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE g.data->>'status'='ready')::int AS ready,COUNT(*) FILTER(WHERE g.data->>'status'='failed' OR (g.id IS NULL AND j.data->>'dispatchStatus'='failed'))::int AS failed FROM api_integration_jobs j LEFT JOIN generated_lessons g ON g.id=j.generation_id WHERE j.integration_id=$1`,[id])).rows[0];
    return {jobsToday:attempts,totalJobs:counts.total,readyJobs:counts.ready,failedJobs:counts.failed};
  }
  async function principal(integration:Integration):Promise<User> {
    const row=(await db.query('SELECT * FROM users WHERE id=$1 AND institution_id=$2',[integration.ownerId,integration.institutionId])).rows[0];
    if(!row?.data.active||!adminRoles.includes(row.data.role))throw new ApiError(403,'The integration owner is unavailable; contact the administrator','INTEGRATION_OWNER_UNAVAILABLE');
    return {...publicUser(row),role:'TEACHER'};
  }
  const service=()=>{if(!ctx.codexLessons||ctx.generationIsClosing?.()||closed)throw new ApiError(503,'Generation service is temporarily unavailable','GENERATION_UNAVAILABLE');return ctx.codexLessons;};
  async function jobFor(integration:Integration,id:string):Promise<JobRow> {
    const row=(await db.query('SELECT * FROM api_integration_jobs WHERE id=$1 AND integration_id=$2',[id,integration.id])).rows[0];if(!row)throw new ApiError(404,'Generation not found','NOT_FOUND');return row;
  }
  async function jobView(row:JobRow,lesson?:GeneratedLesson) {
    if(!lesson)lesson=(await db.query('SELECT data FROM generated_lessons WHERE id=$1',[row.generation_id])).rows[0]?.data;
    if(lesson)refreshGenerationProgress(lesson);
    const status=lesson?.status==='drafting'?'queued':lesson?.status==='generating'?'processing':lesson?.status|| (row.data.dispatchStatus==='failed'?'failed':'queued');
    const result:any={id:row.id,object:'generation',topic:row.data.input.topic,language:row.data.input.language,video_mode:lesson?.videoMode||row.data.input.video_mode||'3d',status,stage:lesson?.progress?.stage||(status==='failed'?'failed':'queued'),revision:lesson?.revision??0,created_at:row.data.createdAt,updated_at:lesson?.updatedAt||row.data.updatedAt||row.data.createdAt,duration_seconds:600,file_ids:row.data.input.file_ids,external_teacher_id:row.data.input.external_teacher_id??null,metadata:row.data.input.metadata||{},progress:lesson?.progress||{stage:status==='failed'?'failed':'queued',completed:0,total:1}};
    if(status==='ready'&&lesson?.artifact)result.video={url:`/api/v1/generations/${row.id}/video`,mime_type:'video/mp4',duration_seconds:lesson.artifact.duration,width:lesson.artifact.width,height:lesson.artifact.height,fps:lesson.artifact.fps,sha256:lesson.artifact.sha256};
    if(status==='language_review'&&lesson)result.language_review={required:true,chapters:lesson.chapters.map(chapter=>({id:chapter.id,title:chapter.title,transcript:chapter.narration,audio_url:`/api/v1/generations/${row.id}/audio/${chapter.id}`}))};
    if(status==='failed')result.error=row.data.dispatchError||{code:lesson?.errorCode||'GENERATION_FAILED',message:lesson?.error||'The generation did not complete; inspect the job before retrying',retryable:false,...(lesson?.errorStage?{stage:lesson.errorStage}:{})};
    return result;
  }
  async function quota(tx:DB,integration:Integration,excludeId?:string,continuation=false) {
    const current=(await tx.query('SELECT data FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id])).rows[0]?.data as Integration|undefined;
    if(!current?.active)throw new ApiError(403,'Integration is disabled','INTEGRATION_DISABLED');
    const today=(await tx.query('SELECT COUNT(*)::int AS n FROM api_integration_attempts WHERE integration_id=$1 AND created_at>=$2',[integration.id,dayStart()])).rows[0].n;
    if(!continuation&&today>=current.limits.jobsPerDay)throw new ApiError(429,'Daily generation attempt quota has been reached (UTC)','DAILY_QUOTA_EXCEEDED');
    const active=(await tx.query(`SELECT COUNT(*)::int AS n FROM api_integration_jobs j LEFT JOIN generated_lessons g ON g.id=j.generation_id WHERE j.integration_id=$1 AND j.id<>$2 AND (j.data->>'operationActive'='true' OR j.data->>'dispatchStatus'='creating' OR g.data->>'status' IN ('drafting','generating'))`,[integration.id,excludeId||''])).rows[0].n;
    if(active>=current.limits.maxConcurrentJobs)throw new ApiError(429,'Concurrent generation limit has been reached','CONCURRENCY_LIMIT');
  }
  async function existingRequest(tx:DB,integrationId:string,route:string,key:string,bodyHash:string) {
    const row=(await tx.query('SELECT * FROM api_integration_requests WHERE integration_id=$1 AND route=$2 AND request_hash=$3',[integrationId,route,key])).rows[0];
    if(!row)return;
    if(row.body_hash!==bodyHash)throw new ApiError(409,'This Idempotency-Key was already used with a different request','IDEMPOTENCY_CONFLICT');
    if(row.error)throw new ApiError(row.error.status,row.error.message,row.error.code);
    return (await tx.query('SELECT * FROM api_integration_jobs WHERE id=$1 AND integration_id=$2',[row.job_id,integrationId])).rows[0] as JobRow;
  }
  async function saveMapping(row:JobRow,changes:any) {row.data={...row.data,...changes,updatedAt:now()};await db.query('UPDATE api_integration_jobs SET data=$1 WHERE id=$2 AND integration_id=$3',[row.data,row.id,row.integration_id]);}

  router.get('/health',(_req,res)=>res.json({status:'ok',api_version:'v1'}));
  router.get('/openapi.json',(_req,res)=>res.json(integrationOpenApi));
  router.get('/docs',(_req,res)=>res.type('html').send(integrationDocsHtml));
  router.use(rateLimit({windowMs:60000,limit:1200,standardHeaders:'draft-7',legacyHeaders:false,handler:(req,res)=>integrationError(new ApiError(429,'Too many requests from this address','REQUEST_RATE_LIMITED'),req,res)}));
  router.use(async(req:any,res,next)=>{
    const header=req.get('Authorization');if(!header)throw new ApiError(401,'Supply your server API key using Authorization: Bearer','API_KEY_REQUIRED');
    const match=/^Bearer (rm_live_[A-Za-z0-9_-]{43})$/.exec(header);if(!match)throw new ApiError(401,'API key is invalid or revoked','API_KEY_INVALID');
    const row=(await db.query('SELECT k.id AS key_id,k.data AS key_data,i.data AS integration FROM api_integration_keys k JOIN api_integrations i ON i.id=k.integration_id WHERE k.token_hash=$1',[hashToken(match[1])])).rows[0];
    if(!row||row.key_data.revokedAt)throw new ApiError(401,'API key is invalid or revoked','API_KEY_INVALID');
    const integration=row.integration as Integration;if(!integration.active)throw new ApiError(403,'Integration is disabled','INTEGRATION_DISABLED');
    const time=Date.now();let window=windows.get(integration.id);if(!window||time-window.start>=60000){window={start:time,count:0};windows.set(integration.id,window);}window.count++;
    res.set('X-RateLimit-Limit',String(integration.limits.requestsPerMinute));res.set('X-RateLimit-Remaining',String(Math.max(0,integration.limits.requestsPerMinute-window.count)));res.set('X-RateLimit-Reset',String(Math.ceil((window.start+60000)/1000)));
    if(window.count>integration.limits.requestsPerMinute){res.set('Retry-After',String(Math.max(1,Math.ceil((window.start+60000-time)/1000))));throw new ApiError(429,'Request rate limit has been reached','REQUEST_RATE_LIMITED');}
    await principal(integration);req.partner=integration;req.apiKeyId=row.key_id;
    if(!row.key_data.lastUsedAt||Date.parse(row.key_data.lastUsedAt)<time-60000)await db.query("UPDATE api_integration_keys SET data=jsonb_set(data,'{lastUsedAt}',to_jsonb($1::text)) WHERE id=$2",[now(),row.key_id]);
    next();
  });
  router.get('/account',async(req:any,res)=>res.json({integration:{id:req.partner.id,name:req.partner.name},limits:req.partner.limits,usage:await usage(req.partner.id),languages:['ru','kaa','uz'],video_modes:['2d','3d'],default_video_mode:'2d',duration_seconds:600,quota_timezone:'UTC'}));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:maxFileBytes,files:1,fields:0,parts:1}});
  router.post('/files',(req:any,res,next)=>{
    if(uploading.has(req.partner.id)||uploading.size>=2)throw new ApiError(429,'Document processing is busy; retry the upload later','UPLOAD_BUSY');
    uploading.add(req.partner.id);const release=()=>uploading.delete(req.partner.id);res.once('finish',release);res.once('close',release);next();
  },upload.single('file'),async(req:any,res)=>{
    const integration=req.partner as Integration,file=req.file as Express.Multer.File|undefined;if(!file)throw new ApiError(400,'Upload one document using the file field','FILE_REQUIRED');
    const name=path.basename(file.originalname.replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,250),ext=path.extname(name).toLowerCase();
    if(!name||!documentMimes[ext])throw new ApiError(415,'Supported documents: PDF, DOCX, TXT and CSV','UNSUPPORTED_FILE');
    let text:string;try{text=(await extractIntegrationDocument({...file,originalname:name},{signal:shutdown.signal})).trim();}catch(error){if(error instanceof ApiError)throw new ApiError(422,error.message,error.code);throw new ApiError(422,'Document could not be read','INVALID_DOCUMENT');}
    if(!text)throw new ApiError(422,'The document has no extractable text; OCR scans before uploading','NO_EXTRACTABLE_TEXT');
    if(text.length>150000)throw new ApiError(422,'Document text exceeds 150,000 characters; split the document','DOCUMENT_TOO_LARGE');
    const owner=await principal(integration),id='file_'+uid(),materialId=uid(),filename=id+ext,directory=path.join(ctx.dataDir,'integration-files',integration.id),timestamp=now();
    const stored={id,object:'file',name,mime:documentMimes[ext],size:file.size,sha256:createHash('sha256').update(file.buffer).digest('hex'),textAvailable:true,extracted_characters:text.length,created_at:timestamp};
    await mkdir(directory,{recursive:true,mode:0o700});const target=path.join(directory,filename);let written=false;
    try{await db.transaction(async tx=>{
      await tx.query('SELECT id FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id]);const totals=(await tx.query('SELECT COUNT(*)::int AS n,COALESCE(SUM(bytes),0)::bigint AS size FROM api_integration_files WHERE integration_id=$1',[integration.id])).rows[0];
      if(Number(totals.n)>=maxFiles||Number(totals.size)+file.size>maxStorageBytes)throw new ApiError(429,'Integration document storage quota has been reached','STORAGE_QUOTA_EXCEEDED');
      const subjectId=await resolveAuthoringSubject(tx,integration.institutionId),material:LessonMaterialDetail={id:materialId,institutionId:integration.institutionId,teacherId:owner.id,subjectId,title:name,status:'stored',files:[{id,name,mime:documentMimes[ext],size:file.size,url:`/api/v1/files/${id}/content`,extractedCharacters:text.length}],documents:[{fileId:id,text}],extractedCharacters:text.length,createdAt:timestamp,updatedAt:timestamp};
      await writeFile(target,file.buffer,{flag:'wx',mode:0o600});written=true;
      await tx.query('INSERT INTO lesson_materials(id,institution_id,teacher_id,subject_id,data) VALUES($1,$2,$3,$4,$5)',[materialId,integration.institutionId,owner.id,subjectId,material]);
      await tx.query('INSERT INTO api_integration_files(id,integration_id,material_id,bytes,data) VALUES($1,$2,$3,$4,$5)',[id,integration.id,materialId,file.size,{...stored,filename}]);
    });}catch(error){if(written)await unlink(target).catch(()=>{});throw error;}
    res.status(201).json(stored);
  });
  async function fileFor(integration:Integration,id:string) {const row=(await db.query('SELECT * FROM api_integration_files WHERE id=$1 AND integration_id=$2',[id,integration.id])).rows[0];if(!row)throw new ApiError(404,'File not found','NOT_FOUND');return row;}
  router.get('/files/:id',async(req:any,res)=>{const {filename:_,...data}=(await fileFor(req.partner,req.params.id)).data;res.json(data);});
  router.get('/files/:id/content',async(req:any,res,next)=>{const row=await fileFor(req.partner,req.params.id),root=await realpath(path.join(ctx.dataDir,'integration-files',req.partner.id)),file=await realpath(path.join(root,row.data.filename));const info=await lstat(file);if(!file.startsWith(root+path.sep)||!info.isFile())throw new ApiError(404,'File not found','NOT_FOUND');res.type(row.data.mime);res.set('Content-Disposition',`attachment; filename="document${path.extname(row.data.filename)}"`);res.sendFile(file,{acceptRanges:true,cacheControl:false},(error:any)=>{if(error)next(error);});});
  router.post('/generations',async(req:any,res)=>{
    const integration=req.partner as Integration,input=validate(generationSchema,req.body),key=idempotency(req),bodyHash=digest(input),route='POST /generations',owner=await principal(integration);
    const replay=await existingRequest(db,integration.id,route,key,bodyHash);if(replay){res.set('Idempotent-Replayed','true');return res.json(await jobView(replay));}
    service();await service().checkAvailable(owner,integration.institutionId,input.video_mode||'2d');
    const materialIds:string[]=[],documents:any[]=[];let totalBytes=0;
    for(const fileId of [...new Set(input.file_ids)]){const file=await fileFor(integration,fileId),material=(await db.query('SELECT data FROM lesson_materials WHERE id=$1',[file.material_id])).rows[0]?.data;if(!material)throw new ApiError(404,'File not found','NOT_FOUND');materialIds.push(file.material_id);totalBytes+=file.bytes;documents.push({title:material.title,additionalTeachingIdeas:material.documents.map((document:any)=>document.text).filter(Boolean)});}
    if(totalBytes>50*1024*1024)throw new ApiError(422,'Attached documents exceed 50 MiB','SOURCE_TOO_LARGE');if(documents.map(canonicalJson).join('\n').length>180000)throw new ApiError(422,'Combined source text exceeds 180,000 characters','SOURCE_TOO_LARGE');
    const result=await db.transaction(async tx=>{
      await tx.query('SELECT id FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id]);const duplicate=await existingRequest(tx,integration.id,route,key,bodyHash);if(duplicate)return{row:duplicate,created:false};
      await quota(tx,integration);const timestamp=now(),row:JobRow={id:'gen_'+uid(),integration_id:integration.id,generation_id:uid(),created_at:timestamp,data:{input:{...input,video_mode:input.video_mode||'2d'},materialIds,internalRequestKey:`partner_${integration.id}_${key}`,createdAt:timestamp,updatedAt:timestamp,dispatchStatus:'creating',operationActive:true}};
      await tx.query('INSERT INTO api_integration_jobs(id,integration_id,generation_id,data) VALUES($1,$2,$3,$4)',[row.id,integration.id,row.generation_id,row.data]);
      await tx.query('INSERT INTO api_integration_requests(integration_id,route,request_hash,body_hash,job_id) VALUES($1,$2,$3,$4,$5)',[integration.id,route,key,bodyHash,row.id]);
      await tx.query('INSERT INTO api_integration_attempts(id,integration_id,job_id) VALUES($1,$2,$3)',[uid(),integration.id,row.id]);return{row,created:true};
    });
    if(!result.created){res.set('Idempotent-Replayed','true');return res.json(await jobView(result.row));}
    let lesson:GeneratedLesson|undefined;
    try{lesson=(await service().create(owner,{title:input.topic,language:input.language,videoMode:input.video_mode||'2d',materialIds,idempotencyKey:result.row.data.internalRequestKey},{id:result.row.generation_id})).lesson;await saveMapping(result.row,{dispatchStatus:'accepted',operationActive:false});}
    catch{await saveMapping(result.row,{dispatchStatus:'failed',operationActive:false,dispatchError:{code:'GENERATION_START_FAILED',message:'Generation could not be started; retry explicitly',retryable:false}});}
    res.location(`/api/v1/generations/${result.row.id}`).status(202).json(await jobView(result.row,lesson));
  });
  router.get('/generations',async(req:any,res)=>{
    const query=validate(z.object({limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().regex(/^gen_[a-f0-9]{32}$/).optional()}).strict(),req.query),args:any[]=[req.partner.id];let clause='';
    if(query.cursor){const cursor=await jobFor(req.partner,query.cursor);args.push(cursor.created_at,cursor.id);clause=' AND (created_at,id)<($2::timestamptz,$3)';}
    args.push(query.limit+1);const rows=(await db.query(`SELECT * FROM api_integration_jobs WHERE integration_id=$1${clause} ORDER BY created_at DESC,id DESC LIMIT $${args.length}`,args)).rows as JobRow[],hasMore=rows.length>query.limit,selected=rows.slice(0,query.limit);
    res.json({object:'list',data:await Promise.all(selected.map(row=>jobView(row))),has_more:hasMore,next_cursor:hasMore?selected.at(-1)?.id:null});
  });
  router.get('/generations/:id',async(req:any,res)=>res.json(await jobView(await jobFor(req.partner,req.params.id))));
  async function mutate(req:any,res:Response,kind:'retry'|'language-approval') {
    const integration=req.partner as Integration,input=validate(revisionSchema,req.body),key=idempotency(req),route=`POST /generations/${req.params.id}/${kind}`,bodyHash=digest(input),owner=await principal(integration);
    const replay=await existingRequest(db,integration.id,route,key,bodyHash);if(replay){res.set('Idempotent-Replayed','true');return res.json(await jobView(replay));}
    const currentJob=await jobFor(integration,req.params.id);
    await service().checkAvailable(owner,integration.institutionId,currentJob.data.input.video_mode||'3d');
    const result=await db.transaction(async tx=>{
      await tx.query('SELECT id FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id]);const duplicate=await existingRequest(tx,integration.id,route,key,bodyHash);if(duplicate)return{row:duplicate,created:false};
      const row=(await tx.query('SELECT * FROM api_integration_jobs WHERE id=$1 AND integration_id=$2 FOR UPDATE',[req.params.id,integration.id])).rows[0] as JobRow|undefined;if(!row)throw new ApiError(404,'Generation not found','NOT_FOUND');
      if(row.data.operationActive)throw new ApiError(409,'Another operation is already being accepted','OPERATION_IN_PROGRESS');
      const lesson=(await tx.query('SELECT data FROM generated_lessons WHERE id=$1',[row.generation_id])).rows[0]?.data as GeneratedLesson|undefined;
      if((lesson?.revision??0)!==input.revision)throw new ApiError(409,'Read the current job revision before retrying','REVISION_CONFLICT');
      if(kind==='retry'&&(lesson?lesson.status!=='failed':row.data.dispatchStatus!=='failed'))throw new ApiError(409,'Only failed jobs can be retried','GENERATION_NOT_FAILED');
      if(kind==='language-approval'&&(!lesson||lesson.status!=='language_review'))throw new ApiError(409,'This generation is already processing or complete','LANGUAGE_REVIEW_REQUIRED');
      await quota(tx,integration,row.id,kind==='language-approval');row.data={...row.data,operationActive:true};await tx.query('UPDATE api_integration_jobs SET data=$1 WHERE id=$2',[row.data,row.id]);
      await tx.query('INSERT INTO api_integration_requests(integration_id,route,request_hash,body_hash,job_id) VALUES($1,$2,$3,$4,$5)',[integration.id,route,key,bodyHash,row.id]);if(kind==='retry')await tx.query('INSERT INTO api_integration_attempts(id,integration_id,job_id) VALUES($1,$2,$3)',[uid(),integration.id,row.id]);return{row,created:true,exists:!!lesson};
    });
    if(!result.created){res.set('Idempotent-Replayed','true');return res.json(await jobView(result.row));}
    try{
      const lesson:GeneratedLesson=result.exists?await(kind==='retry'?service().retry(owner,result.row.generation_id,input.revision):service().approveLanguage(owner,result.row.generation_id,input.revision)):(await service().create(owner,{title:result.row.data.input.topic,language:result.row.data.input.language,videoMode:result.row.data.input.video_mode||'3d',materialIds:result.row.data.materialIds,idempotencyKey:result.row.data.internalRequestKey},{id:result.row.generation_id})).lesson;
      await saveMapping(result.row,{operationActive:false,dispatchStatus:'accepted',dispatchError:undefined});res.status(202).json(await jobView(result.row,lesson));
    }catch(error){await saveMapping(result.row,{operationActive:false});const safe=error instanceof ApiError?error:new ApiError(503,'Generation service is temporarily unavailable','GENERATION_UNAVAILABLE');await db.query('UPDATE api_integration_requests SET error=$1 WHERE integration_id=$2 AND route=$3 AND request_hash=$4',[{status:safe.status,code:safe.code,message:safe.message},integration.id,route,key]);throw safe;}
  }
  router.post('/generations/:id/retry',(req,res)=>mutate(req,res,'retry'));
  router.post('/generations/:id/language-approval',(req,res)=>mutate(req,res,'language-approval'));
  router.get('/generations/:id/audio/:chapterId',async(req:any,res,next)=>{const row=await jobFor(req.partner,req.params.id),audio=await service().getAudio(await principal(req.partner),row.generation_id,{chapterId:req.params.chapterId});res.type(audio.contentType);res.sendFile(audio.file,{acceptRanges:true,cacheControl:false},(error:any)=>{if(error)next(error);});});
  router.get('/generations/:id/video',async(req:any,res,next)=>{const row=await jobFor(req.partner,req.params.id),video=await service().getVideo(await principal(req.partner),row.generation_id);res.type(video.contentType);res.set('ETag',`"${video.sha256}"`);res.sendFile(video.file,{acceptRanges:true,cacheControl:false},(error:any)=>{if(error)next(error);});});
  router.use((_req,_res,next)=>next(new ApiError(404,'API endpoint not found','NOT_FOUND')));
  router.use((error:any,req:any,res:any,_next:any)=>integrationError(error,req,res));

  function installAdmin(app:Express) {
    const integrationSchema=z.object({institutionId:z.string().max(128).optional(),name:z.string().trim().min(2).max(100),limits:limitsSchema.partial().optional()}).strict();
    const adminFor=async(user:User,id:string)=>{permitted(user,adminRoles);const row=(await db.query('SELECT data FROM api_integrations WHERE id=$1',[id])).rows[0] as Row|undefined;if(!row)throw new ApiError(404,'Интеграция не найдена','NOT_FOUND');tenant(user,row.data.institutionId);return row.data;};
    app.get('/api/integrations',async(req:any,res)=>{permitted(req.user,adminRoles);const institutionId=tenant(req.user,req.query.institutionId);const rows=(await db.query('SELECT data FROM api_integrations WHERE institution_id=$1 ORDER BY data->>\'createdAt\' DESC',[institutionId])).rows as Row[];res.json(await Promise.all(rows.map(row=>publicIntegration(row.data))));});
    app.post('/api/integrations',async(req:any,res)=>{permitted(req.user,adminRoles);const input=validate(integrationSchema,req.body),institutionId=tenant(req.user,input.institutionId),timestamp=now();
      const integration:Integration={id:uid(),institutionId,ownerId:req.user.id,name:input.name,active:true,createdAt:timestamp,updatedAt:timestamp,limits:validate(limitsSchema,{...defaultLimits,...input.limits}),webhook:{url:null,configured:false}};
      await db.query('INSERT INTO api_integrations(id,institution_id,owner_id,data) VALUES($1,$2,$3,$4)',[integration.id,institutionId,req.user.id,integration]);await ctx.audit(req.user,'integration.create',integration.id,institutionId);res.status(201).json(await publicIntegration(integration));
    });
    app.patch('/api/integrations/:id',async(req:any,res)=>{const integration=await adminFor(req.user,req.params.id),input=validate(z.object({name:z.string().trim().min(2).max(100).optional(),active:z.boolean().optional(),limits:limitsSchema.partial().optional()}).strict(),req.body);
      await db.transaction(async tx=>{const current=(await tx.query('SELECT data FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id])).rows[0].data;Object.assign(integration,current,input,{limits:{...current.limits,...input.limits},updatedAt:now()});await tx.query('UPDATE api_integrations SET data=$1 WHERE id=$2',[integration,integration.id]);});await ctx.audit(req.user,'integration.update',integration.id,integration.institutionId);res.json(await publicIntegration(integration));
    });
    app.post('/api/integrations/:id/keys',async(req:any,res)=>{const integration=await adminFor(req.user,req.params.id),input=validate(z.object({name:z.string().trim().min(1).max(100).optional()}).strict(),req.body||{}),raw='rm_live_'+randomBytes(32).toString('base64url'),record={id:uid(),prefix:raw.slice(0,16),name:input.name||'Серверный ключ',createdAt:now()};
      await db.transaction(async tx=>{await tx.query('SELECT id FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id]);const count=(await tx.query("SELECT COUNT(*)::int AS n FROM api_integration_keys WHERE integration_id=$1 AND data->>'revokedAt' IS NULL",[integration.id])).rows[0].n;if(count>=10)throw new ApiError(409,'Допускается не более 10 активных ключей','KEY_LIMIT');await tx.query('INSERT INTO api_integration_keys(id,integration_id,token_hash,data) VALUES($1,$2,$3,$4)',[record.id,integration.id,hashToken(raw),record]);});await ctx.audit(req.user,'integration.key.create',record.id,integration.institutionId);res.status(201).json({integrationId:integration.id,key:raw,record});
    });
    app.delete('/api/integrations/:id/keys/:keyId',async(req:any,res)=>{const integration=await adminFor(req.user,req.params.id);const changed=await db.query("UPDATE api_integration_keys SET data=jsonb_set(data,'{revokedAt}',to_jsonb($1::text)) WHERE id=$2 AND integration_id=$3 RETURNING id",[now(),req.params.keyId,integration.id]);if(!changed.rows.length)throw new ApiError(404,'Ключ не найден','NOT_FOUND');await ctx.audit(req.user,'integration.key.revoke',req.params.keyId,integration.institutionId);res.status(204).end();});
    app.post('/api/integrations/:id/webhook',async(req:any,res)=>{const integration=await adminFor(req.user,req.params.id),input=validate(z.object({url:z.string().min(1).max(2048).nullable()}).strict(),req.body);if(input.url){webhookUrl(input.url);await (transport.resolve||resolveWebhook)(input.url);}
      const secret=input.url?'whsec_'+randomBytes(32).toString('base64url'):undefined,webhook={url:input.url,configured:!!input.url,version:uid(),updatedAt:now()};
      await db.transaction(async tx=>{const current=(await tx.query('SELECT data FROM api_integrations WHERE id=$1 FOR UPDATE',[integration.id])).rows[0].data;Object.assign(integration,current,{webhook,webhookCipher:secret?vault.encrypt(secret):undefined,updatedAt:now()});await tx.query('UPDATE api_integrations SET data=$1 WHERE id=$2',[integration,integration.id]);await tx.query("UPDATE api_webhook_events SET status='cancelled' WHERE integration_id=$1 AND status IN ('pending','sending')",[integration.id]);});await ctx.audit(req.user,'integration.webhook.update',integration.id,integration.institutionId);res.json({webhook:{url:webhook.url,configured:webhook.configured,updatedAt:webhook.updatedAt},...(secret?{signingSecret:secret}:{})});
    });
    app.get('/api/integrations/:id/events',async(req:any,res)=>{const integration=await adminFor(req.user,req.params.id);const rows=(await db.query('SELECT id,job_id,kind,status,attempts,created_at,next_at,last_status FROM api_webhook_events WHERE integration_id=$1 ORDER BY created_at DESC LIMIT 100',[integration.id])).rows;res.json(rows);});
  }

  async function processEvents() {
    const rows=(await db.query(`SELECT j.*,i.data AS integration,g.data AS lesson FROM api_integration_jobs j JOIN api_integrations i ON i.id=j.integration_id LEFT JOIN generated_lessons g ON g.id=j.generation_id WHERE i.data->>'active'='true' AND i.data->'webhook'->>'configured'='true' AND (g.data->>'status' IN ('ready','failed','language_review') OR (g.id IS NULL AND j.data->>'dispatchStatus'='failed')) AND NOT EXISTS(SELECT 1 FROM api_webhook_events e WHERE e.job_id=j.id AND e.revision=COALESCE(g.revision,0) AND e.kind='generation.'||COALESCE(g.data->>'status','failed')) ORDER BY j.created_at LIMIT 200`)).rows;
    for(const row of rows){if(closed)return;const integration=row.integration as Integration,view=await jobView(row,row.lesson),kind=`generation.${view.status}`;if(!terminal.has(view.status)||!integration.webhook.version)continue;const eventId='evt_'+uid(),body=JSON.stringify({id:eventId,type:kind,created_at:now(),data:view});await db.query("INSERT INTO api_webhook_events(id,integration_id,job_id,revision,kind,body,config_version,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(job_id,revision,kind) DO NOTHING",[eventId,integration.id,row.id,view.revision,kind,body,integration.webhook.version]);}
    const pending=(await db.query("SELECT e.*,i.data AS integration FROM api_webhook_events e JOIN api_integrations i ON i.id=e.integration_id WHERE e.status='pending' AND e.next_at<=NOW() ORDER BY e.next_at LIMIT 4")).rows;
    for(const event of pending){if(closed)return;const integration=event.integration as Integration;
      if(!integration.active||!integration.webhook.configured||integration.webhook.version!==event.config_version||!integration.webhookCipher){await db.query("UPDATE api_webhook_events SET status='cancelled' WHERE id=$1",[event.id]);continue;}
      const claimed=await db.query("UPDATE api_webhook_events SET status='sending',attempts=attempts+1 WHERE id=$1 AND status='pending' RETURNING attempts",[event.id]);if(!claimed.rows.length)continue;const attempts=claimed.rows[0].attempts;let status=0;
      try{const deadline=AbortSignal.any([shutdown.signal,AbortSignal.timeout(15000)]);status=await bounded((transport.deliver||deliverWebhook)(integration.webhook.url!,vault.decrypt(integration.webhookCipher),event.id,event.body,deadline),deadline);}catch{}
      if(status>=200&&status<300)await db.query("UPDATE api_webhook_events SET status='delivered',last_status=$1 WHERE id=$2 AND status='sending'",[status,event.id]);
      else if(attempts>=8)await db.query("UPDATE api_webhook_events SET status='failed',last_status=$1 WHERE id=$2 AND status='sending'",[status,event.id]);
      else await db.query("UPDATE api_webhook_events SET status='pending',last_status=$1,next_at=$2 WHERE id=$3 AND status='sending'",[status,new Date(Date.now()+Math.min(21600000,30000*4**(attempts-1))).toISOString(),event.id]);
    }
    if(windows.size>10000){const cutoff=Date.now()-60000;for(const [id,window]of windows)if(window.start<cutoff)windows.delete(id);}
  }
  const tick=()=>{if(closed||ticking)return ticking;ticking=processEvents().catch(()=>{console.error('Integration webhook maintenance failed');}).finally(()=>{ticking=undefined;});return ticking;};
  const timer=transport.disableTimer?undefined:setInterval(()=>void tick(),5000);timer?.unref();
  return {router,installAdmin,async close(){closed=true;if(timer)clearInterval(timer);shutdown.abort();await ticking;},tick};
}
