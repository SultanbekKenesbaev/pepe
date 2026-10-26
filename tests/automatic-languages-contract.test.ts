import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { migrateUniversity } from '../server/university-migration.js';
import { migratePlatform } from '../server/platform.js';
import { installGeneratedLessons } from '../server/generated-lessons.js';
import type { CodexLessonService, CodexScriptRequest } from '../server/codex-lessons.js';
import type { GeneratedLesson, User } from '../shared/types.js';
import { pcmWave } from '../server/cinema.js';
import { ApiError } from '../server/security.js';
import { createApp } from '../server/app.js';

// Explicit trusted fixtures only: no model, external TTS, renderer or production access.
test('Russian, Karakalpak and Uzbek lessons finish automatically without inventing a human approval', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'automatic-languages-contract-'));
  const db = await openDatabase(path.join(temporary, 'postgres'));
  const owner: User = { id: 'language-owner', name: 'Owner', email: 'owner@example.test', role: 'TEACHER', institutionId: 'own', active: true };
  const other: User = { ...owner, id: 'language-other', email: 'other@example.test' };
  const foreign: User = { ...owner, id: 'language-foreign', institutionId: 'foreign', email: 'foreign@example.test' };
  for (const institutionId of ['own', 'foreign']) await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)', [institutionId, { id: institutionId, name: institutionId, type: 'UNIVERSITY', settings: { allowExternalAI: true } }]);
  for (const user of [owner, other, foreign]) await db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)', [user.id, user.institutionId, user.email, 'unused-fixture-hash', user]);
  await migrateUniversity(db, false); await migratePlatform(db);
  const requests: CodexScriptRequest[] = [], visuals: string[] = [], audits: string[] = [];
  let voiceCalls = 0;
  const wave = pcmWave(Buffer.alloc(48000 * 48));
  const ctx: any = { dataDir: temporary, audit: async (_user: User, action: string) => { audits.push(action); } };
  installGeneratedLessons(express(), db, ctx, {
    voiceModel: 'gemini-3.8-flash-tts', voice: 'Puck',
    codexScriptProvider: async request => {
      requests.push(request);
      return { title: request.title, summary: 'Synthetic automatic-language fixture.', direction: 'Пространственное объяснение.', chapters: Array.from({ length: 3 }, (_, chapter) => ({ id: `chapter-${chapter}`, title: 'Глава', scene: 'custom' as const, headline: 'Идея', labels: [], values: [], palette: 'dark' as const, visualDirection: 'Модель в пространстве.', cues: Array.from({ length: 4 }, (_, cue) => ({ id: `cue-${chapter}-${cue}`, text: `${request.language}: учебная реплика ${chapter}, пример ${cue}.`, visualAction: 'Изменить модель вместе с объяснением.' })) })) };
    },
    voiceProvider: async () => { voiceCalls++; return wave; },
    codexVisualProvider: async ({ lesson, dataDir, onProgress }) => {
      visuals.push(lesson.id);
      assert.equal(lesson.duration, 600);
      assert.equal(lesson.voiceProfile?.language, lesson.language);
      assert.equal(lesson.languageReview?.approvedAt, undefined, 'Automatic generation must not fabricate a person approving speech');
      assert.equal(lesson.languageReview?.approvedBy, undefined);
      await onProgress?.({ phase: 'rendering', completed: 4, total: 6, frames: { completed: 2400, total: 14400 } });
      const bytes = Buffer.alloc(2048); bytes.write('ftyp', 4);
      const file = path.join(dataDir, 'generated', lesson.id, 'film.mp4'); await writeFile(file, bytes);
      return { file, duration: 600, width: 1280, height: 720, fps: 24, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  });
  const service = ctx.codexLessons as CodexLessonService;
  const waitReady = async (id: string) => {
    for (let count = 0; count < 500; count++) {
      const lesson = await service.get(owner, id);
      if (lesson.status === 'ready') return lesson;
      assert.notEqual(lesson.status, 'language_review', 'No teacher approval should interrupt the pipeline');
      assert.notEqual(lesson.status, 'failed', lesson.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Isolated automatic language fixture timed out');
  };
  const completed = new Map<string, GeneratedLesson>();
  try {
    for (const language of ['ru', 'kaa', 'uz'] as const) {
      await t.test(`${language} goes directly from topic to a ready 600-second artifact`, async () => {
        const input = { title: `Logic ${language}`, language, idempotencyKey: `auto-language-${language}-001` };
        const created = await service.create(owner, input);
        assert.equal(created.created, true);
        const lesson = await waitReady(created.lesson.id); completed.set(language, lesson);
        assert.equal(requests.at(-1)?.language, language);
        assert.equal(lesson.language, language); assert.equal(lesson.duration, 600);
        assert.equal(lesson.status, 'ready'); assert.equal(lesson.progress.percent, 100);
        assert.equal(lesson.languageReview?.approvedAt, undefined); assert.equal(lesson.languageReview?.approvedBy, undefined);
        assert.equal(lesson.languageReview?.required, undefined);
        const stored = (await db.query('SELECT data FROM entities WHERE id=$1', [lesson.lessonId])).rows[0].data;
        assert.equal(stored.language, language);
        const video = await service.getVideo(owner, lesson.id); assert.equal((await readFile(video.file)).length, 2048);
        const before = [requests.length, voiceCalls, visuals.length];
        const replay = await service.create(owner, input); assert.equal(replay.created, false); assert.equal(replay.lesson.id, lesson.id);
        await service.get(owner, lesson.id); await service.getVideo(owner, lesson.id);
        assert.deepEqual([requests.length, voiceCalls, visuals.length], before, 'History reads and idempotent replays must not regenerate');
      });
    }
    await t.test('new language support does not weaken owner scope or revive already-ready lessons', async () => {
      const lesson = completed.get('uz')!;
      for (const principal of [other, foreign]) {
        await assert.rejects(service.get(principal, lesson.id), (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN');
        await assert.rejects(service.retry(principal, lesson.id, lesson.revision), (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN');
      }
      await assert.rejects(service.approveLanguage(owner, lesson.id, lesson.revision), (error: unknown) => error instanceof ApiError && error.code === 'LANGUAGE_REVIEW_REQUIRED');
      assert.equal(visuals.length, 3); assert.equal(voiceCalls, 36); assert.ok(!audits.includes('generated-lesson.language-approve'));
    });
    await t.test('startup continuation claims legacy waiting work once, reuses saved audio and skips unsafe owners and institutions', async () => {
      const resume = () => service.resumeWaitingLanguageLessons();
      const kaa = completed.get('kaa')!;
      const waiting: GeneratedLesson = { ...kaa, status: 'language_review', languageReview: { required: true }, progress: { stage: 'language_review', completed: 0, total: 1 } };
      await db.query('UPDATE generated_lessons SET data=$1 WHERE id=$2', [waiting, waiting.id]);
      const inactive: User = { ...owner, id: 'inactive-owner', email: 'inactive@example.test', active: false };
      const disabledOwner: User = { ...owner, id: 'disabled-owner', email: 'disabled@example.test', institutionId: 'disabled' };
      await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)', ['disabled', { id: 'disabled', name: 'Disabled', type: 'UNIVERSITY', settings: { allowExternalAI: false } }]);
      for (const user of [inactive, disabledOwner]) await db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)', [user.id, user.institutionId, user.email, 'unused-fixture-hash', user]);
      const skipped: GeneratedLesson[] = [
        { ...waiting, id: 'inactive-waiting', teacherId: inactive.id },
        { ...waiting, id: 'mismatched-tenant-waiting', institutionId: 'foreign' },
        { ...waiting, id: 'disabled-institution-waiting', institutionId: 'disabled', teacherId: disabledOwner.id },
        { ...waiting, id: 'legacy-engine-waiting', engine: 'legacy' },
        { ...waiting, id: 'failed-stays-failed', status: 'failed' },
      ];
      for (const lesson of skipped) await db.query('INSERT INTO generated_lessons(id,institution_id,teacher_id,revision,data) VALUES($1,$2,$3,$4,$5)', [lesson.id, lesson.institutionId, lesson.teacherId, lesson.revision, lesson]);
      const before = [requests.length, voiceCalls, visuals.length];
      const resumed = await Promise.all([resume(), resume()]);
      assert.equal(resumed.reduce((sum, value) => sum + value.started, 0), 1, 'Concurrent startup checks must claim the same waiting row once');
      const ready = await waitReady(kaa.id);
      assert.equal(ready.languageReview?.approvedAt, undefined); assert.equal(ready.languageReview?.approvedBy, undefined);
      assert.equal(ready.languageReview?.required, undefined);
      assert.deepEqual([requests.length, voiceCalls, visuals.length], [before[0], before[1], before[2] + 1], 'Legacy continuation must reuse the measured narration');
      assert.equal((await resume()).started, 0, 'Ready jobs must remain ready across repeated startup checks');
      for (const expected of skipped) {
        const actual = (await db.query('SELECT data FROM generated_lessons WHERE id=$1', [expected.id])).rows[0].data as GeneratedLesson;
        assert.equal(actual.status, expected.status, expected.id);
        assert.equal(actual.revision, expected.revision, expected.id);
        assert.equal(actual.languageReview?.approvedBy, undefined, expected.id);
      }
    });
  } finally { await ctx.finishGeneratedJobs(); await db.close(); await rm(temporary, { recursive: true, force: true }); }
});

test('application restart automatically continues an old waiting lesson exactly once without requesting teacher confirmation', { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'automatic-language-restart-'));
  let scripts = 0, voices = 0, renders = 0;
  const generation = {
    voiceModel: 'gemini-3.8-flash-tts', voice: 'Puck',
    codexScriptProvider: async (request: CodexScriptRequest) => {
      scripts++;
      return { title: request.title, summary: 'Restart contract.', direction: 'Пространственная учебная модель.', chapters: Array.from({ length: 3 }, (_, chapter) => ({ id: `chapter-${chapter}`, title: 'Глава', scene: 'custom' as const, headline: 'Идея', labels: [], values: [], palette: 'dark' as const, visualDirection: 'Модель в пространстве.', cues: Array.from({ length: 4 }, (_, cue) => ({ id: `cue-${chapter}-${cue}`, text: `Qaraqalpaq sabaq ${chapter}, mısal ${cue}.`, visualAction: 'Модель объясняет взаимосвязь.' })) })) };
    },
    voiceProvider: async () => { voices++; return pcmWave(Buffer.alloc(48000 * 48)); },
    codexVisualProvider: async ({ lesson, dataDir }: { lesson: GeneratedLesson; dataDir: string }) => {
      renders++;
      const bytes = Buffer.alloc(2048); bytes.write('ftyp', 4);
      const file = path.join(dataDir, 'generated', lesson.id, 'film.mp4'); await writeFile(file, bytes);
      return { file, duration: 600, width: 1280, height: 720, fps: 24, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  };
  let app = await createApp({ dataDir: temporary, seedDemo: true, generation });
  let server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  let base = `http://127.0.0.1:${(server.address() as any).port}`, cookie = '', csrf = '';
  const request = async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, data: await response.json() as any };
  };
  const login = async () => {
    const result = await request('/api/auth/login', 'POST', { email: 'demo@aiteacher.local', password: 'PepeOnly-teacher-2026!' }); assert.equal(result.response.status, 200);
    cookie = result.response.headers.get('set-cookie')!.split(';')[0]; csrf = result.data.csrfToken;
  };
  const wait = async (id: string) => {
    for (let count = 0; count < 500; count++) {
      const result = await request(`/api/generated-lessons/${id}`); assert.equal(result.response.status, 200);
      if (result.data.status === 'ready') return result.data as GeneratedLesson;
      assert.notEqual(result.data.status, 'failed', result.data.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Application restart fixture timed out');
  };
  try {
    await app.locals.db.query("UPDATE institutions SET data=jsonb_set(data,'{settings,allowExternalAI}','true'::jsonb) WHERE id='demo-school'");
    await login();
    const created = await request('/api/generated-lessons', 'POST', { title: 'Logika: pikirden juwmaqqa', language: 'kaa' }); assert.equal(created.response.status, 202);
    let lesson = await wait(created.data.id);
    assert.deepEqual([scripts, voices, renders], [1, 12, 1]);
    // Emulate the previous deployed version's persisted pause, with its valid narration still on disk.
    lesson = { ...lesson, status: 'language_review', languageReview: { required: true }, progress: { stage: 'language_review', completed: 0, total: 1 } };
    await app.locals.db.query('UPDATE generated_lessons SET data=$1 WHERE id=$2', [lesson, lesson.id]);
    await new Promise<void>(resolve => server.close(() => resolve())); await app.locals.close();
    app = await createApp({ dataDir: temporary, seedDemo: false, generation });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`; cookie = ''; csrf = '';
    await login(); const resumed = await wait(lesson.id);
    assert.deepEqual([scripts, voices, renders], [1, 12, 2], 'Startup must continue directly using the saved narration');
    assert.equal(resumed.languageReview, undefined);
    assert.equal(resumed.language, 'kaa'); assert.equal(resumed.artifact?.duration, 600);
    await new Promise<void>(resolve => server.close(() => resolve())); await app.locals.close();
    app = await createApp({ dataDir: temporary, seedDemo: false, generation });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`; cookie = ''; csrf = '';
    await login(); const durable = await wait(lesson.id);
    assert.deepEqual([scripts, voices, renders], [1, 12, 2], 'A second restart must not run the ready lesson again');
    assert.equal(durable.artifact?.sha256, resumed.artifact?.sha256);
    assert.equal((await app.locals.db.query("SELECT id FROM audit WHERE data->>'action'='generated-lesson.language-approve'")).rows.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await app.locals.close(); await rm(temporary, { recursive: true, force: true }); }
});
