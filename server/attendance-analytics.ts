import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from './db.js';
import type { AttendanceAnalytics, AttendanceAnalyticsCounts, TeachingSession } from '../shared/types.js';
import { tenant, permitted, entities, entity } from './access.js';
import { ApiError } from './security.js';
import { localDate } from './university.js';
import { parse } from './validation.js';

const dayMs=86400000;
const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Некорректная дата');
const querySchema=z.object({from:dateSchema,to:dateSchema,groupId:z.string().min(1).max(128).optional(),teacherId:z.string().min(1).max(128).optional()});
const emptyCounts=():AttendanceAnalyticsCounts=>({sessions:0,completedSessions:0,liveSessions:0,pausedSessions:0,present:0,late:0,absent:0,excused:0,unconfirmed:0,total:0,attendanceRate:null,confirmationRate:null});

function addSession(counts:AttendanceAnalyticsCounts,session:TeachingSession) {
  counts.sessions++;
  if(session.state==='completed')counts.completedSessions++;
  else if(session.state==='paused')counts.pausedSessions++;
  else counts.liveSessions++;
  // Use the session's frozen records, never the group's current membership.
  for(const attendance of session.attendance){counts[attendance.status]++;counts.total++;}
}
function withRates<T extends AttendanceAnalyticsCounts>(counts:T):T {
  const accountable=counts.present+counts.late+counts.absent;
  const rounded=(n:number)=>Math.round(n*10)/10;
  counts.attendanceRate=accountable?rounded(100*(counts.present+counts.late)/accountable):null;
  counts.confirmationRate=counts.total?rounded(100*(counts.total-counts.unconfirmed)/counts.total):null;
  return counts;
}

export function aggregateAttendance(sessions:TeachingSession[],from:string,to:string,groupNames:Map<string,string>) {
  const totals=emptyCounts();
  const days=new Map<string,AttendanceAnalyticsCounts & {date:string}>();
  const groups=new Map<string,AttendanceAnalyticsCounts & {groupId:string;name:string}>();
  for(let at=Date.parse(from);at<=Date.parse(to);at+=dayMs){const date=new Date(at).toISOString().slice(0,10);days.set(date,{date,...emptyCounts()});}
  for(const session of sessions){
    const day=days.get(session.event.date);if(!day)continue;
    let group=groups.get(session.groupId);
    if(!group){group={groupId:session.groupId,name:groupNames.get(session.groupId)||'Архивная группа',...emptyCounts()};groups.set(session.groupId,group);}
    addSession(totals,session);addSession(day,session);addSession(group,session);
  }
  return {totals:withRates(totals),days:[...days.values()].map(withRates),groups:[...groups.values()].map(withRates).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name))};
}

export function installAttendanceAnalytics(app:Express,db:DB) {
  app.get('/api/attendance/analytics',async(req:any,res)=>{
    permitted(req.user,['ADMIN','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId);
    const inst=(await db.query('SELECT data FROM institutions WHERE id=$1',[institutionId])).rows[0]?.data;
    if(!inst)throw new ApiError(404,'Университет не найден','NOT_FOUND');
    const timezone=inst.settings?.timezone||'Asia/Tashkent';
    const today=localDate(new Date(),timezone);
    const input=parse<z.infer<typeof querySchema>>(querySchema,{...req.query,from:req.query.from||new Date(Date.parse(today)-13*dayMs).toISOString().slice(0,10),to:req.query.to||today});
    if(input.to<input.from)throw new ApiError(400,'Начало периода позже окончания','INVALID_RANGE');
    if((Date.parse(input.to)-Date.parse(input.from))/dayMs>365)throw new ApiError(400,'Выберите период не длиннее 366 дней','INVALID_RANGE');
    if(req.user.role==='TEACHER'&&input.teacherId&&input.teacherId!==req.user.id)throw new ApiError(403,'Доступна посещаемость только ваших занятий','FORBIDDEN');
    if(input.groupId){const group=await entity(db,input.groupId,'groups');tenant(req.user,group.institutionId);}
    if(input.teacherId){const user=(await db.query('SELECT institution_id FROM users WHERE id=$1',[input.teacherId])).rows[0];if(!user||user.institution_id!==institutionId)throw new ApiError(404,'Преподаватель не найден','NOT_FOUND');}
    const values:string[]=[institutionId,input.from,input.to];
    const clauses=["institution_id=$1","data->'event'->>'date'>=$2","data->'event'->>'date'<=$3"];
    const teacherId=req.user.role==='TEACHER'?req.user.id:input.teacherId;
    if(teacherId){values.push(teacherId);clauses.push(`teacher_id=$${values.length}`);}
    if(input.groupId){values.push(input.groupId);clauses.push(`data->>'groupId'=$${values.length}`);}
    const sessions=(await db.query(`SELECT data FROM teaching_sessions WHERE ${clauses.join(' AND ')} ORDER BY data->>'startedAt' DESC,id`,values)).rows.map(row=>row.data) as TeachingSession[];
    const groups=await entities(db,institutionId,'groups');
    const result:AttendanceAnalytics={from:input.from,to:input.to,timezone,...aggregateAttendance(sessions,input.from,input.to,new Map(groups.map(group=>[group.id,group.name]))),sessions};
    res.json(result);
  });
}
