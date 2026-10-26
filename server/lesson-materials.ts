import type { Express } from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { DB } from './db.js';
import type { LessonMaterial, LessonMaterialDetail, User } from '../shared/types.js';
import { uid, now, ApiError } from './security.js';
import { tenant, permitted, entity, institutionExists } from './access.js';
import { parse } from './validation.js';
import { documentMimes, extractDocumentText } from './document-text.js';
import { resolveAuthoringSubject } from './platform.js';

const materialSchema=z.object({title:z.string().trim().min(1).max(300),subjectId:z.string().min(1).max(128).optional()});
function summary({documents:_,...material}:LessonMaterialDetail):LessonMaterial { return material; }
async function materialFor(db:DB,user:User,id:string):Promise<LessonMaterialDetail> {
  permitted(user,['ADMIN','TEACHER']);
  const material=(await db.query('SELECT data FROM lesson_materials WHERE id=$1',[id])).rows[0]?.data as LessonMaterialDetail|undefined;
  if(!material)throw new ApiError(404,'Урок не найден','NOT_FOUND');
  tenant(user,material.institutionId);
  if(user.role==='TEACHER'&&material.teacherId!==user.id)throw new ApiError(403,'Урок другого преподавателя','FORBIDDEN');
  return material;
}

export function installLessonMaterials(app:Express,db:DB,ctx:any) {
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:12,fields:5,fieldSize:2000}});
  app.get('/api/lesson-materials',async(req:any,res)=>{
    permitted(req.user,['ADMIN','TEACHER']);
    const institutionId=tenant(req.user,req.query.institutionId);
    const values=[institutionId];let scope='institution_id=$1';
    if(req.user.role==='TEACHER'){values.push(req.user.id);scope+=' AND teacher_id=$2';}
    const rows=await db.query(`SELECT data - 'documents' AS data FROM lesson_materials WHERE ${scope} ORDER BY data->>'createdAt' DESC,id`,values);
    res.json(rows.rows.map(row=>row.data));
  });
  app.get('/api/lesson-materials/:id',async(req:any,res)=>res.json(await materialFor(db,req.user,req.params.id)));
  app.post('/api/lesson-materials',(req:any,_res,next)=>{permitted(req.user,['ADMIN','TEACHER']);next();},upload.array('files',12),async(req:any,res)=>{
    const institutionId=tenant(req.user,req.body.institutionId);
    await institutionExists(db,institutionId);
    const input=parse<z.infer<typeof materialSchema>>(materialSchema,req.body);
    if(input.subjectId){const subject=await entity(db,input.subjectId,'subjects');if(subject.institutionId!==institutionId)throw new ApiError(403,'Предмет другого университета','FORBIDDEN');}
    const files=(req.files||[]) as Express.Multer.File[];
    if(!files.length)throw new ApiError(400,'Добавьте файл урока','FILES_REQUIRED');
    if(files.reduce((total,file)=>total+file.size,0)>50*1024*1024)throw new ApiError(400,'Общий размер документов превышает 50 МБ','UPLOAD_TOO_LARGE');
    const documents:{file:Express.Multer.File;text:string;name:string;ext:string}[]=[];
    for(const file of files){
      const name=path.basename(file.originalname.replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,250);
      const ext=path.extname(name).toLowerCase();
      if(!name||!documentMimes[ext])throw new ApiError(400,'Поддерживаются PDF, DOCX, TXT и CSV','UNSUPPORTED_FILE');
      let text:string;
      try{text=(await extractDocumentText({...file,originalname:name},{allowEmptyText:ext==='.pdf'})).trim();}
      catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,`Не удалось прочитать ${name}. Проверьте документ.`,'EXTRACTION_FAILED');}
      if(!text&&ext!=='.pdf')throw new ApiError(400,`В ${name} не найден текст.`,'NO_EXTRACTABLE_TEXT');
      if(text.length>200000)throw new ApiError(400,'Документ содержит более 200 000 символов. Разделите файл.','DOCUMENT_TOO_LARGE');
      documents.push({file,text,name,ext});
    }
    if(documents.reduce((total,document)=>total+document.text.length,0)>1000000)throw new ApiError(400,'В одном уроке допускается до 1 000 000 символов','DOCUMENT_TOO_LARGE');
    const timestamp=now();
    const material:LessonMaterialDetail={id:uid(),institutionId,teacherId:req.user.id,...input,subjectId:input.subjectId||'',status:'stored',files:[],documents:[],extractedCharacters:0,createdAt:timestamp,updatedAt:timestamp};
    await mkdir(ctx.uploadDir,{recursive:true});const written:string[]=[];
    try{
      await db.transaction(async tx=>{
        material.subjectId=await resolveAuthoringSubject(tx,institutionId,input.subjectId);
        for(const {file,text,name,ext} of documents){
          const id=uid(),filename=id+ext,mime=documentMimes[ext];
          await writeFile(path.join(ctx.uploadDir,filename),file.buffer,{flag:'wx',mode:0o600});written.push(filename);
          await tx.query('INSERT INTO files(id,institution_id,owner_id,name,mime,size,path) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,institutionId,req.user.id,name,mime,file.size,filename]);
          material.files.push({id,name,mime,size:file.size,extractedCharacters:text.length,url:`/api/files/${id}`});
          material.documents.push({fileId:id,text});material.extractedCharacters+=text.length;
        }
        await tx.query('INSERT INTO lesson_materials(id,institution_id,teacher_id,subject_id,data) VALUES($1,$2,$3,$4,$5)',[material.id,institutionId,material.teacherId,material.subjectId,material]);
      });
    }catch(error){await Promise.all(written.map(filename=>unlink(path.join(ctx.uploadDir,filename)).catch(()=>{})));throw error;}
    await ctx.audit(req.user,'lesson-material.upload',material.id,institutionId);
    res.status(201).json(summary(material));
  });
}
