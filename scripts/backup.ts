import 'dotenv/config';
import path from 'node:path';
import { backupStorage } from './storage.js';
if(process.env.DATABASE_URL)throw new Error('DATABASE_URL uses an external PostgreSQL server. Use pg_dump plus a separate uploads backup.');
const source=path.resolve(process.env.DATA_DIR||'data');
const destination=path.resolve(process.argv[2]||`backups/ai-teacher-${new Date().toISOString().replace(/[:.]/g,'-')}`);
try{const result=await backupStorage(source,destination);console.log(`Backup verified: ${result.files} files saved to ${result.destination}`);}catch(error:any){console.error(error.message);process.exitCode=1;}
