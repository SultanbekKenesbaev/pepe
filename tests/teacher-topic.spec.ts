import { test, expect, type Page } from '@playwright/test';
import type { GeneratedLesson, GeneratedLessonChapter } from '../shared/types';

const lessonId='d'.repeat(32),stamp='2026-10-21T08:00:00.000Z';
const chapter:GeneratedLessonChapter={id:'voice-1',title:'Мысал',narration:'Синтетический текст для проверки интерфейса.',scene:'custom',headline:'Тест',labels:[],values:[],palette:'dark',start:0,duration:10,audioDuration:10,audioUrl:`/api/generated-lessons/${lessonId}/audio/voice-1`};
function makeLesson(title:string,language:'ru'|'kaa'|'uz',status:GeneratedLesson['status']='generating',videoMode?:GeneratedLesson['videoMode']):GeneratedLesson{return{id:lessonId,institutionId:'topic-test',teacherId:'teacher-test',subjectId:'authors',title,language,videoMode,engine:'codex',targetDuration:600,materialIds:[],summary:'',status,revision:0,chapters:status==='language_review'?[chapter]:[],duration:0,progress:{stage:status==='language_review'?'language_review':'planning',completed:0,total:1},createdAt:stamp,updatedAt:stamp};}

async function setup(page:Page,options:{initial?:GeneratedLesson;createdStatus?:GeneratedLesson['status'];createdStage?:GeneratedLesson['progress']['stage']}={}){
  let lesson=options.initial||null;
  const creates:any[]=[],publications:any[]=[],approvals:any[]=[],retries:any[]=[],uploads:any[]=[],attendance:string[]=[];
  await page.addInitScript(()=>{(window as any).__cameraAttempts=0;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{(window as any).__cameraAttempts++;throw new Error('Unexpected camera');}}});});
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    const respond=(json:unknown,status=200)=>route.fulfill({status,json});
    if(path.includes('/teaching-sessions')&&method==='POST')attendance.push(path);
    if(path==='/api/auth/me')return respond({user:{id:'teacher-test',name:'Саида Каримова',email:'teacher@example.test',role:'TEACHER',institutionId:'topic-test',active:true},institutions:[{id:'topic-test',name:'Университет',type:'UNIVERSITY',language:'ru',settings:{timezone:'Asia/Tashkent'}}],csrfToken:'topic-csrf',ai:{configured:true,mode:'provider'}});
    if(path==='/api/university')return respond({date:url.searchParams.get('date'),semesters:[],events:[],sessions:[],groups:[],students:[],subjects:[],rooms:[],teachers:[]});
    if(path==='/api/lesson-materials'&&method==='GET')return respond([]);
    if(path==='/api/lesson-materials'&&method==='POST'){uploads.push(request.postData());return respond({id:'material-test',institutionId:'topic-test',teacherId:'teacher-test',subjectId:'authors',title:'Источник',status:'stored',files:[],extractedCharacters:100,createdAt:stamp,updatedAt:stamp},201);}
    if(path==='/api/lesson-catalog')return respond([{id:'builtin:derivative',cinemaId:'derivative',title:'Производная: 3D-урок',subjectId:'',durationMinutes:11,status:'ready'},...(lesson?[{id:`generated:${lesson.id}`,cinemaId:lesson.status==='ready'?`generated:${lesson.id}`:undefined,title:lesson.title,subjectId:lesson.subjectId,durationMinutes:10,status:lesson.status,language:lesson.language,videoMode:lesson.videoMode,createdAt:lesson.createdAt,teacherId:lesson.teacherId}]:[])]);
    if(path==='/api/generated-lessons'&&method==='GET')return respond(lesson?[lesson]:[]);
    if(path==='/api/generated-lessons'&&method==='POST'){const body=request.postDataJSON();expect(request.headers()['x-csrf-token']).toBe('topic-csrf');creates.push(body);lesson=makeLesson(body.title,body.language,options.createdStatus,body.videoMode);if(options.createdStage)lesson.progress={stage:options.createdStage,completed:0,total:1};return respond(lesson,202);}
    if(path===`/api/generated-lessons/${lessonId}`)return respond(lesson);
    if(path===`/api/generated-lessons/${lessonId}/publication`){const body=request.postDataJSON();expect(body.revision).toBe(lesson!.revision);publications.push(body);lesson={...lesson!,publication:body.startsAt?{startsAt:body.startsAt,...(body.endsAt?{endsAt:body.endsAt}:{}),timezone:body.timezone}:undefined,revision:lesson!.revision+1};return respond(lesson);}
    if(path===`/api/generated-lessons/${lessonId}/language-approval`){const body=request.postDataJSON();expect(body.revision).toBe(lesson!.revision);approvals.push(body);lesson={...lesson!,status:'generating',revision:lesson!.revision+1,progress:{stage:'visuals',completed:0,total:1},languageReview:{required:true,approvedAt:new Date().toISOString(),approvedBy:'teacher-test'}};return respond(lesson,202);}
    if(path===`/api/generated-lessons/${lessonId}/retry`){const body=request.postDataJSON();expect(body.revision).toBe(lesson!.revision);retries.push(body);lesson={...lesson!,status:'generating',error:undefined,revision:lesson!.revision+1,progress:{stage:'planning',completed:0,total:1}};return respond(lesson,202);}
    if(path==='/api/lesson-publications'){const publication=lesson?.publication,now=Date.now();return respond(lesson?.status==='ready'&&publication?.startsAt&&Date.parse(publication.startsAt)<=now&&(!publication.endsAt||Date.parse(publication.endsAt)>now)?[lesson]:[]);}
    return respond({error:'Не найдено'},404);
  });
  return{creates,publications,approvals,retries,uploads,attendance,get lesson(){return lesson;},ready(){lesson={...lesson!,status:'ready',duration:600,chapters:[chapter],progress:{stage:'ready',completed:1,total:1},revision:lesson!.revision+1,publication:{startsAt:'2020-01-01T00:00:00Z',endsAt:'2020-01-02T00:00:00Z',timezone:'Asia/Tashkent'},artifact:{videoUrl:`/api/generated-lessons/${lessonId}/video`,duration:600,width:1920,height:1080,fps:30,sha256:'a'.repeat(64)}};}};
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}

test('video format supports keyboard selection, keeps retries and defaults to 2D on a new creation',async({page},testInfo)=>{
  await setup(page);await page.goto('/teach');
  await page.getByRole('button',{name:'Создать урок',exact:true}).first().click();
  const create=page.getByRole('dialog',{name:'Создать урок'}),twoD=create.getByRole('radio',{name:'2D видео',exact:true}),threeD=create.getByRole('radio',{name:'3D видео',exact:true});
  await expect(create.getByRole('radiogroup',{name:'Формат',exact:true})).toBeVisible();
  await expect(twoD).toBeChecked();await twoD.focus();await page.keyboard.press('ArrowRight');await expect(threeD).toBeChecked();await expect(threeD).toBeFocused();
  await page.keyboard.press('ArrowLeft');await expect(twoD).toBeChecked();await page.keyboard.press('ArrowRight');
  await create.getByLabel('Тема',{exact:true}).fill('Массивы в программировании');
  const attempts:any[]=[];
  await page.route('**/api/generated-lessons',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    attempts.push(route.request().postDataJSON());
    return route.fulfill({status:503,json:{error:'Временно недоступно',code:'CODEX_BUSY'}});
  });
  await create.getByRole('button',{name:'Создать урок',exact:true}).click();await expect(create.getByRole('alert')).toContainText('Временно недоступно');
  await expect(threeD).toBeChecked();await expect(create.getByLabel('Тема',{exact:true})).toHaveValue('Массивы в программировании');
  await create.getByRole('button',{name:'Создать урок',exact:true}).click();await expect.poll(()=>attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);expect(attempts[1].videoMode).toBe('3d');
  await twoD.check();await create.getByRole('button',{name:'Создать урок',exact:true}).click();await expect.poll(()=>attempts.length).toBe(3);
  expect(attempts[2].videoMode).toBe('2d');expect(attempts[2].idempotencyKey).not.toBe(attempts[1].idempotencyKey);
  await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath('video-mode-mobile.png'),fullPage:false,animations:'disabled'});
  await create.getByRole('button',{name:'Закрыть создание урока',exact:true}).click();
  await page.getByRole('button',{name:'Создать урок',exact:true}).first().click();await expect(twoD).toBeChecked();await expect(create.getByLabel('Тема',{exact:true})).toBeEmpty();
});

test('2D generation labels its scenes without showing voice confirmation',async({page})=>{
  const mock=await setup(page,{createdStatus:'generating',createdStage:'visuals'});await page.goto('/teach');
  await page.getByRole('button',{name:'Создать урок',exact:true}).first().click();const create=page.getByRole('dialog',{name:'Создать урок'});
  await create.getByLabel('Тема',{exact:true}).fill('Массивы');await create.getByRole('button',{name:'Создать урок',exact:true}).click();
  const progress=page.getByRole('dialog',{name:'Создание урока',exact:true});await expect(progress.getByRole('heading',{name:'2D-сцены',exact:true})).toBeVisible();
  await expect(progress.getByRole('checkbox')).toHaveCount(0);expect(mock.creates[0].videoMode).toBe('2d');
  await progress.getByRole('button',{name:'Закрыть сценарий',exact:true}).click();
  const row=page.locator(`[data-film-id="generated:${lessonId}"]`);await expect(row.getByLabel('Формат: 2D',{exact:true})).toHaveText('2D');
  await expect(row).toContainText('2D-сцены');
});

test('teacher creates from topic and language without files, keeps ready history and separately publishes a viewing window',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const mock=await setup(page);await page.goto('/teach');
  await page.getByRole('button',{name:'Создать урок',exact:true}).first().click();
  const create=page.getByRole('dialog',{name:'Создать урок'});
  await expect(create.locator('input[type=date],input[type=datetime-local],input[type=number]')).toHaveCount(0);
  await expect(create.getByText(/Группы|Предмет|Расписание/)).toHaveCount(0);
  await create.getByLabel('Тема',{exact:true}).fill('Производная и движение');
  await expect(create.getByLabel('Язык',{exact:true})).toHaveValue('ru');
  await expect(create.getByRole('radio',{name:'2D видео',exact:true})).toBeChecked();
  await expect(create.getByRole('radio',{name:'3D видео',exact:true})).not.toBeChecked();
  await expect(create.getByRole('button',{name:'Создать урок',exact:true})).toBeEnabled();
  const createBounds=await create.boundingBox();expect(createBounds!.height).toBeLessThan(700);expect(Math.abs(createBounds!.x+createBounds!.width/2-720)).toBeLessThan(2);
  await page.screenshot({path:'../../work/platform-teacher/topic-create-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:'../../work/platform-teacher/topic-create-mobile.png',fullPage:false,animations:'disabled'});await page.setViewportSize({width:1440,height:960});
  await create.getByRole('button',{name:'Создать урок',exact:true}).click();
  await expect(create).toHaveCount(0);
  const progress=page.getByRole('dialog',{name:'Создание урока',exact:true});
  await expect(progress).toBeVisible();await expect(progress.getByRole('heading',{name:'План урока',exact:true})).toBeVisible();
  expect(mock.uploads).toEqual([]);expect(mock.creates).toHaveLength(1);
  expect(mock.creates[0]).toMatchObject({title:'Производная и движение',language:'ru',videoMode:'2d',materialIds:[]});
  expect(mock.creates[0].idempotencyKey.length).toBeGreaterThan(12);
  const row=page.locator(`[data-film-id="generated:${lessonId}"]`);
  await expect(row).toContainText('Производная и движение');await expect(row).toContainText('10 мин');
  await expect(row.getByLabel('Формат: 2D',{exact:true})).toHaveText('2D');
  await expect(row).toContainText(/21.*2026/);
  await page.reload();await expect(progress).toBeVisible();await progress.getByRole('button',{name:'Закрыть сценарий',exact:true}).click();await expect(row).toBeVisible();
  mock.ready();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const watch=row.getByRole('button',{name:'Смотреть урок Производная и движение',exact:true});
  await expect(watch).toBeEnabled();await expect(row).toContainText('Показ завершён');
  await page.screenshot({path:'../../work/platform-teacher/topic-history-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:'../../work/platform-teacher/topic-history-mobile.png',fullPage:false,animations:'disabled'});
  await row.getByRole('button',{name:'Показ урока Производная и движение',exact:true}).click();
  const publication=page.getByRole('dialog',{name:'Показ'});
  await publication.getByRole('button',{name:'Период',exact:true}).click();
  await publication.getByLabel('Начало показа').fill('2030-01-03T08:00');
  await publication.getByLabel('Окончание показа').fill('2030-01-03T09:00');
  await publication.getByLabel('Часовой пояс').selectOption('Asia/Tashkent');
  await page.setViewportSize({width:390,height:844});await noOverflow(page);
  await page.screenshot({path:'../../work/platform-teacher/topic-publication-mobile.png',fullPage:false,animations:'disabled'});
  await publication.getByRole('button',{name:'Сохранить показ'}).click();
  await expect(publication).toHaveCount(0);
  expect(mock.publications[0]).toMatchObject({startsAt:'2030-01-03T03:00:00.000Z',endsAt:'2030-01-03T04:00:00.000Z',timezone:'Asia/Tashkent'});
  await expect(watch).toBeEnabled();
  await row.getByRole('button',{name:'Показ урока Производная и движение',exact:true}).click();
  await publication.getByRole('button',{name:'Сейчас',exact:true}).click();
  await publication.getByRole('button',{name:'Сохранить показ'}).click();
  await expect(publication).toHaveCount(0);expect(mock.publications[1].endsAt).toBeNull();
  await page.getByRole('button',{name:'Сегодня',exact:true}).click();
  const published=page.getByRole('button',{name:'Смотреть показ Производная и движение',exact:true});await expect(published).toBeVisible();
  await noOverflow(page);await page.screenshot({path:'../../work/platform-teacher/topic-today-mobile.png',fullPage:false,animations:'disabled'});await published.click();await expect(page).toHaveURL(new RegExp(`film=${lessonId}`));
  expect(mock.attendance).toEqual([]);expect(await page.evaluate(()=>(window as any).__cameraAttempts)).toBe(0);expect(errors).toEqual([]);
});

for(const language of [{code:'kaa',name:'Каракалпакский',title:'Туўынды ҳәм қозғалыс'},{code:'uz',name:'Узбекский',title:'Hosila va harakat'}] as const)test(`${language.name} creation runs through 3D to ready without voice confirmation`,async({page},testInfo)=>{
  const mock=await setup(page,{createdStatus:'generating',createdStage:'visuals'});await page.goto('/teach');
  await page.getByRole('button',{name:'Создать урок',exact:true}).first().click();const create=page.getByRole('dialog',{name:'Создать урок'});
  await expect(create.getByLabel('Язык',{exact:true}).locator('option')).toHaveText(['Русский','Каракалпакский','Узбекский']);
  await create.getByRole('radio',{name:'3D видео',exact:true}).check();
  await create.getByLabel('Тема',{exact:true}).fill(language.title);await create.getByLabel('Язык',{exact:true}).selectOption(language.code);
  await create.getByRole('button',{name:'Создать урок',exact:true}).click();await expect(create).toHaveCount(0);
  expect(mock.creates[0].language).toBe(language.code);
  expect(mock.creates[0].videoMode).toBe('3d');
  const progress=page.getByRole('dialog',{name:'Создание урока',exact:true});await expect(progress).toBeVisible();
  await expect(progress.getByRole('heading',{name:'3D-сцены',exact:true})).toBeVisible();
  await expect(progress.getByRole('checkbox')).toHaveCount(0);await expect(page.getByRole('button',{name:/Подтвердить язык|Подтвердить озвучку|Проверить язык/})).toHaveCount(0);
  await expect(progress.locator('audio')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath(`${language.code}-automatic-mobile.png`),fullPage:false,animations:'disabled'});
  mock.ready();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const ready=page.getByRole('dialog',{name:'Урок готов',exact:true});await expect(ready.getByRole('button',{name:'Смотреть урок',exact:true})).toBeEnabled();
  await ready.getByRole('button',{name:'Закрыть сценарий',exact:true}).click();
  const row=page.locator(`[data-film-id="generated:${lessonId}"]`);await expect(row.locator('.teach-history-language')).toHaveText(language.name);
  await page.getByLabel('Язык уроков').selectOption(language.code);await expect(row).toBeVisible();
  await page.getByLabel('Язык уроков').selectOption(language.code==='uz'?'kaa':'uz');await expect(row).toHaveCount(0);
  await page.getByLabel('Язык уроков').selectOption(language.code);
  await row.getByRole('button',{name:`Показ урока ${language.title}`,exact:true}).click();
  const publication=page.getByRole('dialog',{name:'Показ',exact:true});await publication.getByRole('button',{name:'Сейчас',exact:true}).click();await publication.getByRole('button',{name:'Сохранить показ',exact:true}).click();
  await page.getByRole('button',{name:'Сегодня',exact:true}).click();
  await expect(page.locator(`[data-publication-lesson-id="${lessonId}"]`)).toContainText(language.name);
  expect(mock.approvals).toEqual([]);expect(mock.uploads).toEqual([]);expect(mock.creates).toHaveLength(1);
});

test('an old language-review lesson shows continuing progress without voice controls',async({page})=>{
  const initial=makeLesson('Туўынды ҳәм қозғалыс','kaa','language_review');
  const mock=await setup(page,{initial});await page.goto('/teach');await page.getByRole('button',{name:'Уроки',exact:true}).click();
  await page.getByRole('button',{name:'Открыть подготовку Туўынды ҳәм қозғалыс',exact:true}).click();
  const progress=page.getByRole('dialog',{name:'Создание урока',exact:true});await expect(progress.getByRole('heading',{name:'Продолжение подготовки',exact:true})).toBeVisible();
  await expect(progress.getByRole('checkbox')).toHaveCount(0);await expect(progress.locator('audio')).toHaveCount(0);
  mock.ready();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('dialog',{name:'Урок готов',exact:true})).toBeVisible();expect(mock.approvals).toEqual([]);
});

test('failed automatic creation can be retried without uploading a document',async({page})=>{
  const failed={...makeLesson('Интеграл','ru','failed'),error:'Не удалось подготовить видео.'};
  const mock=await setup(page,{initial:failed});await page.goto('/teach');await page.getByRole('button',{name:'Уроки',exact:true}).click();
  await page.getByRole('button',{name:'Повторить подготовку Интеграл',exact:true}).click();const detail=page.getByRole('dialog',{name:'Ошибка генерации',exact:true});
  await expect(detail.getByRole('alert')).toContainText('Не удалось подготовить видео.');
  await detail.getByRole('button',{name:'Повторить',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Создание урока',exact:true}).getByRole('heading',{name:'План урока',exact:true})).toBeVisible();expect(mock.retries).toHaveLength(1);expect(mock.uploads).toEqual([]);
});
