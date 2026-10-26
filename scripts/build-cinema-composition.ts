import path from 'node:path';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { loadCinemaManifest } from '../server/cinema.js';

const root = process.cwd(), folder = path.join(root, 'films/derivative');
const { manifest, directory } = await loadCinemaManifest(path.resolve(process.env.DATA_DIR || 'data'));
if (manifest.voice.status !== 'ready' && !process.argv.includes('--draft')) throw new Error('Подготовьте озвучку всех глав перед сборкой фильма.');
await mkdir(path.join(folder, 'assets'), { recursive: true });
await mkdir(path.join(folder, 'compositions'), { recursive: true });
for (const legacy of ['linked-changes.html', 'turning-points.html'])
  await rm(path.join(folder, 'compositions', legacy), { force: true });
await build({
  entryPoints: [path.join(root, 'client/src/lesson/DerivativeScene.tsx')],
  bundle: true, format: 'esm', platform: 'browser', outfile: path.join(folder, 'assets/scene.js'),
  minify: true, define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
  entryPoints: [path.join(root, 'client/src/lesson/lessonMotion.ts')],
  bundle: true, format: 'esm', platform: 'browser', outfile: path.join(folder, 'assets/motion.js'), minify: true,
});
await build({
  entryPoints: [path.join(root, 'client/src/lesson/sceneTheme.ts')],
  bundle: true, format: 'esm', platform: 'browser', outfile: path.join(folder, 'assets/theme.js'), minify: true,
});
await copyFile(path.join(root, 'node_modules/gsap/dist/gsap.min.js'), path.join(folder, 'assets/gsap.min.js'));
for (const [source, dest] of [
  ['client/public/cinema/derivative-bed.mp3', 'bed.mp3'],
  ['client/public/cinema/transition.mp3', 'transition.mp3'],
  ['client/public/cinema/impact.mp3', 'impact.mp3'],
  ['client/public/fonts/Unbounded.ttf', 'Unbounded.ttf'],
  ['client/public/fonts/Unbounded-OFL.txt', 'Unbounded-OFL.txt'],
  ['client/public/models/cinema/car-concept.glb', 'car-concept.glb'],
  ['client/public/models/cinema/CarConcept-CREDITS.txt', 'CarConcept-CREDITS.txt'],
]) await copyFile(path.join(root, source), path.join(folder, 'assets', dest));

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const css = (await readFile(path.join(root, 'client/src/lesson/DerivativeFilm.css'), 'utf8'))
  .replaceAll('/fonts/Unbounded.ttf', 'Unbounded.ttf')
  // The exported film has no interactive controls; their browser-clock fades
  // are omitted while presentation motion stays sampled from film time.
  .replace(/transition:[^;}]+;?/g, '');
await writeFile(path.join(folder, 'assets/film.css'), css);
const chapters = manifest.chapters.map(chapter => ({
  id: chapter.id, scene: chapter.scene, start: chapter.start, duration: chapter.duration,
  title: chapter.title, formula: chapter.formula || '', cues: chapter.cues || [],
  beats: chapter.beats || [], caption: chapter.caption || '',
}));
for (const chapter of manifest.chapters) {
  if ('audioUrl' in chapter) await copyFile(path.join(directory, chapter.id + '.wav'), path.join(folder, 'assets', chapter.id + '.wav'));
  const id = 'chapter-' + chapter.id;
  await writeFile(path.join(folder, 'compositions', chapter.id + '.html'), `<template>
  <div id="${id}" data-composition-id="${id}" data-duration="${chapter.duration}" data-width="1920" data-height="1080" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
    <div id="${id}-overlay" class="clip film-presentation" data-start="0" data-duration="${chapter.duration}" data-track-index="2"></div>
  </div></template>`);
}
const slots = manifest.chapters.map(chapter =>
  `<div id="chapter-${chapter.id}" style="position:absolute;inset:0;z-index:4;pointer-events:none" data-composition-id="chapter-${chapter.id}" data-composition-src="compositions/${chapter.id}.html" data-start="${chapter.start}" data-duration="${chapter.duration}" data-width="1920" data-height="1080" data-track-index="1"></div>`
).join('\n');
const voice = manifest.chapters.filter(chapter => 'audioUrl' in chapter).map(chapter =>
  `<audio id="voice-${chapter.id}" data-audio-group="voiceover" src="assets/${chapter.id}.wav" data-start="${chapter.start}" data-duration="${'audioDuration' in chapter ? chapter.audioDuration : chapter.duration}" data-volume="1" data-track-index="3"></audio>`
).join('\n');
const transitions = manifest.chapters.slice(1).map(chapter =>
  `<audio id="sfx-${chapter.id}" src="assets/transition.mp3" data-start="${Math.max(0, chapter.start - 1.2)}" data-duration="3.5" data-volume="0.055" data-track-index="5"></audio>`
).join('\n');
const impacts = manifest.chapters.flatMap(chapter => (chapter.beats || []).filter((_, index) => index > 0).map((beat, index) =>
  `<audio id="hit-${chapter.id}-${index}" src="assets/impact.mp3" data-start="${chapter.start + beat.at}" data-duration="2.1" data-volume="0.045" data-track-index="6"></audio>`
)).join('\n');
const index = `<!doctype html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=1920,height=1080"><title>${escape(manifest.title)}</title>
<script src="assets/gsap.min.js"></script><link rel="stylesheet" href="assets/film.css">
<style>
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#04070a}
#film{position:relative;width:1920px;height:1080px;overflow:hidden}
#film-canvas{width:100%;height:100%;position:absolute;inset:0;display:block}
.film-presentation{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
</style></head><body><div id="film" class="derivative-film" data-composition-id="derivative-film" data-width="1920" data-height="1080" data-duration="${manifest.duration}">
<canvas id="film-canvas"></canvas><div class="film-shade"></div>
${slots}
${voice}
<audio id="film-bed" src="assets/bed.mp3" data-start="0" data-duration="${manifest.duration}" data-volume="0.22" data-track-index="4"></audio>
${transitions}
${impacts}
</div><script>
window.__hf=window.__hf||{};window.__hf.buildReady=window.__hf.buildReady||{};
window.__hf.buildReady.derivative=new Promise(resolve=>window.__derivativeReady=resolve);
window.__timelines=window.__timelines||{};
</script><script type="module">
import {createDerivativeRenderer} from './assets/scene.js';
import {presentationMarkup,sceneProgressAt} from './assets/motion.js';
import {sceneThemeAt} from './assets/theme.js';
const chapters=${JSON.stringify(chapters)};
await document.fonts.ready;
const scene=createDerivativeRenderer(document.getElementById('film-canvas'),{carUrl:'./assets/car-concept.glb'});scene.resize(1920,1080,1);
await scene.ready;
function draw(time){
 const c=chapters.find(c=>time>=c.start&&time<c.start+c.duration)||chapters.at(-1);
 const p=Math.max(0,Math.min(1,(time-c.start)/c.duration)),visual=sceneProgressAt(c,p);
 document.getElementById('film').className='derivative-film film-theme-'+sceneThemeAt(c.scene,visual);
 scene.renderFrame({time:visual*60,scene:c.scene,progress:visual,playing:false});
 const overlay=document.getElementById('chapter-'+c.id+'-overlay');
 if(overlay)overlay.innerHTML=presentationMarkup(c,p,chapters.indexOf(c),chapters.length);
}
const state={time:0},tl=gsap.timeline({paused:true});
tl.to(state,{time:${manifest.duration},duration:${manifest.duration},ease:'none',onUpdate:()=>draw(state.time)});
window.__timelines['derivative-film']=tl;
window.addEventListener('hf-seek',event=>draw(event.detail.time));draw(0);window.__derivativeReady();
</script></body></html>`;
await writeFile(path.join(folder, 'index.html'), index);
await writeFile(path.join(folder, 'timing.json'), JSON.stringify({ duration: manifest.duration, voice: manifest.voice, chapters }, null, 2));
const board = await readFile(path.join(root, 'content/derivative/V3-DIRECTION.md'), 'utf8');
await writeFile(path.join(folder, 'STORYBOARD.md'), board.replace(/## Scene (\d+)/g, '## Frame $1'));
console.log(`HyperFrames composition ready: ${manifest.chapters.length} chapters, ${manifest.duration.toFixed(1)} seconds, voice ${manifest.voice.status}`);
