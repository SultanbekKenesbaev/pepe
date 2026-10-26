/** Two real broker processes with an isolated Docker executable test double.
 * Mock projects, reports and MP4 bytes prove orchestration only; no author,
 * image generator, recognizer or actual video renderer is invoked. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const temporary = await mkdtemp(path.join(tmpdir(), 'broker-modes-'));
const callsFile = path.join(temporary, 'docker-calls.jsonl'), docker = path.join(temporary, 'docker.mjs');
const brokerFile = fileURLToPath(new URL('../broker.mjs', import.meta.url));
const oldNames = { '2d': 'aiteacher2d-author-' + '2'.repeat(12) + '-aaaaaa', '3d': 'aiteacher-render-' + '3'.repeat(12) + '-bbbbbb' };
const workers = Object.fromEntries(['2d','3d'].map(mode => [mode, { mode, jobs: path.join(temporary, mode, 'jobs'), token: `${mode}-broker-mode-token-${'x'.repeat(48)}`, child: undefined, base: '', output: '' }]));
const key = number => number.toString(16).padStart(64, '0');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let cases = 0;
await writeFile(docker, `#!/usr/bin/env node
import {promises as fs} from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2),log=${JSON.stringify(callsFile)};
await fs.appendFile(log,JSON.stringify({command:args[0],args})+'\\n');
if(args[0]==='ps'){if(args.some(x=>x.startsWith('label=')))console.log(${JSON.stringify(Object.values(oldNames).join('\n'))});process.exit(0);}
if(args[0]==='rm')process.exit(0);if(args[0]!=='run')process.exit(1);
const mount=args.find(x=>x.startsWith('type=bind,src=')&&x.endsWith('dst=/job'));
const job=mount.slice('type=bind,src='.length).split(',dst=')[0],id=path.basename(job),out=path.join(job,'output'),operation=args.at(-1);
const runtime=args.find(x=>/^\\/runtime\\/(author|render)(2d)?\\.mjs$/.test(x)),mode=runtime.includes('2d')?'2d':'3d';
await fs.appendFile(log,JSON.stringify({command:'step',id,mode,operation,runtime,name:args[args.indexOf('--name')+1],owner:args.filter(x=>x.startsWith('com.routemotion.authoring=')),args})+'\\n');
if(operation==='auth'){console.log(JSON.stringify({configured:true,mode:'chatgpt',imageGeneration:true}));process.exit(0);}
const input=JSON.parse(await fs.readFile(path.join(job,'input.json'),'utf8'));await fs.mkdir(out,{recursive:true});
if(operation==='prepare'){
 if(input.prepareFailOnce){const marker=path.join(out,'mock-prepare-failed');let exists=false;try{await fs.access(marker);exists=true;}catch{};if(!exists){await fs.writeFile(marker,'1');process.exit(31);}}
 await fs.writeFile(path.join(out,'alignment.json'),JSON.stringify({mock:true,words:[]}));
}
if(operation==='script')await fs.writeFile(path.join(out,'script.json'),JSON.stringify({title:input.title||input.topic||'Mock',chapters:Array.from({length:3},(_,c)=>({id:'chapter-'+c,cues:Array.from({length:4},(_,i)=>({id:'cue-'+c+'-'+i,text:'Explicit mock narration.'}))}))}));
if(operation==='visuals'){
 await fs.writeFile(path.join(out,mode==='2d'?'index.html':'scene.js'),mode==='2d'?'<html>Mock editable project</html>':'export const mockProject=true;');
 if(input.hold){
  await fs.writeFile(path.join(out,'author-progress.json'),JSON.stringify({stage:'images',completed:1,total:4,privateToken:'DO_NOT_EXPOSE'}));
  const release=path.join(job,'mock-release');let released=false;
  for(let i=0;i<2000;i++){try{await fs.access(release);released=true;break;}catch{}await new Promise(r=>setTimeout(r,10));}
  if(!released)process.exit(32);
 }
}
if(operation==='check')await fs.writeFile(path.join(out,'check.json'),JSON.stringify({passed:true,frames:[{file:'output/mock.png'}],issues:[]}));
if(operation==='review')await fs.writeFile(path.join(out,'review.json'),JSON.stringify({reviewed:['output/mock.png'],issues:[],corrections:[]}));
if(operation==='render'){await fs.writeFile(path.join(out,'film.mp4'),Buffer.alloc(2048,mode==='2d'?2:3));await fs.writeFile(path.join(out,'validation.json'),JSON.stringify({passed:true,duration:600,width:1920,height:1080,fps:30,frameCount:18000}));}
`, { mode: 0o755 });

async function port() { const free = createServer(); await new Promise(resolve => free.listen(0, '127.0.0.1', resolve)); const value = free.address().port; await new Promise(resolve => free.close(resolve)); return value; }
async function logs() { try { return (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } }
async function steps(mode, id) { return (await logs()).filter(item => item.command === 'step' && item.mode === mode && item.id === id).map(item => item.operation); }
async function until(operation, label, maximum = 500) { for (let i = 0; i < maximum; i++) { const value = await operation(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Timeout: ' + label); }
const headers = mode => ({ Authorization: `Bearer ${workers[mode].token}`, 'Content-Type': 'application/json' });
const request = (mode, route, method = 'GET', body, tokenMode = mode) => fetch(workers[mode].base + route, { method, headers: headers(tokenMode), ...(body ? { body: JSON.stringify(body) } : {}) });
const stateFile = (mode, id) => path.join(workers[mode].jobs, '.broker-state', id, 'state-visuals.json');
async function privateState(mode, id) { return JSON.parse(await readFile(stateFile(mode, id), 'utf8')); }
async function state(mode, id, stage = 'visuals') { const response = await request(mode, `/jobs/${id}/${stage}`); assert.equal(response.status, 200); return response.json(); }
async function wait(mode, id, stage = 'visuals') { return until(async () => { const current = await state(mode, id, stage); return ['ready','failed'].includes(current.status) && current; }, `${mode}/${id}/${stage}`); }
async function submit(mode, id, payload, stage = 'visuals') { const response = await request(mode, `/jobs/${id}/${stage}`, 'POST', payload); assert.equal(response.status, 202, await response.clone().text()); return response.json(); }
async function seed(mode, id) {
  const payload = { topic: 'Interrupted ' + mode, ...(mode === '2d' ? { videoMode: mode } : {}) };
  const directory = path.join(workers[mode].jobs, id), privateDir = path.dirname(stateFile(mode, id));
  await mkdir(path.join(directory, 'output'), { recursive: true }); await mkdir(privateDir, { recursive: true });
  await writeFile(path.join(directory, 'output', mode === '2d' ? 'index.html' : 'scene.js'), 'Explicit existing mock project');
  await writeFile(path.join(privateDir, 'input-visuals.json'), JSON.stringify(payload));
  await writeFile(stateFile(mode, id), JSON.stringify({ jobId: id, stage: 'visuals', status: 'running', payloadDigest: digest(payload), createdAt: new Date().toISOString(), progress: { stage: 'authoring', completed: 0, total: 6 } }));
  return payload;
}
async function start(mode) {
  const worker = workers[mode], selectedPort = await port(); worker.base = `http://127.0.0.1:${selectedPort}`;
  await mkdir(worker.jobs, { recursive: true }); const tokenFile = path.join(temporary, mode, 'token'); await writeFile(tokenFile, worker.token, { mode: 0o600 });
  worker.child = spawn(process.execPath, [brokerFile], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(selectedPort), WORKER_VIDEO_MODE: mode, WORKER_JOBS: worker.jobs, WORKER_HOST_JOBS: worker.jobs, WORKER_HOST_CODEX_AUTH: path.join(temporary, mode, 'auth'), WORKER_TOKEN_FILE: tokenFile, WORKER_DOCKER_BIN: docker }, stdio: ['ignore','pipe','pipe'] });
  worker.child.stdout.on('data', bytes => worker.output += bytes); worker.child.stderr.on('data', bytes => worker.output += bytes);
  await until(async () => { if (worker.child.exitCode !== null) throw Error('Broker stopped: ' + worker.output); try { return (await fetch(worker.base + '/health')).status === 401; } catch { return false; } }, mode + ' startup');
}
async function release(mode, id) { await writeFile(path.join(workers[mode].jobs, id, 'mock-release'), 'release'); }
const held = [];
try {
  const recovery2 = key(102), recovery3 = key(103), payload2 = await seed('2d', recovery2), payload3 = await seed('3d', recovery3);
  const previous3 = await readFile(stateFile('3d', recovery3));
  await start('2d');
  let calls = await logs();
  assert.ok(calls.some(call => call.command === 'ps' && call.args.includes('label=com.routemotion.authoring=routemotion-ai-teacher-authoring-2d')));
  assert.deepEqual(calls.filter(call => call.command === 'rm').map(call => call.args.at(-1)), [oldNames['2d']]);
  assert.deepEqual(await readFile(stateFile('3d', recovery3)), previous3, '2D recovery must not modify 3D private state');
  assert.equal((await privateState('2d', recovery2)).error.reason, 'WORKER_INTERRUPTED'); cases++;
  const before3 = calls.length; await start('3d'); calls = (await logs()).slice(before3);
  assert.ok(calls.some(call => call.command === 'ps' && call.args.includes('label=com.routemotion.authoring=routemotion-ai-teacher-authoring')));
  assert.deepEqual(calls.filter(call => call.command === 'rm').map(call => call.args.at(-1)), [oldNames['3d']]);
  assert.equal((await privateState('3d', recovery3)).error.reason, 'WORKER_INTERRUPTED'); cases++;

  for (const mode of ['2d','3d']) {
    const opposite = mode === '2d' ? '3d' : '2d';
    assert.equal((await request(mode, '/health', 'GET', undefined, opposite)).status, 401);
    assert.equal((await request(mode, `/jobs/${key(900)}/visuals`, 'POST', { videoMode: mode, topic: 'Wrong token' }, opposite)).status, 401);
    const health = await (await request(mode, '/health')).json(); assert.equal(health.videoMode, mode); assert.equal(health.configured, true);
    assert.equal((await request(mode, `/jobs/${key(901)}/visuals`, 'POST', { videoMode: opposite, topic: 'Wrong mode' })).status, 400);
  }
  assert.equal((await request('2d', `/jobs/${key(902)}/visuals`, 'POST', { topic: 'Missing mode is not 2D' })).status, 400); cases++;

  const sameId = key(1), second2 = key(2);
  await submit('2d', sameId, { videoMode: '2d', topic: 'Held 2D', hold: true }); held.push(['2d', sameId]);
  await until(async () => (await steps('2d', sameId)).includes('visuals'), '2D author hold');
  await submit('2d', second2, { videoMode: '2d', topic: 'Queued behind own 2D' });
  assert.equal((await state('2d', second2)).status, 'queued');
  await submit('3d', sameId, { topic: 'Legacy 3D while 2D held' });
  assert.equal((await wait('3d', sameId)).status, 'ready');
  assert.equal((await state('2d', sameId)).status, 'running'); assert.equal((await state('2d', second2)).status, 'queued');
  const imageProgress = await state('2d', sameId); assert.equal(imageProgress.progress.stage, 'images'); assert.equal(imageProgress.progress.completed, 1); assert.ok(!JSON.stringify(imageProgress).includes('DO_NOT_EXPOSE'));
  assert.deepEqual(await steps('3d', sameId), ['visuals','check','review','check','render']); cases++;
  await release('2d', sameId); assert.equal((await wait('2d', sameId)).status, 'ready'); assert.equal((await wait('2d', second2)).status, 'ready');
  assert.deepEqual(await steps('2d', sameId), ['prepare','visuals','check','review','check','render']); cases++;

  const reverseId = key(3), queued3 = key(4);
  await submit('3d', reverseId, { videoMode: '3d', topic: 'Held 3D', hold: true }); held.push(['3d', reverseId]);
  await until(async () => (await steps('3d', reverseId)).includes('visuals'), '3D author hold');
  await submit('3d', queued3, { videoMode: '3d', topic: 'Queued behind own 3D' });
  await submit('2d', reverseId, { videoMode: '2d', topic: '2D while 3D held' });
  assert.equal((await wait('2d', reverseId)).status, 'ready'); assert.equal((await state('3d', reverseId)).status, 'running'); assert.equal((await state('3d', queued3)).status, 'queued'); cases++;
  const scriptId = key(5); await submit('2d', scriptId, { videoMode: '2d', title: 'Independent 2D script' }, 'script'); assert.equal((await wait('2d', scriptId, 'script')).status, 'ready');
  await release('3d', reverseId); assert.equal((await wait('3d', reverseId)).status, 'ready'); assert.equal((await wait('3d', queued3)).status, 'ready'); cases++;

  await submit('2d', recovery2, payload2); assert.equal((await wait('2d', recovery2)).status, 'ready');
  assert.equal((await privateState('2d', recovery2)).resumeExistingProject, true); assert.deepEqual(await steps('2d', recovery2), ['prepare','check','review','check','render']);
  await submit('3d', recovery3, payload3); assert.equal((await wait('3d', recovery3)).status, 'ready'); assert.deepEqual(await steps('3d', recovery3), ['check','review','check','render']); cases++;

  const retryId = key(6), wave = Buffer.alloc(4096, 1); wave.write('RIFF', 0); wave.write('WAVE', 8);
  const wavePath = path.join(workers['2d'].jobs, retryId, 'audio', 'chapter.wav'), waveHash = createHash('sha256').update(wave).digest('hex');
  const upload = () => fetch(workers['2d'].base + `/jobs/${retryId}/assets/chapter.wav`, { method: 'PUT', headers: { Authorization: headers('2d').Authorization, 'Content-Type': 'audio/wav', 'X-Content-SHA256': waveHash }, body: wave });
  assert.equal((await upload()).status, 200); const prior = await stat(wavePath, { bigint: true });
  const retryPayload = { videoMode: '2d', topic: 'Cached audio retry', prepareFailOnce: true };
  await submit('2d', retryId, retryPayload); const failed = await wait('2d', retryId); assert.equal(failed.status, 'failed'); assert.equal(failed.error.reason, 'ALIGNMENT_FAILED'); assert.equal(failed.error.stage, 'alignment');
  assert.equal((await upload()).status, 200); assert.equal((await stat(wavePath, { bigint: true })).ino, prior.ino); assert.equal((await stat(wavePath, { bigint: true })).mtimeNs, prior.mtimeNs); assert.deepEqual(await readFile(wavePath), wave);
  await submit('2d', retryId, retryPayload); assert.equal((await wait('2d', retryId)).status, 'ready'); assert.deepEqual(await steps('2d', retryId), ['prepare','prepare','visuals','check','review','check','render']); cases++;

  const runCalls = (await logs()).filter(call => call.command === 'step');
  for (const call of runCalls) {
    assert.equal(call.args[call.args.indexOf('--pids-limit') + 1], call.mode === '2d' && call.runtime.includes('render') ? '768' : '256', 'Only the two-browser 2D renderer gets the larger process budget');
    assert.match(call.name, call.mode === '2d' ? /^aiteacher2d-(author|render)-/ : /^aiteacher-(author|render)-/);
    assert.deepEqual(call.owner, [`com.routemotion.authoring=routemotion-ai-teacher-authoring${call.mode === '2d' ? '-2d' : ''}`]);
    assert.equal(call.runtime, `/runtime/${call.runtime.includes('render') ? 'render' : 'author'}${call.mode === '2d' ? '2d' : ''}.mjs`);
    if (call.mode === '2d' && call.runtime.includes('author')) assert.ok(call.args.some(arg => arg.endsWith('dst=/codex/generated_images')));
  }
  assert.ok(!JSON.stringify((await logs()).filter(call => call.command === 'step')).includes(workers['2d'].token)); cases++;
  console.log(`Broker modes fixture passed ${cases} cases: isolated queues in both directions, credentials, namespaces/recovery, mode rejection, legacy3D, 2Dprepare/review/render and cached-audio retry. Docker/auth/media/render are explicit test doubles.`);
} finally {
  for (const [mode, id] of held) await release(mode, id).catch(() => {});
  for (const worker of Object.values(workers)) if (worker.child?.exitCode === null) { worker.child.kill('SIGTERM'); await new Promise(resolve => worker.child.once('exit', resolve)); }
  await rm(temporary, { recursive: true, force: true });
}
