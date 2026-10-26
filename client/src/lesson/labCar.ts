import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type LabCarAsset = {
  root: THREE.Group;
  /** Absolute rolling angle; positive values roll toward the model's +X front. */
  spinWheels: (radians: number) => void;
  dispose: () => void;
};

/**
 * Local Khronos/DGG CarConcept asset. Attribution is kept beside the GLB.
 * The returned model is 4.5 units long, +X forward, Y-up, grounded at Y=0.
 * No decoder, environment map, font, or other network resource is requested.
 */
export async function loadCarAsset(url = '/models/cinema/car-concept.glb'): Promise<LabCarAsset> {
  const loader = new GLTFLoader();
  // Embedded GLB images use object URLs. Decode them through <img> so they
  // remain under img-src, without opening connect-src to blob fetches.
  loader.register(parser => {
    parser.textureLoader = new THREE.TextureLoader(parser.options.manager)
      .setCrossOrigin(parser.options.crossOrigin)
      .setRequestHeader(parser.options.requestHeader);
    return { name: 'LAB_LOCAL_TEXTURES' };
  });
  const gltf = await loader.loadAsync(url);
  const root = new THREE.Group();
  root.name = 'LabCar';
  const orientation = new THREE.Group();
  orientation.name = 'CarForwardX';
  // glTF is already Y-up. Its named headlights face +Z; rotate that front to +X.
  orientation.rotation.y = Math.PI / 2;
  orientation.add(gltf.scene);
  root.add(orientation);

  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const removed: THREE.Object3D[] = [];
  gltf.scene.traverse(object => {
    if (/license|emblem|logo/i.test(object.name)) removed.push(object);
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (materials.has(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) { value.anisotropy = 4; textures.add(value); }
      }
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.envMapIntensity = 1.05;
      if (/^Paint 1/i.test(material.name)) {
        material.color.set('#bbed28');
        material.metalness = .62;
        material.roughness = .23;
        if (material instanceof THREE.MeshPhysicalMaterial) {
          material.clearcoat = 1;
          material.clearcoatRoughness = .13;
          material.iridescence = 0;
        }
      } else if (/^Paint 2/i.test(material.name)) {
        material.color.set('#18231b'); material.metalness = .55; material.roughness = .30;
      } else if (/^Interior 3/i.test(material.name)) {
        material.color.set('#425137'); material.roughness = .47;
      }
      if (/glass/i.test(material.name) || (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0)) {
        if (material instanceof THREE.MeshPhysicalMaterial) { material.transmission = 0; material.thickness = 0; }
        material.color.set('#87aaa7'); material.opacity = .45; material.transparent = true;
        material.depthWrite = false; material.roughness = .09; material.metalness = .16;
      }
      material.needsUpdate = true;
    }
  });
  removed.forEach(object => object.removeFromParent());

  const spinners: THREE.Group[] = [];
  for (const name of ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR']) {
    const wheel = gltf.scene.getObjectByName(name);
    if (!wheel) continue;
    // The source's front wheels are posed with 30° steering. Remove that yaw,
    // retaining the artist's initial spoke rotation around their local X axle.
    if (name.startsWith('WheelFront')) {
      wheel.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6));
    }
    const spinner = new THREE.Group();
    spinner.name = `${name}Rolling`;
    const rollingParts = wheel.children.filter(child => !/BrakePad/i.test(child.name));
    wheel.add(spinner);
    // The new identity parent preserves authored local mesh transforms. Calipers
    // remain on the stationary axle while rims, discs and tires roll together.
    rollingParts.forEach(part => spinner.add(part));
    spinners.push(spinner);
  }

  root.updateMatrixWorld(true);
  const initialBounds = new THREE.Box3().setFromObject(root, true);
  const length = initialBounds.max.x - initialBounds.min.x;
  if (!Number.isFinite(length) || length <= 0) {
    geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose()); textures.forEach(item => item.dispose());
    throw new Error('Car model has invalid bounds');
  }
  orientation.scale.setScalar(4.5 / length);
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root, true), center = bounds.getCenter(new THREE.Vector3());
  orientation.position.set(-center.x, -bounds.min.y, -center.z);
  root.updateMatrixWorld(true);
  root.userData.asset = 'Khronos CarConcept — DGG, CC-BY-4.0';
  root.userData.forward = '+X';
  const rearWheel = gltf.scene.getObjectByName('WheelRearL');
  root.userData.wheelRadius = rearWheel ? new THREE.Box3().setFromObject(rearWheel, true).getSize(new THREE.Vector3()).y / 2 : .39 * orientation.scale.x;
  let disposed = false;
  return {
    root,
    spinWheels(radians: number) {
      if (disposed) return;
      const angle = Number.isFinite(radians) ? radians : 0;
      spinners.forEach(spinner => { spinner.rotation.x = angle; });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      geometries.forEach(item => item.dispose());
      materials.forEach(item => item.dispose());
      textures.forEach(item => item.dispose());
      // GLTFLoader may decode embedded textures as ImageBitmaps; release their
      // CPU storage too, once per shared image, after all materials are disposed.
      const images = new Set<unknown>();
      textures.forEach(texture => {
        const source = texture.source?.data;
        if (source && !images.has(source)) {
          images.add(source);
          if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
        }
      });
      root.clear();
    },
  };
}
