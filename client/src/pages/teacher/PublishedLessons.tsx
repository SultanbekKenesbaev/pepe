import { useEffect, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import type { GeneratedLesson } from '../../../../shared/types';
import { api } from '../../api';
import { languageName } from './TeacherLessonLibrary';

interface Props{institutionId:string;date:string;timezone:string;refreshRevision:number;onWatch:(cinemaId:string)=>void}
export default function PublishedLessons({institutionId,date,timezone,refreshRevision,onWatch}:Props){
  const [lessons,setLessons]=useState<GeneratedLesson[]>([]),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let cancelled=false,inFlight=false;
    setLessons([]);setError('');
    const load=async()=>{
      if(inFlight||cancelled||document.visibilityState!=='visible')return;inFlight=true;
      try{const rows=await api<GeneratedLesson[]>(`/api/lesson-publications?institutionId=${encodeURIComponent(institutionId)}&date=${date}`);if(!cancelled){setLessons(rows);setError('');}}
      catch(reason){if(!cancelled)setError(reason instanceof Error?reason.message:'Не удалось загрузить показ');}
      finally{inFlight=false;}
    };
    void load();const timer=window.setInterval(()=>void load(),30000);
    const focus=()=>void load();window.addEventListener('focus',focus);
    return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('focus',focus);};
  },[institutionId,date,refreshRevision,attempt]);
  if(error)return <div className="teach-publications-error" role="alert"><span>{error}</span><button className="teach-icon-button" aria-label="Обновить показ уроков" onClick={()=>setAttempt(value=>value+1)}><RefreshCw size={15}/></button></div>;
  if(!lessons.length)return null;
  return <section className="teach-publications" aria-label="Показ уроков"><div className="teach-publications-heading"><span>Показ</span><small>{lessons.length}</small></div>{lessons.map(lesson=><article className="teach-published-row" key={lesson.id} data-publication-lesson-id={lesson.id}><span className="teach-published-icon"><Play size={18}/></span><div><h2>{lesson.title}</h2><span>{languageName(lesson.language)}{lesson.publication?.endsAt&&<> · До {new Intl.DateTimeFormat('ru-RU',{timeZone:lesson.publication.timezone||timezone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(lesson.publication.endsAt))}</>}</span></div><button className="teach-button lime" aria-label={`Смотреть показ ${lesson.title}`} onClick={()=>onWatch(`generated:${lesson.id}`)}><Play size={13} fill="currentColor"/>Смотреть</button></article>)}</section>;
}
