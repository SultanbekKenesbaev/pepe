import { AlertCircle, Check, Clock3, RefreshCw } from 'lucide-react';
import type { GeneratedLesson } from '../../../../shared/types';

const stageNames:Record<string,string>={planning:'План урока',script:'Сценарий',review:'Сценарий',voice:'Озвучка',visuals:'3D-сцены',checking:'Проверка урока',language_review:'Продолжение подготовки',ready:'Готово'};
const phaseNames:Record<string,string>={queued:'В очереди',authoring:'3D-сцены',alignment:'Тайминги',images:'Иллюстрации',checking:'Проверка сцен',reviewing:'Доработка сцен',rendering:'Сборка урока',validating:'Проверка урока',downloading:'Сохранение'};
const steps=['Сценарий','Озвучка','Сцены','Сборка','Проверка'];

export function lessonProgressPercent(lesson?:GeneratedLesson|null){
  if(lesson?.status==='ready')return 100;
  const value=lesson?.progress.percent;
  return typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(99,Math.floor(value))):null;
}
export function lessonProgressStage(lesson?:GeneratedLesson|null){
  const progress=lesson?.progress;
  if(lesson?.status==='language_review')return 'Продолжение подготовки';
  if(progress?.stage==='script'&&progress.completed>0)return 'Уточнение длительности';
  if(progress?.phase==='queued')return 'В очереди';
  if(progress?.phase==='alignment'||progress?.phase==='images')return phaseNames[progress.phase];
  if(lesson?.videoMode==='2d'&&progress?.stage==='visuals'&&(!progress.phase||progress.phase==='authoring'))return '2D-сцены';
  if(progress?.stage==='visuals'&&progress.phase)return phaseNames[progress.phase]||'3D-сцены';
  return stageNames[progress?.stage||'']||'Подготовка';
}
export function lessonWaitLabel(lesson?:GeneratedLesson|null){
  const range=lesson?.progress.estimatedRemainingSeconds;
  if(!range||!Number.isFinite(range.min)||!Number.isFinite(range.max)||range.min<0||range.max<range.min)return 'Время уточняется';
  const min=Math.max(1,Math.ceil(range.min/60)),max=Math.max(min,Math.ceil(range.max/60));
  return `Осталось ≈ ${min===max?min:`${min}–${max}`} мин`;
}
function stepIndex(lesson?:GeneratedLesson|null){
  if(lesson?.status==='ready')return steps.length;
  const p=lesson?.progress;
  if(p?.phase==='validating'||p?.phase==='downloading'||p?.stage==='checking')return 4;
  if(p?.phase==='rendering')return 3;
  if(p?.stage==='visuals'||p?.stage==='language_review')return 2;
  if(p?.stage==='voice')return 1;
  return 0;
}

export default function LessonGenerationProgress({lesson,starting=false}:{lesson?:GeneratedLesson|null;starting?:boolean}){
  const current=starting?null:lesson;
  const percent=lessonProgressPercent(current),stage=starting?'Запуск':lessonProgressStage(current),index=stepIndex(current),frames=current?.progress.frames;
  const id=`lesson-progress-${lesson?.id||'pending'}`;
  return <section className="teach-progress-scene" aria-label="Ход генерации">
    <div className={`teach-progress-orb ${percent===null?'indeterminate':''}`} role="progressbar" aria-label="Общий прогресс, приблизительно" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} aria-valuetext={percent===null?stage:`Примерно ${percent}%, ${stage}`}>
      <span className="teach-progress-orbit" aria-hidden="true"/>
      <svg viewBox="0 0 180 180" aria-hidden="true"><defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#2d8bdb"/><stop offset="1" stopColor="#53b8c6"/></linearGradient></defs><circle className="teach-progress-track" cx="90" cy="90" r="75"/><circle className="teach-progress-value" cx="90" cy="90" r="75" pathLength="100" stroke={`url(#${id})`} strokeDasharray="100" strokeDashoffset={percent===null?77:100-percent}/></svg>
      <div className="teach-progress-number" aria-hidden="true">{percent===null?<RefreshCw size={29} className="spin"/>:<><strong><em>≈</em>{percent}<span>%</span></strong></>}</div>
    </div>
    <div className="teach-progress-caption" role="status" aria-live="polite"><h3>{stage}</h3>{lesson?.title&&<p>{lesson.title}</p>}<span className="teach-progress-eta"><Clock3 size={13}/>{lessonWaitLabel(current)}</span>{frames&&frames.total>0&&<small className="teach-progress-frames">{Math.min(frames.completed,frames.total).toLocaleString('ru-RU')} / {frames.total.toLocaleString('ru-RU')} кадров</small>}</div>
    <ol className="teach-progress-steps" aria-label="Этапы генерации">{steps.map((name,i)=><li key={name} className={i<index?'done':i===index?'active':''} aria-current={i===index?'step':undefined}><span>{i<index?<Check size={11}/>:<i/>}</span><small>{i===2?lesson?.videoMode==='2d'?'2D-сцены':'3D-сцены':name}</small></li>)}</ol>
    {!starting&&<p className="teach-progress-background">Можно закрыть — работа продолжится</p>}
  </section>;
}

export function LessonGenerationFailure({lesson}:{lesson:GeneratedLesson}){
  return <section className="teach-progress-failure" aria-label="Ошибка генерации"><span className="teach-progress-failure-icon"><AlertCircle size={30}/></span><h3>Не удалось создать урок</h3><p className="teach-progress-topic">{lesson.title}</p><div className="teach-progress-error-detail" role="alert"><p>{lesson.error||'Причина ошибки не сохранена. Повторите попытку.'}</p>{lesson.errorCode&&<code>{lesson.errorCode}</code>}{lesson.errorStage&&<small>{lesson.videoMode==='2d'&&lesson.errorStage==='authoring'?'2D-сцены':phaseNames[lesson.errorStage]||stageNames[lesson.errorStage]||'Подготовка урока'}</small>}</div></section>;
}
