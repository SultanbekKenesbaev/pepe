import { generatedWave } from './tts-output.js';

/** Google error bodies may contain project identifiers. Only fixed error codes leave this module. */
export interface GoogleContentRequest {
  apiKey: string; model: string; body: unknown; signal?: AbortSignal; timeoutMs?: number;
}
interface RequestDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}
const maximumAttempts = 4, maximumWait = 60_000, maximumTotalWait = 120_000;

function sleep(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function bytes(response: Response, maximum: number) {
  if (!response.body) throw new Error('GENERATION_EMPTY');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('GENERATION_TOO_LARGE'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function durationMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(value)) return undefined;
  const milliseconds = Number(value.slice(0, -1)) * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}
function errorDetails(body: any): any[] { return Array.isArray(body?.error?.details) ? body.error.details : []; }
function quotaCode(body: any): string | undefined {
  const details = errorDetails(body), violations = details.filter(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure').flatMap(detail => Array.isArray(detail.violations) ? detail.violations : []);
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  const zero = (value: unknown) => (typeof value === 'string' || typeof value === 'number') && /^0(?:\.0+)?$/.test(String(value).trim());
  if (violations.some(item => zero(item?.quotaValue) || zero(item?.quota_value)) ||
      details.some(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && zero(detail.metadata?.quota_limit_value ?? detail.metadata?.quotaLimitValue)) ||
      /\blimit\s*[:=]\s*0(?:\.0+)?(?=\s*(?:,|;|$|\.(?:\s|$)))/i.test(message)) return 'GENERATION_QUOTA_DISABLED';
  const descriptions = violations.map(item => [item?.quotaId, item?.quota_id, item?.quotaMetric, item?.quota_metric, item?.description].filter(value => typeof value === 'string').join(' '));
  if ([...descriptions, message].some(value => /per[\s_-]*day|daily\b|\/day\b/i.test(value))) return 'GENERATION_QUOTA_DAILY';
  return undefined;
}
function retryMilliseconds(response: Response, body: any, now: number) {
  let wait = 0;
  const after = response.headers.get('retry-after');
  if (after !== null) {
    if (/^\d+(?:\.\d+)?$/.test(after.trim())) wait = Number(after) * 1000;
    else { const date = Date.parse(after); if (Number.isFinite(date)) wait = Math.max(0, date - now); }
  }
  for (const detail of errorDetails(body)) {
    if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const delay = durationMilliseconds(detail.retryDelay ?? detail.retry_delay);
    if (delay !== undefined) wait = Math.max(wait, delay);
  }
  return wait;
}

export function googlePublicError(error: unknown): string | undefined {
  const code = error instanceof Error ? error.message : '';
  if (code === 'GENERATION_TTS_EMPTY') return 'Google не вернул озвучку одной из реплик после повторных запросов. Готовые реплики сохранены. Повторите подготовку.';
  if (code === 'GENERATION_TTS_BLOCKED') return 'Google отклонил текст одной из реплик при проверке содержимого. Готовые реплики сохранены. Измените тему или материалы и создайте новый урок.';
  if (code === 'GENERATION_TTS_INCOMPLETE') return 'Google прервал озвучку одной из реплик. Готовые реплики сохранены. Повторите подготовку.';
  if (code === 'GENERATION_TTS_FORMAT' || code === 'GENERATION_TTS_INVALID') return 'Google вернул повреждённую озвучку или неподдерживаемый формат. Готовые реплики сохранены. Повторите подготовку.';
  if (code === 'GENERATION_QUOTA_DISABLED') return 'Для выбранной модели Google AI квота равна нулю. Администратор должен проверить доступ к модели и оплату в Google AI Studio.';
  if (code === 'GENERATION_QUOTA_DAILY') return 'Суточная квота Google AI исчерпана. Повторите после её обновления или попросите администратора увеличить квоту в Google AI Studio. Готовая озвучка сохранена.';
  if (code === 'GENERATION_RETRY_LATER') return 'Google AI требует более долгого ожидания. Повторите подготовку позже. Готовая озвучка сохранена.';
  if (code === 'GENERATION_HTTP_503') return 'Google AI временно недоступен. Повторите подготовку позже. Готовая озвучка сохранена.';
  return undefined;
}

export async function requestGoogleContent(request: GoogleContentRequest, dependencies: RequestDependencies = {}): Promise<any> {
  return requestContent(request, dependencies, false);
}

/** Empty successful TTS responses and HTTP backoff share one timeout and call budget. */
export async function requestGoogleSpeech(request: GoogleContentRequest, dependencies: RequestDependencies = {}): Promise<Buffer> {
  return requestContent(request, dependencies, true);
}

async function requestContent(request: GoogleContentRequest, dependencies: RequestDependencies, speech: boolean): Promise<any> {
  request.signal?.throwIfAborted();
  if (!/^[a-z0-9][a-z0-9.-]{1,100}$/.test(request.model)) throw new Error('GENERATION_MODEL');
  if (!request.apiKey) throw new Error('GENERATION_NOT_CONFIGURED');
  const timeout = AbortSignal.timeout(Math.max(1000, Math.min(240000, request.timeoutMs || 180000)));
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  const send = dependencies.fetch || fetch, pause = dependencies.sleep || sleep, random = dependencies.random || Math.random, clock = dependencies.now || Date.now;
  let totalWait = 0, emptyReplies = 0;
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    signal.throwIfAborted();
    const response = await send(`https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': request.apiKey },
      body: JSON.stringify(request.body), signal, redirect: 'error',
    });
    if (response.ok) {
      const raw=await bytes(response, 90 * 1024 * 1024);let payload:any;
      try{payload=JSON.parse(raw.toString('utf8'));}catch(error){signal.throwIfAborted();if(speech)throw new Error('GENERATION_TTS_INVALID');throw error;}
      signal.throwIfAborted();
      if(!speech)return payload;
      try{return generatedWave(payload);}catch(error){
        if(!(error instanceof Error)||error.message!=='GENERATION_TTS_EMPTY')throw error;
        // A third empty response is final; safety refusals, partial audio and invalid formats never retry.
        emptyReplies++;
        if(emptyReplies>=3||attempt===maximumAttempts-1)throw error;
        const wait=1000*2**(emptyReplies-1);
        totalWait+=wait;
        if(totalWait>maximumTotalWait)throw new Error('GENERATION_RETRY_LATER');
        await pause(wait,signal);signal.throwIfAborted();continue;
      }
    }
    let body: unknown;
    try { body = JSON.parse((await bytes(response, 64 * 1024)).toString('utf8')); } catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    if (response.status === 429) { const quota = quotaCode(body); if (quota) throw new Error(quota); }
    const code = `GENERATION_HTTP_${response.status}`;
    if (![429, 503].includes(response.status) || attempt === maximumAttempts - 1) throw new Error(code);
    const requiredWait = retryMilliseconds(response, body, clock());
    const wait = Math.ceil(Math.max(requiredWait, 1000 * 2 ** attempt + Math.min(1, Math.max(0, random())) * 250));
    // Never shorten a provider's minimum delay in order to fit our retry budget.
    if (wait > maximumWait || totalWait + wait > maximumTotalWait) throw new Error('GENERATION_RETRY_LATER');
    totalWait += wait; await pause(wait, signal); signal.throwIfAborted();
  }
  throw new Error('GENERATION_RETRY_LATER');
}
