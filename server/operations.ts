import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import { permitted } from './access.js';

export function installOperations(app: Express) {
  app.get('/api/operations/status', async (req: any, res) => {
    permitted(req.user, ['ADMIN']);
    let backup: Record<string, string> = { status: 'never' };
    const file = process.env.OPERATIONS_STATUS_FILE;
    if (file) {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        if (['running', 'success', 'failed'].includes(raw.status)) {
          backup = { status: raw.status };
          for (const key of ['lastAttemptAt', 'lastSuccessAt']) {
            if (typeof raw[key] === 'string' && Number.isFinite(Date.parse(raw[key]))) backup[key] = new Date(raw[key]).toISOString();
          }
          if (backup.status === 'running' && (!backup.lastAttemptAt || Date.now() - Date.parse(backup.lastAttemptAt) > 30 * 60_000)) backup.status = 'failed';
        } else backup = { status: 'failed' };
      } catch (error) { backup = { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'never' : 'failed' }; }
    }
    res.json({ backup, serverTime: new Date().toISOString() });
  });
}
