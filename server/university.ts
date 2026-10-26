import type { Express } from 'express';
import multer from 'multer';
import { z } from 'zod';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { parse as parseCSV } from 'csv-parse/sync';
import type { DB } from './db.js';
import type { User, Semester, SemesterTopic, WeeklySlot, TeachingEvent, TeachingSession, UniversityAttendance, FaceEnrollment, AttendanceScan } from '../shared/types.js';
import { uid, now, ApiError } from './security.js';
import { tenant, permitted, entities, entity, groupIds, visibleEntities } from './access.js';
import { parse } from './validation.js';
import { extractDocumentText as extract } from './document-text.js';

const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const dateSchema=z.string().regex(datePattern).refine(s=>!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,'Некорректная дата');
const idSchema=z.string().min(1).max(128);
const slotSchema=z.object({weekday:z.number().int().min(1).max(7),startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),durationMinutes:z.number().int().min(15).max(360),roomId:z.preprocess(v=>v===''?undefined:v,idSchema.optional())});
const topicSchema=z.object({id:idSchema,title:z.string().trim().min(1).max(1000),content:z.string().max(100000),order:z.number().int().nonnegative(),documentName:z.string().max(300).optional()});
const semesterSchema=z.object({name:z.string().trim().min(1).max(500),subjectId:idSchema,groupIds:z.array(idSchema).min(1).max(100),startDate:dateSchema,endDate:dateSchema,topics:z.array(topicSchema).max(500),schedule:z.array(slotSchema).max(30),status:z.enum(['draft','ready']),timezone:z.string().max(100).optional()});
const statuses=z.enum(['present','late','unconfirmed','absent','excused']);
const defaultZone='Asia/Tashkent';
export function localDate(date=new Date(),timezone=defaultZone):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;return `${part('year')}-${part('month')}-${part('day')}`;
}
export function timeAt(date:string,time:string,timezone=defaultZone):string {
  const target=Date.parse(`${date}T${time}:00Z`);let result=target;
  for(let i=0;i<3;i++){
    const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(result));
    const part=(type:string)=>parts.find(p=>p.type===type)!.value;
    const shown=Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);result+=target-shown;
  }
  return new Date(result).toISOString();
}
async function institution(db:DB,id:string):Promise<any>{const data=(await db.query('SELECT data FROM institutions WHERE id=$1',[id])).rows[0]?.data;if(!data)throw new ApiError(404,'Университет не найден');return data;}
function timezoneValid(value:string) {try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}
async function checkGroups(db:DB,user:User,institutionId:string,ids:string[]) {
  const visible=await groupIds(db,user,institutionId);
  for(const id of ids){const group=await entity(db,id,'groups');if(group.institutionId!==institutionId)throw new ApiError(403,'Группа другого университета','FORBIDDEN');if(visible&&!visible.includes(id))throw new ApiError(403,'Группа не назначена преподавателю','FORBIDDEN');}
}
async function semesterFor(db:DB,user:User,id:string):Promise<Semester> {
  const row=(await db.query('SELECT data,archived FROM semesters WHERE id=$1',[id])).rows[0];if(!row||row.archived)throw new ApiError(404,'Семестр не найден','NOT_FOUND');
  tenant(user,row.data.institutionId);if(user.role==='TEACHER'&&row.data.teacherId!==user.id)throw new ApiError(403,'Семестр другого преподавателя','FORBIDDEN');await checkGroups(db,user,row.data.institutionId,row.data.groupIds);return row.data;
}
async function validateSemester(db:DB,user:User,s:Semester) {
  tenant(user,s.institutionId);await checkGroups(db,user,s.institutionId,s.groupIds);
  const subject=await entity(db,s.subjectId,'subjects');if(subject.institutionId!==s.institutionId)throw new ApiError(403,'Предмет другого университета','FORBIDDEN');
  s.schedule.sort((a,b)=>a.weekday-b.weekday||a.startTime.localeCompare(b.startTime));
  if(new Set(s.schedule.map(slot=>`${slot.weekday}:${slot.startTime}`)).size!==s.schedule.length)throw new ApiError(400,'Повторяющееся время в расписании');
  if(s.endDate<s.startDate)throw new ApiError(400,'Дата окончания раньше начала');
  if((Date.parse(s.endDate)-Date.parse(s.startDate))/86400000>730)throw new ApiError(400,'Семестр не может длиться более двух лет');
  if(new Set(s.topics.map(t=>t.id)).size!==s.topics.length)throw new ApiError(400,'Идентификаторы тем должны быть уникальны');
  if(s.timezone&&!timezoneValid(s.timezone))throw new ApiError(400,'Неизвестный часовой пояс');
  for(const slot of s.schedule){if(slot.roomId){const room=await entity(db,slot.roomId,'rooms');if(room.institutionId!==s.institutionId)throw new ApiError(403,'Аудитория другого университета','FORBIDDEN');}const minutes=Number(slot.startTime.slice(0,2))*60+Number(slot.startTime.slice(3));if(minutes+slot.durationMinutes>1440)throw new ApiError(400,'Пара должна закончиться в тот же день');}
  if(s.status==='ready'&&(!s.topics.length||!s.schedule.length))throw new ApiError(400,'Для подтверждения нужны темы и хотя бы одно время в расписании','REVIEW_REQUIRED');
}
function daysBetween(start:string,end:string){return Math.floor((Date.parse(end)-Date.parse(start))/86400000);}
function isoWeekday(date:string){return new Date(`${date}T12:00:00Z`).getUTCDay()||7;}
function topicIndexFor(s:Semester,date:string,slotIndex:number):number {
  let index=0;for(let day=0;day<=daysBetween(s.startDate,date);day++){const current=new Date(Date.parse(s.startDate)+day*86400000).toISOString().slice(0,10);const weekday=isoWeekday(current);for(let i=0;i<s.schedule.length;i++)if(s.schedule[i].weekday===weekday){if(current===date&&i===slotIndex)return index;index++;}}
  return index;
}
async function eventsFor(db:DB,user:User,institutionId:string,date:string):Promise<TeachingEvent[]> {
  const inst=await institution(db,institutionId);const zone=inst.settings?.timezone||defaultZone;
  const rows=(await db.query('SELECT data FROM semesters WHERE institution_id=$1 AND archived=FALSE',[institutionId])).rows;
  const ownGroups=await groupIds(db,user,institutionId);const events:TeachingEvent[]=[];
  const rooms=await entities(db,institutionId,'rooms');
  for(const {data:s} of rows as {data:Semester}[]){
    if(s.status!=='ready'||date<s.startDate||date>s.endDate||user.role==='TEACHER'&&s.teacherId!==user.id)continue;
    for(let i=0;i<s.schedule.length;i++){const slot=s.schedule[i];if(slot.weekday!==isoWeekday(date))continue;const topic=s.topics.slice().sort((a,b)=>a.order-b.order)[topicIndexFor(s,date,i)];if(!topic)continue;
      for(const groupId of s.groupIds){if(ownGroups&&!ownGroups.includes(groupId))continue;const startsAt=timeAt(date,slot.startTime,s.timezone||zone);events.push({id:`semester:${s.id}:${groupId}:${date}:${i}`,institutionId,semesterId:s.id,subjectId:s.subjectId,groupId,teacherId:s.teacherId,roomId:slot.roomId,room:rooms.find(r=>r.id===slot.roomId)?.name,date,startsAt,endsAt:new Date(Date.parse(startsAt)+slot.durationMinutes*60000).toISOString(),topic,semesterName:s.name});}
    }
  }
  const schedule=await visibleEntities(db,user,institutionId,'schedule');
  for(const entry of schedule){
    if(entry.cancelled)continue;
    if(user.role==='TEACHER'&&entry.teacherId!==user.id)continue;
    if(localDate(new Date(entry.startsAt),zone)!==date)continue;
    const lesson=await entity(db,entry.lessonId,'lessons');
    const topic={id:lesson.id,title:lesson.name,content:lesson.sections.map((s:any)=>`${s.title}\n${s.content}`).join('\n\n'),order:0};
    const allDay=entry.allDay===true&&!!lesson.cinemaId;
    const startsAt=allDay?timeAt(date,'00:00',zone):entry.startsAt;
    const nextDate=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
    const endsAt=allDay?timeAt(nextDate,'00:00',zone):new Date(Date.parse(startsAt)+(entry.durationMinutes||lesson.duration)*60000).toISOString();
    events.push({id:`schedule:${entry.id}:${date}`,institutionId,lessonId:lesson.id,subjectId:lesson.subjectId,groupId:entry.groupId,teacherId:entry.teacherId,roomId:entry.roomId,room:entry.room,date,startsAt,endsAt,topic,scheduleItemId:entry.id,scheduleRevision:entry.revision||0,...(allDay?{allDay:true}:{}),...(lesson.cinemaId?{cinemaId:lesson.cinemaId}:{})});
  }
  return events.sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||a.groupId.localeCompare(b.groupId));
}
async function sessionFor(db:DB,user:User,id:string):Promise<TeachingSession> {
  const s=(await db.query('SELECT data FROM teaching_sessions WHERE id=$1',[id])).rows[0]?.data as TeachingSession;if(!s)throw new ApiError(404,'Пара не найдена','NOT_FOUND');tenant(user,s.institutionId);
  if(user.role==='TEACHER'&&s.teacherId!==user.id)throw new ApiError(403,'Пара другого преподавателя','FORBIDDEN');
  // Completed sessions belong to their original teacher even after a group transfer.
  if(s.state!=='completed')await checkGroups(db,user,s.institutionId,[s.groupId]);return s;
}
function checkRevision(s:TeachingSession,value:unknown){if(!Number.isInteger(value))throw new ApiError(400,'Передайте revision');if(s.revision!==value)throw new ApiError(409,'Данные изменились. Обновите пару.','REVISION_CONFLICT');}
async function saveSession(db:DB,s:TeachingSession){const old=s.revision;s.revision++;const result=await db.query('UPDATE teaching_sessions SET data=$1,revision=$2 WHERE id=$3 AND revision=$4 RETURNING id',[s,s.revision,s.id,old]);if(!result.rows.length)throw new ApiError(409,'Данные изменились. Обновите пару.','REVISION_CONFLICT');}
function activeSeconds(s:TeachingSession,at=Date.now()){const paused=s.pausedAt?Math.max(0,at-Date.parse(s.pausedAt)):0;return Math.max(0,(at-Date.parse(s.startedAt)-s.pausedMs-paused)/1000);}
function scanOffsets(duration:number){const end=Math.max(240,duration);return [120,...[.25,.5,.75,.95].map(f=>Math.round(120+(end-120)*f))];}

const dayNames:[number,RegExp][]=[[1,/\bmon(?:day)?\b|понедельник|(?:^|\s)пн(?:[\s,.]|$)/i],[2,/\btue(?:sday)?\b|вторник|(?:^|\s)вт(?:[\s,.]|$)/i],[3,/\bwed(?:nesday)?\b|сред[ау]|(?:^|\s)ср(?:[\s,.]|$)/i],[4,/\bthu(?:rsday)?\b|четверг|(?:^|\s)чт(?:[\s,.]|$)/i],[5,/\bfri(?:day)?\b|пятниц[ау]|(?:^|\s)пт(?:[\s,.]|$)/i],[6,/\bsat(?:urday)?\b|суббот[ау]|(?:^|\s)сб(?:[\s,.]|$)/i],[7,/\bsun(?:day)?\b|воскресенье|(?:^|\s)вс(?:[\s,.]|$)/i]];
function extractSchedule(text:string):WeeklySlot[]{const slots:WeeklySlot[]=[];for(const line of text.split('\n')){const day=dayNames.find(([,regex])=>regex.test(line));const times=[...line.matchAll(/(?:^|\D)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/g)];if(!day||!times.length)continue;const start=Number(times[0][1])*60+Number(times[0][2]);const end=times[1]?Number(times[1][1])*60+Number(times[1][2]):start+90;const duration=end-start;if(duration<15||duration>360||end>1440)continue;const slot={weekday:day[0],startTime:`${times[0][1].padStart(2,'0')}:${times[0][2]}`,durationMinutes:duration};if(!slots.some(s=>s.weekday===slot.weekday&&s.startTime===slot.startTime))slots.push(slot);}return slots.slice(0,30);}
function extractTopics(text:string,name:string):SemesterTopic[]{
  const chunks=text.replace(/\r/g,'').split(/\n\s*\n|\n(?=(?:Тема|Лекция|Topic|Chapter|\d+[.)])\s)/i).map(s=>s.trim()).filter(s=>s.length>3).flatMap(chunk=>chunk.length>90000?chunk.match(/[\s\S]{1,90000}/g)||[]:[chunk]);
  const topics:SemesterTopic[]=[];for(const chunk of chunks){if(dayNames.some(([,r])=>r.test(chunk))&&/^.{0,50}\d{1,2}[:.]\d{2}/.test(chunk)&&chunk.length<140)continue;const lines=chunk.split('\n').map(s=>s.trim()).filter(Boolean);const first=lines[0].replace(/^#+\s*/, '');const title=first.length<=200?first:((topics.length===0?path.parse(name).name:`${path.parse(name).name} — часть ${topics.length+1}`));topics.push({id:uid(),title:title.slice(0,1000),content:chunk.slice(0,100000),order:topics.length,documentName:name});}return topics;
}
function csvTopics(text:string,name:string):{topics:SemesterTopic[];schedule:WeeklySlot[]} {
  const first=text.split('\n')[0];const delimiter=first.split(';').length>first.split(',').length?';':',';
  let rows:Record<string,string>[];try{rows=parseCSV(text,{columns:true,bom:true,skip_empty_lines:true,trim:true,delimiter,max_record_size:100000});}catch{throw new ApiError(400,'Некорректная таблица семестра CSV');}
  if(!rows.length)throw new ApiError(400,'Таблица семестра не содержит строк');
  const topics:SemesterTopic[]=[];const schedule:WeeklySlot[]=[];
  for(const row of rows){const normalized:Record<string,string>={};for(const [key,value]of Object.entries(row))normalized[key.toLowerCase().replace(/[ _-]/g,'')]=String(value||'').trim();
    const title=normalized.title||normalized.topic||normalized['тема']||normalized['название']||Object.values(row)[0];
    const content=normalized.content||normalized.text||normalized.description||normalized['содержание']||normalized['описание']||Object.values(row).filter(Boolean).join('\n');
    if(title&&content)topics.push({id:uid(),title:String(title).slice(0,1000),content:String(content),order:topics.length,documentName:name});
    const day=normalized.weekday||normalized.day||normalized['деньнедели']||normalized['день'];const time=normalized.starttime||normalized.time||normalized['начало']||normalized['время'];
    if(day&&time){const weekday=/^[1-7]$/.test(day)?Number(day):dayNames.find(([,regex])=>regex.test(day))?.[0];const duration=Number(normalized.durationminutes||normalized.duration||normalized['длительность']||90);if(weekday&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time)&&Number.isInteger(duration)&&duration>=15&&duration<=360&&!schedule.some(s=>s.weekday===weekday&&s.startTime===time))schedule.push({weekday,startTime:time,durationMinutes:duration});}
  }
  return {topics,schedule};
}
function jsonArray(value:unknown){if(Array.isArray(value))return value;try{return JSON.parse(String(value));}catch{throw new ApiError(400,'groupIds должен быть JSON-массивом');}}

export function installUniversity(app:Express,db:DB,ctx:any){
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:12,fields:12,fieldSize:100000}});
  app.get('/api/university',async(req:any,res)=>{
    permitted(req.user,['ADMIN','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId);const inst=await institution(db,institutionId);const date=parse<string>(dateSchema,req.query.date||localDate(new Date(),inst.settings?.timezone||defaultZone));
    const groups=await visibleEntities(db,req.user,institutionId,'groups');const students=await visibleEntities(db,req.user,institutionId,'students');const semesters=(await db.query('SELECT data FROM semesters WHERE institution_id=$1 AND archived=FALSE ORDER BY data->>\'createdAt\' DESC',[institutionId])).rows.map(r=>r.data).filter(s=>req.user.role==='ADMIN'||s.teacherId===req.user.id&&s.groupIds.every((id:string)=>groups.some(g=>g.id===id)));
    const sessions=(await db.query('SELECT data FROM teaching_sessions WHERE institution_id=$1 ORDER BY data->>\'startedAt\' DESC',[institutionId])).rows.map(r=>r.data).filter(s=>(req.user.role==='ADMIN'||s.teacherId===req.user.id&&(s.state==='completed'||groups.some(g=>g.id===s.groupId)))&&s.event.date===date);
    const teachers=(await db.query("SELECT data FROM users WHERE institution_id=$1 AND data->>'role' IN ('ADMIN','TEACHER') AND (data->>'active')::boolean=TRUE",[institutionId])).rows.map(r=>({id:r.data.id,name:r.data.name,role:r.data.role,email:req.user.role==='ADMIN'?r.data.email:'',institutionId,active:true}));
    res.json({date,semesters,events:await eventsFor(db,req.user,institutionId,date),sessions,groups,students,subjects:await entities(db,institutionId,'subjects'),rooms:await entities(db,institutionId,'rooms'),teachers});
  });
  app.post('/api/semesters/import',upload.array('files',12),async(req:any,res)=>{
    permitted(req.user,['ADMIN','TEACHER']);const institutionId=tenant(req.user,req.body.institutionId);const inst=await institution(db,institutionId);const input=parse<any>(semesterSchema,{name:req.body.name,subjectId:req.body.subjectId,groupIds:jsonArray(req.body.groupIds),startDate:req.body.startDate,endDate:req.body.endDate,topics:[],schedule:[],status:'draft',timezone:req.body.timezone||inst.settings?.timezone||defaultZone});
    const files=(req.files||[]) as Express.Multer.File[];if(!files.length)throw new ApiError(400,'Загрузите хотя бы один документ');if(files.reduce((sum,f)=>sum+f.size,0)>50*1024*1024)throw new ApiError(400,'Общий размер документов превышает 50 МБ');
    const s:Semester={...input,id:uid(),institutionId,teacherId:req.user.id,files:[],createdAt:now(),updatedAt:now()};await validateSemester(db,req.user,s);
    const texts: {file:Express.Multer.File;text:string}[]=[];
    for(const file of files){let text:string;try{text=(await extract(file)).trim();}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,`Не удалось прочитать ${file.originalname.slice(0,150)}. Для скана нужен OCR или текстовая версия.`,'EXTRACTION_FAILED');}if(!text)throw new ApiError(400,`В ${file.originalname.slice(0,150)} не найден текст. Загрузите текстовый PDF, DOCX или TXT.`,'NO_EXTRACTABLE_TEXT');if(text.length>200000)throw new ApiError(400,'Документ содержит более 200 000 символов. Разделите файл.');texts.push({file,text});}
    const parsed=texts.map(({file,text})=>path.extname(file.originalname).toLowerCase()==='.csv'?csvTopics(text,file.originalname):{topics:extractTopics(text,file.originalname),schedule:extractSchedule(text)});
    const topics=parsed.flatMap(p=>p.topics);if(topics.length>500)throw new ApiError(400,'Более 500 тем. Разделите материалы на несколько семестров.');s.topics=topics.map((topic,i)=>({...topic,order:i}));s.schedule=parsed.flatMap(p=>p.schedule).filter((slot,index,all)=>all.findIndex(s=>s.weekday===slot.weekday&&s.startTime===slot.startTime)===index);await validateSemester(db,req.user,s);
    await mkdir(ctx.uploadDir,{recursive:true});const written:string[]=[];
    try{
      await db.transaction(async tx=>{
        for(const {file,text} of texts){const id=uid();const ext=path.extname(file.originalname).toLowerCase();const filename=id+ext;await writeFile(path.join(ctx.uploadDir,filename),file.buffer,{flag:'wx',mode:0o600});written.push(filename);const mime=ext==='.pdf'?'application/pdf':ext==='.docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':ext==='.csv'?'text/csv':'text/plain';await tx.query('INSERT INTO files(id,institution_id,owner_id,name,mime,size,path) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,institutionId,req.user.id,file.originalname.slice(0,250),mime,file.size,filename]);s.files.push({id,name:file.originalname.slice(0,250),mime,extractedCharacters:text.length});}
        await tx.query('INSERT INTO semesters(id,institution_id,teacher_id,data) VALUES($1,$2,$3,$4)',[s.id,institutionId,s.teacherId,s]);
      });
    }catch(error){for(const filename of written)await unlink(path.join(ctx.uploadDir,filename)).catch(()=>{});throw error;}
    await ctx.audit(req.user,'semester.import',s.id,institutionId);res.status(201).json(s);
  });
  app.get('/api/semesters/:id',async(req:any,res)=>res.json(await semesterFor(db,req.user,req.params.id)));
  app.patch('/api/semesters/:id',async(req:any,res)=>{
    const original=await semesterFor(db,req.user,req.params.id);const fields=parse<any>(semesterSchema,{...original,...req.body});const s={...original,...fields,updatedAt:now()};await validateSemester(db,req.user,s);await db.query('UPDATE semesters SET data=$1 WHERE id=$2',[s,s.id]);await ctx.audit(req.user,'semester.update',s.id,s.institutionId);res.json(s);
  });
  app.delete('/api/semesters/:id',async(req:any,res)=>{
    const s=await semesterFor(db,req.user,req.params.id);const used=(await db.query("SELECT id FROM teaching_sessions WHERE data->'event'->>'semesterId'=$1 LIMIT 1",[s.id])).rows.length>0;
    if(used)await db.query('UPDATE semesters SET archived=TRUE WHERE id=$1',[s.id]);else await db.query('DELETE FROM semesters WHERE id=$1',[s.id]);await ctx.audit(req.user,used?'semester.archive':'semester.delete',s.id,s.institutionId);res.json({ok:true,archived:used});
  });
  app.post('/api/teaching-sessions',async(req:any,res)=>{
    const input=parse<any>(z.object({eventId:z.string().min(1).max(500),date:dateSchema}),req.body);const institutionId=tenant(req.user,req.body.institutionId);const event=(await eventsFor(db,req.user,institutionId,input.date)).find(e=>e.id===input.eventId);if(!event)throw new ApiError(404,'Пара не найдена в расписании на эту дату');
    if(event.allDay)throw new ApiError(409,'Это просмотр 3D-урока без запуска пары и посещаемости','VIEWING_ONLY');
    const session=await db.transaction(async tx=>{
      const existing=(await tx.query("SELECT data FROM teaching_sessions WHERE institution_id=$1 AND event_id=$2 AND data->>'state'<>'completed'",[institutionId,event.id])).rows[0];if(existing)return existing.data;
      const roster=(await entities(tx,institutionId,'students')).filter(student=>student.groupId===event.groupId);const s:TeachingSession={id:uid(),institutionId,eventId:event.id,event,teacherId:event.teacherId,groupId:event.groupId,state:'live',startedAt:now(),pausedMs:0,scanOffsets:scanOffsets((Date.parse(event.endsAt)-Date.parse(event.startsAt))/1000),scans:[],roster:roster.map(student=>({studentId:student.id,name:student.name})),attendance:roster.map(student=>({studentId:student.id,status:'unconfirmed',method:'camera'})),revision:0};
      const inserted=await tx.query('INSERT INTO teaching_sessions(id,institution_id,event_id,teacher_id,revision,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[s.id,institutionId,event.id,s.teacherId,0,s]);if(!inserted.rows.length)return (await tx.query("SELECT data FROM teaching_sessions WHERE institution_id=$1 AND event_id=$2 AND data->>'state'<>'completed'",[institutionId,event.id])).rows[0].data;return s;
    });await ctx.audit(req.user,'teaching.start',session.id,institutionId);res.status(201).json(session);
  });
  app.get('/api/teaching-sessions/:id',async(req:any,res)=>res.json(await sessionFor(db,req.user,req.params.id)));
  app.post('/api/teaching-sessions/:id/action',async(req:any,res)=>{
    const input=parse<any>(z.object({action:z.enum(['pause','resume','complete']),revision:z.number().int().nonnegative()}),req.body);
    const s=await db.transaction(async tx=>{const s=await sessionFor(tx,req.user,req.params.id);checkRevision(s,input.revision);if(input.action==='pause'){if(s.state!=='live')throw new ApiError(409,'Пара не идёт');s.state='paused';s.pausedAt=now();}if(input.action==='resume'){if(s.state!=='paused')throw new ApiError(409,'Пара не на паузе');s.pausedMs+=Math.max(0,Date.now()-Date.parse(s.pausedAt!));delete s.pausedAt;s.state='live';}if(input.action==='complete'){if(s.state==='completed')throw new ApiError(409,'Пара уже завершена');if(s.pausedAt)s.pausedMs+=Math.max(0,Date.now()-Date.parse(s.pausedAt));delete s.pausedAt;s.state='completed';s.completedAt=now();}await saveSession(tx,s);return s;});await ctx.audit(req.user,`teaching.${input.action}`,s.id,s.institutionId);res.json(s);
  });
  app.put('/api/teaching-sessions/:id/attendance',async(req:any,res)=>{
    const input=parse<any>(z.object({revision:z.number().int().nonnegative(),attendance:z.array(z.object({studentId:idSchema,status:statuses})).max(1000)}),req.body);
    const s=await db.transaction(async tx=>{const s=await sessionFor(tx,req.user,req.params.id);checkRevision(s,input.revision);if(new Set(input.attendance.map((a:any)=>a.studentId)).size!==input.attendance.length)throw new ApiError(400,'Повторяющиеся учащиеся');for(const a of input.attendance){const index=s.attendance.findIndex(entry=>entry.studentId===a.studentId);if(index<0)throw new ApiError(400,'Студент не входит в группу пары');s.attendance[index]={...s.attendance[index],status:a.status,method:'manual',reviewed:a.status!=='unconfirmed',updatedBy:req.user.id,updatedAt:now()};}await saveSession(tx,s);return s;});await ctx.audit(req.user,'teaching.attendance.review',s.id,s.institutionId);res.json(s);
  });
  app.post('/api/teaching-sessions/:id/scans',async(req:any,res)=>{
    const input=parse<any>(z.object({revision:z.number().int().nonnegative(),capturedAt:z.string().datetime({offset:true}),detectedFaces:z.number().int().min(0).max(1000),matches:z.array(z.object({studentId:idSchema,similarity:z.number().finite().min(.65).max(1)})).max(1000),unknownFaces:z.number().int().min(0).max(1000),status:z.enum(['completed','failed']),error:z.string().max(2000).optional()}),req.body);
    const s=await db.transaction(async tx=>{
      const s=await sessionFor(tx,req.user,req.params.id);checkRevision(s,input.revision);if(s.state!=='live')throw new ApiError(409,'Камера доступна только во время пары');const captured=Date.parse(input.capturedAt);if(captured<Date.parse(s.startedAt)||captured>Date.now()+60000||Date.now()-captured>15*60000)throw new ApiError(400,'Время снимка выходит за допустимые пределы');
      if(s.scans.some(scan=>scan.capturedAt===input.capturedAt))throw new ApiError(409,'Этот снимок уже обработан','DUPLICATE_SCAN');if(s.scans.length>=20)throw new ApiError(400,'Превышен предел попыток проверки');if(activeSeconds(s,captured)<115)throw new ApiError(409,'Первая проверка доступна через две минуты от начала пары','SCAN_NOT_DUE');
      if(input.status==='failed'&&input.matches.length)throw new ApiError(400,'Неуспешная проверка не может подтверждать студентов');if(new Set(input.matches.map((m:any)=>m.studentId)).size!==input.matches.length)throw new ApiError(400,'Повторяющиеся совпадения');if(input.matches.length+input.unknownFaces!==input.detectedFaces)throw new ApiError(400,'Количество лиц не соответствует результатам распознавания');
      for(const match of input.matches){const attendance=s.attendance.find(a=>a.studentId===match.studentId);if(!attendance)throw new ApiError(400,'Совпадение относится к студенту другой группы');const enrolled=(await tx.query('SELECT student_id FROM face_enrollments WHERE student_id=$1 AND institution_id=$2',[match.studentId,s.institutionId])).rows.length;if(!enrolled)throw new ApiError(400,'Для студента не зарегистрирован эталон лица');if(input.status==='completed'){
        const first=attendance.firstSeenAt&&attendance.firstSeenAt<input.capturedAt?attendance.firstSeenAt:input.capturedAt;attendance.firstSeenAt=first;attendance.lastSeenAt=!attendance.lastSeenAt||attendance.lastSeenAt<input.capturedAt?input.capturedAt:attendance.lastSeenAt;attendance.similarity=Math.max(attendance.similarity||0,match.similarity);
        if(!attendance.reviewed){attendance.status=Date.parse(first)-Date.parse(s.startedAt)>15*60000?'late':'present';attendance.method='camera';attendance.updatedAt=now();}
      }}
      const scan:AttendanceScan={id:uid(),sessionId:s.id,capturedAt:input.capturedAt,detectedFaces:input.detectedFaces,matches:input.matches,unknownFaces:input.unknownFaces,status:input.status,...(input.error?{error:input.error}:{})};s.scans.push(scan);await saveSession(tx,s);return s;
    });await ctx.audit(req.user,'teaching.camera.scan',s.id,s.institutionId);res.json(s);
  });
  app.get('/api/face-enrollments',async(req:any,res)=>{
    const institutionId=tenant(req.user,req.query.institutionId);const groups=await groupIds(db,req.user,institutionId);const requested=typeof req.query.groupId==='string'?req.query.groupId:undefined;if(requested)await checkGroups(db,req.user,institutionId,[requested]);
    const students=await entities(db,institutionId,'students');const allowed=students.filter(s=>(!requested||s.groupId===requested)&&(!groups||groups.includes(s.groupId))).map(s=>s.id);const rows=(await db.query('SELECT data FROM face_enrollments WHERE institution_id=$1',[institutionId])).rows.map(r=>r.data);res.json(rows.filter(row=>allowed.includes(row.studentId)));
  });
  app.post('/api/face-enrollments/:studentId',async(req:any,res)=>{
    permitted(req.user,['ADMIN']);const input=parse<any>(z.object({descriptor:z.array(z.number().finite().min(-100).max(100)).min(128).max(1024),modelVersion:z.string().regex(/^(human[-/: _]|face-api[-/: _])[\w ./:_-]{1,90}$/i),photoFileId:idSchema.optional()}),req.body);if(!([128,1024].includes(input.descriptor.length))||input.descriptor.length===1024&&!/^human/i.test(input.modelVersion)||input.descriptor.length===128&&!/^face-api/i.test(input.modelVersion)||input.descriptor.every((n:number)=>Math.abs(n)<1e-12))throw new ApiError(400,'Неподдерживаемая модель или размер вектора');
    const student=await entity(db,req.params.studentId,'students');tenant(req.user,student.institutionId);
    if(input.photoFileId){const file=(await db.query('SELECT * FROM files WHERE id=$1',[input.photoFileId])).rows[0];if(!file||file.institution_id!==student.institutionId||!file.mime.startsWith('image/'))throw new ApiError(400,'Эталонное фото не найдено в университете');}
    const enrollment:FaceEnrollment={studentId:student.id,...input,enrolledAt:now()};await db.query('INSERT INTO face_enrollments(student_id,institution_id,data) VALUES($1,$2,$3) ON CONFLICT(student_id) DO UPDATE SET data=EXCLUDED.data',[student.id,student.institutionId,enrollment]);await ctx.audit(req.user,'face.enroll',student.id,student.institutionId);res.json(enrollment);
  });
  app.delete('/api/face-enrollments/:studentId',async(req:any,res)=>{permitted(req.user,['ADMIN']);const student=await entity(db,req.params.studentId,'students');tenant(req.user,student.institutionId);await db.query('DELETE FROM face_enrollments WHERE student_id=$1',[student.id]);await ctx.audit(req.user,'face.delete',student.id,student.institutionId);res.json({ok:true});});
  app.post('/api/students/import',upload.single('file'),async(req:any,res)=>{
    permitted(req.user,['ADMIN']);const institutionId=tenant(req.user,req.body.institutionId);const groupId=parse<string>(idSchema,req.body.groupId);await checkGroups(db,req.user,institutionId,[groupId]);if(!req.file||path.extname(req.file.originalname).toLowerCase()!=='.csv')throw new ApiError(400,'Загрузите CSV-файл');
    let rows:any[];try{const first=req.file.buffer.toString('utf8').split('\n')[0];const delimiter=first.split(';').length>first.split(',').length?';':',';rows=parseCSV(req.file.buffer,{columns:true,bom:true,skip_empty_lines:true,trim:true,delimiter,max_record_size:10000});}catch{throw new ApiError(400,'Некорректный CSV');}if(!rows.length||rows.length>5000)throw new ApiError(400,'CSV должен содержать от 1 до 5000 студентов');
    const students=rows.map((row,index)=>{const data:Record<string,string>={};for(const [key,value] of Object.entries(row))data[key.trim().toLowerCase()]=String(value).trim();const name=data.name||data['фио']||data['имя студента']||[data.lastname||data['фамилия'],data.firstname||data['имя'],data.middlename||data['отчество']].filter(Boolean).join(' ');if(!name||name.length>500||/[\x00-\x08]/.test(name))throw new ApiError(400,`Строка ${index+2}: укажите имя студента`);return {id:uid(),institutionId,groupId,name,createdAt:now(),updatedAt:now()};});
    await db.transaction(async tx=>{for(const student of students)await tx.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4)',[student.id,institutionId,'students',student]);});await ctx.audit(req.user,'students.import',groupId,institutionId);res.status(201).json({created:students.length,students});
  });
}
