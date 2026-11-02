import * as THREE from 'three';

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * compileAsync submits the entire object tree synchronously before it waits.
 * Limit that submission while keeping every object/material variant and the
 * target scene's lighting and environment. Never reparent or hide an object.
 */
export async function compileInBatches(renderer, scene, camera, {
  batchSize = 24, yieldTask = nextTask, onProgress,
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('Invalid shader batch size');
  const objects = [];
  scene.traverse(object => {
    if (object.material && (object.isMesh || object.isPoints || object.isLine || object.isSprite)) objects.push(object);
  });
  const batch = new THREE.Object3D();
  // The third compileAsync argument supplies the real scene. Enumerating only
  // this batch avoids duplicate child traversal and preserves world transforms.
  let current = [];
  batch.traverse = callback => { callback(batch); for (const object of current) callback(object); };
  batch.traverseVisible = callback => { if (batch.visible) callback(batch); };
  try {
    for (let start = 0; start < objects.length; start += batchSize) {
      current = objects.slice(start, start + batchSize);
      await renderer.compileAsync(batch, camera, scene);
      onProgress?.({ completed: Math.min(start + batchSize, objects.length), total: objects.length });
      if (start + batchSize < objects.length) await yieldTask();
    }
  } finally { current = []; }
}
