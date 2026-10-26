import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, Loader2, X } from 'lucide-react';
import type { GeneratedLesson } from '../../../../shared/types';
import { api, json } from '../../api';

type Publication={startsAt?:string|null;endsAt?:string|null;timezone?:string};
type PublishableLesson=GeneratedLesson&{publication?:Publication};
interface Props{lesson:PublishableLesson;timezone:string;onClose:()=>void;onSaved:(lesson:GeneratedLesson)=>void}
const parts=(date:Date,timezone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
const localInput=(value:string|number,timezone:string)=>{const data=parts(new Date(value),timezone);const get=(key:string)=>data.find(part=>part.type===key)?.value;return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;};
export function zonedInputToISO(value:string,timezone:string){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('Укажите дату и время');
  const [year,month,day,hour,minute]=value.split(/[-T:]/).map(Number);
  const desired=Date.UTC(year,month-1,day,hour,minute);
  let timestamp=desired;
  for(let attempt=0;attempt<4;attempt++){
    const data=parts(new Date(timestamp),timezone),get=(key:string)=>Number(data.find(part=>part.type===key)?.value);
    const represented=Date.UTC(get('year'),get('month')-1,get('day'),get('hour'),get('minute'));
    const difference=desired-represented;if(!difference)break;timestamp+=difference;
  }
  if(localInput(timestamp,timezone)!==value)throw new Error('Это время недоступно в выбранном часовом поясе');
  return new Date(timestamp).toISOString();
}

export default function LessonPublicationDialog({lesson,timezone:institutionTimezone,onClose,onSaved}:Props){
  const initialTimezone=lesson.publication?.timezone||institutionTimezone;
  const [timezone,setTimezone]=useState(initialTimezone);
  const [mode,setMode]=useState<'now'|'period'|'hidden'>(lesson.publication?.startsAt&&(lesson.publication.endsAt||Date.parse(lesson.publication.startsAt)>Date.now())?'period':'now');
  const [start,setStart]=useState(()=>localInput(lesson.publication?.startsAt||Date.now(),initialTimezone));
  const [end,setEnd]=useState(()=>localInput(lesson.publication?.endsAt||(lesson.publication?.startsAt?Date.parse(lesson.publication.startsAt):Date.now())+86400000,initialTimezone));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLElement>(null);
  const zones=Array.from(new Set([institutionTimezone,initialTimezone,'Asia/Tashkent','Asia/Almaty','Europe/Moscow','UTC']));
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const selector='button:not(:disabled),input:not(:disabled),select:not(:disabled)';
    const frame=requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>(selector)?.focus());
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy)onClose();
      if(event.key!=='Tab')return;
      const fields=Array.from(root.current?.querySelectorAll<HTMLElement>(selector)||[]).filter(item=>item.offsetParent!==null);
      if(event.shiftKey&&document.activeElement===fields[0]){event.preventDefault();fields.at(-1)?.focus();}
      else if(!event.shiftKey&&document.activeElement===fields.at(-1)){event.preventDefault();fields[0]?.focus();}
    };
    document.addEventListener('keydown',key);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',key);previous?.focus();};
  },[busy,onClose]);
  const save=async()=>{
    if(busy)return;setError('');
    let startsAt:string|null=null,endsAt:string|null=null;
    try{
      if(mode==='now')startsAt=new Date().toISOString();
      else if(mode==='period'){startsAt=zonedInputToISO(start,timezone);endsAt=zonedInputToISO(end,timezone);if(Date.parse(endsAt)<=Date.parse(startsAt))throw new Error('Окончание должно быть позже начала');}
      setBusy(true);
      const saved=await api<GeneratedLesson>(`/api/generated-lessons/${encodeURIComponent(lesson.id)}/publication`,json('PATCH',{revision:lesson.revision,startsAt,endsAt,timezone}));
      onSaved(saved);onClose();
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось сохранить показ');}finally{setBusy(false);}
  };
  return <div className="teach-modal-overlay teach-publication-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="teach-dialog teach-publication-dialog" role="dialog" aria-modal="true" aria-labelledby="teach-publication-title" ref={root}><header><span className="teach-publication-symbol"><CalendarDays size={22}/></span><div><h2 id="teach-publication-title">Показ</h2><p>{lesson.title}</p></div><button className="teach-icon-button" aria-label="Закрыть показ" onClick={onClose} disabled={busy}><X size={20}/></button></header><div className="teach-publication-options">{([['now','Сейчас'],['period','Период'],['hidden','Убрать из «Сегодня»']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={mode===value} className={mode===value?'active':''} disabled={busy} onClick={()=>setMode(value)}>{label}</button>)}</div>{mode==='period'&&<div className="teach-publication-period"><div className="teach-form-field"><label htmlFor="publication-start">Начало показа</label><input id="publication-start" type="datetime-local" value={start} onChange={event=>setStart(event.target.value)} disabled={busy}/></div><div className="teach-form-field"><label htmlFor="publication-end">Окончание показа</label><input id="publication-end" type="datetime-local" value={end} onChange={event=>setEnd(event.target.value)} disabled={busy}/></div></div>}{mode!=='hidden'&&<div className="teach-form-field"><label htmlFor="publication-timezone">Часовой пояс</label><select id="publication-timezone" value={timezone} onChange={event=>setTimezone(event.target.value)} disabled={busy}>{zones.map(zone=><option value={zone} key={zone}>{zone==='Asia/Tashkent'?'Ташкент · UTC+5':zone==='UTC'?'UTC':zone}</option>)}</select></div>}{error&&<p className="teach-form-error" role="alert">{error}</p>}<footer><button className="teach-button" disabled={busy} onClick={onClose}>Отмена</button><button className="teach-button lime" disabled={busy||mode==='period'&&(!start||!end)} onClick={()=>void save()}>{busy?<Loader2 size={15} className="spin"/>:<Check size={15}/>}Сохранить показ</button></footer></section></div>;
}
