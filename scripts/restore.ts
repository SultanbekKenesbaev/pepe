import 'dotenv/config';
import { restoreStorage } from './storage.js';
if(process.env.DATABASE_URL)throw new Error('Use pg_restore/psql for an external PostgreSQL server.');
const [source,destination]=process.argv.slice(2);if(!source||!destination)throw new Error('Usage: npx tsx scripts/restore.ts BACKUP_DIRECTORY NEW_DATA_DIRECTORY');
try{const result=await restoreStorage(source,destination);console.log(`Restore verified: ${result.files} files saved to ${result.destination}`);}catch(error:any){console.error(error.message);process.exitCode=1;}
