import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './security.js';

const maxInputBytes=25*1024*1024,maxOutputBytes=1024*1024,maxTextCharacters=150000;
export const integrationDocumentMimes:Record<string,string>={'.txt':'text/plain','.csv':'text/csv','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
const messages:Record<string,string>={
  INVALID_DOCUMENT:'Document could not be read. Upload a valid PDF, DOCX, TXT or CSV.',
  UNSUPPORTED_FILE:'Supported documents: PDF, DOCX, TXT and CSV.',
  FILE_TOO_LARGE:'Maximum document size is 25 MiB.',
  NO_EXTRACTABLE_TEXT:'The document has no extractable text; OCR scans before uploading.',
  DOCUMENT_TOO_LARGE:'Document text exceeds 150,000 characters; split the document.',
  DOCUMENT_TIMEOUT:'Document processing exceeded 15 seconds. Split or simplify the document.',
  DOCUMENT_MEMORY_LIMIT:'Document processing exceeded its memory limit. Split or simplify the document.',
  DOCUMENT_ABORTED:'Document processing was interrupted. Upload the document again.',
  DOCUMENT_EXTRACTION_FAILED:'Document could not be processed. Upload a simpler text document.',
};
function documentError(code:string){return new ApiError(422,messages[code]||messages.DOCUMENT_EXTRACTION_FAILED,messages[code]?code:'DOCUMENT_EXTRACTION_FAILED');}

/** Constructor-only controls; request fields never configure the executable, memory or deadline. */
export interface IntegrationDocumentOptions {signal?:AbortSignal;timeoutMs?:number}

/** Parse untrusted documents in a bounded trusted subprocess, with no temporary document files. */
export async function extractIntegrationDocument(file:Express.Multer.File,options:IntegrationDocumentOptions={}):Promise<string>{
  if(!Buffer.isBuffer(file?.buffer)||typeof file.originalname!=='string'||file.originalname.length>1024)throw documentError('INVALID_DOCUMENT');
  if(!integrationDocumentMimes[path.extname(file.originalname).toLowerCase()])throw documentError('UNSUPPORTED_FILE');
  if(file.buffer.length>maxInputBytes)throw documentError('FILE_TOO_LARGE');
  if(options.signal?.aborted)throw documentError('DOCUMENT_ABORTED');
  const timeoutMs=options.timeoutMs===undefined?15000:Math.max(1,Math.min(15000,options.timeoutMs));
  if(!Number.isFinite(timeoutMs))throw documentError('INVALID_DOCUMENT');
  const helper=fileURLToPath(new URL('./integration-document-worker.ts',import.meta.url));
  const header=Buffer.from(JSON.stringify({originalname:file.originalname,bytes:file.buffer.length})+'\n');
  return new Promise<string>((resolve,reject)=>{
    // No shell or inherited NODE_OPTIONS, provider keys, credentials, or user-supplied executable arguments.
    const child=spawn(process.execPath,['--max-old-space-size=256','--import',import.meta.resolve('tsx'),helper],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH||'/usr/bin:/bin',NODE_NO_WARNINGS:'1',TSX_DISABLE_CACHE:'1'}});
    let settled=false,failed:ApiError|undefined,outputBytes=0,checkingMemory=false;const chunks:Buffer[]=[];
    const finish=(error?:Error,text?:string)=>{if(settled)return;settled=true;clearTimeout(timer);if(memoryTimer)clearInterval(memoryTimer);options.signal?.removeEventListener('abort',aborted);child.stdin.destroy();if(error)reject(error);else resolve(text!);};
    const stop=(error:ApiError)=>{if(settled||failed)return;failed=error;if(child.pid)child.kill('SIGKILL');else finish(error);};
    const aborted=()=>stop(documentError('DOCUMENT_ABORTED'));
    const timer=setTimeout(()=>stop(documentError('DOCUMENT_TIMEOUT')),timeoutMs);
    // V8's heap flag excludes native/external buffers. Linux additionally caps observed RSS.
    const memoryTimer=process.platform==='linux'?setInterval(()=>{
      if(settled||failed||checkingMemory||!child.pid)return;checkingMemory=true;
      void readFile(`/proc/${child.pid}/status`,'utf8').then(status=>{const rss=/^VmRSS:\s+(\d+)\s+kB$/m.exec(status);if(rss&&Number(rss[1])>256*1024)stop(documentError('DOCUMENT_MEMORY_LIMIT'));}).catch(()=>{}).finally(()=>{checkingMemory=false;});
    },100):undefined;
    options.signal?.addEventListener('abort',aborted,{once:true});if(options.signal?.aborted)aborted();
    child.on('error',()=>finish(failed||documentError('DOCUMENT_EXTRACTION_FAILED')));
    child.stdin.on('error',()=>{}); // The close handler reports bounded, sanitized parser failures.
    child.stdout.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>maxOutputBytes){stop(documentError('DOCUMENT_TOO_LARGE'));return;}chunks.push(chunk);});
    child.on('close',(code,signal)=>{
      if(failed)return finish(failed);
      try{
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(result?.ok===false&&typeof result.code==='string')return finish(documentError(result.code));
        if(code!==0||signal||result?.ok!==true||typeof result.text!=='string')throw new Error('INVALID_RESULT');
        if(result.text.length>maxTextCharacters)return finish(documentError('DOCUMENT_TOO_LARGE'));
        if(!result.text.trim())return finish(documentError('NO_EXTRACTABLE_TEXT'));
        finish(undefined,result.text);
      }catch{finish(documentError('DOCUMENT_EXTRACTION_FAILED'));}
    });
    if(!failed){child.stdin.write(header);child.stdin.end(file.buffer);}
  });
}
