import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, CircleAlert, Loader2, ScanFace, Square } from 'lucide-react';
import type { FaceEnrollment, UniversityData } from '../../../../shared/types';
import { FACE_MODEL_VERSION, scanFaces } from '../../face';

type Props={data:UniversityData;enrollments:FaceEnrollment[]};
type ScanResult={detectedFaces:number;matches:{studentId:string;similarity:number}[];unknownFaces:number;elapsed:number};
type FrameInfo={width:number;height:number;brightness:number};

export default function CameraDiagnostics({data,enrollments}:Props){
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[deviceId,setDeviceId]=useState('');
  const [groupId,setGroupId]=useState(''),[state,setState]=useState<'off'|'opening'|'ready'|'scanning'>('off');
  const [error,setError]=useState(''),[frame,setFrame]=useState<FrameInfo|null>(null),[result,setResult]=useState<ScanResult|null>(null);
  const video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null),generation=useRef(0),mounted=useRef(true);
  const roster=useMemo(()=>data.students.filter(item=>!groupId||item.groupId===groupId),[data.students,groupId]);
  const references=useMemo(()=>enrollments.filter(item=>roster.some(student=>student.id===item.studentId)&&item.modelVersion===FACE_MODEL_VERSION),[enrollments,roster]);
  const supported=typeof navigator.mediaDevices?.getUserMedia==='function';
  async function listDevices(){try{const values=await navigator.mediaDevices?.enumerateDevices();if(mounted.current)setDevices((values||[]).filter(item=>item.kind==='videoinput'));}catch{}}
  useEffect(()=>{
    mounted.current=true;void listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange',listDevices);
    return()=>{mounted.current=false;generation.current++;stream.current?.getTracks().forEach(track=>track.stop());navigator.mediaDevices?.removeEventListener?.('devicechange',listDevices);};
  },[]);
  function stop(){generation.current++;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;if(video.current)video.current.srcObject=null;setState('off');setFrame(null);setResult(null);}
  function frameInfo():FrameInfo|null{
    const input=video.current;if(!input?.videoWidth)return null;
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return null;
    context.drawImage(input,0,0,64,36);const pixels=context.getImageData(0,0,64,36).data;let sum=0;
    for(let i=0;i<pixels.length;i+=4)sum+=.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2];
    return {width:input.videoWidth,height:input.videoHeight,brightness:Math.round(sum/(pixels.length/4)/255*100)};
  }
  async function start(){
    if(!supported)return;stop();const token=++generation.current;setState('opening');setError('');
    try{
      const selected=await navigator.mediaDevices.getUserMedia({audio:false,video:{...(deviceId?{deviceId:{exact:deviceId}}:{}),width:{ideal:1920},height:{ideal:1080}}});
      if(token!==generation.current||!mounted.current){selected.getTracks().forEach(track=>track.stop());return;}
      stream.current=selected;const input=video.current;if(!input)throw new Error('Нет изображения с камеры');input.srcObject=selected;await input.play();
      if(input.readyState<2)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{input.onloadeddata=null;reject(new Error('Нет изображения с камеры'));},10_000);input.onloadeddata=()=>{clearTimeout(timer);input.onloadeddata=null;resolve();};});
      if(token!==generation.current||!mounted.current)return;
      setFrame(frameInfo());setState('ready');void listDevices();
    }catch(cause){
      if(token!==generation.current||!mounted.current)return;
      stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;setState('off');
      setError(cause instanceof DOMException&&cause.name==='NotAllowedError'?'Нет доступа к камере':cause instanceof DOMException&&cause.name==='NotFoundError'?'Камера не найдена':cause instanceof Error?cause.message:'Камера недоступна');
    }
  }
  async function scan(){
    if(!video.current||state!=='ready')return;const token=generation.current;setState('scanning');setError('');
    try{const started=performance.now();const detected=await scanFaces(video.current,references);if(token!==generation.current||!mounted.current)return;setResult({...detected,elapsed:Math.round(performance.now()-started)});setFrame(frameInfo());}
    catch(cause){if(token===generation.current&&mounted.current)setError(cause instanceof Error?cause.message:'Проверка не выполнена');}
    finally{if(token===generation.current&&mounted.current)setState('ready');}
  }
  return <section className="ua-panel ua-camera-diagnostics" aria-label="Диагностика камеры"><div className="ua-panel-title"><h2>Проверка камеры</h2><span className="ua-status">Локально</span></div>
    <div className="ua-camera-layout"><div className="ua-camera-view"><video ref={video} autoPlay playsInline muted aria-label="Изображение с камеры"/>{state==='off'&&<div className="ua-camera-placeholder"><Camera size={30}/><span>Камера выключена</span></div>}{(state==='opening'||state==='scanning')&&<div className="ua-camera-processing"><Loader2 size={24} className="ua-spin"/><span>{state==='opening'?'Подключение':'Распознавание'}</span></div>}{frame&&<span className="ua-camera-resolution">{frame.width} × {frame.height}</span>}</div>
      <div className="ua-camera-options"><label className="ua-field"><span>Камера</span><select aria-label="Камера для проверки" value={deviceId} disabled={state==='scanning'||state==='opening'} onChange={event=>{stop();setDeviceId(event.target.value);}}><option value="">По умолчанию</option>{devices.map((item,index)=><option key={item.deviceId} value={item.deviceId}>{item.label||`Камера ${index+1}`}</option>)}</select></label><label className="ua-field"><span>Группа</span><select aria-label="Группа для проверки" value={groupId} disabled={state==='scanning'} onChange={event=>{setGroupId(event.target.value);setResult(null);}}><option value="">Все группы</option>{data.groups.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="ua-camera-references"><ScanFace size={18}/><span>Фото студентов</span><strong>{references.length}<small> / {roster.length}</small></strong></div>
      {frame&&<div className="ua-camera-measurements"><span>Освещённость <strong>{frame.brightness<20?'Темно':frame.brightness>85?'Слишком ярко':'Нормально'}</strong></span><span>Разрешение <strong>{frame.height>=1080?'Full HD':frame.height>=720?'HD':`${frame.width} × ${frame.height}`}</strong></span></div>}
      <div className="ua-camera-actions">{state==='off'?<button type="button" className="ua-button" onClick={()=>void start()} disabled={!supported}><Camera size={16}/>Включить камеру</button>:<button type="button" className="ua-button" disabled={state==='opening'} onClick={stop}><Square size={13}/>Выключить</button>}<button type="button" className="ua-button lime" disabled={state!=='ready'} onClick={()=>void scan()}>{state==='scanning'?<Loader2 size={16} className="ua-spin"/>:<ScanFace size={16}/>}Проверить</button></div>
      {!supported&&<p className="ua-hint">Камера недоступна в этом браузере.</p>}<p className="ua-hint">Проверка не меняет посещаемость. Точность нужно проверить в аудитории.</p></div></div>
    {error&&<div className="ua-error" role="alert"><CircleAlert size={16}/>{error}</div>}
    {result&&<div className="ua-camera-result" aria-live="polite"><div className="ua-camera-result-totals"><span>Лиц <strong>{result.detectedFaces}</strong></span><span>Совпадений <strong>{result.matches.length}</strong></span><span>Не определены <strong>{result.unknownFaces}</strong></span><small>{(result.elapsed/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} с</small></div>{!!result.matches.length&&<div className="ua-camera-matches">{result.matches.map(match=><span key={match.studentId}><Check size={13}/>{data.students.find(item=>item.id===match.studentId)?.name||'Студент'}</span>)}</div>}</div>}
  </section>;
}
