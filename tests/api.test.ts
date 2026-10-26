import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createApp } from '../server/app.js';
import { totp } from '../server/security.js';
import { backupStorage, restoreStorage } from '../scripts/storage.js';

test('university API: roles, semester extraction, real timetable, camera records and durable restoration',{timeout:120000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'university-test-'));const dataDir=path.join(temporary,'data');
  let app=await createApp({dataDir,seedDemo:true});let server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string;user:any};
  const request=async(client:Client|null,url:string,method='GET',body?:any,extra:Record<string,string>={})=>{
    const headers:Record<string,string>={...extra};if(client){headers.Cookie=client.cookie;if(method!=='GET')headers['X-CSRF-Token']=client.csrf;}
    if(body!==undefined&&!(body instanceof FormData))headers['Content-Type']='application/json';
    const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});const content=response.headers.get('content-type')||'';const data=content.includes('application/json')?await response.json():await response.text();return {status:response.status,data,response};
  };
  const login=async(email:string,password:string,code?:string)=>{const r=await request(null,'/api/auth/login','POST',{email,password,...(code?{totp:code}:{})});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrfToken,user:r.data.user};};
  let teacher:Client,admin:Client,other:Client,teacher2:Client;let semester:any,session:any,date:string;let privateGroupId='';let fileId='';let photoFileId='';
  const descriptor=Array.from({length:1024},(_,i)=>i===0?1:0);
  const semesterForm=(content:Blob,filename:string,name='Математический анализ: семестр')=>{const form=new FormData();form.set('institutionId','demo-school');form.set('name',name);form.set('subjectId','demo-biology');form.set('groupIds',JSON.stringify(['demo-group-7a']));form.set('startDate',date);form.set('endDate',new Date(Date.parse(date)+28*86400000).toISOString().slice(0,10));form.set('files',content,filename);return form;};
  try{
    await t.test('only administrator and teacher remain active, with university-only institutions',async()=>{
      assert.equal((await request(null,'/api/university')).status,401);teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');other=await login('other@aiteacher.local','PepeOnly-external-teacher-2026!');
      for(const [email,password]of[['director@aiteacher.local','PepeOnly-director-2026!'],['student@aiteacher.local','PepeOnly-student-2026!'],['parent@aiteacher.local','PepeOnly-parent-2026!'],['tech@aiteacher.local','PepeOnly-technician-2026!']])assert.equal((await request(null,'/api/auth/login','POST',{email,password})).status,401);
      const migrated=await login('super@aiteacher.local','PepeOnly-super-2026!');assert.equal(migrated.user.role,'ADMIN');assert.equal(migrated.user.institutionId,'demo-school');
      assert.equal((await request(teacher,'/api/institutions')).data[0].type,'UNIVERSITY');assert.equal((await request(admin,'/api/users')).data.some((u:any)=>!['ADMIN','TEACHER'].includes(u.role)),false);
      assert.equal((await request(admin,'/api/users','POST',{institutionId:'demo-school',name:'Not allowed',email:'invalid-role@local.test',role:'PARENT',password:'Secret2026!',active:true})).status,400);
      assert.equal((await request({...teacher,csrf:'wrong'},'/api/teaching-sessions','POST',{})).status,403);assert.equal((await request(teacher,'/api/teaching-sessions','POST',{}, {Origin:'https://evil.example'})).status,403);
      assert.equal((await request(other,'/api/university?institutionId=demo-school')).status,403);
      const r=await request(admin,'/api/users','POST',{institutionId:'demo-school',name:'Второй преподаватель',email:'second@university.test',role:'TEACHER',active:true,password:'Second2026!',groupIds:['demo-group-7b']});assert.equal(r.status,201);teacher2=await login('second@university.test','Second2026!');const privateGroup=await request(admin,'/api/data/groups','POST',{institutionId:'demo-school',name:'Личная группа другого преподавателя',teacherId:teacher2.user.id});assert.equal(privateGroup.status,201);privateGroupId=privateGroup.data.id;
    });
    await t.test('today data contains actual dated events and only own teacher groups',async()=>{
      const r=await request(teacher,'/api/university');assert.equal(r.status,200);date=r.data.date;assert.match(date,/^\d{4}-\d{2}-\d{2}$/);assert.equal(r.data.groups.length,2);assert.equal(r.data.groups[0].name,'ИС-21');assert.equal(r.data.students.length,12);assert.ok(r.data.events.length);assert.equal(r.data.events[0].date,date);assert.match(r.data.events[0].topic.content,/производн/i);
      assert.equal((await request(teacher2,'/api/university')).data.events.length,0);assert.equal((await request(teacher,'/api/university?date=2026-02-30')).status,400);
      assert.equal((await request(teacher,'/api/sessions','POST',{})).status,410);assert.equal((await request(teacher,'/api/sessions/nonexistent/results','PUT',{})).status,410);
      assert.equal((await request(teacher,'/api/data/students','POST',{institutionId:'demo-school',name:'Запрещено',groupId:'demo-group-7a'})).status,403);
    });
    await t.test('whole-semester text imports real source topics, requires review and creates recurrence events',async()=>{
      const text='Тема 1. Предел последовательности\nОпределение предела и основные свойства.\n\nТема 2. Производная функции\nПроизводная как предел отношения приращений.';
      const r=await request(teacher,'/api/semesters/import','POST',semesterForm(new Blob([text],{type:'text/plain'}),'semester.txt'));assert.equal(r.status,201,JSON.stringify(r.data));semester=r.data;assert.equal(semester.status,'draft');assert.equal(semester.topics.length,2);assert.deepEqual(semester.schedule,[]);assert.match(semester.topics[0].content,/Определение предела/);fileId=semester.files[0].id;
      assert.equal((await request(teacher,`/api/semesters/${semester.id}`,'PATCH',{status:'ready'})).status,400);
      const weekday=new Date(date+'T12:00:00Z').getUTCDay()||7;const ready=await request(teacher,`/api/semesters/${semester.id}`,'PATCH',{status:'ready',schedule:[{weekday,startTime:'13:00',durationMinutes:90}]});assert.equal(ready.status,200);semester=ready.data;
      const data=(await request(teacher,'/api/university')).data;const event=data.events.find((e:any)=>e.semesterId===semester.id);assert.ok(event);assert.equal(event.date,date);assert.equal(event.topic.title,semester.topics[0].title);assert.equal(Date.parse(event.endsAt)-Date.parse(event.startsAt),90*60000);
      assert.equal((await request(teacher2,`/api/semesters/${semester.id}`)).status,403);assert.equal((await request(other,`/api/semesters/${semester.id}`)).status,403);assert.equal((await request(teacher2,`/api/files/${fileId}`)).status,403);assert.equal((await request(teacher,`/api/files/${fileId}`)).status,200);
      assert.equal((await request(teacher,`/api/semesters/${semester.id}`,'PATCH',{groupIds:[privateGroupId]})).status,403);
    });
    await t.test('DOCX is extracted locally and malformed or scanned input never reports successful analysis',async()=>{
      const document='<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Тема. Интеграл</w:t></w:r></w:p><w:p><w:r><w:t>Первообразная &amp; определённый интеграл.</w:t></w:r></w:p></w:body></w:document>';
      const bytes=zipSync({'word/document.xml':strToU8(document)});const r=await request(teacher,'/api/semesters/import','POST',semesterForm(new Blob([new Uint8Array(bytes)]),'program.docx'));assert.equal(r.status,201,JSON.stringify(r.data));assert.ok(r.data.topics.some((topic:any)=>topic.content.includes('Первообразная & определённый интеграл.')));assert.equal(r.data.status,'draft');
      const bad=await request(teacher,'/api/semesters/import','POST',semesterForm(new Blob(['<html>bad</html>']),'broken.pdf'));assert.equal(bad.status,400);
      const unsupported=await request(teacher,'/api/semesters/import','POST',semesterForm(new Blob(['<svg/>']),'attack.svg'));assert.equal(unsupported.status,400);
    });
    await t.test('structured semester CSV and text PDF retain real document contents',async()=>{
      const weekday=new Date(date+'T12:00:00Z').getUTCDay()||7;
      const csv=`title,content,weekday,startTime,durationMinutes\nПредел функции,Определение предела функции,${weekday},15:00,90\nНепрерывность,Условия непрерывности функции,${weekday},15:00,90\n`;
      const parsed=await request(teacher,'/api/semesters/import','POST',semesterForm(new Blob([csv],{type:'text/csv'}),'curriculum.csv'));assert.equal(parsed.status,201,JSON.stringify(parsed.data));assert.equal(parsed.data.topics.length,2);assert.equal(parsed.data.topics[0].title,'Предел функции');assert.equal(parsed.data.schedule.length,1);assert.equal(parsed.data.status,'draft');
      const stream='BT /F1 14 Tf 50 750 Td (Limits and continuity) Tj ET';
      const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
      let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const parsedPDF=await request(teacher,'/api/semesters/import','POST',semesterForm(new Blob([pdf],{type:'application/pdf'}),'lecture.pdf'));assert.equal(parsedPDF.status,201,JSON.stringify(parsedPDF.data));assert.ok(parsedPDF.data.topics.some((topic:any)=>topic.content.includes('Limits and continuity')));assert.ok(parsedPDF.data.files[0].extractedCharacters>0);
    });
    await t.test('student CSV validation is atomic and face references are administrator-only and group-scoped',async()=>{
      const form=new FormData();form.set('institutionId','demo-school');form.set('groupId','demo-group-7a');form.set('file',new Blob(['name\nНовый студент\n'],{type:'text/csv'}),'students.csv');const r=await request(admin,'/api/students/import','POST',form);assert.equal(r.status,201);assert.equal(r.data.created,1);
      const before=(await request(admin,'/api/data/students')).data.length;const invalid=new FormData();invalid.set('institutionId','demo-school');invalid.set('groupId','demo-group-7a');invalid.set('file',new Blob(['name,other\nValid,x\n,y\n'],{type:'text/csv'}),'bad.csv');assert.equal((await request(admin,'/api/students/import','POST',invalid)).status,400);assert.equal((await request(admin,'/api/data/students')).data.length,before);
      assert.equal((await request(teacher,'/api/students/import','POST',form)).status,403);
      const photo=new FormData();photo.set('institutionId','demo-school');photo.set('file',new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}),'synthetic-fixture.png');const uploaded=await request(admin,'/api/files','POST',photo);assert.equal(uploaded.status,201);photoFileId=uploaded.data.id;
      const enrollment={descriptor,modelVersion:'human-v3-face-description-1024',photoFileId};assert.equal((await request(teacher,'/api/face-enrollments/demo-student-1','POST',enrollment)).status,403);
      assert.equal((await request(admin,'/api/face-enrollments/demo-student-1','POST',{...enrollment,descriptor:[1,2,3]})).status,400);
      assert.equal((await request(admin,'/api/face-enrollments/demo-student-1','POST',enrollment)).status,200);
      assert.equal((await request(teacher,'/api/face-enrollments?groupId=demo-group-7a')).data.length,1);assert.equal((await request(teacher2,'/api/face-enrollments?groupId=demo-group-7a')).status,403);assert.deepEqual((await request(other,'/api/face-enrollments')).data,[]);
      assert.equal((await request(teacher,`/api/files/${photoFileId}`)).status,200);assert.equal((await request(teacher2,`/api/files/${photoFileId}`)).status,403);
    });
    await t.test('teaching starts immediately without an attendance gate or grading and reserves its event',async()=>{
      const event=(await request(teacher,'/api/university')).data.events.find((e:any)=>e.semesterId===semester.id);const r=await request(teacher,'/api/teaching-sessions','POST',{institutionId:'demo-school',eventId:event.id,date});assert.equal(r.status,201);session=r.data;assert.equal(session.state,'live');assert.equal(session.results,undefined);assert.ok(session.attendance.every((a:any)=>a.status==='unconfirmed'));assert.equal(session.roster.find((student:any)=>student.studentId==='demo-student-1').name,'Арина Волкова');assert.equal(session.scanOffsets[0],120);assert.equal(session.scanOffsets.length,5);
      const repeated=await request(teacher,'/api/teaching-sessions','POST',{institutionId:'demo-school',eventId:event.id,date});assert.equal(repeated.data.id,session.id);assert.equal((await request(teacher2,`/api/teaching-sessions/${session.id}`)).status,403);
      const early=await request(teacher,`/api/teaching-sessions/${session.id}/scans`,'POST',{revision:session.revision,capturedAt:new Date().toISOString(),detectedFaces:0,matches:[],unknownFaces:0,status:'completed'});assert.equal(early.status,409);assert.equal(early.data.code,'SCAN_NOT_DUE');
      assert.equal((await request(admin,'/api/data/students/demo-student-1','DELETE')).status,409);assert.equal((await request(admin,'/api/data/subjects/demo-biology','DELETE')).status,409);
      const pause=await request(teacher,`/api/teaching-sessions/${session.id}/action`,'POST',{action:'pause',revision:session.revision});assert.equal(pause.status,200);session=pause.data;assert.equal(session.state,'paused');assert.equal((await request(teacher,`/api/teaching-sessions/${session.id}/action`,'POST',{action:'resume',revision:0})).status,409);
      const resume=await request(teacher,`/api/teaching-sessions/${session.id}/action`,'POST',{action:'resume',revision:session.revision});session=resume.data;assert.equal(session.state,'live');
    });
    await t.test('camera matches preserve firstSeen, leave unknowns unconfirmed and respect manual review',async()=>{
      session.startedAt=new Date(Date.now()-10*60000).toISOString();await app.locals.db.query('UPDATE teaching_sessions SET data=$1 WHERE id=$2',[session,session.id]);
      const scan=async(matches:any[],unknownFaces=0,status='completed')=>request(teacher,`/api/teaching-sessions/${session.id}/scans`,'POST',{revision:session.revision,capturedAt:new Date().toISOString(),detectedFaces:matches.length+unknownFaces,matches,unknownFaces,status});
      const matched=await scan([{studentId:'demo-student-1',similarity:.8}],1);assert.equal(matched.status,200,JSON.stringify(matched.data));session=matched.data;let a=session.attendance.find((a:any)=>a.studentId==='demo-student-1');assert.equal(a.status,'present');const firstSeen=a.firstSeenAt;assert.equal(session.attendance.find((a:any)=>a.studentId==='demo-student-2').status,'unconfirmed');
      const low=await scan([{studentId:'demo-student-1',similarity:.3}]);assert.equal(low.status,400);
      const cross=await scan([{studentId:'demo-student-9',similarity:.9}]);assert.equal(cross.status,400);
      const manual=await request(teacher,`/api/teaching-sessions/${session.id}/attendance`,'PUT',{revision:session.revision,attendance:[{studentId:'demo-student-1',status:'excused'}]});assert.equal(manual.status,200);session=manual.data;assert.equal(session.attendance.filter((a:any)=>a.reviewed).length,1);
      const matchedAgain=await scan([{studentId:'demo-student-1',similarity:.9}]);assert.equal(matchedAgain.status,200);session=matchedAgain.data;a=session.attendance.find((a:any)=>a.studentId==='demo-student-1');assert.equal(a.status,'excused');assert.equal(a.method,'manual');assert.equal(a.firstSeenAt,firstSeen);
      const wholeRoster=await request(admin,`/api/teaching-sessions/${session.id}/attendance`,'PUT',{revision:session.revision,attendance:session.attendance.map((a:any)=>({studentId:a.studentId,status:a.status}))});assert.equal(wholeRoster.status,200);session=wholeRoster.data;assert.equal(session.attendance.find((a:any)=>a.studentId==='demo-student-2').reviewed,false);
      const secondDescriptor=descriptor.map((_:number,i:number)=>i===1?1:0);assert.equal((await request(admin,'/api/face-enrollments/demo-student-2','POST',{descriptor:secondDescriptor,modelVersion:'human-v3-face-description-1024'})).status,200);
      const newlyConfirmed=await scan([{studentId:'demo-student-2',similarity:.85}]);assert.equal(newlyConfirmed.status,200);session=newlyConfirmed.data;assert.equal(session.attendance.find((a:any)=>a.studentId==='demo-student-2').status,'present');
      const failed=await scan([],0,'failed');assert.equal(failed.status,200);session=failed.data;assert.equal(session.attendance.find((a:any)=>a.studentId==='demo-student-3').status,'unconfirmed');
      const duplicate=await request(teacher,`/api/teaching-sessions/${session.id}/scans`,'POST',{revision:session.revision,...session.scans[session.scans.length-1]});assert.equal(duplicate.status,409);
      const complete=await request(teacher,`/api/teaching-sessions/${session.id}/action`,'POST',{action:'complete',revision:session.revision});assert.equal(complete.status,200);session=complete.data;
      const archived=await request(teacher,`/api/semesters/${semester.id}`,'DELETE');assert.equal(archived.status,200);assert.equal(archived.data.archived,true);assert.equal((await request(teacher,`/api/teaching-sessions/${session.id}`)).status,200);
    });
    await t.test('historical roster survives student transfers and can still be reviewed',async()=>{
      const transferred=await request(admin,'/api/data/students/demo-student-1','PATCH',{groupId:privateGroupId,name:'Изменённое имя студента'});assert.equal(transferred.status,200);
      const historical=await request(teacher,`/api/teaching-sessions/${session.id}`);assert.equal(historical.status,200);session=historical.data;assert.equal(session.roster.find((student:any)=>student.studentId==='demo-student-1').name,'Арина Волкова');
      const review=await request(teacher,`/api/teaching-sessions/${session.id}/attendance`,'PUT',{revision:session.revision,attendance:[{studentId:'demo-student-1',status:'present'},{studentId:'demo-student-2',status:'unconfirmed'}]});assert.equal(review.status,200);session=review.data;assert.equal(session.attendance.find((a:any)=>a.studentId==='demo-student-1').status,'present');assert.equal(session.attendance.find((a:any)=>a.studentId==='demo-student-2').reviewed,false);
      // Return the reviewed result to the value tested by the restoration scenario.
      const restore=await request(teacher,`/api/teaching-sessions/${session.id}/attendance`,'PUT',{revision:session.revision,attendance:[{studentId:'demo-student-1',status:'excused'}]});assert.equal(restore.status,200);session=restore.data;
    });
    await t.test('semester review accepts the same large text size as successful imports',async()=>{
      const original=(await request(teacher,'/api/university')).data.semesters[0];
      const topics=Array.from({length:30},(_,i)=>({id:`large-topic-${i}`,title:`Тема ${i+1}`,content:'А'.repeat(80000),order:i}));
      const update=await request(teacher,`/api/semesters/${original.id}`,'PATCH',{topics,status:'draft'});assert.equal(update.status,200,JSON.stringify(update.data).slice(0,200));assert.equal(update.data.topics.length,30);assert.equal(update.data.topics[29].content.length,80000);
    });
    await t.test('TOTP and password changes keep access protected',async()=>{
      const setup=await request(admin,'/api/auth/mfa/setup','POST',{});assert.equal(setup.status,200);assert.equal((await request(admin,'/api/auth/mfa/enable','POST',{code:'bad'})).status,400);const code=totp(setup.data.secret,'admin@aiteacher.local').generate();assert.equal((await request(admin,'/api/auth/mfa/enable','POST',{code})).status,200);
      assert.equal((await request(null,'/api/auth/login','POST',{email:'admin@aiteacher.local',password:'PepeOnly-admin-2026!'})).data.code,'MFA_REQUIRED');const second=await login('admin@aiteacher.local','PepeOnly-admin-2026!',code);assert.equal((await request(admin,'/api/auth/password','POST',{currentPassword:'PepeOnly-admin-2026!',newPassword:'ChangedPepeOnly-admin-2026!'})).status,200);assert.equal((await request(second,'/api/auth/me')).status,401);
    });
    await t.test('offline backup restores semesters, face references and completed attendance',async()=>{
      await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();const backup=path.join(temporary,'backup'),restored=path.join(temporary,'restored');await writeFile(path.join(dataDir,'server.lock'),String(process.pid));await assert.rejects(backupStorage(dataDir,backup),/Stop AI Teacher/);await rm(path.join(dataDir,'server.lock'));const b=await backupStorage(dataDir,backup);assert.ok(b.files>3);const r=await restoreStorage(backup,restored);assert.equal(r.files,b.files);
      app=await createApp({dataDir:restored,seedDemo:false});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');const persisted=await request(teacher,`/api/teaching-sessions/${session.id}`);assert.equal(persisted.status,200);assert.equal(persisted.data.state,'completed');assert.equal(persisted.data.scans.length,4);assert.equal(persisted.data.attendance.find((a:any)=>a.studentId==='demo-student-1').status,'excused');assert.equal((await request(admin,'/api/face-enrollments')).data[0].descriptor.length,1024);assert.equal((await request(admin,`/api/files/${photoFileId}`)).status,200);assert.equal(persisted.data.roster.find((student:any)=>student.studentId==='demo-student-1').name,'Арина Волкова');assert.equal((await request(null,'/api/config')).data.demoEnabled,false);
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});}
});
