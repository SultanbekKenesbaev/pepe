import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from './db.js';
import type { LessonSession, LessonState, QuestionAnswer } from '../shared/types.js';
import { uid, now, hashToken, ApiError, teachingRoles } from './security.js';
import { tenant, permitted, entity, entities, sessionFor, visibleSessions, groupIds, redactSession, moduleEnabled } from './access.js';
import { parse } from './validation.js';
import { answerQuestion } from './ai.js';

const revisionSchema=z.number().int().nonnegative();
function revision(s:LessonSession,r:unknown) { if(!Number.isInteger(r))throw new ApiError(400,'Передайте номер revision');if(r!==s.revision)throw new ApiError(409,'Занятие изменилось в другом окне. Обновите состояние.','REVISION_CONFLICT'); }
async function save(db:DB,s:LessonSession) {
  const previous=s.revision;s.revision++;s.updatedAt=now();
  const saved=await db.query('UPDATE lesson_sessions SET data=$1,revision=$2 WHERE id=$3 AND revision=$4 RETURNING id',[s,s.revision,s.id,previous]);
  if(!saved.rows.length)throw new ApiError(409,'Занятие изменилось в другом окне. Обновите состояние.','REVISION_CONFLICT');
}
function ensureState(s:LessonSession,states:LessonState[]) {if(!states.includes(s.state))throw new ApiError(409,'Действие недоступно в текущем состоянии занятия','INVALID_TRANSITION');}
async function mutate(db:DB,req:any,route:string,fn:(tx:DB)=>Promise<any>) {
  permitted(req.user,teachingRoles);
  const key=req.get('Idempotency-Key');if(key&&(key.length<8||key.length>128))throw new ApiError(400,'Idempotency-Key должен содержать 8–128 символов');
  const inputHash=hashToken(JSON.stringify(req.body));
  return db.transaction(async tx=>{
    if(key) {
      const row=(await tx.query('SELECT * FROM idempotency WHERE user_id=$1 AND request_key=$2',[req.user.id,key])).rows[0];
      if(row) {if(row.route!==route||row.data.inputHash!==inputHash)throw new ApiError(409,'Ключ повторного запроса уже использован с другими данными','IDEMPOTENCY_CONFLICT');await sessionFor(tx,req.user,row.data.result.id,true);return row.data.result;}
    }
    const result=await fn(tx);
    if(key)await tx.query('INSERT INTO idempotency(user_id,request_key,route,data) VALUES($1,$2,$3,$4)',[req.user.id,key,route,{inputHash,result}]);
    return result;
  });
}
export function installSessions(app:Express,db:DB,ctx:any) {
  app.get('/api/sessions',async(req:any,res)=>{await recoverInterrupted(db,ctx.staleAnswerMs);const id=tenant(req.user,req.query.institutionId);res.json(await visibleSessions(db,req.user,id));});
  app.get('/api/sessions/:id',async(req:any,res)=>{await sessionFor(db,req.user,req.params.id);await recoverInterrupted(db,ctx.staleAnswerMs);res.json(redactSession(req.user,await sessionFor(db,req.user,req.params.id)));});
  app.post('/api/sessions',async(req:any,res)=>{
    permitted(req.user,teachingRoles);const {lessonId,groupId}=parse<any>(z.object({lessonId:z.string().min(1),groupId:z.string().min(1)}),req.body);const institutionId=tenant(req.user,req.body.institutionId);
    const result=await mutate(db,req,'create-session',async tx=>{
      const lesson=await entity(tx,lessonId,'lessons');const group=await entity(tx,groupId,'groups');
      if(lesson.institutionId!==institutionId||group.institutionId!==institutionId)throw new ApiError(403,'Урок или группа другого учреждения','FORBIDDEN');
      if(!lesson.approved)throw new ApiError(400,'Для запуска утвердите урок');
      if(lesson.groupId&&lesson.groupId!==groupId)throw new ApiError(400,'Урок предназначен для другой группы');
      if(req.user.role==='TEACHER'&&!(await groupIds(tx,req.user,institutionId))?.includes(groupId))throw new ApiError(403,'Группа не назначена преподавателю');
      const existing=(await tx.query("SELECT data FROM lesson_sessions WHERE institution_id=$1 AND teacher_id=$2 AND data->>'lessonId'=$3 AND data->>'groupId'=$4 AND data->>'state'<>'COMPLETED' ORDER BY data->>'createdAt' DESC LIMIT 1",[institutionId,req.user.id,lessonId,groupId])).rows[0];
      if(existing)return existing.data;
      const features={attendance:false,quizzes:false};
      const timestamp=now();const s:LessonSession={id:uid(),institutionId,lessonId,groupId,teacherId:req.user.id,state:'READY',sectionIndex:0,position:0,revision:0,lesson,features,attendance:[],results:[],createdAt:timestamp,updatedAt:timestamp};
      const inserted=await tx.query('INSERT INTO lesson_sessions(id,institution_id,teacher_id,revision,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[s.id,institutionId,s.teacherId,0,s]);
      if(!inserted.rows.length){const concurrent=(await tx.query("SELECT data FROM lesson_sessions WHERE institution_id=$1 AND teacher_id=$2 AND data->>'lessonId'=$3 AND data->>'groupId'=$4 AND data->>'state'<>'COMPLETED' LIMIT 1",[institutionId,req.user.id,lessonId,groupId])).rows[0];if(concurrent)return concurrent.data;throw new ApiError(409,'Занятие уже создаётся. Повторите запрос.','CONFLICT');}
      return s;
    });
    await ctx.audit(req.user,'session.create',result.id,institutionId);res.status(201).json(result);
  });
  app.post('/api/sessions/:id/action',async(req:any,res)=>{
    const input=parse<any>(z.object({action:z.enum(['start','confirmAttendance','pause','resume','next','listen','cancelQuestion','followUpDone','knowledgeCheck','recover','complete','checkpoint']),revision:revisionSchema,position:z.number().int().min(0).max(100000).optional()}),req.body);
    const result=await mutate(db,req,req.path,async tx=>{
      const s=await sessionFor(tx,req.user,req.params.id,true);revision(s,input.revision);
      if(input.position!==undefined){const count=s.lesson.sections[s.sectionIndex].content.split(/\n\s*\n|\n/).map(p=>p.trim()).filter(Boolean).length;if(input.position>=Math.max(1,count))throw new ApiError(400,'Позиция выходит за пределы раздела');s.position=input.position;}
      switch(input.action){
        case 'start':ensureState(s,['READY']);s.state=s.features?.attendance===false?'TEACHING':'CHECKING_ATTENDANCE';s.startedAt=now();break;
        case 'confirmAttendance':{
          if(s.features?.attendance===false)throw new ApiError(403,'Посещаемость отключена для занятия','MODULE_DISABLED');
          ensureState(s,['CHECKING_ATTENDANCE']);const students=(await entities(tx,s.institutionId,'students')).filter(x=>x.groupId===s.groupId);
          if(students.some(student=>!s.attendance.some(a=>a.studentId===student.id)))throw new ApiError(400,'Отметьте посещаемость каждого учащегося');s.state='TEACHING';break;
        }
        case 'pause':ensureState(s,['TEACHING','LISTENING_FOR_QUESTION','CHECKING_FOLLOW_UP','KNOWLEDGE_CHECK']);s.previousState=s.state;s.state='PAUSED_BY_TEACHER';break;
        case 'resume':ensureState(s,['PAUSED_BY_TEACHER']);s.state=s.previousState&&s.previousState!=='PAUSED_BY_TEACHER'?s.previousState:'TEACHING';delete s.previousState;break;
        case 'next':ensureState(s,['TEACHING']);if(s.sectionIndex<s.lesson.sections.length-1){s.sectionIndex++;s.position=0;}else if(s.features?.quizzes===false){s.state='COMPLETED';s.completedAt=now();}else{s.state='KNOWLEDGE_CHECK';}break;
        case 'listen':ensureState(s,['TEACHING','CHECKING_FOLLOW_UP']);s.state='LISTENING_FOR_QUESTION';break;
        case 'cancelQuestion':ensureState(s,['LISTENING_FOR_QUESTION']);s.state='TEACHING';break;
        case 'followUpDone':ensureState(s,['CHECKING_FOLLOW_UP']);s.state='TEACHING';break;
        case 'knowledgeCheck':if(s.features?.quizzes===false)throw new ApiError(403,'Проверка знаний отключена для занятия','MODULE_DISABLED');ensureState(s,['TEACHING']);s.state='KNOWLEDGE_CHECK';break;
        case 'recover':if(s.state==='ANSWERING'&&Date.now()-new Date(s.updatedAt).getTime()>ctx.staleAnswerMs)s.state='RECOVERY';ensureState(s,['RECOVERY']);s.state='TEACHING';delete s.previousState;break;
        case 'complete':ensureState(s,['READY','CHECKING_ATTENDANCE','TEACHING','LISTENING_FOR_QUESTION','KNOWLEDGE_CHECK','PAUSED_BY_TEACHER','CHECKING_FOLLOW_UP','RECOVERY']);s.state='COMPLETED';s.completedAt=now();delete s.previousState;break;
        case 'checkpoint':ensureState(s,['TEACHING','PAUSED_BY_TEACHER','LISTENING_FOR_QUESTION','CHECKING_FOLLOW_UP','KNOWLEDGE_CHECK','RECOVERY']);if(input.position===undefined)throw new ApiError(400,'Передайте позицию');break;
      }
      await save(tx,s);return s;
    });
    if(input.action!=='checkpoint')await ctx.audit(req.user,`session.${input.action}`,result.id,result.institutionId);res.json(result);
  });
  app.put('/api/sessions/:id/attendance',async(req:any,res)=>{
    const input=parse<any>(z.object({attendance:z.array(z.object({studentId:z.string().min(1),status:z.enum(['present','absent','late','excused']),method:z.literal('manual')})).max(1000),revision:revisionSchema.optional()}),req.body);
    const result=await mutate(db,req,req.path,async tx=>{
      const s=await sessionFor(tx,req.user,req.params.id,true);if(input.revision!==undefined)revision(s,input.revision);if(s.features?.attendance===false)throw new ApiError(403,'Посещаемость отключена для занятия','MODULE_DISABLED');ensureState(s,['READY','CHECKING_ATTENDANCE','TEACHING','PAUSED_BY_TEACHER','LISTENING_FOR_QUESTION','CHECKING_FOLLOW_UP','KNOWLEDGE_CHECK','RECOVERY']);
      const students=(await entities(tx,s.institutionId,'students')).filter(x=>x.groupId===s.groupId);
      if(new Set(input.attendance.map((a:any)=>a.studentId)).size!==input.attendance.length)throw new ApiError(400,'Повторяющиеся учащиеся в посещаемости');
      if(input.attendance.some((a:any)=>!students.some(x=>x.id===a.studentId)))throw new ApiError(400,'Посещаемость содержит учащегося другой группы');
      s.attendance=input.attendance.map((a:any)=>({...a,updatedBy:req.user.id,updatedAt:now()}));await save(tx,s);return s;
    });
    await ctx.audit(req.user,'session.attendance',result.id,result.institutionId);res.json(result);
  });
  app.put('/api/sessions/:id/results',async(req:any,res)=>{
    const input=parse<any>(z.object({questionId:z.string().min(1),selectedIndex:z.number().int().nonnegative(),studentId:z.string().min(1).optional(),revision:revisionSchema.optional()}),req.body);
    const result=await mutate(db,req,req.path,async tx=>{
      const s=await sessionFor(tx,req.user,req.params.id,true);if(input.revision!==undefined)revision(s,input.revision);if(s.features?.quizzes===false)throw new ApiError(403,'Проверка знаний отключена для занятия','MODULE_DISABLED');ensureState(s,['KNOWLEDGE_CHECK']);
      const question=s.lesson.quiz.find(q=>q.id===input.questionId);if(!question||input.selectedIndex>=question.options.length)throw new ApiError(400,'Некорректный вопрос или вариант ответа');
      if(input.studentId){const student=await entity(tx,input.studentId,'students');if(student.institutionId!==s.institutionId||student.groupId!==s.groupId)throw new ApiError(400,'Учащийся не входит в группу');}
      const score={questionId:question.id,selectedIndex:input.selectedIndex,correct:question.correctIndex===input.selectedIndex,...(input.studentId?{studentId:input.studentId}:{})};
      const index=s.results.findIndex(r=>r.questionId===question.id&&r.studentId===input.studentId);if(index===-1)s.results.push(score);else s.results[index]=score;
      await save(tx,s);return s;
    });res.json(result);
  });
  app.get('/api/sessions/:id/questions',async(req:any,res)=>{
    const s=await sessionFor(db,req.user,req.params.id);permitted(req.user,['SUPER_ADMIN','ADMIN','DIRECTOR','TEACHER']);
    res.json((await db.query('SELECT data FROM questions WHERE session_id=$1 ORDER BY data->>\'createdAt\'',[s.id])).rows.map(r=>r.data));
  });
  app.post('/api/sessions/:id/questions',async(req:any,res)=>{
    const input=parse<any>(z.object({question:z.string().trim().min(2).max(2000),revision:revisionSchema}),req.body);
    const key=req.get('Idempotency-Key');const inputHash=hashToken(JSON.stringify(req.body));
    // A question reserves the lesson revision before the network request. Another question
    // cannot start until this one finishes, including in another process/tab.
    const reserved=await db.transaction(async tx=>{
      const s=await sessionFor(tx,req.user,req.params.id,true);
      if(key){if(key.length<8||key.length>128)throw new ApiError(400,'Некорректный Idempotency-Key');const cached=(await tx.query('SELECT * FROM idempotency WHERE user_id=$1 AND request_key=$2',[req.user.id,key])).rows[0];if(cached){if(cached.route!==req.path||cached.data.inputHash!==inputHash)throw new ApiError(409,'Ключ повторного запроса уже использован','IDEMPOTENCY_CONFLICT');return {cached:cached.data.result};}}
      revision(s,input.revision);ensureState(s,['TEACHING','LISTENING_FOR_QUESTION','CHECKING_FOLLOW_UP']);s.state='ANSWERING';await save(tx,s);return {session:s};
    });
    if(reserved.cached)return res.json(reserved.cached);
    const session=reserved.session!;let question:QuestionAnswer;let failed=false;
    try { question=await answerQuestion(db,session,input.question,ctx.aiConfig); }
    catch { failed=true;question={id:uid(),sessionId:session.id,question:input.question,answer:'Сервис AI сейчас недоступен. Позиция урока сохранена. Преподаватель может ответить сам или восстановить урок.',status:'failed',mode:'provider',sources:[],createdAt:now()}; }
    const result=await db.transaction(async tx=>{
      const s=await sessionFor(tx,req.user,session.id,true);revision(s,session.revision);ensureState(s,['ANSWERING']);s.state=failed?'RECOVERY':'CHECKING_FOLLOW_UP';await save(tx,s);
      await tx.query('INSERT INTO questions(id,session_id,data) VALUES($1,$2,$3)',[question.id,s.id,question]);const result={session:s,question};
      if(key)await tx.query('INSERT INTO idempotency(user_id,request_key,route,data) VALUES($1,$2,$3,$4)',[req.user.id,key,req.path,{inputHash,result}]);return result;
    });
    await ctx.audit(req.user,failed?'session.question.failed':'session.question',session.id,session.institutionId);res.json(result);
  });
}
export async function recoverInterrupted(db:DB,maxAgeMs=60000) {
  await db.transaction(async tx=>{
    const cutoff=new Date(Date.now()-maxAgeMs).toISOString();
    const sessions=(await tx.query("SELECT data FROM lesson_sessions WHERE data->>'state'='ANSWERING' AND (data->>'updatedAt')::timestamptz < $1::timestamptz",[cutoff])).rows;
    for(const {data:s} of sessions){s.state='RECOVERY';await save(tx,s);}
  });
}
