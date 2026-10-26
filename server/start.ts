import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { createApp } from './app.js';

const dataDir=path.resolve(process.env.DATA_DIR||'data');await mkdir(dataDir,{recursive:true});
const lockPath=path.join(dataDir,'server.lock');
async function acquireLock(){
  try{const file=await open(lockPath,'wx',0o600);await file.writeFile(String(process.pid));await file.close();}
  catch(error:any){
    if(error.code!=='EEXIST')throw error;
    const pid=Number(await readFile(lockPath,'utf8'));let live=true;try{process.kill(pid,0);}catch{live=false;}
    if(live)throw new Error('AI Teacher is already using this DATA_DIR');await unlink(lockPath);const file=await open(lockPath,'wx',0o600);await file.writeFile(String(process.pid));await file.close();
  }
  try{await readFile(path.join(dataDir,'maintenance.lock'));await unlink(lockPath);throw new Error('Backup/restore is running. Try again when it finishes.');}catch(error:any){if(error.code!=='ENOENT')throw error;}
}
await acquireLock();
let app:any;
try {
  app=await createApp();
  const server=createHttpServer(app);
  if(!(await app.locals.db.query('SELECT id FROM users LIMIT 1')).rows.length)throw new Error('No accounts configured. Set ADMIN_EMAIL and ADMIN_PASSWORD, or explicitly SEED_DEMO=true for a demonstration.');
  if(process.env.NODE_ENV==='production') {
    const dist=path.resolve('dist');app.use(express.static(dist,{index:false}));app.get('/{*path}',(_req:any,res:any)=>res.sendFile(path.join(dist,'index.html')));
  } else {
    const { createServer }=await import('vite');const vite=await createServer({server:{middlewareMode:true,hmr:{server}},appType:'spa'});app.use(vite.middlewares);app.locals.vite=vite;
  }
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT)||3000;
  server.listen(port,host,()=>console.log(`AI Teacher ready at http://${host}:${port}`));
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;setTimeout(()=>process.exit(1),10000).unref();await app.locals.vite?.close();server.close(async()=>{await app.locals.close();await unlink(lockPath).catch(()=>{});process.exit(0);});};
  process.on('SIGINT',close);process.on('SIGTERM',close);
  server.on('error',async(error:Error)=>{console.error(error.message);await app.locals.close();await unlink(lockPath).catch(()=>{});process.exit(1);});
} catch(error:any) {
  console.error(error.message);await app?.locals.close();await unlink(lockPath).catch(()=>{});process.exit(1);
}
