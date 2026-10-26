import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Clapperboard, Loader2, Play, RefreshCw, Save, Sparkles, Volume2, X } from 'lucide-react';
import type { GeneratedLesson, GeneratedLessonChapter, LessonCatalogItem, LessonMaterial, Subject } from '../../../../shared/types';
import { api, APIError, json } from '../../api';
import { useApp } from '../../context';
import TeacherLessonLibrary, { generationStage, type LegacyLibraryLesson, type LibraryFilm } from './TeacherLessonLibrary';
import LessonPublicationDialog from './LessonPublicationDialog';
import LessonGenerationProgress, { LessonGenerationFailure } from './LessonGenerationProgress';
import './TeacherLessonLibrary.css';

interface Props {
  institutionId:string;
  subjects:Subject[];
  materials:LessonMaterial[];
  legacyLessons:LegacyLibraryLesson[];
  materialsError:string;
  busy:boolean;
  onRefreshMaterials:()=>Promise<void>;
  onUpload:()=>void;
  onOpenMaterial:(material:LessonMaterial)=>void;
  onOpenLegacy:(lesson:LegacyLibraryLesson)=>void;
  onWatch:(cinemaId:string)=>void;
  onCount:(count:number,subjects:number)=>void;
  timezone:string;
  newLesson?:GeneratedLesson|null;
  onPublicationChanged:()=>void;
}
const message=(error:unknown)=>error instanceof Error?`${error.message}${error instanceof APIError&&error.code?` · ${error.code}`:''}`:'Не удалось выполнить действие';
const pending=(lesson:GeneratedLesson)=>lesson.status==='drafting'||lesson.status==='generating'||lesson.status==='language_review';
const sceneNames:Record<GeneratedLessonChapter['scene'],string>={concept:'Идея',chart:'График',process:'Процесс',comparison:'Сравнение',orbit:'Пространство',custom:'Авторская сцена'};

export default function TeacherLibraryWorkspace(props:Props){
  const {user}=useApp();
  const [catalog,setCatalog]=useState<LessonCatalogItem[]>([]);
  const [lessons,setLessons]=useState<GeneratedLesson[]>([]);
  const [error,setError]=useState('');
  const [selected,setSelected]=useState<GeneratedLesson|null>(null);
  const [editing,setEditing]=useState<GeneratedLesson|null>(null);
  const [creating,setCreating]=useState(false);
  const [requestBusy,setRequestBusy]=useState(false);
  const [retryingId,setRetryingId]=useState('');
  const [drawerError,setDrawerError]=useState('');
  const [chapterIndex,setChapterIndex]=useState(0);
  const [saved,setSaved]=useState(false);
  const [valuesText,setValuesText]=useState('');
  const [publicationLesson,setPublicationLesson]=useState<GeneratedLesson|null>(null);
  const mounted=useRef(true);
  const selectedId=useRef('');
  const generationScope=useRef(0);
  const retryInFlight=useRef(false);
  const refreshScope=useRef(0);
  const refreshing=useRef<Promise<void>|null>(null);
  const restored=useRef(false);
  const newLessonOpened=useRef('');
  const progressStorageKey=`lesson-progress:${user.id}:${props.institutionId}`;
  const rootRef=useRef<HTMLElement>(null);
  selectedId.current=selected?.id||'';

  const refresh=useCallback(async()=>{
    if(refreshing.current)return refreshing.current;
    const scope=refreshScope.current;
    const operation=(async()=>{
      const results=await Promise.allSettled([
        api<LessonCatalogItem[]>(`/api/lesson-catalog?institutionId=${encodeURIComponent(props.institutionId)}`),
        api<GeneratedLesson[]>(`/api/generated-lessons?institutionId=${encodeURIComponent(props.institutionId)}`),
      ]);
      if(!mounted.current||scope!==refreshScope.current)return;
      if(results[0].status==='fulfilled')setCatalog(results[0].value);
      if(results[1].status==='fulfilled'){
        const updated=results[1].value;
        const newest=(previous:GeneratedLesson|null)=>{const value=updated.find(lesson=>lesson.id===previous?.id);return value&&(!previous||value.revision>=previous.revision)?value:previous;};
        setLessons(previous=>[
          ...previous.filter(value=>!updated.some(item=>item.id===value.id)&&(pending(value)||value.id===selectedId.current)),
          ...updated.map(value=>{const current=previous.find(item=>item.id===value.id);return current&&current.revision>value.revision?current:value;}),
        ]);
        setSelected(previous=>previous&&pending(previous)?newest(previous):previous);
        setEditing(previous=>previous&&pending(previous)?newest(previous):previous);
        if(!restored.current){
          restored.current=true;
          let id='';try{id=sessionStorage.getItem(progressStorageKey)||'';}catch{}
          const lesson=updated.find(item=>item.id===id);
          if(lesson){setSelected(lesson);setEditing(structuredClone(lesson));}
          else if(id){try{sessionStorage.removeItem(progressStorageKey);}catch{}}
        }
      }
      setError(results.some(result=>result.status==='rejected')?'Не удалось обновить библиотеку':'' );
    })();
    refreshing.current=operation;
    try{await operation;}finally{if(refreshing.current===operation)refreshing.current=null;}
  },[props.institutionId,progressStorageKey]);

  useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;generationScope.current+=1;refreshScope.current+=1;refreshing.current=null;};},[refresh]);
  useEffect(()=>{
    const lesson=props.newLesson;
    if(lesson&&lesson.institutionId===props.institutionId){
      setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);
      if(newLessonOpened.current!==lesson.id){newLessonOpened.current=lesson.id;restored.current=true;acceptLesson(lesson);}
    }
  },[props.newLesson,props.institutionId]);
  useEffect(()=>{
    try{if(selected?.engine==='codex')sessionStorage.setItem(progressStorageKey,selected.id);else if(!selected&&restored.current)sessionStorage.removeItem(progressStorageKey);}catch{}
  },[selected?.id,selected?.engine,progressStorageKey]);
  useEffect(()=>{
    const update=()=>{if(document.visibilityState==='visible')void refresh();};
    const timer=window.setInterval(update,30000);window.addEventListener('focus',update);
    return()=>{clearInterval(timer);window.removeEventListener('focus',update);};
  },[refresh]);
  useEffect(()=>{
    const inProgress=lessons.some(pending)||!!selected&&pending(selected);
    if(!inProgress)return;
    const poll=()=>document.visibilityState==='visible'?refresh():Promise.resolve();
    const timer=window.setInterval(()=>void poll(),5000);
    const onFocus=()=>void poll();
    window.addEventListener('focus',onFocus);
    return()=>{clearInterval(timer);window.removeEventListener('focus',onFocus);};
  },[lessons.some(pending),selected?.id,selected?.status,props.institutionId,refresh]);
  useEffect(()=>{
    const hasDialog=!!selected||creating;
    if(!hasDialog)return;
    const previous=document.activeElement as HTMLElement|null;
    const focusable='button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]';
    const frame=requestAnimationFrame(()=>rootRef.current?.querySelector<HTMLElement>(focusable)?.focus());
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){generationScope.current+=1;setSelected(null);setEditing(null);setCreating(false);}
      if(event.key!=='Tab')return;
      const items=Array.from(rootRef.current?.querySelectorAll<HTMLElement>(focusable)||[]).filter(item=>item.offsetParent!==null);
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
      else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
    };
    document.addEventListener('keydown',onKey);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',onKey);previous?.focus();};
  },[!!selected||creating]);

  const builtinSubject=props.subjects.find(subject=>/математ|анализ/i.test(subject.name));
  const builtin:LibraryFilm={id:'derivative',title:'Производная: скорость изменений',subjectId:builtinSubject?.id||'mathematics',subjectName:builtinSubject?.name||'Математический анализ',durationSeconds:640,chapters:22,kind:'builtin',status:'ready'};
  const asFilm=(lesson:GeneratedLesson):LibraryFilm=>({id:`generated:${lesson.id}`,title:lesson.title,subjectId:lesson.subjectId,durationSeconds:lesson.duration||lesson.targetDuration,chapters:lesson.chapters.length,kind:'generated',status:lesson.status,materialId:lesson.materialId||lesson.materialIds?.[0],error:lesson.error,errorCode:lesson.errorCode,createdAt:lesson.createdAt,language:lesson.language||'ru',engine:lesson.engine,videoMode:lesson.videoMode||'3d',owned:lesson.teacherId===user.id,publication:lesson.publication,progress:lesson.progress});
  const films:LibraryFilm[]=catalog.length?catalog.map(item=>{
    const generated=lessons.find(lesson=>item.cinemaId===`generated:${lesson.id}`||item.id===`generated:${lesson.id}`);
    if(generated)return asFilm(generated);
    return{id:item.cinemaId||item.id,title:item.title,subjectId:item.subjectId,subjectName:props.subjects.find(subject=>subject.id===item.subjectId)?.name,durationSeconds:item.durationMinutes*60,kind:item.cinemaId==='derivative'||item.id==='derivative'?'builtin':'generated',status:item.status,materialId:item.materialId,videoMode:item.videoMode||'3d',language:item.language||'ru',createdAt:item.createdAt,owned:item.teacherId===user.id};
  }):[builtin,...lessons.map(asFilm)];
  // Keep active drafts visible even while the ready-film catalog is refreshing.
  for(const lesson of lessons){if(!films.some(film=>film.id===`generated:${lesson.id}`))films.push(asFilm(lesson));}
  if(!films.some(film=>film.kind==='builtin'))films.unshift(builtin);
  const count=films.length+props.legacyLessons.length;
  const subjects=new Set([...films,...props.materials,...props.legacyLessons].map(item=>item.subjectId)).size;
  useEffect(()=>props.onCount(count,subjects),[count,subjects,props.onCount]);

  const close=()=>{generationScope.current+=1;setSelected(null);setEditing(null);setCreating(false);setDrawerError('');};
  const acceptLesson=(lesson:GeneratedLesson)=>{
    setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);
    setSelected(lesson);setEditing(structuredClone(lesson));setChapterIndex(0);setSaved(false);setDrawerError('');
  };
  const create=async(material:LessonMaterial)=>{
    if(creating||requestBusy)return;
    const scope=++generationScope.current;
    setCreating(true);setDrawerError('');
    try{
      const lesson=await api<GeneratedLesson>(`/api/lesson-materials/${encodeURIComponent(material.id)}/draft`,json('POST',{}));
      if(!mounted.current)return;
      setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);
      if(scope===generationScope.current){acceptLesson(lesson);setCreating(false);}
      void refresh();
    }catch(reason){if(scope===generationScope.current){setDrawerError(message(reason));setCreating(false);setError(message(reason));}}
  };
  const openDraft=async(film:LibraryFilm)=>{
    const id=film.id.replace(/^generated:/,'');
    const known=lessons.find(lesson=>lesson.id===id);
    if(known)acceptLesson(known);
    else {setCreating(true);setDrawerError('');}
    const scope=++generationScope.current;
    try{const lesson=await api<GeneratedLesson>(`/api/generated-lessons/${encodeURIComponent(id)}`);if(mounted.current&&scope===generationScope.current){acceptLesson(lesson);setCreating(false);}}
    catch(reason){if(scope===generationScope.current){setDrawerError(message(reason));setCreating(false);setError(message(reason));}}
  };
  const openPublication=async(film:LibraryFilm)=>{
    try{const lesson=await api<GeneratedLesson>(`/api/generated-lessons/${encodeURIComponent(film.id.replace(/^generated:/,''))}`);if(mounted.current)setPublicationLesson(lesson);}
    catch(reason){setError(message(reason));}
  };
  const updateAutomatic=async(action:'retry')=>{
    if(!selected||requestBusy||retryInFlight.current)return;
    const scope=++generationScope.current;retryInFlight.current=true;
    refreshScope.current+=1;refreshing.current=null;
    setRequestBusy(true);setRetryingId(selected.id);setDrawerError('');
    try{
      const lesson=await api<GeneratedLesson>(`/api/generated-lessons/${encodeURIComponent(selected.id)}/${action}`,json('POST',{revision:selected.revision}));
      if(!mounted.current)return;
      refreshScope.current+=1;refreshing.current=null;
      setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);
      if(scope===generationScope.current)acceptLesson(lesson);
      void refresh();
    }catch(reason){if(mounted.current&&scope===generationScope.current)setDrawerError(message(reason));}
    finally{retryInFlight.current=false;if(mounted.current){setRetryingId('');setRequestBusy(false);}}
  };
  const saveDraft=async(scope=generationScope.current)=>{
    if(!editing||!selected)return null;
    const lesson=await api<GeneratedLesson>(`/api/generated-lessons/${encodeURIComponent(editing.id)}`,json('PATCH',{revision:editing.revision,title:editing.title,summary:editing.summary,chapters:editing.chapters}));
    setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);
    if(mounted.current&&scope===generationScope.current){setSelected(lesson);setEditing(structuredClone(lesson));setSaved(true);}return lesson;
  };
  const save=async()=>{if(requestBusy)return;const scope=++generationScope.current;setRequestBusy(true);setDrawerError('');try{await saveDraft(scope);void refresh();}catch(reason){setDrawerError(message(reason));}finally{setRequestBusy(false);}};
  const generate=async()=>{
    if(requestBusy||!editing)return;const scope=++generationScope.current;setRequestBusy(true);setDrawerError('');
    try{
      const updated=await saveDraft(scope);if(!updated)return;
      const lesson=await api<GeneratedLesson>(`/api/generated-lessons/${encodeURIComponent(updated.id)}/generate`,json('POST',{revision:updated.revision}));
      setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);if(mounted.current&&scope===generationScope.current)acceptLesson(lesson);void refresh();
    }catch(reason){setDrawerError(message(reason));}finally{setRequestBusy(false);}
  };
  const updateChapter=(patch:Partial<GeneratedLessonChapter>)=>{setSaved(false);setEditing(previous=>previous?{...previous,chapters:previous.chapters.map((chapter,index)=>index===chapterIndex?{...chapter,...patch}:chapter)}:previous);};
  const automatic=selected?.engine==='codex';
  const retrying=automatic&&selected.id===retryingId;
  const canEdit=!automatic&&!!selected&&!!editing&&(selected.status==='draft'||selected.status==='failed')&&editing.chapters.length>0;
  const chapter=editing?.chapters[chapterIndex];
  useEffect(()=>setValuesText(chapter?.values.join(' ')||''),[selected?.id,chapterIndex]);
  const invalid=!editing?.title.trim()||!editing?.chapters.length||editing.chapters.some(chapter=>!chapter.title.trim()||chapter.narration.trim().length<10||!chapter.headline.trim()||chapter.labels.some(label=>label.length>100)||chapter.values.some(value=>!Number.isFinite(value)||Math.abs(value)>1000000)||(chapter.scene==='chart'&&(!chapter.labels.length||chapter.labels.length!==chapter.values.length)))||editing.chapters.reduce((sum,item)=>sum+item.narration.length,0)>18000;
  const chartMismatch=chapter?.scene==='chart'&&(!chapter.labels.length||chapter.labels.length!==chapter.values.length);
  const valuesInvalid=chapter?.values.some(value=>!Number.isFinite(value)||Math.abs(value)>1000000);

  return <>
    <TeacherLessonLibrary subjects={props.subjects} films={films} materials={props.materials} legacyLessons={props.legacyLessons} error={props.materialsError||error} busy={props.busy||requestBusy||creating} timezone={props.timezone} onRefresh={()=>{void props.onRefreshMaterials();void refresh();}} onUpload={props.onUpload} onOpenMaterial={props.onOpenMaterial} onOpenLegacy={props.onOpenLegacy} onWatch={film=>props.onWatch(film.id)} onCreate={material=>void create(material)} onOpenDraft={film=>void openDraft(film)} onPublish={film=>void openPublication(film)}/>
    {publicationLesson&&<LessonPublicationDialog lesson={publicationLesson} timezone={props.timezone} onClose={()=>setPublicationLesson(null)} onSaved={lesson=>{setLessons(previous=>[lesson,...previous.filter(item=>item.id!==lesson.id)]);props.onPublicationChanged();void refresh();}}/>}
    {(selected||creating)&&<div className={`teach-drawer-overlay teach-script-overlay ${automatic?'teach-automatic-overlay':''}`} onMouseDown={event=>{if(event.target===event.currentTarget)close();}}><section className="teach-dialog teach-drawer teach-script-drawer" data-generated-lesson-id={selected?.id} role="dialog" aria-modal="true" aria-labelledby="teach-script-title" ref={rootRef}><header><div><span className="teach-drawer-step">{automatic?'10 минут':'Материалы → Сценарий → 3D-урок'}</span><h2 id="teach-script-title">{retrying?'Создание урока':selected?.status==='ready'?'Урок готов':automatic&&selected?.status==='failed'?'Ошибка генерации':automatic?'Создание урока':selected?.status==='generating'?'Подготовка урока':'Сценарий урока'}</h2></div><button className="teach-icon-button" aria-label="Закрыть сценарий" onClick={close}><X size={21}/></button></header><div className="teach-drawer-body">
      {(retrying||creating||selected&&pending(selected))&&automatic?<LessonGenerationProgress lesson={selected} starting={retrying}/>:creating||selected?.status==='drafting'||selected?.status==='generating'?<div className="teach-generation-wait" role="status"><span>{selected?.progress.stage==='voice'?<Volume2 size={32}/>:<Sparkles size={32}/>}</span><h3>{automatic?generationStage(selected?.progress.stage,selected?.videoMode):selected?.status==='generating'?'Озвучка и 3D-сцены':'Создаём сценарий'}</h3><p>{automatic?selected?.title:selected?.status==='generating'?`${selected.progress.completed} / ${selected.progress.total} сцен подготовлено`:'Анализируем ваши материалы'}</p>{automatic&&selected&&selected.progress.total>1&&<p>{selected.progress.completed} / {selected.progress.total}</p>}{selected&&selected.progress.total>0?<div className="teach-generation-progress"><span style={{width:`${Math.min(100,selected.progress.completed/selected.progress.total*100)}%`}}/></div>:<Loader2 size={20} className="spin"/>}<small>Можно закрыть — работа продолжится</small></div>:selected?.status==='ready'?<div className="teach-generation-wait ready"><span><Check size={34}/></span><h3>{selected.title}</h3><p>Сцен: {selected.chapters.length} · {Math.ceil(selected.duration/60)} мин</p><button className="teach-button lime" onClick={()=>{close();props.onWatch(`generated:${selected.id}`);}}><Play size={15} fill="currentColor"/>Смотреть урок<ArrowRight size={15}/></button></div>:<>
        {automatic&&selected?.status==='failed'?<LessonGenerationFailure lesson={selected}/>:selected?.error&&<p className="teach-form-error" role="alert">{selected.error}</p>}
        {canEdit&&editing&&<><div className="teach-script-note"><Clapperboard size={17}/><span>Проверьте текст и сцены перед озвучкой</span></div><div className="teach-form-field"><label htmlFor="generated-lesson-title">Название</label><input id="generated-lesson-title" maxLength={200} value={editing.title} disabled={requestBusy} onChange={event=>{setSaved(false);setEditing({...editing,title:event.target.value});}}/></div><div className="teach-form-field"><label htmlFor="generated-summary">Описание</label><textarea id="generated-summary" rows={2} maxLength={1500} value={editing.summary} disabled={requestBusy} onChange={event=>{setSaved(false);setEditing({...editing,summary:event.target.value});}}/></div><div className="teach-script-chapters" aria-label="Сцены урока">{editing.chapters.map((item,index)=><button key={item.id} aria-label={`Сцена ${index+1}: ${item.title}`} aria-pressed={chapterIndex===index} className={chapterIndex===index?'active':''} onClick={()=>setChapterIndex(index)}><span>{String(index+1).padStart(2,'0')}</span><strong>{item.title}</strong><ChevronDown size={13}/></button>)}</div>{chapter&&<section className="teach-chapter-editor" aria-label={`Редактор сцены ${chapterIndex+1}`}><div className="teach-chapter-editor-heading"><span>Сцена {chapterIndex+1} / {editing.chapters.length}</span><span>{sceneNames[chapter.scene]}</span></div><div className="teach-form-field"><label htmlFor="generated-chapter-title">Тема сцены</label><input id="generated-chapter-title" maxLength={200} value={chapter.title} disabled={requestBusy} onChange={event=>updateChapter({title:event.target.value})}/></div><div className="teach-form-field"><label htmlFor="generated-narration">Озвучка</label><textarea id="generated-narration" rows={7} maxLength={3000} value={chapter.narration} disabled={requestBusy} onChange={event=>updateChapter({narration:event.target.value})}/></div><div className="teach-script-editor-row"><div className="teach-form-field"><label htmlFor="generated-scene">3D-сцена</label><select id="generated-scene" value={chapter.scene} disabled={requestBusy} onChange={event=>updateChapter({scene:event.target.value as GeneratedLessonChapter['scene']})}>{Object.entries(sceneNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></div><div className="teach-form-field"><label htmlFor="generated-palette">Свет</label><select id="generated-palette" value={chapter.palette} disabled={requestBusy} onChange={event=>updateChapter({palette:event.target.value as 'light'|'dark'})}><option value="light">Светлый</option><option value="dark">Тёмный</option></select></div></div><div className="teach-form-field"><label htmlFor="generated-headline">Главная мысль</label><input id="generated-headline" maxLength={160} value={chapter.headline} disabled={requestBusy} onChange={event=>updateChapter({headline:event.target.value})}/></div><div className="teach-form-field"><label htmlFor="generated-formula">Формула</label><input id="generated-formula" maxLength={400} value={chapter.formula||''} disabled={requestBusy} onChange={event=>updateChapter({formula:event.target.value})}/></div><div className="teach-form-field"><label htmlFor="generated-labels">Подписи · по одной на строку</label><textarea id="generated-labels" rows={3} value={chapter.labels.join('\n')} disabled={requestBusy} onChange={event=>updateChapter({labels:event.target.value.split('\n').slice(0,8).map(label=>label.slice(0,100))})}/></div>{(chapter.scene==='chart'||chapter.scene==='comparison')&&<div className="teach-form-field"><label htmlFor="generated-values">Значения · через пробел</label><input id="generated-values" value={valuesText} disabled={requestBusy} onChange={event=>{setValuesText(event.target.value);updateChapter({values:event.target.value.trim()?event.target.value.trim().split(/[\s;,]+/).slice(0,8).map(Number):[]});}}/></div>}<div className="teach-form-field"><label htmlFor="generated-example">Пример из жизни</label><textarea id="generated-example" rows={3} maxLength={800} value={chapter.example||''} disabled={requestBusy} onChange={event=>updateChapter({example:event.target.value})}/></div>{chartMismatch&&<p className="teach-script-validation">У графика должно быть одинаковое число подписей и значений</p>}{valuesInvalid&&<p className="teach-script-validation">Введите числа от −1 000 000 до 1 000 000</p>}</section>}</>}
        {automatic&&selected?.status==='failed'&&<div className="teach-script-retry"><button className="teach-button lime" disabled={requestBusy} onClick={()=>void updateAutomatic('retry')}>{requestBusy?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}Повторить</button></div>}
        {!automatic&&selected?.status==='failed'&&!selected.chapters.length&&<div className="teach-script-retry"><button className="teach-button lime" disabled={requestBusy} onClick={()=>{const material=props.materials.find(item=>item.id===selected.materialId);if(material){close();void create(material);}}}><RefreshCw size={16}/>Создать сценарий заново</button></div>}
      </>}
      {drawerError&&<p className="teach-form-error" role="alert">{drawerError}</p>}
    </div>{canEdit&&<footer><span>{saved?<><Check size={13}/>Сохранено</>:`Сцен: ${editing?.chapters.length||0}`}</span><div><button className="teach-button" disabled={requestBusy||invalid} onClick={()=>void save()}>{requestBusy?<Loader2 size={15} className="spin"/>:<Save size={15}/>}Сохранить</button><button className="teach-button lime" disabled={requestBusy||invalid} onClick={()=>void generate()}>{requestBusy?<Loader2 size={15} className="spin"/>:<Sparkles size={15}/>}Подготовить 3D-урок<ArrowRight size={15}/></button></div></footer>}</section></div>}
  </>;
}
