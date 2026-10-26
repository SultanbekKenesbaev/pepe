import type { DB } from './db.js';
import type { User, LessonSession } from '../shared/types.js';
import { ApiError, adminRoles } from './security.js';

export function permitted(user:User,roles:string[]) { if(!roles.includes(user.role)) throw new ApiError(403,'Недостаточно прав','FORBIDDEN'); }
export function tenant(user:User, value:unknown, required=true):string {
  if(user.role==='SUPER_ADMIN') { if(typeof value==='string' && value.length<129) return value; if(required) throw new ApiError(400,'Выберите учреждение'); return ''; }
  if(!user.institutionId) throw new ApiError(403,'Пользователь не связан с учреждением','FORBIDDEN');
  if(value && value!==user.institutionId) throw new ApiError(403,'Доступ к другому учреждению запрещён','FORBIDDEN');
  return user.institutionId;
}
export async function institutionExists(db:DB,id:string) { if(!(await db.query('SELECT id FROM institutions WHERE id=$1',[id])).rows.length) throw new ApiError(404,'Учреждение не найдено','NOT_FOUND'); }
export async function moduleEnabled(db:DB,institutionId:string,module:string):Promise<boolean> {
  const institution=(await db.query('SELECT data FROM institutions WHERE id=$1',[institutionId])).rows[0]?.data;
  if(!institution)throw new ApiError(404,'Учреждение не найдено','NOT_FOUND');
  return !Array.isArray(institution.settings?.modules)||institution.settings.modules.includes(module);
}
export async function entities(db:DB, institutionId:string, kind?:string):Promise<any[]> {
  return (await db.query(kind?'SELECT data FROM entities WHERE institution_id=$1 AND kind=$2 ORDER BY data->>\'name\'':'SELECT data FROM entities WHERE institution_id=$1 ORDER BY kind,data->>\'name\'',kind?[institutionId,kind]:[institutionId])).rows.map(r=>r.data);
}
export async function entity(db:DB,id:string,kind?:string):Promise<any> {
  const row=(await db.query(kind?'SELECT data FROM entities WHERE id=$1 AND kind=$2':'SELECT data FROM entities WHERE id=$1',kind?[id,kind]:[id])).rows[0];
  if(!row) throw new ApiError(404,'Запись не найдена','NOT_FOUND'); return row.data;
}
export async function ownStudents(db:DB,user:User):Promise<string[]> {
  if(user.role==='STUDENT') return user.studentId?[user.studentId]:[];
  if(user.role==='PARENT') return user.childIds||[];
  return [];
}
export async function groupIds(db:DB,user:User,institutionId:string):Promise<string[]|null> {
  if(adminRoles.includes(user.role)||user.role==='DIRECTOR') return null;
  const groups=await entities(db,institutionId,'groups');
  if(user.role==='TEACHER'){const assigned=(await entities(db,institutionId,'schedule')).filter(e=>!e.cancelled&&e.teacherId===user.id).map(e=>e.groupId);return groups.filter(g=>g.teacherId===user.id||g.teacherIds?.includes(user.id)||assigned.includes(g.id)).map(g=>g.id);}
  const ids=await ownStudents(db,user); const students=await entities(db,institutionId,'students');
  return [...new Set(students.filter(s=>ids.includes(s.id)).map(s=>s.groupId))];
}
export async function visibleEntities(db:DB,user:User,institutionId:string,kind:string) {
  if(user.role==='TECHNICIAN') { permitted(user,['TECHNICIAN']); if(kind!=='devices'&&kind!=='rooms') throw new ApiError(403,'Техник имеет доступ только к оборудованию и аудиториям','FORBIDDEN'); return entities(db,institutionId,kind); }
  const all=await entities(db,institutionId,kind); const ids=await groupIds(db,user,institutionId);
  if(ids===null) return all;
  if(kind==='programs') return all.filter(e=>!e.groupIds?.length||e.groupIds.some((id:string)=>ids.includes(id)));
  if(kind==='rooms'){if(user.role==='TEACHER')return all;throw new ApiError(403,'Нет доступа к аудиториям','FORBIDDEN');}
  if(kind==='groups') return all.filter(e=>ids.includes(e.id));
  if(kind==='students') return all.filter(e=>ids.includes(e.groupId) && (user.role==='TEACHER'||(user.studentId===e.id)||(user.childIds||[]).includes(e.id)));
  if(kind==='schedule'||kind==='assignments') return all.filter(e=>ids.includes(e.groupId));
  if(kind==='lessons') return all.filter(e=>(!e.groupId||ids.includes(e.groupId))&&(user.role==='TEACHER'||e.approved)).map(e=>redactLesson(user,e));
  if(kind==='materials') return all.filter(e=>user.role==='TEACHER'||e.approved);
  if(kind==='subjects'||kind==='departments') return all;
  throw new ApiError(403,'Недостаточно прав','FORBIDDEN');
}
export function redactLesson(user:User,lesson:any) {
  if(user.role!=='STUDENT'&&user.role!=='PARENT')return lesson;
  return {...lesson,quiz:lesson.quiz.map(({correctIndex,explanation,...q}:any)=>q)};
}
export async function canWriteEntity(db:DB,user:User,kind:string,item:any) {
  tenant(user,item.institutionId);
  if(kind==='assignments'&&!await moduleEnabled(db,item.institutionId,'assignments'))throw new ApiError(403,'Модуль заданий отключён в учреждении','MODULE_DISABLED');
  if(adminRoles.includes(user.role))return;
  if(user.role==='TECHNICIAN'&&kind==='devices')return;
  if(user.role!=='TEACHER'||!['lessons','materials','assignments','schedule'].includes(kind))throw new ApiError(403,'Недостаточно прав для изменения записи','FORBIDDEN');
  const ids=await groupIds(db,user,item.institutionId) as string[];
  if(kind==='lessons'&&item.programId){const program=await entity(db,item.programId,'programs');if(program.groupIds?.length&&!program.groupIds.some((id:string)=>ids.includes(id)))throw new ApiError(403,'Учебная программа относится к другим группам','FORBIDDEN');}
  if(item.groupId&&!ids.includes(item.groupId))throw new ApiError(403,'Группа не назначена преподавателю','FORBIDDEN');
  if(kind==='schedule'&&item.teacherId!==user.id)throw new ApiError(403,'Можно изменять только своё расписание','FORBIDDEN');
  if(item.ownerId&&item.ownerId!==user.id)throw new ApiError(403,'Можно изменять только свои учебные материалы','FORBIDDEN');
}
export async function visibleSessions(db:DB,user:User,institutionId:string):Promise<LessonSession[]> {
  const all=(await db.query('SELECT data FROM lesson_sessions WHERE institution_id=$1 ORDER BY data->>\'createdAt\' DESC',[institutionId])).rows.map(r=>r.data);
  if(adminRoles.includes(user.role)||user.role==='DIRECTOR')return all;
  if(user.role==='TECHNICIAN')return [];
  const groups=await groupIds(db,user,institutionId) as string[];
  return all.filter(s=>groups.includes(s.groupId)&&(user.role!=='TEACHER'||s.teacherId===user.id)).map(s=>redactSession(user,s));
}
export function redactSession(user:User,s:LessonSession):LessonSession {
  if(user.role!=='STUDENT'&&user.role!=='PARENT')return s;
  const ids=user.role==='STUDENT'?[user.studentId]:user.childIds||[];
  return {...s,lesson:redactLesson(user,s.lesson),attendance:s.attendance.filter(a=>ids.includes(a.studentId)),results:s.results.filter(r=>!!r.studentId&&ids.includes(r.studentId))};
}
export async function sessionFor(db:DB,user:User,id:string,write=false):Promise<LessonSession> {
  const row=(await db.query('SELECT data FROM lesson_sessions WHERE id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'Занятие не найдено','NOT_FOUND');
  const s=row.data as LessonSession; tenant(user,s.institutionId);
  if(write) {
    permitted(user,['SUPER_ADMIN','ADMIN','TEACHER']);
    if(user.role==='TEACHER'&&s.teacherId!==user.id)throw new ApiError(403,'Занятие другого преподавателя','FORBIDDEN');
    if(user.role==='TEACHER'&&!(await groupIds(db,user,s.institutionId))?.includes(s.groupId))throw new ApiError(403,'Группа не назначена преподавателю','FORBIDDEN');
  } else {
    const visible=await visibleSessions(db,user,s.institutionId); if(!visible.some(x=>x.id===id))throw new ApiError(403,'Нет доступа к занятию','FORBIDDEN');
  }
  return s;
}
