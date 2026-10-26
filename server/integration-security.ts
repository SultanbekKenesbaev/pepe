import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { lstat, mkdir, readFile, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './security.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value as object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as any)[key])).join(',') + '}';
}

/** Conservative public-address allowlist; documentation, transition and metadata ranges stay closed. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number), value = parts.reduce((sum, part) => sum * 256 + part, 0);
    const blocked: [string, number][] = [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],['168.63.129.16',32]];
    return !blocked.some(([base,bits]) => Math.floor(value / 2 ** (32-bits)) === Math.floor(base.split('.').map(Number).reduce((sum,part)=>sum*256+part,0) / 2 ** (32-bits)));
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 1 ? left : [...left,...Array(8-left.length-right.length).fill('0'),...right];
  if (words.length !== 8) return false;
  const value = words.reduce((sum,word)=>(sum<<16n)+BigInt('0x'+word),0n);
  const inPrefix=(base:bigint,bits:number)=>(value>>BigInt(128-bits))===(base>>BigInt(128-bits));
  return inPrefix(0x20000000000000000000000000000000n,3)
    && !inPrefix(0x20010000000000000000000000000000n,23)
    && !inPrefix(0x20010db8000000000000000000000000n,32)
    && !inPrefix(0x20020000000000000000000000000000n,16)
    && !inPrefix(0x3fff0000000000000000000000000000n,20);
}

export function webhookUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400,'Укажите публичный HTTPS-адрес уведомлений','INVALID_WEBHOOK_URL'); }
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || value.length>2048 || !hostname.includes('.') && !isIP(hostname) || /(?:^|\.)(?:localhost|local|internal|home|test|invalid)$/i.test(hostname) || isIP(hostname) && !publicAddress(hostname)) {
    throw new ApiError(400,'Нужен публичный HTTPS-адрес без пароля, фрагмента и нестандартного порта','INVALID_WEBHOOK_URL');
  }
  return url;
}

export function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason||new Error('WEBHOOK_ABORTED'));};
    if(signal.aborted){void promise.catch(()=>{});return aborted();}
    signal.addEventListener('abort',aborted,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
  });
}

export async function resolveWebhook(value: string,signal:AbortSignal=AbortSignal.timeout(5000)) {
  const url=webhookUrl(value), hostname=url.hostname.replace(/^\[|\]$/g,'');
  signal.throwIfAborted();
  const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await bounded(lookup(hostname,{all:true,verbatim:true}),signal);
  if (!addresses.length || addresses.some(item=>!publicAddress(item.address))) throw new ApiError(400,'Адрес уведомлений должен указывать только на публичный сервер','INVALID_WEBHOOK_URL');
  return {url,address:addresses[0].address,family:addresses[0].family};
}

export async function signingVault(dataDir:string) {
  const directory=path.join(dataDir,'secrets'),file=path.join(directory,'integration-vault.key');
  await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=path.join(directory,`.integration-vault-${randomBytes(16).toString('hex')}.tmp`),handle=await open(temporary,'wx',0o600);
  try {await handle.writeFile(randomBytes(32));await handle.sync();}finally{await handle.close();}
  try {await link(temporary,file);}catch(error:any){if(error.code!=='EEXIST')throw error;}finally{await unlink(temporary).catch(()=>{});}
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==32||(info.mode&0o077)!==0)throw new Error('INTEGRATION_VAULT_INVALID');
  const key=await readFile(file);
  return {
    encrypt(secret:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');},
    decrypt(value:string){const bytes=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');},
  };
}

export function webhookSignature(secret:string,timestamp:number,body:string) {
  return `t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Resolve on every delivery and pin the checked address; TLS still verifies the original hostname. */
export async function deliverWebhook(value:string,secret:string,eventId:string,body:string,signal?:AbortSignal):Promise<number> {
  const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const {url,address,family}=await resolveWebhook(value,deadline),timestamp=Math.floor(Date.now()/1000);
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'POST',agent:false,signal:deadline,timeout:10000,lookup:((_hostname:any,options:any,callback:any)=>options?.all?callback(null,[{address,family}]):callback(null,address,family)) as any,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'User-Agent':'Routemotion-Webhooks/1.0','X-Routemotion-Event-Id':eventId,'X-Routemotion-Signature':webhookSignature(secret,timestamp,body)}},res=>{
      const status=res.statusCode||0;res.destroy();resolve(status);
    });
    req.on('timeout',()=>req.destroy(new Error('WEBHOOK_TIMEOUT')));req.on('error',reject);req.end(body);
  });
}
