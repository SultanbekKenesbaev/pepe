import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { pcmWave } from '../server/cinema.js';
import type { GeneratedLessonChapter } from '../shared/types.js';

test('catalog, reviewed generation and administrator calendar preserve ownership and history',{timeout:120000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'platform-'));
  let scriptCalls=0,voiceCalls:string[]=[],failScript=false,failVoice=false;
  const wave=pcmWave(Buffer.alloc(24000*2*2));
  const script={title:'Производная: скорость изменения',summary:'Связь изменения координаты и скорости.',chapters:[
    {id:'motion',title:'Движение',narration:'Координата меняется со временем. Производная координаты показывает мгновенную скорость движения.',scene:'concept',headline:'Изменение в каждый момент',labels:['Время','Координата','Скорость'],values:[],palette:'dark'},
    {id:'example',title:'Пример',narration:'Для координаты эс от тэ равной тэ в квадрате скорость равна двум тэ. При тэ равном трём скорость равна шести.',scene:'chart',headline:'При t = 3 скорость равна 6',formula:'s(t)=t²; v(t)=2t',labels:['t=1','t=2','t=3'],values:[2,4,6],example:'Движение по прямой',palette:'light'},
  ]};
  const generation={scriptProvider:async()=>{scriptCalls++;if(failScript)throw new Error('provider failed with private debug detail');return structuredClone(script);},voiceProvider:async(chapter:GeneratedLessonChapter)=>{voiceCalls.push(chapter.id);if(failVoice&&chapter.id==='example')throw new Error('provider failed');return wave;}};
  let app=await createApp({dataDir:temporary,seedDemo:true,generation}),server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));
  let base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string;user:any};
  const request=async(client:Client|null,url:string,method='GET',body?:any)=>{
    const headers:Record<string,string>={};if(client){headers.Cookie=client.cookie;if(method!=='GET')headers['X-CSRF-Token']=client.csrf;}
    if(body!==undefined&&!(body instanceof FormData))headers['Content-Type']='application/json';
    const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());return {status:response.status,data,response};
  };
  const login=async(email:string,password:string):Promise<Client>=>{const response=await request(null,'/api/auth/login','POST',{email,password});assert.equal(response.status,200);return {cookie:response.response.headers.get('set-cookie')!.split(';')[0],csrf:response.data.csrfToken,user:response.data.user};};
  const waitStatus=async(client:Client,id:string,status:string)=>{for(let attempt=0;attempt<200;attempt++){const result=await request(client,`/api/generated-lessons/${id}`);assert.equal(result.status,200);if(result.data.status===status)return result.data;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail(`Timed out waiting for ${status}`);};
  let admin:Client,teacher:Client,other:Client,second:Client,material:any,generated:any,week:any,legacy:any;
  const range={lessonId:'builtin:derivative',groupId:'demo-group-7a',teacherId:'demo-teacher',from:'2027-01-04',to:'2027-01-10',weekdays:[1,2,3,4,5,6,7],allDay:true};
  try{
    admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');other=await login('other@aiteacher.local','PepeOnly-external-teacher-2026!');
    const created=await request(admin,'/api/users','POST',{institutionId:'demo-school',name:'Второй преподаватель',email:'platform@university.test',role:'TEACHER',active:true,password:'Platform2026!',groupIds:[]});assert.equal(created.status,201);second=await login('platform@university.test','Platform2026!');
    legacy=(await app.locals.db.query("SELECT data FROM entities WHERE id='demo-schedule'")).rows[0].data;

    await t.test('operations status is admin-only, bounded and never returns private backup details',async()=>{
      const previous=process.env.OPERATIONS_STATUS_FILE,file=path.join(temporary,'private-operations.json');
      try{
        delete process.env.OPERATIONS_STATUS_FILE;
        assert.equal((await request(admin,'/api/operations/status')).data.backup.status,'never');
        process.env.OPERATIONS_STATUS_FILE=file;
        assert.equal((await request(null,'/api/operations/status')).status,401);assert.equal((await request(teacher,'/api/operations/status')).status,403);
        const lastAttemptAt='2026-10-21T03:00:00+05:00',lastSuccessAt='2026-10-20T03:00:00+05:00';
        await writeFile(file,JSON.stringify({status:'success',lastAttemptAt,lastSuccessAt,path:'/private/backup/database',error:'Internal credential detail',key:'secret-test'}));
        const success=await request(admin,'/api/operations/status');assert.equal(success.status,200);assert.deepEqual(success.data.backup,{status:'success',lastAttemptAt:new Date(lastAttemptAt).toISOString(),lastSuccessAt:new Date(lastSuccessAt).toISOString()});assert.ok(Number.isFinite(Date.parse(success.data.serverTime)));assert.doesNotMatch(JSON.stringify(success.data),/private|credential|secret-test/);
        await writeFile(file,JSON.stringify({status:'running',lastAttemptAt:new Date(Date.now()-31*60000).toISOString(),lastSuccessAt:'invalid-date',path:'/private/backup'}));const stale=await request(admin,'/api/operations/status');assert.equal(stale.data.backup.status,'failed');assert.equal(stale.data.backup.lastSuccessAt,undefined);
        await writeFile(file,JSON.stringify({status:'running',lastAttemptAt:'invalid-date'}));assert.deepEqual((await request(admin,'/api/operations/status')).data.backup,{status:'failed'});
        await writeFile(file,'not JSON');assert.deepEqual((await request(admin,'/api/operations/status')).data.backup,{status:'failed'});
        await writeFile(file,JSON.stringify({status:'garbage',path:'/private/backup'}));assert.deepEqual((await request(admin,'/api/operations/status')).data.backup,{status:'failed'});
      }finally{if(previous===undefined)delete process.env.OPERATIONS_STATUS_FILE;else process.env.OPERATIONS_STATUS_FILE=previous;}
    });

    await t.test('the 3D library is available even without uploaded documents and calendar writes are admin-only',async()=>{
      const catalog=await request(teacher,'/api/lesson-catalog');assert.equal(catalog.status,200);assert.ok(catalog.data.some((item:any)=>item.id==='builtin:derivative'&&item.status==='ready'));assert.equal(catalog.data.some((item:any)=>item.id==='demo-photosynthesis'),false);
      assert.equal((await request(other,'/api/lesson-catalog?institutionId=demo-school')).status,403);
      assert.equal((await request(null,'/api/lesson-catalog')).status,401);
      assert.equal((await request(teacher,'/api/schedule/events','POST',range)).status,403);
      const result=await request(admin,'/api/schedule/events','POST',range);assert.equal(result.status,201,JSON.stringify(result.data));week=result.data;
      assert.equal(week.created.length,7);assert.equal(week.skipped.length,0);assert.ok(week.created.every((item:any)=>item.revision===0));
      for(const item of week.created){const university=await request(teacher,`/api/university?date=${item.date}`);const event=university.data.events.find((event:any)=>event.scheduleItemId===item.id);assert.ok(event);assert.equal(event.allDay,true);assert.equal(event.cinemaId,'derivative');assert.equal(Date.parse(event.endsAt)-Date.parse(event.startsAt),86400000);assert.equal(event.scheduleRevision,0);}
      const repeated=await request(admin,'/api/schedule/events','POST',range);assert.equal(repeated.status,200);assert.equal(repeated.data.created.length,0);assert.deepEqual(repeated.data.skipped.map((item:any)=>item.id),week.created.map((item:any)=>item.id));
      assert.deepEqual((await app.locals.db.query("SELECT data FROM entities WHERE id='demo-schedule'")).rows[0].data,legacy);
    });

    await t.test('range creation is atomic, validates foreign references, and concurrent duplicates retain original IDs',async()=>{
      const snapshot=(await app.locals.db.query("SELECT id FROM entities WHERE kind='schedule' ORDER BY id")).rows;
      for(const body of [{...range,to:'2028-02-01'},{...range,from:'2027-02-30'},{...range,to:'2027-01-01'},{...range,groupId:'other-group'},{...range,teacherId:other.user.id},{...range,weekdays:[]},{...range,allDay:false,startTime:'23:45',durationMinutes:90}])assert.ok((await request(admin,'/api/schedule/events','POST',body)).status>=400,JSON.stringify(body));
      assert.deepEqual((await app.locals.db.query("SELECT id FROM entities WHERE kind='schedule' ORDER BY id")).rows,snapshot);
      const responses=await Promise.all([request(admin,'/api/schedule/events','POST',{...range,from:'2027-02-01',to:'2027-02-07'}),request(admin,'/api/schedule/events','POST',{...range,from:'2027-02-01',to:'2027-02-07'})]);
      assert.equal(responses.reduce((total,response)=>total+response.data.created.length,0),7);assert.equal(responses.reduce((total,response)=>total+response.data.skipped.length,0),7);
      const timed={...range,lessonId:'demo-photosynthesis',from:'2027-03-01',to:'2027-03-01',allDay:false,startTime:'09:00',durationMinutes:90};
      assert.equal((await request(admin,'/api/schedule/events','POST',timed)).status,201);
      const count=(await app.locals.db.query("SELECT COUNT(*)::int AS count FROM entities WHERE kind='schedule'")).rows[0].count;
      const conflict=await request(admin,'/api/schedule/events','POST',{...timed,from:'2027-02-28',to:'2027-03-02',startTime:'09:30'});assert.equal(conflict.status,409);assert.equal(conflict.data.code,'SCHEDULE_CONFLICT');
      assert.equal((await app.locals.db.query("SELECT COUNT(*)::int AS count FROM entities WHERE kind='schedule'")).rows[0].count,count);
    });

    await t.test('single edits require the current revision and cancellation keeps history',async()=>{
      const item=week.created[0];const updated=await request(admin,`/api/schedule/events/${item.id}`,'PATCH',{revision:0,date:'2027-01-11',allDay:false,startTime:'15:00',durationMinutes:45,roomId:null});assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.revision,1);assert.equal(updated.data.date,'2027-01-11');assert.equal(updated.data.durationMinutes,45);
      assert.equal((await request(admin,`/api/schedule/events/${item.id}`,'PATCH',{revision:0,date:'2027-01-12'})).status,409);
      assert.equal((await request(teacher,`/api/schedule/events/${item.id}`,'DELETE')).status,403);
      assert.equal((await request(admin,`/api/schedule/events/${item.id}?revision=0`,'DELETE')).status,409);
      const cancelled=await request(admin,`/api/schedule/events/${item.id}?revision=1`,'DELETE');assert.equal(cancelled.status,200);assert.equal(cancelled.data.cancelled,true);assert.equal(cancelled.data.revision,2);
      assert.equal((await request(teacher,'/api/university?date=2027-01-11')).data.events.some((event:any)=>event.scheduleItemId===item.id),false);
      assert.equal((await request(admin,'/api/schedule/events?from=2027-01-04&to=2027-01-11')).data.some((entry:any)=>entry.id===item.id),false);
      assert.equal((await request(admin,'/api/schedule/events?from=2027-01-04&to=2027-01-11&includeCancelled=true')).data.find((entry:any)=>entry.id===item.id).cancelled,true);
      assert.equal((await app.locals.db.query('SELECT data FROM entities WHERE id=$1',[item.id])).rows[0].data.cancelled,true);
    });

    await t.test('completed attendance survives a later schedule edit and cancellation',async()=>{
      const created=await request(admin,'/api/schedule/events','POST',{...range,lessonId:'demo-photosynthesis',from:'2027-04-01',to:'2027-04-01',allDay:false,startTime:'12:00',durationMinutes:45});assert.equal(created.status,201);const item=created.data.created[0];
      const event=(await request(teacher,'/api/university?date=2027-04-01')).data.events.find((event:any)=>event.scheduleItemId===item.id);
      const session=await request(teacher,'/api/teaching-sessions','POST',{eventId:event.id,date:event.date});assert.equal(session.status,201);
      assert.equal((await request(admin,`/api/schedule/events/${item.id}?revision=0`,'DELETE')).status,409);
      const completed=await request(teacher,`/api/teaching-sessions/${session.data.id}/action`,'POST',{action:'complete',revision:session.data.revision});assert.equal(completed.status,200);
      const snapshot=structuredClone(completed.data);assert.equal((await request(admin,`/api/schedule/events/${item.id}`,'PATCH',{revision:0,date:'2027-04-02',startTime:'12:30'})).status,200);
      assert.equal((await request(admin,`/api/schedule/events/${item.id}?revision=1`,'DELETE')).status,200);
      assert.deepEqual((await request(teacher,`/api/teaching-sessions/${session.data.id}`)).data,snapshot);
    });

    await t.test('generation requires configured tenant approval and a genuine source, while scripts are durable and idempotent',async()=>{
      const form=new FormData();form.set('title',script.title);form.set('subjectId','demo-biology');form.set('files',new Blob(['Производная координаты по времени является мгновенной скоростью. Для s(t)=t², v(t)=2t; при t=1,2,3 скорость равна2,4,6.']),'lesson.txt');
      const uploaded=await request(teacher,'/api/lesson-materials','POST',form);assert.equal(uploaded.status,201);material=uploaded.data;
      assert.equal((await request(teacher,`/api/lesson-materials/${material.id}/draft`,'POST',{})).status,403);
      assert.equal((await request(admin,'/api/institutions/demo-school','PATCH',{settings:{allowExternalAI:true}})).status,200);
      assert.equal((await request(second,`/api/lesson-materials/${material.id}/draft`,'POST',{})).status,403);
      failScript=true;const failed=await request(teacher,`/api/lesson-materials/${material.id}/draft`,'POST',{});assert.equal(failed.status,202);generated=await waitStatus(teacher,failed.data.id,'failed');assert.equal(generated.chapters.length,0);assert.doesNotMatch(generated.error,/private debug/);
      assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}/manifest`)).status,409);
      failScript=false;const retried=await request(teacher,`/api/lesson-materials/${material.id}/draft`,'POST',{});assert.equal(retried.status,202);assert.equal(retried.data.id,generated.id);generated=await waitStatus(teacher,generated.id,'draft');
      const repeated=await request(teacher,`/api/lesson-materials/${material.id}/draft`,'POST',{});assert.equal(repeated.status,200);assert.equal(scriptCalls,2);assert.equal(repeated.data.id,generated.id);
      assert.equal(generated.progress.stage,'review');assert.equal(generated.chapters.length,2);assert.equal(generated.chapters[0].audioUrl,undefined);
      assert.equal((await request(other,`/api/generated-lessons/${generated.id}`)).status,403);assert.equal((await request(second,`/api/generated-lessons/${generated.id}`)).status,403);
      assert.equal((await request(second,'/api/lesson-catalog')).data.some((item:any)=>item.id===`generated:${generated.id}`),false);
      assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}`,'PATCH',{...script,revision:generated.revision-1})).status,409);
      assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}`,'PATCH',{...script,revision:generated.revision,chapters:[{...script.chapters[0],id:'../outside'},script.chapters[1]]})).status,400);
      assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}`,'PATCH',{...script,revision:generated.revision,chapters:[{...script.chapters[0],scene:'comparison',values:[1]},script.chapters[1]]})).status,400);
      const edited=await request(teacher,`/api/generated-lessons/${generated.id}`,'PATCH',{...script,title:'Проверенный сценарий',revision:generated.revision});assert.equal(edited.status,200);generated=edited.data;assert.equal(generated.title,'Проверенный сценарий');
    });

    await t.test('approved narration is real WAV, failures never become ready, and retry reuses finished audio',async()=>{
      failVoice=true;const started=await request(teacher,`/api/generated-lessons/${generated.id}/generate`,'POST',{revision:generated.revision});assert.equal(started.status,202);generated=await waitStatus(teacher,generated.id,'failed');assert.equal(generated.progress.completed,1);assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}/manifest`)).status,409);
      assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}/audio/motion`)).status,404);
      failVoice=false;const retry=await request(teacher,`/api/generated-lessons/${generated.id}/generate`,'POST',{revision:generated.revision});assert.equal(retry.status,202);generated=await waitStatus(teacher,generated.id,'ready');
      assert.deepEqual(voiceCalls,['motion','example','example']);assert.equal(generated.duration,9);assert.equal(generated.chapters[0].start,0);assert.equal(generated.chapters[1].start,4.5);assert.equal(generated.chapters[0].audioDuration,2);
      const manifest=await request(second,`/api/generated-lessons/${generated.id}/manifest`);assert.equal(manifest.status,200);assert.equal(manifest.data.voice.status,'ready');assert.equal(manifest.data.chapters.length,2);
      const audio=await request(second,manifest.data.chapters[0].audioUrl);assert.equal(audio.status,200);assert.deepEqual(audio.data,wave);
      assert.equal((await request(other,manifest.data.chapters[0].audioUrl)).status,403);assert.equal((await request(null,manifest.data.chapters[0].audioUrl)).status,401);
      const catalog=await request(second,'/api/lesson-catalog');const item=catalog.data.find((item:any)=>item.id===`generated:${generated.id}`);assert.equal(item.status,'ready');assert.equal(item.cinemaId,`generated:${generated.id}`);assert.equal(item.lessonId,generated.lessonId);
      assert.equal((await request(teacher,`/api/generated-lessons/${generated.id}`,'PATCH',{...script,revision:generated.revision})).status,409);
      const scheduled=await request(admin,'/api/schedule/events','POST',{...range,lessonId:`generated:${generated.id}`,from:'2027-05-01',to:'2027-05-01'});assert.equal(scheduled.status,201,JSON.stringify(scheduled.data));
      const event=(await request(teacher,'/api/university?date=2027-05-01')).data.events.find((event:any)=>event.lessonId===generated.lessonId);assert.equal(event.allDay,true);assert.equal(event.cinemaId,`generated:${generated.id}`);
      assert.equal((await request(admin,`/api/data/subjects/${generated.subjectId}`,'DELETE')).status,409);
    });

    await t.test('restart preserves ready scripts, audio, calendar IDs and cancellation metadata',async()=>{
      const before=(await request(admin,'/api/schedule/events?from=2027-01-04&to=2027-05-01&includeCancelled=true')).data;
      await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();app=await createApp({dataDir:temporary,seedDemo:false,generation});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;
      teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');
      const restored=await request(teacher,`/api/generated-lessons/${generated.id}`);assert.deepEqual(restored.data,generated);assert.deepEqual((await request(teacher,generated.chapters[0].audioUrl)).data,wave);
      assert.deepEqual((await request(admin,'/api/schedule/events?from=2027-01-04&to=2027-05-01&includeCancelled=true')).data,before);assert.deepEqual(await readFile(path.join(temporary,'generated',generated.id,'motion.wav')),wave);
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});}
});
