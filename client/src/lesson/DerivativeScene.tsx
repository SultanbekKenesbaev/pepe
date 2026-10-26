import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './DerivativeScene.css';
import { loadCarAsset } from './labCar';
import { labCueAt, labCueById } from './labCues';
import { createLabEnvironment } from './lab3DEnvironment';
import { sceneThemeAt } from './sceneTheme';
export { sceneThemeAt } from './sceneTheme';

export type DerivativeSceneKey = 'intro' | 'motion' | 'average' | 'secant' | 'limit' | 'tangent' | 'rules' | 'chain' | 'extrema' | 'outro';
export type DerivativeFrame = { time: number; scene: string; progress: number; playing: boolean };
const LIME = 0xd1ff00, WHITE = 0xf3f5e9, AMBER = 0xff753c, CYAN = 0x8cf5e6;
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a: number, b: number, x: number) => a + (b - a) * x;
const smooth = (x: number) => { const p = clamp(x); return p * p * (3 - 2 * p); };
const easeOut = (x: number) => 1 - (1 - clamp(x)) ** 4;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const gp = (x: number, y: number, z = 0) => V((x - 1.8) * 1.65, y * .49 - 2.5, z);

/** One shared mathematical clock for graphics and typeset equations. */
const cuePoint = (scene:string,id:string,fallback:number) => labCueById(scene,id)?.progress ?? fallback;
const betweenCues = (scene:string,p:number,start:string,end:string,a:number,b:number) => mix(a,b,smooth((p-cuePoint(scene,start,0))/Math.max(.0001,cuePoint(scene,end,1)-cuePoint(scene,start,0))));
export function derivativeReadout(scene: string, progress: number): { h?: number; slope?: number; t?: number; s?: number } {
  const p=clamp(Number.isFinite(progress)?progress:0),beat=Math.min(4,Math.floor(p*5)),q=p===1?1:p*5-beat;
  if(scene==='motion') {
    let t=beat===0?mix(0,1,smooth(q)):beat===1?1:2;
    if(beat===2) t=betweenCues(scene,p,'car-t3','mark-9',2,3);
    if(beat>=3)t=mix(1,3,smooth(q));
    return {t,s:t*t,slope:2*t};
  }
  if(scene==='average')return{t:3,s:9,h:2,slope:4};
  if(scene==='secant') {
    const h=p<.4?1:p<.6?betweenCues(scene,p,'approach-01','h-01',1,.1):betweenCues(scene,p,'approach-001','h-001',.1,.01);
    return{h,slope:4+h};
  }
  if(scene==='limit') {
    let h=.1;
    if(p<.2)h=betweenCues(scene,p,'right-01','right-001',.1,.01);
    else if(p<.4)h=betweenCues(scene,p,'left-001-approach','h-negative-001',-.1,-.01);
    else h=.01;
    return{h,slope:4+h};
  }
  if(scene==='outro'){const h=p<cuePoint(scene,'limit',.7125)?1:betweenCues(scene,p,'limit','tangent',1,.01);return{h,slope:p>=cuePoint(scene,'tangent',.7354)?4:4+h,t:2,s:4};}
  if(scene==='tangent')return{slope:4,t:2,s:4};
  return{};
}

function material(color: number, metalness = .35, roughness = .28, emissive = 0) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, emissive: color, emissiveIntensity: emissive });
}
function glowMaterial(color: number) { return new THREE.MeshBasicMaterial({ color, toneMapped: false }); }
function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, parent?: THREE.Object3D) {
  const object = new THREE.Mesh(geometry, mat); object.castShadow = true; object.receiveShadow = true; parent?.add(object); return object;
}
function block(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const object = mesh(new THREE.BoxGeometry(w, h, d), mat, parent); object.position.set(x, y, z); return object;
}
function tube(fn: (p: number) => THREE.Vector3, color: number, radius = .035, segments = 100) {
  class C extends THREE.Curve<THREE.Vector3> { constructor() { super(); } getPoint(t: number) { return fn(t); } }
  return mesh(new THREE.TubeGeometry(new C(), segments, radius, 8, false), material(color, .3, .25, .35));
}
function rod(parent: THREE.Object3D, color: number, radius = .018) {
  const object = mesh(new THREE.CylinderGeometry(radius, radius, 1, 8), glowMaterial(color), parent);
  return { object, set(a: THREE.Vector3, b: THREE.Vector3) { const delta = b.clone().sub(a); object.position.copy(a).add(b).multiplyScalar(.5); object.scale.y = Math.max(.00001, delta.length()); object.quaternion.setFromUnitVectors(V(0, 1), delta.normalize()); } };
}
function fixedRod(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, color: number, radius = .018) { const r = rod(parent, color, radius); r.set(a, b); return r.object; }
function textLabel(initial: string, color = '#f3f5e9', height = .38, width = 512) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: .025, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  object.scale.set(height * width / 128, height, 1); object.userData.isLabLabel=true;
  let current = '';
  const set = (text: string) => { if (text === current) return; current = text; ctx.clearRect(0, 0, width, 128); ctx.font = '800 64px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, width / 2, 64, width - 8); texture.needsUpdate = true; };
  set(initial); return { object, set };
}
function tag(parent: THREE.Object3D, text: string, x: number, y: number, z = .2, color = '#f3f5e9', height = .38) { const label = textLabel(text, color, height); label.object.position.set(x, y, z); parent.add(label.object); return label; }
function sphere(parent: THREE.Object3D, radius: number, color: number) { return mesh(new THREE.SphereGeometry(radius, 32, 20), material(color, .35, .2, .18), parent); }

/** The renderer is a stateless shot machine: every visible channel is a function of chapter progress.
 * Both the React player and HyperFrames call the same renderFrame; there is no ambient animation. */
export function createDerivativeRenderer(canvas: HTMLCanvasElement, options: { carUrl?: string } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x050605); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const world = new THREE.Scene();
  const environment = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const reflection = environment.fromScene(room, .04); world.environment = reflection.texture; world.environmentIntensity = .55; room.dispose(); environment.dispose();
  world.fog = new THREE.Fog(0x09131b, 38, 78);
  const laboratory = createLabEnvironment(world);
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, .08, 140);
  const stage = new THREE.Group(); world.add(stage);
  const fill = new THREE.HemisphereLight(0xe7f8ff, 0x3b4042, 1.6); world.add(fill);
  const key = new THREE.DirectionalLight(0xffffff, 2.8); key.position.set(-5, 9, 8); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -18; key.shadow.camera.right = 18; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14; key.shadow.normalBias = .025; world.add(key);
  const rim = new THREE.DirectionalLight(LIME, 2.2); rim.position.set(4, 6, -5); world.add(rim);
  const whiteRim = new THREE.DirectionalLight(0xb7d0dd, 1.1); whiteRim.position.set(5, 2, 4); world.add(whiteRim);
  const floor = mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshBasicMaterial({color:0x050605}), world); floor.rotation.x = -Math.PI / 2; floor.position.y = -3.2; floor.castShadow = false; floor.visible = false;
  const lime = material(LIME, .4, .22), chrome = material(0xe3e7da, .83, .15), dark = material(0x111918, .75, .26), rubber = material(0x080a09, .05, .66), glass = material(0x17252a, .85, .12), orange = material(AMBER, .15, .45);
  const groups: THREE.Group[] = [];
  function group() { const g = new THREE.Group(); stage.add(g); groups.push(g); return g; }

  // A modelled sports car: body extrusion, glass canopy, four rotating wheels and brake lamps.
  const roadScene = group();
  const road = block(roadScene, 34, .12, 4.2, material(0x1d211e, .22, .65), 0, -2.88, 0);
  const roadMarks: THREE.Mesh[] = [];
  for (let i = 0; i < 17; i++) roadMarks.push(block(roadScene, .68, .014, .05, material(WHITE), -6 + i * .75, -2.809, 0));
  for (const z of [-1.82, 1.82]) block(roadScene, 34, .02, .055, lime, 0, -2.80, z);
  const car = new THREE.Group(); roadScene.add(car);
  let importedCar: Awaited<ReturnType<typeof loadCarAsset>> | null = null;
  const shape = new THREE.Shape(); shape.moveTo(-2.2, .49); shape.lineTo(-2.03, .92); shape.lineTo(-.87, 1.05); shape.lineTo(1.29, 1.04); shape.lineTo(2.18, .88); shape.lineTo(2.27, .48); shape.lineTo(-2.2, .49);
  const paint = new THREE.MeshPhysicalMaterial({color:LIME, metalness:.45,roughness:.21,clearcoat:1,clearcoatRoughness:.15});
  const body = mesh(new THREE.ExtrudeGeometry(shape, { depth: 1.72, bevelEnabled: true, bevelSegments: 5, steps: 1, bevelSize: .09, bevelThickness: .06 }), paint, car); body.position.z = -.86;
  block(car, 4.4, .14, 1.86, dark, 0, .45);
  const canopyShape = new THREE.Shape(); canopyShape.moveTo(-.79, 1.06); canopyShape.lineTo(-.36, 1.43); canopyShape.lineTo(.73, 1.4); canopyShape.lineTo(1.19, 1.06); canopyShape.closePath();
  const cabinGlass = new THREE.MeshPhysicalMaterial({color:0x4b757b,metalness:.15,roughness:.1,transparent:true,opacity:.48,depthWrite:false,side:THREE.DoubleSide});
  const canopy = mesh(new THREE.ExtrudeGeometry(canopyShape, { depth: 1.60, bevelEnabled: false }), cabinGlass, car); canopy.position.z = -.80;
  block(car, .07, .44, 1.77, dark, .2, 1.25);
  block(car, 1.35, .04, 1.4, dark, -.02, 1.485);
  // Visible cabin, aerodynamic details, brake discs and tread lend scale to close chase shots.
  for(const z of [-.42,.42]) { const seat=block(car,.52,.5,.48,rubber,-.18,.98,z);seat.rotation.z=.12; }
  block(car,.24,.18,1.43,dark,.72,1.05,0);
  const steering=mesh(new THREE.TorusGeometry(.17,.035,10,32),chrome,car);steering.rotation.y=Math.PI/2;steering.position.set(.40,1.12,.42);
  block(car,.60,.06,2.02,dark,2.02,.42,0);
  for(const z of [-.61,.61]) { const pipe=mesh(new THREE.CylinderGeometry(.10,.10,.3,20),chrome,car);pipe.rotation.z=Math.PI/2;pipe.position.set(-2.25,.52,z);const mirror=block(car,.24,.10,.16,paint,.42,1.13,z*1.6);mirror.rotation.y=z; }
  for(let i=0;i<5;i++) block(car,.32,.12,.045,dark,-2.13,.46,-.62+i*.31);
  for (const z of [-.24, .24]) { const stripe = block(car, .9, .018, .14, dark, 1.67, 1.035, z); stripe.rotation.z = -.16; }
  for (let i = 0; i < 4; i++) block(car, .28, .025, .06, dark, -1.45, 1.12, -.45 + i * .30);
  for (const z of [-.59, .59]) { block(car, .06, .12, .45, glowMaterial(WHITE), 2.27, .78, z); block(car, .05, .10, .46, glowMaterial(0xff3038), -2.21, .79, z); }
  block(car, .42, .06, 1.98, dark, -1.78, 1.17);
  for (const z of [-.65, .65]) block(car, .06, .25, .06, chrome, -1.8, 1.06, z);
  const wheels: THREE.Group[] = [];
  for (const x of [-1.42, 1.40]) for (const z of [-.94, .94]) {
    const wheel = new THREE.Group(); wheel.position.set(x, .48, z); car.add(wheel); wheels.push(wheel);
    const tire = mesh(new THREE.CylinderGeometry(.48, .48, .23, 32), rubber, wheel); tire.rotation.x = Math.PI / 2;
    const hub = mesh(new THREE.CylinderGeometry(.32, .32, .241, 24), chrome, wheel); hub.rotation.x = Math.PI / 2;
    const center = mesh(new THREE.CylinderGeometry(.09, .09, .255, 20), dark, wheel); center.rotation.x = Math.PI / 2;
    for (let j = 0; j < 5; j++) { const spoke = block(wheel, .055, .57, .26, dark); spoke.rotation.z = j * Math.PI / 5; }
    for(let j=0;j<28;j++) { const a=j*Math.PI/14;const tread=block(wheel,.055,.018,.22,dark,Math.sin(a)*.484,Math.cos(a)*.484,0);tread.rotation.z=-a; }
    const brake=mesh(new THREE.CylinderGeometry(.235,.235,.25,24),material(0x777f81,.8,.4),wheel);brake.rotation.x=Math.PI/2;
    block(wheel,.09,.22,.26,orange,.22,.05,0);
  }
  for(const x of [-14,-6,6,18]) { for(const z of [-2.3]) {block(roadScene,.15,4.7,.15,chrome,x,-.45,z);block(roadScene,.04,4.3,.04,glowMaterial(LIME),x+.09,-.45,z);} block(roadScene,.14,.14,4.8,chrome,x,1.9,0); }
  for(const x of [-16])block(roadScene,.15,4.7,.15,chrome,x,-.45,2.3);
  const carGhosts: THREE.Mesh[] = [];
  for (let i = 0; i < 7; i++) { const dot = sphere(roadScene, .09, LIME); carGhosts.push(dot); }
  const roadUnits: THREE.Mesh[] = [];
  for (const value of [0, 1, 4, 9]) { const l = tag(roadScene, `${value} м`, value - 4.5, -2.65, 2.24, '#b2bca6', .43); roadUnits.push(l.object); }
  const roadTime = tag(roadScene, 't = 0 с', 0, .1, 0, '#d1ff00', .70);
  const velocityArrow = rod(roadScene, WHITE, .035);

  const dial = group();
  const dialBack = mesh(new THREE.CylinderGeometry(2.4, 2.4, .25, 64), dark, dial); dialBack.rotation.x = Math.PI / 2;
  const outerRing = mesh(new THREE.TorusGeometry(2.34, .055, 12, 120), chrome, dial); outerRing.position.z = .15;
  const arc = tube(p => { const a = mix(Math.PI * .78, Math.PI * -.22, p); return V(Math.cos(a) * 2.10, Math.sin(a) * 2.10, .19); }, LIME, .10, 100); dial.add(arc);
  for (let i = 0; i < 21; i++) { const angle = mix(Math.PI * 1.22, -Math.PI * .22, i / 20); fixedRod(dial, V(Math.cos(angle) * 1.86, Math.sin(angle) * 1.86, .23), V(Math.cos(angle) * (i % 5 ? 2.02 : 2.10), Math.sin(angle) * (i % 5 ? 2.02 : 2.10), .23), i >= 15 ? LIME : WHITE, i % 5 ? .014 : .027); }
  const needle = rod(dial, AMBER, .034); sphere(dial, .13, WHITE).position.z = .30;
  const speedText = tag(dial, '0.0', 0, -.65, .32, '#d1ff00', 1.15); const speedUnits = tag(dial, 'м / с', 0, -1.35, .32, '#f3f5e9', .34);
  tag(dial, 'СЕЙЧАС', 0, .72, .3, '#f3f5e9', .31);

  // Graph geometry is a coordinate record; it never becomes the physical road.
  const graph = group();
  const graphAxes = new THREE.Group(); graph.add(graphAxes);
  for (let x = 0; x <= 3; x++) { fixedRod(graphAxes, gp(x, 0, -.1), gp(x, 12, -.1), 0x30392b, .008); tag(graphAxes, `${x}`, gp(x, 0).x, -2.84, .15, '#adb59c', .32); }
  for (let y = 0; y <= 12; y += 2) fixedRod(graphAxes, gp(0, y, -.1), gp(3.45, y, -.1), 0x30392b, .008);
  fixedRod(graphAxes, gp(-.3, 0), gp(3.6, 0), 0x88917d, .022); fixedRod(graphAxes, gp(0, -.3), gp(0, 12.8), 0x88917d, .022);
  for (const value of [4, 8, 12]) tag(graphAxes, `${value}`, gp(0, value).x - .28, gp(0, value).y, .15, '#adb59c', .27);
  const graphX = tag(graphAxes, 'x', gp(3.75, 0).x, -2.5, .15, '#d1ff00', .38), graphY = tag(graphAxes, 'f(x)', gp(0, 13).x, gp(0, 13).y, .15, '#d1ff00', .36);
  const parabola = tube(p => { const x = mix(-.25, 3.52, p); return gp(x, x * x); }, LIME, .055, 140); graph.add(parabola);
  const graphGlass=material(0x142a35,.45,.22);graphGlass.transparent=true;graphGlass.opacity=.23;graphGlass.depthWrite=false;
  block(graph,6.8,7.4,.20,graphGlass,-.2,.55,-.30);
  const graphFrame=material(0x647983,.7,.25);
  for(const x of [-3.6,3.2]) {block(graph,.10,7.55,.23,graphFrame,x,.55,-.31);block(graph,.20,.9,.75,chrome,x,-3.5,-.28);}
  for(const y of [-3.22,4.32])block(graph,6.95,.11,.24,graphFrame,-.2,y,-.31);
  block(graph,7.8,.2,2,material(0x263c46,.4,.3),-.2,-3.12,-.6);
  // Extruded ribbon makes the exact x/y curve a tangible section through space.
  const ribbonPositions:number[]=[];const ribbonIndices:number[]=[];
  for(let i=0;i<=100;i++){const x=mix(-.25,3.52,i/100);for(const z of [-.10,.14]){const point=gp(x,x*x,z);ribbonPositions.push(point.x,point.y,point.z)}if(i<100){const j=i*2;ribbonIndices.push(j,j+1,j+2,j+1,j+3,j+2)}}
  const ribbon=new THREE.BufferGeometry();ribbon.setAttribute('position',new THREE.Float32BufferAttribute(ribbonPositions,3));ribbon.setIndex(ribbonIndices);ribbon.computeVertexNormals();graph.add(mesh(ribbon,material(LIME,.55,.25,.1)));
  const graphA = sphere(graph, .13, WHITE), graphB = sphere(graph, .12, AMBER);
  const aLabel = tag(graph, 'A (2;4)', 0, 0, .3, '#f3f5e9', .38), bLabel = tag(graph, 'B', 0, 0, .3, '#ff753c', .38);
  const secant = rod(graph, AMBER, .028), tangent = rod(graph, WHITE, .035), horizontal = rod(graph, AMBER, .021), vertical = rod(graph, AMBER, .021);
  const markerA = rod(graph, 0x5f6853, .012), markerB = rod(graph, 0x5f6853, .012), limitLeft = rod(graph, CYAN, .025);
  const halo = mesh(new THREE.TorusGeometry(.27, .024, 12, 64), chrome, graph);
  const hLabel = tag(graph, 'h', 0, 0, .3, '#ff753c', .34);
  const slopeBadge = tag(graph, '4 м/с', 1.9, -.8, .3, '#f3f5e9', .63);
  const portal = new THREE.Group(); graph.add(portal);
  for (let i = 0; i < 5; i++) { const ring = mesh(new THREE.TorusGeometry(.35 + i * .17, .023 + i * .003, 12, 64), i % 2 ? chrome : lime, portal); ring.position.z = -i * .38; }

  // A ceramic cup with a real interior, liquid surface, handle and finite steam wisps.
  const coffee = group();
  const cup = new THREE.Group(); coffee.add(cup); cup.position.y = -1.8;
  block(coffee,6.8,.28,4.6,material(0xd5dfdc,.08,.5),0,-1.99,0);
  for(const x of [-2.6,2.6])for(const z of [-1.65,1.65])block(coffee,.16,1.2,.16,chrome,x,-2.7,z);
  const spoon=mesh(new THREE.CapsuleGeometry(.09,1.2,4,12),chrome,coffee);spoon.rotation.set(Math.PI/2,0,.3);spoon.position.set(-1.8,-1.8,.55);
  for(let i=0;i<3;i++)block(coffee,.28,.28,.28,material(0xf7f5e8,.03,.8),-2.1+i*.35,-1.71,-.7);
  const cupProfile = [V(.0, .0), V(.87, .0), V(.99, .13), V(1.15, 1.78), V(1.10, 1.92), V(.98, 1.92), V(.91, .25), V(0, .25)].map(p => new THREE.Vector2(p.x, p.y));
  mesh(new THREE.LatheGeometry(cupProfile, 72), material(0xe7e8dc, .06, .24), cup);
  const lip = mesh(new THREE.TorusGeometry(1.045, .055, 12, 80), chrome, cup); lip.rotation.x = Math.PI / 2; lip.position.y = 1.91;
  const handle = mesh(new THREE.TorusGeometry(.63, .16, 16, 64, Math.PI * 1.65), material(0xdce2d0, .15, .28), cup); handle.position.set(1.19, 1.10, 0); handle.rotation.z = -Math.PI * .825;
  const liquid = mesh(new THREE.CylinderGeometry(.986, .986, .03, 64), material(0x25130a, .1, .15), cup); liquid.position.y = 1.73;
  const saucer = mesh(new THREE.CylinderGeometry(1.65, 1.40, .12, 72), material(0xaeb69a, .35, .28), cup); saucer.position.y = -.08;
  const latte = mesh(new THREE.TorusGeometry(.35, .014, 8, 60), material(0xd9aa6d, .1, .4), cup); latte.rotation.x = Math.PI / 2; latte.position.y = 1.75;
  const steam: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) { const s = tube(p => V(Math.sin(p * Math.PI * 2 + i) * .14, p * 1.35, 0), WHITE, .018, 44); (s.material as THREE.Material).transparent = true; (s.material as THREE.Material).opacity = .25; s.position.set(-.45 + i * .3, 1.85, -.1); cup.add(s); steam.push(s); }
  const temp = tag(coffee, '70°', -.05, 1.6, .2, '#d1ff00', 1.15);
  const thermometer = new THREE.Group(); coffee.add(thermometer); thermometer.position.set(2.3, -.8, 0);
  const thermometerBody = mesh(new THREE.CapsuleGeometry(.17, 2.4, 8, 16), material(WHITE, .35, .24), thermometer);
  const thermal = block(thermometer, .18, 1, .12, orange, 0, 0, .15);
  sphere(thermometer, .29, AMBER).position.set(0, -1.32, .12);
  const cooling = new THREE.Group(); coffee.add(cooling); cooling.position.set(-.6, 0, 1.9);
  const coolingGlass=material(0x96bbb3,.2,.4);coolingGlass.transparent=true;coolingGlass.opacity=.17;coolingGlass.depthWrite=false;
  block(cooling,5.5,2.6,.13,coolingGlass,0,0,-.2);
  for(const x of [-2.75,2.75])block(cooling,.06,2.65,.15,chrome,x,0,-.2);
  for(const y of [-1.3,1.3])block(cooling,5.55,.06,.15,chrome,0,y,-.2);
  for(const x of [-2.1,2.1])block(cooling,.12,.85,.4,chrome,x,-1.7,-.2);
  const coolingCurve=tube(p => V(mix(-2.3, 2.3, p), 1.4 * Math.exp(-p * 1.7) - .7, 0), LIME, .045);cooling.add(coolingCurve);
  fixedRod(cooling, V(-2.3, -.9), V(2.5, -.9), 0x7e876e); fixedRod(cooling, V(-2.3, -.9), V(-2.3, 1), 0x7e876e);
  const coolingTangent = rod(cooling, WHITE, .027); const coolingY = 1.4 * Math.exp(-.85) - .7;
  const coolingSlope = -(1.7 / 4.6) * 1.4 * Math.exp(-.85);
  coolingTangent.set(V(-1.6, coolingY + coolingSlope * -1.6), V(1.8, coolingY + coolingSlope * 1.8));
  const coolingPoint = sphere(cooling, .09, WHITE); coolingPoint.position.set(0, coolingY, .04);
  tag(cooling, 'Δt', 2.55, -.9, .1, '#b4bda6', .3);

  // Growing area tiles make the two xh strips and the h² corner physically separate.
  const square = group();
  const squareRig=new THREE.Group();square.add(squareRig);
  block(squareRig,7,.20,3.5,chrome,.2,-3.04,-.6);
  for(const x of [-2.8,3.2])block(squareRig,.14,4,.14,chrome,x,-1,-.7);
  const areaBase = block(square, 1, 1, .30, lime), stripX = block(square, 1, 1, .34, material(AMBER)), stripY = block(square, 1, 1, .34, material(CYAN)), areaCorner = block(square, 1, 1, .38, chrome);
  const areaTitle = tag(square, 'x²', 0, 0, .3, '#080b03', .9);
  const stripXTitle = tag(square, 'xh', 0, 0, .3, '#201007', .5), stripYTitle = tag(square, 'xh', 0, 0, .3, '#071713', .5), cornerTitle = tag(square, 'h²', 0, 0, .4, '#10140b', .35);
  const xSide = tag(square, 'x', 0, -2.2, .2, '#f3f5e9', .55), hSide = tag(square, 'h', 0, -2.2, .2, '#ff753c', .43);
  const equal = tag(square, '2xh + h²', 0, 3.0, .2, '#f3f5e9', .65);

  // The chain mechanism is a visible input/output transformation, with gains labelled explicitly.
  const powers = group();
  const powerCube = block(powers, 2.7, 2.7, 2.7, lime, .4, 0, 0);
  const faceTop = block(powers, 2.72, .025, 2.72, material(CYAN), .4, 1.36, 0);
  const faceSide = block(powers, .025, 2.72, 2.72, material(AMBER), 1.76, 0, 0);
  const cubeTitle=tag(powers, 'x³', .4, 0, 1.40, '#0b1704', .9);
  const cubeAnswer=tag(powers, '3x²', .4, -2.25, .2, '#f3f5e9', .65);
  const constant = new THREE.Group(); powers.add(constant); constant.position.set(-3.4, 1.8, 0);
  fixedRod(constant,V(-1,0),V(1,0),0x18473f,.08); tag(constant,'c',0,.45,0,'#d1ff00',.5);
  const quadratic = group();
  const quadraticLabels: ReturnType<typeof textLabel>[] = [];
  for(let i=0;i<3;i++) { block(quadratic,1.85,1.85,.26,lime,(i-1)*2.1,.5,0); quadraticLabels.push(tag(quadratic,'x²',(i-1)*2.1,.5,.2,'#0b1704',.65)); }
  const fiveConstants = new THREE.Group();fiveConstants.name='quadratic-five-constants';quadratic.add(fiveConstants);
  for(let i=0;i<5;i++) block(fiveConstants,.34,.34,.29,chrome,(i-2)*.44,0,0);
  tag(fiveConstants,'+5',0,-.7,.2,'#f3f5e9',.5);
  const quadraticAnswer=tag(quadratic,'6x',0,-1.5,.25,'#f3f5e9',.75);quadraticAnswer.object.name='quadratic-answer';
  const chain = group();
  block(chain,9,.22,3,chrome,0,-3,-.5);
  for(const x of [-1.95,1.95]){block(chain,.22,3,.3,dark,x,-1.7,-.6);const axle=mesh(new THREE.CylinderGeometry(.20,.20,1.4,24),chrome,chain);axle.rotation.x=Math.PI/2;axle.position.set(x,0,-.5);}

  const gearGroups: THREE.Group[] = [];
  for (let i = 0; i < 2; i++) {
    const g = new THREE.Group(); chain.add(g); g.position.set(i ? 1.95 : -1.95, 0, 0); gearGroups.push(g);
    const radius = i ? 1.43 : 1.12;
    const drum = mesh(new THREE.CylinderGeometry(radius, radius, .38, 40), i ? lime : chrome, g); drum.rotation.x = Math.PI / 2;
    for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; const tooth = block(g, .28, .45, .39, i ? lime : chrome, Math.sin(a) * (radius + .08), Math.cos(a) * (radius + .08)); tooth.rotation.z = -a; }
    const axle = mesh(new THREE.CylinderGeometry(.60, .60, .52, 32), dark, g); axle.rotation.x = Math.PI / 2;
  }
  tag(chain, '×3', -1.95, 0, .45, '#f3f5e9', .7); tag(chain, '×2u', 1.95, 0, .45, '#f3f5e9', .7);
  tag(chain, 'x', -4.2, 0, .2, '#f3f5e9', .7); tag(chain, 'u = 3x + 1', -1.95, -2.2, .2, '#f3f5e9', .53); tag(chain, 'y = u²', 1.95, -2.2, .2, '#d1ff00', .53);
  fixedRod(chain, V(-3.9, 0), V(-3.35, 0), WHITE, .04); fixedRod(chain, V(-.45, 0, .4), V(.3, 0, .4), WHITE, .035);
  const parcel = sphere(chain, .13, AMBER);
  const product = group();
  const productBase = block(product, 3.8, 2.5, .3, lime, -.3, -.2), productW = block(product, 1, 1, .34, material(AMBER)), productH = block(product, 1, 1, .34, material(CYAN)), productC = block(product, 1, 1, .36, chrome);
  tag(product, 'fg', -.3, -.2, .3, '#0b1603', 1); tag(product, 'f', -.3, -1.85, .3, '#f3f5e9', .5); tag(product, 'g', -2.65, -.2, .3, '#f3f5e9', .5);
  const productWT = tag(product, 'g Δf', 0, 0, .3, '#321007', .42), productHT = tag(product, 'f Δg', 0, 0, .3, '#071713', .42);

  // Projectile motion is physical height H(t), with its t/H graph separately labelled.
  const projectile = group();
  const court = block(projectile, 10, .1, 4, material(0x21261b, .15, .55), 0, -2.88, 0);
  for (const z of [-1.7, 1.7]) block(projectile, 10, .02, .04, lime, 0, -2.82, z);
  const trajectory = tube(p => { const t = p * 4; return V((t - 2) * 1.9, -t * t + 4 * t - 2.3, 0); }, LIME, .027, 100); projectile.add(trajectory);
  const basket = new THREE.Group(); projectile.add(basket);
  const basketball = sphere(basket, .43, AMBER); basketball.material = material(0xdb5d16, .05, .57);
  for (let i = 0; i < 3; i++) { const seam = mesh(new THREE.TorusGeometry(.433, .014, 8, 64), dark, basket); seam.rotation.set(i === 0 ? Math.PI / 2 : 0, i === 1 ? Math.PI / 2 : 0, 0); }
  const trail: THREE.Mesh[] = []; for (let i = 0; i < 10; i++) { const dot = sphere(projectile, .048, WHITE); trail.push(dot); }
  const velocity = rod(projectile, WHITE, .04), peakLine = rod(projectile, WHITE, .025);
  peakLine.set(V(-1.2, 1.7), V(1.2, 1.7));
  const peakMarker = mesh(new THREE.TorusGeometry(.65, .025, 12, 72), chrome, projectile); peakMarker.position.set(0, 1.7, -.12);
  const ballTag = tag(projectile, 'H = 4 м', 0, 2.55, .2, '#d1ff00', .68), velocityTag = tag(projectile, 'v = 0', 2.5, .3, .2, '#f3f5e9', .65);
  tag(projectile, '0', -3.8, -3.05, .2, '#aab59c', .35); tag(projectile, '2 с', 0, -3.05, .2, '#d1ff00', .35); tag(projectile, '4 с', 3.8, -3.05, .2, '#aab59c', .35);
  const cubic = group();
  fixedRod(cubic, V(-3.4, 0), V(3.4, 0), 0x7a836e); fixedRod(cubic, V(0, -3.2), V(0, 3.2), 0x7a836e);
  cubic.add(tube(p => { const x = mix(-1.45, 1.45, p); return V(x * 2, x ** 3); }, LIME, .055, 100));
  fixedRod(cubic, V(-2.3, 0, .08), V(2.3, 0, .08), WHITE, .032);
  const cubeDot = sphere(cubic, .13, AMBER); tag(cubic, 'x³', 2.9, 2.8, .2, '#d1ff00', .6); tag(cubic, 'f′(0) = 0', 0, -.7, .2, '#f3f5e9', .58);

  let disposed = false, width = 1920, height = 1080;
  let lastFrame: DerivativeFrame = { scene: 'intro', progress: 0, time: 0, playing: false };
  const target = V();
  function placeCamera(position: THREE.Vector3, look = V(), zoom = 1) {
    const portrait = width / height < 1;
    const distance = position.clone().sub(look);
    camera.position.copy(look).add(distance.multiplyScalar(portrait ? 1.65 : 1));
    target.copy(look);camera.lookAt(target);camera.zoom=zoom;camera.aspect=width/height;
    camera.clearViewOffset();camera.updateProjectionMatrix();
    // Keep the mathematical installation above the bottom captions, never to one side.
    camera.projectionMatrix.elements[9]=portrait?-.16:-.12;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  function setGraph(p: number, scene: string, beat: number) {
    const motion = scene === 'motion';
    const ax = scene === 'average' ? 1 : motion ? derivativeReadout(scene, p).t! : 2;
    const h = scene === 'average' ? 2 : derivativeReadout(scene, p).h ?? .01;
    const bx = ax + h, ay = ax * ax, by = bx * bx;
    graphA.position.copy(gp(ax, ay, .08)); graphB.position.copy(gp(bx, by, .08)); halo.position.copy(graphA.position);
    aLabel.object.position.copy(gp(ax - .24, ay + .85, .35)); bLabel.object.position.copy(gp(bx + .16, by + .65, .35));
    aLabel.set(motion ? `(${ax.toFixed(1)}; ${ay.toFixed(1)})` : scene === 'average' ? 'A (1;1)' : 'A (2;4)');
    bLabel.set(scene === 'average' ? 'B (3;9)' : 'B');
    const slope = ax + bx;
    const lo = Math.max(-.2, ax + (-.2 - ay) / slope), hi = Math.min(3.55, ax + (12.4 - ay) / slope);
    secant.set(gp(lo, ay + slope * (lo - ax), .04), gp(hi, ay + slope * (hi - ax), .04));
    tangent.set(gp(1, 0, .1), gp(3.55, 10.2, .1));
    limitLeft.set(gp(1, Math.abs(h), .07), gp(3.55, 4 + (4 - Math.abs(h)) * 1.55, .07));
    horizontal.set(gp(ax, ay, .06), gp(bx, ay, .06)); vertical.set(gp(bx, ay, .06), gp(bx, by, .06));
    markerA.set(gp(ax, 0), gp(ax, ay)); markerB.set(gp(bx, 0), gp(bx, by));
    hLabel.object.position.copy(gp((ax + bx) / 2, ay - .55, .3));
    hLabel.set(scene === 'average' ? 'Δt = 2' : `h = ${h.toFixed(Math.abs(h) < .05 ? 2 : 1)}`);
    const outroTangent=scene==='outro'&&p>=cuePoint('outro','tangent',.7354);
    const isSecant = ['average', 'secant', 'limit'].includes(scene) || (scene === 'outro'&&!outroTangent);
    graphB.visible = isSecant && Math.abs(h) > .05; bLabel.object.visible = isSecant && Math.abs(h) > .25;
    secant.object.visible = isSecant; tangent.object.visible = scene === 'tangent' || outroTangent || (scene === 'limit' && beat >= 3);
    horizontal.object.visible = vertical.object.visible = hLabel.object.visible = isSecant && Math.abs(h) > .05;
    markerB.object.visible = isSecant; markerA.object.visible = true;
    limitLeft.object.visible = scene === 'limit' && beat < 3;
    slopeBadge.object.visible = scene !== 'motion' && scene !== 'tangent' && !(scene==='secant' && ((p>=.4&&p<cuePoint(scene,'h-01',.424))||(p>=.6&&p<cuePoint(scene,'h-001',.610))));
    slopeBadge.set(outroTangent ? 'k = 4' : scene === 'average' ? '4 м/с' : scene === 'limit' && beat >= 3 ? '4' : `k = ${slope.toFixed(h < .05 ? 2 : 1)}`);
    graphX.set(motion || scene === 'average' ? 't, с' : 'x'); graphY.set(motion || scene === 'average' ? 's, м' : 'f(x)');
    portal.visible = scene === 'limit' && beat >= 2; portal.position.copy(gp(2, 4, -.10));
    portal.rotation.z = p * .9; portal.scale.setScalar(.85 + .2 * smooth((p - .4) / .3));
  }
  function setCar(t: number, q: number, inMotion: boolean) {
    const s = t * t; car.position.set(inMotion ? s - 4.5 : 0, -2.80, 0); car.scale.setScalar(inMotion ? .95 : 1);
    car.rotation.set(0, 0, 0); wheels.forEach(wheel => { wheel.rotation.z = -s / (.48*car.scale.x); });
    importedCar?.spinWheels(s / ((Number(importedCar.root.userData.wheelRadius)||.3966)*car.scale.x));
    roadTime.set(`t = ${t.toFixed(1)} с`); roadTime.object.position.set(car.position.x, -.9, 0);
    roadTime.object.visible = inMotion; roadUnits.forEach(o => { o.visible = inMotion; });
    roadMarks.forEach((mark, i) => { mark.position.x = -6 + i * .75 - (inMotion ? 0 : q * 8 % .75); });
    velocityArrow.object.visible = inMotion;
    velocityArrow.set(V(car.position.x, -1.2, 0), V(car.position.x + t * .45, -1.2, 0));
    carGhosts.forEach((dot, i) => { const ghostTime = i * .5; dot.visible = inMotion && ghostTime < t; dot.position.set(ghostTime ** 2 - 4.5, -2.62, .1); });
    road.visible = true;
  }
  function setDial(speed: number) { const a = mix(Math.PI * 1.22, -Math.PI * .22, clamp(speed / (speed > 8 ? 120 : 8))); speedUnits.set(speed > 8 ? "км / ч" : "м / с"); needle.set(V(0, 0, .29), V(Math.cos(a) * 1.7, Math.sin(a) * 1.7, .29)); speedText.set(speed.toFixed(1)); }
  function setCoffee(p: number, beat: number, q: number) {
    const dt = beat >= 3 ? .5 * smooth((p-cuePoint('tangent','half-minute',.604))/Math.max(.001,cuePoint('tangent','coffee-69',.637)-cuePoint('tangent','half-minute',.604))) : 0;
    temp.set(`${(70 - 2 * dt).toFixed(dt ? 1 : 0)}°`); temp.object.visible = true; temp.object.position.set(beat >= 2 ? (width/height<1?-.3:-1.8) : -.05, beat >= 2 ? 1.25 : 1.6, .2);
    coffee.rotation.y = -.20 + q * .12; cup.rotation.z = 0;
    thermal.scale.y = mix(1.95, 1.85, dt * 2); thermal.position.y = -.20;
    steam.forEach((s, i) => { s.position.y = 1.85 + q * .35; s.rotation.y = p * 2 + i * .8; (s as THREE.Mesh).scale.set(1, 1 + q * .25, 1); });
    cooling.visible = beat >= 2; cooling.position.set(4.35,.25,-.7); cooling.scale.setScalar(1.0);
    thermometerBody.visible = true;
  }
  function setBall(t: number, beat: number) {
    const heightValue = -t * t + 4 * t; basket.position.set((t - 2) * 1.9, heightValue - 2.3, 0); basket.rotation.set(0, 0, -t * 2);
    velocity.set(basket.position.clone().add(V(.75, 0)), basket.position.clone().add(V(.75, (4 - 2 * t) * .48)));
    velocityTag.object.visible=true;velocityTag.set(`v = ${(4 - 2 * t).toFixed(1)}`); velocityTag.object.position.copy(basket.position).add(V(1.9, .2, .1));
    ballTag.object.visible = peakMarker.visible = peakLine.object.visible = beat >= 2;
    trail.forEach((dot, i) => { const tt = i * .4; dot.visible = tt < t; dot.position.set((tt - 2) * 1.9, -tt * tt + 4 * tt - 2.3, .03); });
    trajectory.visible = true; court.visible = true;
  }
  const STATIONS = { car: V(-10,0,4), graph: V(3,0,-10), coffee: V(13,0,4), area: V(-10,0,-12), chain: V(18,0,-12), ball: V(1,0,14) };
  let previousTheme='';
  const diagnostics = { scene:'intro', beat:0, shot:'', theme:'dark', camera:[0,0,0], target:[0,0,0] };
  // These camera routes are world-space positions; the laboratory itself never rotates.
  function route(a:THREE.Vector3,b:THREE.Vector3,c:THREE.Vector3,q:number) {
    return q<.28 ? a.clone().lerp(b,easeOut(q/.28)) : b.clone().lerp(c,smooth((q-.28)/.72));
  }
  function placeAt(object:THREE.Object3D,origin:THREE.Vector3) { object.position.copy(origin);object.visible=true; }
  const renderFrame = (frame: DerivativeFrame) => {
    if(disposed)return;lastFrame=frame;
    const p=clamp(Number.isFinite(frame.progress)?frame.progress:0);
    const beat=Math.min(4,Math.floor(p*5)), q=p===1?1:p*5-beat, scene=frame.scene;
    const theme=sceneThemeAt(scene,p), light=theme==='light';
    laboratory.setTheme(theme);renderer.setClearColor(light?0xe9eeee:0x09131b);
    if(previousTheme!==theme){world.traverse(o=>{if(o.userData.isLabLabel)(o as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>).material.color.set(light?0x20332b:0xffffff)});previousTheme=theme;}
    renderer.toneMappingExposure=light?.95:1.05;
    (coolingCurve.material as THREE.MeshStandardMaterial).color.set(light?0x155d4b:LIME);
    (coolingCurve.material as THREE.MeshStandardMaterial).emissive.set(light?0x071c14:LIME);
    (coolingTangent.object.material as THREE.MeshBasicMaterial).color.set(light?0x294646:WHITE);
    (world.fog as THREE.Fog).color.set(light?0xe9eeee:0x09131b);
    world.environmentIntensity=light?.5:.48;fill.intensity=light?1.2:1.2;key.intensity=light?2.7:3.2;
    rim.color.set(light?0xb4d5ce:LIME);rim.intensity=light?.8:2.1;
    stage.position.set(0,0,0);floor.visible=false;
    groups.forEach(g=>{g.visible=false;g.position.set(0,0,0);g.rotation.set(0,0,0);g.scale.setScalar(1);});
    // The inactive stations remain tangible in the background, proving the space is continuous.
    placeAt(roadScene,STATIONS.car);setCar(2,0,true);
    placeAt(graph,STATIONS.graph);setGraph(0,'secant',0);
    placeAt(coffee,STATIONS.coffee);setCoffee(0,1,0);
    placeAt(projectile,STATIONS.ball);setBall(2,2);
    placeAt(chain,STATIONS.chain);gearGroups.forEach(g=>g.rotation.z=0);parcel.position.set(-4,0,.7);
    let origin=STATIONS.car.clone(), eye=V(-6,1,7), look=V(0,-1.4,0), shot='';
    const cameraPath=(a:THREE.Vector3,b:THREE.Vector3,c:THREE.Vector3)=>route(a,b,c,q);
    const graphShot=(variant:number)=>{
      origin.copy(STATIONS.graph);look.set(-.1,.8,0);
      const routes=[
        [V(8,3.8,2),V(3.4,2.2,10),V(.8,1.7,10.7)],
        [V(-5.2,1.4,8),V(-1.4,1.3,10.5),V(.4,1.2,10)],
        [V(2.2,1.6,6.5),V(.3,1.0,10),V(-.5,1.2,10.8)],
        [V(5.8,4.5,8),V(1,1.8,10.8),V(.3,1.4,10.4)],
        [V(-3.8,3,9),V(-.6,1.7,10.5),V(.6,1.8,10.8)],
      ]; eye=cameraPath(...routes[variant] as [THREE.Vector3,THREE.Vector3,THREE.Vector3]);shot=`graph-installation-${variant}`;
    };
    const coffeeShot=(variant:number)=>{
      origin.copy(STATIONS.coffee);look.set(0,-.1,0);
      const routes=[
        [V(7,3,2),V(4.4,3.6,5),V(1.9,2.8,6.2)],
        [V(1,5.6,.6),V(3.6,3.0,5.7),V(1.8,2.7,6.8)],
        [V(-4.5,3.3,4),V(-1.2,2,7.4),V(.6,2.2,7.7)],
        [V(4.8,2.4,5),V(1.4,2.3,7.6),V(-.3,2.2,8.0)],
        [V(-4,3.1,4.4),V(-.7,2.1,7.8),V(2.3,2.2,8.0)],
      ];eye=cameraPath(...routes[variant] as [THREE.Vector3,THREE.Vector3,THREE.Vector3]);if(variant>=2)look.set(width/height<1?0:1.5,-.1,0);shot=`coffee-orbit-${variant}`;
    };
    if(scene==='intro') {
      if(beat===0){
        const launch=smooth(p/cuePoint('intro','car-freeze',.057));setCar(mix(0,3,launch),launch,false);car.position.x=mix(-5,4,launch);car.scale.setScalar(1);
        const focus=car.position.clone().add(V(0,.7,0));look.copy(focus);
        eye=q<.20?V(20,8,24).lerp(focus.clone().add(V(-5,1.8,5)),easeOut(q/.2)):cameraPath(focus.clone().add(V(-6,2,5)),focus.clone().add(V(-4,1.4,4.8)),focus.clone().add(V(4.8,2,4.7)));
        shot='lab-fly-in-car-chase';
      }
      if(beat===1){
        car.scale.setScalar(1);car.position.set(0,-2.8,0);dial.visible=true;dial.position.copy(STATIONS.car).add(V(.4,-1.5,2.7));dial.scale.setScalar(.54);
        origin.copy(STATIONS.car);look.set(.25,-1.4,2.4);eye=cameraPath(V(-3.5,1,5),V(.4,-.4,6.4),V(.6,-.5,6.1));setDial(80);shot='speedometer-cockpit-dolly';
      }
      if(beat===2){coffeeShot(0);setCoffee(p,1,q);}
      if(beat===3){origin.copy(STATIONS.ball);const bt=p<cuePoint('intro','ball-peak',.649)?betweenCues('intro',p,'ball-rise','ball-peak',0,2):betweenCues('intro',p,'ball-fall','derivative-reveal',2,4);setBall(bt,2);look.copy(basket.position);eye=cameraPath(look.clone().add(V(-5,1.7,5)),look.clone().add(V(-2.6,2.5,6)),look.clone().add(V(3.3,2.3,7)));shot='ball-crane-up';}
      if(beat===4){origin.set(0,0,0);look.set(1,-.5,-2);eye=cameraPath(V(-16,5,20),V(2,6.2,19),V(16,5.5,17));shot='laboratory-traverse';}
    } else if(scene==='motion') {
      const t=derivativeReadout(scene,p).t!;setCar(t,q,true);car.scale.setScalar(.95);
      const focus=car.position.clone().add(V(0,.75,0));look.copy(focus);
      if(beat===0){eye=cameraPath(focus.clone().add(V(-6,1.2,5)),focus.clone().add(V(-4,1,4)),focus.clone().add(V(3,1.7,5)));shot='chase-acceleration';}
      if(beat===1){eye=cameraPath(focus.clone().add(V(1.6,-.15,2.1)),focus.clone().add(V(2.8,.1,3.5)),focus.clone().add(V(4,1.2,5)));shot='wheel-macro-to-side';}
      if(beat===2){eye=cameraPath(focus.clone().add(V(-2,5,3.5)),focus.clone().add(V(2,4,5)),focus.clone().add(V(4,2.4,5.5)));shot='car-overhead-overtake';}
      if(beat===3){setGraph(p,scene,beat);graphShot(0);}
      if(beat===4){setGraph(p,scene,beat);graph.position.copy(STATIONS.car).add(V(1,2.3,-4.2));origin.copy(STATIONS.car);look.set(0,.7,-2);eye=cameraPath(V(9,5.2,8),V(2.4,3.2,13),V(-3.4,3,13));shot='track-to-physical-graph';}
    } else if(scene==='average') {
      setCar(beat===0?betweenCues(scene,p,'point-a','point-b',1,3):mix(1,3,smooth(q)),q,true);car.scale.setScalar(.95);
      if(beat<2){origin.copy(STATIONS.car);look.set(0,-1.9,0);eye=beat===0?cameraPath(V(-5,5,8),V(0,7.6,6),V(3,6.3,7)):cameraPath(V(7,1,7),V(2,2.6,10),V(-2,3,10));shot=beat===0?'track-measure-overhead':'track-distance-traverse';}
      else{setGraph(p,scene,beat);graphShot(beat);}
    } else if(scene==='secant'||scene==='limit') {
      setGraph(p,scene,beat);graphShot(beat);
      if(scene==='limit'&&beat===2){origin.copy(STATIONS.graph);const a=gp(2,4);look.copy(a);eye=cameraPath(a.clone().add(V(3.3,2,7)),a.clone().add(V(.2,.35,4.6)),a.clone().add(V(-.3,.7,8.8)));shot='limit-portal-push';}
    } else if(scene==='tangent') {
      if(beat===0){setGraph(p,scene,beat);graphShot(2);}
      else{coffeeShot(beat);setCoffee(p,beat,q);temp.object.visible=p>=cuePoint(scene,'coffee-70',.227);}
    } else if(scene==='rules') {
      origin.copy(STATIONS.area);look.set(.1,.4,0);placeAt(square,origin);
      const x=3.4,h=beat===0?.001:beat===1?.9:beat===2?betweenCues(scene,p,'shrink-h','two-x',.9,.012):.012;
      const gap=beat===1?.46*smooth(q/.35):.06;
      areaBase.scale.set(x,x,1);areaBase.position.set(-.35,-.2,0);
      stripX.scale.set(h,x,1);stripX.position.set(-.35+x/2+h/2+gap,-.2,.22);
      stripY.scale.set(x,h,1);stripY.position.set(-.35,-.2+x/2+h/2+gap,.22);
      areaCorner.scale.set(h,h,1);areaCorner.position.set(stripX.position.x,stripY.position.y,.35);
      stripX.visible=p>=cuePoint(scene,'strip-right',.2);stripY.visible=p>=cuePoint(scene,'strip-top',.245);areaCorner.visible=p>=cuePoint(scene,'corner',.275);
      areaTitle.object.position.set(-.35,-.2,.25);stripXTitle.object.position.copy(stripX.position).add(V(0,0,.3));stripYTitle.object.position.copy(stripY.position).add(V(0,0,.3));cornerTitle.object.position.copy(areaCorner.position).add(V(0,0,.3));
      stripXTitle.object.visible=stripX.visible&&beat<3;stripYTitle.object.visible=stripY.visible&&beat<3;cornerTitle.object.visible=areaCorner.visible&&beat<3;
      xSide.object.position.x=-.35;hSide.object.position.x=stripX.position.x;hSide.object.visible=beat>0;
      equal.object.visible=beat>0;equal.set(beat===1?'xh + xh + h²':beat===2?'2x + h':beat===3?'2x':'6x');
      eye=cameraPath(V(beat%2?5:-5,4,6),V(beat%2?1.6:-1.6,2.3,10),V(.3,1.8,10.5));shot=`area-workbench-${beat}`;
      if(beat===3){square.visible=false;placeAt(powers,origin);faceTop.position.y=1.36+.35*smooth(q);faceSide.position.x=1.76+.35*smooth(q);const showCube=p>=cuePoint(scene,'cube-rule',.744);constant.visible=!showCube;constant.position.set(0,.6,0);constant.scale.setScalar(showCube?1:2.4);powerCube.visible=faceTop.visible=faceSide.visible=cubeTitle.object.visible=cubeAnswer.object.visible=showCube;eye=cameraPath(V(6,5,3),V(4,3.5,6.6),V(-4,3.1,7.1));shot='cube-three-faces-orbit';}
      if(beat===4){
        square.visible=false;placeAt(quadratic,origin);
        const vanishCue=labCueById(scene,'constant-vanishes')!,answerCue=labCueById(scene,'six-x')!;
        const vanishDuration=(answerCue.progress-vanishCue.progress)*.6/(answerCue.at-vanishCue.at);
        const vanish=smooth((p-vanishCue.progress)/vanishDuration);
        fiveConstants.visible=vanish<1;fiveConstants.scale.setScalar(Math.max(.001,1-vanish));fiveConstants.position.set(0,-1.25-.35*vanish,-1.2*vanish);
        quadraticLabels.forEach(label=>label.set(p>=vanishCue.progress?'2x':'x²'));
        quadraticAnswer.object.visible=p>=answerCue.progress;
        eye=cameraPath(V(-6,3.2,5.8),V(-1.3,2.5,10),V(1.8,2.1,10.5));shot='three-squares-constant';
      }
    } else if(scene==='chain') {
      origin.copy(STATIONS.chain);look.set(0,.25,0);
      if(beat<4){const spin=(beat+q)*.7;gearGroups[0].rotation.z=-spin*3;gearGroups[1].rotation.z=spin*2;parcel.position.set(mix(-4,3.8,smooth(q)),.15,.7);eye=cameraPath(V(beat%2?6:-6,3.5,4),V(beat%2?2.2:-2.2,2,10.5),V(beat%2?-1:1,2,11));shot=`mechanism-orbit-${beat}`;}
      else{chain.visible=false;placeAt(product,origin);const h=mix(.8,.4,smooth(q));productW.scale.set(h,2.5,1);productW.position.set(1.6+h/2+.1,-.2,.22);productH.scale.set(3.8,h*.7,1);productH.position.set(-.3,1.05+h*.35+.1,.22);productC.scale.set(h,h*.7,1);productC.position.set(productW.position.x,productH.position.y,.3);productWT.object.position.copy(productW.position).add(V(0,0,.3));productHT.object.position.copy(productH.position).add(V(0,0,.3));eye=cameraPath(V(5,4,5),V(1.8,2.3,9),V(-1,2.2,9.5));shot='product-blocks-explode';}
    } else if(scene==='extrema') {
      origin.copy(STATIONS.ball);
      if(beat<4){const t=beat===0?(p<cuePoint(scene,'ball-fall',.1546)?betweenCues(scene,p,'ball-rise','ball-fall',0,2):betweenCues(scene,p,'ball-fall','velocity-law',2,4)):beat===1?mix(.5,3.5,smooth(q)):beat===2?2:betweenCues(scene,p,'positive-before','negative-after',1,3);setBall(t,beat);ballTag.object.visible=p>=cuePoint(scene,'ball-height-4',.537);velocityTag.object.visible=!(beat===2&&p<cuePoint(scene,'ball-zero',.43));look=beat<2?basket.position.clone():V(0,.5,0);eye=beat<2?cameraPath(look.clone().add(V(-5,1.2,6)),look.clone().add(V(-2.3,2,8)),look.clone().add(V(4,2.1,9))):cameraPath(V(5,4,6),V(1.8,2.8,10),V(-2.2,2.6,10));shot=beat<2?'ball-tracking-crane':'peak-orbit-sign-change';}
      else{graph.visible=false;origin.copy(STATIONS.graph);placeAt(cubic,origin);const x=mix(-1.25,1.25,smooth(q));cubeDot.position.set(x*2,x**3,.08);look.set(0,.5,0);eye=cameraPath(V(-5,3,6),V(-.8,1.6,10),V(.8,1.8,10.7));shot='stationary-not-extremum';}
    } else {
      if(beat===0){const t=p<cuePoint('outro','car-speed-4',.1101)?betweenCues('outro',p,'car-recap','car-speed-4',1,2):betweenCues('outro',p,'car-speed-4','car-speed-6',2,3);setCar(t,q,true);car.scale.setScalar(.95);look=car.position.clone().add(V(0,.7,0));eye=cameraPath(look.clone().add(V(-4,1,4)),look.clone().add(V(1,2.7,6)),look.clone().add(V(4,2,6)));shot='recap-car-orbit';}
      if(beat===1){coffeeShot(3);setCoffee(p,3,q);}
      if(beat===2){origin.copy(STATIONS.ball);const t=p<cuePoint('outro','ball-peak',.4372)?betweenCues('outro',p,'ball-recap','ball-peak',0,2):betweenCues('outro',p,'ball-fall','two-states',2,4);setBall(t,2);look.set(0,.7,0);eye=cameraPath(V(-5,3,6),V(1,2.8,9),V(4,3,8));shot='recap-ball-peak';}
      if(beat===3){setGraph(p,'outro',beat);graphShot(3);}
      if(beat===4){origin.set(0,0,0);look.set(1,.1,-6);eye=cameraPath(V(3,4,14),V(11,6,19),V(18,7.5,23));shot='laboratory-final-pullback';}
    }
    const worldEye=origin.clone().add(eye),worldLook=origin.clone().add(look);
    key.position.copy(worldLook).add(V(-6,11,8));key.target.position.copy(worldLook);world.add(key.target);
    placeCamera(worldEye,worldLook);
    canvas.dataset.cue=labCueAt(scene,p).id;diagnostics.scene=scene;diagnostics.beat=beat;diagnostics.shot=shot;diagnostics.theme=theme;
    diagnostics.camera=camera.position.toArray();diagnostics.target=worldLook.toArray();
    canvas.dataset.shot=shot;canvas.dataset.theme=theme;canvas.dataset.cameraPosition=diagnostics.camera.map(n=>n.toFixed(3)).join(',');
    renderer.render(world,camera);
  };
  canvas.dataset.carAsset='loading';
  const ready = loadCarAsset(options.carUrl).then(asset=>{
    if(disposed){asset.dispose();return {loaded:false};}
    for(const child of car.children)child.visible=false;
    importedCar=asset;car.add(asset.root);canvas.dataset.carAsset='gltf';renderFrame(lastFrame);return {loaded:true};
  }).catch(()=>{canvas.dataset.carAsset='fallback';return {loaded:false};});
  const resize = (w: number, h: number, pixelRatio?: number) => { if (disposed || w < 1 || h < 1) return; width = w; height = h; if (pixelRatio !== undefined) renderer.setPixelRatio(clamp(pixelRatio, 1, 2)); renderer.setSize(w, h, false); renderFrame(lastFrame); };
  const dispose = () => {
    if (disposed) return; disposed = true;
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    world.traverse(object => { const m = object as THREE.Mesh; if (m.geometry) geometries.add(m.geometry); if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => { materials.add(mat); Object.values(mat).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); }); }); });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); reflection.dispose(); key.shadow.dispose(); renderer.dispose();
  };
  return { renderFrame, resize, dispose, renderer, ready, getDiagnostics: () => ({...diagnostics, camera:[...diagnostics.camera], target:[...diagnostics.target]}) };
}
export type DerivativeSceneProps = DerivativeFrame & { onReady?: () => void };
export default function DerivativeScene(frame: DerivativeSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ReturnType<typeof createDerivativeRenderer> | null>(null);
  const latestFrame = useRef(frame); latestFrame.current = frame;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current, container = host.current;
    if (!element || !container) return;
    let observer: ResizeObserver | undefined;
    let active=true;
    const contextLost = (event: Event) => { event.preventDefault(); setFailed(true); };
    const contextRestored = () => { setFailed(false); engine.current?.renderFrame(latestFrame.current); };
    element.addEventListener('webglcontextlost', contextLost);
    element.addEventListener('webglcontextrestored', contextRestored);
    try {
      engine.current = createDerivativeRenderer(element);
      observer = new ResizeObserver(([entry]) => engine.current?.resize(entry.contentRect.width, entry.contentRect.height));
      observer.observe(container);
      engine.current.resize(container.clientWidth, container.clientHeight);
      engine.current.renderFrame(latestFrame.current);
      void engine.current.ready.then(()=>{if(active)latestFrame.current.onReady?.();});
    } catch { setFailed(true); latestFrame.current.onReady?.(); }
    return () => {
      active=false; observer?.disconnect(); engine.current?.dispose(); engine.current = null;
      element.removeEventListener('webglcontextlost', contextLost); element.removeEventListener('webglcontextrestored', contextRestored);
    };
  }, []);
  useEffect(() => { engine.current?.renderFrame(frame); }, [frame.time, frame.scene, frame.progress, frame.playing]);
  return <div className="derivative-scene" ref={host} data-renderer={failed ? 'fallback' : 'webgl'}>
    <canvas ref={canvas} aria-label="Трёхмерная модель производной" className={failed ? 'derivative-scene-unavailable' : ''} />
    {failed && <svg className="derivative-scene-fallback" viewBox="0 0 1000 650" role="img" aria-label="Парабола и касательная в точке 2, 4">
      <defs><linearGradient id="derivative-fallback-gradient"><stop stopColor="#d1ff00"/><stop offset="1" stopColor="#eaf7ab"/></linearGradient></defs>
      <path d="M160 560H880M220 595V60" stroke="#2a4656" strokeWidth="2"/>
      <path d={Array.from({ length: 81 }, (_, i) => { const x = -.4 + i / 80 * 4.0; return `${i ? 'L' : 'M'}${220 + x * 150} ${560 - x * x * 37.5}`; }).join(' ')} fill="none" stroke="url(#derivative-fallback-gradient)" strokeWidth="5"/>
      <path d="M370 560L805 125" stroke="#d1ff00" strokeWidth="3"/>
      <circle cx="520" cy="410" r="9" fill="#fff"/>
      <text x="510" y="385" fill="#daeaf2" fontSize="23">A (2; 4)</text>
      <text x="665" y="495" fill="#d1ff00" fontSize="23">y = 4x − 4</text>
    </svg>}
  </div>;
}
