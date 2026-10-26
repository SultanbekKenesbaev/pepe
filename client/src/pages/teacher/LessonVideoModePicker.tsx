import { Box, Check, Layers3 } from 'lucide-react';
import type { GeneratedLessonVideoMode } from '../../../../shared/types';
import './LessonVideoModePicker.css';

interface Props {
  value:GeneratedLessonVideoMode;
  disabled?:boolean;
  onChange:(value:GeneratedLessonVideoMode)=>void;
}

export default function LessonVideoModePicker({value,disabled,onChange}:Props){
  return <fieldset className="teach-video-modes" role="radiogroup" disabled={disabled}>
    <legend>Формат</legend>
    <div className="teach-video-mode-options">
      {(['2d','3d'] as const).map(mode=><label className={`teach-video-mode mode-${mode}`} key={mode}>
        <input type="radio" name="lesson-video-mode" value={mode} checked={value===mode} onChange={()=>onChange(mode)}/>
        <span className="teach-video-mode-card">
          <span className="teach-video-mode-art" aria-hidden="true">{mode==='2d'?<><i/><Layers3 size={32} strokeWidth={1.6}/></>:<><i/><Box size={34} strokeWidth={1.5}/></>}</span>
          <span className="teach-video-mode-name">{mode==='2d'?'2D видео':'3D видео'}</span>
          <span className="teach-video-mode-check" aria-hidden="true">{value===mode&&<Check size={12} strokeWidth={2.5}/>}</span>
        </span>
      </label>)}
    </div>
  </fieldset>;
}
