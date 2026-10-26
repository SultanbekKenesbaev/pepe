import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { brokerProgress, createCodexProviders } from '../server/codex-provider.js';
import { refreshGenerationProgress } from '../server/generation-progress.js';
import { installGeneratedLessons } from '../server/generated-lessons.js';
import { openDatabase } from '../server/db.js';
import { migrateUniversity } from '../server/university-migration.js';
import { migratePlatform } from '../server/platform.js';
import { pcmWave } from '../server/cinema.js';
import { ApiError } from '../server/security.js';
import type { CodexLessonService, CodexScriptRequest } from '../server/codex-lessons.js';
import type { GeneratedLesson, User } from '../shared/types.js';

test('2D progress includes media preparation and mode-specific estimates without changing historical 3D estimates', () => {
  const lesson = (videoMode?: '2d' | '3d'): GeneratedLesson => ({ id: 'progress', institutionId: 'university', teacherId: 'teacher', subjectId: 'subject', title: 'Topic', summary: '', status: 'drafting', revision: 0, chapters: [], duration: 0, progress: { stage: 'planning', completed: 0, total: 1 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(videoMode ? { videoMode } : {}) });
  const two = refreshGenerationProgress(lesson('2d')), old = refreshGenerationProgress(lesson());
  assert.deepEqual(two.progress.estimatedRemainingSeconds, { min: 1800, max: 7200 });
  assert.deepEqual(old.progress.estimatedRemainingSeconds, { min: 3600, max: 10800 });
  for (const phase of ['alignment', 'images'] as const) {
    const progress = brokerProgress({ stage: phase, completed: 1, total: 4, secret: 'must-not-forward' });
    assert.deepEqual(progress, { phase, completed: 1, total: 4 });
    const current = lesson('2d'); current.status = 'generating'; current.progress = { stage: 'visuals', ...progress! };
    refreshGenerationProgress(current); assert.ok(Number.isFinite(current.progress.percent)); assert.ok(current.progress.percent! < 100);
  }
});

test('2D and 3D use independent broker URLs, credentials, job bytes and artifact routes', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'video-mode-brokers-'));
  const keys = ['CODEX_WORKER_URL','CODEX_WORKER_TOKEN_FILE','CODEX_2D_WORKER_URL','CODEX_2D_WORKER_TOKEN_FILE'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests: { mode: string; url: string; payload?: any }[] = [];
  let release3d!: () => void, signal3d!: () => void;
  const gate = new Promise<void>(resolve => release3d = resolve), started = new Promise<void>(resolve => signal3d = resolve);
  const servers = await Promise.all((['2d','3d'] as const).map(async mode => {
    const token = mode + '-isolated-token-' + 'x'.repeat(40), file = path.join(root, mode + '.token');
    await writeFile(file, token, { mode: 0o600 });
    const movie = Buffer.alloc(2048, mode === '2d' ? 2 : 3); movie.write('ftyp', 4);
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), payload = req.headers['content-type'] === 'application/json' ? JSON.parse(bytes.toString()) : undefined;
      requests.push({ mode, url: req.url!, payload }); res.setHeader('Content-Type', 'application/json');
      if (req.url!.endsWith('/script')) {
        if (mode === '3d' && payload.title === 'Blocked 3D') { signal3d(); await gate; }
        res.end(JSON.stringify({ status: 'ready', result: { title: payload.title, chapters: [] } })); return;
      }
      if (req.url!.endsWith('.wav')) { assert.equal(req.headers['x-content-sha256'], createHash('sha256').update(bytes).digest('hex')); res.end('{}'); return; }
      if (req.url!.endsWith('/visuals')) { res.end(JSON.stringify({ status: 'ready', result: { duration: 600, width: 1920, height: 1080, fps: 30, sha256: createHash('sha256').update(movie).digest('hex') } })); return; }
      if (req.url!.endsWith('/artifact')) { res.setHeader('Content-Type', 'video/mp4'); res.end(movie); return; }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const prefix = mode === '2d' ? 'CODEX_2D_WORKER' : 'CODEX_WORKER';
    process.env[prefix + '_URL'] = `http://127.0.0.1:${(server.address() as any).port}`;
    process.env[prefix + '_TOKEN_FILE'] = file;
    return server;
  }));
  try {
    const provider = createCodexProviders(root);
    assert.deepEqual(provider.codexVideoModes, ['2d','3d']);
    const context = { lessonId: 'lesson', title: 'Blocked 3D', language: 'ru' as const, source: '', targetDuration: 600 as const, voiceModel: 'gemini-3.8-flash-tts' };
    const pending = provider.codexScriptProvider!({ ...context, videoMode: '3d' }); await started;
    const two = await provider.codexScriptProvider!({ ...context, title: 'Independent 2D', videoMode: '2d' });
    assert.equal(two.title, 'Independent 2D'); release3d(); await pending;
    await provider.codexScriptProvider!({ ...context, title: 'Same topic', videoMode: '2d' });
    await provider.codexScriptProvider!({ ...context, title: 'Same topic', videoMode: '3d' });
    const same = requests.filter(request => request.payload?.title === 'Same topic');
    assert.notEqual(same[0].url, same[1].url); assert.equal(same[0].payload.videoMode, '2d'); assert.equal(same[1].payload.videoMode, '3d');
    const lesson: any = { id: 'artifact-lesson', title: 'Topic', language: 'ru', duration: 600, chapters: [{ id: 'chapter', start: 0, duration: 600 }] };
    await mkdir(path.join(root, 'generated', lesson.id), { recursive: true });
    await writeFile(path.join(root, 'generated', lesson.id, 'chapter.wav'), pcmWave(Buffer.alloc(48000)));
    for (const mode of ['2d','3d'] as const) {
      const artifact = await provider.codexVisualProvider!({ lesson: { ...lesson, videoMode: mode }, dataDir: root });
      assert.equal((await readFile(artifact.file))[0], mode === '2d' ? 2 : 3);
      assert.ok(requests.some(request => request.mode === mode && request.url.endsWith('/artifact')));
    }
    const before = requests.length; delete process.env.CODEX_2D_WORKER_URL;
    const only3d = createCodexProviders(root);
    await assert.rejects(only3d.codexScriptProvider!({ ...context, videoMode: '2d' }), /CODEX_2D_WORKER_NOT_CONFIGURED/);
    assert.equal(requests.length, before);
    await only3d.codexScriptProvider!({ ...context, title: 'Historical request' });
    assert.equal(requests.at(-1)!.mode, '3d'); assert.ok(!('videoMode' in requests.at(-1)!.payload));
  } finally {
    release3d();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});

test('new lessons default to 2D, 3D does not block 2D, and history/retries keep their original mode', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'video-mode-service-'));
  const db = await openDatabase(path.join(root, 'postgres'));
  const user: User = { id: 'owner', name: 'Teacher', email: 'teacher@example.test', role: 'TEACHER', institutionId: 'university', active: true };
  await db.query('INSERT INTO institutions(id,data) VALUES($1,$2)', ['university', { id: 'university', type: 'UNIVERSITY', settings: { allowExternalAI: true } }]);
  await db.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)', [user.id, user.institutionId, user.email, 'unused', user]);
  await migrateUniversity(db, false); await migratePlatform(db);
  let release3d!: () => void, signal3d!: () => void;
  const gate = new Promise<void>(resolve => release3d = resolve), started = new Promise<void>(resolve => signal3d = resolve);
  const scriptRequests: CodexScriptRequest[] = [], visualModes: string[] = []; let failVisual: string | undefined, voiceCalls = 0;
  const ctx: any = { dataDir: root, audit: async () => {} };
  installGeneratedLessons(express(), db, ctx, {
    codexVideoModes: ['2d','3d'],
    codexScriptProvider: async request => {
      scriptRequests.push(request);
      if (request.videoMode === '3d') { signal3d(); await gate; }
      return { title: request.title, summary: 'Isolated test.', direction: 'Clear educational staging.', chapters: Array.from({ length: 3 }, (_, chapter) => ({ id: `chapter-${chapter}`, title: 'Chapter', scene: 'custom' as const, headline: 'Topic', labels: [], values: [], palette: 'light' as const, visualDirection: 'Show a concrete example.', cues: Array.from({ length: 4 }, (_, cue) => ({ id: `cue-${chapter}-${cue}`, text: 'An explicit narrated educational example.', visualAction: 'Demonstrate the corresponding concept.' })) })) };
    },
    voiceProvider: async () => { voiceCalls++; return pcmWave(Buffer.alloc(48000 * 48)); },
    codexVisualProvider: async ({ lesson, dataDir }) => {
      visualModes.push(lesson.videoMode || '3d');
      if (failVisual) throw Object.assign(new Error(failVisual), { generationStage: failVisual === 'CODEX_ALIGNMENT_FAILED' ? 'alignment' : 'images' });
      const file = path.join(dataDir, 'generated', lesson.id, 'film.mp4'), bytes = Buffer.alloc(2048); bytes.write('ftyp', 4);
      await writeFile(file, bytes); return { file, duration: 600, width: 1920, height: 1080, fps: 30, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  });
  const service = ctx.codexLessons as CodexLessonService;
  const wait = async (id: string, target = 'ready') => { for (let i = 0; i < 300; i++) { const lesson = await service.get(user, id); if (lesson.status === target) return lesson; if (lesson.status === 'failed') assert.fail(lesson.error); await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Readiness timeout'); };
  const rejects = (operation: Promise<unknown>, code: string) => assert.rejects(operation, (error: unknown) => error instanceof ApiError && error.code === code);
  try {
    const three = (await service.create(user, { title: 'Spatial topic', language: 'ru', videoMode: '3d', idempotencyKey: 'spatial-request-001' })).lesson;
    await started;
    const input = { title: 'Array topic', language: 'ru' as const, idempotencyKey: 'illustrated-request-001' };
    const two = (await service.create(user, input)).lesson;
    assert.equal(two.videoMode, '2d'); const ready = await wait(two.id);
    assert.equal(ready.videoMode, '2d'); assert.equal(scriptRequests.find(request => request.lessonId === two.id)!.videoMode, '2d');
    assert.equal((await service.get(user, three.id)).status, 'drafting'); assert.deepEqual(visualModes, ['2d']);
    assert.equal((await service.create(user, input)).created, false);
    await rejects(service.create(user, { ...input, videoMode: '3d' }), 'IDEMPOTENCY_CONFLICT');
    await rejects(service.create(user, { ...input, title: 'Different topic' }), 'IDEMPOTENCY_CONFLICT');
    await rejects(service.create(user, { ...input, videoMode: '4d' } as any), 'VALIDATION_ERROR');
    release3d(); const spatial = await wait(three.id); assert.equal(spatial.videoMode, '3d');
    const legacy = { ...spatial, status: 'failed' as const }; delete legacy.videoMode; delete legacy.requestFingerprint;
    await db.query('UPDATE generated_lessons SET data=$1 WHERE id=$2', [legacy, legacy.id]);
    const before = scriptRequests.length; await service.retry(user, legacy.id, legacy.revision); const restored = await wait(legacy.id);
    assert.equal(restored.videoMode, '3d'); assert.equal(scriptRequests.length, before); assert.equal(visualModes.at(-1), '3d');
    assert.equal((await db.query('SELECT data FROM generated_lessons WHERE id=$1', [legacy.id])).rows[0].data.videoMode, undefined);
    const cached = { voices: voiceCalls, scripts: scriptRequests.length, hash: ready.chapters[0].cues![0].audioHash };
    for (const code of ['CODEX_ALIGNMENT_FAILED', 'CODEX_IMAGE_GENERATION_FAILED']) {
      const previous = await service.get(user, two.id); previous.status = 'failed';
      await db.query('UPDATE generated_lessons SET data=$1 WHERE id=$2', [previous, two.id]); failVisual = code;
      await service.retry(user, two.id, previous.revision); const failed = await wait(two.id, 'failed');
      assert.equal(failed.errorCode, code); assert.match(failed.error!, code === 'CODEX_ALIGNMENT_FAILED' ? /синхронизировать/ : /иллюстрации/);
      assert.match(failed.error!, /озвучка.*сохранен[аы]/); assert.equal(failed.errorStage, code === 'CODEX_ALIGNMENT_FAILED' ? 'alignment' : 'images');
      assert.equal(failed.chapters[0].cues![0].audioHash, cached.hash); assert.equal(voiceCalls, cached.voices); assert.equal(scriptRequests.length, cached.scripts);
      failVisual = undefined; await service.retry(user, two.id, failed.revision); await wait(two.id);
      assert.equal(voiceCalls, cached.voices); assert.equal(scriptRequests.length, cached.scripts);
    }
    const unavailable: any = { dataDir: root, audit: async () => {} };
    installGeneratedLessons(express(), db, unavailable, { voiceProvider: async () => pcmWave(Buffer.alloc(48000)), codexScriptProvider: async () => { throw Error('must not run'); }, codexVisualProvider: async () => { throw Error('must not run'); }, codexVideoModes: ['3d'] });
    await rejects(unavailable.codexLessons.create(user, { title: 'Unavailable 2D', language: 'ru' }), 'CODEX_2D_WORKER_NOT_CONFIGURED');
    assert.equal((await unavailable.codexLessons.create(user, { title: 'Spatial topic', language: 'ru', idempotencyKey: 'spatial-request-001' })).created, false);
    await unavailable.finishGeneratedJobs();
  } finally { release3d(); await ctx.finishGeneratedJobs(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
