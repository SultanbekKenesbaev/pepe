import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from './db.js';
import type { GeneratedLesson, Lesson, LessonCatalogItem, ScheduleItem, User } from '../shared/types.js';
import { entity, entities, institutionExists, permitted, tenant, visibleEntities } from './access.js';
import { ApiError, now, uid } from './security.js';
import { parse } from './validation.js';
import { localDate, timeAt } from './university.js';

const id=z.string().min(1).max(128);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Некорректная дата');
const clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const fields={lessonId:id,groupId:id,teacherId:id,allDay:z.boolean(),startTime:clock.optional(),durationMinutes:z.number().int().min(1).max(720).optional(),roomId:z.preprocess(value=>value===''||value===null?undefined:value,id.optional()),subjectId:id.optional()};
const createSchema=z.object({...fields,from:day,to:day,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).optional()});
const updateSchema=z.object({...fields,date:day,revision:z.number().int().nonnegative()}).partial().extend({revision:z.number().int().nonnegative()});

export async function migratePlatform(db:DB) {
  await db.query('CREATE TABLE IF NOT EXISTS generated_lessons(id TEXT PRIMARY KEY,institution_id TEXT NOT NULL REFERENCES institutions(id),teacher_id TEXT NOT NULL REFERENCES users(id),material_id TEXT NOT NULL UNIQUE REFERENCES lesson_materials(id),revision INTEGER NOT NULL,data JSONB NOT NULL)');
  await db.query('CREATE INDEX IF NOT EXISTS generated_lessons_scope ON generated_lessons(institution_id,teacher_id)');
  await db.query('ALTER TABLE generated_lessons ALTER COLUMN material_id DROP NOT NULL');
  await db.query('ALTER TABLE generated_lessons DROP CONSTRAINT IF EXISTS generated_lessons_material_id_key');
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS generated_lessons_legacy_material ON generated_lessons(material_id) WHERE material_id IS NOT NULL AND COALESCE(data->>'engine','legacy')<>'codex'");
  await db.query('ALTER TABLE generated_lessons ADD COLUMN IF NOT EXISTS request_key TEXT');
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS generated_lessons_request_key ON generated_lessons(institution_id,teacher_id,request_key) WHERE request_key IS NOT NULL');
  // An interrupted external request cannot safely resume without a person reviewing/retrying it.
  await db.query(`UPDATE generated_lessons SET revision=revision+1,data=data||jsonb_build_object(
    'status','failed','error','Подготовка прервана перезапуском сервера. Повторите попытку.',
    'errorCode','GENERATION_INTERRUPTED','errorStage',COALESCE(data->'progress'->>'phase',data->'progress'->>'stage','planning'),
    'progress',(COALESCE(data->'progress','{"completed":0,"total":0}'::jsonb)-'estimatedRemainingSeconds')||'{"stage":"failed"}'::jsonb,
    'revision',revision+1,'updatedAt',$1::text) WHERE data->>'status' IN ('drafting','generating')`,[now()]);
}

/** A neutral subject prevents optional-source uploads from being silently assigned to an unrelated course. */
export async function resolveAuthoringSubject(db:DB,institutionId:string,subjectId?:string):Promise<string> {
  if(subjectId){const subject=await entity(db,subjectId,'subjects');if(subject.institutionId!==institutionId)throw new ApiError(403,'Предмет другого университета','FORBIDDEN');return subject.id;}
  await db.query('SELECT id FROM institutions WHERE id=$1 FOR UPDATE',[institutionId]);
  const existing=(await entities(db,institutionId,'subjects')).find(subject=>subject.name==='Авторские уроки');if(existing)return existing.id;
  const timestamp=now(),subject={id:uid(),institutionId,name:'Авторские уроки',description:'Учебные фильмы по темам преподавателя.',createdAt:timestamp,updatedAt:timestamp};
  await db.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4)',[subject.id,institutionId,'subjects',subject]);return subject.id;
}

export async function lessonCatalog(db:DB,user:User,institutionId:string):Promise<LessonCatalogItem[]> {
  const lessons=await visibleEntities(db,user,institutionId,'lessons') as Lesson[];
  const generated=(await db.query('SELECT data FROM generated_lessons WHERE institution_id=$1',[institutionId])).rows.map(row=>row.data as GeneratedLesson).filter(item=>item.status==='ready'||user.role==='ADMIN'||item.teacherId===user.id);
  const result:LessonCatalogItem[]=lessons.filter(lesson=>lesson.cinemaId&&!lesson.cinemaId.startsWith('generated:')).map(lesson=>({id:lesson.id,lessonId:lesson.id,title:lesson.name,subjectId:lesson.subjectId,durationMinutes:lesson.cinemaId==='derivative'?11:lesson.duration,status:lesson.approved?'ready':'draft',cinemaId:lesson.cinemaId,description:lesson.description,updatedAt:lesson.updatedAt}));
  if(!result.some(item=>item.cinemaId==='derivative')){
    const subjects=await entities(db,institutionId,'subjects');
    result.unshift({id:'builtin:derivative',title:'Производная: 3D-урок',subjectId:subjects.find(subject=>/математическ.*анализ/i.test(subject.name))?.id||subjects[0]?.id||'',durationMinutes:11,status:'ready',cinemaId:'derivative',description:'Скорость, касательная и производная в пространстве.'});
  }
  for(const item of generated)result.push({id:`generated:${item.id}`,lessonId:item.lessonId,title:item.title,subjectId:item.subjectId,durationMinutes:Math.max(1,Math.ceil(item.duration/60)),status:item.status,cinemaId:item.status==='ready'?`generated:${item.id}`:undefined,description:item.summary,materialId:item.materialId,teacherId:item.teacherId,updatedAt:item.updatedAt,createdAt:item.createdAt,language:item.language,videoMode:item.videoMode||'3d'});
  return result.sort((a,b)=>Number(b.status==='ready')-Number(a.status==='ready')||a.title.localeCompare(b.title,'ru'));
}

async function zoneFor(db:DB,institutionId:string):Promise<string> {
  const inst=(await db.query('SELECT data FROM institutions WHERE id=$1',[institutionId])).rows[0]?.data;
  if(!inst)throw new ApiError(404,'Университет не найден','NOT_FOUND');
  return inst.settings?.timezone||'Asia/Tashkent';
}
async function resolveLesson(db:DB,institutionId:string,lessonId:string,subjectId?:string):Promise<Lesson> {
  if(lessonId==='builtin:derivative'){
    const existing=(await entities(db,institutionId,'lessons')).find(lesson=>lesson.cinemaId==='derivative');if(existing)return existing;
    const subjects=await entities(db,institutionId,'subjects');
    const selected=subjectId||subjects.find(subject=>/математическ.*анализ/i.test(subject.name))?.id||subjects[0]?.id;
    if(!selected)throw new ApiError(400,'Сначала добавьте предмет для 3D-урока','SUBJECT_REQUIRED');
    const subject=await entity(db,selected,'subjects');if(subject.institutionId!==institutionId)throw new ApiError(403,'Предмет другого университета','FORBIDDEN');
    const timestamp=now(),lesson:Lesson={id:uid(),institutionId,name:'Производная: 3D-урок',subjectId:selected,duration:11,language:'ru',approved:true,cinemaId:'derivative',sections:[{id:'definition',title:'Производная',content:'Производная показывает мгновенную скорость изменения функции. В уроке разобраны движение, касательная и правила дифференцирования.',materialIds:[]}],quiz:[],createdAt:timestamp,updatedAt:timestamp};
    await db.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4)',[lesson.id,institutionId,'lessons',lesson]);return lesson;
  }
  if(lessonId.startsWith('generated:')){
    const generated=(await db.query('SELECT data FROM generated_lessons WHERE id=$1',[lessonId.slice(10)])).rows[0]?.data as GeneratedLesson|undefined;
    if(!generated)throw new ApiError(404,'3D-урок не найден','NOT_FOUND');tenant({role:'ADMIN',institutionId} as User,generated.institutionId);
    if(generated.status!=='ready'||!generated.lessonId)throw new ApiError(409,'3D-урок ещё не готов','LESSON_NOT_READY');
    lessonId=generated.lessonId;
  }
  const lesson=await entity(db,lessonId,'lessons') as Lesson;
  if(lesson.institutionId!==institutionId)throw new ApiError(403,'Урок другого университета','FORBIDDEN');
  if(!lesson.approved)throw new ApiError(409,'Урок ещё не утверждён','LESSON_NOT_READY');
  return lesson;
}
async function checkReferences(db:DB,institutionId:string,input:any) {
  const group=await entity(db,input.groupId,'groups');if(group.institutionId!==institutionId)throw new ApiError(403,'Группа другого университета','FORBIDDEN');
  const teacher=(await db.query('SELECT institution_id,data FROM users WHERE id=$1',[input.teacherId])).rows[0];
  if(!teacher||teacher.institution_id!==institutionId||teacher.data.role!=='TEACHER'||!teacher.data.active)throw new ApiError(400,'Выберите активного преподавателя университета');
  if(input.roomId){const room=await entity(db,input.roomId,'rooms');if(room.institutionId!==institutionId)throw new ApiError(403,'Аудитория другого университета','FORBIDDEN');}
}
function publicSchedule(item:ScheduleItem,zone:string):ScheduleItem {
  const date=localDate(new Date(item.startsAt),zone);
  const startTime=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(item.startsAt));
  return {...item,date,startTime,revision:item.revision||0};
}
function sameSlot(a:ScheduleItem,b:ScheduleItem,zone:string):boolean {
  return a.lessonId===b.lessonId&&a.groupId===b.groupId&&a.teacherId===b.teacherId&&!!a.allDay===!!b.allDay&&(a.allDay?localDate(new Date(a.startsAt),zone)===localDate(new Date(b.startsAt),zone):Date.parse(a.startsAt)===Date.parse(b.startsAt))&&(!a.durationMinutes||!b.durationMinutes||a.durationMinutes===b.durationMinutes)&&(a.roomId||'')===(b.roomId||'');
}
function validateTime(input:any,lesson:Lesson) {
  if(input.allDay&&!lesson.cinemaId)throw new ApiError(400,'Доступ 24 часа доступен для готовых 3D-уроков','INVALID_VIEWING_SCHEDULE');
  if(!input.allDay&&!input.startTime)throw new ApiError(400,'Укажите время начала');
  const duration=input.durationMinutes||lesson.duration;
  if(!input.allDay&&Number(input.startTime.slice(0,2))*60+Number(input.startTime.slice(3))+duration>1440)throw new ApiError(400,'Занятие должно закончиться в тот же день');
}
async function checkOverlap(db:DB,institutionId:string,item:ScheduleItem,excludingId?:string) {
  if(item.allDay)return;
  const start=Date.parse(item.startsAt),end=start+(item.durationMinutes||90)*60000;
  const lessons=await entities(db,institutionId,'lessons');
  for(const other of await entities(db,institutionId,'schedule')){
    if(other.id===excludingId||other.cancelled||other.allDay)continue;
    if(other.groupId!==item.groupId&&other.teacherId!==item.teacherId&&(!item.roomId||other.roomId!==item.roomId))continue;
    const otherStart=Date.parse(other.startsAt),duration=other.durationMinutes||lessons.find(lesson=>lesson.id===other.lessonId)?.duration||90;
    if(start<otherStart+duration*60000&&end>otherStart)throw new ApiError(409,'В это время уже заняты группа, преподаватель или аудитория','SCHEDULE_CONFLICT');
  }
}
export function installPlatform(app:Express,db:DB,ctx:any) {
  app.get('/api/lesson-catalog',async(req:any,res)=>{permitted(req.user,['ADMIN','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId);res.json(await lessonCatalog(db,req.user,institutionId));});
  app.get('/api/schedule/events',async(req:any,res)=>{
    permitted(req.user,['ADMIN','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId),zone=await zoneFor(db,institutionId);
    const from=req.query.from?parse<string>(day,req.query.from):undefined,to=req.query.to?parse<string>(day,req.query.to):undefined;
    if(from&&to&&to<from)throw new ApiError(400,'Дата окончания раньше начала');
    const items=await visibleEntities(db,req.user,institutionId,'schedule');
    res.json(items.filter(item=>(req.user.role==='ADMIN'||item.teacherId===req.user.id)&&(req.query.includeCancelled==='true'||!item.cancelled)).map(item=>publicSchedule(item,zone)).filter(item=>(!from||item.date!>=from)&&(!to||item.date!<=to)).sort((a,b)=>a.startsAt.localeCompare(b.startsAt)));
  });
  app.post('/api/schedule/events',async(req:any,res)=>{
    permitted(req.user,['ADMIN']);const institutionId=tenant(req.user,req.body.institutionId);await institutionExists(db,institutionId);
    const input=parse<z.infer<typeof createSchema>>(createSchema,req.body),zone=await zoneFor(db,institutionId);
    if(input.to<input.from||(Date.parse(input.to)-Date.parse(input.from))/86400000>365)throw new ApiError(400,'Выберите период до 366 дней');
    const result=await db.transaction(async tx=>{
      await tx.query('SELECT id FROM institutions WHERE id=$1 FOR UPDATE',[institutionId]);
      await checkReferences(tx,institutionId,input);const lesson=await resolveLesson(tx,institutionId,input.lessonId,input.subjectId);validateTime(input,lesson);
      const created:ScheduleItem[]=[],skipped:ScheduleItem[]=[],existing=(await entities(tx,institutionId,'schedule')).filter(item=>!item.cancelled);
      for(let millis=Date.parse(input.from);millis<=Date.parse(input.to);millis+=86400000){
        const date=new Date(millis).toISOString().slice(0,10),weekday=new Date(`${date}T12:00:00Z`).getUTCDay()||7;if(input.weekdays&&!input.weekdays.includes(weekday))continue;
        const timestamp=now(),item:ScheduleItem={id:uid(),institutionId,name:lesson.name,lessonId:lesson.id,groupId:input.groupId,teacherId:input.teacherId,startsAt:timeAt(date,input.allDay?'00:00':input.startTime!,zone),allDay:input.allDay,...(!input.allDay?{durationMinutes:input.durationMinutes||lesson.duration}:{}),...(input.roomId?{roomId:input.roomId}:{}),revision:0,createdAt:timestamp,updatedAt:timestamp};
        const duplicate=existing.find(other=>sameSlot(other,item,zone));if(duplicate){skipped.push(publicSchedule(duplicate,zone));continue;}
        await checkOverlap(tx,institutionId,item);await tx.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4)',[item.id,institutionId,'schedule',item]);existing.push(item);created.push(publicSchedule(item,zone));
      }
      if(!created.length&&!skipped.length)throw new ApiError(400,'В выбранном периоде нет отмеченных дней');return {created,skipped};
    });
    await ctx.audit(req.user,'schedule.range.create',result.created.map(item=>item.id).join(',').slice(0,1000),institutionId);res.status(result.created.length?201:200).json(result);
  });
  app.patch('/api/schedule/events/:id',async(req:any,res)=>{
    permitted(req.user,['ADMIN']);const input=parse<z.infer<typeof updateSchema>>(updateSchema,req.body);
    const result=await db.transaction(async tx=>{
      const row=(await tx.query("SELECT data FROM entities WHERE id=$1 AND kind='schedule' FOR UPDATE",[req.params.id])).rows[0];if(!row)throw new ApiError(404,'Занятие не найдено','NOT_FOUND');
      const original=row.data as ScheduleItem,institutionId=tenant(req.user,original.institutionId),zone=await zoneFor(tx,institutionId);await tx.query('SELECT id FROM institutions WHERE id=$1 FOR UPDATE',[institutionId]);
      if(original.cancelled)throw new ApiError(409,'Занятие отменено','CANCELLED');if((original.revision||0)!==input.revision)throw new ApiError(409,'Расписание изменилось. Обновите страницу.','REVISION_CONFLICT');
      const current=publicSchedule(original,zone),merged={...current,...input};await checkReferences(tx,institutionId,merged);const lesson=await resolveLesson(tx,institutionId,merged.lessonId,merged.subjectId);validateTime(merged,lesson);
      const item:ScheduleItem={...original,lessonId:lesson.id,name:lesson.name,groupId:merged.groupId,teacherId:merged.teacherId,allDay:merged.allDay,startsAt:timeAt(merged.date!,merged.allDay?'00:00':merged.startTime!,zone),revision:(original.revision||0)+1,updatedAt:now()};
      if(input.roomId!==undefined)item.roomId=input.roomId;else if(req.body.roomId===''||req.body.roomId===null)delete item.roomId;
      if(!item.allDay)item.durationMinutes=merged.durationMinutes||lesson.duration;else delete item.durationMinutes;
      const sessions=(await tx.query("SELECT data FROM teaching_sessions WHERE institution_id=$1 AND data->>'state'<>'completed'",[institutionId])).rows;
      if(sessions.some(row=>row.data.eventId.startsWith(`schedule:${item.id}:`)))throw new ApiError(409,'Сначала завершите действующую пару','ACTIVE_SESSION');
      if((await entities(tx,institutionId,'schedule')).some(other=>other.id!==item.id&&!other.cancelled&&sameSlot(other,item,zone)))throw new ApiError(409,'Такое занятие уже есть в расписании','DUPLICATE');
      await checkOverlap(tx,institutionId,item,item.id);await tx.query('UPDATE entities SET data=$1 WHERE id=$2',[item,item.id]);return publicSchedule(item,zone);
    });await ctx.audit(req.user,'schedule.update',result.id,result.institutionId);res.json(result);
  });
  app.delete('/api/schedule/events/:id',async(req:any,res)=>{
    permitted(req.user,['ADMIN']);const revision=parse<number>(z.coerce.number().int().nonnegative(),req.query.revision??req.body?.revision);
    const result=await db.transaction(async tx=>{
      const row=(await tx.query("SELECT data FROM entities WHERE id=$1 AND kind='schedule' FOR UPDATE",[req.params.id])).rows[0];if(!row)throw new ApiError(404,'Занятие не найдено','NOT_FOUND');
      const item=row.data as ScheduleItem;tenant(req.user,item.institutionId);if(item.cancelled)return item;
      if((item.revision||0)!==revision)throw new ApiError(409,'Расписание изменилось. Обновите страницу.','REVISION_CONFLICT');
      const sessions=(await tx.query("SELECT data FROM teaching_sessions WHERE institution_id=$1 AND data->>'state'<>'completed'",[item.institutionId])).rows;
      if(sessions.some(row=>row.data.eventId.startsWith(`schedule:${item.id}:`)))throw new ApiError(409,'Сначала завершите действующую пару','ACTIVE_SESSION');
      Object.assign(item,{cancelled:true,cancelledAt:now(),cancelledBy:req.user.id,updatedAt:now(),revision:revision+1});await tx.query('UPDATE entities SET data=$1 WHERE id=$2',[item,item.id]);return item;
    });await ctx.audit(req.user,'schedule.cancel',result.id,result.institutionId);res.json(result);
  });
}
