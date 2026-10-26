/** Canonical five-beat scene clock; shared by WebGL, HUD, and offline export. */
export type SceneTheme = 'dark' | 'light';

export function sceneThemeAt(scene: string, progress: number): SceneTheme {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const beat = Math.min(4, Math.floor(p * 5));
  return (scene === 'intro' && beat === 2)
    || (scene === 'tangent' && beat >= 1)
    || scene === 'rules'
    || (scene === 'chain' && beat === 4)
    || (scene === 'outro' && beat === 1)
    ? 'light' : 'dark';
}
