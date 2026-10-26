import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const width=1280,height=720,fps=24;
const safeId=/^[a-z0-9][a-z0-9-]{0,63}$/;
const mime={'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.bin':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2'};
const fileName=fileURLToPath(import.meta.url);
function check(value,message){if(!value)throw new Error(message);}
async function atomic(file,data){await fs.writeFile(file+'.render-tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});await fs.rename(file+'.render-tmp',file);}
async function regular(file,max=64*1024*1024){const info=await fs.lstat(file);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=max,`Invalid local file: ${path.basename(file)}`);return info;}
async function packageDirectory(runtime,name){
  for(const base of [runtime,path.dirname(fileName),path.resolve(path.dirname(fileName),'..')]){
    const candidate=path.join(base,'node_modules',name);try{await regular(path.join(candidate,'package.json'));return candidate;}catch{}
    try{const require=createRequire(path.join(base,'render-dependencies.cjs'));return path.dirname(require.resolve(name+'/package.json'));}catch{}
  }throw new Error(`Missing renderer dependency: ${name}`);
}
async function run(command,args,{limit=8*1024*1024,timeout=60000}={}){
  return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${path.basename(command)} timed out`));},timeout);
    child.stdout.on('data',chunk=>{if(out.length<limit)out+=chunk;});child.stderr.on('data',chunk=>{err=(err+chunk).slice(-16000);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(out);else reject(new Error(`${path.basename(command)} failed (${code}): ${err.slice(-2000)}`));});});
}
async function probe(file,ffprobe){return JSON.parse(await run(ffprobe,['-v','error','-show_format','-show_streams','-count_frames','-of','json',file],{timeout:120000}));}
function rate(value){if(typeof value!=='string')return Number(value);const[a,b='1']=value.split('/');return Number(a)/Number(b);}

export function rendererDriverConfig(driver=process.env.WORKER_RENDER_DRIVER??'swiftshader'){
  check(['swiftshader','llvmpipe'].includes(driver),'WORKER_RENDER_DRIVER must be swiftshader or llvmpipe');
  return driver==='llvmpipe'?{driver,args:['--use-gl=angle','--use-angle=gl-egl','--ignore-gpu-blocklist','--ozone-platform=headless'],env:{EGL_PLATFORM:'surfaceless',LIBGL_ALWAYS_SOFTWARE:'true',GALLIUM_DRIVER:'llvmpipe'}}:{driver,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader'],env:{}};
}
/** Browser-process CDP is outside the generated page and cannot be forged by scene code. */
export async function verifyRendererDriver(browser,driver){
  driver=rendererDriverConfig(driver).driver;const session=await browser.newBrowserCDPSession();
  try{const info=await session.send('SystemInfo.getInfo'),attributes=info.gpu?.auxAttributes,actual=attributes?.glRenderer,expected=driver==='llvmpipe'?/llvmpipe/i:/swiftshader/i,other=driver==='llvmpipe'?/swiftshader/i:/llvmpipe/i;
    check(typeof actual==='string'&&actual.length<=2048&&expected.test(actual)&&!other.test(actual),`Requested ${driver} renderer is not active; actual renderer: ${typeof actual==='string'?actual.slice(0,240):'unavailable'}`);
    const text=value=>typeof value==='string'?value.slice(0,2048):null;return{driver,browserVersion:browser.version(),glRenderer:actual,glVendor:text(attributes.glVendor),glVersion:text(attributes.glVersion),displayType:text(attributes.displayType),verifiedAt:new Date().toISOString()};
  }finally{await session.detach();}
}

/** Analyze actual Chromium PNG output rather than trusting scene state or placeholders. */
export function pngStatistics(png){
  check(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Screenshot is not PNG');let w=0,h=0,channels=0;const blocks=[];
  for(let p=8;p+12<=png.length;){const length=png.readUInt32BE(p),type=png.toString('ascii',p+4,p+8),start=p+8;check(start+length+4<=png.length,'Truncated PNG');
    if(type==='IHDR'){w=png.readUInt32BE(start);h=png.readUInt32BE(start+4);check(png[start+8]===8&&[2,6].includes(png[start+9])&&png[start+12]===0,'Unsupported PNG');channels=png[start+9]===6?4:3;}
    if(type==='IDAT')blocks.push(png.subarray(start,start+length));p=start+length+4;
  }
  check(w>0&&h>0&&w<=4096&&h<=4096,'Invalid PNG dimensions');const stride=w*channels,raw=inflateSync(Buffer.concat(blocks),{maxOutputLength:(stride+1)*h});check(raw.length===(stride+1)*h,'Invalid PNG pixels');
  let previous=Buffer.alloc(stride),minimum=255,maximum=0,sum=0,squared=0,count=0;const samples=[];
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<h;y++){const filter=raw[y*(stride+1)],row=Buffer.from(raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)));check(filter<=4,'Invalid PNG filter');
    for(let x=0;x<stride;x++){const a=x>=channels?row[x-channels]:0,b=previous[x],c=x>=channels?previous[x-channels]:0;row[x]=(row[x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;}
    if(y%4===0)for(let x=0;x<w;x+=4){const i=x*channels,luma=.2126*row[i]+.7152*row[i+1]+.0722*row[i+2];minimum=Math.min(minimum,luma);maximum=Math.max(maximum,luma);sum+=luma;squared+=luma*luma;count++;samples.push(luma);}previous=row;
  }
  const mean=sum/count,deviation=Math.sqrt(Math.max(0,squared/count-mean*mean)),contrastFraction=samples.filter(value=>Math.abs(value-mean)>12).length/count;
  return{width:w,height:h,mean:Number(mean.toFixed(3)),deviation:Number(deviation.toFixed(3)),range:Number((maximum-minimum).toFixed(3)),contrastFraction:Number(contrastFraction.toFixed(6)),blank:deviation<3||maximum-minimum<16||contrastFraction<.003};
}
function manifestFor(input,duration){
  check(input&&typeof input==='object'&&!Array.isArray(input),'Missing lesson manifest');check(Number.isFinite(input.duration)&&Math.abs(input.duration-duration)<=.001,'Manifest must have the exact target duration');check(Array.isArray(input.chapters)&&input.chapters.length>0&&input.chapters.length<=40,'Invalid chapter list');
  let end=0;const chapters=new Set(),cues=new Set();for(const chapter of input.chapters){check(safeId.test(chapter.id)&&!chapters.has(chapter.id),'Invalid or duplicate chapter ID');chapters.add(chapter.id);check(Number.isFinite(chapter.start)&&Math.abs(chapter.start-end)<.001&&Number.isFinite(chapter.duration)&&chapter.duration>0,'Chapter timeline is not contiguous');
    check(Array.isArray(chapter.cues)&&chapter.cues.length>0,'Every chapter needs phrase cues');let cueEnd=chapter.start;
    for(const cue of chapter.cues){check(safeId.test(cue.id)&&!cues.has(cue.id),'Invalid or duplicate cue ID');cues.add(cue.id);check(typeof cue.text==='string'&&cue.text.trim()&&typeof cue.visualAction==='string'&&cue.visualAction.trim(),'Missing cue explanation/action');check(Number.isFinite(cue.start)&&Math.abs(cue.start-cueEnd)<.001&&Number.isFinite(cue.audioDuration)&&cue.audioDuration>0&&Number.isFinite(cue.duration)&&cue.duration>=cue.audioDuration&&cue.duration-cue.audioDuration<=3.001,'Cue timing is invalid');cueEnd=cue.start+cue.duration;}
    check(Math.abs(cueEnd-chapter.start-chapter.duration)<.001,'Cue timing does not match the chapter');end=chapter.start+chapter.duration;
  }check(Math.abs(end-duration)<.001,'Chapter timeline does not match duration');return input;
}
async function serveFiles(output,runtime){
  const three=await packageDirectory(runtime,'three');let gsap;try{gsap=await packageDirectory(runtime,'gsap');}catch{}
  const assetRoots=[path.join(runtime,'assets'),path.join(path.dirname(fileName),'assets'),path.resolve(path.dirname(fileName),'../client/public')],blocked=[];
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://renderer');if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    if(url.pathname==='/'){
      res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'");
      res.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}#stage{position:relative;width:${width}px;height:${height}px;overflow:hidden}canvas{position:absolute;inset:0;width:100%;height:100%}#overlay{position:absolute;inset:0;pointer-events:none}*{box-sizing:border-box;animation:none!important;transition:none!important;caret-color:transparent!important}</style><script type="importmap">${JSON.stringify({imports:{three:'/runtime/three/three.module.js','three/addons/':'/runtime/three/addons/',...(gsap?{gsap:'/runtime/gsap/index.js','gsap/':'/runtime/gsap/'}:{})}})}</script></head><body><main id="stage" data-composition-id="lesson" data-duration="600"><canvas id="canvas" width="${width}" height="${height}"></canvas><div id="overlay"></div></main><script type="module">import * as THREE from 'three';import {createLesson} from '/output/scene.js';const manifest=await(await fetch('/manifest.json')).json();await document.fonts.ready;const lesson=await createLesson({THREE,canvas:document.querySelector('#canvas'),overlay:document.querySelector('#overlay'),width:${width},height:${height},manifest});if(!lesson||typeof lesson.renderAt!=='function'||typeof lesson.dispose!=='function')throw new Error('createLesson must return renderAt and dispose');window.__lesson=lesson;Object.defineProperty(window,'__seek',{value:async(t)=>{const before=window.__getRenderMetrics();await lesson.renderAt(t);const after=window.__getRenderMetrics();if(!after.webglContexts||after.drawCalls<=before.drawCalls)throw new Error('Every renderAt must draw actual WebGL geometry on the supplied canvas');window.dispatchEvent(new CustomEvent('hf-seek',{detail:{time:t}}));await document.fonts.ready;return{webglContexts:after.webglContexts,drawCalls:after.drawCalls-before.drawCalls,totalDrawCalls:after.drawCalls};},writable:false,configurable:false});window.__ready=true;</script></body></html>`);return;
    }
    if(url.pathname==='/manifest.json'){res.setHeader('Content-Type','application/json');res.end(server.manifest);return;}
    let base,file;if(url.pathname.startsWith('/output/')){base=output;file=path.join(base,decodeURIComponent(url.pathname.slice(8)));}
    else if(url.pathname==='/runtime/three/three.module.js'||url.pathname==='/runtime/three/three.core.js'){base=path.join(three,'build');file=path.join(base,path.basename(url.pathname));}
    else if(url.pathname.startsWith('/runtime/three/addons/')){base=path.join(three,'examples/jsm');file=path.join(base,decodeURIComponent(url.pathname.slice('/runtime/three/addons/'.length)));}
    else if(gsap&&url.pathname.startsWith('/runtime/gsap/')){base=gsap;file=path.join(base,decodeURIComponent(url.pathname.slice('/runtime/gsap/'.length)));}
    else if(url.pathname.startsWith('/assets/')){
      const name=decodeURIComponent(url.pathname.slice(8));check(!name.includes('..')&&!path.isAbsolute(name),'Invalid asset path');
      for(const root of assetRoots){const candidate=path.join(root,name==='car-concept.glb'&&root.endsWith('/public')?'models/cinema/car-concept.glb':name==='Unbounded.ttf'&&root.endsWith('/public')?'fonts/Unbounded.ttf':name);try{await regular(candidate);base=root;file=candidate;break;}catch{}}
    }
    check(base&&file&&mime[path.extname(file).toLowerCase()],'Asset is not allowed');const actual=await fs.realpath(file),root=await fs.realpath(base);check(actual.startsWith(root+path.sep),'Asset path leaves its directory');await regular(actual);res.setHeader('Content-Type',mime[path.extname(actual).toLowerCase()]);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');if(req.method==='HEAD'){res.end();return;}createReadStream(actual).on('error',()=>res.destroy()).pipe(res);
  }catch{blocked.push(req.url?.slice(0,200));res.writeHead(404);res.end('Local asset is unavailable');}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return{server,origin:`http://127.0.0.1:${server.address().port}`,blocked};
}
async function launch(runtime,origin,{antialiasOverride,preserveDrawingBufferOverride}={}){
  const directory=await packageDirectory(runtime,'playwright-core'),{chromium}=await import(pathToFileURL(path.join(directory,'index.mjs')).href),executable=process.env.CHROME_BIN||process.env.CHROMIUM_EXECUTABLE_PATH||process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const config=rendererDriverConfig(),browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),env:{...process.env,...config.env},args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--no-first-run','--disable-default-apps','--autoplay-policy=no-user-gesture-required',...config.args,'--hide-scrollbars','--force-color-profile=srgb']});
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,locale:'ru-RU',timezoneId:'UTC',reducedMotion:'no-preference',serviceWorkers:'block',permissions:[]});
  const errors=[],network=[];await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();network.push(url.origin);await route.abort('blockedbyclient');});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message.slice(0,1000)));page.on('console',message=>{if(message.type()==='error')errors.push(message.text().slice(0,1000));});
  // Three.js itself generates UUIDs with Math.random during construction. Seed it;
  // per-frame use still fails the forward/reverse pixel comparison.
  await page.addInitScript(({antialiasOverride,preserveDrawingBufferOverride})=>{
    let seed=0x817a3b;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const metrics={webglContexts:0,drawCalls:0},seen=new WeakSet(),original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){const webgl=this.id==='canvas'&&['webgl','webgl2','experimental-webgl'].includes(kind);if(webgl&&typeof antialiasOverride==='boolean')args[0]={...(args[0]||{}),antialias:antialiasOverride};if(webgl&&typeof preserveDrawingBufferOverride==='boolean')args[0]={...(args[0]||{}),preserveDrawingBuffer:preserveDrawingBufferOverride};const context=original.call(this,kind,...args);if(webgl&&context&&!seen.has(context)){seen.add(context);metrics.webglContexts++;if(typeof antialiasOverride==='boolean')Object.defineProperty(window,'__benchmarkContextAttributes',{value:context.getContextAttributes(),writable:false,configurable:false});}return context;};
    for(const Constructor of [window.WebGLRenderingContext,window.WebGL2RenderingContext].filter(Boolean))for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
      const draw=Constructor.prototype[name];if(typeof draw!=='function')continue;Constructor.prototype[name]=function(...args){if(this.canvas?.id==='canvas')metrics.drawCalls++;return draw.apply(this,args);};
    }
    Object.defineProperty(window,'__getRenderMetrics',{value:()=>({...metrics}),writable:false,configurable:false});
  },{antialiasOverride,preserveDrawingBufferOverride});
  return{browser,context,page,errors,network,driver:config.driver};
}

function benchmarkEncoder(directory,frameCount,ffmpeg){
  const target=path.join(directory,'sample.mp4'),started=performance.now(),duration=frameCount/fps,diagnostics={frameCount,duration,writeCalls:0,drainCount:0,writeMs:0,drainMs:0},child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostats','-stats_period','0.25','-progress','pipe:3','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-map','0:v:0','-an','-c:v','libx264','-preset','veryfast','-crf','20','-maxrate','5M','-bufsize','10M','-pix_fmt','yuv420p','-threads','2','-t',String(duration),'-frames:v',String(frameCount),target],{stdio:['pipe','ignore','pipe','pipe']});
  let stderr='',failure,progress='';child.on('error',error=>{failure=error;});child.stdin.on('error',error=>{failure=error;});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
  child.stdio[3].on('data',chunk=>{progress+=chunk;let end;while((end=progress.indexOf('\n'))>=0){const line=progress.slice(0,end).trim();progress=progress.slice(end+1);const i=line.indexOf('=');if(i<0)continue;const key=line.slice(0,i),value=line.slice(i+1);if(key==='frame'){diagnostics.lastFrame=Number(value);if(Number(value)>0&&diagnostics.firstProgressMs===undefined)diagnostics.firstProgressMs=performance.now()-started;}if(['fps','speed','out_time_us'].includes(key))diagnostics[key]=value;}});
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));
  return{diagnostics,target,async write(bytes){if(failure)throw failure;check(child.exitCode===null,'Benchmark encoder ended before all frames');const startedWrite=performance.now(),accepted=child.stdin.write(bytes),written=performance.now();let drainMs=0;diagnostics.writeCalls++;
    if(!accepted){diagnostics.drainCount++;const waiting=performance.now();await Promise.race([once(child.stdin,'drain'),closed.then(()=>{throw new Error('Benchmark encoder closed during backpressure');})]);drainMs=performance.now()-waiting;}
    const writeMs=written-startedWrite;diagnostics.writeMs+=writeMs;diagnostics.drainMs+=drainMs;return{writeMs,drainMs};
  },async finish(ffprobe){child.stdin.end();let timeout;const code=await Promise.race([closed,new Promise((_,reject)=>{timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Benchmark encoder did not finish'));},120000);})]).finally(()=>clearTimeout(timeout));check(code===0&&!failure,`Benchmark FFmpeg failed: ${stderr.slice(-2000)}`);
    const info=await probe(target,ffprobe),video=info.streams?.find(stream=>stream.codec_type==='video'),actualFrames=Number(video?.nb_read_frames||video?.nb_frames),actualDuration=Number(info.format?.duration);check(video&&video.width===width&&video.height===height&&Math.abs(rate(video.avg_frame_rate)-fps)<.001&&actualFrames===frameCount&&Math.abs(actualDuration-duration)<.05,`Benchmark sample has wrong dimensions, duration or frame count: ${JSON.stringify({actualDuration,duration,actualFrames,frameCount,width:video?.width,height:video?.height})}`);
    diagnostics.elapsedMs=performance.now()-started;diagnostics.probe={duration:actualDuration,frameCount:actualFrames,width:video.width,height:video.height,fps:rate(video.avg_frame_rate)};diagnostics.file=`output/perf/${path.basename(directory)}/sample.mp4`;return diagnostics;
  },async dispose(){if(child.exitCode===null){child.stdin.destroy();child.kill('SIGKILL');}await closed;}};
}

/** Isolated profiling only: no audio reads, project edits or readiness reports. */
export async function runBenchmark({jobDir,runtimeDir,duration=600,antialias=true,preserveDrawingBuffer,captureFromSurface=true,encodeSample=false,warmupFrames=0,framesPerScene=6,times=[6.9,102.7,425.9,498.7]}={}){
  check(typeof antialias==='boolean','Benchmark antialias must be true or false');check(Number.isInteger(framesPerScene)&&framesPerScene>=1&&framesPerScene<=24,'Invalid benchmark frame count');
  check(preserveDrawingBuffer===undefined||typeof preserveDrawingBuffer==='boolean','Invalid benchmark drawing buffer option');check(typeof captureFromSurface==='boolean'&&typeof encodeSample==='boolean','Invalid benchmark capture/encode option');
  check(Number.isInteger(warmupFrames)&&warmupFrames>=0&&warmupFrames<=10,'Invalid benchmark warmup count');
  check(Array.isArray(times)&&times.length>0&&times.length<=8&&times.every(time=>Number.isFinite(time)&&time>=0&&time+(framesPerScene-1)/fps<duration),'Invalid benchmark scene times');
  check(Number.isFinite(duration)&&duration>0&&duration<=600&&Number.isInteger(duration*fps),'Invalid benchmark duration');
  const job=path.resolve(jobDir||process.env.WORKER_JOB_DIR||process.env.CODEX_JOB_DIR||'/job'),runtime=path.resolve(runtimeDir||process.env.WORKER_RUNTIME_DIR||'/runtime'),output=path.join(job,'output'),runId=randomUUID(),perf=path.join(output,'perf');
  await fs.mkdir(perf,{recursive:true,mode:0o700});const perfInfo=await fs.lstat(perf);check(perfInfo.isDirectory()&&!perfInfo.isSymbolicLink(),'Invalid benchmark output directory');
  const directory=path.join(perf,`aa-${antialias?'true':'false'}-${runId}`);await fs.mkdir(directory,{mode:0o700});const reportFile=path.join(directory,'report.json'),started=performance.now();let serving,browser,session,encoder;
  const report={kind:'isolated-render-benchmark',passed:false,runId,width,height,fps,duration,requestedAntialias:antialias,requestedPreserveDrawingBuffer:preserveDrawingBuffer,captureFromSurface,encodeSample,warmupFrames,framesPerScene,sceneTimes:times,scenes:[],issues:[],startedAt:new Date().toISOString()};
  try{
    await regular(path.join(job,'input.json'),2*1024*1024);const manifest=manifestFor(JSON.parse(await fs.readFile(path.join(job,'input.json'),'utf8')),duration);await regular(path.join(output,'scene.js'),2*1024*1024);
    serving=await serveFiles(output,runtime);serving.server.manifest=JSON.stringify(manifest);const launched=await launch(runtime,serving.origin,{antialiasOverride:antialias,preserveDrawingBufferOverride:preserveDrawingBuffer});browser=launched.browser;
    await launched.page.goto(serving.origin,{waitUntil:'load',timeout:60000});check(!launched.errors.length,launched.errors.join('\n'));await launched.page.waitForFunction(()=>window.__ready===true,undefined,{timeout:60000});
    report.renderer=await verifyRendererDriver(browser,launched.driver);report.startupMs=performance.now()-started;report.contextAttributes=await launched.page.evaluate(()=>window.__benchmarkContextAttributes);check(report.contextAttributes&&report.contextAttributes.antialias===antialias,'Requested benchmark antialias was not applied');if(preserveDrawingBuffer!==undefined)check(report.contextAttributes.preserveDrawingBuffer===preserveDrawingBuffer,'Requested benchmark drawing buffer was not applied');
    session=await launched.page.context().newCDPSession(launched.page);await session.send('Page.enable');
    if(encodeSample)encoder=benchmarkEncoder(directory,times.length*framesPerScene,process.env.FFMPEG_BIN||'ffmpeg');
    for(const[index,time]of times.entries()){
      const scene={time,frames:[],warmup:[]};report.scenes.push(scene);
      for(let frame=0;frame<warmupFrames;frame++){const start=performance.now(),value=await session.send('Runtime.evaluate',{expression:`window.__seek(${time})`,awaitPromise:true,returnByValue:true}),sought=performance.now();check(!value.exceptionDetails&&value.result?.value?.drawCalls>0,'Benchmark warmup must draw actual WebGL');const image=await session.send('Page.captureScreenshot',{format:'jpeg',quality:88,fromSurface:captureFromSurface,optimizeForSpeed:true,captureBeyondViewport:false}),captured=performance.now();check(image.data?.length>1000,'Benchmark warmup capture is empty');scene.warmup.push({seekMs:sought-start,captureMs:captured-sought,totalMs:captured-start,webgl:value.result.value});}
      const sceneStarted=performance.now();
      for(let frame=0;frame<framesPerScene;frame++){
        const frameTime=time+frame/fps,frameStarted=performance.now(),value=await session.send('Runtime.evaluate',{expression:`window.__seek(${frameTime})`,awaitPromise:true,returnByValue:true}),seekFinished=performance.now();
        check(!value.exceptionDetails,'Generated renderAt failed during benchmark');const webgl=value.result?.value;check(webgl?.webglContexts>0&&webgl?.drawCalls>0,'Benchmark frame has no actual WebGL draw');
        const image=await session.send('Page.captureScreenshot',{format:'jpeg',quality:88,fromSurface:captureFromSurface,optimizeForSpeed:true,captureBeyondViewport:false}),captured=performance.now(),bytes=Buffer.from(image.data,'base64');check(bytes.length>1000,'Benchmark frame capture is empty');const enqueue=encoder?await encoder.write(bytes):{writeMs:0,drainMs:0};
        scene.frames.push({time:frameTime,seekMs:seekFinished-frameStarted,captureMs:captured-seekFinished,...enqueue,totalMs:performance.now()-frameStarted,jpegBytes:bytes.length,webgl});
      }
      scene.measuredMs=performance.now()-sceneStarted;for(const key of ['seekMs','captureMs','writeMs','drainMs','totalMs'])scene[key]=scene.frames.reduce((sum,frame)=>sum+frame[key],0);
      const png=await session.send('Page.captureScreenshot',{format:'png',fromSurface:captureFromSurface,optimizeForSpeed:true,captureBeyondViewport:false}),bytes=Buffer.from(png.data,'base64'),name=`scene-${index}-${time.toFixed(3)}.png`;await fs.writeFile(path.join(directory,name),bytes,{mode:0o600});scene.quality={time:scene.frames.at(-1).time,file:`output/perf/${path.basename(directory)}/${name}`,sha256:createHash('sha256').update(bytes).digest('hex'),...pngStatistics(bytes)};
      if(scene.quality.blank)report.issues.push(`Blank or nearly blank benchmark scene at ${time}`);if(scene.quality.width!==width||scene.quality.height!==height)report.issues.push(`Benchmark screenshot dimensions differ from viewport: ${scene.quality.width}x${scene.quality.height}`);await atomic(reportFile,report);
    }
    if(encoder)report.encoder=await encoder.finish(process.env.FFPROBE_BIN||'ffprobe');report.renderer=await verifyRendererDriver(browser,launched.driver);report.issues.push(...launched.errors.map(message=>`Browser: ${message}`),...launched.network.map(origin=>`External network blocked: ${origin}`),...serving.blocked.map(url=>`Unavailable local asset: ${url}`));
    const frames=report.scenes.flatMap(scene=>scene.frames);report.frameCount=frames.length;report.meanSeekMs=frames.reduce((sum,frame)=>sum+frame.seekMs,0)/frames.length;report.meanCaptureMs=frames.reduce((sum,frame)=>sum+frame.captureMs,0)/frames.length;report.meanFrameMs=frames.reduce((sum,frame)=>sum+frame.totalMs,0)/frames.length;report.elapsedMs=performance.now()-started;report.passed=report.issues.length===0;report.completedAt=new Date().toISOString();await atomic(reportFile,report);check(report.passed,'Benchmark encountered visual or browser errors');return{...report,reportFile};
  }catch(error){report.issues.push(error instanceof Error?error.message:'Benchmark failed');report.elapsedMs=performance.now()-started;report.completedAt=new Date().toISOString();await atomic(reportFile,report);throw error;}
  finally{try{await encoder?.dispose();}finally{try{await session?.detach();}catch{}try{await browser?.close();}finally{if(serving)await new Promise(resolve=>serving.server.close(resolve));}}}
}
async function screenshot(page,time,file){const webgl=await page.evaluate(async t=>window.__seek(t),time);check(webgl?.webglContexts>0&&webgl?.drawCalls>0,'Screenshot has no actual WebGL draw');const bytes=await page.screenshot({type:'png',animations:'disabled',omitBackground:false});await fs.writeFile(file,bytes,{mode:0o600});return{sha256:createHash('sha256').update(bytes).digest('hex'),webgl,...pngStatistics(bytes)};}
function samples(manifest,duration){const frames=[{kind:'opening',time:0},{kind:'closing',time:Math.max(0,duration-1/fps)}];for(const chapter of manifest.chapters)for(const cue of chapter.cues)frames.push({kind:'cue',chapter:chapter.id,cue:cue.id,time:Math.min(duration-1/fps,cue.start+Math.min(cue.audioDuration/2,Math.max(0,cue.duration-.05)))});return frames.sort((a,b)=>a.time-b.time);}
async function checkFrames(page,manifest,output,duration,errors,network,blocked,runId,verifyRenderer){
  const directory=path.join(output,'frames');await fs.mkdir(directory,{recursive:true,mode:0o700});const frames=[],issues=[];
  for(const[index,sample]of samples(manifest,duration).entries()){const name=`frame-${String(index).padStart(3,'0')}-${sample.cue||sample.kind}.png`,stats=await screenshot(page,sample.time,path.join(directory,name));frames.push({...sample,file:`output/frames/${name}`,...stats});if(stats.blank)issues.push(`Blank or nearly blank frame at ${sample.time.toFixed(3)} seconds`);}
  const reverse=[];for(const frame of frames.slice().reverse()){const file=path.join(directory,`reverse-${path.basename(frame.file)}`),stats=await screenshot(page,frame.time,file),equal=stats.sha256===frame.sha256;reverse.push({time:frame.time,file:`output/frames/${path.basename(file)}`,matchesForward:equal,sha256:stats.sha256});if(!equal)issues.push(`Reverse seek changed the frame at ${frame.time.toFixed(3)} seconds`);}
  if(errors.length)issues.push(...errors.map(message=>`Browser: ${message}`));if(network.length)issues.push(...network.map(origin=>`External network blocked: ${origin}`));if(blocked.length)issues.push(...blocked.map(url=>`Unavailable local asset: ${url}`));
  const renderer=await verifyRenderer(),report={passed:issues.length===0,runId,width,height,fps,duration,renderer,frames,reverse,issues,checkedAt:new Date().toISOString()};await atomic(path.join(output,'check.json'),report);return report;
}
async function audioList(job,manifest,output,duration,ffprobe){
  const lines=['ffconcat version 1.0'];let sum=0;for(const chapter of manifest.chapters){const file=path.join(job,'audio',chapter.id+'.wav');await regular(file);const info=await probe(file,ffprobe),stream=info.streams?.find(item=>item.codec_type==='audio'),measured=Number(info.format?.duration);check(stream&&stream.sample_rate==='24000'&&stream.channels===1&&Math.abs(measured-chapter.duration)<.001,'Chapter WAV does not match its measured timeline');sum+=measured;lines.push(`file '${file.replaceAll("'","'\\''")}'`);}check(Math.abs(sum-duration)<.001,'Audio does not have the exact target duration');const file=path.join(output,'.render-audio.ffconcat');await fs.writeFile(file,lines.join('\n')+'\n',{mode:0o600});return file;
}

/** Trusted, time-driven sound design; generated scene code never supplies audio. */
export async function createAmbientBed(file,manifest,duration){
  check(Number.isFinite(duration)&&duration>0&&duration<=600,'Invalid sound-bed duration');
  const sampleRate=24000,count=Math.round(duration*sampleRate),bytes=count*2,header=Buffer.alloc(44),boundaries=manifest.chapters.slice(1).map(chapter=>chapter.start);
  check(boundaries.every(time=>Number.isFinite(time)&&time>0&&time<duration),'Invalid sound transition');
  header.write('RIFF');header.writeUInt32LE(36+bytes,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(bytes,40);
  const handle=await fs.open(file,'w',0o600),fade=Math.min(1.2,duration/6);let peak=0,squared=0;
  try{await handle.write(header);for(let offset=0;offset<count;offset+=sampleRate){const length=Math.min(sampleRate,count-offset),block=Buffer.alloc(length*2);for(let index=0;index<length;index++){
    const t=(offset+index)/sampleRate,envelope=Math.min(1,t/fade,(duration-t)/fade),breath=.85+.15*Math.sin(2*Math.PI*t/8);
    let value=.006*breath*(Math.sin(2*Math.PI*110*t)+.45*Math.sin(2*Math.PI*165*t+.2)+.28*Math.sin(2*Math.PI*220*t+.5));
    for(const boundary of boundaries){const u=(t-boundary+.08)/.6;if(u>=0&&u<1){const seconds=u*.6;value+=.018*Math.sin(Math.PI*u)**2*Math.sin(2*Math.PI*(650*seconds-350*seconds*seconds));}}
    value*=envelope;peak=Math.max(peak,Math.abs(value));squared+=value*value;block.writeInt16LE(Math.round(value*32767),index*2);
  }await handle.write(block);}}finally{await handle.close();}
  return{sampleRate,samples:count,peak,rms:Math.sqrt(squared/count),transitions:boundaries.length};
}
export function cinematicAudioFilter(duration){
  check(Number.isFinite(duration)&&duration>0&&duration<=600,'Invalid audio mix duration');
  // Speech itself is untouched. The broad midrange cut and sidechain act only
  // on the quiet bed; limiter auto-level is disabled and lookahead compensated.
  return `[1:a]aresample=48000,asplit=2[voice][key];[2:a]aresample=48000,highpass=f=80,lowpass=f=5000,equalizer=f=1000:t=o:w=4:g=-18[bed];[bed][key]sidechaincompress=threshold=0.015:ratio=8:attack=15:release=220:makeup=1[ducked];[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=0:attack=5:release=50:latency=1,atrim=end_sample=${Math.round(duration*48000)},asetpts=N/SR/TB[mixed]`;
}
export async function muxLessonAudio({silent,concat,manifest,output,duration,ffmpeg='ffmpeg',target}){
  const bed=path.join(output,'.render-soundbed.wav');
  try{const soundDesign=await createAmbientBed(bed,manifest,duration);await run(ffmpeg,['-hide_banner','-loglevel','warning','-y','-i',silent,'-f','concat','-safe','0','-i',concat,'-i',bed,'-filter_complex',cinematicAudioFilter(duration),'-map','0:v:0','-map','[mixed]','-c:v','copy','-c:a','aac','-b:a','160k','-ar','48000','-t',String(duration),'-movflags','+faststart',target],{timeout:300000});return{kind:'procedural-ambient-v1',...soundDesign};}
  finally{await fs.rm(bed,{force:true});}
}
async function encode(page,manifest,job,output,duration,ffmpeg,ffprobe,verifyRenderer){
  const concat=await audioList(job,manifest,output,duration,ffprobe),target=path.join(output,'film.mp4'),temporary=path.join(output,'.film-render.mp4'),silent=path.join(output,'.film-video.mp4'),frameCount=Math.round(duration*fps),started=Date.now();
  // FFmpeg 5 stops processing audio early when a piped video's frame limit is hit.
  // First finish the exact frame sequence, then mux the complete measured speech.
  const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-map','0:v:0','-an','-c:v','libx264','-preset','veryfast','-crf','20','-maxrate','5M','-bufsize','10M','-pix_fmt','yuv420p','-threads','2','-t',String(duration),'-frames:v',String(frameCount),silent],{stdio:['pipe','ignore','pipe']});
  let stderr='',encoderError;encoder.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);});encoder.on('error',error=>{encoderError=error;});encoder.stdin.on('error',error=>{encoderError=error;});const closed=new Promise(resolve=>encoder.once('close',code=>resolve(code)));const session=await page.context().newCDPSession(page);await session.send('Page.enable');
  try{
    for(let frame=0;frame<frameCount;frame++){
      if(encoderError)throw encoderError;check(encoder.exitCode===null,'Encoder ended before all frames');const value=await session.send('Runtime.evaluate',{expression:`window.__seek(${frame/fps})`,awaitPromise:true,returnByValue:false});check(!value.exceptionDetails,'Generated renderAt failed');
      const image=await session.send('Page.captureScreenshot',{format:'jpeg',quality:88,fromSurface:true,optimizeForSpeed:true,captureBeyondViewport:false}),bytes=Buffer.from(image.data,'base64');check(bytes.length>1000,'Frame capture is empty');if(!encoder.stdin.write(bytes))await Promise.race([once(encoder.stdin,'drain'),closed.then(()=>{throw new Error('Encoder closed while waiting for backpressure');})]);
      if(frame%240===0)await atomic(path.join(output,'render-progress.json'),{completed:frame,total:frameCount,elapsedSeconds:(Date.now()-started)/1000});
    }
    encoder.stdin.end();const code=await closed;check(code===0&&!encoderError,`FFmpeg failed: ${stderr.slice(-2000)}`);await session.detach();
    const soundDesign=await muxLessonAudio({silent,concat,manifest,output,duration,ffmpeg,target:temporary});
    const info=await probe(temporary,ffprobe),video=info.streams?.find(stream=>stream.codec_type==='video'),audio=info.streams?.find(stream=>stream.codec_type==='audio'),videoDuration=Number(video?.duration),audioDuration=Number(audio?.duration),actualDuration=Number(info.format?.duration),actualFrames=Number(video?.nb_read_frames||video?.nb_frames);
    const measured={target:duration,format:actualDuration,video:videoDuration,audio:audioDuration,frameCount:actualFrames,expectedFrames:frameCount,audioSamples:audio?.duration_ts,audioTimeBase:audio?.time_base};
    check(video&&audio&&Math.abs(actualDuration-duration)<.05&&Math.abs(videoDuration-duration)<.05&&Math.abs(audioDuration-duration)<.05,`Encoded audio/video duration differs from target: ${JSON.stringify(measured)}`);check(video.width===width&&video.height===height&&Math.abs(rate(video.avg_frame_rate)-fps)<.001&&actualFrames===frameCount,`Encoded video dimensions/frame count are invalid: ${JSON.stringify({...measured,width:video?.width,height:video?.height,fps:rate(video?.avg_frame_rate)})}`);
    const renderer=await verifyRenderer(),hash=createHash('sha256');for await(const chunk of createReadStream(temporary))hash.update(chunk);const validation={passed:true,duration:actualDuration,width,height,fps,frameCount:actualFrames,audioDuration,videoDuration,renderer,soundDesign,sha256:hash.digest('hex'),elapsedSeconds:(Date.now()-started)/1000,validatedAt:new Date().toISOString()};await fs.rename(temporary,target);await fs.rm(silent,{force:true});await atomic(path.join(output,'validation.json'),validation);await atomic(path.join(output,'render-progress.json'),{completed:frameCount,total:frameCount,elapsedSeconds:validation.elapsedSeconds});return validation;
  }catch(error){encoder.stdin.destroy();encoder.kill('SIGKILL');await closed;await fs.rm(temporary,{force:true});await fs.rm(silent,{force:true});throw error;}
}

/** The CLI always enforces 600 seconds. Trusted local fixtures may exercise this identical engine on shorter audio. */
export async function runRenderer({jobDir,runtimeDir,mode='check',duration=600}={}){
  check(['check','render'].includes(mode),'Expected check or render');check(Number.isFinite(duration)&&duration>0&&duration<=600&&Number.isInteger(duration*fps),'Invalid fixture duration');
  const job=path.resolve(jobDir||process.env.WORKER_JOB_DIR||process.env.CODEX_JOB_DIR||'/job'),runtime=path.resolve(runtimeDir||process.env.WORKER_RUNTIME_DIR||'/runtime'),output=path.join(job,'output'),runId=randomUUID();await fs.mkdir(output,{recursive:true,mode:0o700});let serving,browser;
  try{
    await regular(path.join(job,'input.json'),2*1024*1024);const manifest=manifestFor(JSON.parse(await fs.readFile(path.join(job,'input.json'),'utf8')),duration);await regular(path.join(output,'scene.js'),2*1024*1024);
    serving=await serveFiles(output,runtime);serving.server.manifest=JSON.stringify(manifest);const launched=await launch(runtime,serving.origin);browser=launched.browser;
    await launched.page.goto(serving.origin,{waitUntil:'load',timeout:60000});check(!launched.errors.length,launched.errors.join('\n'));await launched.page.waitForFunction(()=>window.__ready===true,undefined,{timeout:60000});const verifyRenderer=()=>verifyRendererDriver(browser,launched.driver);await verifyRenderer();const checked=await checkFrames(launched.page,manifest,output,duration,launched.errors,launched.network,serving.blocked,runId,verifyRenderer);check(checked.passed,'Visual checks failed; inspect output/check.json and its PNG frames');
    if(mode==='check')return checked;const validation=await encode(launched.page,manifest,job,output,duration,process.env.FFMPEG_BIN||'ffmpeg',process.env.FFPROBE_BIN||'ffprobe',verifyRenderer);check(!launched.errors.length&&!launched.network.length&&!serving.blocked.length,'Render encountered browser errors or blocked resources');return validation;
  }catch(error){const report={passed:false,runId,issues:[error instanceof Error?error.message:'Renderer failed'],checkedAt:new Date().toISOString()};if(mode==='check'){try{const previous=JSON.parse(await fs.readFile(path.join(output,'check.json'),'utf8'));if(!(previous.runId===runId&&previous.passed===false&&Array.isArray(previous.frames)&&previous.frames.length))await atomic(path.join(output,'check.json'),report);}catch{await atomic(path.join(output,'check.json'),report);}}else await atomic(path.join(output,'validation.json'),report);throw error;
  }finally{try{await browser?.close();}finally{if(serving)await new Promise(resolve=>serving.server.close(resolve));}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileName){const mode=process.argv[2]||'check';(mode==='benchmark'?Promise.resolve().then(()=>{const boolean=(name,fallback)=>{const value=process.env[name];check(value===undefined||['true','false'].includes(value),`${name} must be true or false`);return value===undefined?fallback:value==='true';};return runBenchmark({antialias:boolean('WORKER_BENCHMARK_AA',true),preserveDrawingBuffer:boolean('WORKER_BENCHMARK_PRESERVE_BUFFER',undefined),captureFromSurface:boolean('WORKER_BENCHMARK_FROM_SURFACE',true),encodeSample:boolean('WORKER_BENCHMARK_ENCODE',false),warmupFrames:Number(process.env.WORKER_BENCHMARK_WARMUP||0),framesPerScene:Number(process.env.WORKER_BENCHMARK_FRAMES||6),...(process.env.WORKER_BENCHMARK_TIMES?{times:process.env.WORKER_BENCHMARK_TIMES.split(',').map(Number)}:{})});}):runRenderer({mode,duration:600})).then(report=>console.log(JSON.stringify({passed:report.passed,duration:report.duration,frameCount:report.frameCount||null,...(report.reportFile?{reportFile:report.reportFile,meanSeekMs:report.meanSeekMs,meanCaptureMs:report.meanCaptureMs,meanFrameMs:report.meanFrameMs}:{})}))).catch(error=>{console.error(error instanceof Error?error.message:'Renderer failed');process.exitCode=1;});}
