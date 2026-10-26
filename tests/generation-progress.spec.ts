import { test, expect, type Page } from '@playwright/test';
import type { GeneratedLesson } from '../shared/types';

const id='d'.repeat(32),institutionId='progress-university',teacherId='progress-teacher',title='Бесконечность в математике и философии';
function fixture(language:GeneratedLesson['language']='ru'):GeneratedLesson{return{id,institutionId,teacherId,subjectId:'math',title,summary:'',engine:'codex',language,targetDuration:600,status:'drafting',revision:0,chapters:[],duration:0,progress:{stage:'script',completed:0,total:1,percent:5,estimatedRemainingSeconds:{min:3600,max:7200}},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
async function mock(page:Page,language:GeneratedLesson['language']='ru',initial:GeneratedLesson|null=null){
  let lesson:GeneratedLesson|null=initial,attempts=0,listRequests=0;
  let detailDelay:Promise<void>|null=null,releaseDetail:()=>void=()=>{};
  let retryDelay:Promise<void>|null=null,releaseRetry:()=>void=()=>{},retryError:{error:string;code:string}|null=null;
  let listDelay:Promise<void>|null=null,releaseList:()=>void=()=>{};
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    const json=(data:unknown,status=200)=>route.fulfill({status,json:data});
    if(path==='/api/auth/me')return json({user:{id:teacherId,name:'Преподаватель',email:'teacher@example.test',role:'TEACHER',institutionId,active:true},institutions:[{id:institutionId,name:'Университет',type:'UNIVERSITY',language:'ru',settings:{timezone:'Asia/Tashkent'}}],csrfToken:'progress-fixture-csrf',ai:{configured:true,mode:'provider'}});
    if(path==='/api/university')return json({date:url.searchParams.get('date'),semesters:[],events:[],sessions:[],groups:[],students:[],subjects:[{id:'math',institutionId,name:'Математика'}],rooms:[],teachers:[]});
    if(path==='/api/lesson-publications'||path==='/api/lesson-materials'||path==='/api/lesson-catalog')return json([]);
    if(path==='/api/generated-lessons'&&method==='POST'){
      expect(request.headers()['x-csrf-token']).toBe('progress-fixture-csrf');expect(request.postDataJSON()).toMatchObject({title,language,materialIds:[]});
      attempts++;lesson=fixture(language);return json(lesson,202);
    }
    if(path===`/api/generated-lessons/${id}/retry`){expect(request.postDataJSON().revision).toBe(lesson!.revision);attempts++;if(retryDelay)await retryDelay;if(retryError)return json(retryError,503);lesson={...fixture(language),revision:lesson!.revision+1};return json(lesson,202);}
    if(path==='/api/generated-lessons'){listRequests++;const snapshot=structuredClone(lesson),delay=listDelay;listDelay=null;if(delay)await delay;return json(snapshot?[snapshot]:[]);}
    if(path===`/api/generated-lessons/${id}`){const snapshot=structuredClone(lesson);if(detailDelay)await detailDelay;return json(snapshot);}
    return json({error:'Не найдено'},404);
  });
  return{get attempts(){return attempts;},get listRequests(){return listRequests;},setLesson(patch:Partial<GeneratedLesson>){lesson={...lesson!,...patch,revision:lesson!.revision+1};},delayDetail(){detailDelay=new Promise<void>(resolve=>{releaseDetail=resolve;});},releaseDetail(){detailDelay=null;releaseDetail();},delayRetry(error?:{error:string;code:string}){retryError=error||null;retryDelay=new Promise<void>(resolve=>{releaseRetry=resolve;});},releaseRetry(){retryDelay=null;releaseRetry();},delayList(){listDelay=new Promise<void>(resolve=>{releaseList=resolve;});},releaseList(){releaseList();}};
}
const focus=(page:Page)=>page.evaluate(()=>window.dispatchEvent(new Event('focus')));

test('retry immediately replaces the previous failure with a pending launch and ignores an older poll',async({page})=>{
  const previousError='Предыдущая озвучка не получена.';
  const api=await mock(page,'kaa',{...fixture('kaa'),status:'failed',error:previousError,errorCode:'GENERATION_FAILED',errorStage:'voice'});
  await page.goto('/teach');await page.getByRole('button',{name:'Уроки',exact:true}).click();
  await page.locator(`[data-film-id="generated:${id}"]`).getByRole('button').click();
  const failed=page.getByRole('dialog',{name:'Ошибка генерации',exact:true});await expect(failed).toContainText(previousError);
  const requests=api.listRequests;api.delayList();await focus(page);await expect.poll(()=>api.listRequests).toBeGreaterThan(requests);
  api.delayRetry();await failed.getByRole('button',{name:'Повторить',exact:true}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  const progress=page.getByRole('dialog',{name:'Создание урока',exact:true}),ring=progress.getByRole('progressbar');
  await expect(progress).toBeVisible();await expect(progress.getByRole('heading',{name:'Запуск',exact:true})).toBeVisible();
  await expect(ring).not.toHaveAttribute('aria-valuenow');await expect(progress).toContainText(title);
  await expect(progress.getByRole('alert')).toHaveCount(0);await expect(progress.getByRole('button',{name:'Повторить',exact:true})).toHaveCount(0);
  expect(api.attempts).toBe(1);api.releaseRetry();await expect(ring).toHaveAttribute('aria-valuenow','5');
  api.releaseList();await focus(page);await expect(ring).toHaveAttribute('aria-valuenow','5');
  await expect(progress.getByText(previousError,{exact:true})).toHaveCount(0);expect(api.attempts).toBe(1);
  api.setLesson({status:'failed',error:'Новая попытка не получила аудио от Google.',errorCode:'GENERATION_FAILED',errorStage:'voice',progress:{stage:'failed',completed:2,total:32,percent:22}});
  await focus(page);await expect(failed.getByRole('alert')).toContainText('Новая попытка не получила аудио от Google.');
  await expect(failed.getByRole('button',{name:'Повторить',exact:true})).toBeEnabled();expect(api.attempts).toBe(1);
});

test('a rejected retry shows its actual API error and enables another attempt',async({page})=>{
  const api=await mock(page,'kaa',{...fixture('kaa'),status:'failed',error:'Предыдущая ошибка.',errorCode:'GENERATION_FAILED',errorStage:'voice'});
  await page.goto('/teach');await page.getByRole('button',{name:'Уроки',exact:true}).click();
  await page.locator(`[data-film-id="generated:${id}"]`).getByRole('button').click();
  const failed=page.getByRole('dialog',{name:'Ошибка генерации',exact:true});
  api.delayRetry({error:'Сервис озвучки временно недоступен.',code:'GENERATION_UNAVAILABLE'});
  await failed.getByRole('button',{name:'Повторить',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Создание урока',exact:true}).getByRole('progressbar')).toBeVisible();
  api.releaseRetry();await expect(failed).toBeVisible();
  await expect(failed.getByRole('alert').filter({hasText:'GENERATION_UNAVAILABLE'})).toContainText('Сервис озвучки временно недоступен.');
  await expect(failed.getByRole('button',{name:'Повторить',exact:true})).toBeEnabled();expect(api.attempts).toBe(1);
});

test('generation modal opens after create, reports real stages, survives reload and shows error details before retry',async({page},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const api=await mock(page,'uz');
  await page.goto('/teach');await page.getByRole('button',{name:'Создать урок',exact:true}).click();
  const create=page.getByRole('dialog',{name:'Создать урок',exact:true});
  await create.getByLabel('Тема',{exact:true}).fill(title);await create.getByLabel('Язык',{exact:true}).selectOption('uz');await create.getByRole('button',{name:'Создать урок',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Создание урока',exact:true}),progress=dialog.getByRole('progressbar',{name:'Общий прогресс, приблизительно'});
  await expect(dialog).toBeVisible();await expect(progress).toHaveAttribute('aria-valuenow','5');
  await expect(dialog.getByRole('heading',{name:'Сценарий',exact:true})).toBeVisible();await expect(dialog).toContainText('Осталось ≈ 60–120 мин');
  expect(api.attempts).toBe(1);await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  api.setLesson({status:'generating',progress:{stage:'visuals',phase:'rendering',completed:3240,total:14400,percent:69,frames:{completed:3240,total:14400},estimatedRemainingSeconds:{min:2700,max:5400}}});
  await focus(page);await expect(progress).toHaveAttribute('aria-valuenow','69');await expect(dialog.getByRole('heading',{name:'Сборка урока',exact:true})).toBeVisible();
  await expect(dialog).toContainText('Осталось ≈ 45–90 мин');await expect(dialog).toContainText(/3\s?240 \/ 14\s?400 кадров/);
  await page.waitForTimeout(700); // Allow the ring to settle before comparing the displayed percentage visually.
  await page.screenshot({path:testInfo.outputPath('generation-progress-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('generation-progress-mobile.png'),fullPage:true});
  await page.reload();await expect(dialog).toBeVisible();await expect(progress).toHaveAttribute('aria-valuenow','69');expect(api.attempts).toBe(1);
  await dialog.getByRole('button',{name:'Закрыть сценарий',exact:true}).click();await expect(dialog).toBeHidden();
  api.setLesson({status:'failed',error:'Генерация остановлена до завершения сборки.',errorCode:'GENERATION_CANCELLED',errorStage:'rendering',progress:{stage:'failed',completed:0,total:1,percent:69}});
  await focus(page);const row=page.locator(`[data-film-id="generated:${id}"]`);await expect(row).toContainText('Генерация остановлена');
  expect(api.attempts).toBe(1);api.delayDetail();await row.getByRole('button').click();
  const failed=page.getByRole('dialog',{name:'Ошибка генерации',exact:true});await expect(failed).toBeVisible();
  await expect(failed.getByRole('alert')).toContainText('GENERATION_CANCELLED');await expect(failed.getByRole('alert')).toContainText('Сборка урока');
  await page.screenshot({path:testInfo.outputPath('generation-error-mobile.png'),fullPage:true});
  await failed.getByRole('button',{name:'Повторить',exact:true}).click();api.releaseDetail();await expect(dialog).toBeVisible();await expect(progress).toHaveAttribute('aria-valuenow','5');
  await expect(dialog.getByText('GENERATION_CANCELLED',{exact:true})).toHaveCount(0);expect(api.attempts).toBe(2);
  api.setLesson({status:'generating',progress:{stage:'visuals',phase:'validating',completed:1,total:1,percent:100}});
  await focus(page);await expect(progress).toHaveAttribute('aria-valuenow','99');
  api.setLesson({status:'ready',duration:600,progress:{stage:'ready',completed:1,total:1,percent:100}});
  await focus(page);await expect(page.getByRole('dialog',{name:'Урок готов',exact:true}).getByRole('button',{name:'Смотреть урок',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('file upload stays in creation modal and displays the server error code without starting generation',async({page})=>{
  const api=await mock(page);
  let releaseUpload!:()=>void;
  const uploadReleased=new Promise<void>(resolve=>{releaseUpload=resolve;});
  let uploadStarted=false;
  await page.route('**/api/lesson-materials',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    expect(route.request().headers()['x-csrf-token']).toBe('progress-fixture-csrf');uploadStarted=true;
    await uploadReleased;await route.fulfill({status:422,json:{error:'В документе нет доступного текста.',code:'MATERIAL_TEXT_EMPTY'}});
  });
  await page.goto('/teach');await page.getByRole('button',{name:'Создать урок',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Создать урок',exact:true});await dialog.getByLabel('Тема',{exact:true}).fill(title);
  await dialog.getByLabel('Материалы урока',{exact:true}).setInputFiles({name:'lecture.txt',mimeType:'text/plain',buffer:Buffer.from('Материалы для проверки загрузки. '.repeat(1000))});
  await dialog.getByRole('button',{name:'Создать урок',exact:true}).click();
  await expect.poll(()=>uploadStarted).toBe(true);await expect(dialog.getByRole('progressbar')).toBeVisible();await expect(dialog.getByRole('button',{name:'Создаём…',exact:true})).toBeDisabled();
  releaseUpload();await expect(dialog.getByRole('alert')).toContainText('MATERIAL_TEXT_EMPTY');await expect(dialog.getByRole('alert')).toContainText('В документе нет доступного текста.');
  await expect(dialog.getByRole('button',{name:'Создать урок',exact:true})).toBeEnabled();expect(api.attempts).toBe(0);
});
