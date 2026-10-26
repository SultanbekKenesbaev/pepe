import { pcmWave } from './cinema.js';

/** Provider bodies and headers may contain private account data: only fixed codes escape. */
export interface OpenRouterSpeechRequest {
  apiKey: string; model: string; input: string; voice: string; instructions: string;
  signal?: AbortSignal; timeoutMs?: number;
}
interface RequestDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}
const maximumAttempts = 4, maximumBytes = 60 * 1024 * 1024, maximumWait = 60_000, maximumTotalWait = 120_000;
const code = (name: string) => new Error(`GENERATION_OPENROUTER_${name}`);

function sleep(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function readPcm(response: Response, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) throw code('TOO_LARGE');
  const contentType = response.headers.get('content-type') || '';
  if (!/^(?:audio\/pcm|application\/octet-stream)(?:\s*;|$)/i.test(contentType)) throw code('FORMAT');
  for(const parameter of contentType.split(';').slice(1)){
    const [rawName,raw]=parameter.trim().split('=');const name=rawName.toLowerCase(),value=raw?.trim().replace(/^"|"$/g,'').toLowerCase();
    if((['rate','sample_rate'].includes(name)&&value!=='24000')||(name==='channels'&&value!=='1')||(name==='bits'&&value!=='16')||(name==='endian'&&!['little','le'].includes(value))||(name==='codec'&&!['pcm','pcm_s16le','s16le'].includes(value)))throw code('FORMAT');
  }
  const pcm=await readBounded(response,signal,maximumBytes);
  if(!pcm.length)throw code('EMPTY');
  if(pcm.length%2)throw code('INVALID');
  return pcmWave(pcm,24000,1,16);
}
async function readBounded(response:Response,signal:AbortSignal,maximum:number):Promise<Buffer> {
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  let rejectAbort!:(reason:unknown)=>void;
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  // Also bounds custom streams: fetch's abort behavior alone does not cover their reader.
  const abort=()=>{rejectAbort(signal.reason);void reader.cancel().catch(()=>undefined);};
  signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    for(;;){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;
      size+=part.value.byteLength;if(size>maximum)throw code('TOO_LARGE');chunks.push(part.value);}
    signal.throwIfAborted();return Buffer.concat(chunks);
  }catch(error){signal.throwIfAborted();if(error instanceof Error&&/^GENERATION_OPENROUTER_/.test(error.message))throw error;throw code('NETWORK');}
  finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
async function temporaryBudget(response:Response,signal:AbortSignal):Promise<boolean> {
  if(!response.headers.has('retry-after')){void response.body?.cancel().catch(()=>undefined);return false;}
  try {
    // Only this fixed metadata value changes behavior; private messages are never retained or surfaced.
    const payload=JSON.parse((await readBounded(response,signal,64*1024)).toString('utf8'));
    return payload?.error?.metadata?.limit_source==='openrouter_in_flight_budget';
  }catch{signal.throwIfAborted();return false;}
}

function retryDelay(response: Response | undefined, now: number) {
  const value = response?.headers.get('retry-after');
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}
export function openRouterPublicError(error: unknown): string | undefined {
  const name = error instanceof Error ? error.message.replace(/^GENERATION_OPENROUTER_/, '') : '';
  if (!(error instanceof Error) || !error.message.startsWith('GENERATION_OPENROUTER_')) return undefined;
  if (name === 'AUTH' || name === 'NOT_CONFIGURED') return 'OpenRouter: проверьте ключ и доступ к озвучке в настройках сервера.';
  if (name === 'BALANCE') return 'На балансе OpenRouter недостаточно средств для озвучки. Пополните баланс и повторите подготовку. Готовые реплики сохранены.';
  if (name === 'RATE_LIMIT' || name === 'RETRY_LATER') return 'Лимит озвучки OpenRouter временно исчерпан. Повторите подготовку позже. Готовые реплики сохранены.';
  if (name === 'MODEL') return 'Выбранная модель озвучки недоступна в OpenRouter. Администратор должен проверить модель на сервере.';
  if (name === 'BLOCKED') return 'OpenRouter отклонил озвучку одной из реплик. Готовые реплики сохранены. Измените тему или материалы и создайте новый урок.';
  if (name === 'EMPTY') return 'OpenRouter не вернул озвучку одной из реплик после повторных запросов. Готовые реплики сохранены. Повторите подготовку.';
  if (['INVALID', 'FORMAT', 'TOO_LARGE'].includes(name)) return 'OpenRouter вернул повреждённую озвучку или неподдерживаемый формат. Готовые реплики сохранены. Повторите подготовку.';
  if (['NETWORK', 'UNAVAILABLE'].includes(name)) return 'Сервис озвучки OpenRouter временно недоступен. Готовые реплики сохранены. Повторите подготовку позже.';
  return 'OpenRouter не завершил озвучку. Готовые реплики сохранены. Повторите подготовку.';
}

/** Gemini speech is raw little-endian 24 kHz mono PCM16, not OpenRouter chat completions. */
export async function requestOpenRouterSpeech(request: OpenRouterSpeechRequest, dependencies: RequestDependencies = {}): Promise<Buffer> {
  request.signal?.throwIfAborted();
  if (!request.apiKey?.trim()) throw code('NOT_CONFIGURED');
  if (!/^[a-z0-9][a-z0-9.-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/.test(request.model) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.voice)) throw code('MODEL');
  if (typeof request.input !== 'string' || !request.input.trim() || request.input.length > 18000 || typeof request.instructions !== 'string' || request.instructions.length > 16000) throw code('INVALID');
  const timeout = AbortSignal.timeout(Math.max(1000, Math.min(240000, request.timeoutMs || 180000)));
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  const send = dependencies.fetch || fetch, pause = dependencies.sleep || sleep, random = dependencies.random || Math.random, clock = dependencies.now || Date.now;
  const body = JSON.stringify({model: request.model, input: request.input, voice: request.voice, instructions: request.instructions, response_format: 'pcm'});
  let emptyReplies = 0, totalWait = 0;
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    signal.throwIfAborted();
    let response: Response | undefined, failure: Error;
    try {
      response = await send('https://openrouter.ai/api/v1/audio/speech', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${request.apiKey}`}, body, signal, redirect: 'error'});
    } catch { signal.throwIfAborted(); failure = code('NETWORK'); }
    if (response) {
      if (response.ok) {
        try { return await readPcm(response, signal); }
        catch (error) {
          signal.throwIfAborted();
          void response.body?.cancel().catch(()=>undefined);
          if (!(error instanceof Error)) throw code('INVALID');
          failure = error;
          if (error.message === 'GENERATION_OPENROUTER_EMPTY') { if (++emptyReplies >= 3) throw error; }
          else if (error.message !== 'GENERATION_OPENROUTER_NETWORK') throw error;
        }
      } else {
        if(response.status===402){
          if(!await temporaryBudget(response,signal))throw code('BALANCE');
          failure=code('RATE_LIMIT');
        }else {
          // Other failures need no provider body; close it immediately.
          void response.body?.cancel().catch(()=>undefined);
          if(response.status===401)throw code('AUTH');
          if(response.status===403)throw code('BLOCKED');
          if(response.status===404)throw code('MODEL');
          if(response.status===429)failure=code('RATE_LIMIT');
          else if(response.status>=500)failure=code('UNAVAILABLE');
          else throw code('INVALID');
        }
      }
    }
    if (attempt === maximumAttempts - 1) throw failure!;
    const required = retryDelay(response, clock());
    const wait = Math.ceil(Math.max(required, 1000 * 2 ** attempt + Math.min(1, Math.max(0, random())) * 250));
    if (wait > maximumWait || totalWait + wait > maximumTotalWait) throw code('RETRY_LATER');
    totalWait += wait; await pause(wait, signal); signal.throwIfAborted();
  }
  throw code('RETRY_LATER');
}
