import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Maximize, Pause, Play, RotateCcw, Volume2, X } from 'lucide-react';
import type { GeneratedLessonChapter } from '../../../shared/types';
import { api } from '../api';
import { GeneratedScene } from './GeneratedScene';
import GeneratedVideo from './GeneratedVideo';
import './GeneratedFilm.css';

const clock = (time: number) => `${Math.floor(Math.max(0, time) / 60)}:${String(Math.floor(Math.max(0, time)) % 60).padStart(2, '0')}`;
interface FilmManifest { id: string; title: string; summary: string; duration: number; chapters: GeneratedLessonChapter[]; voice: { status: string }; videoUrl?:string; artifact?:{videoUrl:string} }
const indexAt = (lesson: FilmManifest, time: number) => lesson.chapters.reduce((index, chapter, i) => time >= chapter.start ? i : index, 0);

export default function GeneratedFilm({ lessonId, playbackId, onClose }: { lessonId: string; playbackId?: string; onClose: () => void }) {
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLDivElement>(null), audio = useRef<HTMLAudioElement>(null);
  const engine = useRef<GeneratedScene | null>(null);
  const [manifest, setManifest] = useState<FilmManifest | null>(null);
  const [error, setError] = useState(''), [audioError, setAudioError] = useState('');
  const [playing, setPlaying] = useState(false), [ready, setReady] = useState(false), [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0), [volume, setVolume] = useState(1);
  const positionRef = useRef(0), playingRef = useRef(false), lastStore = useRef(0);
  const chapterRef = useRef(0), generation = useRef(0), gap = useRef({ clock: 0, position: 0 });
  const loadGeneration = useRef(0);
  const current = useRef(manifest); current.current = manifest;
  const videoUrl=manifest?.videoUrl||manifest?.artifact?.videoUrl;
  const chapterIndex = manifest ? indexAt(manifest, position) : 0, chapter = manifest?.chapters[chapterIndex];
  const storageKey = `aiteacher:generated:${playbackId || lessonId}:${manifest?.duration || ''}`;
  const publish = useCallback((time: number) => { positionRef.current = time; setPosition(time); engine.current?.renderAt(time); }, []);

  const load = useCallback(() => {
    const token = ++loadGeneration.current; generation.current++; gap.current.clock = 0;
    playingRef.current = false; setPlaying(false); setReady(false); setAudioError(''); audio.current?.pause(); current.current = null; setError(''); setManifest(null);
    api<FilmManifest>(`/generated-lessons/${lessonId}/manifest`).then(data => {
      if (token !== loadGeneration.current) return;
      const movie=data.videoUrl||data.artifact?.videoUrl;
      if(movie){const url=new URL(movie,location.origin);if(url.origin!==location.origin||!/^\/api\/generated-lessons\/[a-f0-9]{32}\/video$/.test(url.pathname)||!Number.isFinite(data.duration)||data.duration<=0)throw new Error('Видео урока недоступно');}
      else if (data.voice?.status !== 'ready' || !data.chapters?.length || !(data.duration > 0) || data.chapters.some(c => !c.audioUrl || !c.audioDuration)) throw new Error('Урок ещё не готов');
      let saved = 0;
      try { saved = Number(localStorage.getItem(`aiteacher:generated:${playbackId || lessonId}:${data.duration}`)) || 0; } catch {}
      if (saved >= data.duration - .1) saved = 0;
      positionRef.current = Math.max(0, Math.min(saved, data.duration)); setPosition(positionRef.current); setManifest(data);
    }).catch(e => { if (token === loadGeneration.current) setError(e.message || 'Не удалось открыть урок'); });
  }, [lessonId, playbackId]);
  useEffect(() => { load(); return () => { loadGeneration.current++; }; }, [load]);
  useEffect(() => {
    if (!manifest || videoUrl || !canvas.current) return;
    setReady(false);
    try { const scene = new GeneratedScene(canvas.current, manifest.chapters); engine.current = scene; scene.renderAt(positionRef.current); setReady(true); }
    catch { setError('Не удалось запустить 3D. Обновите браузер или включите аппаратное ускорение.'); }
    return () => { engine.current?.dispose(); engine.current = null; };
  }, [manifest,videoUrl]);

  const pause = useCallback(() => { playingRef.current = false; setPlaying(false); audio.current?.pause(); setWaiting(false); gap.current.clock = 0; }, []);
  const syncAudio = useCallback(async () => {
    const lesson = current.current, voice = audio.current;
    if (!lesson || lesson.videoUrl || lesson.artifact?.videoUrl || !voice) return;
    const token = ++generation.current, index = indexAt(lesson, positionRef.current), item = lesson.chapters[index]; chapterRef.current = index;
    const offset = Math.max(0, positionRef.current - item.start);
    voice.pause(); gap.current = { clock: 0, position: positionRef.current };
    if (offset >= item.audioDuration!) { gap.current.clock = performance.now(); return; }
    const url = new URL(item.audioUrl!, location.origin).href;
    if (voice.src !== url) { voice.src = item.audioUrl!; voice.load(); }
    setWaiting(playingRef.current);
    const align = () => { if (token === generation.current) voice.currentTime = Math.min(offset, item.audioDuration!); };
    if (voice.readyState >= 1) align(); else voice.addEventListener('loadedmetadata', align, { once: true });
    if (playingRef.current) {
      try { await voice.play(); if (token !== generation.current) return; if (!playingRef.current) voice.pause(); else { setWaiting(false); setAudioError(''); } }
      catch (e) { if (token !== generation.current || (e as DOMException).name === 'AbortError') return; pause(); setAudioError('Нажмите «Продолжить», чтобы включить озвучку.'); }
    }
  }, [pause]);

  const seek = useCallback((time: number) => {
    const lesson = current.current; if (!lesson) return;
    publish(Math.max(0, Math.min(time, lesson.duration))); gap.current.clock = 0;
    setAudioError(''); void syncAudio();
  }, [publish, syncAudio]);
  const play = useCallback(() => {
    if (!ready || !current.current) return;
    if (positionRef.current >= current.current.duration - .05) publish(0);
    playingRef.current = true; setPlaying(true); setAudioError(''); void syncAudio();
  }, [ready, publish, syncAudio]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  useEffect(() => {
    if(videoUrl)return;
    let frame = 0, lastUI = 0;
    const tick = (now: number) => {
      const lesson = current.current, voice = audio.current;
      if (lesson && playingRef.current && voice) {
        const item = lesson.chapters[chapterRef.current]; let time = positionRef.current;
        if (gap.current.clock) time = gap.current.position + (now - gap.current.clock) / 1000;
        else if (!voice.paused && voice.readyState >= 2) time = item.start + Math.min(voice.currentTime, item.audioDuration!);
        if (time >= item.start + item.duration - .015) {
          const next = lesson.chapters[chapterRef.current + 1];
          if (next) { publish(next.start); void syncAudio(); }
          else { publish(lesson.duration); pause(); }
        } else { positionRef.current = time; engine.current?.renderAt(time); if (now - lastUI > 90) { setPosition(time); lastUI = now; } }
        if (now - lastStore.current > 2000) { try { localStorage.setItem(storageKey, String(positionRef.current)); } catch {} lastStore.current = now; }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [pause, publish, syncAudio, storageKey,videoUrl]);
  useEffect(() => {
    if(!manifest||videoUrl)return;
    const before = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
      if (event.code === 'Space') { event.preventDefault(); if (playingRef.current) pause(); else play(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); seek(positionRef.current + 10); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); seek(positionRef.current - 10); }
      if (event.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    window.addEventListener('keydown', key); root.current?.focus();
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', key); };
  }, [onClose, pause, play, seek,manifest,videoUrl]);
  useEffect(() => () => { playingRef.current = false; generation.current++; audio.current?.pause(); }, []);

  if(manifest&&videoUrl)return <GeneratedVideo lessonId={lessonId} playbackId={playbackId} title={manifest.title} duration={manifest.duration} chapters={manifest.chapters||[]} videoUrl={videoUrl} onClose={onClose}/>;
  return <section className={`generated-film ${chapter?.palette === 'light' ? 'generated-film-light' : ''}`} ref={root} role="dialog" aria-modal="true" aria-label={manifest?.title || '3D-урок'} tabIndex={-1}>
    <div className="generated-film-canvas" ref={canvas} />
    <audio ref={audio} preload="metadata" data-testid="generated-voice" onWaiting={() => { if (playingRef.current) setWaiting(true); }} onPlaying={() => setWaiting(false)} onEnded={() => { const item = current.current?.chapters[chapterRef.current]; if (item) gap.current = { clock: performance.now(), position: item.start + item.audioDuration! }; setWaiting(false); }} onError={() => { pause(); setAudioError('Не удалось загрузить озвучку. Попробуйте продолжить.'); }} />
    <header className="generated-film-header"><div><span>AI TEACHER / 3D</span><strong>{manifest?.title || 'Загрузка урока'}</strong></div><button aria-label="Закрыть урок" onClick={() => { pause(); onClose(); }}><X size={22}/></button></header>
    {error ? <div className="generated-film-state"><p role="alert">{error}</p><button onClick={load}><RotateCcw size={18}/> Повторить</button></div> : !ready ? <div className="generated-film-state"><LoaderCircle className="spin" size={32}/></div> : <>
      <div className="generated-film-copy"><span>{String(chapterIndex + 1).padStart(2, '0')} / {String(manifest!.chapters.length).padStart(2, '0')}</span><h1>{chapter?.headline}</h1>{chapter?.formula && <p className="generated-formula">{chapter.formula}</p>}</div>
      {chapter?.example && <aside className="generated-film-example">{chapter.example}</aside>}
      {(!playing || audioError) && <div className="generated-film-state generated-film-start">{audioError && <p role="alert">{audioError}</p>}<button onClick={play}><Play fill="currentColor" size={22}/>{position >= manifest!.duration - .05 ? 'Смотреть ещё раз' : position > 0 ? 'Продолжить' : 'Смотреть урок'}</button></div>}
      {waiting && playing && <div className="generated-film-buffer"><LoaderCircle className="spin" size={22}/> Загрузка звука</div>}
      <footer className="generated-film-controls"><input className="generated-film-seek" type="range" min={0} max={manifest!.duration} step={.1} value={position} onChange={e => seek(Number(e.target.value))} aria-label="Позиция урока"/><div><button aria-label={playing ? 'Пауза' : 'Воспроизвести'} onClick={playing ? pause : play}>{playing ? <Pause/> : <Play/>}</button><span className="generated-film-clock">{clock(position)} / {clock(manifest!.duration)}</span><select aria-label="Глава урока" value={chapterIndex} onChange={e => seek(manifest!.chapters[Number(e.target.value)].start)}>{manifest!.chapters.map((c, i) => <option key={c.id} value={i}>{i + 1}. {c.title}</option>)}</select><label className="generated-film-volume"><Volume2 size={18}/><input type="range" min={0} max={1} step={.05} value={volume} onChange={e => setVolume(Number(e.target.value))} aria-label="Громкость"/></label><button aria-label="Полный экран" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void root.current?.requestFullscreen().catch(() => {}); }}><Maximize/></button></div></footer>
    </>}
  </section>;
}
