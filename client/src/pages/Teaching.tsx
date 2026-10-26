import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowRight, BookOpen, CalendarDays, Camera, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Clock3, FileText, FolderOpen, Layers3, Loader2, Pause, Play, Plus, RefreshCw, ScanFace, Search, Square, UploadCloud, Users, X } from 'lucide-react';
import type { FaceEnrollment, GeneratedLesson, GeneratedLessonLanguage, GeneratedLessonVideoMode, LessonMaterial, LessonMaterialDetail, TeachingEvent, TeachingSession, UniversityAttendanceStatus, UniversityData } from '../../../shared/types';
import { api, APIError, json, upload } from '../api';
import TeacherLibraryWorkspace from './teacher/TeacherLibraryWorkspace';
import PublishedLessons from './teacher/PublishedLessons';
import LessonVideoModePicker from './teacher/LessonVideoModePicker';
import { useApp } from '../context';
import { scanFaces } from '../face';
import './Teaching.css';
import './TeachingUploadProgress.css';
import type { DerivativeFilmProps } from '../lesson/types';
const DerivativeFilm=lazy(()=>import('../lesson/DerivativeFilm'));
const GeneratedFilm=lazy(()=>import('../lesson/GeneratedFilm'));
const CinematicLesson=(props:DerivativeFilmProps)=><Suspense fallback={<div className="teach-cinema-loading"/>}><DerivativeFilm {...props}/></Suspense>;

type Tab = 'today' | 'lessons' | 'attendance';
type LessonPreview = {id:string; title:string; subjectId:string; files:{id:string;name:string;size?:number;url?:string}[]; documents:{fileId:string;text:string}[]; legacy?:boolean};
type CameraState = 'waiting' | 'opening' | 'scanning' | 'ready' | 'error' | 'unsupported';
const EMPTY:UniversityData={date:'',semesters:[],events:[],sessions:[],groups:[],students:[],subjects:[],rooms:[],teachers:[]};
const STATUS:Record<UniversityAttendanceStatus,string>={present:'Присутствует',late:'Замечен позже',unconfirmed:'Не определён',absent:'Отсутствует',excused:'Уважительная причина'};
const errorText=(error:unknown)=>error instanceof Error?error.message:'Не удалось сохранить';
const pad=(value:number)=>String(value).padStart(2,'0');
const isScheduledFilm=(event:TeachingEvent)=>!!event.allDay&&!!event.cinemaId;
const countWord=(count:number,words:[string,string,string])=>`${count} ${count%100>=11&&count%100<=14?words[2]:count%10===1?words[0]:count%10>=2&&count%10<=4?words[1]:words[2]}`;
const classCount=(count:number)=>`${count} ${count%100>=11&&count%100<=14?'занятий':count%10===1?'занятие':count%10>=2&&count%10<=4?'занятия':'занятий'}`;
function mergeUniversityData(loaded:UniversityData,previous:UniversityData,institutionId:string):UniversityData{
  if(previous.date!==loaded.date)return loaded;
  const existing=new Map(previous.sessions.filter(session=>session.institutionId===institutionId).map(session=>[session.id,session]));
  return {...loaded,sessions:loaded.sessions.map(session=>{const current=existing.get(session.id);return current&&current.revision>session.revision?current:session;})};
}
const clock=(seconds:number)=>`${pad(Math.floor(Math.max(0,seconds)/60))}:${pad(Math.floor(Math.max(0,seconds)%60))}`;
function dateInZone(timezone:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>parts.find(part=>part.type===type)?.value).join('-');}
function offsetDate(date:string,days:number){const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);}
function elapsedSeconds(session:TeachingSession,now:number){return Math.max(0,Math.floor(((session.state==='paused'?new Date(session.pausedAt||session.startedAt).getTime():session.state==='completed'?new Date(session.completedAt||session.startedAt).getTime():now)-new Date(session.startedAt).getTime()-session.pausedMs)/1000));}
function durationSeconds(event:TeachingEvent){return Math.max(0,Math.floor((new Date(event.endsAt).getTime()-new Date(event.startsAt).getTime())/1000));}
const fileSize=(size:number)=>size>1024*1024?`${(size/1024/1024).toFixed(1)} МБ`:`${Math.ceil(size/1024)} КБ`;
function sessionRoster(session:TeachingSession,students:UniversityData['students']){
  const snapshot=(session as TeachingSession&{roster?:{studentId:string;name:string}[]}).roster||[];
  const names=new Map(snapshot.map(student=>[student.studentId,student.name]));
  const ids=Array.from(new Set([...snapshot.map(student=>student.studentId),...session.attendance.map(item=>item.studentId)]));
  return ids.map(id=>({id,name:names.get(id)||students.find(student=>student.id===id)?.name||`Студент ${id}`}));
}

function LabGraphic(){
  return <div className="teach-lab-graphic" aria-hidden="true"><svg viewBox="0 0 600 530" fill="none"><defs>
    <linearGradient id="teach-chrome" x1="140" y1="70" x2="420" y2="400" gradientUnits="userSpaceOnUse"><stop stopColor="#ffffff"/><stop offset=".22" stopColor="#d7dce0"/><stop offset=".46" stopColor="#858f98"/><stop offset=".65" stopColor="#d2d8dd"/><stop offset=".85" stopColor="#ffffff"/><stop offset="1" stopColor="#adb6bd"/></linearGradient>
    <linearGradient id="teach-panel" x1="180" y1="165" x2="460" y2="420" gradientUnits="userSpaceOnUse"><stop stopColor="#ffffff" stopOpacity=".72"/><stop offset="1" stopColor="#e8ecef" stopOpacity=".92"/></linearGradient>
    <radialGradient id="teach-sphere" cx=".32" cy=".22" r=".8"><stop stopColor="#ffffff"/><stop offset=".46" stopColor="#e5eaee"/><stop offset="1" stopColor="#9ca7af"/></radialGradient>
    <filter id="teach-glow"><feGaussianBlur stdDeviation="8"/></filter>
  </defs>
  <g stroke="#7d8c96" strokeOpacity=".18"><path d="m55 355 273-152 237 141-273 157Z"/><path d="m83 372 274-153M116 391l274-153M150 411l274-153M184 431l274-153M219 451l274-153M255 473l274-153M87 337l238 142M122 318l237 142M157 298l237 142M192 279l237 142M227 259l237 142M262 240l237 142M297 220l237 142"/></g>
  <path d="M168 125 420 88 462 348 210 386Z" fill="#e6ebef" stroke="#b9c3ca" strokeOpacity=".4"/>
  <path d="m184 113 252-37 42 260-252 38Z" fill="url(#teach-panel)" stroke="url(#teach-chrome)" strokeWidth="2"/>
  <g stroke="#84959f" strokeOpacity=".13"><path d="m209 181 237-35m-226 98 237-35m-226 98 237-35M247 104l42 260m25-270 42 260m25-270 42 260"/></g>
  <path d="m215 332 235-34M229 339l-34-206" stroke="#95a2ab" strokeOpacity=".55"/>
  <path d="M214 300c48 7 64-60 99-47s58-102 121-111" stroke="#5a97df" strokeWidth="14" opacity=".18" filter="url(#teach-glow)"/>
  <path d="M214 300c48 7 64-60 99-47s58-102 121-111" stroke="#5a97df" strokeWidth="4" strokeLinecap="round"/>
  <path d="m291 298 82-145" stroke="#8c9ba5" strokeWidth="2" strokeDasharray="6 7"/>
  <circle cx="334" cy="223" r="8" fill="#5a97df" stroke="#ffffff" strokeWidth="3"/>
  <ellipse cx="328" cy="414" rx="83" ry="22" fill="#ccd4da" opacity=".3"/>
  <ellipse cx="327" cy="390" rx="70" ry="21" fill="#dce2e6" stroke="#aab7c0"/>
  <path d="M257 373v17c0 12 31 22 70 22s70-10 70-22v-17" fill="url(#teach-chrome)"/>
  <ellipse cx="327" cy="373" rx="70" ry="22" fill="url(#teach-chrome)" stroke="#f7f9fb" strokeOpacity=".6"/>
  <circle cx="327" cy="343" r="36" fill="url(#teach-sphere)"/>
  <g fill="#7b8992" fontFamily="monospace" fontSize="12"><text x="446" y="116">f′(x)</text><text x="465" y="307">x</text><text x="183" y="126">y</text></g>
  <g stroke="#91a1ad" strokeOpacity=".4"><path d="M495 178h14m-7-7v14M124 286h14m-7-7v14"/><path d="M482 369h40v-40M147 111V81h30"/></g>
  </svg></div>;
}

export default function Teaching(){
  const {user,institutionId,institutions,notify}=useApp();
  const [searchParams,setSearchParams]=useSearchParams();
  const institution=institutions.find(item=>item.id===institutionId);
  const timezone=(institution?.settings as {timezone?:string}|undefined)?.timezone||'Asia/Tashkent';
  const [tab,setTab]=useState<Tab>(()=>{try{return sessionStorage.getItem(`lesson-progress:${user.id}:${institutionId}`)?'lessons':'today';}catch{return'today';}});
  const [previewPaused,setPreviewPaused]=useState(false);
  const [generatedClassFilmOpen,setGeneratedClassFilmOpen]=useState(false);
  const [date,setDate]=useState(()=>dateInZone(timezone));
  const [data,setData]=useState<UniversityData>(EMPTY);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [active,setActive]=useState<TeachingSession|null>(null);
  const [attendanceSessionId,setAttendanceSessionId]=useState('');
  const [now,setNow]=useState(Date.now());
  const [drawerOpen,setDrawerOpen]=useState(false);
  const [createStage,setCreateStage]=useState<'uploading'|'processing'|'starting'|null>(null);
  const [uploadPercent,setUploadPercent]=useState<number|null>(0);
  const [lessonTitle,setLessonTitle]=useState('');
  const [lessonLanguage,setLessonLanguage]=useState<GeneratedLessonLanguage>('ru');
  const [lessonVideoMode,setLessonVideoMode]=useState<GeneratedLessonVideoMode>('2d');
  const [createdLesson,setCreatedLesson]=useState<GeneratedLesson|null>(null);
  const [publicationRevision,setPublicationRevision]=useState(0);
  const preparedMaterial=useRef<LessonMaterial|null>(null);
  const createRequestKey=useRef('');
  const createRequestPayload=useRef('');
  const [files,setFiles]=useState<File[]>([]);
  const [materials,setMaterials]=useState<LessonMaterial[]>([]);
  const [materialsError,setMaterialsError]=useState('');
  const [libraryStats,setLibraryStats]=useState<{count:number;subjects:number}|null>(null);
  const updateLibraryCount=useCallback((count:number,subjects:number)=>setLibraryStats(previous=>previous?.count===count&&previous?.subjects===subjects?previous:{count,subjects}),[]);
  const [lessonPreview,setLessonPreview]=useState<LessonPreview|null>(null);
  const [previewLoading,setPreviewLoading]=useState(false);
  const [studentQuery,setStudentQuery]=useState('');
  const [attendanceFilter,setAttendanceFilter]=useState<UniversityAttendanceStatus|'all'>('all');
  const [drawerError,setDrawerError]=useState('');
  const [dragging,setDragging]=useState(false);
  const [finishOpen,setFinishOpen]=useState(false);
  const [cameraState,setCameraState]=useState<CameraState>('waiting');
  const [cameraError,setCameraError]=useState('');
  const [rosterOpen,setRosterOpen]=useState(false);
  const activeRef=useRef<TeachingSession|null>(null);
  const mounted=useRef(true);
  const sessionQueue=useRef<Promise<unknown>>(Promise.resolve());
  const actionInFlight=useRef(false);
  const attendanceMutation=useRef(false);
  const viewScope=useRef('');
  viewScope.current=`${institutionId}:${date}`;
  const scanInProgress=useRef(false);
  const scanGeneration=useRef(0);
  const streamRef=useRef<MediaStream|null>(null);
  const cameraVideo=useRef<HTMLVideoElement>(null);
  const lastScanAttempt=useRef(0);
  const fileInput=useRef<HTMLInputElement>(null);
  const activeBoard=useRef<HTMLDivElement>(null);

  const time=(value:string)=>new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  const prettyDate=(value:string,options:Intl.DateTimeFormatOptions={day:'numeric',month:'long'})=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',...options}).format(new Date(`${value}T12:00:00Z`));
  const groupName=(id:string)=>data.groups.find(item=>item.id===id)?.name||'Группа';
  const subjectName=(id:string)=>data.subjects.find(item=>item.id===id)?.name||'Предмет';
  const roomName=(event:TeachingEvent)=>event.room||data.rooms.find(item=>item.id===event.roomId)?.name;
  const updateSession=useCallback((value:TeachingSession)=>{
    if(!mounted.current)return;
    if(activeRef.current?.id===value.id){if(value.revision<activeRef.current.revision)return;activeRef.current=value;setActive(value);}
    setData(previous=>({...previous,sessions:previous.sessions.some(item=>item.id===value.id)?previous.sessions.map(item=>item.id===value.id&&item.revision<=value.revision?value:item):[value,...previous.sessions]}));
  },[]);
  const stopCamera=useCallback(()=>{scanGeneration.current+=1;streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;if(cameraVideo.current)cameraVideo.current.srcObject=null;},[]);
  const loadData=useCallback(async()=>{
    const scope=`${institutionId}:${date}`;
    const loaded=await api<UniversityData>(`/api/university?institutionId=${encodeURIComponent(institutionId)}&date=${date}`);
    if(mounted.current&&viewScope.current===scope){setData(previous=>mergeUniversityData(loaded,previous,institutionId));setAttendanceSessionId(previous=>loaded.sessions.some(item=>item.id===previous)?previous:loaded.sessions[0]?.id||'');}
    return loaded;
  },[institutionId,date]);
  const loadMaterials=useCallback(async()=>{
    const loaded=await api<LessonMaterial[]>(`/api/lesson-materials?institutionId=${encodeURIComponent(institutionId)}`);
    if(mounted.current){setMaterials(loaded);setMaterialsError('');}
  },[institutionId]);
  useEffect(()=>{let cancelled=false;setMaterials([]);setMaterialsError('');api<LessonMaterial[]>(`/api/lesson-materials?institutionId=${encodeURIComponent(institutionId)}`).then(value=>{if(!cancelled)setMaterials(value);}).catch(reason=>{if(!cancelled)setMaterialsError(errorText(reason));});return()=>{cancelled=true;};},[institutionId]);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;scanGeneration.current+=1;streamRef.current?.getTracks().forEach(track=>track.stop());};},[]);
  useEffect(()=>{let cancelled=false;setLoading(true);setError('');api<UniversityData>(`/api/university?institutionId=${encodeURIComponent(institutionId)}&date=${date}`).then(value=>{if(cancelled)return;setData(previous=>mergeUniversityData(value,previous,institutionId));setAttendanceSessionId(value.sessions[0]?.id||'');}).catch(reason=>{if(!cancelled)setError(errorText(reason));}).finally(()=>{if(!cancelled)setLoading(false);});return ()=>{cancelled=true;};},[institutionId,date]);
  useEffect(()=>{
    if(loading||busy||active||searchParams.get('preview')||!(tab==='today'||tab==='attendance'))return;
    let cancelled=false,inFlight=false;
    const scope=`${institutionId}:${date}`;
    const refresh=async()=>{
      if(cancelled||inFlight||document.visibilityState!=='visible'||actionInFlight.current||attendanceMutation.current||scanInProgress.current)return;
      inFlight=true;
      try{
        const loaded=await api<UniversityData>(`/api/university?institutionId=${encodeURIComponent(institutionId)}&date=${date}`);
        if(cancelled||!mounted.current||viewScope.current!==scope||activeRef.current||actionInFlight.current||attendanceMutation.current||scanInProgress.current)return;
        setData(previous=>mergeUniversityData(loaded,previous,institutionId));
        setAttendanceSessionId(previous=>loaded.sessions.some(session=>session.id===previous)?previous:loaded.sessions[0]?.id||'');
      }catch{/* Keep the last confirmed roster during a background network failure. */}
      finally{inFlight=false;}
    };
    const onFocus=()=>{void refresh();};
    const onVisibility=()=>{if(document.visibilityState==='visible')void refresh();};
    const interval=window.setInterval(onFocus,30000);
    window.addEventListener('focus',onFocus);
    document.addEventListener('visibilitychange',onVisibility);
    void refresh();
    return ()=>{cancelled=true;clearInterval(interval);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onVisibility);};
  },[institutionId,date,tab,active?.id,busy,loading,searchParams]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  useEffect(()=>{stopCamera();activeRef.current=null;setActive(null);setGeneratedClassFilmOpen(false);setDrawerOpen(false);setCreatedLesson(null);preparedMaterial.current=null;setLessonPreview(null);setLibraryStats(null);setStudentQuery('');setAttendanceFilter('all');setDate(dateInZone(timezone));},[institutionId,timezone,stopCamera]);
  useEffect(()=>{
    const id=searchParams.get('session');if(!id)return;let cancelled=false;
    api<TeachingSession>(`/api/teaching-sessions/${encodeURIComponent(id)}`).then(session=>{
      if(cancelled)return;activeRef.current=session;setActive(session);setDate(session.event.date);setAttendanceSessionId(session.id);updateSession(session);
      if(session.scans.at(-1)?.status==='failed'){setCameraState('error');setCameraError(session.scans.at(-1)?.error||'Проверка не выполнена');}
    }).catch(reason=>{if(!cancelled){notify(errorText(reason),'error');setSearchParams({}, {replace:true});}});
    return ()=>{cancelled=true;};
    // Restore only on workspace/institution entry; local starts already set active state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[institutionId]);
  useEffect(()=>{if(active?.state!=='live')stopCamera();},[active?.state,stopCamera]);

  const mutateSession=useCallback((id:string,operation:(current:TeachingSession)=>Promise<TeachingSession>)=>{
    const request=sessionQueue.current.then(async()=>{
      const current=activeRef.current?.id===id?activeRef.current:await api<TeachingSession>(`/api/teaching-sessions/${id}`);
      const updated=await operation(current);updateSession(updated);return updated;
    }).catch(async(reason:unknown)=>{
      if((reason as {status?:number}).status===409){try{updateSession(await api<TeachingSession>(`/api/teaching-sessions/${id}`));}catch{}notify('Данные обновлены. Повторите действие.','error');}
      else notify(errorText(reason),'error');return null;
    });sessionQueue.current=request;return request;
  },[notify,updateSession]);
  const sessionAction=async(action:'pause'|'resume'|'complete')=>{
    const current=activeRef.current;if(!current||actionInFlight.current)return;
    actionInFlight.current=true;setBusy(true);if(action!=='resume')stopCamera();
    try{const updated=await mutateSession(current.id,latest=>api<TeachingSession>(`/api/teaching-sessions/${latest.id}/action`,json('POST',{action,revision:latest.revision})));if(updated){setFinishOpen(false);if(action==='resume')setCameraState('waiting');}}
    finally{actionInFlight.current=false;setBusy(false);}
  };
  const watchFilm=(cinemaId='derivative')=>{stopCamera();setPreviewPaused(false);void document.documentElement.requestFullscreen?.().catch(()=>{});setSearchParams(cinemaId.startsWith('generated:')?{film:cinemaId.slice('generated:'.length)}:{preview:'derivative'});};
  const startClass=async(event:TeachingEvent)=>{
    if(actionInFlight.current)return;if(/производн|дифференц/i.test(event.topic.title))void document.documentElement.requestFullscreen?.().catch(()=>{});actionInFlight.current=true;setBusy(true);setCameraError('');setCameraState(typeof navigator.mediaDevices?.getUserMedia==='function'?'waiting':'unsupported');lastScanAttempt.current=0;
    try{const session=await api<TeachingSession>('/api/teaching-sessions',json('POST',{eventId:event.id,date:event.date,institutionId}));activeRef.current=session;setActive(session);setSearchParams({session:session.id},{replace:true});updateSession(session);setRosterOpen(false);setGeneratedClassFilmOpen(!!event.cinemaId?.startsWith('generated:'));setAttendanceSessionId(session.id);if(session.scans.at(-1)?.status==='failed'){setCameraState('error');setCameraError(session.scans.at(-1)?.error||'Проверка не выполнена');}}
    catch(reason){notify(errorText(reason),'error');}finally{actionInFlight.current=false;setBusy(false);}
  };
  const openSession=async(session:TeachingSession)=>{setGeneratedClassFilmOpen(false);stopCamera();setCameraError('');setCameraState('waiting');try{const fresh=await api<TeachingSession>(`/api/teaching-sessions/${session.id}`);activeRef.current=fresh;setActive(fresh);setSearchParams({session:fresh.id},{replace:true});updateSession(fresh);setAttendanceSessionId(fresh.id);if(fresh.scans.at(-1)?.status==='failed'){setCameraState('error');setCameraError(fresh.scans.at(-1)?.error||'Проверка не выполнена');}}catch(reason){notify(errorText(reason),'error');}};

  const performScan=useCallback(async()=>{
    const initial=activeRef.current;if(!initial||initial.state!=='live'||scanInProgress.current)return;
    scanInProgress.current=true;lastScanAttempt.current=Date.now();const generation=scanGeneration.current;
    let payload:{capturedAt:string;detectedFaces:number;matches:{studentId:string;similarity:number}[];unknownFaces:number;status:'completed'|'failed';error?:string};
    try{
      if(typeof navigator.mediaDevices?.getUserMedia!=='function')throw new Error('Камера недоступна в этом браузере');
      setCameraState('opening');setCameraError('');
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280},height:{ideal:720}}});
      if(generation!==scanGeneration.current||!mounted.current){stream.getTracks().forEach(track=>track.stop());return;}
      streamRef.current=stream;const video=cameraVideo.current;if(!video)throw new Error('Камера недоступна');video.srcObject=stream;await video.play();
      if(video.readyState<2)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Нет изображения с камеры')),10000);video.onloadeddata=()=>{clearTimeout(timer);video.onloadeddata=null;resolve();};});
      if(generation!==scanGeneration.current||activeRef.current?.state!=='live')return;
      setCameraState('scanning');
      const enrollments=await api<FaceEnrollment[]>(`/api/face-enrollments?institutionId=${encodeURIComponent(initial.institutionId)}&groupId=${encodeURIComponent(initial.groupId)}`);
      const result=await scanFaces(video,enrollments);
      if(generation!==scanGeneration.current||activeRef.current?.state!=='live')return;
      payload={...result,capturedAt:new Date().toISOString(),status:'completed'};setCameraState('ready');
    }catch(reason){
      if(generation!==scanGeneration.current||!mounted.current)return;
      const message=reason instanceof DOMException&&reason.name==='NotAllowedError'?'Нет доступа к камере':errorText(reason);setCameraError(message);setCameraState('error');payload={capturedAt:new Date().toISOString(),detectedFaces:0,matches:[],unknownFaces:0,status:'failed',error:message};
    }finally{streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;if(cameraVideo.current)cameraVideo.current.srcObject=null;scanInProgress.current=false;}
    if(generation!==scanGeneration.current||activeRef.current?.id!==initial.id||activeRef.current.state!=='live')return;
    await mutateSession(initial.id,current=>api<TeachingSession>(`/api/teaching-sessions/${current.id}/scans`,json('POST',{...payload,revision:current.revision})));
  },[mutateSession]);
  useEffect(()=>{
    const current=activeRef.current;if(!current||current.state!=='live'||cameraState==='error'||cameraState==='unsupported')return;
    const next=current.scanOffsets[current.scans.filter(scan=>scan.status==='completed').length];if(next===undefined)return;
    if(elapsedSeconds(current,now)>=next&&now-lastScanAttempt.current>=60000)void performScan();
  },[now,active?.id,active?.state,active?.scans.length,cameraState,performScan]);
  useEffect(()=>{
    if(!active||active.state==='completed')return;let cancelled=false;
    const timer=window.setInterval(async()=>{if(actionInFlight.current||scanInProgress.current)return;try{const value=await api<TeachingSession>(`/api/teaching-sessions/${active.id}`);if(!cancelled&&activeRef.current?.id===value.id&&value.revision>=activeRef.current.revision)updateSession(value);}catch{}},15000);
    return ()=>{cancelled=true;clearInterval(timer);};
  },[active?.id,active?.state,updateSession]);

  const openUpload=()=>{setDrawerOpen(true);setFiles([]);setDrawerError('');setLessonTitle('');setLessonLanguage('ru');setLessonVideoMode('2d');preparedMaterial.current=null;createRequestKey.current=crypto.randomUUID();createRequestPayload.current='';};
  const acceptFiles=(incoming:File[])=>{preparedMaterial.current=null;const allowed=incoming.filter(file=>/\.(pdf|docx|txt|csv)$/i.test(file.name));if(allowed.length!==incoming.length)setDrawerError('Форматы: PDF, DOCX, TXT, CSV');else setDrawerError('');setFiles(previous=>{const next=[...previous,...allowed].filter((file,index,list)=>list.findIndex(item=>item.name===file.name&&item.size===file.size)===index);if(next.length>12)setDrawerError('Максимум 12 файлов');return next.slice(0,12);});};
  const saveLesson=async()=>{
    if(!lessonTitle.trim()||busy)return;
    setBusy(true);setDrawerError('');setUploadPercent(0);setCreateStage(files.length&&!preparedMaterial.current?'uploading':'starting');
    try{
      let material=files.length?preparedMaterial.current:null;
      if(files.length&&!material){
        const form=new FormData();files.forEach(file=>form.append('files',file));form.append('institutionId',institutionId);form.append('title',lessonTitle.trim());
        material=await upload<LessonMaterial>('/api/lesson-materials',form,progress=>{setUploadPercent(progress.percent);if(progress.percent===100)setCreateStage('processing');});preparedMaterial.current=material;
        setMaterials(previous=>[material!,...previous.filter(item=>item.id!==material!.id)]);setMaterialsError('');
      }
      setCreateStage('starting');
      const input={institutionId,title:lessonTitle.trim(),language:lessonLanguage,videoMode:lessonVideoMode,materialIds:material?[material.id]:[]};
      const fingerprint=JSON.stringify(input);
      if(createRequestPayload.current&&createRequestPayload.current!==fingerprint)createRequestKey.current=crypto.randomUUID();
      createRequestPayload.current=fingerprint;
      const lesson=await api<GeneratedLesson>('/api/generated-lessons',json('POST',{...input,idempotencyKey:createRequestKey.current}));
      setCreatedLesson(lesson);setDrawerOpen(false);setLibraryStats(null);setTab('lessons');notify('Урок создаётся');
    }catch(reason){setDrawerError(`${errorText(reason)}${reason instanceof APIError&&reason.code?` · ${reason.code}`:''}`);}finally{setBusy(false);setCreateStage(null);}
  };
  const openMaterial=async(material:LessonMaterial)=>{setPreviewLoading(true);try{setLessonPreview(await api<LessonMaterialDetail>(`/api/lesson-materials/${encodeURIComponent(material.id)}`));}catch(reason){notify(errorText(reason),'error');}finally{setPreviewLoading(false);}};
  const updateAttendance=async(session:TeachingSession,studentId:string,status:UniversityAttendanceStatus)=>{if(attendanceMutation.current)return;attendanceMutation.current=true;setBusy(true);try{await mutateSession(session.id,current=>api<TeachingSession>(`/api/teaching-sessions/${current.id}/attendance`,json('PUT',{revision:current.revision,attendance:[{studentId,status}]})));}finally{attendanceMutation.current=false;setBusy(false);}};
  const exportAttendance=(session:TeachingSession)=>{const safe=(value:string)=>`"${/^[=+\-@\t\r]/.test(value)?"'":''}${value.replace(/"/g,'""')}"`;const content='\uFEFF'+[['Студент','Статус','Группа','Занятие'],...sessionRoster(session,data.students).map(student=>[student.name,STATUS[session.attendance.find(item=>item.studentId===student.id)?.status||'unconfirmed'],groupName(session.groupId),session.event.topic.title])].map(row=>row.map(safe).join(';')).join('\r\n');const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`attendance-${session.event.date}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);};

  useEffect(()=>{
    if(!drawerOpen&&!finishOpen&&!lessonPreview&&!rosterOpen)return;const prior=document.activeElement as HTMLElement|null;const select='button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';const dialog=()=>Array.from(document.querySelectorAll<HTMLElement>('.teach-dialog,.teach-cinema-roster')).at(-1);const frame=requestAnimationFrame(()=>dialog()?.querySelector<HTMLElement>(select)?.focus());
    const keyboard=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy){setDrawerOpen(false);setFinishOpen(false);setLessonPreview(null);setRosterOpen(false);}if(event.key==='Tab'){const items=Array.from(dialog()?.querySelectorAll<HTMLElement>(select)||[]).filter(item=>item.offsetParent!==null);if(!items.length)return;if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}}};document.addEventListener('keydown',keyboard);return ()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',keyboard);prior?.focus();};
  },[drawerOpen,finishOpen,lessonPreview,rosterOpen,busy]);

  const sortedEvents=[...data.events].sort((a,b)=>a.startsAt.localeCompare(b.startsAt));
  const liveSession=data.sessions.find(session=>session.state!=='completed');
  const nextEvent=sortedEvents.find(event=>event.id===liveSession?.eventId)||sortedEvents.find(event=>(isScheduledFilm(event)||!data.sessions.some(session=>session.eventId===event.id&&session.state==='completed'))&&new Date(event.endsAt).getTime()>now)||sortedEvents.find(event=>isScheduledFilm(event)||!data.sessions.some(session=>session.eventId===event.id&&session.state==='completed'))||sortedEvents.find(event=>/производн|дифференц/i.test(event.topic.title));
  const replayFilm=!!nextEvent&&/производн|дифференц/i.test(nextEvent.topic.title)&&data.sessions.some(session=>session.eventId===nextEvent.id&&session.state==='completed');
  const selectedAttendance=data.sessions.find(session=>session.id===attendanceSessionId);
  const todaysRoster=new Set([...data.students.filter(student=>sortedEvents.some(event=>event.groupId===student.groupId)).map(student=>student.id),...data.sessions.flatMap(session=>sessionRoster(session,data.students).map(student=>student.id))]);
  const presentToday=new Set(data.sessions.flatMap(session=>session.attendance.filter(item=>item.status==='present'||item.status==='late').map(item=>item.studentId))).size;

  const legacyLessons=data.semesters.flatMap(semester=>semester.topics.map(topic=>({id:`${semester.id}:${topic.id}`,title:topic.title,subjectId:semester.subjectId,semesterName:semester.name,status:semester.status,content:topic.content,files:semester.files})));
  const lessonCount=libraryStats?.count??materials.length+legacyLessons.length+1;
  const librarySubjectCount=libraryStats?.subjects??new Set([...materials,...legacyLessons].map(item=>item.subjectId)).size+1;
  const dayStatuses=data.sessions.flatMap(session=>sessionRoster(session,data.students).map(student=>session.attendance.find(item=>item.studentId===student.id)?.status||'unconfirmed'));
  const dayCounts={present:dayStatuses.filter(status=>status==='present'||status==='late').length,unconfirmed:dayStatuses.filter(status=>status==='unconfirmed').length,absent:dayStatuses.filter(status=>status==='absent').length,excused:dayStatuses.filter(status=>status==='excused').length};

  if(searchParams.get('film')&&!active)return <Suspense fallback={<div className="teach-cinema-loading"/>}><GeneratedFilm lessonId={searchParams.get('film')!} onClose={()=>{void document.exitFullscreen?.().catch(()=>{});setSearchParams({},{replace:true});}}/></Suspense>;
  if(searchParams.get('preview')==='derivative'&&!active)return <CinematicLesson preview sessionId="preview-derivative" paused={previewPaused} onPause={()=>setPreviewPaused(true)} onResume={()=>setPreviewPaused(false)} onFinish={()=>{void document.exitFullscreen?.().catch(()=>{});setSearchParams({},{replace:true});}} onAttendance={()=>{setSearchParams({},{replace:true});setTab('attendance');}}/>;
  if(active)return renderLive(active);
  return <div className="teaching-page">
    <div className="teach-navigation"><nav aria-label="Преподаватель"><button className={tab==='today'?'active':''} onClick={()=>setTab('today')}><CalendarDays size={17}/>Сегодня</button><button className={tab==='lessons'?'active':''} onClick={()=>setTab('lessons')}><BookOpen size={17}/>Уроки</button><button className={tab==='attendance'?'active':''} onClick={()=>setTab('attendance')}><ScanFace size={18}/>Посещаемость</button></nav><button className="teach-button lime" onClick={openUpload}><Plus size={17}/>Создать урок</button></div>
    {loading?<div className="teach-loading"><Loader2 size={25} className="spin"/></div>:error?<div className="teach-error" role="alert"><p>{error}</p><button className="teach-button" onClick={()=>{setError('');setLoading(true);void loadData().catch(reason=>setError(errorText(reason))).finally(()=>setLoading(false));}}><RefreshCw size={16}/>Повторить</button></div>:<>
      {tab==='today'&&<>
        <PublishedLessons institutionId={institutionId} date={date} timezone={timezone} refreshRevision={publicationRevision} onWatch={watchFilm}/>
        <div className="teach-section-heading teach-today-heading"><div className="teach-date-control"><button aria-label="Предыдущий день" onClick={()=>setDate(offsetDate(date,-1))}><ChevronLeft size={17}/></button><label><CalendarDays size={16}/><span>{prettyDate(date,{day:'numeric',month:'long',weekday:'long'})}</span><input aria-label="Дата занятий" type="date" value={date} onChange={event=>{if(event.target.value)setDate(event.target.value);}}/></label><button aria-label="Следующий день" onClick={()=>setDate(offsetDate(date,1))}><ChevronRight size={17}/></button></div><span className="teach-muted-label">{classCount(sortedEvents.length)}</span></div>
        <div className="teach-today-grid"><section className={`teach-main-hero ${!nextEvent?'is-empty':''}`}>
          <LabGraphic/>
          <div className="teach-hero-top"><span className="teach-hero-chip"><span/>{nextEvent?subjectName(nextEvent.subjectId):'Сегодня'}</span><span className="teach-hero-index">{nextEvent?`${pad(sortedEvents.indexOf(nextEvent)+1)} / ${pad(sortedEvents.length)}`:prettyDate(date,{day:'2-digit',month:'2-digit'})}</span></div>
          <div className="teach-hero-content">{nextEvent?<><div className="teach-hero-kicker">{groupName(nextEvent.groupId)}{roomName(nextEvent)&&<> <span> / </span> {roomName(nextEvent)}</>}</div><h2>{nextEvent.topic.title}</h2><div className="teach-hero-time"><Clock3 size={16}/>{nextEvent.allDay?<><strong>Весь день</strong><i/>24 часа</>:<>{time(nextEvent.startsAt)}<span>—</span>{time(nextEvent.endsAt)}<i/>{Math.round(durationSeconds(nextEvent)/60)} мин</>}</div></>:<><div className="teach-hero-kicker">{prettyDate(date,{weekday:'long'})}</div><h2>Свободный<br/>день</h2></>}</div>
          <div className="teach-hero-bottom">{nextEvent?<button className="teach-button lime" disabled={busy} onClick={()=>{if(isScheduledFilm(nextEvent)||replayFilm)watchFilm(nextEvent.cinemaId);else void startClass(nextEvent);}}>{busy?<Loader2 size={18} className="spin"/>:<Play size={17} fill="currentColor"/>}{isScheduledFilm(nextEvent)||replayFilm?'Смотреть урок':liveSession?.eventId===nextEvent.id?'Продолжить занятие':'Начать занятие'}<ArrowRight size={18}/></button>:<button className="teach-button glass" onClick={()=>setTab('lessons')}><BookOpen size={17}/>Мои уроки<ArrowRight size={17}/></button>}<span className="teach-hero-footer-mark">AI TEACHER<span>UNIVERSITY</span></span></div>
        </section><div className="teach-today-sidebar"><aside className="teach-schedule-panel"><div className="teach-panel-title"><h2>Расписание</h2><span>{sortedEvents.length}</span></div><div className="teach-schedule-list">{sortedEvents.length?sortedEvents.map(event=>{const session=data.sessions.find(item=>item.eventId===event.id);const film=isScheduledFilm(event);const isNext=event.id===nextEvent?.id;return <div className={`teach-schedule-item ${isNext?'current':''} ${!film&&session?.state==='completed'?'completed':''}`} data-event-id={event.id} key={event.id}><div className={`teach-schedule-time ${event.allDay?'all-day':''}`}><strong>{event.allDay?'Весь день':time(event.startsAt)}</strong><span>{event.allDay?'24 часа':time(event.endsAt)}</span></div><div className="teach-schedule-line"><span/></div><div className="teach-schedule-content"><span>{subjectName(event.subjectId)}</span><h3>{event.topic.title}</h3><p><Users size={12}/>{groupName(event.groupId)}{roomName(event)&&<><i/> {roomName(event)}</>}</p>{film&&<button className="teach-watch-film" aria-label={`Смотреть урок ${event.topic.title}`} onClick={()=>watchFilm(event.cinemaId)}><Play size={12} fill="currentColor"/>Смотреть урок <ArrowRight size={12}/></button>}{!film&&session?.state==='completed'&&<small><CheckCheck size={12}/>Завершено</small>}{!film&&session&&session.state!=='completed'&&<button onClick={()=>void openSession(session)}>{session.state==='paused'?'На паузе':'Идёт занятие'} <ArrowRight size={12}/></button>}</div></div>;}):<div className="teach-schedule-empty"><CalendarDays size={28}/><span>Занятий нет</span></div>}</div><div className="teach-schedule-footer"><span className="teach-tiny-dot"/>{timezone}</div></aside>
        <button className="teach-library-strip" onClick={()=>setTab('lessons')}><span className="teach-strip-icon"><BookOpen size={22}/></span><span className="teach-strip-copy"><strong>Мои уроки</strong><small>{countWord(lessonCount,['урок','урока','уроков'])}</small></span><ArrowRight size={20}/></button><button className="teach-attendance-strip" onClick={()=>setTab('attendance')} aria-label="Открыть посещаемость"><span className="teach-strip-icon"><ScanFace size={23}/></span><span className="teach-strip-copy"><strong>Посещаемость</strong><small>Подтверждено сегодня</small></span><span className="teach-strip-count">{presentToday}<small>/{todaysRoster.size}</small></span><ArrowRight size={20}/></button></div></div>
      </>}
      <div hidden={tab!=='lessons'}><TeacherLibraryWorkspace key={institutionId} institutionId={institutionId} timezone={timezone} newLesson={createdLesson} onPublicationChanged={()=>setPublicationRevision(value=>value+1)} subjects={data.subjects} materials={materials} legacyLessons={legacyLessons} materialsError={materialsError} busy={busy||previewLoading} onRefreshMaterials={()=>loadMaterials().catch(reason=>setMaterialsError(errorText(reason)))} onUpload={openUpload} onOpenMaterial={material=>void openMaterial(material)} onOpenLegacy={lesson=>setLessonPreview({id:lesson.id,title:lesson.title,subjectId:lesson.subjectId,files:lesson.files.map(file=>({...file,url:`/api/files/${file.id}`})),documents:[{fileId:'topic',text:lesson.content}],legacy:true})} onWatch={watchFilm} onCount={updateLibraryCount}/></div>
      {tab==='attendance'&&<><div className="teach-section-heading"><span className="teach-muted-label">{classCount(data.sessions.length)}</span><label className="teach-attendance-date"><CalendarDays size={16}/><input aria-label="Дата посещаемости" type="date" value={date} onChange={event=>{if(event.target.value)setDate(event.target.value);}}/></label></div>
        <section className="teach-day-attendance" aria-label="Посещаемость за день"><div className="teach-day-attendance-heading"><span>За день</span><strong>{dayCounts.present}<small> / {dayStatuses.length} отметок</small></strong></div><div className="teach-attendance-track" aria-label={`${dayCounts.present} присутствуют, ${dayCounts.unconfirmed} не определены, ${dayCounts.absent} отсутствуют, ${dayCounts.excused} по уважительной причине`}>{(['present','unconfirmed','absent','excused'] as const).map(status=><span key={status} className={status} style={{width:dayStatuses.length?`${dayCounts[status]/dayStatuses.length*100}%`:'0%'}}/>)}</div><div className="teach-day-legend"><span><i className="present"/>Присутствуют <b>{dayCounts.present}</b></span><span><i className="unconfirmed"/>Не определены <b>{dayCounts.unconfirmed}</b></span><span><i className="absent"/>Отсутствуют <b>{dayCounts.absent}</b></span><span><i className="excused"/>Уважительная <b>{dayCounts.excused}</b></span></div></section>
        <section className="teach-attendance-panel"><div className="teach-attendance-toolbar"><select aria-label="Занятие для посещаемости" value={attendanceSessionId} onChange={event=>{setAttendanceSessionId(event.target.value);setStudentQuery('');setAttendanceFilter('all');}}><option value="">Выберите занятие</option>{data.sessions.map(session=><option key={session.id} value={session.id}>{time(session.event.startsAt)} · {groupName(session.groupId)} · {session.event.topic.title}</option>)}</select>{selectedAttendance&&<><button className="teach-button" onClick={()=>void openSession(selectedAttendance)} aria-label="Открыть занятие"><Play size={15}/><span>Занятие</span></button><button className="teach-button" onClick={()=>exportAttendance(selectedAttendance)}><ArrowDownToLine size={15}/>CSV</button></>}</div>{selectedAttendance?renderAttendance(selectedAttendance):<div className="teach-attendance-empty"><ScanFace size={34}/><span>Занятий пока нет</span></div>}</section></>}
    </>}
    {drawerOpen&&renderDrawer()}
    {lessonPreview&&renderLessonPreview(lessonPreview)}
  </div>;

  function renderAttendance(session:TeachingSession,compact=false){
    const roster=sessionRoster(session,data.students);
    const statuses=roster.map(student=>session.attendance.find(item=>item.studentId===student.id)?.status||'unconfirmed');
    const confirmed=statuses.filter(status=>status==='present'||status==='late').length,unconfirmed=statuses.filter(status=>status==='unconfirmed').length,absent=statuses.filter(status=>status==='absent').length,excused=statuses.filter(status=>status==='excused').length;
    const visibleRoster=compact?roster:roster.filter(student=>{const status=session.attendance.find(item=>item.studentId===student.id)?.status||'unconfirmed';return student.name.toLocaleLowerCase('ru').includes(studentQuery.toLocaleLowerCase('ru'))&&(attendanceFilter==='all'||(attendanceFilter==='present'?(status==='present'||status==='late'):status===attendanceFilter));});
    return <><div className="teach-roster-summary"><span><span className="teach-tiny-dot"/>{confirmed} присутствуют</span><span>{unconfirmed} не определены</span>{absent>0&&<span>{absent} отсутствуют</span>}{excused>0&&<span>{excused} уважительная</span>}<span><Camera size={13}/>{session.scans.filter(scan=>scan.status==='completed').length} / {session.scanOffsets.length} проверок</span></div>
      {!compact&&<div className="teach-roster-tools"><label className="teach-student-search"><Search size={16}/><input aria-label="Поиск студента" placeholder="Найти студента" value={studentQuery} onChange={event=>setStudentQuery(event.target.value)}/></label><div className="teach-status-filters" aria-label="Фильтр посещаемости">{([['all','Все',roster.length],['present','Присутствуют',confirmed],['unconfirmed','Не определены',unconfirmed],['absent','Отсутствуют',absent],['excused','Уважительная',excused]] as const).map(([value,label,count])=><button className={attendanceFilter===value?'active':''} key={value} onClick={()=>setAttendanceFilter(value)}>{label}<span>{count}</span></button>)}</div></div>}
      <div className={`teach-roster ${compact?'compact':''}`}>{visibleRoster.map((student,index)=>{const attendance=session.attendance.find(item=>item.studentId===student.id),status=attendance?.status||'unconfirmed';const cameraObserved=attendance?.method==='camera'&&(!!attendance.firstSeenAt||session.scans.some(scan=>scan.status==='completed'&&scan.matches.some(match=>match.studentId===student.id)));return <div className="teach-student-row" key={student.id}><span className="teach-student-index">{pad(index+1)}</span><span className="teach-student-avatar">{student.name.split(' ').slice(0,2).map(word=>word.charAt(0)).join('')}</span><div className="teach-student-name"><strong>{student.name}</strong>{!compact&&<small>{attendance?.reviewed?'Отмечено вручную':cameraObserved?'Камера':groupName(session.groupId)}{attendance?.firstSeenAt&&<> · {time(attendance.firstSeenAt)}</>}</small>}</div><label className={`teach-student-status ${status}`}><span/><select aria-label={`Посещаемость: ${student.name}`} disabled={busy} value={status} onChange={event=>void updateAttendance(session,student.id,event.target.value as UniversityAttendanceStatus)}>{Object.entries(STATUS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12}/></label></div>;})}{!visibleRoster.length&&<div className="teach-attendance-empty"><Users size={28}/><span>{roster.length?'Никого не найдено':'Список группы пуст'}</span></div>}</div></>;
  }

  function renderLive(session:TeachingSession){
    const elapsed=elapsedSeconds(session,now),duration=durationSeconds(session.event),nextScan=session.scanOffsets[session.scans.filter(scan=>scan.status==='completed').length];
    const cameraLabel=session.state==='completed'?'Занятие завершено':session.state==='paused'?'Камера на паузе':cameraState==='opening'?'Включаем камеру':cameraState==='scanning'?'Проверка присутствия':cameraState==='error'?cameraError:cameraState==='unsupported'?'Камера недоступна':nextScan!==undefined?`Камера через ${clock(Math.max(0,nextScan-elapsed))}`:'Проверки завершены';
    const generatedFilmId=session.event.cinemaId?.startsWith('generated:')?session.event.cinemaId.slice('generated:'.length):null;
    if((session.event.cinemaId==='derivative'||!session.event.cinemaId&&/производн|дифференц/i.test(session.event.topic.title))&&session.state!=='completed')return <div className="teach-cinema-session" ref={activeBoard}>
      <CinematicLesson sessionId={session.id} paused={session.state==='paused'} busy={busy} cameraLabel={cameraLabel} cameraError={(cameraState==='error'||cameraState==='unsupported')&&session.state==='live'} attendanceCount={`${session.attendance.filter(item=>item.status==='present'||item.status==='late').length}/${session.attendance.length}`} onPause={()=>void sessionAction('pause')} onResume={()=>void sessionAction('resume')} onFinish={()=>setFinishOpen(true)} onAttendance={()=>setRosterOpen(value=>!value)} onRetryCamera={cameraState==='error'&&session.state==='live'?()=>void performScan():undefined}/>
      <video ref={cameraVideo} className="teach-capture-video" autoPlay playsInline muted aria-hidden="true"/>
      {rosterOpen&&<aside className="teach-cinema-roster" role="dialog" aria-modal="true" aria-label="Посещаемость занятия"><div className="teach-panel-title"><h2>{groupName(session.groupId)}</h2><button className="teach-icon-button" aria-label="Закрыть посещаемость" onClick={()=>setRosterOpen(false)}><X size={20}/></button></div>{renderAttendance(session,true)}</aside>}
      {finishOpen&&<div className="teach-modal-overlay teach-cinema-confirm"><section className="teach-dialog teach-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="finish-teaching-title"><h2 id="finish-teaching-title">Завершить занятие?</h2><div><button className="teach-button" onClick={()=>setFinishOpen(false)}>Отмена</button><button className="teach-button dark" disabled={busy} onClick={()=>{void document.exitFullscreen?.().catch(()=>{});void sessionAction('complete');}}>{busy?<Loader2 size={16} className="spin"/>:null}Завершить</button></div></section></div>}
    </div>;
    return <div className="teach-live" ref={activeBoard}>
      <header className="teach-live-header"><div><span>{subjectName(session.event.subjectId)} <i/> {groupName(session.groupId)}</span><h1>{session.event.topic.title}</h1></div><div className={`teach-camera-pill ${cameraState==='error'||cameraState==='unsupported'?'error':''}`} title={cameraLabel}><Camera size={15}/><span>{cameraLabel}</span>{cameraState==='error'&&session.state==='live'&&<button aria-label="Повторить проверку камеры" onClick={()=>void performScan()}><RefreshCw size={12}/></button>}</div>{generatedFilmId&&session.state!=='completed'&&<button className="teach-button teach-live-film-button" disabled={session.state!=='live'} onClick={()=>setGeneratedClassFilmOpen(true)}><Play size={15}/>Открыть 3D-урок</button>}<button className={`teach-roster-toggle ${rosterOpen?'active':''}`} aria-label="Посещаемость занятия" onClick={()=>setRosterOpen(value=>!value)}><Users size={18}/><span>{session.attendance.filter(item=>item.status==='present'||item.status==='late').length}/{session.attendance.length}</span></button></header>
      <div className={`teach-live-layout ${rosterOpen?'with-roster':''}`}><main className="teach-live-main"><div className="teach-live-board"><div className="teach-board-meta"><span className="teach-board-chip"><span/>{session.state==='paused'?'ПАУЗА':session.state==='completed'?'ЗАВЕРШЕНО':'МАТЕРИАЛ'}</span><span>{session.event.semesterName}</span></div>{session.state==='completed'?<div className="teach-live-complete"><span><CheckCheck size={36}/></span><h2>Занятие завершено</h2><div>{session.attendance.filter(item=>item.status==='present'||item.status==='late').length} присутствуют <i/> {session.attendance.filter(item=>item.status==='unconfirmed').length} не определены</div><button className="teach-button dark" onClick={()=>{stopCamera();activeRef.current=null;setActive(null);setSearchParams({},{replace:true});setTab('attendance');setAttendanceSessionId(session.id);void loadData().catch(reason=>notify(errorText(reason),'error'));}}>К посещаемости <ArrowRight size={17}/></button></div>:<article className="teach-source-content"><span className="teach-source-index">{pad(session.event.topic.order+1)}</span><h2>{session.event.topic.title}</h2><div>{session.event.topic.content.split(/\n\s*\n|\n/).filter(Boolean).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div></article>}<div className="teach-board-grid" aria-hidden="true"/></div><footer className="teach-live-controls"><div className="teach-elapsed"><span className={session.state==='live'?'live':''}/><strong>{clock(elapsed)}</strong><small>/ {clock(duration)}</small></div><div className="teach-live-progress"><span style={{width:`${duration?Math.min(100,elapsed/duration*100):0}%`}}/></div>{session.state!=='completed'&&<div className="teach-live-buttons"><button className="teach-button" disabled={busy} onClick={()=>void sessionAction(session.state==='paused'?'resume':'pause')}>{session.state==='paused'?<Play size={17}/>:<Pause size={17}/ >}{session.state==='paused'?'Продолжить':'Пауза'}</button><button className="teach-button dark" disabled={busy} onClick={()=>setFinishOpen(true)}><Square size={12} fill="currentColor"/>Завершить</button></div>}</footer></main>{rosterOpen&&<aside className="teach-live-roster"><div className="teach-panel-title"><h2>{groupName(session.groupId)}</h2><button className="teach-icon-button" aria-label="Закрыть посещаемость" onClick={()=>setRosterOpen(false)}><X size={17}/></button></div>{renderAttendance(session,true)}</aside>}</div>
      <video ref={cameraVideo} className="teach-capture-video" autoPlay playsInline muted aria-hidden="true"/>
      {generatedFilmId&&generatedClassFilmOpen&&session.state==='live'&&<Suspense fallback={<div className="teach-cinema-loading"/>}><GeneratedFilm lessonId={generatedFilmId} playbackId={session.id} onClose={()=>{void document.exitFullscreen?.().catch(()=>{});setGeneratedClassFilmOpen(false);}}/></Suspense>}
      {finishOpen&&<div className="teach-modal-overlay"><section className="teach-dialog teach-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="finish-teaching-title"><h2 id="finish-teaching-title">Завершить занятие?</h2><div><button className="teach-button" onClick={()=>setFinishOpen(false)}>Отмена</button><button className="teach-button dark" disabled={busy} onClick={()=>void sessionAction('complete')}>{busy?<Loader2 size={16} className="spin"/>:null}Завершить</button></div></section></div>}
    </div>;
  }

  function renderLessonPreview(lesson:LessonPreview){
    return <div className="teach-drawer-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)setLessonPreview(null);}}><section className="teach-dialog teach-drawer teach-lesson-preview" role="dialog" aria-modal="true" aria-labelledby="lesson-preview-title"><header><div><span className="teach-drawer-step">{subjectName(lesson.subjectId)}</span><h2 id="lesson-preview-title">{lesson.title}</h2></div><button className="teach-icon-button" aria-label="Закрыть урок" onClick={()=>setLessonPreview(null)}><X size={21}/></button></header><div className="teach-drawer-body">{!!lesson.files.length&&<div className="teach-preview-files">{lesson.files.map(file=><a href={file.url} target="_blank" rel="noopener noreferrer" key={file.id}><FileText size={19}/><span><strong>{file.name}</strong>{file.size!==undefined&&<small>{fileSize(file.size)}</small>}</span><ArrowDownToLine size={16}/></a>)}</div>}{lesson.documents.map(document=><article className="teach-document-text" key={document.fileId}>{lesson.documents.length>1&&<h3>{lesson.files.find(file=>file.id===document.fileId)?.name}</h3>}<p>{document.text||'Текст не извлечён'}</p></article>)}</div></section></div>;
  }

  function renderDrawer(){
    return <div className="teach-drawer-overlay teach-create-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)setDrawerOpen(false);}}><section className="teach-dialog teach-drawer teach-create-dialog" role="dialog" aria-modal="true" aria-labelledby="lesson-drawer-title"><header><div><span className="teach-drawer-step">10 минут</span><h2 id="lesson-drawer-title">Создать урок</h2></div><button className="teach-icon-button" aria-label="Закрыть создание урока" disabled={busy} onClick={()=>setDrawerOpen(false)}><X size={21}/></button></header><div className="teach-drawer-body">
      <div className="teach-form-field"><label htmlFor="lesson-title">Тема</label><input id="lesson-title" value={lessonTitle} onChange={event=>setLessonTitle(event.target.value)} placeholder="Например, массивы в программировании" maxLength={200} disabled={busy}/></div>
      <LessonVideoModePicker value={lessonVideoMode} onChange={setLessonVideoMode} disabled={busy}/>
      <div className="teach-form-field"><label htmlFor="lesson-language">Язык</label><select id="lesson-language" value={lessonLanguage} onChange={event=>setLessonLanguage(event.target.value as GeneratedLessonLanguage)} disabled={busy}><option value="ru">Русский</option><option value="kaa">Каракалпакский</option><option value="uz">Узбекский</option></select></div>
      <input ref={fileInput} className="teach-hidden-input" type="file" accept=".pdf,.docx,.txt,.csv" multiple aria-label="Материалы урока" onChange={event=>{acceptFiles(Array.from(event.target.files||[]));event.target.value='';}}/><button className={`teach-create-attachment ${dragging?'dragging':''}`} type="button" disabled={busy} onClick={()=>fileInput.current?.click()} onDragOver={event=>{event.preventDefault();if(!busy)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);if(!busy)acceptFiles(Array.from(event.dataTransfer.files));}}><UploadCloud size={21}/><span><strong>Добавить материалы</strong><small>Необязательно · PDF, DOCX, TXT, CSV</small></span><Plus size={17}/></button><div className="teach-upload-files">{files.map((file,index)=><div key={`${file.name}-${file.size}`}><span><FileText size={18}/></span><p><strong>{file.name}</strong><small>{fileSize(file.size)}</small></p><button className="teach-icon-button" disabled={busy} aria-label={`Удалить файл ${file.name}`} onClick={()=>{preparedMaterial.current=null;setFiles(previous=>previous.filter((_,itemIndex)=>index!==itemIndex));}}><X size={16}/></button></div>)}</div>
      {busy&&createStage&&<div className="teach-upload-progress" role="status" aria-live="polite"><div><Loader2 size={17} className="spin"/><strong>{createStage==='uploading'?'Загрузка файлов':createStage==='processing'?'Обработка файлов':'Запуск генерации'}</strong>{createStage==='uploading'&&uploadPercent!==null&&<span>{uploadPercent}%</span>}</div><div className={`teach-upload-meter ${createStage!=='uploading'||uploadPercent===null?'is-indeterminate':''}`} role="progressbar" aria-label={createStage==='uploading'?'Загрузка файлов':'Подготовка запроса'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={createStage==='uploading'&&uploadPercent!==null?uploadPercent:undefined}><i style={createStage==='uploading'&&uploadPercent!==null?{width:`${uploadPercent}%`}:undefined}/></div></div>}
      {drawerError&&<p className="teach-form-error" role="alert">{drawerError}</p>}
    </div><footer>{files.length>0&&<span>{files.length} файлов</span>}<button className="teach-button lime" disabled={busy||!lessonTitle.trim()} onClick={()=>void saveLesson()}>{busy?<Loader2 size={17} className="spin"/>:<Plus size={17}/ >}{busy?'Создаём…':'Создать урок'}<ArrowRight size={17}/></button></footer></section></div>;
  }
}
