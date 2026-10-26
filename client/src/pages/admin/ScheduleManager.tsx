import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Film, Loader2, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { api, json } from '../../api';
import { useApp } from '../../context';
import type { LessonCatalogItem, TeachingEvent, UniversityData } from '../../../../shared/types';

const DerivativeFilm = lazy(() => import('../../lesson/DerivativeFilm'));
const GeneratedFilm = lazy(() => import('../../lesson/GeneratedFilm'));
type CatalogItem = LessonCatalogItem;
type ScheduledItem = { id:string; lessonId:string; groupId:string; teacherId:string; startsAt:string; roomId?:string; allDay?:boolean; durationMinutes?:number; date?:string; revision:number; cancelled?:boolean };
type Draft = { lessonId:string; subjectId:string; groupId:string; teacherId:string; from:string; to:string; weekdays:number[]; allDay:boolean; startTime:string; durationMinutes:number; roomId:string };
type Props = { institutionId:string; data:UniversityData; date:string; setDate:(value:string)=>void; mode:'timetable'|'catalog'; onRefresh:()=>Promise<void>; onSemester:(id:string)=>void };
const days = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const statusLabels = { ready:'Готов',drafting:'Готовится сценарий',draft:'Сценарий',generating:'Генерируется',language_review:'Подготовка',failed:'Ошибка' };
const move = (date:string,amount:number) => {const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+amount);return value.toISOString().slice(0,10);};
const weekday = (date:string) => new Date(`${date}T12:00:00Z`).getUTCDay()||7;
const monday = (date:string) => move(date,1-weekday(date));
const label = (date:string,weekday=false) => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{day:'numeric',month:'long',...(weekday?{weekday:'long' as const}:{})});
const localTime = (value:string) => new Date(value).toLocaleTimeString('ru-RU',{timeZone:'Asia/Tashkent',hour:'2-digit',minute:'2-digit'});
const localDate = (value:string) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const lessonCount = (count:number) => `${count} ${count%10===1&&count%100!==11?'занятие':count%10>=2&&count%10<=4&&(count%100<12||count%100>14)?'занятия':'занятий'}`;
const today = () => localDate(new Date().toISOString());

export default function ScheduleManager({institutionId,data,date,setDate,mode,onRefresh,onSemester}:Props) {
  const {notify}=useApp();
  const [catalog,setCatalog]=useState<CatalogItem[]>([]);
  const [scheduled,setScheduled]=useState<ScheduledItem[]>([]);
  const [loading,setLoading]=useState(true),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[subject,setSubject]=useState(''),[group,setGroup]=useState('');
  const [editor,setEditor]=useState<{item?:ScheduledItem;event?:TeachingEvent}|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null),[range,setRange]=useState<'day'|'week'|'range'>('week');
  const [busy,setBusy]=useState(false),[formError,setFormError]=useState('');
  const [detail,setDetail]=useState<TeachingEvent|null>(null),[cancel,setCancel]=useState(false);
  const [preview,setPreview]=useState<string|null>(null),[paused,setPaused]=useState(false);
  const request=useRef(0),dialog=useRef<HTMLElement>(null);
  const week=monday(date),weekDays=Array.from({length:7},(_,i)=>move(week,i));
  const fetchLists=useCallback(async()=>{
    const current=++request.current;setLoading(true);setError('');
    const result=await Promise.allSettled([
      api<CatalogItem[]>(`/lesson-catalog?institutionId=${encodeURIComponent(institutionId)}`),
      api<ScheduledItem[]>(`/schedule/events?institutionId=${encodeURIComponent(institutionId)}&from=${monday(date)}&to=${move(monday(date),6)}&includeCancelled=true`),
    ]);
    if(current!==request.current)return;
    if(result[0].status==='fulfilled')setCatalog(result[0].value);else setError(result[0].reason.message);
    if(result[1].status==='fulfilled')setScheduled(result[1].value);else setError(result[1].reason.message);
    setLoading(false);
  },[institutionId,date]);
  useEffect(()=>{void fetchLists();},[fetchLists]);
  useEffect(()=>{
    const refresh=()=>{if(document.visibilityState==='visible'&&!editor&&!detail&&!preview)void fetchLists();};
    const interval=setInterval(refresh,15_000);
    window.addEventListener('focus',refresh);
    return()=>{clearInterval(interval);window.removeEventListener('focus',refresh);};
  },[fetchLists,editor,detail,preview]);
  const open=!!(editor||detail);
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement as HTMLElement;
    const bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    dialog.current?.querySelector<HTMLElement>('button,input,select')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy)close();
      if(event.key!=='Tab')return;
      const elements=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')||[]).filter(item=>item.offsetParent!==null);
      const first=elements[0],last=elements.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=bodyOverflow;previous?.focus();};
  },[open,busy]);
  function close(){setEditor(null);setDraft(null);setDetail(null);setCancel(false);setFormError('');}
  const names=(kind:'groups'|'subjects'|'teachers'|'rooms',id?:string)=>data[kind].find(item=>item.id===id)?.name||'—';
  const ready=catalog.filter(item=>item.status==='ready');
  const selectedLesson=draft?catalog.find(item=>item.id===draft.lessonId):undefined;
  const filteredCatalog=catalog.filter(item=>(!subject||item.subjectId===subject)&&(!query||`${item.title} ${item.description||''}`.toLowerCase().includes(query.toLowerCase())));
  const events=data.events.filter(item=>item.date===date&&(!group||item.groupId===group)).sort((a,b)=>a.startsAt.localeCompare(b.startsAt));
  const itemFor=(event:TeachingEvent)=>scheduled.find(item=>event.scheduleItemId===item.id||event.id===`schedule:${item.id}:${event.date}`);
  const cancelled=scheduled.filter(item=>item.cancelled&&localDate(item.startsAt)===date&&(!group||item.groupId===group));
  const catalogById=(id:string)=>catalog.find(item=>item.id===id||item.lessonId===id);

  function openCreate(lesson?:CatalogItem){
    const chosen=lesson||ready[0];setDetail(null);setCancel(false);setFormError('');setRange('week');
    setDraft({lessonId:chosen?.id||'',subjectId:chosen?.subjectId||data.subjects[0]?.id||'',groupId:group||data.groups[0]?.id||'',teacherId:data.teachers.find(item=>item.role==='TEACHER'&&item.active)?.id||'',from:date,to:move(date,6),weekdays:[1,2,3,4,5,6,7],allDay:!!chosen?.cinemaId,startTime:'09:00',durationMinutes:chosen?.durationMinutes||80,roomId:''});
    setEditor({});
  }
  function openEdit(event:TeachingEvent){
    const item=itemFor(event);if(!item)return;
    const lesson=catalogById(item.lessonId);setDetail(null);setFormError('');setRange('day');
    setDraft({lessonId:lesson?.id||item.lessonId,subjectId:event.subjectId,groupId:item.groupId,teacherId:item.teacherId,from:event.date,to:event.date,weekdays:[weekday(event.date)],allDay:!!item.allDay,startTime:localTime(item.startsAt),durationMinutes:item.durationMinutes||Math.round((Date.parse(event.endsAt)-Date.parse(event.startsAt))/60000),roomId:item.roomId||''});
    setEditor({item,event});
  }
  function changeRange(value:'day'|'week'|'range'){
    if(!draft)return;setRange(value);setDraft({...draft,to:value==='day'?draft.from:value==='week'?move(draft.from,6):draft.to,weekdays:value==='day'?[weekday(draft.from)]:draft.weekdays});
  }
  function changeLesson(id:string){const lesson=catalog.find(item=>item.id===id);if(draft)setDraft({...draft,lessonId:id,subjectId:lesson?.subjectId||draft.subjectId,allDay:lesson?.cinemaId?draft.allDay:false,durationMinutes:lesson?.durationMinutes||80});}
  async function save(event:FormEvent){
    event.preventDefault();if(!draft||!editor)return;
    if(!draft.weekdays.length){setFormError('Выберите дни недели');return;}
    setBusy(true);setFormError('');
    try{
      const common={lessonId:draft.lessonId,groupId:draft.groupId,teacherId:draft.teacherId,allDay:draft.allDay,startTime:draft.startTime,durationMinutes:draft.durationMinutes,roomId:draft.roomId||null,subjectId:draft.subjectId};
      if(editor.item){await api(`/schedule/events/${encodeURIComponent(editor.item.id)}`,json('PATCH',{...common,date:draft.from,revision:editor.item.revision}));notify('Занятие сохранено','success');}
      else {const result=await api<{created:ScheduledItem[];skipped:ScheduledItem[]}>('/schedule/events',json('POST',{...common,institutionId,from:draft.from,to:draft.to,weekdays:draft.weekdays}));notify(result.created.length?`Добавлено занятий: ${result.created.length}${result.skipped.length?` · уже были: ${result.skipped.length}`:''}`:'Занятия уже есть в расписании','success');}
      const next=draft.from;close();
      if(next!==date)setDate(next);
      else {await onRefresh();await fetchLists();}
    }catch(cause){setFormError((cause as Error).message);}finally{setBusy(false);}
  }
  async function cancelEvent(){
    if(!detail)return;const item=itemFor(detail);if(!item)return;setBusy(true);setFormError('');
    try{await api(`/schedule/events/${encodeURIComponent(item.id)}?revision=${item.revision}`,json('DELETE',{}));close();notify('Занятие отменено','success');await onRefresh();await fetchLists();}
    catch(cause){setFormError((cause as Error).message);}finally{setBusy(false);}
  }
  function showPreview(cinemaId='derivative'){setPaused(false);setPreview(cinemaId);}
  const datesCount=draft?Array.from({length:Math.max(0,Math.min(366,Math.floor((Date.parse(draft.to)-Date.parse(draft.from))/86400000)+1))},(_,i)=>move(draft.from,i)).filter(day=>draft.weekdays.includes(weekday(day))).length:0;
  return <>
    {mode==='catalog'?<>
      <div className="ua-catalog-toolbar"><label className="ua-search"><Search size={17}/><input aria-label="Найти 3D-урок" placeholder="Найти урок" value={query} onChange={event=>setQuery(event.target.value)}/></label><select className="ua-filter" aria-label="Дисциплина уроков" value={subject} onChange={event=>setSubject(event.target.value)}><option value="">Все дисциплины</option>{data.subjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><span className="ua-small-label">{filteredCatalog.length} уроков</span></div>
      <div className="ua-catalog-grid">{filteredCatalog.map(item=><article className={`ua-lesson-card ${item.status==='ready'?'ready':''}`} key={item.id}>
        <div className="ua-lesson-cover" aria-hidden="true"><span className="ua-cover-grid"/><span className="ua-cover-orbit"/><span className="ua-cover-equation">{item.cinemaId?'ƒ′':'ƒ'}</span><span className="ua-cover-label">{item.cinemaId?'3D / MOTION':'AI / LESSON'}</span><Film size={22}/></div>
        <div className="ua-lesson-card-body"><div className="ua-lesson-meta"><span>{names('subjects',item.subjectId)}</span><span className={`ua-status ${item.status==='ready'?'lime':''}`}>{statusLabels[item.status]}</span></div><h2>{item.title}</h2>{item.description&&<p>{item.description}</p>}<div className="ua-lesson-duration"><Clock3 size={14}/>{Math.round(item.durationMinutes)} мин</div><footer>{item.status==='ready'&&item.cinemaId&&<button className="ua-button" onClick={()=>showPreview(item.cinemaId)}><Play size={15} fill="currentColor"/>Смотреть</button>}<button className="ua-button lime" disabled={item.status!=='ready'} onClick={()=>openCreate(item)}><CalendarDays size={15}/>В расписание</button></footer></div>
      </article>)}</div>
      {!loading&&!filteredCatalog.length&&<div className="ua-empty"><Film size={26}/><p>{query||subject?'Уроки не найдены':'Готовых уроков пока нет'}</p></div>}
    </>:<>
      <div className="ua-calendar-toolbar"><div className="ua-date-control"><button className="ua-icon" aria-label="Предыдущая неделя" onClick={()=>setDate(move(date,-7))}><ChevronLeft size={17}/></button><label><CalendarDays size={16}/><input type="date" aria-label="Дата расписания" value={date} onChange={event=>event.target.value&&setDate(event.target.value)}/></label><button className="ua-icon" aria-label="Следующая неделя" onClick={()=>setDate(move(date,7))}><ChevronRight size={17}/></button><button className="ua-date-today" onClick={()=>setDate(today())}>Сегодня</button></div><select className="ua-filter" aria-label="Группа расписания" value={group} onChange={event=>setGroup(event.target.value)}><option value="">Все группы</option>{data.groups.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="ua-button lime" onClick={()=>openCreate()}><Plus size={17}/>Добавить занятие</button></div>
      <section className="ua-panel ua-calendar-panel"><div className="ua-calendar-week" aria-label="Неделя расписания">{weekDays.map(day=><button key={day} className={`${date===day?'active':''} ${day===today()?'today':''}`} aria-label={label(day,true)} aria-pressed={date===day} onClick={()=>setDate(day)}><span>{days[weekday(day)-1]}</span><strong>{Number(day.slice(-2))}</strong><small>{new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU',{month:'short'})}</small></button>)}</div><div className="ua-panel-title ua-calendar-day-title"><h2>{label(date)}</h2><span className="ua-small-label">{lessonCount(events.length)} · Ташкент</span></div><div className="ua-event-list">{events.map(event=><button className="ua-event" key={event.id} data-schedule-event-id={event.id} onClick={()=>{setDetail(event);setCancel(false);setFormError('');}}><div className={`ua-event-time ${event.allDay?'all-day':''}`}><strong>{event.allDay?'Весь день':localTime(event.startsAt)}</strong><small>{event.allDay?'24 часа':localTime(event.endsAt)}</small></div><span className="ua-event-line ua-tone-1"/><div className="ua-event-content"><span>{names('subjects',event.subjectId)}</span><strong>{event.topic.title}</strong><small>{names('teachers',event.teacherId)}</small></div><div className="ua-event-place"><span>{names('groups',event.groupId)}</span><small>{names('rooms',event.roomId)}</small></div><span className="ua-status">{event.cinemaId?'3D-урок':'Занятие'}</span><ArrowRight size={16}/></button>)}</div>{!events.length&&<div className="ua-calendar-empty"><CalendarDays size={28}/><p>Занятий нет</p><button className="ua-text-button" onClick={()=>openCreate()}>Добавить занятие <Plus size={14}/></button></div>}{!!cancelled.length&&<details className="ua-cancelled-events"><summary>Отменённые · {cancelled.length}</summary>{cancelled.map(item=><div key={item.id}><span>{catalogById(item.lessonId)?.title||'Урок'}</span><small>{names('groups',item.groupId)} · {item.allDay?'Весь день':localTime(item.startsAt)}</small></div>)}</details>}</section>
    </>}
    {loading&&!catalog.length&&<div className="ua-loading"><Loader2 className="ua-spin" size={22}/></div>}
    {error&&<div className="ua-error" role="alert">{error}<button className="ua-text-button" onClick={()=>void fetchLists()}>Повторить</button></div>}
    {open&&<div className="ua-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close();}}><section className="ua-drawer" role="dialog" aria-modal="true" aria-labelledby="ua-calendar-dialog-title" ref={dialog}><header><h2 id="ua-calendar-dialog-title">{editor?(editor.item?'Изменить занятие':'Добавить занятие'):cancel?'Отменить занятие?':'Занятие'}</h2><button className="ua-icon" aria-label="Закрыть" onClick={close} disabled={busy}><X size={21}/></button></header><div className="ua-drawer-body">
      {editor&&draft?<form id="ua-schedule-form" onSubmit={save}>
        <label className="ua-field"><span>Урок</span><select required aria-label="Урок расписания" value={draft.lessonId} onChange={event=>changeLesson(event.target.value)}><option value="">Выбрать урок</option>{ready.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {!!selectedLesson&&!selectedLesson.subjectId&&<label className="ua-field"><span>Дисциплина</span><select required value={draft.subjectId} onChange={event=>setDraft({...draft,subjectId:event.target.value})}><option value="">Выбрать</option>{data.subjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <div className="ua-form-grid"><label className="ua-field"><span>Группа</span><select required aria-label="Группа занятия" value={draft.groupId} onChange={event=>setDraft({...draft,groupId:event.target.value})}><option value="">Выбрать</option>{data.groups.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="ua-field"><span>Преподаватель</span><select required aria-label="Преподаватель занятия" value={draft.teacherId} onChange={event=>setDraft({...draft,teacherId:event.target.value})}><option value="">Выбрать</option>{data.teachers.filter(item=>item.role==='TEACHER'&&item.active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
        {!editor.item&&<div className="ua-schedule-range" aria-label="Повтор занятия">{[{id:'day',label:'Один день'},{id:'week',label:'Неделя'},{id:'range',label:'Период'}].map(item=><button type="button" key={item.id} className={range===item.id?'active':''} aria-pressed={range===item.id} onClick={()=>changeRange(item.id as typeof range)}>{item.label}</button>)}</div>}
        <div className="ua-form-grid"><label className="ua-field"><span>{range==='day'?'Дата':'С'}</span><input type="date" aria-label="Начало периода" required value={draft.from} onChange={event=>{if(event.target.value)setDraft({...draft,from:event.target.value,to:range==='day'?event.target.value:range==='week'?move(event.target.value,6):draft.to,weekdays:range==='day'?[weekday(event.target.value)]:draft.weekdays});}}/></label>{range!=='day'&&<label className="ua-field"><span>По</span><input type="date" aria-label="Конец периода" required min={draft.from} max={move(draft.from,365)} readOnly={range==='week'} value={draft.to} onChange={event=>{if(event.target.value)setDraft({...draft,to:event.target.value});}}/></label>}</div>
        {range!=='day'&&<div className="ua-schedule-weekdays" aria-label="Дни недели">{days.map((day,i)=><button type="button" key={day} aria-pressed={draft.weekdays.includes(i+1)} className={draft.weekdays.includes(i+1)?'active':''} onClick={()=>setDraft({...draft,weekdays:draft.weekdays.includes(i+1)?draft.weekdays.filter(value=>value!==i+1):[...draft.weekdays,i+1]})}>{day}</button>)}</div>}
        {selectedLesson?.cinemaId&&<label className="ua-all-day-toggle"><div><Clock3 size={19}/><span><strong>Доступ 24 часа</strong><small>Можно смотреть повторно в течение дня</small></span></div><input type="checkbox" aria-label="Доступ 24 часа" checked={draft.allDay} onChange={event=>setDraft({...draft,allDay:event.target.checked})}/><span className="ua-toggle-track" aria-hidden="true"/></label>}
        {!draft.allDay&&<div className="ua-form-grid"><label className="ua-field"><span>Начало</span><input type="time" aria-label="Время занятия" required value={draft.startTime} onChange={event=>setDraft({...draft,startTime:event.target.value})}/></label><label className="ua-field"><span>Длительность, мин</span><input type="number" aria-label="Длительность занятия" min={1} max={720} required value={draft.durationMinutes} onChange={event=>setDraft({...draft,durationMinutes:Number(event.target.value)})}/></label></div>}
        <label className="ua-field"><span>Аудитория</span><select aria-label="Аудитория занятия" value={draft.roomId} onChange={event=>setDraft({...draft,roomId:event.target.value})}><option value="">Без аудитории</option>{data.rooms.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="ua-schedule-summary"><CalendarDays size={17}/><span>{editor.item?label(draft.from):lessonCount(datesCount)}{draft.allDay?' · 24 часа':` · ${draft.startTime}`}</span><small>Asia/Tashkent</small></div>
        {!ready.length&&<p className="ua-hint">Сначала подготовьте урок в библиотеке.</p>}
      </form>:detail&&<div className="ua-event-detail"><span className="ua-status lavender">{names('groups',detail.groupId)}</span><h3>{detail.topic.title}</h3><dl><dt>Преподаватель</dt><dd>{names('teachers',detail.teacherId)}</dd><dt>Дата</dt><dd>{label(detail.date)}</dd><dt>Время</dt><dd>{detail.allDay?'Весь день · 24 часа':`${localTime(detail.startsAt)}–${localTime(detail.endsAt)}`}</dd><dt>Аудитория</dt><dd>{names('rooms',detail.roomId)}</dd></dl>{cancel&&<p className="ua-hint">Посещаемость и история занятия сохранятся.</p>}</div>}
      {formError&&<div className="ua-error" role="alert">{formError}</div>}
    </div><footer className="ua-drawer-footer">{editor?<><button className="ua-button" disabled={busy} onClick={close}>Отмена</button><button className="ua-button lime" disabled={busy||!ready.length||!datesCount} form="ua-schedule-form" type="submit">{busy?<Loader2 size={16} className="ua-spin"/>:<Check size={16}/>}Сохранить занятие</button></>:detail&&cancel?<><button className="ua-button" disabled={busy} onClick={()=>setCancel(false)}>Назад</button><button className="ua-button danger" disabled={busy} onClick={()=>void cancelEvent()}>{busy?<Loader2 size={16} className="ua-spin"/>:<Trash2 size={16}/>}Отменить занятие</button></>:detail?<>{detail.cinemaId&&<button className="ua-button" onClick={()=>{const cinemaId=detail.cinemaId;close();showPreview(cinemaId);}}><Play size={15}/>Смотреть</button>}{itemFor(detail)?<><button className="ua-icon ua-danger-icon" aria-label="Отменить занятие" onClick={()=>setCancel(true)}><Trash2 size={17}/></button><button className="ua-button lime" onClick={()=>openEdit(detail)}><Pencil size={15}/>Изменить занятие</button></>:detail.semesterId?<button className="ua-button lime" onClick={()=>{const id=detail.semesterId!;close();onSemester(id);}}><Pencil size={15}/>Изменить семестр</button>:null}</>:null}</footer></section></div>}
    {preview&&<Suspense fallback={<div className="ua-cinema-loading"><Loader2 size={30} className="ua-spin"/></div>}>{preview.startsWith('generated:')?<GeneratedFilm lessonId={preview.slice('generated:'.length)} onClose={()=>setPreview(null)}/>:<DerivativeFilm preview sessionId="admin-catalog-preview" paused={paused} onPause={()=>setPaused(true)} onResume={()=>setPaused(false)} onFinish={()=>{setPreview(null);void document.exitFullscreen?.().catch(()=>{});}} onAttendance={()=>{}}/>}</Suspense>}
  </>;
}
