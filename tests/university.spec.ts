import { test, expect, type Page } from '@playwright/test';

async function login(page:Page, admin=false){
 await page.goto(admin?'/admin/login':'/login');
 await page.getByLabel('Почта',{exact:true}).fill(admin?'admin@aiteacher.local':'demo@aiteacher.local');
 await page.getByLabel('Пароль',{exact:true}).fill(admin?'PepeOnly-admin-2026!':'PepeOnly-teacher-2026!');
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await expect(page).toHaveURL(admin?/\/admin$/:/\/teach$/);
 await expect(page.locator(admin?'.ua-workspace':'.teaching-page')).toBeVisible();
 await expect(page.locator(admin?'.ua-loading':'.teach-loading')).toBeHidden();
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}

test('teacher optionally attaches lesson sources without groups or timetable and can reopen them',async({page})=>{
 await page.route('**/api/generated-lessons',async route=>{
  if(route.request().method()!=='POST')return route.fallback();
  const body=route.request().postDataJSON();
  await route.fulfill({status:202,json:{id:'f'.repeat(32),institutionId:body.institutionId,teacherId:'source-fixture',subjectId:'source-fixture',title:body.title,language:body.language,engine:'codex',targetDuration:600,materialIds:body.materialIds,summary:'',status:'generating',revision:0,chapters:[],duration:0,progress:{stage:'planning',completed:0,total:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}});
 });
 await login(page);
 await expect(page.locator('aside.sidebar')).toHaveCount(0);
 await expect(page.getByText(/Викторина|Оценки|Суперадминистратор|Школьный/)).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Начать занятие',exact:true})).toBeVisible();
 await noOverflow(page);
 await page.screenshot({path:'../AI-Teacher-preview.png',fullPage:true});
 await page.getByRole('button',{name:'Создать урок',exact:true}).first().click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByText(/Группы|Начало семестра|День недели|Расписание/)).toHaveCount(0);
 await page.getByLabel('Тема',{exact:true}).fill('Предел — материалы лекции');
 const source='Тема 1. Предел последовательности\nПоследовательность сходится к L, если для каждого ε > 0 существует N.\n\nТема 2. Производная\nПроизводная — предел отношения приращений.';
 await page.getByLabel('Материалы урока',{exact:true}).setInputFiles({name:'lecture.txt',mimeType:'text/plain',buffer:Buffer.from(source)});
 await dialog.getByRole('button',{name:'Создать урок',exact:true}).click();
 await expect(dialog).toBeHidden();
 await page.getByRole('button',{name:'Уроки',exact:true}).click();
 await page.getByRole('group',{name:'Тип уроков'}).getByRole('button',{name:'Материалы',exact:false}).click();
 await expect(page.getByRole('button',{name:'Открыть урок Предел — материалы лекции',exact:true})).toBeVisible();
 await page.reload();
 await page.getByRole('button',{name:'Уроки',exact:true}).click();
 await page.getByRole('group',{name:'Тип уроков'}).getByRole('button',{name:'Материалы',exact:false}).click();
 await page.getByRole('button',{name:'Открыть урок Предел — материалы лекции',exact:true}).click();
 const detail=page.getByRole('dialog');
 await expect(detail.getByText(/Последовательность сходится к L/)).toBeVisible();
 const original=detail.getByRole('link',{name:/lecture.txt/});
 const href=(await original.getAttribute('href'))!;
 const response=await page.request.get(href);
 expect(response.ok()).toBe(true);expect(await response.text()).toBe(source);
 await detail.getByRole('button',{name:/Закрыть/}).first().click();
 await page.setViewportSize({width:390,height:844});
 await noOverflow(page);
 await page.getByRole('button',{name:'Сегодня',exact:true}).click();
 await noOverflow(page);
});

test('class starts immediately; camera waits two minutes and failure leaves roster unconfirmed',async({page})=>{
 await page.addInitScript(()=>{
  (window as any).__cameraAttempts=0;
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{(window as any).__cameraAttempts++;throw new DOMException('Denied','NotAllowedError');}});
 });
 await login(page);
 await page.clock.install();
 let session:any;
 page.on('response',async response=>{if(response.url().endsWith('/api/teaching-sessions')&&response.request().method()==='POST')session=await response.json();});
 await page.route('**/api/teaching-sessions/*/scans',async route=>{
  const payload=route.request().postDataJSON();
  await route.fulfill({json:{...session,scans:[{...payload,id:'camera-failure-test',sessionId:session.id}],revision:session.revision}});
 });
 await page.getByRole('button',{name:'Начать занятие',exact:true}).click();
 await expect(page.getByRole('button',{name:'Пауза',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__cameraAttempts)).toBe(0);
 await page.clock.fastForward(119_000);
 expect(await page.evaluate(()=>(window as any).__cameraAttempts)).toBe(0);
 await page.clock.fastForward(2000);
 await expect.poll(()=>page.evaluate(()=>(window as any).__cameraAttempts)).toBe(1);
 await expect(page.getByText('Нет доступа к камере',{exact:true})).toBeVisible();
 await page.keyboard.press('Tab');
 await page.clock.fastForward(500);
 await page.getByRole('button',{name:'Посещаемость занятия',exact:true}).click();
 await expect(page.getByRole('combobox',{name:/Посещаемость:/}).first()).toHaveValue('unconfirmed');
 await page.getByRole('button',{name:'Закрыть посещаемость',exact:true}).click();
 await page.getByRole('button',{name:'Пауза',exact:true}).click();
 await expect(page.getByRole('button',{name:'Продолжить',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Завершить',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Завершить',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Занятие завершено'})).toBeVisible();
 await page.getByRole('button',{name:'К посещаемости'}).click();
 const first=page.getByRole('combobox',{name:/Посещаемость:/}).first();
 await first.selectOption('present');
 await expect(first).toHaveValue('present');
 await page.reload();
 await page.getByRole('button',{name:'Посещаемость',exact:true}).click();
 await expect(page.getByRole('combobox',{name:/Посещаемость:/}).first()).toHaveValue('present');
});

test('admin library, CSV import, distinct navigation and two roles',async({page})=>{
 await login(page,true);
 await page.screenshot({path:'../AI-Teacher-admin.png',fullPage:true});
 await page.getByRole('link',{name:'Студенты',exact:true}).first().click();
 await expect(page).toHaveURL(/\/admin\/students/);
 await page.getByRole('button',{name:'Список CSV',exact:true}).click();
 await page.getByRole('dialog').locator('input[type=file]').setInputFiles({name:'students.csv',mimeType:'text/csv',buffer:Buffer.from('name\nТестовый Студент Университета\n')});
 await page.getByRole('button',{name:'Добавить студентов',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeHidden();
 await page.getByPlaceholder('Найти').fill('Тестовый Студент Университета');
 await expect(page.getByText('Тестовый Студент Университета',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Преподаватели',exact:true}).click();
 await page.getByRole('button',{name:'Преподаватель',exact:true}).click();
 await expect(page.getByRole('combobox',{name:/^Доступ/}).locator('option:not([value=""])')).toHaveText(['Преподаватель','Администратор']);
 await page.getByRole('button',{name:'Отмена',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await noOverflow(page);
 await page.goto('/teach');
 await expect(page).toHaveURL(/\/admin$/);
});

test('local face models load and reject a blank photo without creating an enrollment',async({page})=>{
 test.setTimeout(120_000);
 await login(page,true);
 const external:string[]=[];let humanModuleUrl='';
 page.on('request',request=>{if(request.url().includes('@vladmandic_human.js')&&!request.url().includes('.map'))humanModuleUrl=request.url();if(/^https?:/.test(request.url())&&!request.url().startsWith('http://127.0.0.1:3101'))external.push(request.url());});
 const message=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;
  const context=canvas.getContext('2d')!;context.fillStyle='#ddd';context.fillRect(0,0,320,320);
  const blob=await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),'image/png'));
  const modulePath='/src/face.ts';const {enrollFace}=await import(modulePath);
  try{await enrollFace(new File([blob],'blank.png',{type:'image/png'}));return 'unexpected enrollment';}
  catch(error){return (error as Error).message;}
 });
 expect(message).toMatch(/Лицо не найдено/);
 const embeddingShape=await page.evaluate(async(modulePath)=>{
  const {default:Human}=await import(modulePath);const human=new Human();
  const graph=await human.tf.loadGraphModel('/models/face/faceres.json');
  const input=human.tf.zeros([1,224,224,3]);
  const output=graph.execute(input,'global_pooling/Mean');
  const values=await output.data();const result={shape:output.shape,finite:[...values].every(Number.isFinite)};
  input.dispose();output.dispose();graph.dispose();return result;
 },humanModuleUrl);
 expect(embeddingShape).toEqual({shape:[1,1024],finite:true});
 expect(external).toEqual([]);
});
