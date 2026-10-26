import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { openDatabase } from './db.js';
import { seed } from './seed.js';
import { uid, now, ApiError, passwordValid } from './security.js';
import { installAuth } from './auth.js';
import { installCrud } from './crud.js';
import { installSessions, recoverInterrupted } from './sessions.js';
import { installFiles } from './files.js';
import { installUniversity } from './university.js';
import { installLessonMaterials } from './lesson-materials.js';
import { installAttendanceAnalytics } from './attendance-analytics.js';
import { installCinema } from './cinema.js';
import { installPlatform, migratePlatform } from './platform.js';
import { installGeneratedLessons, type LessonGenerationConfig } from './generated-lessons.js';
import { installOperations } from './operations.js';
import { createIntegrationApi, integrationRequestContext, integrationError, type IntegrationTransport } from './integrations.js';
import { migrateUniversity } from './university-migration.js';
import { installReports } from './reports.js';
import { aiStatus, type AIConfig } from './ai.js';
import { tenant, entities, permitted, groupIds } from './access.js';
import type { User } from '../shared/types.js';

export interface AppOptions { dataDir?:string; databaseUrl?:string; seedDemo?:boolean; adminEmail?:string; adminPassword?:string; production?:boolean; trustProxy?:boolean|number; ai?:AIConfig; generation?:LessonGenerationConfig; integrationTransport?:IntegrationTransport }
export async function createApp(options:AppOptions={}) {
  const dataDir=path.resolve(options.dataDir||process.env.DATA_DIR||'data');
  const db=await openDatabase(options.dataDir===':memory:'?':memory:':path.join(dataDir,'postgres'),options.databaseUrl||process.env.DATABASE_URL);
  const demo=options.seedDemo??process.env.SEED_DEMO==='true';
  const adminEmail=options.adminEmail||process.env.ADMIN_EMAIL,adminPassword=options.adminPassword||process.env.ADMIN_PASSWORD;
  if((adminEmail&&!adminPassword)||(!adminEmail&&adminPassword))throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be supplied together');
  if(adminPassword&&!passwordValid(adminPassword))throw new Error('ADMIN_PASSWORD must contain 10–200 characters, at least one letter and one digit');
  await seed(db,demo,adminEmail,adminPassword);
  await migrateUniversity(db,demo);
  await migratePlatform(db);
  await db.query('DELETE FROM auth_sessions WHERE expires_at<NOW()');
  const app=express();app.disable('x-powered-by');
  const production=options.production??process.env.NODE_ENV==='production';
  if(options.trustProxy!==undefined)app.set('trust proxy',options.trustProxy);else if(process.env.TRUST_PROXY)app.set('trust proxy',Number(process.env.TRUST_PROXY));
  app.use(helmet({contentSecurityPolicy:production?{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:','https:'],mediaSrc:["'self'",'blob:','https:'],connectSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}}:false,crossOriginEmbedderPolicy:false}));
  app.use('/api/v1',integrationRequestContext,express.json({limit:'128kb'}));
  app.use(express.json({limit:'8mb'}));app.use(cookieParser());
  app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/api/health',(_req,res)=>res.json({status:'ok'}));
  app.get('/api/config',(_req,res)=>res.json({demoEnabled:demo}));
  const aiConfig:AIConfig=options.ai||{apiKey:process.env.AI_API_KEY,model:process.env.AI_MODEL,baseUrl:process.env.AI_BASE_URL,timeoutMs:Number(process.env.AI_TIMEOUT_MS)||25000,transcriptionModel:process.env.AI_TRANSCRIPTION_MODEL||process.env.AI_TRANSCRIBE_MODEL};
  aiConfig.timeoutMs=Math.min(120000,Math.max(500,aiConfig.timeoutMs||25000));
  const staleAnswerMs=Math.max(60000,aiConfig.timeoutMs+30000);
  await recoverInterrupted(db,staleAnswerMs);
  const ctx:any={db,production,dataDir,uploadDir:path.join(dataDir,'uploads'),aiConfig,staleAnswerMs};
  ctx.aiStatus=(id:string)=>aiStatus(db,id,aiConfig);
  ctx.institutions=async(user:User)=>(await db.query(user.role==='SUPER_ADMIN'?'SELECT data FROM institutions ORDER BY data->>\'name\'':'SELECT data FROM institutions WHERE id=$1',user.role==='SUPER_ADMIN'?[]:[user.institutionId])).rows.map(r=>r.data);
  ctx.expandUser=async(user:User)=>{
    if(user.role==='TEACHER'&&user.institutionId){return {...user,groupIds:await groupIds(db,user,user.institutionId)||[]};}
    return user;
  };
  ctx.bootstrap=async(user:User,csrfToken:string)=>({user:await ctx.expandUser(user),institutions:await ctx.institutions(user),ai:await aiStatus(db,user.institutionId||'',aiConfig),csrfToken});
  ctx.audit=async(user:User,action:string,targetId?:string,institutionId?:string|null)=>{
    const id=uid();const data={id,institutionId:institutionId===undefined?user.institutionId:institutionId,actorId:user.id,actorName:user.name,action,targetId,createdAt:now()};
    await db.query('INSERT INTO audit(id,institution_id,actor_id,data) VALUES($1,$2,$3,$4)',[id,data.institutionId,user.id,data]);
  };
  ctx.auditEntries=async(user:User,institutionId:string)=>{
    const params:any[]=[];const clauses:string[]=[];
    if(institutionId){params.push(institutionId);clauses.push('institution_id=$'+params.length);}
    else if(user.role!=='SUPER_ADMIN'){params.push(user.institutionId);clauses.push('institution_id=$'+params.length);}
    if(user.role==='TEACHER'){params.push(user.id);clauses.push('actor_id=$'+params.length);}
    return (await db.query('SELECT data FROM audit'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+" ORDER BY data->>'createdAt' DESC LIMIT 200",params)).rows.map(r=>r.data);
  };
  const integrations=await createIntegrationApi(db,ctx,options.integrationTransport);
  // This router authenticates with organization Bearer keys and always terminates /api/v1 requests.
  // It must run before session/CSRF middleware; no cookie-authentication bypass is added elsewhere.
  app.use('/api/v1',integrations.router);
  installAuth(app,db,ctx);
  app.use('/api',rateLimit({windowMs:60*1000,limit:600,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Слишком много запросов. Повторите через минуту.',code:'RATE_LIMITED'}}));
  app.get('/api/ai/status',async(req:any,res)=>{const id=tenant(req.user,req.query.institutionId);res.json(await aiStatus(db,id,aiConfig));});
  app.use('/api/sessions',(req,res,next)=>{if(!['GET','HEAD'].includes(req.method))return res.status(410).json({error:'Предыдущий формат уроков и оценивания больше не используется',code:'FEATURE_REMOVED'});next();});
  app.use('/api/data/assignments',(req,res,next)=>{if(!['GET','HEAD'].includes(req.method))return res.status(410).json({error:'Модуль заданий больше не используется',code:'FEATURE_REMOVED'});next();});
  installCinema(app,db,ctx);installUniversity(app,db,ctx);installLessonMaterials(app,db,ctx);installGeneratedLessons(app,db,ctx,options.generation);integrations.installAdmin(app);installPlatform(app,db,ctx);installOperations(app);installAttendanceAnalytics(app,db);installCrud(app,db,ctx);installSessions(app,db,ctx);installFiles(app,db,ctx);installReports(app,db,ctx);
  app.use('/api',(_req,res)=>res.status(404).json({error:'API endpoint не найден',code:'NOT_FOUND'}));
  // Express 5 forwards rejected async handlers to this error boundary.
  app.use((error:any,_req:any,res:any,_next:any)=>{
    if(res.headersSent)return;
    if(_req.path==='/api/v1'||_req.path.startsWith('/api/v1/'))return integrationError(error,_req,res);
    if(error instanceof ApiError)return res.status(error.status).json({error:error.message,code:error.code});
    if(error.name==='MulterError')return res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'Размер файла превышает 25 МБ':'Не удалось загрузить файл',code:error.code});
    if(error.type==='entity.too.large')return res.status(413).json({error:'Слишком большой запрос',code:'PAYLOAD_TOO_LARGE'});
    if(error instanceof SyntaxError)return res.status(400).json({error:'Некорректный JSON',code:'INVALID_JSON'});
    console.error('API request failed:',error.name||'Error',error.code||'INTERNAL_ERROR');
    res.status(500).json({error:'Внутренняя ошибка сервера',code:'INTERNAL_ERROR'});
  });
  app.locals.integrationTick=integrations.tick;
  app.locals.db=db;app.locals.close=async()=>{await integrations.close();await ctx.finishGeneratedJobs?.();await db.close();};app.locals.dataDir=dataDir;
  await ctx.codexLessons.resumeWaitingLanguageLessons();
  return app;
}
