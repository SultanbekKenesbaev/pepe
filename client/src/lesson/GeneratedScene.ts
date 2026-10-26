import * as THREE from 'three';
import type { GeneratedLessonChapter } from '../../../shared/types';

const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
const colors = [0x91d931, 0x52a9ff, 0xffb354, 0x64dec1, 0xafa6ff, 0xff786d, 0x75c6ed, 0xd7b85f];
type Moving = { mesh: THREE.Object3D; base: THREE.Vector3; order: number; spin?: boolean };

/** All camera and object transforms derive from the supplied film time. Seeking never runs a simulation. */
export class GeneratedScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(43, 1, .1, 150);
  private chapters: { root: THREE.Group; moving: Moving[]; chapter: GeneratedLessonChapter }[] = [];
  private observer: ResizeObserver;
  private labels: THREE.Sprite[] = [];
  private host: HTMLElement;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private lastTime = 0;

  constructor(host: HTMLElement, chapters: GeneratedLessonChapter[]) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.domElement.setAttribute('aria-label', 'Трёхмерная сцена урока');
    host.append(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight(0xf1f7ff, 0x242f4c, 2.8));
    const key = new THREE.DirectionalLight(0xffffff, 4); key.position.set(4, 9, 6); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x62aaff, 3); rim.position.set(-6, 5, -5); this.scene.add(rim);
    chapters.forEach((chapter, index) => this.build(chapter, index));
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
  }

  private mesh(geometry: THREE.BufferGeometry, color: number, metalness = .25) {
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, metalness, roughness: .27 }));
  }

  private text(root: THREE.Object3D, value: string, x: number, y: number, z: number, dark: boolean, width = 3.4) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = dark ? 'rgba(10,20,35,.94)' : 'rgba(255,255,255,.96)';
    ctx.beginPath(); ctx.roundRect(4, 20, 504, 216, 30); ctx.fill();
    ctx.font = `${value.length < 10 ? 72 : 46}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = dark ? '#eff6ff' : '#182a40';
    const words = value.split(/\s+/); const lines: string[] = []; let line = '';
    for (const word of words) { const next = `${line} ${word}`.trim(); if (ctx.measureText(next).width > 470 && line) { lines.push(line); line = word; } else line = next; }
    if (line) lines.push(line);
    lines.slice(0, 3).forEach((s, i, all) => ctx.fillText(s, 256, 128 + (i - (all.length - 1) / 2) * 58, 470));
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.position.set(x, y, z); sprite.scale.set(width, width / 2, 1); root.add(sprite); this.labels.push(sprite); return sprite;
  }

  private link(root: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, color = 0x66819c, radius = .035) {
    const vector = b.clone().sub(a); const tube = this.mesh(new THREE.CylinderGeometry(radius, radius, vector.length(), 12), color);
    tube.position.copy(a).add(b).multiplyScalar(.5); tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector.normalize()); root.add(tube);
  }

  private build(chapter: GeneratedLessonChapter, index: number) {
    const root = new THREE.Group(); root.position.x = index * 24; this.scene.add(root);
    const dark = chapter.palette === 'dark'; const moving: Moving[] = [];
    const track = (mesh: THREE.Object3D, order: number, spin = false) => { root.add(mesh); moving.push({ mesh, base: mesh.position.clone(), order, spin }); return mesh; };
    const platform = this.mesh(new THREE.CylinderGeometry(8, 8.4, .3, 80), dark ? 0x162238 : 0xdce8f2, .35); platform.position.y = -.25; root.add(platform);
    const ring = this.mesh(new THREE.TorusGeometry(7.5, .028, 8, 128), 0x7fb438); ring.rotation.x = Math.PI / 2; ring.position.y = -.06; root.add(ring);
    const grid = new THREE.GridHelper(16, 24, dark ? 0x385170 : 0x9ab0c3, dark ? 0x1c3048 : 0xc5d5e3); grid.position.y = -.07; root.add(grid);
    const labels = chapter.labels.length ? chapter.labels : [chapter.headline];
    if (chapter.scene === 'comparison' && !chapter.values.length) {
      labels.slice(0, 8).forEach((label, i, all) => {
        const x = (i - (all.length - 1) / 2) * Math.min(3.6, 13 / all.length);
        const object = this.mesh(new THREE.OctahedronGeometry(.9), colors[i % colors.length]); object.position.set(x, 2, (i % 2) * .5); track(object, i, true);
        this.text(root, label, x, 3.6, 0, dark, Math.min(3.5, 13 / all.length));
      });
    } else if (chapter.scene === 'chart' || chapter.scene === 'comparison') {
      const count = Math.min(labels.length, chapter.values.length || labels.length, 8);
      const values = chapter.values.length ? chapter.values : labels.map(() => 1);
      const positive = Math.max(...values, 0), negative = Math.max(...values.map(n => -n), 0);
      const maximum = positive + negative || 1, baseline = .15 + negative / maximum * 4.3;
      for (let i = 0; i < count; i++) {
        const value = values[i]; const height = Math.max(.008, Math.abs(value) / maximum * 4.3);
        const x = (i - (count - 1) / 2) * Math.min(2.25, 12 / count);
        const bar = this.mesh(new THREE.BoxGeometry(1.15, height, 1.15), colors[i % colors.length]);
        bar.position.set(x, baseline + (value < 0 ? -height / 2 : height / 2), 0); track(bar, i);
        this.text(root, `${value}`, x, value < 0 ? baseline - height - .5 : baseline + height + .5, 0, dark, 1.6);
        this.text(root, labels[i], x, -.9, 1, dark, Math.min(2.5, 12 / count));
      }
      this.link(root, new THREE.Vector3(-6.5, baseline, 0), new THREE.Vector3(6.5, baseline, 0), dark ? 0x90a5bd : 0x52677d, .025);
    } else if (chapter.scene === 'process') {
      labels.slice(0, 8).forEach((label, i, all) => {
        const theta = (i / Math.max(all.length - 1, 1) - .5) * 2;
        const point = new THREE.Vector3(Math.sin(theta) * 6, 1.3 + (i % 2) * .55, Math.cos(theta) * 2 - 2);
        const block = this.mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), colors[i % colors.length]); block.position.copy(point); track(block, i);
        this.text(root, `${i + 1}. ${label}`, point.x, point.y + 1.5, point.z, dark, 3.1);
        if (i) { const p = moving[i - 1].base; this.link(root, p, point, 0x6ba6cd, .06); }
      });
    } else {
      const core = this.mesh(new THREE.IcosahedronGeometry(1.3, 1), colors[0], .5); core.position.y = 2.5; track(core, 0, true);
      const orbit = this.mesh(new THREE.TorusGeometry(4.3, .025, 8, 100), 0x668aaf); orbit.rotation.x = Math.PI / 2.9; orbit.position.y = 2.5; root.add(orbit);
      labels.slice(0, 8).forEach((label, i, all) => {
        const theta = i * Math.PI * 2 / all.length + .2;
        const point = new THREE.Vector3(Math.cos(theta) * 4.3, 2.5 + Math.sin(theta) * 1.15, Math.sin(theta) * 3.1);
        const object = this.mesh(new THREE.IcosahedronGeometry(.53, chapter.scene === 'concept' ? 0 : 2), colors[(i + 1) % colors.length]);
        object.position.copy(point); track(object, i + 1, true);
        this.link(root, new THREE.Vector3(0, 2.5, 0), point, dark ? 0x36597a : 0x94b0c8);
        this.text(root, label, point.x, point.y + 1, point.z, dark, 3.2);
      });
    }
    this.chapters.push({ root, moving, chapter });
  }

  private resize() {
    const width = this.host.clientWidth || 1, height = this.host.clientHeight || 1;
    this.renderer.setSize(width, height); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    if (this.chapters.length) this.renderAt(this.lastTime);
  }

  renderAt(time: number) {
    this.lastTime = time;
    let index = 0;
    this.chapters.forEach(({ chapter }, i) => { if (time >= chapter.start) index = i; });
    this.chapters.forEach(({ root }, i) => { root.visible = i === index; });
    const { root, moving, chapter } = this.chapters[index];
    const elapsed = clamp(time - chapter.start, 0, chapter.duration);
    const p = elapsed / Math.max(chapter.duration, .001);
    const dark = chapter.palette === 'dark'; this.scene.background = new THREE.Color(dark ? 0x080f1a : 0xeaf2fa);
    this.scene.fog = new THREE.Fog(dark ? 0x080f1a : 0xeaf2fa, 28, 65);
    moving.forEach(({ mesh, base, order, spin }) => {
      const entrance = this.reduced ? 1 : smooth((elapsed - order * .18) / .65);
      mesh.scale.setScalar(Math.max(.001, entrance)); mesh.position.copy(base); mesh.position.y += (1 - entrance) * 1.6;
      if (spin) { mesh.rotation.set(elapsed * .08, elapsed * .16 + order, elapsed * .04); }
    });
    // A restrained continuous orbit plus four deliberate shot changes; all values are seek-safe.
    const shot = Math.floor(p * 4); const within = (p * 4) % 1;
    const baseAngles = [.26, -.42, .72, .02];
    const angle = this.reduced ? .25 : baseAngles[Math.min(shot, 3)] + (within - .5) * .16;
    const portrait = this.camera.aspect < 1;
    const distance = (portrait ? 27 : 19.5) + (this.reduced ? 0 : Math.cos(within * Math.PI) * .8);
    this.camera.position.set(root.position.x + Math.sin(angle) * distance, portrait ? 13 : 10.5 + Math.sin(p * Math.PI * 2) * .6, Math.cos(angle) * distance);
    this.camera.lookAt(root.position.x, 2, 0);
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.dataset.chapter = chapter.id;
    this.renderer.domElement.dataset.time = time.toFixed(2);
    this.renderer.domElement.dataset.camera = this.camera.position.toArray().map(n => n.toFixed(5)).join(',');
  }

  dispose() {
    this.observer.disconnect();
    this.scene.traverse(object => {
      const mesh = object as THREE.Mesh; mesh.geometry?.dispose();
      if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const map = (material as THREE.MeshStandardMaterial).map; map?.dispose(); material.dispose();
      }
    });
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); this.labels = [];
  }
}
