import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneTheme } from './sceneTheme';

/** Architectural scenery stays fixed in world coordinates. Camera travel, not a spinning
 * backdrop, produces all parallax. One laboratory has a lit gallery and a night test-track mode. */
export function createLabEnvironment(world: THREE.Scene) {
  const root = new THREE.Group(); root.name = 'derivative-laboratory'; world.add(root);
  const floorMaterial = new THREE.MeshStandardMaterial({color:0x172028,metalness:.23,roughness:.48});
  const wallMaterial = new THREE.MeshStandardMaterial({color:0x151d24,metalness:.25,roughness:.62});
  const metalMaterial = new THREE.MeshStandardMaterial({color:0x4e5962,metalness:.76,roughness:.27});
  const plinthMaterial = new THREE.MeshStandardMaterial({color:0x243039,metalness:.28,roughness:.35});
  const glassMaterial = new THREE.MeshPhysicalMaterial({color:0x789a9d,metalness:.12,roughness:.14,transparent:true,opacity:.16,depthWrite:false,side:THREE.DoubleSide});
  const lightMaterial = new THREE.MeshBasicMaterial({color:0xeaffd4,toneMapped:false});
  const lineMaterial = new THREE.MeshBasicMaterial({color:0x5e6e71});
  function box(w:number,h:number,d:number,mat:THREE.Material,x:number,y:number,z:number) { const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;root.add(m);return m; }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(110,90),floorMaterial);floor.rotation.x=-Math.PI/2;floor.position.y=-3.25;floor.receiveShadow=true;root.add(floor);
  // Structural uprights and the distant wall establish human-scale space from every camera.
  box(76,15,.35,wallMaterial,0,3.9,-26);
  for(const x of [-28,-20,-12,-4,4,12,20,28]) {
    box(.24,12,.35,metalMaterial,x,2.7,-24);
    if(Math.abs(x)>5)box(.32,11,.32,metalMaterial,x,2.2,14);
    box(.22,.24,39,metalMaterial,x,7.7,-5);
    box(.09,5,.08,lightMaterial,x,-.1,-23.77);
  }
  for(const z of [-20,-12,-4,4,12]) {
    box(64,.24,.28,metalMaterial,0,7.7,z);
    box(58,.035,.14,lightMaterial,0,7.54,z);
    for(const x of [-18,-6,6,18]) box(6,.05,2.1,lightMaterial,x,7.72,z+1.2);
  }
  for(let i=-12;i<=12;i++) {
    box(.025,.008,72,lineMaterial,i*4,-3.239,0);
    box(96,.008,.025,lineMaterial,0,-3.238,i*4);
  }
  // Transparent partition bays and equipment blocks create genuine foreground occlusion.
  for(const x of [-24,24]) for(const z of [-15,-7,1,9]) {
    box(.07,6.8,5.9,glassMaterial,x,.2,z);
    box(.15,7.1,.15,metalMaterial,x,.3,z-3);
    box(.15,7.1,.15,metalMaterial,x,.3,z+3);
  }
  for(const [x,z] of [[-15,-16],[12,-17],[19,5],[-20,8],[0,-21]]) {
    box(3.4,1.15,2.1,plinthMaterial,x,-2.67,z);
    box(3.55,.13,2.2,metalMaterial,x,-2.02,z);
    box(2.6,.06,.06,lightMaterial,x,-2.1,z+1.12);
    const display = box(2.4,1.4,.12,wallMaterial,x,-1.15,z-.35); display.rotation.x=-.15;
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4,.055,12,80),lightMaterial);ring.rotation.x=Math.PI/2;ring.position.set(0,-3.19,1);root.add(ring);
  // Batch the immutable architecture by material: this preserves its depth and shadows
  // while avoiding hundreds of individual draw calls on classroom laptops.
  root.updateMatrixWorld(true);
  const batches=new Map<THREE.Material,THREE.Mesh[]>();
  for(const child of [...root.children]) { const m=child as THREE.Mesh; if(!m.geometry||Array.isArray(m.material)||m.material===glassMaterial)continue; const list=batches.get(m.material)||[];list.push(m);batches.set(m.material,list); }
  for(const [mat,items] of batches){
    if(items.length<2)continue;
    const geometries=items.map(item=>item.geometry.clone().applyMatrix4(item.matrix));
    const geometry=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());
    if(!geometry)continue;
    const batched=new THREE.Mesh(geometry,mat);batched.castShadow=mat!==lightMaterial&&mat!==lineMaterial;batched.receiveShadow=true;root.add(batched);
    for(const item of items){root.remove(item);item.geometry.dispose();}
  }
  let theme:SceneTheme|undefined;
  function setTheme(next:SceneTheme) {
    if(theme===next)return;theme=next;const light=next==='light';
    floorMaterial.color.set(light?0xc7d2cd:0x121d28);floorMaterial.metalness=light?.06:.3;floorMaterial.roughness=light?.62:.42;
    wallMaterial.color.set(light?0xd7dfdc:0x151f29);
    metalMaterial.color.set(light?0x9eaaa9:0x53616b);
    plinthMaterial.color.set(light?0xe3e9e4:0x24333e);
    lineMaterial.color.set(light?0xb4c4be:0x344955);
    lightMaterial.color.set(light?0xffffff:0xd1ff80);
    glassMaterial.opacity=light?.12:.18;
  }
  return {root,setTheme};
}
