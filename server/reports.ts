import type { Express } from 'express';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.js';
import { tenant, permitted, visibleSessions, visibleEntities } from './access.js';
import { adminRoles } from './security.js';

function csvCell(value:unknown) {
  let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export function installReports(app:Express,db:DB,ctx:any) {
  app.get('/api/dashboard',async(req:any,res)=>{
    permitted(req.user,['SUPER_ADMIN','ADMIN','DIRECTOR','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId,false);
    let institutions=await ctx.institutions(req.user);if(institutionId)institutions=institutions.filter((i:any)=>i.id===institutionId);
    const sessions:any[]=[],groups:any[]=[],students:any[]=[],lessons:any[]=[],audit:any[]=[];
    for(const institution of institutions){
      sessions.push(...await visibleSessions(db,req.user,institution.id));groups.push(...await visibleEntities(db,req.user,institution.id,'groups'));students.push(...await visibleEntities(db,req.user,institution.id,'students'));lessons.push(...await visibleEntities(db,req.user,institution.id,'lessons'));audit.push(...await ctx.auditEntries(req.user,institution.id));
    }
    const attendance=sessions.flatMap(s=>s.attendance);const counted=attendance.filter(a=>a.status!=='excused');
    res.json({institutions:institutions.length,groups:groups.length,students:students.length,lessons:lessons.length,sessions:sessions.length,completedSessions:sessions.filter(s=>s.state==='COMPLETED').length,attendanceRate:counted.length?Math.round(counted.filter(a=>a.status==='present'||a.status==='late').length/counted.length*100):0,recentSessions:sessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,6),recentAudit:audit.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,10)});
  });
  app.get('/api/audit',async(req:any,res)=>{permitted(req.user,['SUPER_ADMIN','ADMIN','DIRECTOR']);const institutionId=tenant(req.user,req.query.institutionId,false);res.json(await ctx.auditEntries(req.user,institutionId));});
  app.get('/api/reports/export',async(req:any,res)=>{
    permitted(req.user,['SUPER_ADMIN','ADMIN','DIRECTOR','TEACHER']);const institutionId=tenant(req.user,req.query.institutionId);const sessions=await visibleSessions(db,req.user,institutionId);
    const groups=await visibleEntities(db,req.user,institutionId,'groups');const students=await visibleEntities(db,req.user,institutionId,'students');
    const rows:any[][]=[['Занятие','Урок','Группа','Состояние','Начало','Завершение','Учащийся','Посещаемость','Правильных ответов','Ответов всего']];
    for(const session of sessions) {
      const participants=session.attendance.length?session.attendance:[{studentId:'',status:''}];
      for(const a of participants) {
        const results=session.results.filter(r=>r.studentId===a.studentId||!a.studentId&&!r.studentId);
        rows.push([session.id,session.lesson.name,groups.find(g=>g.id===session.groupId)?.name||session.groupId,session.state,session.startedAt||'',session.completedAt||'',students.find(s=>s.id===a.studentId)?.name||a.studentId,a.status,results.filter(r=>r.correct).length,results.length]);
      }
      const groupResults=session.results.filter(r=>!r.studentId);
      if(groupResults.length&&session.attendance.length)rows.push([session.id,session.lesson.name,groups.find(g=>g.id===session.groupId)?.name||session.groupId,session.state,session.startedAt||'',session.completedAt||'','Вся группа','',groupResults.filter(r=>r.correct).length,groupResults.length]);
    }
    res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="ai-teacher-report.csv"');res.send('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));
  });
  app.post('/api/maintenance/purge',async(req:any,res)=>{
    permitted(req.user,adminRoles);const institutionId=tenant(req.user,req.body.institutionId);const institution=(await db.query('SELECT data FROM institutions WHERE id=$1',[institutionId])).rows[0]?.data;
    const days=institution?.settings?.retentionDays||365;const cutoff=new Date(Date.now()-days*86400000).toISOString();
    const result=await db.transaction(async tx=>{
      const removed=await tx.query("DELETE FROM lesson_sessions WHERE institution_id=$1 AND data->>'state'='COMPLETED' AND (data->>'completedAt')::timestamptz<$2::timestamptz RETURNING id",[institutionId,cutoff]);
      const audits=await tx.query("DELETE FROM audit WHERE institution_id=$1 AND (data->>'createdAt')::timestamptz<$2::timestamptz RETURNING id",[institutionId,cutoff]);
      const cached=await tx.query("DELETE FROM idempotency WHERE created_at<$2::timestamptz AND (data->'result'->>'institutionId'=$1 OR data->'result'->'session'->>'institutionId'=$1) RETURNING request_key",[institutionId,cutoff]);
      return {sessions:removed.rows.length,auditEntries:audits.rows.length,idempotencyEntries:cached.rows.length,retentionDays:days};
    });
    await ctx.audit(req.user,'maintenance.purge',institutionId,institutionId);res.json(result);
  });
}
