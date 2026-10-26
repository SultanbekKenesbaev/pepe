import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedLesson, GeneratedLessonLanguage, GeneratedLessonPhase, GeneratedLessonVideoMode, GeneratedLessonWorkerProgress } from '../shared/types.js';
import type { CodexScript } from './codex-lessons.js';

export interface CodexScriptRequest {
  lessonId: string; title: string; language: GeneratedLessonLanguage; source: string; targetDuration: 600; voiceModel: string;
  videoMode?: GeneratedLessonVideoMode;
  currentScript?: CodexScript; measuredDuration?: number; signal?: AbortSignal; onProgress?:(progress:GeneratedLessonWorkerProgress)=>Promise<void>;
}
export interface CodexVisualRequest { lesson: GeneratedLesson; dataDir: string; signal?: AbortSignal; onProgress?:(progress:GeneratedLessonWorkerProgress)=>Promise<void> }
type JobState = { status: 'queued' | 'running' | 'ready' | 'failed'; result?: any; progress?:unknown; error?: {code?:string;reason?:string;stage?:string} };
const maximumVideoBytes = 512 * 1024 * 1024;
/** JSONB may reorder nested object keys. Hash and send the very same canonical
 * JSON bytes; arrays retain their order because chapter/cue order is meaningful. */
function canonicalPayload(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);
}

async function tokenFor(file: string) {
  const stat = await lstat(file).catch(() => { throw new Error('CODEX_WORKER_NOT_CONFIGURED'); });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('CODEX_WORKER_NOT_CONFIGURED');
  const token = (await readFile(file, 'utf8')).trim();
  if (token.length < 32) throw new Error('CODEX_WORKER_NOT_CONFIGURED');
  return token;
}
const phases:GeneratedLessonPhase[]=['queued','alignment','images','authoring','checking','reviewing','rendering','validating','downloading'];
function errorFor(code: unknown, reason?: unknown, phase?: unknown): Error {
  const mapped:Record<string,string>={AUTH:'CODEX_AUTH_REQUIRED',MODEL:'CODEX_MODEL_UNAVAILABLE',RENDER:'CODEX_RENDER_FAILED',VALIDATION:'CODEX_VALIDATION_FAILED',BUSY:'CODEX_BUSY'};
  const reasons=['AUTHOR_TIMEOUT','SCRIPT_TIMEOUT','REVIEW_TIMEOUT','RENDER_TIMEOUT','SCRIPT_INVALID','SCENE_CHECK_FAILED','ARTIFACT_INVALID','WORKER_INTERRUPTED','ALIGNMENT_FAILED','IMAGE_GENERATION_FAILED'];
  const error=new Error(typeof reason==='string'&&reasons.includes(reason)?`CODEX_${reason}`:typeof code==='string'&&mapped[code]?mapped[code]:'CODEX_WORKER_FAILED');
  if(typeof phase==='string'&&phases.includes(phase as GeneratedLessonPhase))Object.assign(error,{generationStage:phase});
  return error;
}
/** A worker response can include generated data; only bounded numeric telemetry is trusted here. */
export function brokerProgress(value:unknown):GeneratedLessonWorkerProgress|undefined {
  if(!value||typeof value!=='object')return;
  const p=value as any;
  if(!phases.includes(p.stage)||!Number.isInteger(p.completed)||!Number.isInteger(p.total)||p.total<1||p.total>72000||p.completed<0||p.completed>p.total)return;
  const result:GeneratedLessonWorkerProgress={phase:p.stage,completed:p.completed,total:p.total};
  if(typeof p.stageStartedAt==='string'&&Number.isFinite(Date.parse(p.stageStartedAt)))result.stageStartedAt=new Date(p.stageStartedAt).toISOString();
  const f=p.frames;
  if(p.stage==='rendering'&&f&&Number.isInteger(f.completed)&&Number.isInteger(f.total)&&f.total>=1&&f.total<=72000&&f.completed>=0&&f.completed<=f.total)result.frames={completed:f.completed,total:f.total};
  return result;
}
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason || new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Only the trusted broker receives tokens. Generated JavaScript is never imported into this server. */
function brokerProviders(dataDir: string, configured: string | undefined, tokenFile: string | undefined) {
  if (!configured || !tokenFile) return {};
  const base = new URL(configured);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('CODEX_WORKER_URL_INVALID');
  const url = (relative: string) => new URL(relative, base.href.endsWith('/') ? base : base.href + '/');
  const request = async (relative: string, init: RequestInit = {}, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${await tokenFor(tokenFile)}`);
    const waits = [0, 750, 2000];
    for (let attempt = 0; attempt < waits.length; attempt++) {
      signal?.throwIfAborted();
      if (waits[attempt]) await delay(waits[attempt], signal);
      let response: Response;
      try {
        response = await fetch(url(relative), { ...init, headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), redirect: 'error' });
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === waits.length - 1) throw error;
        continue;
      }
      if (response.ok) return response;
      const body = await response.json().catch(() => ({})) as any;
      signal?.throwIfAborted();
      const code = body.error?.code;
      if (response.status < 500 || response.status >= 600 || ['AUTH', 'VALIDATION'].includes(code) || attempt === waits.length - 1) throw errorFor(code,body.error?.reason,body.error?.stage);
    }
    throw new Error('CODEX_WORKER_FAILED');
  };
  const run = async (id: string, kind: 'script' | 'visuals', body: string, signal?: AbortSignal,onProgress?:(progress:GeneratedLessonWorkerProgress)=>Promise<void>) => {
    let status = await (await request(`jobs/${id}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, signal)).json() as JobState;
    const deadline = Date.now() + 2 * 60 * 60_000;let previous='';
    while (status.status !== 'ready') {
      const progress=brokerProgress(status.progress),fingerprint=progress?JSON.stringify(progress):'';
      if(progress&&fingerprint!==previous){previous=fingerprint;await onProgress?.(progress);}
      if (status.status === 'failed') throw errorFor(status.error?.code,status.error?.reason,status.error?.stage);
      if (!['queued', 'running'].includes(status.status) || Date.now() > deadline) throw new Error('CODEX_WORKER_TIMEOUT');
      await delay(2000, signal);
      status = await (await request(`jobs/${id}/${kind}`, {}, signal)).json() as JobState;
    }
    if (!status.result) throw new Error('CODEX_VALIDATION_FAILED');
    return status.result;
  };
  return {
    codexScriptProvider: async (context: CodexScriptRequest): Promise<CodexScript> => {
      const { signal, onProgress, ...payload } = context;
      const body = canonicalPayload(payload), id = createHash('sha256').update('script:' + body).digest('hex');
      const result = await run(id, 'script', body, signal,onProgress);
      return result as CodexScript;
    },
    codexVisualProvider: async ({ lesson, dataDir: storage, signal,onProgress }: CodexVisualRequest) => {
      const payload = { lessonId: lesson.id, title: lesson.title, summary: lesson.summary, direction: lesson.direction, language: lesson.language || 'ru', videoMode: lesson.videoMode, duration: lesson.duration, voiceProfile: lesson.voiceProfile, chapters: lesson.chapters };
      const body = canonicalPayload(payload), id = createHash('sha256').update('visuals:' + body).digest('hex');
      for (const chapter of lesson.chapters) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(chapter.id)) throw new Error('CODEX_VALIDATION_FAILED');
        const file = path.join(storage, 'generated', lesson.id, chapter.id + '.wav');
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 60 * 1024 * 1024) throw new Error('CODEX_VALIDATION_FAILED');
        const bytes = await readFile(file);
        await request(`jobs/${id}/assets/${chapter.id}.wav`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'X-Content-SHA256': createHash('sha256').update(bytes).digest('hex') }, body: bytes as unknown as BodyInit }, signal);
      }
      const result = await run(id, 'visuals', body, signal,onProgress);
      if (Math.abs(Number(result.duration) - 600) > .05 || !Number.isInteger(result.width) || result.width < 640 || !Number.isInteger(result.height) || result.height < 360 || !(result.fps >= 24 && result.fps <= 60) || !/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error('CODEX_VALIDATION_FAILED');
      await onProgress?.({phase:'downloading',completed:0,total:1});
      const response = await request(`jobs/${id}/artifact`, {}, signal);
      if (!response.body || !(response.headers.get('content-type') || '').startsWith('video/mp4')) throw new Error('CODEX_VALIDATION_FAILED');
      const directory = path.join(dataDir, 'generated', lesson.id); await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, 'film.mp4'), temporary = file + '.download';
      const handle = await open(temporary, 'w', 0o600), digest = createHash('sha256'); let size = 0;
      try {
        const reader = response.body.getReader();
        try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maximumVideoBytes) { await reader.cancel(); throw new Error('CODEX_VALIDATION_FAILED'); } digest.update(chunk.value); let offset=0; while(offset<chunk.value.byteLength){ const result=await handle.write(chunk.value,offset,chunk.value.byteLength-offset); if(!result.bytesWritten)throw new Error('CODEX_VALIDATION_FAILED'); offset+=result.bytesWritten; } }
        } finally { reader.releaseLock(); }
      } catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
      await handle.close();
      if (size < 1024 || digest.digest('hex') !== result.sha256) { await unlink(temporary).catch(() => {}); throw new Error('CODEX_VALIDATION_FAILED'); }
      await rename(temporary, file);
      await writeFile(path.join(directory, 'render-validation.json'), JSON.stringify({ ...result, jobId: id, receivedAt: new Date().toISOString() }), { mode: 0o600 });
      return { file, duration: result.duration, width: result.width, height: result.height, fps: result.fps, sha256: result.sha256 };
    },
  };
}

/** Each mode has a separate broker, token and durable queue. Historical requests
 * without a mode retain their original 3D broker and canonical job bytes. */
export function createCodexProviders(dataDir: string) {
  const workers = {
    '3d': brokerProviders(dataDir, process.env.CODEX_WORKER_URL, process.env.CODEX_WORKER_TOKEN_FILE),
    '2d': brokerProviders(dataDir, process.env.CODEX_2D_WORKER_URL, process.env.CODEX_2D_WORKER_TOKEN_FILE),
  };
  const codexVideoModes = (['2d', '3d'] as const).filter(mode => workers[mode].codexScriptProvider && workers[mode].codexVisualProvider);
  if (!codexVideoModes.length) return {};
  const workerFor = (mode: GeneratedLessonVideoMode | undefined) => {
    const worker = workers[mode || '3d'];
    if (!worker?.codexScriptProvider || !worker?.codexVisualProvider) throw new Error(mode === '2d' ? 'CODEX_2D_WORKER_NOT_CONFIGURED' : 'CODEX_WORKER_NOT_CONFIGURED');
    return worker;
  };
  return {
    codexVideoModes,
    codexScriptProvider: async (request: CodexScriptRequest) => workerFor(request.videoMode).codexScriptProvider!(request),
    codexVisualProvider: async (request: CodexVisualRequest) => workerFor(request.lesson.videoMode).codexVisualProvider!(request),
  };
}
