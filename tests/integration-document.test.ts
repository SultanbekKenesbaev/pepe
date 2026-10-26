import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractIntegrationDocument } from '../server/integration-document.js';
import { ApiError } from '../server/security.js';

const file=(originalname:string,bytes:string|Buffer|Uint8Array)=>({originalname,buffer:typeof bytes==='string'?Buffer.from(bytes):Buffer.from(bytes),size:typeof bytes==='string'?Buffer.byteLength(bytes):bytes.length}) as Express.Multer.File;
const rejects=(operation:Promise<unknown>,code:string)=>assert.rejects(operation,(error:unknown)=>error instanceof ApiError&&error.status===422&&error.code===code);
function textPdf(){
  const stream='BT /F1 20 Tf 30 100 Td (Derivative means rate of change.) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets:number[]=[];
  for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);return pdf+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}

test('isolated subprocess extracts genuine TXT, CSV, DOCX and PDF without executing document content',{timeout:20000},async()=>{
  assert.equal(await extractIntegrationDocument(file('lesson.txt','\uFEFF  Производная — скорость изменения.\n\nМысал.  ')),'Производная — скорость изменения.\n\nМысал.');
  assert.equal(await extractIntegrationDocument(file('lesson.CSV','topic,value\nПроизводная,2')),'topic,value\nПроизводная,2');
  const document='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>График &amp; касательная</w:t></w:r></w:p><w:p><w:r><w:t>Қарақалпақ</w:t></w:r></w:p></w:body></w:document>';
  const docx=zipSync({'word/document.xml':strToU8(document),'word/_rels/document.xml.rels':strToU8('<Relationships><Relationship Target="https://invalid.example/external" TargetMode="External"/></Relationships>')});
  assert.equal(await extractIntegrationDocument(file('lesson.docx',docx)),'График & касательная\n\nҚарақалпақ');
  assert.match(await extractIntegrationDocument(file('lesson.pdf',textPdf())),/Derivative means rate of change\./);
  const temporary=await mkdtemp(path.join(os.tmpdir(),'integration-document-data-'));
  try{
    const marker=path.join(temporary,'must-not-exist');
    const content=`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`;
    assert.equal(await extractIntegrationDocument(file(`lesson-$(touch ${marker}).txt`,content)),content);
    await assert.rejects(access(marker),{code:'ENOENT'});
  }finally{await rm(temporary,{recursive:true,force:true});}
});

test('isolated parser sanitizes malformed PDF/ZIP, binary text, empty text and oversized output',{timeout:20000},async()=>{
  const sensitive='PRIVATE_DOCUMENT_CONTENT_MUST_NOT_APPEAR_IN_ERROR';
  for(const document of [file('broken.pdf','%PDF-1.4\n'+sensitive),file('broken.docx',Buffer.from('PK'+sensitive)),file('binary.txt',Buffer.from([255,254,0,1]))]){
    await assert.rejects(extractIntegrationDocument(document),(error:unknown)=>error instanceof ApiError&&error.status===422&&error.code==='INVALID_DOCUMENT'&&!error.message.includes(sensitive));
  }
  await rejects(extractIntegrationDocument(file('missing-content.docx',zipSync({'unrelated.xml':strToU8('<root/>')}))),'INVALID_DOCUMENT');
  await rejects(extractIntegrationDocument(file('blank.txt','  \n\t  ')),'NO_EXTRACTABLE_TEXT');
  await rejects(extractIntegrationDocument(file('long.txt','x'.repeat(150001))),'DOCUMENT_TOO_LARGE');
  const largeXml=zipSync({'word/document.xml':strToU8('x'.repeat(8*1024*1024))});
  await rejects(extractIntegrationDocument(file('oversized-xml.docx',largeXml)),'INVALID_DOCUMENT');
});

test('input caps, hard deadline and abort kill the parser without poisoning the next upload',{timeout:20000},async()=>{
  await rejects(extractIntegrationDocument(file('too-large.txt',Buffer.alloc(25*1024*1024+1))),'FILE_TOO_LARGE');
  await rejects(extractIntegrationDocument(file('program.js','process.exit()')),'UNSUPPORTED_FILE');
  const already=new AbortController();already.abort();await rejects(extractIntegrationDocument(file('lesson.txt','lesson'),{signal:already.signal}),'DOCUMENT_ABORTED');
  const began=Date.now();await rejects(extractIntegrationDocument(file('lesson.pdf',textPdf()),{timeoutMs:1}),'DOCUMENT_TIMEOUT');assert.ok(Date.now()-began<2000);
  const controller=new AbortController(),started=Date.now();
  const pending=extractIntegrationDocument(file('lesson.docx',zipSync({'word/document.xml':strToU8('<w:document><w:p>lesson</w:p></w:document>')})),{signal:controller.signal});
  controller.abort();await rejects(pending,'DOCUMENT_ABORTED');assert.ok(Date.now()-started<2000);
  assert.equal(await extractIntegrationDocument(file('healthy.txt','Следующая загрузка работает.')),'Следующая загрузка работает.');
});
