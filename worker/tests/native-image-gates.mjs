/** Trust-boundary regression only. The Codex/Docker executables and image bytes
 * are isolated test doubles; this never invokes generation or proves PNG quality. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const author = fileURLToPath(new URL('../author2d.mjs', import.meta.url));
const broker = fileURLToPath(new URL('../broker.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temporary(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function execute(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes);
    child.stderr.on('data', bytes => stderr += bytes);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('review rejects missing native assets even when Codex exits successfully', async t => {
  const directory = await temporary(t, 'native-review-'), job = path.join(directory, 'job');
  const native = path.join(directory, 'native'), assets = path.join(job, 'output/assets');
  await fs.mkdir(native, { recursive: true });
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(job, 'input.json'), JSON.stringify({ language: 'ru' }));
  const cli = path.join(directory, 'codex.mjs');
  await fs.writeFile(cli, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>process.exit(0));\n', { mode: 0o755 });
  // Redirect just the native-image subtree. Do not inspect a real /codex mount.
  const hook = path.join(directory, 'isolated-images.mjs');
  await fs.writeFile(hook, `import{promises as fs}from'node:fs';const base=${JSON.stringify(native)};const map=file=>typeof file==='string'&&(file==='/codex/generated_images'||file.startsWith('/codex/generated_images/'))?base+file.slice('/codex/generated_images'.length):file;for(const name of ['readdir','lstat','stat','readFile']){const original=fs[name];fs[name]=function(file,...args){return original.call(this,map(file),...args);};}`);
  const runReview = () => execute(process.execPath, ['--import', hook, author, 'review'], {
    ...process.env, CODEX_JOB_DIR: job, CODEX_BIN: cli, CODEX_MODEL: 'gpt-6-astra', CODEX_REASONING_EFFORT: 'ultra',
  });
  let result = await runReview();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /CODEX_IMAGE_GENERATION_FAILED/);
  assert.equal(JSON.parse(await fs.readFile(path.join(job, 'output/author-error.json'))).reason, 'IMAGE_GENERATION_FAILED');
  // Four distinct matching originals satisfy the provenance gate in review.
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.from('EXPLICIT_TEST_IMAGE_' + i);
    await fs.writeFile(path.join(native, `image-${i}.png`), bytes);
    await fs.writeFile(path.join(assets, `image-${i}.png`), bytes);
  }
  result = await runReview();
  assert.equal(result.code, 0, result.stderr);
  const proof = JSON.parse(await fs.readFile(path.join(job, 'output/image-generation-proof.json')));
  assert.equal(proof.accepted, 4);
  assert.equal(await fs.access(path.join(job, 'output/author-error.json')).then(() => true, () => false), false);
  await fs.rm(path.join(assets, 'image-3.png'));
  result = await runReview();
  assert.notEqual(result.code, 0, 'A stale successful proof must not bypass a fresh review');
  assert.equal(JSON.parse(await fs.readFile(path.join(job, 'output/author-error.json'))).reason, 'IMAGE_GENERATION_FAILED');
});

test('2D broker cannot publish explicit, continued or resumed native-image failures', async t => {
  const directory = await temporary(t, 'native-broker-'), jobs = path.join(directory, 'jobs');
  const callsFile = path.join(directory, 'calls.jsonl'), docker = path.join(directory, 'docker.mjs');
  const token = 'native-image-gate-test-' + 'x'.repeat(48), tokenFile = path.join(directory, 'token');
  await fs.mkdir(jobs, { recursive: true });
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(docker, `#!/usr/bin/env node
import{promises as fs}from'node:fs';import path from'node:path';
const args=process.argv.slice(2);if(args[0]==='ps'||args[0]==='rm')process.exit(0);if(args[0]!=='run')process.exit(1);
const operation=args.at(-1);if(operation==='auth'){console.log(JSON.stringify({configured:true,mode:'chatgpt',imageGeneration:true}));process.exit(0);}
const mount=args.find(value=>value.startsWith('type=bind,src=')&&value.endsWith('dst=/job')),job=mount.slice('type=bind,src='.length).split(',dst=')[0],out=path.join(job,'output'),id=path.basename(job);
await fs.appendFile(${JSON.stringify(callsFile)},JSON.stringify({id,operation})+'\\n');await fs.mkdir(out,{recursive:true});
const input=JSON.parse(await fs.readFile(path.join(job,'input.json'),'utf8'));
if(operation==='visuals'){await fs.writeFile(path.join(out,'index.html'),'<html>Explicit mock project</html>');if(input.authorImageFailure)await fs.writeFile(path.join(out,'author-error.json'),JSON.stringify({reason:'IMAGE_GENERATION_FAILED'}));process.exit(42);}
if(operation==='check')await fs.writeFile(path.join(out,'check.json'),JSON.stringify({passed:true,frames:[{file:'output/mock.png'}]}));
if(operation==='review'){await fs.writeFile(path.join(out,'author-error.json'),JSON.stringify({reason:'IMAGE_GENERATION_FAILED'}));process.exit(43);}
if(operation==='render')throw Error('An image failure must never render');
`, { mode: 0o755 });
  const free = createServer();
  await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
  const port = free.address().port;
  await new Promise(resolve => free.close(resolve));
  const child = spawn(process.execPath, [broker], { env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), WORKER_VIDEO_MODE: '2d', WORKER_JOBS: jobs,
    WORKER_HOST_JOBS: jobs, WORKER_HOST_CODEX_AUTH: path.join(directory, 'auth'),
    WORKER_TOKEN_FILE: tokenFile, WORKER_DOCKER_BIN: docker,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } });
  const base = `http://127.0.0.1:${port}`, headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw Error(output);
    try { if ((await fetch(base + '/health')).status === 401) break; } catch {}
    if (attempt >= 200) throw Error('Broker startup timeout');
    await sleep(20);
  }
  const key = number => number.toString(16).padStart(64, '0');
  const request = (id, method = 'GET', body) => fetch(base + `/jobs/${id}/visuals`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  async function wait(id) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const state = await (await request(id)).json();
      if (['ready', 'failed'].includes(state.status)) return state;
      await sleep(20);
    }
    throw Error('Job timeout');
  }
  for (const [number, payload, expectedSteps, resumed] of [
    [1, { videoMode: '2d', authorImageFailure: true }, ['prepare', 'visuals'], false],
    [2, { videoMode: '2d' }, ['prepare', 'visuals', 'check', 'review'], false],
    [3, { videoMode: '2d' }, ['prepare', 'check', 'review'], true],
  ]) {
    const id = key(number);
    if (resumed) {
      const privateDir = path.join(jobs, '.broker-state', id);
      await fs.mkdir(privateDir, { recursive: true });
      await fs.mkdir(path.join(jobs, id, 'output'), { recursive: true });
      await fs.writeFile(path.join(jobs, id, 'output/index.html'), '<html>Explicit existing mock project</html>');
      await fs.writeFile(path.join(privateDir, 'state-visuals.json'), JSON.stringify({
        jobId: id, stage: 'visuals', status: 'failed', payloadDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        createdAt: new Date().toISOString(), progress: { stage: 'authoring', completed: 0, total: 6 }, error: { code: 'MODEL' },
      }));
    }
    const submitted = await request(id, 'POST', payload);
    assert.equal(submitted.status, 202, await submitted.text());
    const state = await wait(id);
    assert.equal(state.status, 'failed');
    assert.equal(state.error.reason, 'IMAGE_GENERATION_FAILED');
    assert.equal(state.error.stage, number === 1 ? 'authoring' : 'reviewing');
    const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.id === id);
    assert.deepEqual(calls.map(row => row.operation), expectedSteps);
    assert.equal((await fetch(base + `/jobs/${id}/artifact`, { headers })).status, 404);
  }
});
