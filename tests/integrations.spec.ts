import { test, expect } from '@playwright/test';

test('admin manages integrations and secrets appear only at creation', async ({ page }, testInfo) => {
  const integrations: any[] = [];
  const writes: { method: string; body: any; csrf: boolean }[] = [];
  await page.route('**/api/integrations**', async route => {
    const request = route.request(), method = request.method(), path = new URL(request.url()).pathname;
    if (method === 'GET') return route.fulfill({ json: integrations });
    const body = request.postDataJSON();
    writes.push({ method, body, csrf: !!request.headers()['x-csrf-token'] });
    if (path === '/api/integrations' && method === 'POST') {
      const item = { id: 'integration-ui-fixture', name: body.name, active: true, createdAt: new Date().toISOString(), limits: body.limits, usage: { jobsToday: 2, totalJobs: 7, readyJobs: 4, failedJobs: 1 }, keys: [], webhook: { url: null, configured: false } };
      integrations.push(item);
      return route.fulfill({ status: 201, json: item });
    }
    const item = integrations[0];
    if (path.endsWith('/keys') && method === 'POST') {
      const record = { id: 'key-ui-fixture', name: body.name, prefix: 'ui_fixture', createdAt: new Date().toISOString() };
      item.keys.push(record);
      return route.fulfill({ status: 201, json: { key: 'synthetic-ui-key-not-a-real-credential', record, integrationId: item.id } });
    }
    if (method === 'DELETE') { item.keys[0].revokedAt = new Date().toISOString(); return route.fulfill({ status: 204 }); }
    if (method === 'PATCH') { expect(body).not.toHaveProperty('institutionId'); expect(Object.keys(body).sort()).toEqual(['active', 'limits', 'name']); Object.assign(item, body); return route.fulfill({ json: item }); }
    if (path.endsWith('/webhook')) {
      item.webhook = { url: body.url, configured: !!body.url };
      return route.fulfill({ json: { webhook: item.webhook, ...(body.url ? { signingSecret: 'synthetic-ui-signing-secret-not-real' } : {}) } });
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected fixture request' } });
  });
  await page.goto('/admin/login');
  await page.getByLabel('Почта', { exact: true }).fill('admin@aiteacher.local');
  await page.getByLabel('Пароль', { exact: true }).fill('PepeOnly-admin-2026!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Подключений пока нет' })).toBeVisible();
  await page.getByRole('button', { name: 'Создать подключение', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название подключения', { exact: true }).fill('Учебный портал');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Учебный портал', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  expect(writes[0].body.institutionId).toBeTruthy();
  expect(writes[0].csrf).toBe(true);
  await page.getByRole('button', { name: 'Создать ключ', exact: true }).click();
  await dialog.getByLabel('Название ключа', { exact: true }).fill('Сайт');
  await dialog.getByRole('button', { name: 'Создать ключ', exact: true }).click();
  await expect(dialog.getByLabel('API-ключ', { exact: true })).toHaveValue('synthetic-ui-key-not-a-real-credential');
  await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);
  await dialog.getByRole('button', { name: 'Скопировать', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Скопировано', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.getByLabel('API-ключ', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Обновить подключения', exact: true }).click();
  await expect(page.getByLabel('API-ключ', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('synthetic-ui')))).toBe(false);
  expect(await page.evaluate(() => Object.values(sessionStorage).some(value => String(value).includes('synthetic-ui')))).toBe(false);
  await page.getByRole('button', { name: 'Отозвать ключ Сайт', exact: true }).click();
  await expect(dialog.getByText('Ключ «Сайт» перестанет принимать запросы.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Отозвать ключ', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Отозвать ключ Сайт', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Настроить Учебный портал', exact: true }).click();
  await dialog.getByLabel('Одновременно', { exact: true }).fill('2');
  await dialog.getByLabel('Заданий / день', { exact: true }).fill('20');
  await dialog.getByLabel('Подключение активно', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.ua-api-title')).toContainText('Отключено');
  expect(integrations[0].limits.maxConcurrentJobs).toBe(2);
  expect(integrations[0].limits.jobsPerDay).toBe(20);
  await page.locator('.ua-api-webhook summary').click();
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await dialog.getByLabel('URL уведомлений', { exact: true }).fill('http://example.uz/events');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('HTTPS');
  await dialog.getByLabel('URL уведомлений', { exact: true }).fill('https://example.uz/events');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByLabel('Секрет подписи', { exact: true })).toHaveValue('synthetic-ui-signing-secret-not-real');
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.getByLabel('Секрет подписи', { exact: true })).toHaveCount(0);
  await expect(page.locator('.ua-api-webhook')).toContainText('https://example.uz/events');
  await page.getByRole('button', { name: 'Изменить', exact: true }).click();
  await expect(dialog).toContainText('секрет подписи будет обновлён');
  await dialog.getByLabel('URL уведомлений', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.ua-api-webhook summary')).toContainText('Не подключён');
  expect(writes.every(write => write.csrf)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('integrations-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('integrations-mobile.png'), fullPage: true });
});
