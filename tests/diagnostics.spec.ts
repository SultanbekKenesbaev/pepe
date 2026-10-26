import { test, expect } from '@playwright/test';

test.use({permissions:['camera'],launchOptions:{channel:'chrome',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}});

test('admin camera preflight reports denied permission without changing attendance or settings',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).__cameraDiagnosticsAttempts=0;
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
      enumerateDevices:async()=>[{deviceId:'camera-test-one',kind:'videoinput',label:'Камера аудитории 204',groupId:'test'},{deviceId:'camera-test-two',kind:'videoinput',label:'USB-камера',groupId:'test'}],
      getUserMedia:async()=>{(window as any).__cameraDiagnosticsAttempts++;throw new DOMException('Denied','NotAllowedError');},
      addEventListener:()=>{},removeEventListener:()=>{},
    }});
  });
  await page.route('**/api/operations/status',route=>route.fulfill({json:{backup:{status:'success',lastAttemptAt:'2026-10-22T02:00:00.000Z',lastSuccessAt:'2026-10-22T02:00:00.000Z'},serverTime:'2026-10-22T02:01:00.000Z'}}));
  await page.goto('/admin/login');
  await page.getByLabel('Почта',{exact:true}).fill('admin@aiteacher.local');
  await page.getByLabel('Пароль',{exact:true}).fill('PepeOnly-admin-2026!');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page).toHaveURL(/\/admin$/);
  const writes:string[]=[];
  page.on('request',request=>{if(!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push(request.url());});
  await page.getByRole('link',{name:'Настройки',exact:true}).click();
  const panel=page.getByRole('region',{name:'Диагностика камеры',exact:true});
  await expect(panel.getByLabel('Камера для проверки',{exact:true}).locator('option')).toHaveCount(3);
  await panel.getByLabel('Камера для проверки',{exact:true}).selectOption('camera-test-two');
  await expect(panel.getByRole('button',{name:'Проверить',exact:true})).toBeDisabled();
  await panel.getByRole('button',{name:'Включить камеру',exact:true}).click();
  await expect(panel.getByRole('alert')).toHaveText('Нет доступа к камере');
  expect(await page.evaluate(()=>(window as any).__cameraDiagnosticsAttempts)).toBe(1);
  await expect(panel.getByRole('button',{name:'Проверить',exact:true})).toBeDisabled();
  await expect(page.getByRole('region',{name:'Резервные копии',exact:true})).toContainText('Копия сохранена');
  expect(writes).toEqual([]);
  await page.screenshot({path:'../AI-Teacher-diagnostics.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:'../../work/diagnostics-mobile.png',fullPage:true});
});

test.describe('local camera diagnostic',()=>{
  test('synthetic camera feed runs the actual local face models and makes no attendance changes',async({page})=>{
    test.setTimeout(120_000);
    await page.goto('/admin/login');
    await page.getByLabel('Почта',{exact:true}).fill('admin@aiteacher.local');
    await page.getByLabel('Пароль',{exact:true}).fill('PepeOnly-admin-2026!');
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await expect(page).toHaveURL(/\/admin$/);
    const writes:string[]=[];
    page.on('request',request=>{if(!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push(request.url());});
    await page.getByRole('link',{name:'Настройки',exact:true}).click();
    const panel=page.getByRole('region',{name:'Диагностика камеры',exact:true});
    await panel.getByRole('button',{name:'Включить камеру',exact:true}).click();
    await expect(panel.locator('.ua-camera-resolution')).toContainText(/\d+ × \d+/);
    await expect(panel.getByRole('button',{name:'Проверить',exact:true})).toBeEnabled();
    await panel.getByRole('button',{name:'Проверить',exact:true}).click();
    await expect(panel.locator('.ua-camera-result')).toContainText('Совпадений 0',{timeout:90_000});
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await panel.getByRole('button',{name:'Выключить',exact:true}).click();
    await expect(panel.getByText('Камера выключена',{exact:true})).toBeVisible();
    expect(await panel.locator('video').evaluate(video=>(video as HTMLVideoElement).srcObject)).toBeNull();
    expect(writes).toEqual([]);
  });
});
