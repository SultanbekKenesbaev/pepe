let csrfToken = '';
export function setCSRF(token: string) { csrfToken = token; }
export class APIError extends Error {
  status: number; code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'APIError'; this.status = status; this.code = code; }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() || 'GET';
  if (!['GET','HEAD','OPTIONS'].includes(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try { response = await fetch(path.startsWith('/api') ? path : `/api${path}`, { ...options, headers, credentials:'same-origin' }); }
  catch { throw new APIError('Нет соединения. Проверьте сеть и попробуйте снова.', 0); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/login') && !path.includes('/auth/me')) window.dispatchEvent(new Event('auth-expired'));
    throw new APIError(data?.error || `Не удалось выполнить действие (${response.status})`, response.status, data?.code);
  }
  if (data?.csrfToken) setCSRF(data.csrfToken);
  return data as T;
}
export function json(method: string, body: unknown): RequestInit { return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}; }
export interface UploadProgress { loaded:number; total:number|null; percent:number|null }
export function upload<T>(path: string, body: FormData, onProgress?:(progress:UploadProgress)=>void):Promise<T> {
  if(!onProgress)return api<T>(path,{method:'POST',body});
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();
    request.open('POST',path.startsWith('/api')?path:`/api${path}`);
    request.withCredentials=true;request.timeout=300_000;
    if(csrfToken)request.setRequestHeader('X-CSRF-Token',csrfToken);
    request.upload.onprogress=event=>onProgress({loaded:event.loaded,total:event.lengthComputable?event.total:null,percent:event.lengthComputable&&event.total>0?Math.min(100,Math.floor(event.loaded/event.total*100)):null});
    request.upload.onload=()=>onProgress({loaded:1,total:1,percent:100});
    request.onerror=()=>reject(new APIError('Нет соединения. Проверьте сеть и попробуйте снова.',0));
    request.ontimeout=()=>reject(new APIError('Загрузка заняла слишком много времени. Повторите попытку.',0,'UPLOAD_TIMEOUT'));
    request.onabort=()=>reject(new APIError('Загрузка остановлена.',0,'UPLOAD_CANCELLED'));
    request.onload=()=>{
      let data:any=null;try{data=JSON.parse(request.responseText);}catch{}
      if(request.status<200||request.status>=300){
        if(request.status===401)window.dispatchEvent(new Event('auth-expired'));
        reject(new APIError(typeof data?.error==='string'?data.error:`Не удалось загрузить файлы (${request.status})`,request.status,data?.code));return;
      }
      if(!data){reject(new APIError('Сервер вернул некорректный ответ.',request.status,'UPLOAD_RESPONSE_INVALID'));return;}
      if(data.csrfToken)setCSRF(data.csrfToken);resolve(data as T);
    };
    onProgress({loaded:0,total:null,percent:0});request.send(body);
  });
}
