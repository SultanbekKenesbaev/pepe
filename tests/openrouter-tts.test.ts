import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { requestOpenRouterSpeech, openRouterPublicError } from '../server/openrouter-speech.js';
import { waveDuration } from '../server/cinema.js';
import { createApp } from '../server/app.js';
import type { CodexScriptRequest, CodexVisualRequest } from '../server/codex-lessons.js';

const request = {
  apiKey: 'isolated-openrouter-key-never-sent', model: 'google/gemini-3.8-flash-tts', voice: 'Puck',
  input: 'Ájiniyaz: el, jer hám yad. Массив хранит значения.', instructions: 'Speak only the supplied words, with clear and energetic delivery.',
};
const pcm = Buffer.alloc(48_000);
for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(offset % 8 === 0 ? -4321 : 1234, offset);
const success = () => new Response(pcm, { headers: { 'Content-Type': 'audio/pcm', 'X-Generation-Id': 'gen-isolated' } });

test('OpenRouter sends text and delivery separately with its own bearer key and preserves PCM16 little-endian mono at 24 kHz', async () => {
  let calls = 0;
  const wave = await requestOpenRouterSpeech(request, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${request.apiKey}`);
    assert.equal(headers.get('content-type'), 'application/json'); assert.equal(headers.get('x-goog-api-key'), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { model: request.model, input: request.input, voice: 'Puck', instructions: request.instructions, response_format: 'pcm' });
    return success();
  } });
  assert.equal(calls, 1); assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wave.readUInt16LE(20), 1); assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt32LE(24), 24000); assert.equal(wave.readUInt16LE(34), 16);
  assert.equal(waveDuration(wave), 1); assert.deepEqual(wave.subarray(44), pcm);
  assert.equal(wave.readInt16LE(44), -4321); assert.equal(wave.readInt16LE(46), 1234);
});

test('chunk boundaries can split a sample without changing audio bytes', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(pcm.subarray(0, 7)); controller.enqueue(pcm.subarray(7, 201)); controller.enqueue(pcm.subarray(201)); controller.close();
  } });
  const wave = await requestOpenRouterSpeech(request, { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'audio/pcm; rate=24000; channels=1' } }) });
  assert.deepEqual(wave.subarray(44), pcm); assert.equal(waveDuration(wave), 1);
});

test('401, ordinary 402 and other permanent request errors fail once without leaking provider bodies', async () => {
  const cases = [[400, 'INVALID'], [401, 'AUTH'], [402, 'BALANCE'], [403, 'BLOCKED'], [404, 'MODEL'], [413, 'INVALID']] as const;
  for (const [status, code] of cases) {
    let calls = 0;
    await assert.rejects(requestOpenRouterSpeech(request, {
      fetch: async () => { calls++; return Response.json({ error: { message: 'private-account-or-bearer-token', metadata: { raw: request.apiKey } } }, { status, headers: { 'Retry-After': '1' } }); },
      sleep: async () => assert.fail('A permanent failure must not wait or spend another call'),
    }), error => error instanceof Error && error.message === `GENERATION_OPENROUTER_${code}` && !error.stack?.includes('private-account-or-bearer-token') && !error.stack?.includes(request.apiKey));
    assert.equal(calls, 1);
  }
  assert.match(openRouterPublicError(new Error('GENERATION_OPENROUTER_AUTH'))!, /OpenRouter.*ключ/);
  assert.match(openRouterPublicError(new Error('GENERATION_OPENROUTER_BALANCE'))!, /OpenRouter.*недостаточно средств/);
  assert.equal(openRouterPublicError(new Error('unrelated-private-error')), undefined);
});

test('transient 429 and provider failures respect Retry-After before recovering', async () => {
  const responses = [Response.json({}, { status: 429, headers: { 'Retry-After': '2.5' } }), Response.json({}, { status: 503, headers: { 'Retry-After': '4' } }), success()];
  let calls = 0; const waits: number[] = [];
  const wave = await requestOpenRouterSpeech(request, { fetch: async () => { calls++; return responses.shift()!; }, sleep: async ms => { waits.push(ms); }, random: () => 0 });
  assert.equal(waveDuration(wave), 1); assert.equal(calls, 3); assert.deepEqual(waits, [2500, 4000]);
});

test('only a bounded, explicitly identified in-flight 402 can retry; credit and key-budget failures remain terminal', async () => {
  const temporary = { error: { code: 402, message: 'private account details', metadata: { limit_source: 'openrouter_in_flight_budget' } } };
  let calls = 0; const waits: number[] = [];
  const wave = await requestOpenRouterSpeech(request, { fetch: async () => ++calls === 1 ? Response.json(temporary, { status: 402, headers: { 'Retry-After': '3' } }) : success(), sleep: async ms => { waits.push(ms); }, random: () => 0 });
  assert.equal(waveDuration(wave), 1); assert.equal(calls, 2); assert.deepEqual(waits, [3000]);
  const terminal = [
    () => Response.json(temporary, { status: 402 }),
    () => Response.json({ error: { metadata: { limit_source: 'openrouter_key_limit' } } }, { status: 402, headers: { 'Retry-After': '3' } }),
    () => Response.json({ error: { metadata: { limit_source: 'openrouter_credits' } } }, { status: 402, headers: { 'Retry-After': '3' } }),
    () => new Response('private-account-details'.repeat(5000), { status: 402, headers: { 'Retry-After': '3', 'Content-Type': 'application/json' } }),
  ];
  for (const response of terminal) {
    let attempts = 0;
    await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => { attempts++; return response(); }, sleep: async () => assert.fail('A balance or unverified budget error must not spend another call') }), { message: 'GENERATION_OPENROUTER_BALANCE' });
    assert.equal(attempts, 1);
  }
});

test('Retry-After dates are respected and waits are never shortened to fit a retry budget', async () => {
  const now = Date.parse('2026-10-24T02:00:00Z'), waits: number[] = []; let calls = 0;
  await requestOpenRouterSpeech(request, { fetch: async () => ++calls === 1 ? Response.json({}, { status: 502, headers: { 'Retry-After': 'Sat, 24 Oct 2026 02:00:05 GMT' } }) : success(), now: () => now, sleep: async ms => { waits.push(ms); }, random: () => 0 });
  assert.deepEqual(waits, [5000]); assert.equal(calls, 2);
  let longCalls = 0;
  await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => { longCalls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '61' } }); }, sleep: async () => assert.fail('Do not retry earlier than requested') }), { message: 'GENERATION_OPENROUTER_RETRY_LATER' });
  assert.equal(longCalls, 1);
  const totalWaits: number[] = []; let totalCalls = 0;
  await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => { totalCalls++; return Response.json({}, { status: 503, headers: { 'Retry-After': '60' } }); }, sleep: async ms => { totalWaits.push(ms); } }), { message: 'GENERATION_OPENROUTER_RETRY_LATER' });
  assert.equal(totalCalls, 3); assert.deepEqual(totalWaits, [60000, 60000]);
});

test('network failures and 5xx responses share a maximum four paid attempts', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => { calls++; if (calls % 2) throw new Error(`private network details ${request.apiKey}`); return Response.json({ private: true }, { status: 529 }); }, sleep: async ms => { waits.push(ms); }, random: () => 0 }), { message: 'GENERATION_OPENROUTER_UNAVAILABLE' });
  assert.equal(calls, 4); assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('empty successful responses retry at most three times, sharing the HTTP attempt budget', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => { calls++; return new Response(new Uint8Array(), { headers: { 'Content-Type': 'audio/pcm' } }); }, sleep: async ms => { waits.push(ms); }, random: () => 0 }), { message: 'GENERATION_OPENROUTER_EMPTY' });
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
  let mixedCalls = 0;
  await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => ++mixedCalls % 2 ? Response.json({}, { status: 503 }) : new Response(null, { headers: { 'Content-Type': 'audio/pcm' } }), sleep: async () => {}, random: () => 0 }), { message: 'GENERATION_OPENROUTER_EMPTY' });
  assert.equal(mixedCalls, 4);
});

test('audio sample bytes resembling ASCII markup are preserved rather than mistaken for error documents', async () => {
  for (const prefix of ['[', '{', '<', 'RIFF']) {
    const sample = Buffer.from(pcm); sample.write(prefix, 0, 'ascii');
    const wave = await requestOpenRouterSpeech(request, { fetch: async () => new Response(sample, { headers: { 'Content-Type': 'audio/pcm' } }) });
    assert.deepEqual(wave.subarray(44), sample);
  }
});

test('JSON content types, odd bytes, wrong sample layout and oversized bodies cannot become successful audio', async () => {
  const cases: [() => Response, string][] = [
    [() => Response.json({ error: { code: 502, message: 'private upstream failure' } }), 'FORMAT'],
    [() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/pcm' } }), 'INVALID'],
    [() => new Response(pcm, { headers: { 'Content-Type': 'audio/L16; rate=24000; channels=1' } }), 'FORMAT'],
    [() => new Response(pcm, { headers: { 'Content-Type': 'audio/pcm; rate=48000; channels=1' } }), 'FORMAT'],
    [() => new Response(pcm, { headers: { 'Content-Type': 'audio/pcm; rate=24000; channels=2' } }), 'FORMAT'],
    [() => new Response(pcm, { headers: { 'Content-Type': 'audio/pcm; bits=24' } }), 'FORMAT'],
    [() => new Response(pcm, { headers: { 'Content-Type': 'audio/pcm', 'Content-Length': String(61 * 1024 * 1024) } }), 'TOO_LARGE'],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    await assert.rejects(requestOpenRouterSpeech(request, { fetch: async () => { calls++; return response(); }, sleep: async () => assert.fail('Corrupt audio must not retry') }), { message: `GENERATION_OPENROUTER_${code}` });
    assert.equal(calls, 1);
  }
});

test('malformed models, voices and requests fail before a provider call', async () => {
  const cases = [
    { ...request, model: 'google/../../secrets' }, { ...request, voice: '../Puck' },
    { ...request, apiKey: '' }, { ...request, input: ' ' }, { ...request, input: 'x'.repeat(18001) },
  ];
  for (const value of cases) await assert.rejects(requestOpenRouterSpeech(value, { fetch: async () => assert.fail('Invalid request must not make a provider call') }), /GENERATION_OPENROUTER_/);
});

test('shutdown aborts before a request, during provider backoff and while reading a stalled body', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(requestOpenRouterSpeech({ ...request, signal: before.signal }, { fetch: async () => assert.fail('Aborted jobs cannot call a provider') }), { name: 'AbortError' });
  const backoff = new AbortController(); let calls = 0; const started = Date.now();
  const pending = requestOpenRouterSpeech({ ...request, signal: backoff.signal }, { fetch: async () => { calls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }); } });
  const checked = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20)); backoff.abort(); await checked;
  assert.equal(calls, 1); assert.ok(Date.now() - started < 500);
  const reading = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pcm.subarray(0, 100)); }, cancel() { cancelled = true; } });
  const stalled = requestOpenRouterSpeech({ ...request, signal: reading.signal }, { fetch: async () => new Response(body, { headers: { 'Content-Type': 'audio/pcm' } }) });
  const stopped = assert.rejects(stalled, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20)); reading.abort(); await stopped; assert.equal(cancelled, true);
});

test('one timeout covers provider requests, streamed bodies and Retry-After pauses', async () => {
  let calls = 0; const started = Date.now();
  await assert.rejects(requestOpenRouterSpeech({ ...request, timeoutMs: 1000 }, { fetch: async () => { calls++; return Response.json({}, { status: 503, headers: { 'Retry-After': '5' } }); } }), { name: 'TimeoutError' });
  assert.equal(calls, 1); assert.ok(Date.now() - started < 1800);
});

test('2D and 3D topic routes use OpenRouter without a Google key and retain measured narration on a render failure', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openrouter-authoring-'));
  const keyFile = path.join(directory, 'openrouter.key'); await writeFile(keyFile, request.apiKey, { mode: 0o600 });
  const sourcePcm = Buffer.alloc(48000 * 48); let voiceCalls = 0; const visualModes: string[] = [];
  const app = await createApp({ dataDir: directory, seedDemo: true, generation: {
    apiKey: '', apiKeyFile: path.join(directory, 'missing-google.key'), voiceBackend: 'openrouter', openRouterApiKeyFile: keyFile, voiceModel: request.model, voice: 'Puck',
    voiceFetch: async (url, init) => {
      voiceCalls++; assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
      const headers = new Headers(init?.headers); assert.equal(headers.get('authorization'), `Bearer ${request.apiKey}`); assert.equal(headers.get('x-goog-api-key'), null);
      const sent = JSON.parse(String(init?.body)); assert.equal(sent.model, request.model); assert.equal(sent.voice, 'Puck'); assert.equal(sent.response_format, 'pcm');
      assert.ok(sent.input.startsWith('Фраза ')); assert.ok(!sent.input.includes('<TRANSCRIPT>')); assert.match(sent.instructions, /Speak natural Russian/);
      return new Response(sourcePcm, { headers: { 'Content-Type': 'audio/pcm' } });
    },
    codexScriptProvider: async (value: CodexScriptRequest) => ({ title: value.title, summary: 'Изолированная проверка соединения.', direction: 'Наглядное объяснение учебной темы.', chapters: Array.from({ length: 3 }, (_, chapter) => ({ id: `chapter-${chapter}`, title: 'Сцена', scene: 'custom' as const, headline: 'Массив', labels: [], values: [], palette: 'dark' as const, visualDirection: 'Показать последовательность значений.', cues: Array.from({ length: 4 }, (_, cue) => ({ id: `cue-${chapter}-${cue}`, text: `Фраза ${chapter}, ${cue}: массив хранит последовательность значений.`, visualAction: 'Выделить выбранное значение массива.' })) })) }),
    codexVisualProvider: async ({ lesson }: CodexVisualRequest) => {
      visualModes.push(lesson.videoMode!); assert.equal(lesson.voiceProfile?.model, request.model); assert.equal(lesson.voiceProfile?.voice, 'Puck'); assert.equal(lesson.voiceProfile?.backend, 'openrouter'); assert.equal(lesson.duration, 600);
      assert.ok(lesson.chapters.every(chapter => chapter.cues?.every(cue => cue.audioDuration === 48 && cue.audioHash)));
      const cue = lesson.chapters[0].cues![0];
      const oldKey = { text: cue.text, model: request.model, voice: 'Puck', language: 'ru', style: 'authoring-cue-v1' };
      const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      assert.equal(cue.audioHash, hash({ ...oldKey, backend: 'openrouter' }));
      assert.notEqual(cue.audioHash, hash(oldKey), 'Provider changes must never reuse a Google cache entry with the same model name');
      // An intentional trusted-renderer failure exercises resume behavior; no real video is generated.
      throw new Error('CODEX_RENDER_FAILED');
    },
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  type Client = { cookie: string; csrf: string };
  const call = async (client: Client | undefined, route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, response };
  };
  const login = async (email: string, password: string): Promise<Client> => {
    const result = await call(undefined, '/api/auth/login', 'POST', { email, password }); assert.equal(result.status, 200);
    return { cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrfToken };
  };
  const wait = async (client: Client, id: string) => {
    for (let count = 0; count < 500; count++) { const result = await call(client, `/api/generated-lessons/${id}`); if (result.data.status === 'failed') return result.data; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Isolated lesson did not reach the render stage');
  };
  try {
    const teacher = await login('demo@aiteacher.local', 'PepeOnly-teacher-2026!'), admin = await login('admin@aiteacher.local', 'PepeOnly-admin-2026!');
    assert.equal((await call(admin, '/api/institutions/demo-school', 'PATCH', { settings: { allowExternalAI: true } })).status, 200);
    const config = (await call(teacher, '/api/generated-lessons/config')).data;
    assert.equal(config.configured, true); assert.equal(config.authoringConfigured, true); assert.equal(config.voiceBackend, 'openrouter'); assert.equal(config.voiceModel, request.model); assert.equal(config.voice, 'Puck');
    for (const mode of ['2d', '3d']) {
      const created = await call(teacher, '/api/generated-lessons', 'POST', { title: `Массив ${mode}`, language: 'ru', videoMode: mode }); assert.equal(created.status, 202, JSON.stringify(created.data));
      const lesson = await wait(teacher, created.data.id); assert.equal(lesson.errorCode, 'CODEX_RENDER_FAILED'); assert.equal(lesson.errorStage, 'visuals'); assert.equal(lesson.duration, 600); assert.equal(lesson.voiceProfile.model, request.model);
      const wave = await readFile(path.join(directory, 'generated', lesson.id, lesson.chapters[0].id + '.wav')); assert.equal(waveDuration(wave), 200);
      const before = voiceCalls, cached = lesson.chapters[0].cues[0].audioHash;
      assert.equal((await call(teacher, `/api/generated-lessons/${lesson.id}/retry`, 'POST', { revision: lesson.revision })).status, 202);
      const retried = await wait(teacher, lesson.id); assert.equal(retried.errorCode, 'CODEX_RENDER_FAILED'); assert.equal(retried.chapters[0].cues[0].audioHash, cached); assert.equal(voiceCalls, before, 'Unchanged OpenRouter profile reuses its measured audio');
    }
    assert.equal(voiceCalls, 24); assert.deepEqual(visualModes, ['2d', '2d', '3d', '3d']);
    await rm(keyFile); await writeFile(path.join(directory, 'missing-google.key'), 'isolated-google-key-must-not-be-a-fallback', { mode: 0o600 });
    assert.equal((await call(teacher, '/api/generated-lessons/config')).data.configured, false);
    const missing = await call(teacher, '/api/generated-lessons', 'POST', { title: 'Без ключа OpenRouter', language: 'ru', videoMode: '2d' });
    assert.equal(missing.status, 503); assert.equal(missing.data.code, 'GENERATION_NOT_CONFIGURED'); assert.equal(voiceCalls, 24);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await app.locals.close(); await rm(directory, { recursive: true, force: true });
  }
});
