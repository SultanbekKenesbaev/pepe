import type { GeneratedLesson, GeneratedLessonProgress } from '../shared/types.js';

const seconds = (from: string | undefined, at: number) => from && Number.isFinite(Date.parse(from))
  ? Math.max(0, Math.floor((at - Date.parse(from)) / 1000)) : 0;
const ratio = (done: number, total: number) => Number.isFinite(done) && Number.isFinite(total) && total > 0
  ? Math.max(0, Math.min(1, done / total)) : 0;

/** These ranges describe the current CPU renderer, not a promised completion deadline.
 * LLM phases have no measurable fraction: their percentage stays at a milestone. */
export function refreshGenerationProgress(lesson: GeneratedLesson, at = Date.now()): GeneratedLesson {
  const p = lesson.progress;
  const illustrated = lesson.videoMode === '2d';
  const terminal = ['ready', 'failed', 'language_review', 'draft'].includes(lesson.status);
  p.elapsedSeconds = seconds(lesson.generationStartedAt || lesson.createdAt, terminal && Number.isFinite(Date.parse(lesson.updatedAt)) ? Date.parse(lesson.updatedAt) : at);
  if (lesson.status === 'ready') p.percent = 100;
  else if (lesson.status !== 'failed') {
    const phase = p.phase;
    let percent = 0;
    if (p.stage === 'script') percent = 5;
    if (p.stage === 'review') percent = 10;
    if (p.stage === 'voice') percent = 10 + 15 * ratio(p.completed, p.total);
    if (p.stage === 'language_review') percent = 25;
    if (p.stage === 'visuals') percent = ({ queued: 25, alignment: 25, images: 28, authoring: illustrated ? 28 : 25, checking: 45, reviewing: 50, rendering: 60, validating: 96, downloading: 98 }[phase || 'authoring']);
    if (p.stage === 'visuals' && phase === 'rendering' && p.frames) percent += 36 * ratio(p.frames.completed, p.frames.total);
    if (p.stage === 'checking') percent = 99;
    p.percent = Math.max(0, Math.min(99, Math.floor(percent)));
  } else if (p.percent !== undefined) p.percent = Math.max(0, Math.min(99, p.percent));
  delete p.estimatedRemainingSeconds;
  if (terminal) return lesson;
  let range: [number, number] = illustrated ? [30 * 60, 120 * 60] : [60 * 60, 180 * 60];
  if (p.stage === 'voice') range = illustrated ? [25 * 60, 110 * 60] : [50 * 60, 150 * 60];
  if (p.stage === 'visuals') {
    range = illustrated ? [20 * 60, 100 * 60] : [45 * 60, 135 * 60];
    if (p.phase === 'checking') range = illustrated ? [15 * 60, 90 * 60] : [40 * 60, 120 * 60];
    if (p.phase === 'reviewing') range = illustrated ? [15 * 60, 85 * 60] : [35 * 60, 115 * 60];
    if (p.phase === 'rendering') {
      range = illustrated ? [15 * 60, 75 * 60] : [30 * 60, 90 * 60];
      const frameRatio = p.frames ? ratio(p.frames.completed, p.frames.total) : 0;
      const elapsed = seconds(p.stageStartedAt, at);
      if (frameRatio > 0 && elapsed >= 10) {
        const remaining = elapsed * (1 - frameRatio) / frameRatio;
        range = [Math.max(60, Math.floor(remaining * .75 + 60)), Math.max(180, Math.ceil(remaining * 1.5 + 180))];
      }
    }
    if (p.phase === 'validating') range = [60, 5 * 60];
    if (p.phase === 'downloading') range = [30, 3 * 60];
  }
  if (p.stage === 'checking') range = [30, 3 * 60];
  p.estimatedRemainingSeconds = { min: range[0], max: range[1] };
  return lesson;
}

export function stampGenerationProgress(lesson: GeneratedLesson, previous?: GeneratedLessonProgress, at = Date.now()) {
  const p = lesson.progress;
  if (!p.stageStartedAt) p.stageStartedAt = previous?.stage === p.stage && previous?.phase === p.phase
    ? previous.stageStartedAt || new Date(at).toISOString() : new Date(at).toISOString();
  if (lesson.status === 'failed' && p.percent === undefined && previous?.percent !== undefined) p.percent = Math.min(99, previous.percent);
  return refreshGenerationProgress(lesson, at);
}
