import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestGoogleContent, googlePublicError } from '../server/google-request.js';

const request = { apiKey: 'isolated-test-key-never-sent', model: 'gemini-2.5-pro-preview-tts', body: { contents: [] } };
const result = { candidates: [{ content: { parts: [{ text: 'Success' }] } }] };
const success = () => Response.json(result);
const retry = (delay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
const quota = (violation: Record<string, unknown>, delay = '1s') => ({ error: { message: 'Private provider/project identifiers must never leave this response.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [violation] }, retry(delay)] } });

test('transient Google 429/503 honors the largest RetryInfo and Retry-After then returns the real response', async () => {
  const waits: number[] = [], responses = [Response.json({ error: { details: [retry('2.500000000s')] } }, { status: 429, headers: { 'Retry-After': '1' } }), Response.json({}, { status: 503, headers: { 'Retry-After': '4' } }), success()];
  let calls = 0;
  const actual = await requestGoogleContent(request, { fetch: async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get('x-goog-api-key'), request.apiKey); return responses.shift()!; }, sleep: async milliseconds => { waits.push(milliseconds); }, random: () => 0 });
  assert.deepEqual(actual, result); assert.equal(calls, 3); assert.deepEqual(waits, [2500, 4000]);
});

test('Google Retry-After HTTP dates are respected', async () => {
  const now = Date.parse('2026-10-21T11:10:00Z'), waits: number[] = []; let calls = 0;
  await requestGoogleContent(request, { fetch: async () => ++calls === 1 ? Response.json({}, { status: 503, headers: { 'Retry-After': 'Wed, 21 Oct 2026 11:10:05 GMT' } }) : success(), now: () => now, sleep: async ms => { waits.push(ms); }, random: () => 0 });
  assert.deepEqual(waits, [5000]); assert.equal(calls, 2);
});

test('persistent transient limits stop after four calls and exponential bounded delays without exposing the response', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(requestGoogleContent(request, { fetch: async () => { calls++; return Response.json({ error: { message: 'secret-project-or-key' } }, { status: 429 }); }, sleep: async ms => { waits.push(ms); }, random: () => 0 }), error => error instanceof Error && error.message === 'GENERATION_HTTP_429' && !error.stack?.includes('secret-project-or-key'));
  assert.equal(calls, 4); assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('actual daily TTS quota shape fails immediately despite a RetryInfo suggestion', async () => {
  const body = quota({ quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model_per_day', quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaDimensions: { model: 'gemini-2.5-pro-tts', location: 'global' }, quotaValue: '50' }, '71282s');
  let calls = 0, waits = 0;
  await assert.rejects(requestGoogleContent(request, { fetch: async () => { calls++; return Response.json(body, { status: 429 }); }, sleep: async () => { waits++; } }), { message: 'GENERATION_QUOTA_DAILY' });
  assert.equal(calls, 1); assert.equal(waits, 0); assert.match(googlePublicError(new Error('GENERATION_QUOTA_DAILY'))!, /Суточная.*Google AI Studio/); assert.doesNotMatch(googlePublicError(new Error('GENERATION_QUOTA_DAILY'))!, /Private|quotaDimensions|71282/);
});

test('camel-case daily quota IDs and zero-valued access quotas fail fast without confusing fractional limits', async () => {
  const cases: [unknown, string][] = [
    [quota({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }), 'GENERATION_QUOTA_DAILY'],
    [quota({ quotaId: 'GenerateRequestsPerMinutePerProject', quotaValue: '0' }), 'GENERATION_QUOTA_DISABLED'],
    [quota({ quota_metric: 'generate_requests', quota_value: 0 }), 'GENERATION_QUOTA_DISABLED'],
    [{ error: { message: 'Quota exceeded for metric X, limit: 0, model: unavailable' } }, 'GENERATION_QUOTA_DISABLED'],
    [{ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', metadata: { quota_limit_value: '0' } }] } }, 'GENERATION_QUOTA_DISABLED'],
  ];
  for (const [body, code] of cases) {
    let calls = 0;
    await assert.rejects(requestGoogleContent(request, { fetch: async () => { calls++; return Response.json(body, { status: 429 }); }, sleep: async () => assert.fail('Permanent quota must not wait') }), { message: code }); assert.equal(calls, 1);
  }
  let fractionalCalls = 0;
  assert.deepEqual(await requestGoogleContent(request, { fetch: async () => ++fractionalCalls === 1 ? Response.json({ error: { message: 'Spend rate limit: 0.5 per minute' } }, { status: 429 }) : success(), sleep: async () => {}, random: () => 0 }), result);
  assert.equal(fractionalCalls, 2); assert.match(googlePublicError(new Error('GENERATION_QUOTA_DISABLED'))!, /квота равна нулю.*оплату/);
});

test('waits beyond 60 seconds or cumulative 120 seconds never retry earlier than Google allows', async () => {
  let longCalls = 0;
  await assert.rejects(requestGoogleContent(request, { fetch: async () => { longCalls++; return Response.json({ error: { details: [retry('61s')] } }, { status: 429 }); }, sleep: async () => assert.fail('Must not shorten provider delay') }), { message: 'GENERATION_RETRY_LATER' }); assert.equal(longCalls, 1);
  let calls = 0; const waits: number[] = [];
  await assert.rejects(requestGoogleContent(request, { fetch: async () => { calls++; return Response.json({}, { status: 503, headers: { 'Retry-After': '60' } }); }, sleep: async ms => { waits.push(ms); }, random: () => 0 }), { message: 'GENERATION_RETRY_LATER' });
  assert.equal(calls, 3); assert.deepEqual(waits, [60000, 60000]);
});

test('client errors never retry, and oversized private error bodies are bounded', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    await assert.rejects(requestGoogleContent(request, { fetch: async () => { calls++; return new Response('private details'.repeat(10000), { status }); }, sleep: async () => assert.fail('Client errors must not retry') }), { message: `GENERATION_HTTP_${status}` }); assert.equal(calls, 1);
  }
});

test('shutdown aborts before a call and interrupts Retry-After sleep immediately', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(requestGoogleContent({ ...request, signal: before.signal }, { fetch: async () => { calls++; return success(); } }), { name: 'AbortError' }); assert.equal(calls, 0);
  const controller = new AbortController(), started = Date.now();
  const pending = requestGoogleContent({ ...request, signal: controller.signal }, { fetch: async () => { calls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }); } });
  const checked = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); await checked;
  assert.equal(calls, 1); assert.ok(Date.now() - started < 500);
});

test('one timeout bounds attempts and provider-requested pauses together', async () => {
  let calls = 0; const started = Date.now();
  await assert.rejects(requestGoogleContent({ ...request, timeoutMs: 1000 }, { fetch: async () => { calls++; return Response.json({}, { status: 503, headers: { 'Retry-After': '5' } }); } }), { name: 'TimeoutError' });
  assert.equal(calls, 1); assert.ok(Date.now() - started < 1800);
});
