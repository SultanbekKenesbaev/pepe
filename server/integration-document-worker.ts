// Trusted parser entry point. Uploaded content is bytes, never JavaScript or a command.
const maxInputBytes=25*1024*1024,maxHeaderBytes=4096;
const safeCodes=new Set(['INVALID_DOCUMENT','UNSUPPORTED_FILE','NO_EXTRACTABLE_TEXT','DOCUMENT_TOO_LARGE']);
let replied=false;
function reply(value:{ok:true;text:string}|{ok:false;code:string}){if(replied)return;replied=true;process.stdout.write(JSON.stringify(value));}
async function main(){
  let header:Buffer|undefined,headerBytes=Buffer.alloc(0),bytes=0;const chunks:Buffer[]=[];
  for await(const incoming of process.stdin){
    let chunk=Buffer.from(incoming);
    if(!header){const end=chunk.indexOf(10);if(end===-1){headerBytes=Buffer.concat([headerBytes,chunk]);if(headerBytes.length>maxHeaderBytes)throw new Error('INVALID_DOCUMENT');continue;}
      header=Buffer.concat([headerBytes,chunk.subarray(0,end)]);if(header.length>maxHeaderBytes)throw new Error('INVALID_DOCUMENT');chunk=chunk.subarray(end+1);
    }
    bytes+=chunk.length;if(bytes>maxInputBytes)throw new Error('INVALID_DOCUMENT');chunks.push(chunk);
  }
  if(!header)throw new Error('INVALID_DOCUMENT');const input=JSON.parse(header.toString('utf8'));
  if(typeof input.originalname!=='string'||input.originalname.length>1024||!Number.isInteger(input.bytes)||input.bytes!==bytes)throw new Error('INVALID_DOCUMENT');
  // Parser diagnostics must never contaminate the bounded JSON stdout protocol or expose source text.
  console.log=()=>{};console.warn=()=>{};console.error=()=>{};
  globalThis.fetch=async()=>{throw new Error('NETWORK_DISABLED');};
  const {extractDocumentText}=await import('./document-text.js');
  const text=(await extractDocumentText({originalname:input.originalname,buffer:Buffer.concat(chunks)} as Express.Multer.File)).trim();
  if(!text)reply({ok:false,code:'NO_EXTRACTABLE_TEXT'});
  else if(text.length>150000)reply({ok:false,code:'DOCUMENT_TOO_LARGE'});
  else reply({ok:true,text});
}
void main().catch(error=>{const code=typeof error?.code==='string'&&safeCodes.has(error.code)?error.code:'INVALID_DOCUMENT';reply({ok:false,code});});
