import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('isolated author receives the chosen language for script, scene labels and review without calling Codex',{timeout:15000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'author-language-'));
 try{
  const cli=path.join(root,'mock-codex.mjs');
  await writeFile(cli,`#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nlet text='';for await(const chunk of process.stdin)text+=chunk;await fs.writeFile('prompt.txt',text);\nconst target=process.argv[process.argv.indexOf('--output-last-message')+1];\nif(process.argv.includes('--output-schema'))await fs.writeFile(target,JSON.stringify({title:'Synthetic lesson',chapters:Array.from({length:3},(_,c)=>({id:'c'+c,cues:Array.from({length:4},(_,i)=>({id:'c'+c+'-'+i,text:'Only synthetic narration'}))}))}));else await fs.writeFile(target,'Synthetic completion');\n`,{mode:0o700});
  for(const [language,expected]of [['ru','Russian'],['kaa','Karakalpak (Qaraqalpaq tili)'],['uz','Uzbek (O‘zbek tili, Latin script']] as const){
   for(const mode of ['script','visuals','review'])await t.test(`${language} ${mode}`,async()=>{
    const job=path.join(root,language+'-'+mode);await mkdir(job);await writeFile(path.join(job,'input.json'),JSON.stringify({language,voiceModel:'gemini-3.8-flash-tts',title:'Topic'}));
    await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../worker/author.mjs',import.meta.url)),mode],{env:{PATH:process.env.PATH,CODEX_JOB_DIR:job,CODEX_BIN:cli,CODEX_MODEL:'gpt-6-astra',CODEX_REASONING_EFFORT:'ultra'},stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',data=>errors+=data);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`Author failed ${code}: ${errors}`)));});
    const prompt=await readFile(path.join(job,'prompt.txt'),'utf8');assert.ok(prompt.includes(`Use the exact selected language, ${expected}`));assert.ok(prompt.includes('for every spoken sentence and educational label'));
    if(language==='uz')assert.ok(!prompt.includes('selected language, Russian,'));
    if(mode==='script'){const script=JSON.parse(await readFile(path.join(job,'output/script.json'),'utf8'));assert.equal(script.chapters.length,3);assert.equal(script.chapters[0].narration,script.chapters[0].cues.map((c:any)=>c.text).join('\n\n'));}
   });
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
