import { test, expect, type Page } from '@playwright/test';
import type { GeneratedLesson, GeneratedLessonChapter, LessonCatalogItem, LessonMaterial, TeachingEvent, TeachingSession } from '../shared/types';

const generatedId='a'.repeat(32),materialId='b'.repeat(32),timestamp='2026-10-21T08:00:00.000Z';
const source:LessonMaterial={id:materialId,institutionId:'library-test',teacherId:'teacher-test',subjectId:'math',title:'Изменения вокруг нас',status:'stored',files:[{id:'file',name:'Лекция.pdf',mime:'application/pdf',size:18560,extractedCharacters:560,url:'/api/files/file'}],extractedCharacters:560,createdAt:timestamp,updatedAt:timestamp};
const builtin:LessonCatalogItem={id:'builtin:derivative',cinemaId:'derivative',title:'Производная: скорость изменений',subjectId:'math',durationMinutes:11,status:'ready'};
const chapter=(number:number):GeneratedLessonChapter=>({id:`scene-${number}`,title:number===1?'Скорость перемен':'Мгновенная скорость',narration:'Посмотрите на движение автомобиля. Его скорость показывает, как быстро меняется положение в пространстве.',scene:number===1?'concept':'chart',headline:number===1?'Изменения можно измерить':'Момент вместо интервала',labels:number===1?['Путь','Время']:['0','1'],values:number===1?[]:[0,1],example:'Автомобиль разгоняется на прямой дороге.',palette:number===1?'light':'dark',start:(number-1)*12,duration:12});

async function mockLibrary(page:Page,materials:LessonMaterial[]=[]){
  let lesson:GeneratedLesson|null=null;
  const approvals:number[]=[];
  const patches:GeneratedLesson[]=[];
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname,method=route.request().method();
    const respond=(json:unknown,status=200)=>route.fulfill({status,json});
    if(path==='/api/auth/me')return respond({user:{id:'teacher-test',name:'Саида Каримова',email:'teacher@example.test',role:'TEACHER',institutionId:'library-test',active:true},institutions:[{id:'library-test',name:'Университет',type:'UNIVERSITY',language:'ru',settings:{timezone:'Asia/Tashkent'}}],csrfToken:'library-csrf',ai:{configured:true,mode:'provider'}});
    if(path==='/api/university')return respond({date:url.searchParams.get('date'),semesters:[],events:[],sessions:[],groups:[],students:[],subjects:[{id:'math',institutionId:'library-test',name:'Математический анализ'}],rooms:[],teachers:[]});
    if(path==='/api/lesson-materials')return respond(materials);
    if(path==='/api/lesson-publications')return respond([]);
    if(path==='/api/lesson-catalog')return respond([builtin,...(lesson?[{id:`generated:${lesson.id}`,cinemaId:lesson.status==='ready'?`generated:${lesson.id}`:undefined,title:lesson.title,subjectId:'math',durationMinutes:1,status:lesson.status,materialId}]:[])]);
    if(path==='/api/generated-lessons')return respond(lesson?[lesson]:[]);
    if(path===`/api/lesson-materials/${materialId}/draft`){lesson={id:generatedId,institutionId:'library-test',teacherId:'teacher-test',subjectId:'math',materialId,title:source.title,summary:'Как производная описывает изменения',status:'drafting',revision:0,chapters:[],duration:24,progress:{stage:'script',completed:0,total:1},createdAt:timestamp,updatedAt:timestamp};return respond(lesson,202);}
    if(path===`/api/generated-lessons/${generatedId}`&&method==='PATCH'){
      const input=route.request().postDataJSON();
      expect(input.revision).toBe(lesson!.revision);
      expect(route.request().headers()['x-csrf-token']).toBe('library-csrf');
      lesson={...lesson!,...input,status:'draft',revision:lesson!.revision+1};patches.push(structuredClone(lesson!));return respond(lesson);
    }
    if(path===`/api/generated-lessons/${generatedId}/generate`){const input=route.request().postDataJSON();expect(input.revision).toBe(lesson!.revision);approvals.push(input.revision);lesson={...lesson!,status:'generating',revision:lesson!.revision+1,progress:{stage:'voice',completed:0,total:2}};return respond(lesson,202);}
    if(path===`/api/generated-lessons/${generatedId}`)return respond(lesson);
    return respond({error:'Не найдено'},404);
  });
  return {
    get lesson(){return lesson;},approvals,patches,
    review(){lesson={...lesson!,status:'draft',chapters:[chapter(1),chapter(2)],progress:{stage:'review',completed:1,total:1},revision:1};},
    progress(){lesson={...lesson!,progress:{stage:'voice',completed:1,total:2}};},
    ready(){lesson={...lesson!,status:'ready',progress:{stage:'ready',completed:2,total:2},revision:lesson!.revision+1};},
    fail(){lesson={...lesson!,status:'failed',error:'Не удалось подготовить озвучку. Повторите попытку.',progress:{stage:'failed',completed:0,total:2},revision:lesson!.revision+1};},
  };
}
async function library(page:Page){await page.goto('/teach');await page.getByRole('button',{name:'Уроки',exact:true}).click();await expect(page.getByRole('button',{name:'Смотреть урок Производная: скорость изменений'})).toBeVisible();}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}

test('teacher sees the built-in 3D film without uploaded materials and can filter the library',async({page})=>{
  await mockLibrary(page);await library(page);
  await expect(page.locator('.teach-history-row[data-film-id]')).toHaveCount(1);
  await expect(page.getByText('Первый урок',{exact:true})).toHaveCount(0);
  await page.getByLabel('Поиск урока').fill('производная');
  await expect(page.locator('.teach-history-row[data-film-id]')).toHaveCount(1);
  await page.getByLabel('Поиск урока').fill('несуществующий');
  await expect(page.getByRole('heading',{name:'Ничего не найдено'})).toBeVisible();
  await page.getByLabel('Поиск урока').fill('');
  await page.getByRole('button',{name:'Материалы',exact:false}).click();
  await expect(page.locator('.teach-history-row[data-film-id]')).toHaveCount(0);
  await page.getByRole('button',{name:'Готовые',exact:false}).click();
  await page.getByLabel('Язык уроков').selectOption('ru');
  await expect(page.locator('.teach-history-row[data-film-id]')).toHaveCount(1);
  await page.setViewportSize({width:390,height:844});await noOverflow(page);
});

test('teacher reviews a real contract draft, approves generation, sees failure and retries to a ready film',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const mock=await mockLibrary(page,[source]);
  await library(page);
  await page.getByRole('button',{name:'Материалы',exact:false}).click();
  await page.getByRole('button',{name:'Создать 3D-урок',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Создаём сценарий'})).toBeVisible();
  await expect(page.locator(`[data-generated-lesson-id="${generatedId}"]`)).toBeVisible();
  expect(mock.approvals).toHaveLength(0);
  mock.review();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Озвучка',{exact:true})).toBeVisible();
  await page.getByLabel('Название',{exact:true}).fill('Производная — сценарий проверен');
  await page.getByLabel('Озвучка',{exact:true}).fill('Измеряем скорость изменений. Производная показывает, как быстро меняется величина в выбранный момент времени.');
  await page.getByRole('button',{name:'Сцена 2: Мгновенная скорость'}).click();
  await expect(page.getByLabel('3D-сцена')).toHaveValue('chart');
  await page.getByLabel('Значения · через пробел').fill('1 4');
  await expect(page.getByLabel('Значения · через пробел')).toHaveValue('1 4');
  await page.setViewportSize({width:390,height:844});await noOverflow(page);
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.getByText('Сохранено',{exact:true})).toBeVisible();
  expect(mock.patches[0].title).toBe('Производная — сценарий проверен');
  expect(mock.patches[0].chapters[0].narration).toContain('Измеряем');
  expect(mock.patches[0].chapters[1].values).toEqual([1,4]);
  expect(mock.approvals).toHaveLength(0);
  await page.getByRole('button',{name:'Подготовить 3D-урок',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Озвучка и 3D-сцены'})).toBeVisible();
  expect(mock.approvals).toHaveLength(1);
  mock.progress();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('1 / 2 сцен подготовлено',{exact:true})).toBeVisible();
  mock.fail();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({hasText:'Не удалось подготовить озвучку'})).toBeVisible();
  await page.getByRole('button',{name:'Подготовить 3D-урок',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Озвучка и 3D-сцены'})).toBeVisible();
  expect(mock.approvals).toHaveLength(2);
  await page.getByRole('button',{name:'Закрыть сценарий'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  mock.ready();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('button',{name:'Все',exact:false}).click();
  await expect(page.getByRole('button',{name:'Смотреть урок Производная — сценарий проверен',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Все',exact:false}).click();
  await page.getByLabel('Поиск урока').fill('сценарий проверен');
  await expect(page.locator('.teach-history-row[data-film-id]')).toHaveCount(1);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

for(const cinemaId of ['derivative',`generated:${generatedId}`])test(`a timed ${cinemaId.startsWith('generated:')?'generated':'authored'} film starts attendance and keeps the two-minute camera timer`,async({page})=>{
  await mockLibrary(page);
  await page.addInitScript(()=>{
    (window as any).__cameraAttempts=0;(window as any).__cameraVideoAtScan=false;
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{(window as any).__cameraAttempts++;(window as any).__cameraVideoAtScan=!!document.querySelector('.teach-capture-video');throw new DOMException('Denied','NotAllowedError');}}});
  });
  await page.clock.install({time:new Date('2026-10-21T09:00:00.000Z')});
  const event:TeachingEvent={id:'timed-film-event',institutionId:'library-test',lessonId:'timed-film',subjectId:'math',groupId:'group-test',teacherId:'teacher-test',date:'2026-10-21',startsAt:'2026-10-21T09:00:00.000Z',endsAt:'2026-10-21T10:30:00.000Z',allDay:false,cinemaId,topic:{id:'topic-test',title:'Производная в движении',content:'Производная описывает мгновенную скорость изменения.',order:0}};
  let session:TeachingSession|null=null,starts=0,scans=0;
  await page.route('**/api/university?**',route=>route.fulfill({json:{date:'2026-10-21',semesters:[],events:[event],sessions:session?[session]:[],groups:[{id:'group-test',institutionId:'library-test',name:'ИС-21',teacherIds:['teacher-test']}],students:[{id:'student-test',institutionId:'library-test',name:'Тестовый Студент',groupId:'group-test'}],subjects:[{id:'math',institutionId:'library-test',name:'Математический анализ'}],rooms:[],teachers:[]}}));
  await page.route('**/api/teaching-sessions',async route=>{
    const startedAt=new Date(await page.evaluate(()=>Date.now())).toISOString();
    starts++;session={id:'class-test',institutionId:'library-test',eventId:event.id,event,teacherId:'teacher-test',groupId:'group-test',state:'live',startedAt,pausedMs:0,scanOffsets:[120,1200,2400,3600,5000],scans:[],attendance:[{studentId:'student-test',status:'unconfirmed',method:'camera'}],roster:[{studentId:'student-test',name:'Тестовый Студент'}],revision:0};return route.fulfill({json:session});
  });
  await page.route('**/api/teaching-sessions/class-test',route=>route.fulfill({json:session}));
  await page.route('**/api/teaching-sessions/class-test/scans',route=>{scans++;const input=route.request().postDataJSON();session={...session!,scans:[{...input,id:'scan-test',sessionId:'class-test'}],revision:session!.revision+1};return route.fulfill({json:session});});
  await page.route('**/api/cinema/derivative',route=>route.fulfill({json:{id:'derivative-test',title:'Производная',duration:600,chapters:[{id:'intro',title:'Изменения',scene:'intro',start:0,duration:600}],voice:{status:'ready',model:'test',voice:'test'}}}));
  const chapters=[chapter(1),chapter(2)].map((item,index)=>({...item,audioDuration:2,audioUrl:`/api/generated-lessons/${generatedId}/audio/${item.id}`,start:index*4.5,duration:4.5}));
  await page.route(`**/api/generated-lessons/${generatedId}/manifest`,route=>route.fulfill({json:{id:generatedId,title:'Производная в движении',summary:'',duration:9,chapters,voice:{status:'ready'}}}));
  const wave=Buffer.alloc(44+24000*2*2);wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(24000,24);wave.writeUInt32LE(48000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
  await page.route(`**/api/generated-lessons/${generatedId}/audio/**`,route=>route.fulfill({body:wave,contentType:'audio/wav'}));
  await page.goto('/teach');
  await page.getByRole('button',{name:'Начать занятие',exact:true}).click();
  await expect(page).toHaveURL(/session=class-test/);
  await expect(page.locator('.teach-capture-video')).toBeAttached();
  if(cinemaId.startsWith('generated:')){
    await expect(page.locator('.teach-live>.generated-film')).toBeVisible();
    await expect(page.locator('.teach-live-board')).toBeAttached();
    expect(await page.evaluate(()=>!!document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('.generated-film'))).toBe(true);
  }else await expect(page.locator('.teach-cinema-session>.derivative-film')).toBeVisible();
  expect(starts).toBe(1);
  const elapsed=(await page.evaluate(()=>Date.now()))-Date.parse(session!.startedAt);
  await page.clock.fastForward(Math.max(0,119000-elapsed));
  expect(await page.evaluate(()=>(window as any).__cameraAttempts)).toBe(0);
  await page.clock.fastForward(2000);
  await expect.poll(()=>page.evaluate(()=>(window as any).__cameraAttempts)).toBe(1);
  await expect.poll(()=>scans).toBe(1);
  expect(await page.evaluate(()=>(window as any).__cameraVideoAtScan)).toBe(true);
  expect(session!.attendance[0].status).toBe('unconfirmed');
  if(cinemaId.startsWith('generated:')){
    await page.getByRole('button',{name:'Закрыть урок',exact:true}).click();
    await expect(page.locator('.teach-live>.generated-film')).toHaveCount(0);
    await page.getByRole('button',{name:'Открыть 3D-урок',exact:true}).click();
    await expect(page.locator('.teach-live>.generated-film')).toBeVisible();
    expect(starts).toBe(1);expect(scans).toBe(1);
    await page.getByRole('button',{name:'Закрыть урок',exact:true}).click();
    await page.reload();
    await expect(page.getByRole('button',{name:'Открыть 3D-урок',exact:true})).toBeVisible();
    await expect(page.locator('.teach-live>.generated-film')).toHaveCount(0);
  }
});
