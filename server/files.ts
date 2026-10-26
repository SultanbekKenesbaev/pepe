import type { Express } from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import type { DB } from './db.js';
import { uid, ApiError, teachingRoles } from './security.js';
import { tenant, permitted, institutionExists, visibleEntities, groupIds } from './access.js';

const extensions: Record<string,{mime:string;signature?:(b:Buffer)=>boolean}>= {
  '.pdf':{mime:'application/pdf',signature:b=>b.subarray(0,5).toString()==='%PDF-'},
  '.png':{mime:'image/png',signature:b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))},
  '.jpg':{mime:'image/jpeg',signature:b=>b[0]===255&&b[1]===216&&b[2]===255},
  '.jpeg':{mime:'image/jpeg',signature:b=>b[0]===255&&b[1]===216&&b[2]===255},
  '.gif':{mime:'image/gif',signature:b=>/^GIF8[79]a$/.test(b.subarray(0,6).toString())},
  '.webp':{mime:'image/webp',signature:b=>b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'},
  '.pptx':{mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',signature:b=>b[0]===80&&b[1]===75&&b[2]===3&&b[3]===4},
  '.txt':{mime:'text/plain',signature:b=>!b.includes(0)},
  '.mp3':{mime:'audio/mpeg',signature:b=>b.subarray(0,3).toString()==='ID3'||b[0]===255&&(b[1]&224)===224},
  '.wav':{mime:'audio/wav',signature:b=>b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WAVE'},
  '.mp4':{mime:'video/mp4',signature:b=>b.subarray(4,8).toString()==='ftyp'},
  '.webm':{mime:'video/webm',signature:b=>b.subarray(0,4).equals(Buffer.from([26,69,223,163]))},
  '.ogg':{mime:'audio/ogg',signature:b=>b.subarray(0,4).toString()==='OggS'},
};
export function installFiles(app:Express,db:DB,ctx:any) {
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1,fields:8,fieldSize:5000}});
  app.post('/api/files',(req:any,_res,next)=>{permitted(req.user,teachingRoles);next();},upload.single('file'),async(req:any,res)=>{
    const institutionId=tenant(req.user,req.body.institutionId);await institutionExists(db,institutionId);
    if(!req.file)throw new ApiError(400,'Выберите файл');
    const ext=path.extname(req.file.originalname).toLowerCase();const config=extensions[ext];
    if(!config||!config.signature?.(req.file.buffer))throw new ApiError(400,'Тип файла или его содержимое не поддерживается. Допустимы PDF, PNG, JPG, GIF, WEBP, PPTX, TXT, MP3, WAV, MP4, WEBM, OGG.','UNSUPPORTED_FILE');
    const name=String(req.body.name||req.file.originalname).replace(/[\x00-\x1f]/g,'').slice(0,250);const id=uid();const relative=id+ext;
    await mkdir(ctx.uploadDir,{recursive:true});await writeFile(path.join(ctx.uploadDir,relative),req.file.buffer,{flag:'wx',mode:0o600});
    try{await db.query('INSERT INTO files(id,institution_id,owner_id,name,mime,size,path) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,institutionId,req.user.id,name,config.mime,req.file.size,relative]);}catch(error){await unlink(path.join(ctx.uploadDir,relative));throw error;}
    await ctx.audit(req.user,'file.upload',id,institutionId);res.status(201).json({id,name,mime:config.mime,size:req.file.size,url:'/api/files/'+id});
  });
  app.get('/api/files/:id',async(req:any,res)=>{
    const file=(await db.query('SELECT * FROM files WHERE id=$1',[req.params.id])).rows[0];if(!file)throw new ApiError(404,'Файл не найден');
    tenant(req.user,file.institution_id);
    if(req.user.role==='TEACHER'&&file.owner_id!==req.user.id){
      // Source-library documents stay private even if someone links a known file ID
      // into a legacy shared material. Only their author and institution admin read them.
      const source=(await db.query("SELECT id FROM lesson_materials WHERE institution_id=$1 AND data->'files' @> $2::jsonb LIMIT 1",[file.institution_id,JSON.stringify([{id:file.id}])])).rows[0];
      if(source)throw new ApiError(403,'Файл урока другого преподавателя','FORBIDDEN');
      const materials=await visibleEntities(db,req.user,file.institution_id,'materials');
      const groups=await groupIds(db,req.user,file.institution_id) as string[];
      const students=(await db.query("SELECT data FROM entities WHERE institution_id=$1 AND kind='students'",[file.institution_id])).rows.map(r=>r.data);
      const faces=(await db.query("SELECT data FROM face_enrollments WHERE institution_id=$1 AND data->>'photoFileId'=$2",[file.institution_id,file.id])).rows.map(r=>r.data);
      const ownFace=faces.some(face=>students.some(student=>student.id===face.studentId&&groups.includes(student.groupId)));
      const semesters=(await db.query('SELECT data FROM semesters WHERE institution_id=$1 AND teacher_id=$2 AND archived=FALSE',[file.institution_id,req.user.id])).rows.map(r=>r.data);
      const ownSemester=semesters.some(s=>s.files.some((f:any)=>f.id===file.id));
      if(!ownFace&&!ownSemester&&!materials.some(m=>m.approved&&m.fileId===file.id))throw new ApiError(403,'Файл не связан с вашими группами или материалами','FORBIDDEN');
    }
    if(req.user.role==='TECHNICIAN')throw new ApiError(403,'Нет доступа к учебным файлам');
    if(['STUDENT','PARENT'].includes(req.user.role)) {
      const materials=await visibleEntities(db,req.user,file.institution_id,'materials');
      if(!materials.some(m=>m.fileId===file.id))throw new ApiError(403,'Файл ещё не опубликован в материалах');
    }
    const inline=file.mime==='application/pdf'||file.mime.startsWith('image/')||file.mime.startsWith('video/')||file.mime.startsWith('audio/');
    res.set('Content-Type',file.mime).set('X-Content-Type-Options','nosniff').set('Cache-Control','private, no-store').set('Content-Security-Policy',"default-src 'none'; sandbox");
    res.set('Content-Disposition',`${inline?'inline':'attachment'}; filename="download${path.extname(file.path)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    const data=await readFile(path.join(ctx.uploadDir,file.path));res.send(data);
  });
  app.post('/api/speech/transcribe',(req:any,_res,next)=>{permitted(req.user,teachingRoles);next();},upload.single('audio'),async(req:any,res)=>{
    const institutionId=tenant(req.user,req.body.institutionId);const status=await ctx.aiStatus(institutionId);
    if(!status.externalAllowed||!ctx.aiConfig.apiKey||!ctx.aiConfig.transcriptionModel)throw new ApiError(503,'Серверное распознавание речи не настроено или не разрешено учреждением. Используйте текстовый ввод.','SPEECH_UNAVAILABLE');
    if(!req.file||!['audio/webm','audio/ogg','audio/wav','audio/mpeg','video/webm','audio/mp4'].includes(req.file.mimetype))throw new ApiError(400,'Неподдерживаемый аудиофайл');
    const form=new FormData();form.set('model',ctx.aiConfig.transcriptionModel);form.set('file',new Blob([new Uint8Array(req.file.buffer)],{type:req.file.mimetype}),req.file.originalname);
    try {
      const response=await fetch((ctx.aiConfig.baseUrl||'https://api.openai.com/v1').replace(/\/$/,'')+'/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${ctx.aiConfig.apiKey}`},body:form,signal:AbortSignal.timeout(ctx.aiConfig.timeoutMs||25000)});
      if(!response.ok)throw new Error();const data:any=await response.json();if(typeof data.text!=='string')throw new Error();res.json({text:data.text.slice(0,10000)});
    }catch{throw new ApiError(503,'Сервис распознавания речи недоступен. Используйте текстовый ввод.','SPEECH_UNAVAILABLE');}
  });
}
