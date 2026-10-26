import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';

test('dated 3D viewing schedules cover calendar days without starting attendance',{timeout:120000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'viewing-schedule-'));
  const app=await createApp({dataDir:temporary,seedDemo:true});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  type Client={cookie:string;csrf:string;user:any};
  const request=async(client:Client|null,url:string,method='GET',body?:any)=>{
    const headers:Record<string,string>={};
    if(client){headers.Cookie=client.cookie;if(method!=='GET')headers['X-CSRF-Token']=client.csrf;}
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),response};
  };
  const login=async(email:string,password:string):Promise<Client>=>{
    const result=await request(null,'/api/auth/login','POST',{email,password});assert.equal(result.status,200);
    return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken,user:result.data.user};
  };
  try{
    const admin=await login('admin@aiteacher.local','PepeOnly-admin-2026!');
    const teacher=await login('demo@aiteacher.local','PepeOnly-teacher-2026!');
    const other=await login('other@aiteacher.local','PepeOnly-external-teacher-2026!');
    const secondCreated=await request(admin,'/api/users','POST',{institutionId:'demo-school',name:'Другой преподаватель',email:'viewing@university.test',role:'TEACHER',active:true,password:'Viewing2026!',groupIds:['demo-group-7a']});
    assert.equal(secondCreated.status,201);
    const second=await login('viewing@university.test','Viewing2026!');
    const lessonBody={institutionId:'demo-school',name:'Производная: 3D-урок',subjectId:'demo-biology',duration:11,language:'ru',sections:[{id:'intro',title:'Производная',content:'Скорость изменения функции.',materialIds:[]}],quiz:[],approved:true};
    const cinema=await request(admin,'/api/data/lessons','POST',{...lessonBody,cinemaId:'derivative'});assert.equal(cinema.status,201,JSON.stringify(cinema.data));
    const ordinary=await request(admin,'/api/data/lessons','POST',{...lessonBody,name:'Обычная пара',duration:90});assert.equal(ordinary.status,201);
    const schedule=(lessonId:string,startsAt:string,allDay?:boolean)=>({institutionId:'demo-school',name:'Производная · просмотр',lessonId,groupId:'demo-group-7a',teacherId:teacher.user.id,startsAt,...(allDay===undefined?{}:{allDay})});
    const dates=Array.from({length:7},(_,day)=>new Date(Date.parse('2026-10-21')+day*86400000).toISOString().slice(0,10));
    const ids:string[]=[];

    await t.test('seven dated entries expose exact local midnight boundaries to teacher and administrator',async()=>{
      for(const date of dates){
        // Even a non-midnight input denotes the same whole local calendar day.
        const created=await request(admin,'/api/data/schedule','POST',schedule(cinema.data.id,`${date}T14:15:00+05:00`,true));
        assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.allDay,true);ids.push(created.data.id);
      }
      for(const [index,date] of dates.entries()){
        const teacherData=await request(teacher,`/api/university?date=${date}`);assert.equal(teacherData.status,200);
        const event=teacherData.data.events.find((item:any)=>item.id===`schedule:${ids[index]}:${date}`);
        assert.ok(event);assert.equal(event.allDay,true);assert.equal(event.cinemaId,'derivative');
        assert.equal(event.startsAt,new Date(`${date}T00:00:00+05:00`).toISOString());
        assert.equal(Date.parse(event.endsAt)-Date.parse(event.startsAt),86400000);
        assert.equal(event.endsAt,new Date(Date.parse(`${date}T00:00:00+05:00`)+86400000).toISOString());
        const adminData=await request(admin,`/api/university?date=${date}`);
        assert.deepEqual(adminData.data.events.find((item:any)=>item.id===event.id),event);
      }
      for(const date of ['2026-10-20','2026-10-28']){
        const result=await request(teacher,`/api/university?date=${date}`);assert.equal(result.status,200);
        assert.equal(result.data.events.some((item:any)=>item.lessonId===cinema.data.id),false);
      }
    });

    await t.test('ordinary classes retain their start, duration and attendance flow',async()=>{
      const startsAt='2026-10-21T13:00:00+05:00';
      const created=await request(admin,'/api/data/schedule','POST',schedule(ordinary.data.id,startsAt));assert.equal(created.status,201);
      const data=await request(teacher,'/api/university?date=2026-10-21');
      const event=data.data.events.find((item:any)=>item.id===`schedule:${created.data.id}:2026-10-21`);
      assert.equal(event.startsAt,startsAt);assert.equal(Date.parse(event.endsAt)-Date.parse(event.startsAt),90*60000);
      assert.equal(event.allDay,undefined);assert.equal(event.cinemaId,undefined);
      const started=await request(teacher,'/api/teaching-sessions','POST',{eventId:event.id,date:event.date});assert.equal(started.status,201);
      assert.ok(started.data.attendance.length);assert.equal(started.data.state,'live');
    });

    await t.test('viewing cannot create attendance, unsupported cinema identifiers and foreign access are rejected',async()=>{
      const before=(await app.locals.db.query('SELECT COUNT(*)::int AS count FROM teaching_sessions')).rows[0].count;
      const result=await request(teacher,'/api/teaching-sessions','POST',{eventId:`schedule:${ids[0]}:${dates[0]}`,date:dates[0]});
      assert.equal(result.status,409);assert.equal(result.data.code,'VIEWING_ONLY');
      assert.equal((await app.locals.db.query('SELECT COUNT(*)::int AS count FROM teaching_sessions')).rows[0].count,before);
      assert.equal((await request(admin,'/api/data/schedule','POST',schedule(ordinary.data.id,'2026-10-21T00:00:00+05:00',true))).status,400);
      assert.equal((await request(admin,'/api/data/lessons','POST',{...lessonBody,cinemaId:'unknown-film'})).status,400);
      assert.equal((await request(other,'/api/university?institutionId=demo-school&date=2026-10-21')).status,403);
      assert.equal((await request(second,'/api/university?date=2026-10-21')).data.events.some((item:any)=>item.lessonId===cinema.data.id),false);
      assert.equal((await request(second,'/api/data/schedule','POST',schedule(cinema.data.id,'2026-10-21T00:00:00+05:00',true))).status,403);
    });

    await t.test('whole-day boundaries use the institution calendar across daylight-saving changes',async()=>{
      assert.equal((await request(admin,'/api/institutions/demo-school','PATCH',{settings:{timezone:'America/New_York'}})).status,200);
      const created=await request(admin,'/api/data/schedule','POST',schedule(cinema.data.id,'2026-03-08T12:00:00-04:00',true));assert.equal(created.status,201);
      const result=await request(teacher,'/api/university?date=2026-03-08');
      const event=result.data.events.find((item:any)=>item.id===`schedule:${created.data.id}:2026-03-08`);
      assert.equal(event.startsAt,'2026-03-08T05:00:00.000Z');assert.equal(event.endsAt,'2026-03-09T04:00:00.000Z');
      assert.equal(Date.parse(event.endsAt)-Date.parse(event.startsAt),23*60*60*1000);
    });
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));await app.locals.close();await rm(temporary,{recursive:true,force:true});
  }
});
