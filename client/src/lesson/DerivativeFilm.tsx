import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, LoaderCircle, Maximize, Minimize, Pause, Play, RefreshCw, Users, Volume2, VolumeX, X } from 'lucide-react';
import { api } from '../api';
import DerivativeScene from './DerivativeScene';
import type { CinemaManifest, DerivativeFilmProps } from './types';
import { presentationAt, presentationMarkup, sceneProgressAt } from './lessonMotion';
import { sceneThemeAt } from './sceneTheme';
import './DerivativeFilm.css';

const clamp = (value: number, lower = 0, upper = 1) => Math.max(lower, Math.min(upper, value));
const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, '0')}`;
const storageKey = (sessionId: string) => `aiteacher:derivative-cinema-v3:${sessionId}`;
function storedPosition(sessionId: string) {
  try { const value = Number(localStorage.getItem(storageKey(sessionId))); return Number.isFinite(value) && value > 0 ? value : 0; }
  catch { return 0; }
}


export default function DerivativeFilm(props: DerivativeFilmProps) {
  const { sessionId, preview, paused, busy, cameraLabel, cameraError, attendanceCount, onPause, onResume, onFinish, onAttendance, onRetryCamera, onExit } = props;
  const root = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const voice = useRef<HTMLAudioElement>(null);
  const bed = useRef<HTMLAudioElement>(null);
  const transition = useRef<HTMLAudioElement>(null);
  const impact = useRef<HTMLAudioElement>(null);
  const soundPosition = useRef({ position: 0, chapter: '', beat: -1 });
  const suppressSound = useRef(false);
  const latest = useRef(props); latest.current = props;
  const [manifest, setManifest] = useState<CinemaManifest | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const handleSceneReady = useCallback(() => setSceneReady(true), []);
  const [loadError, setLoadError] = useState('');
  const [position, setPosition] = useState(() => storedPosition(sessionId));
  const positionRef = useRef(position); positionRef.current = position;
  const [shown, setShown] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [visualOnly, setVisualOnly] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const hasVolume = volume > 0;
  const [fullScreen, setFullScreen] = useState(Boolean(document.fullscreenElement));
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardInput = useRef(false);
  const lastPersist = useRef(0);
  const duration = manifest?.duration || 600;
  const ended = Boolean(manifest && position >= duration - .03);
  const chapterIndex = manifest ? manifest.chapters.reduce((found, item, index) => position >= item.start ? index : found, 0) : 0;
  const chapter = manifest?.chapters[chapterIndex];
  const nextChapter = manifest?.chapters[chapterIndex + 1];
  const elapsed = chapter ? clamp(position - chapter.start, 0, chapter.duration) : 0;
  const progress = chapter ? clamp(elapsed / chapter.duration) : 0;
  const sceneProgress = chapter ? sceneProgressAt(chapter, progress) : 0;
  const sceneTheme = chapter ? sceneThemeAt(chapter.scene, sceneProgress) : 'dark';
  const presentation = chapter ? presentationAt(chapter, progress, reducedMotion) : null;
  const voiceMissing = Boolean(manifest && manifest.voice.status !== 'ready');
  const waitingForChoice = voiceMissing && !visualOnly;
  const playing = sceneReady && !paused && !blocked && !waitingForChoice && !audioError && !ended && Boolean(manifest);
  const backgroundAllowed = useRef(false);
  backgroundAllowed.current = playing && !buffering && !muted && hasVolume;
  const playback = useRef({ sceneReady, paused, blocked, visualOnly, waitingForChoice, audioError, ended, chapter, duration });
  playback.current = { sceneReady, paused, blocked, visualOnly, waitingForChoice, audioError, ended, chapter, duration };

  const reveal = useCallback(() => {
    setShown(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (keyboardInput.current && controls.current?.contains(document.activeElement)) return;
      if (controls.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
      setShown(false);
    }, 3000);
  }, []);

  const load = useCallback(() => {
    setLoadError('');
    api<CinemaManifest>('/cinema/derivative').then(data => {
      if (!data.chapters?.length || !Number.isFinite(data.duration) || data.duration <= 0) throw new Error('Урок недоступен');
      setManifest(data);
      const saved = clamp(storedPosition(sessionId), 0, data.duration);
      positionRef.current = saved; setPosition(saved);
    }).catch(error => setLoadError(error instanceof Error ? error.message : 'Урок недоступен'));
  }, [sessionId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  const playVoice = useCallback(async () => {
    const state = playback.current;
    const audio = voice.current;
    if (!audio || !state.sceneReady || state.paused || state.ended || state.waitingForChoice || state.visualOnly || state.audioError || !state.chapter?.audioUrl) return;
    const offset = Math.max(0, positionRef.current - state.chapter.start);
    if (offset >= (state.chapter.audioDuration || state.chapter.duration)) return;
    try {
      if (audio.readyState >= 1 && Math.abs(audio.currentTime - offset) > .4) audio.currentTime = offset;
      await audio.play(); setBlocked(false);
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return;
      setBuffering(false); setBlocked(true); reveal();
    }
  }, [reveal]);

  const syncBed = useCallback(() => {
    const background = bed.current;
    if (background && Number.isFinite(background.duration) && background.duration > 0) {
      background.currentTime = positionRef.current % background.duration;
    }
  }, []);

  const seek = useCallback((target: number) => {
    const state = playback.current;
    const value = clamp(target, 0, state.duration);
    const oldChapter = state.chapter;
    suppressSound.current = true;
    positionRef.current = value; setPosition(value);
    setAudioError('');
    const audio = voice.current;
    if (audio && oldChapter && value >= oldChapter.start && value < oldChapter.start + oldChapter.duration) {
      const offset = value - oldChapter.start;
      if (audio.readyState >= 1) audio.currentTime = Math.min(offset, oldChapter.audioDuration || oldChapter.duration);
      if (state.sceneReady && !state.paused && !state.blocked) void playVoice();
    } else audio?.pause();
    syncBed();
    try { localStorage.setItem(storageKey(sessionId), String(value)); } catch {}
    reveal();
  }, [playVoice, reveal, sessionId, syncBed]);

  const unlock = useCallback(() => {
    if (!playback.current.sceneReady) return;
    setBlocked(false); setAudioError('');
    if (playback.current.paused) latest.current.onResume();
    // These attempts happen inside the click/keyboard gesture, preserving browser activation.
    const audio = voice.current;
    if (audio && playback.current.chapter?.audioUrl && !visualOnly) {
      const offset = Math.max(0, positionRef.current - playback.current.chapter.start);
      if (audio.readyState >= 1 && offset < (playback.current.chapter.audioDuration || Infinity)) audio.currentTime = offset;
      void audio.play().then(() => {
        // Resume is confirmed by the server through props; a failed request must
        // never leave sound running while the actual teaching session is paused.
        if (latest.current.paused) audio.pause();
        setBlocked(false);
      }).catch(() => setBlocked(true));
    }
    if (!muted && volume > 0) {
      const background = bed.current;
      void background?.play().then(() => { if (!backgroundAllowed.current) background.pause(); }).catch(() => {});
    }
    reveal();
  }, [muted, volume, visualOnly, reveal]);

  const togglePause = useCallback(() => {
    if (latest.current.busy || !playback.current.sceneReady) return;
    reveal();
    if (playback.current.blocked) { unlock(); return; }
    if (playback.current.paused) unlock();
    else latest.current.onPause();
  }, [reveal, unlock]);

  const toggleFullScreen = useCallback(() => {
    reveal();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen().catch(() => {});
  }, [reveal]);

  useEffect(() => {
    const changed = () => setFullScreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && !root.current?.contains(event.target) && event.target !== document.body) return;
      keyboardInput.current = true;
      if (event.key === 'Tab') {
        if (!shown) { event.preventDefault(); reveal(); requestAnimationFrame(() => controls.current?.querySelector<HTMLButtonElement>('button')?.focus()); }
        else {
          reveal();
          const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') || []).filter(item => !item.closest('[inert]') && item.tabIndex >= 0);
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
        }
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.code === 'Space') {
        if (event.target instanceof HTMLElement && event.target.closest('button,a')) return;
        event.preventDefault(); if (!event.repeat) togglePause();
      }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(positionRef.current + 10); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(positionRef.current - 10); }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); toggleFullScreen(); }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); setMuted(value => !value); reveal(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('fullscreenchange', changed); };
  }, [shown, reveal, seek, togglePause, toggleFullScreen]);

  useEffect(() => {
    const audio = voice.current;
    if (!audio || !chapter) return;
    setBuffering(Boolean(chapter.audioUrl && !visualOnly));
    setAudioError('');
    const sync = () => {
      const target = clamp(positionRef.current - chapter.start, 0, chapter.audioDuration || chapter.duration);
      if (Math.abs(audio.currentTime - target) > .2) audio.currentTime = target;
      void playVoice();
    };
    audio.addEventListener('loadedmetadata', sync);
    if (audio.readyState >= 1) sync();
    return () => { audio.removeEventListener('loadedmetadata', sync); audio.pause(); };
  }, [chapter?.id, chapter?.audioUrl, playVoice, visualOnly]);

  useEffect(() => {
    const previous = soundPosition.current;
    const beat = presentation?.beatIndex ?? -1;
    const forward = position >= previous.position && position - previous.position < .8;
    if (chapter && playing && !buffering && !muted && !suppressSound.current && forward && previous.chapter) {
      const chapterChanged = previous.chapter !== chapter.id;
      const beatChanged = previous.beat !== beat;
      const effect = chapterChanged ? transition.current : beatChanged ? impact.current : null;
      if (effect) { effect.currentTime = 0; void effect.play().catch(() => {}); }
    }
    soundPosition.current = { position, chapter: chapter?.id || '', beat };
    suppressSound.current = false;
  }, [chapter?.id, presentation?.beatIndex, position, playing, buffering, muted]);

  useEffect(() => {
    if (!sceneReady || paused || blocked || waitingForChoice || ended || audioError) {
      voice.current?.pause(); bed.current?.pause(); transition.current?.pause(); impact.current?.pause();
      if (paused || ended || blocked) reveal();
    } else {
      void playVoice();
    }
  }, [sceneReady, paused, blocked, waitingForChoice, ended, audioError, playVoice, reveal]);

  useEffect(() => {
    const background = bed.current;
    if (!backgroundAllowed.current) {
      background?.pause();
      if (buffering) { impact.current?.pause(); transition.current?.pause(); }
      return;
    }
    syncBed();
    void background?.play().then(() => { if (!backgroundAllowed.current) background.pause(); }).catch(() => {});
  }, [playing, buffering, muted, hasVolume, syncBed]);

  useEffect(() => {
    if (voice.current) { voice.current.volume = volume; voice.current.muted = muted; }
    if (bed.current) { bed.current.volume = volume * .22; bed.current.muted = muted; }
    if (transition.current) { transition.current.volume = volume * .08; transition.current.muted = muted; }
    if (impact.current) { impact.current.volume = volume * .12; impact.current.muted = muted; }
  }, [muted, volume]);

  useEffect(() => {
    let frame = 0, previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(.25, Math.max(0, (now - previous) / 1000)); previous = now;
      const state = playback.current;
      if (state.sceneReady && !state.paused && !state.blocked && !state.waitingForChoice && !state.audioError && !state.ended && state.chapter) {
        const current = positionRef.current;
        const local = current - state.chapter.start;
        const audio = voice.current;
        const voiceEnd = state.chapter.audioDuration || state.chapter.duration;
        const tail = local >= voiceEnd - .025 || Boolean(audio?.ended);
        const voiceReady = state.visualOnly || !state.chapter.audioUrl || tail || Boolean(audio && audio.readyState >= 3 && !audio.paused && !audio.seeking);
        if (voiceReady) {
          let next = current + delta;
          if (audio && state.chapter.audioUrl && !state.visualOnly && !tail && Math.abs(audio.currentTime - local) > .45) next = state.chapter.start + audio.currentTime;
          if (tail && local < voiceEnd) next = state.chapter.start + voiceEnd;
          next = Math.min(next, state.chapter.start + state.chapter.duration, state.duration);
          positionRef.current = next; setPosition(next);
          if (now - lastPersist.current > 1000) {
            try { localStorage.setItem(storageKey(sessionId), String(next)); } catch {}
            lastPersist.current = now;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sessionId]);

  useEffect(() => {
    const savedOverflow = document.body.style.overflow;
    const host = root.current;
    const media = [voice.current, bed.current, transition.current, impact.current];
    document.body.style.overflow = 'hidden'; root.current?.focus({ preventScroll: true }); reveal();
    return () => {
      document.body.style.overflow = savedOverflow; clearTimeout(hideTimer.current);
      try { localStorage.setItem(storageKey(sessionId), String(positionRef.current)); } catch {}
      media.forEach(audio => audio?.pause());
      // StrictMode rehearses effects while the DOM remains mounted. Only detach sources
      // after a real unmount, otherwise its second setup would lose the static sound bed.
      queueMicrotask(() => { if (!host?.isConnected) media.forEach(audio => { if (audio) { audio.removeAttribute('src'); audio.load(); } }); });
    };
  }, [sessionId, reveal]);

  return <section className={`derivative-film film-theme-${sceneTheme}${shown || paused || blocked || ended ? ' film-controls-visible' : ''}`} data-scene={chapter?.scene} data-beat={presentation?.beatIndex} data-theme={sceneTheme} ref={root} tabIndex={-1} aria-label="Урок: Производная" onPointerMove={() => { keyboardInput.current = false; reveal(); }} onPointerDown={() => { keyboardInput.current = false; reveal(); }}>
    {chapter && <DerivativeScene time={sceneProgress * 60} scene={chapter.scene} progress={sceneProgress} playing={playing && !buffering} onReady={handleSceneReady} />}
    <div className="film-shade" aria-hidden="true" />
    {chapter && <div className="film-presentation" dangerouslySetInnerHTML={{ __html: presentationMarkup(chapter, progress, chapterIndex, manifest!.chapters.length, reducedMotion) }} />}
    <header className="film-header" aria-hidden={!shown && !paused && !ended}>
      <span>Производная</span>
      <div className="film-header-right">
        {!preview && cameraLabel && !cameraError && <span className="film-camera"><i />{cameraLabel}</span>}
        {(preview || onExit) && <button type="button" onClick={preview ? onFinish : onExit} aria-label={preview ? 'Закрыть урок' : 'Свернуть урок'} tabIndex={shown ? 0 : -1}><X size={20} /></button>}
      </div>
    </header>
    {!preview && cameraError && <button className="film-camera-alert" onClick={onRetryCamera} aria-label="Повторить камеру"><RefreshCw size={14} />{cameraLabel || 'Камера недоступна'}</button>}
    {(!manifest || loadError) && <div className="film-center-message" role="status">{loadError ? <><p>{loadError}</p><button onClick={load}>Повторить</button></> : <LoaderCircle className="film-spinner" size={30} aria-label="Загрузка" />}</div>}
    {sceneReady && (blocked || (paused && !busy && !ended)) && !waitingForChoice && <button className="film-big-play" onClick={unlock} aria-label="Продолжить урок"><Play size={30} fill="currentColor" /></button>}
    {waitingForChoice && <div className="film-center-message"><p>Озвучка не готова</p><button onClick={() => { setVisualOnly(true); reveal(); }}>Смотреть без озвучки</button></div>}
    {audioError && <div className="film-center-message"><p>{audioError}</p><button onClick={() => { setAudioError(''); voice.current?.load(); unlock(); }}>Повторить</button></div>}
    {chapter && !sceneReady && <div className="film-buffering" role="status"><LoaderCircle className="film-spinner" size={22} aria-label="Загрузка 3D" /></div>}
    {buffering && playing && !blocked && !waitingForChoice && !audioError && <div className="film-buffering" role="status"><LoaderCircle className="film-spinner" size={22} aria-label="Загрузка озвучки" /></div>}
    {ended && <div className="film-end-tag"><Check size={16} />Урок завершён<button onClick={() => { seek(0); setBlocked(false); if (paused) onResume(); }}><RefreshCw size={15} />Ещё раз</button></div>}
    <div className="film-controls" ref={controls} inert={!(shown || paused || blocked || ended)}>
      <div className="film-seek-line"><span>{clock(position)}</span><input aria-label="Позиция урока" type="range" min={0} max={duration} step={.1} value={Math.min(position, duration)} style={{ '--film-progress': `${clamp(position / duration) * 100}%` } as React.CSSProperties} onChange={event => seek(Number(event.target.value))} /><span>{clock(duration)}</span></div>
      <div className="film-control-row">
        <div className="film-controls-left">
          <button type="button" className="film-play-button" onClick={togglePause} disabled={busy || !manifest || !sceneReady || waitingForChoice || ended} aria-label={paused || blocked ? 'Продолжить' : 'Пауза'}>{paused || blocked ? <Play size={19} fill="currentColor" /> : <Pause size={19} fill="currentColor" />}</button>
          <button type="button" onClick={() => { setMuted(value => !value); reveal(); }} aria-label={muted || volume === 0 ? 'Включить звук' : 'Выключить звук'}>{muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
          <input className="film-volume" aria-label="Громкость" type="range" min={0} max={1} step={.05} value={muted ? 0 : volume} onChange={event => { setVolume(Number(event.target.value)); setMuted(false); reveal(); }} />
          <span className="film-control-title">{chapter?.title}</span>
        </div>
        <div className="film-controls-right">
          {!preview && <button type="button" onClick={onAttendance} className="film-attendance" aria-label="Посещаемость занятия"><Users size={18} />{attendanceCount && <span>{attendanceCount}</span>}</button>}
          <button type="button" onClick={toggleFullScreen} aria-label={fullScreen ? 'Выйти из полного экрана' : 'На весь экран'}>{fullScreen ? <Minimize size={19} /> : <Maximize size={19} />}</button>
          {!preview && <button type="button" className="film-finish" onClick={onFinish} disabled={busy} aria-label="Завершить">Завершить пару<ArrowLeft size={15} /></button>}
        </div>
      </div>
    </div>
    <audio ref={voice} src={chapter?.audioUrl} preload="auto" onPlaying={() => { setBuffering(false); setBlocked(false); }} onCanPlay={() => { setBuffering(false); void playVoice(); }} onWaiting={() => setBuffering(true)} onStalled={() => { if ((voice.current?.readyState || 0) < 3) setBuffering(true); }} onEnded={() => setBuffering(false)} onError={() => { if (chapter?.audioUrl && !visualOnly) { setBuffering(false); setAudioError('Не удалось загрузить озвучку'); } }} />
    {nextChapter?.audioUrl && <audio key={nextChapter.id} src={nextChapter.audioUrl} preload="auto" aria-hidden="true" />}
    <audio ref={bed} src="/cinema/derivative-bed.mp3?v=2" loop preload="auto" onLoadedMetadata={syncBed} />
    <audio ref={transition} src="/cinema/transition.mp3?v=2" preload="auto" />
    <audio ref={impact} src="/cinema/impact.mp3?v=2" preload="auto" />
  </section>;
}
