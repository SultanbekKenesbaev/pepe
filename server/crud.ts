import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from './db.js';
import { uid, now, publicUser, passwordHash, passwordValid, ApiError, adminRoles } from './security.js';
import { schemas, institutionSchema, userSchema, parse } from './validation.js';
import { tenant, permitted, entities, entity, visibleEntities, canWriteEntity, institutionExists, groupIds, moduleEnabled } from './access.js';

async function checkReferences(db:DB,kind:string,data:any) {
  const refs: [string, string|undefined][]=[];
  if(data.programId)refs.push(['programs',data.programId]);
  if(data.roomId)refs.push(['rooms',data.roomId]);
  if(kind==='programs'){for(const subjectId of data.subjectIds)refs.push(['subjects',subjectId]);for(const groupId of data.groupIds)refs.push(['groups',groupId]);}
  if(data.groupId)refs.push(['groups',data.groupId]);
  if(data.subjectId)refs.push(['subjects',data.subjectId]);
  if(data.departmentId)refs.push(['departments',data.departmentId]);
  if(data.parentId)refs.push(['departments',data.parentId]);
  if(data.lessonId)refs.push(['lessons',data.lessonId]);
  if(kind==='lessons') for(const section of data.sections)for(const materialId of section.materialIds)refs.push(['materials',materialId]);
  for(const [refKind,id] of refs) { const ref=await entity(db,id!,refKind); if(ref.institutionId!==data.institutionId)throw new ApiError(403,'Связанная запись принадлежит другому учреждению','FORBIDDEN'); if(id===data.id)throw new ApiError(400,'Запись не может ссылаться сама на себя'); }
  if(kind==='schedule'&&data.allDay&&!(await entity(db,data.lessonId,'lessons')).cinemaId)throw new ApiError(400,'Просмотр в течение дня доступен только для 3D-урока','INVALID_VIEWING_SCHEDULE');
  if(kind==='lessons'&&data.cinemaId?.startsWith('generated:')){const generated=(await db.query('SELECT data FROM generated_lessons WHERE id=$1',[data.cinemaId.slice(10)])).rows[0]?.data;if(!generated||generated.institutionId!==data.institutionId||generated.status!=='ready')throw new ApiError(400,'3D-урок не найден или ещё не готов','LESSON_NOT_READY');}
  if(kind==='lessons'&&!data.cinemaId&&(await entities(db,data.institutionId,'schedule')).some(item=>item.lessonId===data.id&&item.allDay))throw new ApiError(409,'Урок используется в расписании просмотра на весь день','REFERENCE_EXISTS');
  if(kind==='lessons'&&data.programId){const program=await entity(db,data.programId,'programs');if(program.subjectIds.length&&!program.subjectIds.includes(data.subjectId))throw new ApiError(400,'Предмет не включён в выбранную программу');if(data.groupId&&program.groupIds.length&&!program.groupIds.includes(data.groupId))throw new ApiError(400,'Группа не включена в выбранную программу');}
  if(kind==='lessons') {
    if(new Set(data.sections.map((s:any)=>s.id)).size!==data.sections.length||new Set(data.quiz.map((q:any)=>q.id)).size!==data.quiz.length)throw new ApiError(400,'Идентификаторы разделов и вопросов должны быть уникальны');
  }
  if(kind==='departments'&&data.parentId) {
    let parent=data.parentId;const seen=new Set([data.id]);
    while(parent) {if(seen.has(parent))throw new ApiError(400,'Цикл в структуре подразделений');seen.add(parent);parent=(await entity(db,parent,'departments')).parentId;}
  }
  if(kind==='groups'&&data.teacherIds){for(const id of data.teacherIds){const user=(await db.query('SELECT institution_id,data FROM users WHERE id=$1',[id])).rows[0];if(!user||user.institution_id!==data.institutionId||user.data.role!=='TEACHER'||!user.data.active)throw new ApiError(400,'Все преподаватели группы должны быть активны в этом университете');}}
  if(data.teacherId) {
    const teacher=(await db.query('SELECT * FROM users WHERE id=$1',[data.teacherId])).rows[0];
    if(!teacher||teacher.institution_id!==data.institutionId||teacher.data.role!=='TEACHER'||!teacher.data.active)throw new ApiError(400,'Укажите активного преподавателя этого учреждения');
    
  }
  if(data.fileId) {
    const file=(await db.query('SELECT * FROM files WHERE id=$1',[data.fileId])).rows[0];
    if(!file||file.institution_id!==data.institutionId)throw new ApiError(400,'Файл не найден в учреждении');
    data.url='/api/files/'+data.fileId;
  }
}
export function installCrud(app:Express,db:DB,ctx:any) {
  app.get('/api/institutions',async(req:any,res)=>res.json(await ctx.institutions(req.user)));
  app.post('/api/institutions',async(req:any,res)=>{
    permitted(req.user,['ADMIN']); const data={...parse<any>(institutionSchema,req.body),id:uid(),createdAt:now()};
    await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)',[data.id,data]); await ctx.audit(req.user,'institution.create',data.id,data.id);res.status(201).json(data);
  });
  app.patch('/api/institutions/:id',async(req:any,res)=>{
    permitted(req.user,adminRoles); const id=tenant(req.user,req.params.id);const row=(await db.query('SELECT data FROM institutions WHERE id=$1',[id])).rows[0];
    if(!row)throw new ApiError(404,'Учреждение не найдено');
    const data={...parse<any>(institutionSchema,{...row.data,...req.body,settings:{...row.data.settings,...req.body.settings}}),id,createdAt:row.data.createdAt};
    await db.query('UPDATE institutions SET data=$1 WHERE id=$2',[data,id]); await ctx.audit(req.user,'institution.update',id,id);res.json(data);
  });
  app.get('/api/data/:kind',async(req:any,res)=>{
    const {kind}=req.params;if(!schemas[kind])throw new ApiError(404,'Неизвестный вид данных'); const id=tenant(req.user,req.query.institutionId);
    const items=await visibleEntities(db,req.user,id,kind);
    res.json(kind==='assignments'&&!await moduleEnabled(db,id,'assignments')?[]:items);
  });
  app.post('/api/data/:kind',async(req:any,res)=>{
    const {kind}=req.params;if(!schemas[kind])throw new ApiError(404,'Неизвестный вид данных');const institutionId=tenant(req.user,req.body.institutionId);await institutionExists(db,institutionId);
    const data={...parse<any>(schemas[kind],req.body),id:uid(),institutionId,createdAt:now(),updatedAt:now(),ownerId:req.user.id};
    await canWriteEntity(db,req.user,kind,data);await checkReferences(db,kind,data);
    await db.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4)',[data.id,institutionId,kind,data]);await ctx.audit(req.user,`${kind}.create`,data.id,institutionId);res.status(201).json(data);
  });
  app.patch('/api/data/:kind/:id',async(req:any,res)=>{
    const {kind,id}=req.params;if(!schemas[kind])throw new ApiError(404,'Неизвестный вид данных');const original=await entity(db,id,kind);tenant(req.user,original.institutionId);
    if(req.body.institutionId&&req.body.institutionId!==original.institutionId)throw new ApiError(400,'Нельзя переносить запись в другое учреждение');
    await canWriteEntity(db,req.user,kind,original);
    if(kind==='schedule'&&original.cancelled)throw new ApiError(409,'Занятие отменено','CANCELLED');
    const data={...parse<any>(schemas[kind],{...original,...req.body}),id,institutionId:original.institutionId,createdAt:original.createdAt,updatedAt:now(),ownerId:original.ownerId,...(kind==='schedule'?{revision:(original.revision||0)+1}: {})};
    await canWriteEntity(db,req.user,kind,data);await checkReferences(db,kind,data);
    await db.query('UPDATE entities SET data=$1 WHERE id=$2',[data,id]);await ctx.audit(req.user,`${kind}.update`,id,data.institutionId);res.json(data);
  });
  app.delete('/api/data/:kind/:id',async(req:any,res)=>{
    const {kind,id}=req.params;if(!schemas[kind])throw new ApiError(404,'Неизвестный вид данных');const original=await entity(db,id,kind);await canWriteEntity(db,req.user,kind,original);
    const all=await entities(db,original.institutionId);
    const includes=(obj:any):boolean=>Array.isArray(obj)?obj.some(includes):obj&&typeof obj==='object'?Object.entries(obj).some(([key,value])=>key!=='id'&&includes(value)):obj===id;
    if(all.some(e=>e.id!==id&&includes(e)))throw new ApiError(409,'Сначала удалите или измените связанные записи','REFERENCE_EXISTS');
    const users=(await db.query('SELECT data FROM users WHERE institution_id=$1',[original.institutionId])).rows;
    if(users.some(u=>u.data.studentId===id||u.data.childIds?.includes(id)))throw new ApiError(409,'Запись связана с учётной записью','REFERENCE_EXISTS');
    const active=(await db.query("SELECT data FROM lesson_sessions WHERE institution_id=$1 AND data->>'state'<>'COMPLETED'",[original.institutionId])).rows;
    if(active.some(r=>r.data.groupId===id||r.data.lessonId===id||r.data.attendance.some((a:any)=>a.studentId===id)))throw new ApiError(409,'Запись используется в активном занятии','REFERENCE_EXISTS');
    const teaching=(await db.query("SELECT data FROM teaching_sessions WHERE institution_id=$1 AND data->>'state'<>'completed'",[original.institutionId])).rows;
    if(teaching.some(({data:s})=>s.groupId===id||s.event.lessonId===id||s.event.subjectId===id||s.event.roomId===id||s.attendance.some((a:any)=>a.studentId===id)))throw new ApiError(409,'Запись используется в действующей паре','REFERENCE_EXISTS');
    const semesters=(await db.query('SELECT data FROM semesters WHERE institution_id=$1 AND archived=FALSE',[original.institutionId])).rows;
    if(semesters.some(({data:s})=>s.subjectId===id||s.groupIds.includes(id)||s.schedule.some((slot:any)=>slot.roomId===id)))throw new ApiError(409,'Запись используется в учебном плане семестра','REFERENCE_EXISTS');
    if((await db.query('SELECT id FROM lesson_materials WHERE subject_id=$1 LIMIT 1',[id])).rows.length)throw new ApiError(409,'Предмет используется в загруженных уроках','REFERENCE_EXISTS');
    if(kind==='schedule')await db.query('UPDATE entities SET data=$1 WHERE id=$2',[{...original,cancelled:true,cancelledAt:now(),cancelledBy:req.user.id,updatedAt:now(),revision:(original.revision||0)+1},id]);
    else await db.query('DELETE FROM entities WHERE id=$1',[id]);await ctx.audit(req.user,`${kind}.delete`,id,original.institutionId);res.json({ok:true});
  });
  app.get('/api/users',async(req:any,res)=>{
    const institutionId=tenant(req.user,req.query.institutionId);
    permitted(req.user,['SUPER_ADMIN','ADMIN','DIRECTOR','TEACHER']);
    const rows=(await db.query("SELECT * FROM users WHERE institution_id=$1 AND data->>'role' IN ('ADMIN','TEACHER') ORDER BY data->>'name'",[institutionId])).rows;
    if(req.user.role==='TEACHER')return res.json(rows.filter(r=>r.data.role==='TEACHER').map(r=>({id:r.id,name:r.data.name,email:'',role:r.data.role,institutionId,active:r.data.active,groupIds:[]})));
    res.json(await Promise.all(rows.map(r=>ctx.expandUser(publicUser(r)))));
  });
  const writeUser=async(req:any,res:any,update:boolean)=>{
    permitted(req.user,adminRoles);
    const existing=update?(await db.query('SELECT * FROM users WHERE id=$1',[req.params.id])).rows[0]:null;
    if(update&&!existing)throw new ApiError(404,'Пользователь не найден');
    if(existing) {
      if(existing.data.role==='SUPER_ADMIN'&&req.user.role!=='SUPER_ADMIN')throw new ApiError(403,'Недостаточно прав');
      if(existing.institution_id)tenant(req.user,existing.institution_id);
    }
    const raw={active:true,...existing?.data,...req.body}; const user=parse<any>(userSchema,raw);
    if(user.role==='SUPER_ADMIN'&&req.user.role!=='SUPER_ADMIN')throw new ApiError(403,'Только суперадминистратор управляет этой ролью');
    if(req.user.id===existing?.id&&(user.active===false||user.role!==existing.data.role))throw new ApiError(400,'Нельзя отключить или изменить собственную роль');
    const institutionId=user.role==='SUPER_ADMIN'?null:tenant(req.user,raw.institutionId||existing?.institution_id);
    if(institutionId)await institutionExists(db,institutionId);
    if(existing&&institutionId!==existing.institution_id)throw new ApiError(400,'Перенос учётной записи между учреждениями запрещён');
    const password=req.body.password;
    if((!update||password!==undefined)&&!passwordValid(password))throw new ApiError(400,'Пароль: 10–200 символов, минимум одна буква и цифра');
    for(const id of [user.studentId,...(user.childIds||[])].filter(Boolean)) {const student=await entity(db,id,'students');if(student.institutionId!==institutionId)throw new ApiError(400,'Учащийся относится к другому учреждению');}
    if(user.role==='STUDENT'&&!user.studentId)throw new ApiError(400,'Для учащегося укажите studentId');
    if(user.role==='PARENT'&&!user.childIds?.length)throw new ApiError(400,'Для родителя укажите childIds');
    if(user.role!=='STUDENT')delete user.studentId;if(user.role!=='PARENT')delete user.childIds;
    const selectedGroups=user.role==='TEACHER'?user.groupIds:[];
    for(const id of selectedGroups||[]){const group=await entity(db,id,'groups');if(group.institutionId!==institutionId)throw new ApiError(400,'Группа относится к другому учреждению');}
    const id=existing?.id||uid();const data={...user,id,institutionId,email:user.email.toLowerCase()};delete data.groupIds;
    try {
      await db.transaction(async tx=>{
        if(existing)await tx.query('UPDATE users SET email=$1,password_hash=$2,data=$3 WHERE id=$4',[data.email,password?passwordHash(password):existing.password_hash,data,id]);
        else await tx.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)',[id,institutionId,data.email,passwordHash(password),data]);
        if(existing&&(password||!data.active||data.role!==existing.data.role))await tx.query('DELETE FROM auth_sessions WHERE user_id=$1',[id]);
        if(institutionId && (req.body.groupIds!==undefined||existing?.data.role==='TEACHER'&&user.role!=='TEACHER')) {
          const groups=await entities(tx,institutionId,'groups');
          for(const group of groups) {
            if(selectedGroups?.includes(group.id)){group.teacherIds=[...new Set([...(group.teacherIds||[]),id])];if(!group.teacherId)group.teacherId=id;}
            else if(group.teacherId===id||group.teacherIds?.includes(id)){group.teacherIds=(group.teacherIds||[]).filter((teacherId:string)=>teacherId!==id);if(group.teacherId===id){if(group.teacherIds.length)group.teacherId=group.teacherIds[0];else delete group.teacherId;}}
            else continue;
            group.updatedAt=now();await tx.query('UPDATE entities SET data=$1 WHERE id=$2',[group,group.id]);
          }
        }
      });
    }catch(error:any){if(error.code==='23505')throw new ApiError(409,'Этот email уже используется','DUPLICATE');throw error;}
    await ctx.audit(req.user,existing?'users.update':'users.create',id,institutionId);res.status(existing?200:201).json(await ctx.expandUser({...data,mfaEnabled:!!existing?.mfa_secret}));
  };
  app.post('/api/users',async(req:any,res)=>writeUser(req,res,false));
  app.patch('/api/users/:id',async(req:any,res)=>writeUser(req,res,true));
}
