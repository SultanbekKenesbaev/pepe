import { test, expect } from '@playwright/test';

test('3D laboratory loads its local car, moves the camera, changes lighting and restores a sought pose', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill('demo@aiteacher.local');
  await page.getByLabel('Пароль', { exact: true }).fill('PepeOnly-teacher-2026!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/teach$/);
  await page.goto('/teach?preview=derivative');
  const stage = page.getByRole('region', { name: 'Урок: Производная' });
  const canvas = stage.locator('canvas');
  await expect(canvas).toHaveAttribute('data-car-asset', 'gltf', { timeout: 30_000 });
  const slider = page.getByRole('slider', { name: 'Позиция урока' });
  const play = page.getByRole('button', { name: 'Продолжить урок', exact: true });
  if (await play.isVisible()) await play.click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(.5);
  await stage.hover();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const manifest = await (await page.request.get('/api/cinema/derivative')).json();
  async function seek(seconds: number) {
    await stage.hover();
    const box = (await slider.boundingBox())!;
    // Native range values span the thumb's centre positions, not the outer box.
    await page.mouse.click(box.x + 4 + (box.width - 8) * seconds / manifest.duration, box.y + box.height / 2);
  }
  await seek(6);
  await expect(canvas).toHaveAttribute('data-theme', 'dark');
  const firstCamera = (await canvas.getAttribute('data-camera-position'))!;
  await seek(10);
  const secondCamera = (await canvas.getAttribute('data-camera-position'))!;
  const distance = Math.hypot(...secondCamera.split(',').map((value, index) => Number(value) - Number(firstCamera.split(',')[index])));
  expect(distance).toBeGreaterThan(.3);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: '../Derivative-Lab.png' });
  const coffee = manifest.chapters.find((chapter: any) => chapter.scene === 'tangent');
  await seek(coffee.start + coffee.beats[1].at + 4);
  await expect(stage).toHaveAttribute('data-theme', 'light');
  await expect(canvas).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.film-formula')).toContainText('70');
  await page.screenshot({ path: '../Derivative-Lab-Light.png' });
  await seek(6);
  await expect(canvas).toHaveAttribute('data-camera-position', firstCamera);
  expect(errors).toEqual([]);
});
