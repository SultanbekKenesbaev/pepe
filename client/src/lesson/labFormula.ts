import { labCues } from './labCues';
import type { DerivativeSceneKey } from './types';

/** Values land on the same spoken cues as their physical models. */
const statements: Record<DerivativeSceneKey, Record<string, string>> = {
  intro: {
    'car-launch': '', 'speed-80': '80 км/ч', 'journey-average': 'Путь / время',
    'coffee-reveal': 'T(t)', 'coffee-cools': 'T′(t) < 0', 'ball-reveal': 'H(t)',
    'ball-rise': 'H′(t) > 0', 'ball-peak': 'H′(t) = 0', 'ball-fall': 'H′(t) < 0',
    'derivative-reveal': 'f′(t)',
  },
  motion: {
    model: 's(t) = t²', 'car-t1': 't = 1 с', 'mark-1': 't = 1 с → s = 1 м',
    'car-t2': 't = 2 с', 'mark-4': 't = 2 с → s = 4 м',
    'car-t3': 't = 3 с', 'mark-9': 't = 3 с → s = 9 м',
    'graph-recording': 's(t) = t²', 'graph-points': '(1; 1) · (2; 4) · (3; 9)',
    'linked-motion': 's(t) = t²', 'slope-speed': 'v(t) = s′(t)',
  },
  average: {
    'two-frames': 't₁ = 1 с · t₂ = 3 с', 'point-a': 'A = (1; 1)', 'point-b': 'A = (1; 1) · B = (3; 9)',
    'coordinate-difference': 'Δs = 9 − 1', 'distance-8': 'Δs = 8 м', 'time-2': 'Δt = 2 с',
    'rise-run': 'Δs / Δt = 8 / 2', 'speed-4': 'vср = 4 м/с',
    'secant-draw': 'Наклон = Δs / Δt', 'acceleration': 'Средняя — за интервал', 'focus-two': 't = 2 с',
  },
  secant: {
    'anchor-a': 'A = (2; 4)', 'h-1': 'h = 1', 'slope-5': 'h = 1 → k = 5',
    'approach-01': 'h ↓', 'h-01': 'h = 0,1', 'slope-41': 'h = 0,1 → k = 4,1',
    'approach-001': 'h ↓', 'h-001': 'h = 0,01', 'slope-401': 'h = 0,01 → k = 4,01',
    quotient: '((2 + h)² − 4) / h', 'expand-cancel': '(4h + h²) / h = 4 + h',
    'four-plus-h': '4 + h', 'nonzero-h': '4 + h, h ≠ 0',
  },
  limit: {
    'right-approach': 'h → 0⁺', 'right-01': 'h = 0,1 → k = 4,1', 'right-001': 'h = 0,01 → k = 4,01',
    'left-approach': 'h → 0⁻', 'h-negative-01': 'h = −0,1 → k = 3,9',
    'left-001-approach': 'h → 0⁻', 'h-negative-001': 'h = −0,01 → k = 3,99',
    'both-to-four': '3,99 → 4 ← 4,01', 'zero-division': '0 / 0 не определено',
    definition: 'f′(a) = limₕ→₀ [f(a + h) − f(a)] / h',
    'instant-speed': 's′(2)', 'speed-4': 's′(2) = 4 м/с',
  },
  tangent: {
    'secant-settles': 'Секущая → касательная', 'local-zoom': 'f(a + h) ≈ f(a) + f′(a)h',
    'coffee-reveal': 'T(t)', 'coffee-70': 'T₀ = 70 °C', 'coffee-rate': 'T′(t₀) = −2 °C/мин',
    'local-prediction': 'T ≈ T₀ + T′(t₀)Δt', 'coffee-linear': 'T ≈ 70 − 2Δt',
    'half-minute': 'Δt = 0,5 мин', 'coffee-69': 'T ≈ 70 − 2 · 0,5 = 69 °C',
    'curves-diverge': 'Приближение: Δt → 0', 'hour-extrapolation': 'Линейный прогноз ≠ точный закон',
    'local-only': 'f(a + h) ≈ f(a) + f′(a)h',
  },
  rules: {
    square: 'S = x²', 'square-expand': 'ΔS = (x + h)² − x²',
    'strip-right': 'xh', 'strip-top': 'xh + xh', corner: 'ΔS = 2xh + h²',
    'shrink-h': 'ΔS / h = 2x + h → 2x', 'two-x': '(x²)′ = 2x',
    'constant-zero': '(c)′ = 0', 'cube-rule': '(x³)′ = 3x²',
    'sum-example': '(3x² + 5)′', 'constant-vanishes': '3 · 2x + 0', 'six-x': '(3x² + 5)′ = 6x',
  },
  chain: {
    mechanism: 'x → u = 3x + 1', 'times-three': 'du / dx = 3', 'second-stage': 'u → y = u²',
    'rate-three': 'du / dx = 3', 'rate-two-u': 'dy / du = 2u',
    'multiply-rates': 'dy / dx = 2u · 3', 'substitute-u': 'u = 3x + 1',
    'chain-result': 'y′ = 6(3x + 1)', 'product-rectangle': 'S = f · g',
    'product-first': '(fg)′ = f′g + …', 'product-second': '(fg)′ = f′g + fg′',
  },
  extrema: {
    'ball-model': 'H(t) = −t² + 4t', 'velocity-law': 'H′(t) = 4 − 2t',
    'ball-peak': 'H′(t)', 'ball-zero': '4 − 2t = 0', 'ball-time-2': 't = 2 с', 'ball-height-4': 'H(2) = 4 м',
    'positive-before': 't < 2 → H′(t) > 0', 'negative-after': 't > 2 → H′(t) < 0',
    'cubic-counterexample': 'f(x) = x³', 'horizontal-tangent': 'f′(0) = 0',
    'growth-continues': 'f(x) = x³: экстремума нет',
  },
  outro: {
    'car-recap': 's(t) = t² → v(t) = 2t', 'car-speed-4': 'v(2) = 4 м/с', 'car-speed-6': 'v(3) = 6 м/с',
    'coffee-recap': 'T′(t) < 0', 'ball-recap': 'H′: + → 0 → −', 'ball-peak': 'H′(2) = 0',
    'ball-fall': 'H′(t) < 0', 'two-states': 'Δf / Δx',
    limit: 'f′(a) = limₕ→₀ [f(a + h) − f(a)] / h', 'tangent': 'Наклон касательной = f′(a)',
    'three-worlds': 'Скорость изменения', 'right-now': 'Прямо сейчас',
  },
};

export function labFormulaAt(scene: DerivativeSceneKey, elapsed: number): string | undefined {
  const cues = labCues[scene], byId = statements[scene];
  if (!cues || !byId || !Number.isFinite(elapsed)) return undefined;
  let formula: string | undefined;
  for (const cue of cues) {
    if (cue.at > elapsed + 1e-6) break;
    if (Object.prototype.hasOwnProperty.call(byId, cue.id)) formula = byId[cue.id];
  }
  return formula;
}
