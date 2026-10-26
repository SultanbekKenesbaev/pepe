import { test, expect } from '@playwright/test';

test('generated 3D player uses voice clock, deterministic seek and five scene templates without attendance', async ({ page }) => {
  const id = 'c'.repeat(32), errors: string[] = [];
  const wave = Buffer.alloc(44 + 24000 * 2 * 2); wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(24000, 24); wave.writeUInt32LE(48000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  const scenes = ['concept', 'chart', 'process', 'comparison', 'orbit'];
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play; let held = false;
    HTMLMediaElement.prototype.play = function () {
      const result = original.call(this);
      if (this.dataset.testid === 'generated-voice' && !held) {
        held = true;
        return result.then(() => new Promise<void>(resolve => { (window as any).__releaseFirstPlay = resolve; }));
      }
      return result;
    };
  });
  const chapters = scenes.map((scene, i) => ({ id: `chapter-${i}`, title: `Глава ${i + 1}`, narration: 'Проверка синхронизации с озвучкой.', scene, headline: `Сцена ${i + 1}`, labels: ['Время', 'Расстояние', 'Скорость'], values: scene === 'chart' || scene === 'comparison' ? [-2, 4, 6] : [], formula: 'v(t) = 2t', example: 'Автомобиль меняет скорость.', palette: i % 2 ? 'light' : 'dark', start: i * 4.5, duration: 4.5, audioDuration: 2, audioUrl: `/api/generated-lessons/${id}/audio/chapter-${i}` }));
  await page.route(`**/api/generated-lessons/${id}/manifest`, route => route.fulfill({ json: { id, title: 'Трёхмерные изменения', summary: '', duration: 22.5, chapters, voice: { status: 'ready' } } }));
  await page.route(`**/api/generated-lessons/${id}/audio/**`, route => route.fulfill({ body: wave, contentType: 'audio/wav' }));
  page.on('pageerror', e => errors.push(e.message));
  const attendance: string[] = []; page.on('request', r => { if (r.method() === 'POST' && /teaching-sessions/.test(r.url())) attendance.push(r.url()); });
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill('demo@aiteacher.local'); await page.getByLabel('Пароль', { exact: true }).fill('PepeOnly-teacher-2026!'); await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL('**/teach'); await page.goto(`/teach?film=${id}`);
  const film = page.getByRole('dialog', { name: 'Трёхмерные изменения' }); await expect(film).toBeVisible();
  const canvas = film.locator('canvas'), timeline = film.getByRole('slider', { name: 'Позиция урока' });
  const seek = async (time: number) => { await timeline.evaluate((element, value) => { const input = element as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, time); };
  await expect(canvas).toHaveAttribute('data-chapter', 'chapter-0');
  await film.getByRole('button', { name: 'Смотреть урок', exact: true }).click();
  await expect.poll(async () => Number(await timeline.inputValue())).toBeGreaterThan(.5);
  await seek(5.5); await expect(canvas).toHaveAttribute('data-chapter', 'chapter-1');
  await page.evaluate(() => (window as any).__releaseFirstPlay());
  await expect.poll(async () => Number(await timeline.inputValue())).toBeGreaterThan(5.8);
  await film.getByRole('button', { name: 'Пауза', exact: true }).click();
  const paused = Number(await timeline.inputValue()); await page.waitForTimeout(250); expect(Math.abs(Number(await timeline.inputValue()) - paused)).toBeLessThan(.08);
  for (let i = 0; i < chapters.length; i++) { await seek(chapters[i].start + 1); await expect(canvas).toHaveAttribute('data-chapter', chapters[i].id); }
  await seek(5.5); await expect(canvas).toHaveAttribute('data-time', '5.50'); const camera = await canvas.getAttribute('data-camera'); await seek(14.5); await seek(5.5); await expect(canvas).toHaveAttribute('data-time', '5.50'); expect(await canvas.getAttribute('data-camera')).toBe(camera);
  await seek(1.6); await film.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-chapter', 'chapter-1', { timeout: 8000 });
  await film.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(film.getByRole('button', { name: 'Закрыть урок' })).toBeVisible();
  await film.getByRole('button', { name: 'Закрыть урок' }).click(); await expect(film).not.toBeVisible(); expect(attendance).toEqual([]); expect(errors).toEqual([]);
});
