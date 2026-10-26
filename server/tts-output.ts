import { pcmWave, waveDuration } from './cinema.js';

/** Only fixed, non-sensitive codes escape Google's response parser. */
export function generatedWave(payload:any):Buffer {
  const candidate=payload?.candidates?.[0],reason=candidate?.finishReason;
  const blocked=new Set(['SAFETY','BLOCKLIST','PROHIBITED_CONTENT','RECITATION','SPII','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT']);
  const promptBlock=payload?.promptFeedback?.blockReason;
  if((typeof promptBlock==='string'&&promptBlock&&promptBlock!=='BLOCK_REASON_UNSPECIFIED')||blocked.has(reason)||(Array.isArray(candidate?.safetyRatings)&&candidate.safetyRatings.some((rating:any)=>rating?.blocked===true)))throw new Error('GENERATION_TTS_BLOCKED');
  if(reason&&reason!=='STOP'&&reason!=='OTHER')throw new Error('GENERATION_TTS_INCOMPLETE');
  if(candidate?.content?.parts!==undefined&&!Array.isArray(candidate.content.parts))throw new Error('GENERATION_TTS_INVALID');
  const part=candidate?.content?.parts?.find((part:any)=>part?.inlineData?.data||part?.inline_data?.data);
  const inline=part?.inlineData||part?.inline_data;
  if(!inline)throw new Error('GENERATION_TTS_EMPTY');
  // OTHER with partial audio must never be accepted as a complete spoken cue.
  if(reason==='OTHER')throw new Error('GENERATION_TTS_INCOMPLETE');
  const mime=inline.mimeType||inline.mime_type;
  if(typeof inline.data!=='string'||inline.data.length>85*1024*1024||typeof mime!=='string'||!mime)throw new Error('GENERATION_TTS_INVALID');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(inline.data))throw new Error('GENERATION_TTS_INVALID');
  const bytes=Buffer.from(inline.data,'base64');let wave:Buffer;
  try{
    if(/^audio\/(wav|wave|x-wav)(;|$)/i.test(mime))wave=bytes;
    else if(/^audio\/(L16|pcm)(;|$)/i.test(mime)){
      const rateMatch=mime.match(/rate=(\d+)/i),channelsMatch=mime.match(/channels=(\d+)/i);
      wave=pcmWave(bytes,rateMatch?Number(rateMatch[1]):24000,channelsMatch?Number(channelsMatch[1]):1);
    }else throw new Error('GENERATION_TTS_FORMAT');
    waveDuration(wave);return wave;
  }catch(error){if(error instanceof Error&&error.message==='GENERATION_TTS_FORMAT')throw error;throw new Error('GENERATION_TTS_INVALID');}
}

/** Shared exact-transcript request for the direct Google backend. */
export function googleSpeechBody(text:string,instructions:string,model:string,voice:string) {
  if(model.startsWith('gemini-3.8-'))return {contents:[{role:'user',parts:[{text,speech_metadata:{style:instructions}}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{voice}}}};
  return {contents:[{role:'user',parts:[{text:`${instructions}\n\n<TRANSCRIPT>\n${text}\n</TRANSCRIPT>`}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}}}};
}
