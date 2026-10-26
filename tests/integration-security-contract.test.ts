import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, publicAddress, webhookUrl, webhookSignature, signingVault } from '../server/integration-security.js';

// Independent pure/local checks. No DNS lookup, callback delivery or AI provider is invoked.
test('integration canonical payload keeps nested values and array order across JSONB key order', () => {
  const first={topic:'Производная',language:'ru',metadata:{z:3,a:{second:false,first:null}},file_ids:['f2','f1']};
  const reordered={file_ids:['f2','f1'],metadata:{a:{first:null,second:false},z:3},language:'ru',topic:'Производная'};
  assert.equal(canonicalJson(first),canonicalJson(reordered));
  assert.notEqual(canonicalJson(first),canonicalJson({...first,file_ids:['f1','f2']}));
  assert.notEqual(canonicalJson(first),canonicalJson({...first,topic:'Скорость'}));
  assert.deepEqual(JSON.parse(canonicalJson(first)),first);
  const unusual=JSON.parse('{"metadata":{"__proto__":"literal","constructor":"literal","escaped":"a\\nb"}}');
  assert.deepEqual(JSON.parse(canonicalJson(unusual)),unusual);
  assert.equal(({} as any).literal,undefined);
});

test('webhook IP policy closes private, metadata, mapped, transition and documentation addresses', () => {
  const denied=['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255',
    '192.0.0.1','192.0.2.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','255.255.255.255',
    '168.63.129.16','::','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::7f00:1',
    '2001:db8::1','2002:7f00:1::','3fff::1','fe80::1%en0','garbage'];
  for(const address of denied)assert.equal(publicAddress(address),false,`must deny ${address}`);
  for(const address of ['8.8.8.8','1.1.1.1','172.15.255.255','172.32.0.1','2606:4700:4700::1111','2001:4860:4860::8888']) {
    assert.equal(publicAddress(address),true,`must allow public ${address}`);
  }
});

test('webhook URL parser rejects alternate schemes, URL credentials and disguised loopback', () => {
  const denied=['http://example.com/callback','file:///etc/passwd','https://user:secret@example.com/callback',
    'https://example.com:444/callback','https://example.com/callback#secret','https://localhost/events','https://service.local/events',
    'https://service.internal/events','https://service.test/events','https://service.invalid/events','https://singlelabel/events',
    'https://127.0.0.1/events','https://2130706433/events','https://0x7f000001/events','https://0177.0.0.1/events',
    'https://[::1]/events','https://[::ffff:127.0.0.1]/events','https://169.254.169.254/latest/meta-data',
    'https://example.com/'+ 'a'.repeat(2050)];
  for(const url of denied)assert.throws(()=>webhookUrl(url),{code:'INVALID_WEBHOOK_URL'},url);
  assert.equal(webhookUrl('https://example.com/events?course=math').href,'https://example.com/events?course=math');
  assert.equal(webhookUrl('https://8.8.8.8/events').hostname,'8.8.8.8');
  // Public-looking DNS names are only syntactic candidates here. Delivery must resolve and pin every attempt.
});

test('webhook signature authenticates exact UTF-8 bytes and delivery timestamp', () => {
  const secret='synthetic-signing-key-34-characters',timestamp=1792620000;
  const body=JSON.stringify({id:'evt_synthetic',type:'generation.ready',data:{topic:'Производная — Қарақалпақ'}});
  const digest=createHmac('sha256',secret).update(String(timestamp)+'.').update(Buffer.from(body,'utf8')).digest('hex');
  assert.equal(webhookSignature(secret,timestamp,body),`t=${timestamp},v1=${digest}`);
  assert.notEqual(webhookSignature(secret,timestamp,body+' '),`t=${timestamp},v1=${digest}`);
  assert.notEqual(webhookSignature(secret,timestamp+1,body),`t=${timestamp},v1=${digest}`);
  assert.notEqual(webhookSignature('another-secret',timestamp,body),`t=${timestamp},v1=${digest}`);
});

test('webhook signing vault survives concurrent open/restart and rejects tampered ciphertext',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'integration-vault-contract-'));
  try {
    const [first,second]=await Promise.all([signingVault(temporary),signingVault(temporary)]);
    const secret='synthetic-webhook-secret',encrypted=first.encrypt(secret),again=first.encrypt(secret);
    assert.notEqual(encrypted,again);assert.equal(second.decrypt(encrypted),secret);
    assert.equal((await signingVault(temporary)).decrypt(encrypted),secret);
    const bytes=Buffer.from(encrypted,'base64');bytes[bytes.length-1]^=1;
    assert.throws(()=>second.decrypt(bytes.toString('base64')));
    assert.equal((await readFile(path.join(temporary,'secrets/integration-vault.key'))).length,32);
    assert.equal((await stat(path.join(temporary,'secrets/integration-vault.key'))).mode&0o077,0);
    assert.equal((await stat(path.join(temporary,'secrets'))).mode&0o077,0);
  } finally { await rm(temporary,{recursive:true,force:true}); }
});

test('webhook signing vault refuses symlink and invalid-sized stored keys',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'integration-vault-invalid-'));
  try {
    const outside=path.join(temporary,'unrelated-key');await writeFile(outside,Buffer.alloc(32,7));
    const linked=path.join(temporary,'linked');await mkdir(path.join(linked,'secrets'),{recursive:true});
    await symlink(outside,path.join(linked,'secrets/integration-vault.key'));
    await assert.rejects(signingVault(linked),/INTEGRATION_VAULT_INVALID/);
    assert.deepEqual(await readFile(outside),Buffer.alloc(32,7));
    const bad=path.join(temporary,'bad');await mkdir(path.join(bad,'secrets'),{recursive:true});
    await writeFile(path.join(bad,'secrets/integration-vault.key'),'not-a-32-byte-key');
    await assert.rejects(signingVault(bad),/INTEGRATION_VAULT_INVALID/);
  } finally { await rm(temporary,{recursive:true,force:true}); }
});
