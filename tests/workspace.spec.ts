import { test, expect, type Page } from '@playwright/test';

async function login(page:Page,admin=false){
  await page.goto(admin?'/admin/login':'/login');
  await page.getByLabel('Почта',{exact:true}).fill(admin?'admin@aiteacher.local':'demo@aiteacher.local');
  await page.getByLabel('Пароль',{exact:true}).fill(admin?'PepeOnly-admin-2026!':'PepeOnly-teacher-2026!');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page).toHaveURL(admin?/\/admin$/:/\/teach$/);
}

test('teacher and administrator see and update the same attendance records',async({page,browser})=>{
  await login(page);
  const boot=await (await page.request.get('/api/auth/me')).json();
  const institutionId=boot.user.institutionId;
  const data=await (await page.request.get(`/api/university?institutionId=${institutionId}`)).json();
  const event=data.events[0];
  expect(event).toBeTruthy();
  const headers={'X-CSRF-Token':boot.csrfToken};
  const created=await page.request.post('/api/teaching-sessions',{headers,data:{institutionId,eventId:event.id,date:event.date}});
  expect(created.ok()).toBe(true);
  const session=await created.json();
  const finished=await page.request.post(`/api/teaching-sessions/${session.id}/action`,{headers,data:{action:'complete',revision:session.revision}});
  expect(finished.ok()).toBe(true);
  const student=session.roster[0];
  await page.reload();
  await page.getByRole('button',{name:'Посещаемость',exact:true}).click();
  await page.getByLabel('Занятие для посещаемости',{exact:true}).selectOption(session.id);
  const teacherMark=page.getByRole('combobox',{name:`Посещаемость: ${student.name}`,exact:true});
  await expect(teacherMark).toHaveValue('unconfirmed');
  await teacherMark.selectOption('present');
  await expect(teacherMark).toHaveValue('present');
  await page.screenshot({path:'../AI-Teacher-Attendance.png',fullPage:true});
  const adminContext=await browser.newContext({baseURL:new URL(page.url()).origin,viewport:{width:1440,height:960}});
  const adminPage=await adminContext.newPage();
  await login(adminPage,true);
  const analytics=await (await adminPage.request.get(`/api/attendance/analytics?institutionId=${institutionId}&from=${event.date}&to=${event.date}`)).json();
  expect(analytics.sessions.find((item:any)=>item.id===session.id).attendance[0].status).toBe('present');
  expect(analytics.totals.unconfirmed).toBeGreaterThan(0);
  expect(analytics.sessions.find((item:any)=>item.id===session.id).attendance.filter((mark:any)=>mark.status==='absent')).toHaveLength(0);
  const row=adminPage.locator(`[data-session-id="${session.id}"]`);
  await expect(row).toBeVisible();
  await adminPage.screenshot({path:'../AI-Teacher-admin.png',fullPage:true});
  await row.click();
  const adminMark=adminPage.getByRole('combobox',{name:`Отметка ${student.name}`,exact:true});
  await expect(adminMark).toHaveValue('present');
  await adminMark.selectOption('excused');
  await adminPage.getByRole('button',{name:'Подтвердить отметки',exact:true}).click();
  await expect(adminPage.getByRole('dialog')).toBeHidden();
  await adminPage.setViewportSize({width:390,height:844});
  expect(await adminPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  // Returning to an already open teacher workspace refreshes shared marks without a reload.
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(teacherMark).toHaveValue('excused');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await adminContext.close();
});
