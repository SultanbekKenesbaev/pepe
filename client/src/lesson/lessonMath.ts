import type { CinemaChapter } from './types';
import { labFormulaAt } from './labFormula';

/** One mathematical statement at a time; long rule lists never fill the frame. */
export function formulaAt(chapter: CinemaChapter, progress: number): string {
  if (chapter.beats?.length) {
    const elapsed = Math.max(0, Math.min(1, progress)) * chapter.duration;
    const spoken = labFormulaAt(chapter.scene, elapsed);
    if (spoken !== undefined) return spoken;
    const beat = chapter.beats.filter(item => item.at <= elapsed).at(-1) || chapter.beats[0];
    return beat.formula || '';
  }
  switch (chapter.scene) {
    case 'average': return progress < .23 ? 'Δs = 9 − 1 = 8 м' : progress < .45 ? 'Δt = 3 − 1 = 2 с' : 'vср = 8 / 2 = 4 м/с';
    case 'secant': return progress < .26 ? 'A = (2, 4)' : progress < .52 ? '((2 + h)² − 4) / h' : progress < .75 ? '(4h + h²) / h = 4 + h' : '5 → 4,1 → 4,01 → 4';
    case 'limit': return progress < .27 ? '3,99 → 4 ← 4,01' : progress < .5 ? 'h → 0,  h ≠ 0' : progress < .78 ? 'f′(a) = limₕ→₀ [f(a + h) − f(a)] / h' : 's′(2) = 4 м/с';
    case 'tangent': return progress < .48 ? 'y = 4 + 4(x − 2)' : progress < .78 ? '4,0401 ≈ 4,04' : 'f(a + h) ≈ f(a) + f′(a)h';
    case 'rules': return progress < .25 ? '(x²)′ = 2x' : progress < .51 ? 'ΔS = 2xh + h²' : progress < .75 ? 'ΔS / h = 2x + h → 2x' : '(xⁿ)′ = nxⁿ⁻¹';
    case 'chain': return progress < .27 ? 'x → 3x + 1 → (3x + 1)²' : progress < .53 ? 'y′ = 2(3x + 1) · 3' : '(fg)′ = f′g + fg′';
    case 'extrema': return progress < .25 ? 'f(x) = x³ − 3x' : progress < .5 ? 'f′(x) = 3x² − 3' : progress < .77 ? '+  |  −  |  +' : '(x³)′|ₓ₌₀ = 0';
    case 'outro': return progress < .5 ? 'Изменение → предел' : 's(t) = t²  →  v(t) = 2t';
    default: return chapter.formula || '';
  }
}

const escapeMath = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fraction = (numerator: string, denominator: string) => `<span class="math-frac"><span class="math-num">${escapeMath(numerator)}</span><span class="math-den">${escapeMath(denominator)}</span></span>`;

/** Safe shared HTML for the app and the export composition; all variable text is escaped. */
export function formulaMarkup(chapter: CinemaChapter, progress: number): string {
  if (chapter.beats?.length) {
    const formula = formulaAt(chapter, progress);
    if (/f′\(a\).*lim.*f\(a\s*\+\s*h\)/u.test(formula)) {
      return `<span class="math-equation math-definition" aria-hidden="true"><span>f′(a) =</span><span class="math-lim"><span>lim</span><small>h → 0</small></span>${fraction('f(a + h) − f(a)', 'h')}</span>`;
    }
    if (/^\(\(2\s*\+\s*h\)²\s*−\s*4\)\s*\/\s*h/u.test(formula)) {
      return `<span class="math-equation" aria-hidden="true">${fraction('(2 + h)² − 4', 'h')}${formula.includes('4 + h') ? '<span class="math-result">= 4 + h</span>' : ''}</span>`;
    }
    if (/^\(4h\s*\+\s*h²\)\s*\/\s*h/u.test(formula)) {
      return `<span class="math-equation" aria-hidden="true">${fraction('4h + h²', 'h')}<span class="math-result">= 4 + h</span></span>`;
    }
    if (formula.startsWith('ΔS / h')) {
      return `<span class="math-equation" aria-hidden="true">${fraction('ΔS', 'h')}<span class="math-result">${escapeMath(formula.slice(6))}</span></span>`;
    }
    return `<span aria-hidden="true">${escapeMath(formula)}</span>`;
  }
  if (chapter.scene === 'limit' && progress >= .5 && progress < .78) {
    return `<span class="math-equation math-definition" aria-hidden="true"><span>f′(a) =</span><span class="math-lim"><span>lim</span><small>h → 0</small></span>${fraction('f(a + h) − f(a)', 'h')}</span>`;
  }
  if (chapter.scene === 'secant' && progress >= .26 && progress < .75) {
    const simplified = progress >= .52;
    return `<span class="math-equation" aria-hidden="true">${fraction(simplified ? '4h + h²' : '(2 + h)² − 4', 'h')}${simplified ? '<span class="math-result">= 4 + h</span>' : ''}</span>`;
  }
  if (chapter.scene === 'rules' && progress >= .51 && progress < .75) {
    return `<span class="math-equation" aria-hidden="true">${fraction('ΔS', 'h')}<span class="math-result">= 2x + h → 2x</span></span>`;
  }
  return `<span aria-hidden="true">${escapeMath(formulaAt(chapter, progress))}</span>`;
}

