import type { CinemaBeat, CinemaChapter } from './types';
import { formulaAt, formulaMarkup } from './lessonMath';
import { sceneThemeAt } from './sceneTheme';

const clamp = (value: number, lower = 0, upper = 1) => Math.max(lower, Math.min(upper, value));
const out = (value: number) => 1 - (1 - clamp(value)) ** 4;
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const fixed = (value: number) => Number(value.toFixed(4));
const escaped = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);

/** Real narrated beat times map to the renderer's evenly spaced story stations. */
export function sceneProgressAt(chapter: CinemaChapter, progress: number): number {
  if (!chapter.beats?.length) return clamp(progress);
  const elapsed = clamp(progress) * chapter.duration;
  const index = chapter.beats.reduce((found, beat, at) => beat.at <= elapsed ? at : found, 0);
  const start = chapter.beats[index].at;
  const end = chapter.beats[index + 1]?.at || chapter.duration;
  return clamp((index + clamp((elapsed - start) / Math.max(.01, end - start))) / chapter.beats.length);
}

export type CinemaPresentation = {
  beat: CinemaBeat;
  beatIndex: number;
  age: number;
  beatProgress: number;
  headlineOpacity: number;
  headlineTransform: string;
  formulaOpacity: number;
  formulaTransform: string;
  noteOpacity: number;
  accentScale: number;
  heroOpacity: number;
  heroTransform: string;
  wipeOpacity: number;
  wipeTransform: string;
};

/**
 * Every reveal samples film time. Pause, reverse seek, and offline export therefore
 * paint the same pose; none of the lesson's typography runs on a CSS clock.
 */
export function presentationAt(chapter: CinemaChapter, progress: number, reducedMotion = false): CinemaPresentation {
  const elapsed = clamp(progress) * chapter.duration;
  const beats = chapter.beats?.length ? chapter.beats : [{
    at: 0, headline: chapter.title, formula: chapter.formula,
    note: chapter.cues?.filter(cue => cue.at <= elapsed).at(-1)?.text || chapter.caption,
    emphasis: 'equation' as const,
  }];
  const beatIndex = beats.reduce((found, beat, index) => beat.at <= elapsed ? index : found, 0);
  const beat = beats[beatIndex];
  const age = Math.max(0, elapsed - beat.at);
  const beatDuration = Math.max(.5, (beats[beatIndex + 1]?.at || chapter.duration) - beat.at);
  const beatProgress = clamp(age / beatDuration);
  const entry = reducedMotion ? 1 : out(age / .62);
  const detailEntry = reducedMotion ? 1 : out((age - .14) / .58);
  // The opening label leaves the laboratory visible and resolves within a second.
  const heroOpacity = reducedMotion ? 0 : 1 - smooth((elapsed - .36) / .5);
  const mathReveal = reducedMotion ? 1 : smooth((elapsed - .28) / .32);
  const headlineTransform = reducedMotion ? 'none' : `translate3d(0,${fixed((1 - entry) * 5)}px,0)`;
  return {
    beat, beatIndex, age, beatProgress,
    headlineOpacity: fixed((.24 + entry * .76) * mathReveal),
    headlineTransform,
    formulaOpacity: fixed(detailEntry * mathReveal),
    formulaTransform: reducedMotion ? 'none' : `translate3d(0,${fixed((1 - detailEntry) * 8)}px,0)`,
    noteOpacity: fixed((reducedMotion ? 1 : out((age - .42) / .5)) * mathReveal),
    accentScale: fixed(reducedMotion ? 1 : out((age - .12) / .8)),
    heroOpacity: fixed(heroOpacity),
    heroTransform: reducedMotion ? 'none' : `translate3d(0,${fixed(-8 + out(elapsed / .28) * 8 - smooth((elapsed - .36) / .5) * 5)}px,0)`,
    wipeOpacity: 0,
    wipeTransform: 'none',
  };
}

/** Shared app/export overlay. Content always passes through escaping. */
export function presentationMarkup(chapter: CinemaChapter, progress: number, chapterIndex = 0, totalChapters = 10, reducedMotion = false): string {
  const state = presentationAt(chapter, progress, reducedMotion);
  const { beat } = state;
  const formula = formulaAt(chapter, progress);
  const stackedFormula = formula.includes('lim') || formula.startsWith('((2 + h)²') || formula.startsWith('(4h + h²)') || formula.startsWith('ΔS / h');
  const theme = sceneThemeAt(chapter.scene, sceneProgressAt(chapter, progress));
  return `<div class="film-overlay film-theme-${theme}" data-theme="${theme}">
  <div class="film-math film-emphasis-${escaped(beat.emphasis || 'equation')}" data-beat="${state.beatIndex}">
    <h1 class="film-headline" aria-label="${escaped(beat.headline)}" style="opacity:${state.headlineOpacity};transform:${state.headlineTransform}">${escaped(beat.headline)}</h1>
    <div class="film-formula${!stackedFormula && formula.length > 29 ? ' film-formula-long' : ''}${!stackedFormula && formula.length > 44 ? ' film-formula-wide' : ''}" role="math" aria-label="${escaped(formula)}" style="opacity:${state.formulaOpacity};transform:${state.formulaTransform}">${formulaMarkup(chapter, progress)}</div>
    ${beat.note ? `<p class="film-cue" style="opacity:${state.noteOpacity}">${escaped(beat.note)}</p>` : ''}
  </div>
  <div class="film-hero" aria-hidden="true" style="opacity:${state.heroOpacity};transform:${state.heroTransform}"><span>${String(chapterIndex + 1).padStart(2, '0')} / ${String(totalChapters).padStart(2, '0')}</span><strong>${escaped(chapter.title)}</strong></div>
  </div>`;
}
