import { z } from 'zod';
import { ApiError } from './security.js';
export const text = z.string().trim().min(1).max(1000);
const identifier = z.string().trim().min(1).max(128);
const optionalId = z.preprocess(value => value === '' ? undefined : value, identifier.optional());
const longText = z.string().max(100000);
const url = z.string().max(2000).refine(s=> /^https?:\/\//i.test(s) || /^\/api\/files\/[a-f0-9]+$/.test(s), 'Допустима ссылка http(s) или загруженный файл');
const base = { name:text };
export const schemas: Record<string,z.ZodTypeAny> = {
  programs:z.object({...base,description:longText.optional(),subjectIds:z.array(identifier).max(200),groupIds:z.array(identifier).max(500),language:z.string().min(2).max(20),ageLevel:z.string().max(200).optional()}),
  rooms:z.object({...base,capacity:z.preprocess(v=>v===''?undefined:v,z.number().int().min(1).max(10000).optional()),description:longText.optional()}),
  groups:z.object({...base,level:z.string().max(200).optional(),teacherId:optionalId,teacherIds:z.array(identifier).max(100).optional(),departmentId:optionalId}),
  students:z.object({...base,groupId:identifier}),
  subjects:z.object({...base,description:longText.optional()}),
  lessons:z.object({...base,subjectId:identifier,groupId:optionalId,programId:optionalId,description:longText.optional(),duration:z.number().int().min(1).max(480),language:z.string().min(2).max(20),sections:z.array(z.object({id:identifier,title:text,content:longText.min(1),materialIds:z.array(identifier).max(100)})).min(1).max(100),quiz:z.array(z.object({id:identifier,question:text,options:z.array(text).min(2).max(10),correctIndex:z.number().int().min(0),explanation:z.string().max(5000).optional()}).refine(q=>q.correctIndex<q.options.length,'Индекс правильного ответа вне списка')).max(100),approved:z.boolean(),cinemaId:z.string().regex(/^(derivative|generated:[a-f0-9]{32})$/).optional()}),
  materials:z.object({...base,subjectId:optionalId,topic:z.string().max(1000).optional(),language:z.string().min(2).max(20),ageLevel:z.string().max(100).optional(),type:z.enum(['text','image','pdf','video','link','presentation']),content:longText.optional(),url:z.preprocess(v=>v===''?undefined:v,url.optional()),fileId:optionalId,source:z.string().max(2000).optional(),license:z.string().max(1000).optional(),approved:z.boolean()}).refine(m=>!!(m.content?.trim()||m.url||m.fileId),'Материал должен содержать текст или файл/ссылку'),
  schedule:z.object({...base,lessonId:identifier,groupId:identifier,teacherId:identifier,startsAt:z.string().datetime({offset:true}),room:z.string().max(200).optional(),roomId:optionalId,allDay:z.boolean().optional()}),
  devices:z.object({...base,room:text,roomId:optionalId,type:z.enum(['camera','microphone','speaker','panel']),status:z.enum(['unknown','online','offline']),model:z.string().max(500).optional(),lastCheckedAt:z.string().datetime({offset:true}).optional()}),
  departments:z.object({...base,parentId:optionalId}),
  assignments:z.object({...base,groupId:identifier,lessonId:optionalId,instructions:longText.min(1),dueAt:z.preprocess(v=>v===''?undefined:v,z.string().datetime({offset:true}).optional())}),
};
export const institutionSchema = z.object({name:text,type:z.literal('UNIVERSITY'),language:z.string().min(2).max(20),settings:z.object({voice:z.string().max(200).optional(),timezone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Неизвестный часовой пояс').optional(),allowExternalAI:z.boolean().optional(),retentionDays:z.number().int().min(1).max(3650).optional(),modules:z.array(z.string().max(100)).max(30).optional()})});
export const userSchema = z.object({name:text,email:z.string().email().max(254),role:z.enum(['ADMIN','TEACHER']),active:z.boolean(),groupIds:z.array(identifier).max(200).optional(),studentId:optionalId,childIds:z.array(identifier).max(100).optional()});
export function parse<T = any>(schema:z.ZodTypeAny, input:unknown):T {
  const r=schema.safeParse(input); if(!r.success) throw new ApiError(400,r.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ').slice(0,1200)); return r.data as T;
}
