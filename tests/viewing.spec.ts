import { test, expect } from '@playwright/test';

test('seven all-day 3D viewings open from the hero and schedule without a class session or camera', async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const admin = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
  const createdScheduleIds: string[] = [];
  let clonedLessonId = '';
  const sessionWrites: string[] = [];
  const errors: string[] = [];
  await page.addInitScript(() => {
    (window as any).__cameraAttempts = 0;
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { (window as any).__cameraAttempts++; throw new Error('A viewing must not open the camera'); },
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/teaching-sessions')) sessionWrites.push(request.url());
  });
  await page.route('**/api/teaching-sessions{,/**}', async route => {
    if (route.request().method() === 'POST') return route.abort('blockedbyclient');
    await route.continue();
  });

  try {
    const auth = await admin.request.post('/api/auth/login', { data: { email: 'admin@aiteacher.local', password: 'PepeOnly-admin-2026!' } });
    expect(auth.ok()).toBe(true);
    const boot = await auth.json();
    const headers = { 'X-CSRF-Token': boot.csrfToken };
    const institutionId = boot.user.institutionId;
    const universityResponse = await admin.request.get(`/api/university?institutionId=${institutionId}`);
    expect(universityResponse.ok()).toBe(true);
    const university = await universityResponse.json();
    const lessonsResponse = await admin.request.get(`/api/data/lessons?institutionId=${institutionId}`);
    expect(lessonsResponse.ok()).toBe(true);
    const original = (await lessonsResponse.json()).find((lesson: any) => /производн/i.test(lesson.name));
    expect(original).toBeTruthy();
    const teacher = university.teachers.find((item: any) => item.email === 'demo@aiteacher.local');
    expect(teacher).toBeTruthy();
    const groupId = original.groupId || university.groups.find((group: any) => group.teacherId === teacher.id || group.teacherIds?.includes(teacher.id))?.id;
    expect(groupId).toBeTruthy();

    // Keep the original lesson and its normal timetable unchanged for the other browser tests.
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ownerId: _ownerId, ...lessonInput } = original;
    const title = 'Производная — просмотр 3D (тест)';
    const cloned = await admin.request.post('/api/data/lessons', {
      headers, data: { ...lessonInput, cinemaId: undefined, institutionId, groupId, name: title },
    });
    expect(cloned.ok()).toBe(true);
    clonedLessonId = (await cloned.json()).id;
    const linked = await admin.request.patch(`/api/data/lessons/${clonedLessonId}`, { headers, data: { cinemaId: 'derivative' } });
    expect(linked.ok()).toBe(true);
    expect((await linked.json()).cinemaId).toBe('derivative');

    const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${university.date}T12:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
    for (const date of dates) {
      const response = await admin.request.post('/api/data/schedule', {
        headers,
        data: { institutionId, name: `${title} · ${date}`, lessonId: clonedLessonId, groupId, teacherId: teacher.id, startsAt: `${date}T12:00:00+05:00`, allDay: true },
      });
      expect(response.ok()).toBe(true);
      createdScheduleIds.push((await response.json()).id);
    }

    await page.goto('/login');
    await page.getByLabel('Почта', { exact: true }).fill('demo@aiteacher.local');
    await page.getByLabel('Пароль', { exact: true }).fill('PepeOnly-teacher-2026!');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/teach$/);
    const hero = page.locator('.teach-main-hero');
    const heroWatch = hero.getByRole('button', { name: 'Смотреть урок', exact: true });
    const card = (index: number) => page.locator(`[data-event-id="schedule:${createdScheduleIds[index]}:${dates[index]}"]`);
    const stage = page.getByRole('region', { name: 'Урок: Производная' });
    async function expectViewingDay(index: number) {
      await expect(page.getByLabel('Дата занятий', { exact: true })).toHaveValue(dates[index]);
      await expect(card(index)).toContainText('Весь день');
      await expect(card(index)).toContainText('24 часа');
      await expect(hero).toContainText(title);
      await expect(hero).toContainText('24 часа');
      await expect(heroWatch).toBeVisible();
    }
    async function closePreview() {
      await expect(page).toHaveURL(/\/teach\?preview=derivative$/);
      await expect(stage).toBeVisible();
      await expect(stage.locator('canvas')).toHaveAttribute('data-car-asset', 'gltf', { timeout: 30_000 });
      await stage.hover();
      await page.getByRole('button', { name: 'Закрыть урок', exact: true }).click();
      await expect(page).toHaveURL(/\/teach$/);
    }

    await expectViewingDay(0);
    await heroWatch.click();
    await closePreview();
    await expectViewingDay(0);
    // Reopening a viewing keeps it available and never changes attendance or starts a class.
    await card(0).getByRole('button', { name: `Смотреть урок ${title}`, exact: true }).click();
    await closePreview();
    for (let index = 1; index < dates.length; index++) {
      await page.getByRole('button', { name: 'Следующий день', exact: true }).click();
      await expectViewingDay(index);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expectViewingDay(6);
    await heroWatch.click();
    await expect(stage).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await closePreview();
    expect(sessionWrites).toEqual([]);
    expect(await page.evaluate(() => (window as any).__cameraAttempts)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    const bootstrap = await admin.request.get('/api/auth/me');
    if (bootstrap.ok()) {
      const { csrfToken } = await bootstrap.json();
      const headers = { 'X-CSRF-Token': csrfToken };
      const removed = await Promise.all(createdScheduleIds.map(id => admin.request.delete(`/api/data/schedule/${id}`, { headers })));
      for (const response of removed) expect(response.ok(), 'Remove the isolated viewing schedule fixture').toBe(true);
      if (clonedLessonId) {
        const response = await admin.request.delete(`/api/data/lessons/${clonedLessonId}`, { headers });
        // Cancelled calendar entries retain their lesson reference for history in this isolated test database.
        expect(response.status(), 'Keep the lesson referenced by cancelled viewing history').toBe(409);
      }
    }
    await admin.close();
  }
});
