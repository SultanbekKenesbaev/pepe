import type { GraphModel, FaceResult } from '@vladmandic/human';
import type { CameraMatch, FaceEnrollment } from '../../shared/types';

export const FACE_MODEL_VERSION = 'human-v3-face-description-1024';
export const FACE_MATCH_THRESHOLD = 0.65;
export const FACE_MATCH_MARGIN = 0.08;
type HumanEngine = InstanceType<(typeof import('@vladmandic/human'))['default']>;
type LoadedEngine = { human: HumanEngine; descriptor: GraphModel };
let enginePromise: Promise<LoadedEngine> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function engine(): Promise<LoadedEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { default: Human } = await import('@vladmandic/human');
      const human = new Human({
        backend: 'webgl', modelBasePath: '/models/face/', cacheSensitivity: 0,
        filter: { enabled: true, equalization: true, flip: false },
        face: {
          enabled: true,
          detector: { enabled: true, maxDetected: 80, minConfidence: 0.65, minSize: 35, rotation: true, return: true, skipFrames: 0, skipTime: 0 },
          mesh: { enabled: true }, attention: { enabled: false }, iris: { enabled: false },
          // Human's description pipeline also infers age and gender. Keep it disabled;
          // the separate graph below executes only the upstream identity embedding.
          description: { enabled: false }, emotion: { enabled: false }, antispoof: { enabled: false },
          liveness: { enabled: false }, gear: { enabled: false },
        },
        body: { enabled: false }, hand: { enabled: false }, object: { enabled: false },
        gesture: { enabled: false }, segmentation: { enabled: false },
      });
      try {
        await human.load();
      } catch {
        human.config.backend = 'cpu';
        await human.init();
        await human.load();
      }
      const descriptor = await human.tf.loadGraphModel('/models/face/faceres.json') as GraphModel;
      return { human, descriptor };
    })().catch(error => {
      enginePromise = null;
      throw new Error('Не удалось загрузить распознавание. ' + (error instanceof Error ? error.message : ''));
    });
  }
  return enginePromise;
}

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const task = queue.then(operation);
  queue = task.catch(() => {});
  return task;
}
function validDescriptor(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 1024 && value.every(x => typeof x === 'number' && Number.isFinite(x)) && value.some(x => x !== 0);
}
async function describe(loaded: LoadedEngine, face: FaceResult): Promise<number[] | null> {
  if (!face.tensor || face.faceScore < 0.65) return null;
  const tf = loaded.human.tf;
  // Detector returns an aligned HWC face in [0,1]. Match the model's official
  // preprocessing while requesting only the 1024-dimensional pooling node.
  const input = tf.tidy(() => tf.mul(tf.image.resizeBilinear(tf.expandDims(face.tensor, 0), [224, 224], false), 255));
  let output: ReturnType<GraphModel['execute']> | undefined;
  try {
    output = loaded.descriptor.execute(input, 'global_pooling/Mean');
    const tensor = Array.isArray(output) ? output[0] : output;
    const descriptor = Array.from(await tensor.data());
    return validDescriptor(descriptor) ? descriptor : null;
  } finally {
    input.dispose();
    if (Array.isArray(output)) output.forEach(tensor => tensor.dispose()); else output?.dispose();
  }
}
function disposeFaces(faces: FaceResult[]): void {
  for (const face of faces) face.tensor?.dispose();
}

export function enrollFace(file: File): Promise<{ descriptor: number[]; modelVersion: string }> {
  return exclusive(async () => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Выберите JPG, PNG или WEBP.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Фото больше 10 МБ.');
    const url = URL.createObjectURL(file);
    const input = new Image();
    let faces: FaceResult[] = [];
    try {
      input.src = url;
      await input.decode();
      if (input.naturalWidth < 120 || input.naturalHeight < 120) throw new Error('Нужно фото не меньше 120 × 120.');
      if (input.naturalWidth * input.naturalHeight > 20_000_000 || input.naturalWidth > 8192 || input.naturalHeight > 8192) throw new Error('Слишком большое разрешение фото. Уменьшите его до 20 мегапикселей.');
      const loaded = await engine();
      faces = (await loaded.human.detect(input)).face;
      if (faces.length !== 1) throw new Error(faces.length ? 'На фото должно быть одно лицо.' : 'Лицо не найдено. Выберите другое фото.');
      const descriptor = await describe(loaded, faces[0]);
      if (!descriptor) throw new Error('Лицо недостаточно чёткое. Выберите другое фото.');
      return { descriptor, modelVersion: FACE_MODEL_VERSION };
    } finally {
      disposeFaces(faces);
      URL.revokeObjectURL(url);
    }
  });
}

export function scanFaces(video: HTMLVideoElement, enrollments: FaceEnrollment[]): Promise<{ detectedFaces: number; matches: CameraMatch[]; unknownFaces: number }> {
  return exclusive(async () => {
    if (video.readyState < 2 || !video.videoWidth) throw new Error('Камера ещё не готова.');
    const references = enrollments.filter(x => x.modelVersion === FACE_MODEL_VERSION && validDescriptor(x.descriptor));
    const loaded = await engine();
    const faces = (await loaded.human.detect(video)).face;
    try {
      const candidates: CameraMatch[] = [];
      for (const face of faces) {
        const descriptor = await describe(loaded, face);
        if (!descriptor) continue;
        const ranked = references.map(person => ({ studentId: person.studentId, similarity: loaded.human.match.similarity(descriptor, person.descriptor) }))
          .filter(x => Number.isFinite(x.similarity)).sort((a, b) => b.similarity - a.similarity);
        if (ranked[0] && ranked[0].similarity >= FACE_MATCH_THRESHOLD && (!ranked[1] || ranked[0].similarity - ranked[1].similarity >= FACE_MATCH_MARGIN)) candidates.push(ranked[0]);
      }
      // Two detected faces cannot claim the same identity. Ambiguous duplicates stay unknown.
      const matches = candidates.filter(x => candidates.filter(y => y.studentId === x.studentId).length === 1);
      return { detectedFaces: faces.length, matches, unknownFaces: faces.length - matches.length };
    } finally {
      disposeFaces(faces);
    }
  });
}
