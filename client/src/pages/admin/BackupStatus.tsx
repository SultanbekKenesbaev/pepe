import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, HardDrive, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../../api';

type Operations={backup:{status:'never'|'running'|'success'|'failed';lastAttemptAt?:string;lastSuccessAt?:string};serverTime:string};
const labels={never:'Пока нет копий',running:'Создаётся копия',success:'Копия сохранена',failed:'Ошибка копирования'};
export default function BackupStatus(){
  const [data,setData]=useState<Operations|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);try{setData(await api<Operations>('/operations/status'));setError(false);}catch{setError(true);}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();const refresh=()=>{if(document.visibilityState==='visible')void load();};const interval=setInterval(refresh,30_000);window.addEventListener('focus',refresh);return()=>{clearInterval(interval);window.removeEventListener('focus',refresh);};},[load]);
  const status=data?.backup.status;
  return <section className="ua-panel ua-backup-status" aria-label="Резервные копии"><span className={`ua-backup-symbol ${status==='failed'?'failed':''}`}>{status==='failed'?<CircleAlert size={23}/>:status==='success'?<ShieldCheck size={23}/>:<HardDrive size={23}/>}</span><div><h2>Резервные копии</h2><p aria-live="polite">{error?'Не удалось проверить':status?labels[status]:'Проверка состояния'}</p></div><div className="ua-backup-last"><span>Последняя копия</span><strong>{data?.backup.lastSuccessAt?new Date(data.backup.lastSuccessAt).toLocaleString('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tashkent'}):'—'}</strong></div><button className="ua-icon" type="button" aria-label="Обновить состояние копирования" onClick={()=>void load()} disabled={loading}>{loading?<Loader2 size={17} className="ua-spin"/>:<RefreshCw size={17}/>}</button></section>;
}
