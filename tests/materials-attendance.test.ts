import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createApp } from '../server/app.js';
import type { TeachingSession, UniversityAttendanceStatus } from '../shared/types.js';

test('lesson source library and attendance analytics persist without leaking or rewriting history',{timeout:120000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'teacher-library-'));
  let app=await createApp({dataDir:temporary,seedDemo:true});
  let server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));
  let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string;user:any};
  const request=async(client:Client|null,url:string,method='GET',body?:any)=>{
    const headers:Record<string,string>={};if(client){headers.Cookie=client.cookie;if(method!=='GET')headers['X-CSRF-Token']=client.csrf;}
    if(body!==undefined&&!(body instanceof FormData))headers['Content-Type']='application/json';
    const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():await response.text();
    return {status:response.status,data,response};
  };
  const login=async(email:string,password:string)=>{const result=await request(null,'/api/auth/login','POST',{email,password});assert.equal(result.status,200);return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken,user:result.data.user};};
  const form=(files:{name:string;data:BlobPart}[],subjectId='demo-biology')=>{const body=new FormData();body.set('title','Производная: движение и скорость');body.set('subjectId',subjectId);for(const file of files)body.append('files',new Blob([file.data]),file.name);return body;};
  let teacher:Client,admin:Client,other:Client,teacher2:Client,material:any,scanned:any;
  const source='Производная координаты — мгновенная скорость. При s(t)=t², v(t)=2t.';
  // A real one-page PDF containing only an embedded RGB image, with valid xref offsets.
  const imageStream='FF000000FF000000FFFFFFFF>';
  const drawImage='q 100 0 0 100 50 600 cm /Scan Do Q';
  const pdfObjects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>',`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`,`<< /Length ${drawImage.length} >>\nstream\n${drawImage}\nendstream`];
  let scanPdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<pdfObjects.length;i++){offsets.push(Buffer.byteLength(scanPdf));scanPdf+=`${i+1} 0 obj\n${pdfObjects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(scanPdf);scanPdf+=`xref\n0 ${pdfObjects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${pdfObjects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  try{
    teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');other=await login('other@aiteacher.local','PepeOnly-external-teacher-2026!');
    const created=await request(admin,'/api/users','POST',{institutionId:'demo-school',name:'Автор без группы',email:'library@university.test',role:'TEACHER',active:true,password:'Library2026!',groupIds:[]});assert.equal(created.status,201);
    teacher2=await login('library@university.test','Library2026!');

    await t.test('a teacher without groups uploads only subject, lesson title and source files',async()=>{
      const before=(await app.locals.db.query("SELECT (SELECT COUNT(*) FROM semesters)::int AS semesters,(SELECT COUNT(*) FROM entities WHERE kind='schedule')::int AS schedule")).rows[0];
      const docx=zipSync({'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>График &amp; касательная</w:t></w:r></w:p></w:body></w:document>')});
      const uploaded=await request(teacher2,'/api/lesson-materials','POST',form([{name:'lecture.txt',data:source},{name:'figure.docx',data:new Uint8Array(docx)}]));
      assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));material=uploaded.data;
      assert.equal(material.teacherId,teacher2.user.id);assert.equal(material.status,'stored');assert.equal(material.files.length,2);assert.equal(material.documents,undefined);assert.equal(material.groupIds,undefined);assert.equal(material.video,undefined);
      const detail=await request(teacher2,`/api/lesson-materials/${material.id}`);assert.equal(detail.status,200);assert.equal(detail.data.documents[0].text,source);assert.equal(detail.data.documents[1].text,'График & касательная');assert.equal(material.extractedCharacters,source.length+'График & касательная'.length);
      assert.equal((await request(teacher2,material.files[0].url)).data,source);
      assert.deepEqual((await app.locals.db.query("SELECT (SELECT COUNT(*) FROM semesters)::int AS semesters,(SELECT COUNT(*) FROM entities WHERE kind='schedule')::int AS schedule")).rows[0],before);
      const list=await request(teacher2,'/api/lesson-materials');assert.equal(list.data.length,1);assert.equal(list.data[0].documents,undefined);
    });

    await t.test('source records and original files enforce teacher ownership and university boundaries',async()=>{
      assert.equal((await request(null,'/api/lesson-materials')).status,401);
      assert.deepEqual((await request(teacher,'/api/lesson-materials')).data,[]);
      assert.equal((await request(teacher,`/api/lesson-materials/${material.id}`)).status,403);
      assert.equal((await request(teacher,material.files[0].url)).status,403);
      assert.equal((await request(other,`/api/lesson-materials/${material.id}`)).status,403);
      assert.equal((await request(other,material.files[0].url)).status,403);
      assert.equal((await request(other,'/api/lesson-materials?institutionId=demo-school')).status,403);
      assert.equal((await request(admin,`/api/lesson-materials/${material.id}`)).status,200);
      assert.equal((await request(admin,material.files[1].url)).status,200);
      assert.equal((await request(admin,'/api/lesson-materials')).data.length,1);
      const linked=await request(teacher,'/api/data/materials','POST',{institutionId:'demo-school',name:'Known file ID in a shared legacy record',language:'ru',type:'pdf',approved:true,fileId:material.files[0].id});assert.equal(linked.status,201);
      assert.equal((await request(teacher,material.files[0].url)).status,403);
      assert.equal((await request(other,'/api/lesson-materials','POST',form([{name:'lesson.txt',data:source}]))).status,403);
      assert.equal((await request(admin,'/api/data/subjects/demo-biology','DELETE')).status,409);
    });

    await t.test('bad uploads are atomic and produce no stored lesson or orphan files',async()=>{
      const filesBefore=(await readdir(path.join(temporary,'uploads'))).sort();
      const invalids=[
        [{name:'valid.txt',data:source},{name:'disguised.pdf',data:'<html>not a PDF</html>'}],
        [{name:'broken.pdf',data:'%PDF-1.4\n1 0 obj << /Type /Catalog >>\nnot a complete PDF'}],
        [{name:'broken.docx',data:new Uint8Array(zipSync({'unrelated.xml':strToU8('<root/>')}))}],
        [{name:'active.html',data:'<script>bad</script>'}],
        [{name:'binary.txt',data:new Uint8Array([0,1,2,255])}],
        [{name:'invalid-utf8.txt',data:new Uint8Array([255,254,255])}],
        [{name:'empty.txt',data:'  \n '}],
        [{name:'long.txt',data:'a'.repeat(200001)}],
      ];
      for(const files of invalids)assert.equal((await request(teacher2,'/api/lesson-materials','POST',form(files))).status,400,files[0].name);
      const noFiles=new FormData();noFiles.set('title','Lesson');noFiles.set('subjectId','demo-biology');assert.equal((await request(teacher2,'/api/lesson-materials','POST',noFiles)).status,400);
      assert.deepEqual((await readdir(path.join(temporary,'uploads'))).sort(),filesBefore);
      assert.equal((await request(teacher2,'/api/lesson-materials')).data.length,1);
      assert.equal((await app.locals.db.query('SELECT COUNT(*)::int AS total FROM files')).rows[0].total,2);
    });

    await t.test('a valid image-only PDF is stored byte-for-byte without invented text, while semester import rejects it',async()=>{
      const result=await request(teacher2,'/api/lesson-materials','POST',form([{name:'lecture-scan.pdf',data:scanPdf}]));assert.equal(result.status,201,JSON.stringify(result.data));scanned=result.data;
      assert.equal(scanned.status,'stored');assert.equal(scanned.extractedCharacters,0);assert.equal(scanned.files[0].extractedCharacters,0);
      const detail=await request(teacher2,`/api/lesson-materials/${scanned.id}`);assert.deepEqual(detail.data.documents,[{fileId:scanned.files[0].id,text:''}]);
      const original=await fetch(base+scanned.files[0].url,{headers:{Cookie:teacher2.cookie}});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),Buffer.from(scanPdf));
      const date=(await request(teacher,'/api/university')).data.date;
      const semester=new FormData();semester.set('name','Скан учебного плана');semester.set('subjectId','demo-biology');semester.set('groupIds',JSON.stringify(['demo-group-7a']));semester.set('startDate',date);semester.set('endDate',date);semester.set('files',new Blob([scanPdf],{type:'application/pdf'}),'semester-scan.pdf');
      const rejected=await request(teacher,'/api/semesters/import','POST',semester);assert.equal(rejected.status,400);assert.equal(rejected.data.code,'NO_EXTRACTABLE_TEXT');
    });

    await t.test('date trends count stored statuses separately across completed, live and paused sessions',async()=>{
      const make=(id:string,date:string,state:TeachingSession['state'],statuses:UniversityAttendanceStatus[],teacherId=teacher.user.id,institutionId='demo-school',groupId='demo-group-7a'):TeachingSession=>({
        id,institutionId,eventId:id,teacherId,groupId,state,startedAt:`${date}T04:00:00Z`,pausedMs:0,...(state==='completed'?{completedAt:`${date}T05:00:00Z`}:{}),scanOffsets:[120],scans:[],revision:0,
        roster:statuses.map((_,i)=>({studentId:`demo-student-${i+1}`,name:`Историческое имя ${i+1}`})),attendance:statuses.map((status,i)=>({studentId:`demo-student-${i+1}`,status,method:'manual'})),
        event:{id,institutionId,subjectId:'demo-biology',groupId,teacherId,date,startsAt:`${date}T04:00:00Z`,endsAt:`${date}T05:00:00Z`,topic:{id:'topic',title:'Производная',content:'Текст',order:0}},
      });
      const snapshots=[make('analytics-completed','2026-10-20','completed',['present','late','absent','excused','unconfirmed']),make('analytics-live','2026-10-21','live',['present','present','unconfirmed']),make('analytics-paused','2026-10-21','paused',['unconfirmed','unconfirmed'],teacher2.user.id,'demo-school','demo-group-7b'),make('analytics-foreign','2026-10-21','completed',['present'],other.user.id,other.user.institutionId,'other-group'),make('analytics-outside','2026-10-18','completed',['absent'])];
      for(const s of snapshots)await app.locals.db.query('INSERT INTO teaching_sessions(id,institution_id,event_id,teacher_id,revision,data) VALUES($1,$2,$3,$4,$5,$6)',[s.id,s.institutionId,s.eventId,s.teacherId,s.revision,s]);
      const before=(await app.locals.db.query('SELECT data FROM teaching_sessions ORDER BY id')).rows;
      const result=await request(admin,'/api/attendance/analytics?from=2026-10-19&to=2026-10-21');assert.equal(result.status,200,JSON.stringify(result.data));
      assert.deepEqual(result.data.totals,{sessions:3,completedSessions:1,liveSessions:1,pausedSessions:1,present:3,late:1,absent:1,excused:1,unconfirmed:4,total:10,attendanceRate:80,confirmationRate:60});
      assert.equal(result.data.days.length,3);assert.equal(result.data.days[0].date,'2026-10-19');assert.equal(result.data.days[0].total,0);assert.equal(result.data.days[0].attendanceRate,null);assert.equal(result.data.days[1].unconfirmed,1);assert.equal(result.data.groups.length,2);assert.equal(result.data.groups[0].name,'ИС-21');
      assert.equal(result.data.groups[1].attendanceRate,null);assert.equal(result.data.groups[1].confirmationRate,0);
      const own=await request(teacher,'/api/attendance/analytics?from=2026-10-19&to=2026-10-21');assert.equal(own.data.totals.sessions,2);assert.equal(own.data.totals.total,8);assert.equal(own.data.totals.confirmationRate,75);assert.ok(own.data.sessions.every((s:TeachingSession)=>s.teacherId===teacher.user.id));
      const foreign=await request(other,'/api/attendance/analytics?from=2026-10-19&to=2026-10-21');assert.equal(foreign.data.sessions.length,1);assert.equal(foreign.data.sessions[0].id,'analytics-foreign');
      assert.equal((await request(teacher,`/api/attendance/analytics?from=2026-10-19&to=2026-10-21&teacherId=${teacher2.user.id}`)).status,403);
      assert.equal((await request(other,'/api/attendance/analytics?institutionId=demo-school')).status,403);
      assert.equal((await request(admin,'/api/attendance/analytics?from=2026-02-30&to=2026-10-21')).status,400);
      assert.equal((await request(admin,'/api/attendance/analytics?from=2026-10-22&to=2026-10-21')).status,400);
      assert.equal((await request(admin,'/api/attendance/analytics?from=2024-01-01&to=2026-10-21')).status,400);
      const group=await request(admin,'/api/attendance/analytics?from=2026-10-19&to=2026-10-21&groupId=demo-group-7b');assert.equal(group.data.totals.sessions,1);assert.equal(group.data.totals.unconfirmed,2);
      assert.deepEqual((await app.locals.db.query('SELECT data FROM teaching_sessions ORDER BY id')).rows,before);
    });

    await t.test('changing current rosters or teacher assignments does not rewrite completed attendance',async()=>{
      const current=(await app.locals.db.query("SELECT data FROM entities WHERE id='demo-student-1'")).rows[0].data;
      await app.locals.db.query("UPDATE entities SET data=$1 WHERE id='demo-student-1'",[{...current,name:'Новое имя',groupId:'demo-group-7b'}]);
      const group=(await app.locals.db.query("SELECT data FROM entities WHERE id='demo-group-7a'")).rows[0].data;
      await app.locals.db.query("UPDATE entities SET data=$1 WHERE id='demo-group-7a'",[{...group,teacherId:teacher2.user.id,teacherIds:[teacher2.user.id]}]);
      await app.locals.db.query("UPDATE entities SET data=jsonb_set(data,'{teacherId}',to_jsonb($1::text)) WHERE kind='schedule' AND data->>'groupId'='demo-group-7a'",[teacher2.user.id]);
      const detail=await request(teacher,'/api/teaching-sessions/analytics-completed');assert.equal(detail.status,200);assert.equal(detail.data.roster[0].name,'Историческое имя 1');assert.equal(detail.data.attendance[0].status,'present');
      const history=await request(teacher,'/api/university?date=2026-10-20');assert.ok(history.data.sessions.some((s:TeachingSession)=>s.id==='analytics-completed'));
      const result=await request(teacher,'/api/attendance/analytics?from=2026-10-20&to=2026-10-20');assert.equal(result.data.totals.total,5);assert.equal(result.data.totals.unconfirmed,1);assert.equal(result.data.sessions[0].roster[0].name,'Историческое имя 1');
      assert.equal((await request(teacher2,'/api/teaching-sessions/analytics-completed')).status,403);
    });

    await t.test('restarting the database restores source bytes, extracted text and attendance analytics',async()=>{
      await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();
      app=await createApp({dataDir:temporary,seedDemo:false});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;
      teacher2=await login('library@university.test','Library2026!');admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');
      const restored=await request(teacher2,`/api/lesson-materials/${material.id}`);assert.equal(restored.status,200);assert.equal(restored.data.documents[0].text,source);assert.equal((await request(teacher2,material.files[0].url)).data,source);assert.equal(restored.data.files[0].id,material.files[0].id);
      const restoredScan=await request(teacher2,`/api/lesson-materials/${scanned.id}`);assert.equal(restoredScan.data.extractedCharacters,0);assert.equal(restoredScan.data.documents[0].text,'');
      const scanDownload=await fetch(base+scanned.files[0].url,{headers:{Cookie:teacher2.cookie}});assert.equal(scanDownload.status,200);assert.deepEqual(Buffer.from(await scanDownload.arrayBuffer()),Buffer.from(scanPdf));
      const report=await request(admin,'/api/attendance/analytics?from=2026-10-19&to=2026-10-21');assert.equal(report.data.totals.unconfirmed,4);assert.equal(report.data.totals.absent,1);assert.equal(report.data.sessions.find((s:TeachingSession)=>s.id==='analytics-completed').roster[0].name,'Историческое имя 1');
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});}
});
