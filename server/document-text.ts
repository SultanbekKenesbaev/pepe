import path from 'node:path';
import { unzipSync } from 'fflate';
import { PDFParse } from 'pdf-parse';
import { ApiError } from './security.js';

export const documentMimes: Record<string, string> = {
  '.txt': 'text/plain', '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function decodeXml(text: string) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
    const known: Record<string, string> = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if (known[entity]) return known[entity];
    const value=entity.slice(2,-1), hex=value.toLowerCase().startsWith('x');
    const code=Number.parseInt(hex?value.slice(1):value,hex?16:10);
    return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';
  });
}

/** Extract locally; never execute document content or fetch external document resources. */
export async function extractDocumentText(file: Express.Multer.File, options: { allowEmptyText?: boolean } = {}): Promise<string> {
  const ext=path.extname(file.originalname).toLowerCase();
  if (ext==='.txt'||ext==='.csv') {
    let text: string;
    try { text=new TextDecoder('utf-8',{fatal:true}).decode(file.buffer).replace(/^\uFEFF/,''); }
    catch { throw new ApiError(400,'Сохраните текстовый документ в кодировке UTF-8','INVALID_DOCUMENT'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new ApiError(400,'Текстовый файл содержит двоичные данные','INVALID_DOCUMENT');
    return text;
  }
  if (ext==='.docx') {
    if (file.buffer[0]!==80||file.buffer[1]!==75) throw new ApiError(400,'Некорректный DOCX','INVALID_DOCUMENT');
    const files=unzipSync(new Uint8Array(file.buffer),{filter:f=>f.name==='word/document.xml'&&f.originalSize<8*1024*1024});
    const xml=files['word/document.xml'];
    if (!xml) throw new ApiError(400,'В DOCX отсутствует текст или документ слишком большой','INVALID_DOCUMENT');
    return decodeXml(new TextDecoder('utf-8',{fatal:true}).decode(xml).replace(/<\/w:p>|<\/w:tr>/g,'\n\n').replace(/<w:tab\b[^>]*\/>/g,'\t').replace(/<w:br\b[^>]*\/>/g,'\n').replace(/<[^>]*>/g,''));
  }
  if (ext==='.pdf') {
    if (file.buffer.subarray(0,5).toString()!=='%PDF-') throw new ApiError(400,'Некорректный PDF','INVALID_DOCUMENT');
    const parser=new PDFParse({data:new Uint8Array(file.buffer),stopAtErrors:true,isEvalSupported:false});
    try {
      const result=await parser.getText({pageJoiner:''});
      if(!result.total||result.pages.length!==result.total)throw new ApiError(400,'Некорректный PDF','INVALID_DOCUMENT');
      // Read actual page text, excluding parser-generated page-number labels.
      // A valid scan can be stored as a source without pretending OCR took place.
      const text=result.pages.map(page=>page.text).join('\n\n').trim();
      if(!text&&!options.allowEmptyText)throw new ApiError(400,'В PDF не найден текст. Для семестра нужен PDF с текстовым слоем, DOCX, TXT или CSV.','NO_EXTRACTABLE_TEXT');
      return text;
    } finally { await parser.destroy(); }
  }
  throw new ApiError(400,'Поддерживаются PDF, DOCX, TXT и CSV','UNSUPPORTED_FILE');
}
