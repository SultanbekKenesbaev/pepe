import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
 testDir:'./tests',testMatch:'**/production.smoke.ts',timeout:120_000,workers:1,reporter:'list',
 use:{baseURL:'http://127.0.0.1:3102',viewport:{width:1440,height:960},headless:true,launchOptions:{channel:'chrome'},screenshot:'only-on-failure'},
 webServer:{command:'npx tsx server/start.ts',url:'http://127.0.0.1:3102/api/health',timeout:60_000,reuseExistingServer:false,env:{PORT:'3102',HOST:'127.0.0.1',SEED_DEMO:'true',DATA_DIR:join(tmpdir(),`ai-teacher-production-e2e-${process.pid}`),NODE_ENV:'production',DATABASE_URL:'',ADMIN_EMAIL:'',ADMIN_PASSWORD:'',AI_API_KEY:'',AI_MODEL:''}},
});
