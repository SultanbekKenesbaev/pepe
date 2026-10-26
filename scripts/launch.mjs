import 'dotenv/config';
import { spawn } from 'node:child_process';
const port = Number(process.env.PORT) || 3000;
const url = `http://localhost:${port}`;
const openBrowser = () => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const browser = spawn(command, [url], {stdio:'ignore'});
  browser.on('error', () => console.log(`Откройте ${url} в браузере.`));
  browser.unref();
};
async function ready() {
  try { const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)}); return response.ok && (await response.json()).status==='ok'; }
  catch { return false; }
}
if (await ready()) { console.log(`AI Teacher уже работает: ${url}`); openBrowser(); }
else {
  const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','server/start.ts'],{stdio:'inherit',env:process.env});
  let finished=false;
  child.on('exit',(code)=>{finished=true;process.exitCode=code||0;});
  child.on('error',(error)=>{finished=true;console.error(error.message);process.exitCode=1;});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  for(let attempt=0;attempt<60&&!finished;attempt++){
    if(await ready()){openBrowser();break;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}
