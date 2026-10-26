import type { DerivativeSceneKey } from './types';

export type LabCue = Readonly<{ at: number; progress: number; id: string; label: string }>;
export type LabCueSample = LabCue & { cueProgress: number };

/** Speech events for the unchanged Puck narration (tempo 1.1).
 * at = seconds within the FINISHED chapter, not global film seconds.
 * progress = canonical scene progress used by sceneProgressAt: five stations
 * 0, .2, .4, .6, .8; the final station ends at audioDuration + 2.5 seconds.
 * Sources: existing raw ASR word timings / 1.1 and approved voice beatTimes.
 * Labels use the authored mathematics, never ASR's misrecognized decimal digits.
 * The merged negative-decimal tokens are revealed at their END to avoid spoilers.
 * These are action cues, not UI captions. No timers, media or renderer dependency.
 */
export const labCues: Readonly<Record<DerivativeSceneKey, readonly LabCue[]>> = {
  intro: [
    {"at": 0.0, "progress": 0.0, "id": "car-launch", "label": "Машина разгоняется"},
    {"at": 2.7, "progress": 0.04285714, "id": "speed-80", "label": "80 км/ч"},
    {"at": 3.6, "progress": 0.05714286, "id": "car-freeze", "label": "Стоп-кадр"},
    {"at": 12.6, "progress": 0.2, "id": "journey-average", "label": "Километры / часы"},
    {"at": 23.236, "progress": 0.4, "id": "coffee-reveal", "label": "Утренний кофе"},
    {"at": 27.527, "progress": 0.49129787, "id": "coffee-cools", "label": "Кофе остывает"},
    {"at": 32.636, "progress": 0.6, "id": "ball-reveal", "label": "Подбросим мяч"},
    {"at": 34.127, "progress": 0.62534852, "id": "ball-rise", "label": "Мяч взлетает"},
    {"at": 35.518, "progress": 0.64899694, "id": "ball-peak", "label": "Мяч замирает"},
    {"at": 36.164, "progress": 0.6599796, "id": "ball-fall", "label": "Мяч падает"},
    {"at": 44.4, "progress": 0.8, "id": "derivative-reveal", "label": "Одна идея — производная"},
    {"at": 54.882, "progress": 0.95320688, "id": "launch-next", "label": "Поехали"},
  ],
  motion: [
    {"at": 0.0, "progress": 0.0, "id": "model", "label": "s(t) = t²"},
    {"at": 8.291, "progress": 0.16070944, "id": "straight-road", "label": "Движение по прямой"},
    {"at": 10.318, "progress": 0.2, "id": "car-t1", "label": "t = 1 с"},
    {"at": 12.445, "progress": 0.24130097, "id": "mark-1", "label": "s = 1 м"},
    {"at": 20.618, "progress": 0.4, "id": "car-t2", "label": "t = 2 с"},
    {"at": 21.745, "progress": 0.41955409, "id": "mark-4", "label": "s = 4 м"},
    {"at": 22.718, "progress": 0.43643619, "id": "car-t3", "label": "t = 3 с"},
    {"at": 23.427, "progress": 0.44873775, "id": "mark-9", "label": "s = 9 м"},
    {"at": 32.145, "progress": 0.6, "id": "graph-recording", "label": "Движение → график"},
    {"at": 37.582, "progress": 0.6967696, "id": "graph-points", "label": "(1;1), (2;4), (3;9)"},
    {"at": 43.382, "progress": 0.8, "id": "linked-motion", "label": "Дорога и график"},
    {"at": 49.527, "progress": 0.88767873, "id": "slope-speed", "label": "Наклон = скорость"},
  ],
  average: [
    {"at": 0.0, "progress": 0.0, "id": "two-frames", "label": "Первая и третья секунды"},
    {"at": 4.627, "progress": 0.08737607, "id": "point-a", "label": "A = (1;1)"},
    {"at": 6.455, "progress": 0.12189595, "id": "point-b", "label": "B = (3;9)"},
    {"at": 10.591, "progress": 0.2, "id": "coordinate-difference", "label": "Δs = 9 − 1"},
    {"at": 13.773, "progress": 0.25072937, "id": "distance-8", "label": "Δs = 8 м"},
    {"at": 16.845, "progress": 0.29970506, "id": "time-2", "label": "Δt = 2 с"},
    {"at": 19.227, "progress": 0.33768035, "id": "rise-run", "label": "Треугольник 2 × 8"},
    {"at": 24.482, "progress": 0.42631991, "id": "speed-4", "label": "vср = 4 м/с"},
    {"at": 33.364, "progress": 0.6, "id": "secant-draw", "label": "Две точки → секущая"},
    {"at": 37.718, "progress": 0.66160158, "id": "ratio-link", "label": "Наклон = Δs / Δt"},
    {"at": 47.5, "progress": 0.8, "id": "acceleration", "label": "Среднее и разгон"},
    {"at": 56.555, "progress": 0.92388659, "id": "focus-two", "label": "Фиксируем t = 2 с"},
  ],
  secant: [
    {"at": 0.0, "progress": 0.0, "id": "anchor-a", "label": "A = (2;4)"},
    {"at": 13.827, "progress": 0.21644451, "id": "h-1", "label": "h = 1"},
    {"at": 22.055, "progress": 0.3318928, "id": "slope-5", "label": "Наклон 5"},
    {"at": 26.909, "progress": 0.4, "id": "approach-01", "label": "Сжимаем интервал"},
    {"at": 28.418, "progress": 0.42374695, "id": "h-01", "label": "h = 0,1"},
    {"at": 35.591, "progress": 0.53662759, "id": "slope-41", "label": "Наклон 4,1"},
    {"at": 39.618, "progress": 0.6, "id": "approach-001", "label": "Ещё ближе"},
    {"at": 40.3, "progress": 0.60985122, "id": "h-001", "label": "h = 0,01"},
    {"at": 42.6, "progress": 0.64307381, "id": "slope-401", "label": "Наклон 4,01"},
    {"at": 53.464, "progress": 0.8, "id": "quotient", "label": "((2+h)² − 4) / h"},
    {"at": 59.345, "progress": 0.87289178, "id": "expand-cancel", "label": "Раскрываем и сокращаем"},
    {"at": 63.127, "progress": 0.9197676, "id": "four-plus-h", "label": "4 + h"},
    {"at": 65.382, "progress": 0.9477171, "id": "nonzero-h", "label": "h ≠ 0"},
  ],
  limit: [
    {"at": 0.0, "progress": 0.0, "id": "right-approach", "label": "Приближаемся справа"},
    {"at": 1.9, "progress": 0.03154836, "id": "right-01", "label": "h = 0,1; наклон 4,1"},
    {"at": 3.845, "progress": 0.06384392, "id": "right-001", "label": "h = 0,01; наклон 4,01"},
    {"at": 12.045, "progress": 0.2, "id": "left-approach", "label": "Приближаемся слева"},
    {"at": 13.2, "progress": 0.21951508, "id": "h-negative-01", "label": "h = −0,1; наклон 3,9"},
    {"at": 16.236, "progress": 0.27081186, "id": "left-001-approach", "label": "Ещё ближе слева"},
    {"at": 19.582, "progress": 0.32734646, "id": "h-negative-001", "label": "h = −0,01; наклон 3,99"},
    {"at": 21.809, "progress": 0.36497423, "id": "both-to-four", "label": "С двух сторон → 4"},
    {"at": 25.536, "progress": 0.4279912, "id": "zero-division", "label": "0 / 0 не определено"},
    {"at": 35.7, "progress": 0.6, "id": "definition", "label": "Предел отношения изменений"},
    {"at": 49.482, "progress": 0.8, "id": "instant-speed", "label": "Скорость на второй секунде"},
    {"at": 51.409, "progress": 0.82665429, "id": "speed-4", "label": "s′(2) = 4 м/с"},
  ],
  tangent: [
    {"at": 0.0, "progress": 0.0, "id": "secant-settles", "label": "Секущая → касательная"},
    {"at": 4.145, "progress": 0.05742588, "id": "local-zoom", "label": "Приблизим гладкую кривую"},
    {"at": 14.436, "progress": 0.2, "id": "coffee-reveal", "label": "Проверим на кофе"},
    {"at": 16.164, "progress": 0.227019, "id": "coffee-70", "label": "T₀ = 70 °C"},
    {"at": 20.291, "progress": 0.29154875, "id": "coffee-rate", "label": "T′(t₀) = −2 °C/мин"},
    {"at": 27.227, "progress": 0.4, "id": "local-prediction", "label": "Температура + скорость × время"},
    {"at": 33.927, "progress": 0.50461394, "id": "coffee-linear", "label": "T ≈ 70 − 2Δt"},
    {"at": 40.318, "progress": 0.6040494, "id": "half-minute", "label": "Δt = 0,5 мин"},
    {"at": 42.618, "progress": 0.63707639, "id": "coffee-69", "label": "T ≈ 69 °C"},
    {"at": 52.309, "progress": 0.77623492, "id": "curves-diverge", "label": "Вдали расходятся"},
    {"at": 53.964, "progress": 0.8, "id": "hour-extrapolation", "label": "Линейный прогноз на час"},
    {"at": 65.427, "progress": 0.94428661, "id": "local-only", "label": "Приближение работает рядом"},
  ],
  rules: [
    {"at": 0.0, "progress": 0.0, "id": "square", "label": "S = x²"},
    {"at": 6.145, "progress": 0.10141938, "id": "square-expand", "label": "Увеличиваем сторону на h"},
    {"at": 12.118, "progress": 0.2, "id": "strip-right", "label": "Правая полоса xh"},
    {"at": 14.436, "progress": 0.24541091, "id": "strip-top", "label": "Верхняя полоса xh"},
    {"at": 15.964, "progress": 0.27534528, "id": "corner", "label": "Уголок h²"},
    {"at": 25.382, "progress": 0.44759679, "id": "shrink-h", "label": "h → 0"},
    {"at": 31.927, "progress": 0.54956766, "id": "two-x", "label": "(x²)′ = 2x"},
    {"at": 37.782, "progress": 0.64207312, "id": "constant-zero", "label": "(c)′ = 0"},
    {"at": 45.964, "progress": 0.77356368, "id": "cube-rule", "label": "(x³)′ = 3x²"},
    {"at": 47.609, "progress": 0.8, "id": "sum-example", "label": "(3x² + 5)′"},
    {"at": 54.791, "progress": 0.89615316, "id": "constant-vanishes", "label": "Постоянная пятёрка исчезает"},
    {"at": 56.173, "progress": 0.91465548, "id": "six-x", "label": "Ответ: 6x"},
  ],
  chain: [
    {"at": 0.0, "progress": 0.0, "id": "mechanism", "label": "Две ступени изменения"},
    {"at": 5.982, "progress": 0.09806557, "id": "times-three", "label": "Первый коэффициент: 3"},
    {"at": 12.2, "progress": 0.2, "id": "second-stage", "label": "u → u²"},
    {"at": 25.627, "progress": 0.43061578, "id": "rate-three", "label": "du / dx = 3"},
    {"at": 26.855, "progress": 0.44836658, "id": "rate-two-u", "label": "dy / du = 2u"},
    {"at": 27.818, "progress": 0.46228679, "id": "impulse", "label": "Импульс через обе ступени"},
    {"at": 30.945, "progress": 0.50748771, "id": "multiply-rates", "label": "3 × 2u"},
    {"at": 37.345, "progress": 0.6, "id": "substitute-u", "label": "u = 3x + 1"},
    {"at": 40.764, "progress": 0.65839453, "id": "chain-result", "label": "6(3x + 1)"},
    {"at": 49.055, "progress": 0.8, "id": "product-rectangle", "label": "Две меняющиеся стороны"},
    {"at": 57.918, "progress": 0.91353844, "id": "product-first", "label": "f′g"},
    {"at": 58.845, "progress": 0.92541367, "id": "product-second", "label": "fg′"},
  ],
  extrema: [
    {"at": 0.0, "progress": 0.0, "id": "ball-model", "label": "H(t) = −t² + 4t"},
    {"at": 7.745, "progress": 0.12510095, "id": "ball-rise", "label": "Мяч взлетает"},
    {"at": 9.573, "progress": 0.15462769, "id": "ball-fall", "label": "Мяч падает"},
    {"at": 14.891, "progress": 0.23889922, "id": "velocity-law", "label": "H′(t) = 4 − 2t"},
    {"at": 25.282, "progress": 0.4, "id": "ball-peak", "label": "Мяч на вершине"},
    {"at": 27.018, "progress": 0.43014412, "id": "ball-zero", "label": "Скорость равна нулю"},
    {"at": 30.373, "progress": 0.48840076, "id": "ball-time-2", "label": "t = 2 с"},
    {"at": 33.173, "progress": 0.53702032, "id": "ball-height-4", "label": "H = 4 м"},
    {"at": 38.582, "progress": 0.62899683, "id": "positive-before", "label": "До вершины: плюс"},
    {"at": 39.682, "progress": 0.6468961, "id": "negative-after", "label": "После вершины: минус"},
    {"at": 49.091, "progress": 0.8, "id": "cubic-counterexample", "label": "f(x) = x³"},
    {"at": 52.573, "progress": 0.84532809, "id": "horizontal-tangent", "label": "f′(0) = 0"},
    {"at": 54.164, "progress": 0.86603946, "id": "growth-continues", "label": "Рост продолжается"},
  ],
  outro: [
    {"at": 0.0, "progress": 0.0, "id": "car-recap", "label": "Машина: s = t², v = 2t"},
    {"at": 6.364, "progress": 0.11006572, "id": "car-speed-4", "label": "t = 2 с → v = 4 м/с"},
    {"at": 8.491, "progress": 0.1468523, "id": "car-speed-6", "label": "t = 3 с → v = 6 м/с"},
    {"at": 11.564, "progress": 0.2, "id": "coffee-recap", "label": "Кофе: отрицательная производная"},
    {"at": 25.236, "progress": 0.4, "id": "ball-recap", "label": "Мяч: рост → вершина → падение"},
    {"at": 27.709, "progress": 0.43716282, "id": "ball-peak", "label": "Ноль на вершине"},
    {"at": 29.091, "progress": 0.45793072, "id": "ball-fall", "label": "Отрицательная скорость"},
    {"at": 38.545, "progress": 0.6, "id": "two-states", "label": "Два близких состояния"},
    {"at": 46.827, "progress": 0.71246605, "id": "limit", "label": "Находим предел"},
    {"at": 48.518, "progress": 0.73542911, "id": "tangent", "label": "Секущая → касательная"},
    {"at": 53.273, "progress": 0.8, "id": "three-worlds", "label": "Машина, кофе, мяч"},
    {"at": 63.873, "progress": 0.95007521, "id": "right-now", "label": "Прямо сейчас"},
  ],
};

const idleCue: LabCue = { at: 0, progress: 0, id: 'idle', label: '' };
const clampProgress = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const cuesFor = (scene: string): readonly LabCue[] =>
  Object.prototype.hasOwnProperty.call(labCues, scene) ? labCues[scene as DerivativeSceneKey] : [];

/** Lookup for geometry thresholds, e.g. labCueById('motion', 'mark-4')?.progress. */
export function labCueById(scene: string, id: string): LabCue | undefined {
  return cuesFor(scene).find(cue => cue.id === id);
}

/** Stateless sampling: direct seeking and reverse seeking give the same action.
 * cueProgress is 0 at this spoken event, 1 at the next event (or chapter end).
 * Unknown scenes safely return idle; NaN/infinite progress samples the start.
 */
export function labCueAt(scene: string, canonicalProgress: number): LabCueSample {
  const cues = cuesFor(scene);
  if (!cues.length) return { ...idleCue, cueProgress: 0 };
  const progress = clampProgress(canonicalProgress);
  let index = 0;
  for (let i = 1; i < cues.length && cues[i].progress <= progress; i++) index = i;
  const cue = cues[index];
  const end = cues[index + 1]?.progress ?? 1;
  const cueProgress = clampProgress((progress - cue.progress) / Math.max(1e-9, end - cue.progress));
  return { ...cue, cueProgress };
}
