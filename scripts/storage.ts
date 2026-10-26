import { mkdir, open, readFile, unlink, readdir, lstat, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function exists(file:string) {try{await access(file);return true;}catch{return false;}}
async function assertStopped(directory:string) {
  const file=path.join(directory,'server.lock');
  if(!await exists(file))return;
  const pid=Number(await readFile(file,'utf8'));let running=false;
  if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);running=true;}catch{}}
  if(running)throw new Error('Stop AI Teacher before copying or restoring its database.');
}
async function fileList(directory:string,prefix=''):Promise<string[]> {
  const files:string[]=[];
  for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})) {
    const relative=path.join(prefix,entry.name);
    if(['server.lock','maintenance.lock','backup-manifest.json'].includes(relative))continue;
    if(entry.isSymbolicLink())throw new Error('Storage backups do not permit symbolic links.');
    if(entry.isDirectory())files.push(...await fileList(directory,relative));else if(entry.isFile())files.push(relative);
  }
  return files.sort();
}
async function directoryList(directory:string,prefix=''):Promise<string[]> {
  const dirs:string[]=[];
  for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('Storage backups do not permit symbolic links.');if(entry.isDirectory()){const relative=path.join(prefix,entry.name);dirs.push(relative,...await directoryList(directory,relative));}}
  return dirs.sort();
}
async function copyFiles(source:string,destination:string,files:string[],directories:string[]=[]) {
  await mkdir(destination,{recursive:false,mode:0o700});
  for(const directory of directories)await mkdir(path.join(destination,directory),{recursive:true,mode:0o700});
  for(const relative of files){const target=path.join(destination,relative);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(path.join(source,relative),target);}
}
export async function backupStorage(source:string,destination:string) {
  source=path.resolve(source);destination=path.resolve(destination);
  if(destination===source||destination.startsWith(source+path.sep))throw new Error('Backup destination must be outside DATA_DIR.');
  await mkdir(source,{recursive:true,mode:0o700});
  const lock=path.join(source,'maintenance.lock');const handle=await open(lock,'wx',0o600);await handle.close();
  try {
    await assertStopped(source);const files=await fileList(source);
    if(!files.some(f=>f.startsWith('postgres'+path.sep)))throw new Error('No local PostgreSQL database found in DATA_DIR.');
    const directories=await directoryList(source);
    await copyFiles(source,destination,files,directories);
    const entries=[];for(const file of files){const bytes=await readFile(path.join(destination,file));entries.push({path:file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
    const manifest={version:1,createdAt:new Date().toISOString(),directories,files:entries};
    const manifestFile=await open(path.join(destination,'backup-manifest.json'),'wx',0o600);await manifestFile.writeFile(JSON.stringify(manifest,null,2));await manifestFile.close();
    return {files:files.length,destination};
  }finally{await unlink(lock).catch(()=>{});}
}
export async function restoreStorage(source:string,destination:string) {
  source=path.resolve(source);destination=path.resolve(destination);
  if(await exists(destination))throw new Error('Restore destination already exists. Choose a new empty path.');
  const manifest=JSON.parse(await readFile(path.join(source,'backup-manifest.json'),'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Unsupported backup manifest.');
  const files:string[]=[];
  for(const entry of manifest.files) {
    if(typeof entry.path!=='string'||path.isAbsolute(entry.path)||entry.path.split(/[\\/]/).includes('..'))throw new Error('Unsafe backup path.');
    const real=path.join(source,entry.path);if(!(await lstat(real)).isFile())throw new Error('Backup contains a non-file.');
    const data=await readFile(real);if(data.length!==entry.size||createHash('sha256').update(data).digest('hex')!==entry.sha256)throw new Error('Backup integrity check failed.');files.push(entry.path);
  }
  const directories:string[]=manifest.directories||[];
  for(const directory of directories)if(typeof directory!=='string'||path.isAbsolute(directory)||directory.split(/[\\/]/).includes('..'))throw new Error('Unsafe backup directory.');
  await copyFiles(source,destination,files,directories);return {files:files.length,destination};
}
