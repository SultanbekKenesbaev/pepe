import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GeneratedLesson } from '../shared/types.js';
import LessonGenerationProgress, { LessonGenerationFailure, lessonProgressPercent, lessonProgressStage, lessonWaitLabel } from '../client/src/pages/teacher/LessonGenerationProgress.js';
import { refreshGenerationProgress, stampGenerationProgress } from '../server/generation-progress.js';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { migrateUniversity } from '../server/university-migration.js';
import { migratePlatform } from '../server/platform.js';
import { installGeneratedLessons } from '../server/generated-lessons.js';
import type { CodexLessonService } from '../server/codex-lessons.js';
import type { User } from '../shared/types.js';
import { pcmWave } from '../server/cinema.js';
import { ApiError } from '../server/security.js';
import { brokerProgress } from '../server/codex-provider.js';

const fixture = (patch: Partial<GeneratedLesson> = {}): GeneratedLesson => ({
  id: 'test-lesson', institutionId: 'own', teacherId: 'teacher', subjectId: 'math',
  title: 'Бесконечность', summary: '', status: 'generating', revision: 1,
  chapters: [], duration: 600, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
  progress: { stage: 'visuals', completed: 0, total: 1 }, ...patch,
});

test('visible lesson progress reserves 100% for a ready artifact and leaves old jobs indeterminate', () => {
  for (const status of ['drafting', 'generating', 'language_review', 'failed'] as const) {
    for (const [percent, expected] of [[-30, 0], [0, 0], [45.9, 45], [100, 99], [999, 99]]) {
      assert.equal(lessonProgressPercent(fixture({ status, progress: { stage: 'visuals', completed: 1, total: 1, percent } })), expected);
    }
  }
  for (const percent of [undefined, NaN, Infinity, -Infinity]) {
    assert.equal(lessonProgressPercent(fixture({ progress: { stage: 'visuals', completed: 1, total: 1, percent } })), null);
  }
  assert.equal(lessonProgressPercent(null), null);
  assert.equal(lessonProgressPercent(fixture({ status: 'ready' })), 100);
  const oldJob = renderToStaticMarkup(createElement(LessonGenerationProgress, { lesson: fixture() }));
  assert.match(oldJob, /aria-valuemax="100"/);
  assert.ok(!oldJob.includes('aria-valuenow='), 'Old jobs without telemetry must not imply a measured percentage');
  assert.match(oldJob, /Время уточняется/);
});

test('wait estimates reject invalid ranges and distinguish real phases from overall lesson stages', () => {
  for (const range of [{ min: -1, max: 30 }, { min: 60, max: 10 }, { min: NaN, max: 30 }, { min: 30, max: Infinity }]) {
    assert.equal(lessonWaitLabel(fixture({ progress: { stage: 'visuals', completed: 0, total: 1, estimatedRemainingSeconds: range } })), 'Время уточняется');
  }
  const phase = fixture({ progress: { stage: 'visuals', phase: 'rendering', completed: 1, total: 6, percent: 71, frames: { completed: 2400, total: 14400 }, estimatedRemainingSeconds: { min: 1800, max: 2700 } } });
  assert.equal(lessonProgressStage(phase), 'Сборка урока');
  assert.equal(lessonWaitLabel(phase), 'Осталось ≈ 30–45 мин');
  assert.equal(lessonProgressStage(fixture({ progress: { stage: 'voice', completed: 3, total: 12 } })), 'Озвучка');
  assert.equal(lessonProgressStage(fixture({ progress: { stage: 'script', phase: 'authoring', completed: 0, total: 1 } })), 'Сценарий');
  assert.equal(lessonProgressStage(fixture({ progress: { stage: 'script', phase: 'authoring', completed: 1, total: 3 } })), 'Уточнение длительности');
  assert.equal(lessonProgressStage(fixture({ progress: { stage: 'voice', phase: 'authoring', completed: 3, total: 12 } })), 'Озвучка');
  assert.equal(lessonProgressStage(fixture({ progress: { stage: 'visuals', phase: 'queued', completed: 0, total: 6 } })), 'В очереди');
  const markup = renderToStaticMarkup(createElement(LessonGenerationProgress, { lesson: phase }));
  assert.match(markup, /aria-valuenow="71"/);
  assert.match(markup, /Примерно 71%/);
  assert.match(markup, /14.400 кадров/);
  assert.match(markup, /30–45 мин/);
});

test('failure dialog keeps the saved reason, safe code and phase readable, including legacy fallback', () => {
  const failed = fixture({ status: 'failed', error: 'Сборка урока прервана.', errorCode: 'GENERATION_INTERRUPTED', errorStage: 'rendering' });
  const markup = renderToStaticMarkup(createElement(LessonGenerationFailure, { lesson: failed }));
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Сборка урока прервана/);
  assert.match(markup, /GENERATION_INTERRUPTED/);
  assert.match(markup, /Сборка урока/);
  assert.match(renderToStaticMarkup(createElement(LessonGenerationFailure, { lesson: fixture({ status: 'failed' }) })), /Причина ошибки не сохранена/);
  const escaped = renderToStaticMarkup(createElement(LessonGenerationFailure, { lesson: fixture({ status: 'failed', error: '<script>alert("bad")</script>' }) }));
  assert.ok(!escaped.includes('<script>'));
  assert.match(escaped, /&lt;script&gt;/);
});

test('elapsed time cannot manufacture completed work and renderer checkpoints stay below ready', () => {
  const at = Date.parse('2026-10-23T03:00:00.000Z');
  const author = fixture({ generationStartedAt: '2026-10-23T00:00:00.000Z', progress: { stage: 'visuals', phase: 'authoring', completed: 0, total: 6 } });
  refreshGenerationProgress(author, at);
  assert.equal(author.progress.percent, 25);
  assert.equal(author.progress.elapsedSeconds, 10800);
  refreshGenerationProgress(author, at + 7200_000);
  assert.equal(author.progress.percent, 25, 'LLM progress must stay at the last real milestone');
  const rendering = fixture({ progress: { stage: 'visuals', phase: 'rendering', completed: 4, total: 6, frames: { completed: 7200, total: 14400 }, stageStartedAt: new Date(at - 2400_000).toISOString() } });
  refreshGenerationProgress(rendering, at);
  assert.equal(rendering.progress.percent, 78);
  assert.ok(rendering.progress.estimatedRemainingSeconds!.min >= 60);
  assert.ok(rendering.progress.estimatedRemainingSeconds!.max >= rendering.progress.estimatedRemainingSeconds!.min);
  rendering.progress.frames!.completed = 999999;
  refreshGenerationProgress(rendering, at);
  assert.equal(rendering.progress.percent, 96);
  assert.ok(rendering.progress.percent! < 100);
  rendering.status = 'ready';
  refreshGenerationProgress(rendering, at);
  assert.equal(rendering.progress.percent, 100);
  assert.equal(rendering.progress.estimatedRemainingSeconds, undefined);
});

test('failed and review states cannot retain a running countdown, and a new phase resets its clock', () => {
  const at = Date.parse('2026-10-23T01:00:00.000Z');
  for (const status of ['failed', 'language_review', 'draft'] as const) {
    const lesson = fixture({ status, progress: { stage: status === 'failed' ? 'failed' : status === 'language_review' ? 'language_review' : 'review', completed: 1, total: 1, percent: 78, estimatedRemainingSeconds: { min: 10, max: 60 } } });
    refreshGenerationProgress(lesson, at);
    assert.equal(lesson.progress.estimatedRemainingSeconds, undefined, status);
  }
  const previous = { stage: 'visuals' as const, phase: 'checking' as const, completed: 1, total: 6, stageStartedAt: '2026-10-23T00:00:00.000Z' };
  const lesson = fixture({ progress: { stage: 'visuals', phase: 'rendering', completed: 4, total: 6 } });
  stampGenerationProgress(lesson, previous, at);
  assert.equal(lesson.progress.stageStartedAt, '2026-10-23T01:00:00.000Z');
  const samePhase = fixture({ progress: { stage: 'visuals', phase: 'checking', completed: 1, total: 6 } });
  stampGenerationProgress(samePhase, previous, at);
  assert.equal(samePhase.progress.stageStartedAt, previous.stageStartedAt);
});

test('broker telemetry accepts only bounded counters and approved phases, never generated free text', () => {
  for (const value of [null, '50%', { stage: 'secret-provider-path', completed: 1, total: 6 }, { stage: 'rendering', completed: -1, total: 6 }, { stage: 'rendering', completed: 7, total: 6 }, { stage: 'rendering', completed: 0, total: 72001 }, { stage: 'rendering', completed: '4', total: 6 }, { stage: 'rendering', completed: NaN, total: 6 }]) {
    assert.equal(brokerProgress(value), undefined);
  }
  assert.deepEqual(brokerProgress({ stage: 'rendering', completed: 4, total: 6, frames: { completed: 240, total: 14400 }, privatePath: '/private/secret', secret: 'test-key', message: 'untrusted generated content' }), { phase: 'rendering', completed: 4, total: 6, frames: { completed: 240, total: 14400 } });
  assert.deepEqual(brokerProgress({ stage: 'authoring', completed: 0, total: 1, frames: { completed: 240, total: 14400 } }), { phase: 'authoring', completed: 0, total: 1 });
  assert.deepEqual(brokerProgress({ stage: 'rendering', completed: 4, total: 6, frames: { completed: 14401, total: 14400 } }), { phase: 'rendering', completed: 4, total: 6 });
});

test('persisted render failure retains its exact safe stage, and explicit retry clears stale diagnostics without changing access', { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lesson-progress-contract-'));
  const db = await openDatabase(path.join(temporary, 'postgres'));
  const owner: User = { id: 'progress-owner', name: 'Owner', email: 'owner@example.test', role: 'TEACHER', institutionId: 'own', active: true };
  const other: User = { ...owner, id: 'progress-other', email: 'other@example.test' };
  const foreign: User = { ...owner, id: 'progress-foreign', institutionId: 'foreign', email: 'foreign@example.test' };
  for (const institutionId of ['own', 'foreign']) await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)', [institutionId, { id: institutionId, name: institutionId, type: 'UNIVERSITY', settings: { allowExternalAI: true } }]);
  for (const user of [owner, other, foreign]) await db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)', [user.id, user.institutionId, user.email, 'unused-fixture-hash', user]);
  await migrateUniversity(db, false); await migratePlatform(db);
  const ctx: any = { dataDir: temporary, audit: async () => {} };
  let calls = 0, fail = true, release: (() => void) | undefined;
  const wait = async (service: CodexLessonService, id: string, condition: (lesson: GeneratedLesson) => boolean) => {
    for (let count = 0; count < 400; count++) {
      const lesson = await service.get(owner, id); if (condition(lesson)) return lesson;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Isolated fixture did not reach its expected state');
  };
  installGeneratedLessons(express(), db, ctx, {
    voiceModel: 'gemini-3.8-flash-tts', voice: 'Puck',
    codexScriptProvider: async request => ({ title: request.title, summary: 'Synthetic contract fixture.', direction: 'Пространственное объяснение.', chapters: Array.from({ length: 3 }, (_, chapter) => ({ id: `chapter-${chapter}`, title: 'Глава', scene: 'custom' as const, headline: 'Идея', labels: [], values: [], palette: 'dark' as const, visualDirection: 'Модель в пространстве.', cues: Array.from({ length: 4 }, (_, cue) => ({ id: `cue-${chapter}-${cue}`, text: `Учебная реплика ${chapter}, пример ${cue}.`, visualAction: 'Изменить модель вместе с объяснением.' })) })) }),
    voiceProvider: async () => { calls++; return pcmWave(Buffer.alloc(48000 * 48)); },
    codexVisualProvider: async ({ lesson, dataDir, signal, onProgress }) => {
      await onProgress?.({ phase: 'rendering', completed: 4, total: 6, frames: { completed: 4800, total: 14400 } });
      if (fail) throw Object.assign(new Error('CODEX_RENDER_TIMEOUT'), { generationStage: 'rendering' });
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        release = () => { signal.removeEventListener('abort', aborted); resolve(); };
      });
      const bytes = Buffer.alloc(2048); bytes.write('ftyp', 4);
      const file = path.join(dataDir, 'generated', lesson.id, 'film.mp4'); await writeFile(file, bytes);
      return { file, duration: 600, width: 1280, height: 720, fps: 24, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  });
  const service = ctx.codexLessons as CodexLessonService;
  try {
    const created = await service.create(owner, { title: 'Бесконечность и предел', language: 'ru' });
    const failed = await wait(service, created.lesson.id, lesson => lesson.status === 'failed');
    assert.equal(failed.errorCode, 'CODEX_RENDER_TIMEOUT');
    assert.equal(failed.errorStage, 'rendering');
    assert.match(failed.error!, /время|ожидани/);
    assert.equal(failed.progress.estimatedRemainingSeconds, undefined);
    assert.ok(failed.progress.percent! < 100);
    for (const principal of [other, foreign]) {
      await assert.rejects(service.get(principal, failed.id), (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN');
      await assert.rejects(service.retry(principal, failed.id, failed.revision), (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN');
    }
    fail = false;
    const retry = await service.retry(owner, failed.id, failed.revision);
    assert.equal(retry.error, undefined); assert.equal(retry.errorCode, undefined); assert.equal(retry.errorStage, undefined);
    const rendering = await wait(service, failed.id, lesson => lesson.progress.phase === 'rendering' && lesson.status === 'generating');
    assert.equal(rendering.progress.percent, 72);
    assert.deepEqual(rendering.progress.frames, { completed: 4800, total: 14400 });
    assert.equal(calls, 12, 'Retry must reuse the saved narration');
    release!();
    const ready = await wait(service, failed.id, lesson => lesson.status === 'ready');
    assert.equal(ready.progress.percent, 100);
    assert.equal(ready.errorCode, undefined);
    assert.equal(ready.progress.estimatedRemainingSeconds, undefined);
  } finally { release?.(); await ctx.finishGeneratedJobs(); await db.close(); await rm(temporary, { recursive: true, force: true }); }
});

test('startup recovery preserves the last actual checkpoint and marks interruption without a stale countdown', { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lesson-progress-recovery-'));
  const db = await openDatabase(path.join(temporary, 'postgres'));
  try {
    await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)', ['own', { id: 'own', name: 'Own', type: 'UNIVERSITY', settings: {} }]);
    await db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)', ['teacher', 'own', 'teacher@example.test', 'unused-fixture-hash', { id: 'teacher', role: 'TEACHER', institutionId: 'own', active: true }]);
    await migrateUniversity(db, false);
    await migratePlatform(db);
    const active = fixture({ id: 'recover-active', revision: 8, progress: { stage: 'visuals', phase: 'rendering', completed: 4, total: 6, percent: 78, frames: { completed: 7200, total: 14400 }, estimatedRemainingSeconds: { min: 1800, max: 2700 } } });
    const ready = fixture({ id: 'keep-ready', status: 'ready', revision: 6, progress: { stage: 'ready', completed: 1, total: 1, percent: 100 } });
    for (const lesson of [active, ready]) await db.query('INSERT INTO generated_lessons(id,institution_id,teacher_id,revision,data) VALUES($1,$2,$3,$4,$5)', [lesson.id, lesson.institutionId, lesson.teacherId, lesson.revision, lesson]);
    await migratePlatform(db);
    const stored = (await db.query('SELECT data FROM generated_lessons WHERE id=$1', [active.id])).rows[0].data as GeneratedLesson;
    assert.equal(stored.status, 'failed');
    assert.equal(stored.revision, 9);
    assert.equal(stored.errorCode, 'GENERATION_INTERRUPTED');
    assert.equal(stored.errorStage, 'rendering');
    assert.equal(stored.progress.stage, 'failed');
    assert.equal(stored.progress.percent, 78);
    assert.deepEqual(stored.progress.frames, active.progress.frames);
    assert.equal(stored.progress.estimatedRemainingSeconds, undefined);
    assert.notEqual(stored.updatedAt, active.updatedAt);
    assert.deepEqual((await db.query('SELECT data FROM generated_lessons WHERE id=$1', [ready.id])).rows[0].data, ready);
  } finally { await db.close(); await rm(temporary, { recursive: true, force: true }); }
});
