import { useState } from 'react';
import { ArrowRight, CalendarDays, Check, Clock3, FileText, FolderOpen, Languages, Play, Plus, RefreshCw, Search, Sparkles } from 'lucide-react';
import type { GeneratedLesson, GeneratedLessonLanguage, GeneratedLessonVideoMode, LessonMaterial, Subject } from '../../../../shared/types';
import { lessonProgressPercent, lessonProgressStage } from './LessonGenerationProgress';

export type LessonLanguage = GeneratedLessonLanguage;
export interface LibraryFilm {
  id:string; title:string; subjectId:string; subjectName?:string; durationSeconds?:number; chapters?:number;
  kind:'builtin'|'generated'; status:'ready'|'draft'|'drafting'|'generating'|'language_review'|'failed';
  materialId?:string; error?:string; createdAt?:string; language?:LessonLanguage; engine?:string; owned?:boolean;
  progress?:GeneratedLesson['progress']; errorCode?:string;
  videoMode?:GeneratedLessonVideoMode;
  publication?:{startsAt?:string|null;endsAt?:string|null;timezone?:string};
}
export interface LegacyLibraryLesson {
  id:string; title:string; subjectId:string; semesterName:string; status:string; content:string;
  files:{id:string;name:string;mime?:string;extractedCharacters?:number}[];
}
interface Props {
  subjects:Subject[]; films:LibraryFilm[]; materials:LessonMaterial[]; legacyLessons:LegacyLibraryLesson[];
  error:string; busy:boolean; timezone?:string;
  onRefresh:()=>void; onUpload:()=>void; onOpenMaterial:(material:LessonMaterial)=>void;
  onOpenLegacy:(lesson:LegacyLibraryLesson)=>void; onWatch:(film:LibraryFilm)=>void;
  onCreate:(material:LessonMaterial)=>void; onOpenDraft:(film:LibraryFilm)=>void; onPublish:(film:LibraryFilm)=>void;
}
export const languageName=(language?:string)=>language==='kaa'?'Каракалпакский':language==='uz'?'Узбекский':'Русский';
export const generationStage=(stage?:string,videoMode?:GeneratedLessonVideoMode)=>({planning:'План урока',script:'Сценарий',review:'Сценарий',voice:'Озвучка',visuals:videoMode==='2d'?'2D-сцены':'3D-сцены',checking:'Проверка урока',language_review:'Продолжение подготовки',ready:'Готов',failed:'Ошибка'}[stage||'']||'Подготовка');
const statusText:Record<LibraryFilm['status'],string>={ready:'Готов',draft:'Сценарий',drafting:'Сценарий',generating:'Создаётся',language_review:'Создаётся',failed:'Ошибка'};
const duration=(seconds?:number)=>seconds?`${Math.round(seconds/60)} мин`:'—';

export default function TeacherLessonLibrary(props:Props){
  const [query,setQuery]=useState('');
  const [language,setLanguage]=useState('');
  const [kind,setKind]=useState<'all'|'ready'|'materials'>('all');
  const matches=(item:{title:string;language?:string})=>(!language||(item.language||'ru')===language)&&item.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
  const films=props.films.filter(item=>matches(item)&&(kind!=='ready'||item.status==='ready'));
  const materials=props.materials.filter(matches);
  const legacy=props.legacyLessons.filter(matches);
  const date=(value?:string)=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:props.timezone||'Asia/Tashkent',day:'numeric',month:'short',year:'numeric'}).format(new Date(value)):'Включён';
  const publication=(film:LibraryFilm)=>{
    if(!film.publication?.startsAt)return '';
    if(film.publication.endsAt&&Date.parse(film.publication.endsAt)<Date.now())return 'Показ завершён';
    if(Date.parse(film.publication.startsAt)>Date.now())return `Показ с ${date(film.publication.startsAt)}`;
    return 'В «Сегодня»';
  };
  return <section className="teach-library" aria-label="Библиотека уроков">
    <div className="teach-library-toolbar"><div className="teach-library-tabs" role="group" aria-label="Тип уроков">{([['all','Все'],['ready','Готовые'],['materials','Материалы']] as const).map(([value,label])=><button key={value} className={kind===value?'active':''} aria-pressed={kind===value} onClick={()=>setKind(value)}>{label}<span>{value==='ready'?props.films.filter(film=>film.status==='ready').length:value==='materials'?props.materials.length+props.legacyLessons.length:props.films.length}</span></button>)}</div><div className="teach-library-find"><label className="teach-library-search"><Search size={16}/><input aria-label="Поиск урока" placeholder="Найти урок" value={query} onChange={event=>setQuery(event.target.value)}/></label><label className="teach-history-language-filter"><Languages size={15}/><select aria-label="Язык уроков" value={language} onChange={event=>setLanguage(event.target.value)}><option value="">Все языки</option><option value="ru">Русский</option><option value="kaa">Каракалпакский</option><option value="uz">Узбекский</option></select></label></div></div>
    {props.error&&<div className="teach-library-error" role="alert"><span>{props.error}</span><button className="teach-button" onClick={props.onRefresh}><RefreshCw size={14}/>Повторить</button></div>}
    {kind!=='materials'&&films.length>0&&<div className="teach-history-list" aria-label="История уроков"><div className="teach-history-columns" aria-hidden="true"><span>Урок</span><span>Язык</span><span>Создан</span><span>Статус</span><span/></div>{films.map(film=>{
      const progress=film.progress,showProgress=film.status==='generating'||film.status==='drafting'||film.status==='language_review';
      const progressLesson=progress?{status:film.status,progress,videoMode:film.videoMode} as GeneratedLesson:null,percent=lessonProgressPercent(progressLesson);
      return <article className={`teach-history-row ${film.status}`} key={film.id} data-film-id={film.id}><div className="teach-history-topic"><span className={`teach-history-icon ${film.kind}`} aria-hidden="true">{film.kind==='builtin'?<span>f′</span>:<Play size={17}/>}</span><div><h2>{film.title}</h2><div className="teach-history-details"><span><Clock3 size={11}/>{duration(film.durationSeconds)}</span><span className="teach-history-mode" aria-label={`Формат: ${film.videoMode==='2d'?'2D':'3D'}`}>{film.videoMode==='2d'?'2D':'3D'}</span>{publication(film)&&<span><CalendarDays size={11}/>{publication(film)}</span>}{showProgress&&<span>{lessonProgressStage(progressLesson)}{progress&&progress.total>1?` · ${progress.completed}/${progress.total}`:''}</span>}</div>{showProgress&&percent!==null&&<div className="teach-history-progress"><span><i style={{width:`${percent}%`}}/></span><small>≈ {percent}%</small></div>}{film.error&&<p className="teach-history-error">{film.error}</p>}</div></div><span className="teach-history-language">{languageName(film.language)}</span><time className="teach-history-date" dateTime={film.createdAt}>{date(film.createdAt)}</time><span className={`teach-status ${film.status}`}>{film.status==='ready'?<Check size={11}/>:showProgress?<RefreshCw size={11} className="spin"/>:null}{statusText[film.status]}</span><div className="teach-history-actions">{film.status==='ready'?<><button className="teach-button lime" aria-label={`Смотреть урок ${film.title}`} onClick={()=>props.onWatch(film)}><Play size={13} fill="currentColor"/>Смотреть</button>{film.kind==='generated'&&film.owned&&<button className="teach-button teach-publication-trigger" aria-label={`Показ урока ${film.title}`} onClick={()=>props.onPublish(film)}><CalendarDays size={14}/>Показ</button>}</>:<button className="teach-button" aria-label={`${film.status==='failed'?'Повторить подготовку':'Открыть подготовку'} ${film.title}`} onClick={()=>props.onOpenDraft(film)}>{film.status==='draft'?'Сценарий':film.status==='failed'?'Повторить':'Открыть'}<ArrowRight size={14}/></button>}</div></article>;
    })}</div>}
    {kind==='materials'&&(materials.length>0||legacy.length>0)&&<div className="teach-history-list teach-material-history" aria-label="Материалы уроков">{materials.map(material=>{
      const film=props.films.find(item=>item.materialId===material.id);
      return <article className="teach-history-row teach-material-row" key={material.id}><div className="teach-history-topic"><span className="teach-history-icon"><FileText size={19}/></span><div><h2>{material.title}</h2><div className="teach-history-details"><span>{material.files.length} файлов</span><span>{material.files[0]?.name}</span></div></div></div><time className="teach-history-date" dateTime={material.createdAt}>{date(material.createdAt)}</time><div className="teach-history-actions"><button className="teach-button" disabled={props.busy} aria-label={`Открыть урок ${material.title}`} onClick={()=>props.onOpenMaterial(material)}>Открыть<ArrowRight size={14}/></button>{!film&&<button className="teach-source-generate" disabled={props.busy||material.extractedCharacters<30} onClick={()=>props.onCreate(material)}><Sparkles size={14}/>Создать 3D-урок</button>}</div></article>;
    })}{legacy.map(lesson=><article className="teach-history-row teach-material-row" key={lesson.id}><div className="teach-history-topic"><span className="teach-history-icon"><FileText size={19}/></span><div><h2>{lesson.title}</h2><div className="teach-history-details"><span>{lesson.semesterName}</span></div></div></div><span className="teach-status">Учебный план</span><div className="teach-history-actions"><button className="teach-button" aria-label={`Открыть урок ${lesson.title}`} onClick={()=>props.onOpenLegacy(lesson)}>Открыть<ArrowRight size={14}/></button></div></article>)}</div>}
    {(kind==='materials'?(!materials.length&&!legacy.length):!films.length)&&<div className="teach-library-empty"><span>{query||language?<Search size={32}/>:<FolderOpen size={35}/>}</span><h2>{query||language?'Ничего не найдено':kind==='materials'?'Материалов пока нет':'Уроков пока нет'}</h2>{!query&&!language&&<button className="teach-button lime" onClick={props.onUpload}><Plus size={17}/>Создать урок</button>}</div>}
  </section>;
}
