import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';

export interface DB {
  query<T = any>(sql: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number }>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(dataDir: string, databaseUrl?: string): Promise<DB> {
  let base: any;
  if (databaseUrl) base = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  else {
    if (dataDir !== ':memory:') await mkdir(dataDir, { recursive: true });
    base = new PGlite(dataDir === ':memory:' ? undefined : dataDir);
    await base.waitReady;
  }
  let queue: Promise<unknown> = Promise.resolve();
  let closed=false;
  const db: DB = {
    async query(sql, values = []) { return base.query(sql, values); },
    async transaction(fn) {
      // Serialize local transactions: PGlite runs in one embedded PostgreSQL connection.
      // PostgreSQL deployments additionally use row locks / revision predicates.
      const operation = queue.then(async () => {
        if (databaseUrl) {
          const client = await base.connect();
          try {
            await client.query('BEGIN');
            const result = await fn({ ...db, query: (s, v = []) => client.query(s, v) });
            await client.query('COMMIT');
            return result;
          } catch (error) { await client.query('ROLLBACK'); throw error; }
          finally { client.release(); }
        }
        return base.transaction(async (tx: any) => fn({ ...db, query: (s, v = []) => tx.query(s, v) }));
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    async close() { if(closed)return;closed=true;await queue; if (databaseUrl) await base.end(); else await base.close(); },
  };
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.transaction(async tx => {
    if ((await tx.query('SELECT version FROM schema_migrations WHERE version=1')).rows.length) return;
    const migration = `CREATE TABLE institutions (id TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE users (id TEXT PRIMARY KEY, institution_id TEXT REFERENCES institutions(id), email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, data JSONB NOT NULL, mfa_secret TEXT);
      CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, pending_mfa TEXT);
      CREATE TABLE entities (id TEXT PRIMARY KEY, institution_id TEXT NOT NULL REFERENCES institutions(id), kind TEXT NOT NULL, data JSONB NOT NULL);
      CREATE INDEX entities_scope ON entities(institution_id,kind);
      CREATE TABLE lesson_sessions (id TEXT PRIMARY KEY, institution_id TEXT NOT NULL REFERENCES institutions(id), teacher_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL, data JSONB NOT NULL);
      CREATE INDEX lessons_scope ON lesson_sessions(institution_id,teacher_id);
      CREATE TABLE questions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE, data JSONB NOT NULL);
      CREATE TABLE files (id TEXT PRIMARY KEY, institution_id TEXT NOT NULL REFERENCES institutions(id), owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL);
      CREATE TABLE audit (id TEXT PRIMARY KEY, institution_id TEXT REFERENCES institutions(id), actor_id TEXT NOT NULL, data JSONB NOT NULL);
      CREATE TABLE idempotency (user_id TEXT NOT NULL, request_key TEXT NOT NULL, route TEXT NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,request_key));
      INSERT INTO schema_migrations(version) VALUES (1)`;
    for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await tx.query(statement);
  });
  await db.transaction(async tx=>{
    if((await tx.query('SELECT version FROM schema_migrations WHERE version=2')).rows.length)return;
    await tx.query("CREATE UNIQUE INDEX lesson_sessions_one_active ON lesson_sessions (teacher_id,(data->>'lessonId'),(data->>'groupId')) WHERE data->>'state'<>'COMPLETED'");
    await tx.query('INSERT INTO schema_migrations(version) VALUES(2)');
  });
  return db;
}
