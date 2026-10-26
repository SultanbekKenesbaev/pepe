import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Maximize, Play, RotateCcw, X } from 'lucide-react';
import type { GeneratedLessonChapter } from '../../../shared/types';
import './GeneratedVideo.css';

interface Props{lessonId:string;playbackId?:string;title:string;duration:number;chapters:GeneratedLessonChapter[];videoUrl:string;onClose:()=>void}
export default function GeneratedVideo({lessonId,playbackId,title,duration,chapters,videoUrl,onClose}:Props){
  const root=useRef<HTMLElement>(null),video=useRef<HTMLVideoElement>(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  const [playing,setPlaying]=useState(false),[ready,setReady]=useState(false),[waiting,setWaiting]=useState(false);
  const [position,setPosition]=useState(0),[error,setError]=useState('');
  const restored=useRef(false),lastSave=useRef(0),positionRef=useRef(0);
  const storageKey=`aiteacher:generated:${playbackId||lessonId}:${duration}`;
  const chapterIndex=chapters.reduce((index,chapter,i)=>position>=chapter.start?i:index,0);
  const save=useCallback((time:number)=>{
    if(!Number.isFinite(time))return;
    positionRef.current=time;
    try{localStorage.setItem(storageKey,String(time>=duration-.15?0:Math.max(0,Math.min(time,duration))));}catch{}
  },[storageKey,duration]);
  const play=useCallback(async()=>{
    const media=video.current;if(!media)return;
    if(media.ended||media.currentTime>=duration-.1)media.currentTime=0;
    try{await media.play();setError('');}catch{/* Browser autoplay restrictions leave native controls and the play button available. */}
  },[duration]);
  const close=useCallback(()=>{
    const media=video.current;if(media){if(restored.current)save(media.currentTime);media.pause();}
    if(document.fullscreenElement&&root.current?.contains(document.fullscreenElement))void document.exitFullscreen().catch(()=>{});
    closeRef.current();
  },[save]);
  const onMetadata=()=>{
    const media=video.current;if(!media)return;
    if(!restored.current){
      let saved=0;try{saved=Number(localStorage.getItem(storageKey))||0;}catch{}
      if(!Number.isFinite(saved)||saved>=duration-.15)saved=0;
      const target=Math.max(0,Math.min(saved,Number.isFinite(media.duration)?media.duration:duration));
      try{media.currentTime=target;}catch{}
      positionRef.current=target;setPosition(target);restored.current=true;
    }
    setReady(true);void play();
  };
  const seek=(time:number)=>{const media=video.current;if(!media||!ready)return;media.currentTime=Math.max(0,Math.min(time,duration));positionRef.current=media.currentTime;setPosition(media.currentTime);save(media.currentTime);};
  useEffect(()=>{
    const media=video.current,previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){if(document.fullscreenElement){event.preventDefault();void document.exitFullscreen().catch(()=>{});}else close();return;}
      if(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLButtonElement||event.target instanceof HTMLVideoElement)return;
      if(event.code==='Space'){event.preventDefault();if(media?.paused)void play();else media?.pause();}
      if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();if(media&&Number.isFinite(media.duration)){media.currentTime=Math.max(0,Math.min(media.duration,media.currentTime+(event.key==='ArrowRight'?10:-10)));save(media.currentTime);}}
    };
    document.addEventListener('keydown',key);root.current?.focus();
    return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=previousOverflow;if(media){if(restored.current)save(media.currentTime);media.pause();}};
  },[close,play,save]);
  return <section className="generated-film generated-video" ref={root} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <video ref={video} className="generated-video-media" src={videoUrl} controls playsInline preload="metadata" aria-label={`Видео урока ${title}`} onLoadedMetadata={onMetadata} onCanPlay={()=>{setWaiting(false);setReady(true);}} onWaiting={()=>setWaiting(true)} onPlaying={()=>{setPlaying(true);setWaiting(false);}} onPlay={()=>setPlaying(true)} onPause={()=>{setPlaying(false);if(video.current&&restored.current)save(video.current.currentTime);}} onEnded={()=>{setPlaying(false);setPosition(duration);save(duration);}} onTimeUpdate={()=>{const media=video.current;if(!media||!restored.current)return;positionRef.current=media.currentTime;setPosition(media.currentTime);if(Date.now()-lastSave.current>1000){lastSave.current=Date.now();save(media.currentTime);}}} onSeeked={()=>{if(video.current){setPosition(video.current.currentTime);save(video.current.currentTime);}}} onError={()=>{setPlaying(false);setWaiting(false);setError('Не удалось загрузить видео. Повторите попытку.');}}/>
    <header className="generated-video-header"><div><span>AI TEACHER</span><strong>{title}</strong></div><div><button aria-label="Полный экран" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});else void root.current?.requestFullscreen().catch(()=>{});}}><Maximize size={19}/></button><button aria-label="Закрыть урок" onClick={close}><X size={21}/></button></div></header>
    {error?<div className="generated-video-message"><p role="alert">{error}</p><button onClick={()=>{if(video.current&&restored.current)save(video.current.currentTime);setError('');setReady(false);restored.current=false;video.current?.load();}}><RotateCcw size={17}/>Повторить</button></div>:!ready||waiting?<div className="generated-video-buffer" role="status"><LoaderCircle size={28} className="spin"/></div>:!playing?<div className="generated-video-start"><button onClick={()=>void play()}><Play size={23} fill="currentColor"/>{position>=duration-.15?'Смотреть ещё раз':position>.1?'Продолжить':'Смотреть урок'}</button></div>:null}
    {chapters.length>1&&<label className="generated-video-chapter"><select aria-label="Глава урока" value={chapterIndex} onChange={event=>seek(chapters[Number(event.target.value)].start)}>{chapters.map((chapter,index)=><option key={chapter.id} value={index}>{index+1}. {chapter.title}</option>)}</select></label>}
  </section>;
}
