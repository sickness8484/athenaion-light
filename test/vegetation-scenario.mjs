// Deterministic boundary/camera/budget scenarios shared by the upstream golden fixture and tests.
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { ATMO } from '../src/core/atmosphere.js';

export function runVegetationScenario(VegSystem, observe = () => {}) {
  let state = 0x19730721;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const camera = new THREE.PerspectiveCamera(44, 1.6, 0.5, 60000);
  camera.position.set(0, 12, 80); camera.lookAt(0, 12, -400);
  const engine = { camera, height: 941, quality: { name: 'high', detail: 1 }, params: new URLSearchParams(), patchMaterial() {} };
  const system = new VegSystem(engine);
  const material = new THREE.MeshStandardMaterial();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const variants = [
    { name: 'cypress', H: 24, px: [220, 100, 18], cullPx: 0.7, tris: [90000, 18000, 500, 2], shadowLod: 2 },
    { name: 'olive', H: 11, px: [90, 32, 9], cullPx: 0.8, tris: [50000, 8000, 220, 2], shadowLod: 2 },
    { name: 'shrub', H: 3.2, px: [36, 14, 6], cullPx: 1.2, tris: [18000, 4000, 100, 2], shadowLod: 1 },
    { name: 'empty', H: 5, px: [100, 30, 8], cullPx: 1, tris: [18000, 4000, 100, 2], shadowLod: 1 },
  ];
  for (const spec of variants) {
    const v = system.addVariant({
      ...spec,
      lods: spec.tris.map((tris, l) => l === 3 ? { bb: geometry, tris } : { bark: geometry, card: geometry, tris }),
      materials: { bark: material, card: material, bb: material },
    });
    if (spec.name === 'empty') continue;
    for (let i = 0; i < 360; i++) {
      const x = (random() - 0.5) * 1800, y = random() * 100 - 15, z = 300 - random() * 3600;
      const yaw = random() * Math.PI * 2, scale = 0.3 + random() * 2.5;
      system.add(v, x, y, z, yaw, scale, {
        tint: [0.75 + random() * 0.5, 0.7 + random() * 0.6, 0.6 + random() * 0.7], width: 0.6 + random(),
        ...(i % 3 === 0 ? { up: [0.1, 1, -0.05] } : i % 3 === 1 ? { tilt: [0.08, -0.12] } : {}),
      });
    }
    // Samples near all LOD hysteresis boundaries and the cull threshold, centred in the first shot.
    const focal = (engine.height * 0.5) / Math.tan(camera.fov * Math.PI / 360);
    for (const threshold of [...spec.px, spec.cullPx]) for (const factor of [0.879999, 0.88, 0.880001, 0.999999, 1, 1.000001, 1.119999, 1.12, 1.120001]) {
      const distance = spec.H * focal / (threshold * factor) + spec.H * 0.25;
      system.add(v, 0, 12 - spec.H / 2, 80 - distance, factor, 1, { tint: [1, 0.9, 0.8] });
    }
  }
  system.finalize();
  const steps = [
    { label: 'tight-budget', budget: '90000' },
    { label: 'stationary', maybe: true },
    { label: 'tiny-move', position: [0.1, 12, 80], maybe: true },
    { label: 'camera-move', position: [1, 12, 79.5], target: [1, 12, -400], maybe: true },
    { label: 'more-detail', budget: '8000000' },
    { label: 'hysteresis-near', position: [0, 12, 78], target: [0, 12, -400] },
    { label: 'hysteresis-far', position: [0, 12, 84], target: [0, 12, -400] },
    { label: 'very-tight-budget', budget: '5000' },
    { label: 'ultra-default', quality: 'ultra', budget: null },
    { label: 'preview-default', quality: 'preview', detail: 0.5 },
    { label: 'forced-near', forceLod: 0, budget: '1' },
    { label: 'forced-mid', forceLod: 2 },
    { label: 'forced-far', forceLod: 3 },
    { label: 'forced-clamped', forceLod: 5 },
    { label: 'reset-history', forceLod: null, quality: 'high', detail: 1, budget: '200000', reset: true },
    { label: 'portrait', height: 1170, aspect: 0.7, resetCamera: true, maybe: true },
    { label: 'high-resolution', height: 2160, aspect: 1.778, budget: null, resetCamera: true, maybe: true },
    { label: 'reverse-view', position: [800, 600, -2000], target: [0, 20, -300], fov: 61 },
    { label: 'low-sun', sun: [0.98, 0.06, -0.2], position: [0, 20, 180], target: [0, 20, -400], fov: 44 },
    { label: 'all-clipped', position: [100000, 0, 0], target: [101000, 0, 0] },
    { label: 'return-shot', position: [0, 12, 80], target: [0, 12, -400], sun: [0.6, 0.4, -0.6], height: 941, aspect: 1.6, reset: true, budget: '90000' },
  ];
  ATMO.uSunDir.value.set(0.6, 0.4, -0.6).normalize();
  const snapshots = [];
  for (const step of steps) {
    if (step.position) camera.position.set(...step.position);
    if (step.target) camera.lookAt(...step.target);
    if (step.fov !== undefined) camera.fov = step.fov;
    if (step.aspect !== undefined) camera.aspect = step.aspect;
    if (step.height !== undefined) engine.height = step.height;
    if (step.quality) engine.quality.name = step.quality;
    if (step.detail !== undefined) engine.quality.detail = system.detail = step.detail;
    if (step.sun) ATMO.uSunDir.value.set(...step.sun).normalize();
    if (Object.hasOwn(step, 'budget')) step.budget === null ? engine.params.delete('vegTris') : engine.params.set('vegTris', step.budget);
    if (Object.hasOwn(step, 'forceLod')) step.forceLod === null ? delete system.forceLod : system.forceLod = step.forceLod;
    if (step.reset) system.resetHistory();
    if (step.resetCamera) system.lastCam = null;
    camera.updateProjectionMatrix();
    const updated = step.maybe ? system.maybeUpdate(camera) : (system.update(camera), true);
    const snapshot = snapshotVegetation(system, step.label, updated);
    snapshots.push(snapshot);
    observe(system, snapshot);
  }
  return { snapshots, system };
}

function snapshotVegetation(system, label, updated) {
  const history = createHash('sha256'), matrices = createHash('sha256'), colors = createHash('sha256');
  const hashArray = (hash, array) => hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  const counts = [], parts = [];
  let allocatedPages = 0;
  for (const v of system.variants) {
    if (v.lastLod) hashArray(history, v.lastLod);
    if (!v.lodMeshes) { counts.push([v.name, []]); continue; }
    counts.push([v.name, v.lodMeshes.map(l => l.count)]);
    for (const l of v.lodMeshes) {
      allocatedPages += l.pages.length;
      for (let page = 0; page < l.pages.length; page++) {
        const pg = l.pages[page];
        const n = Math.max(0, Math.min(l.page, l.count - page * l.page));
        if (!n) continue;
        hashArray(matrices, pg.im.array.subarray(0, n * 16));
        hashArray(colors, pg.ic.array.subarray(0, n * 3));
        parts.push(pg.parts.map(m => [m.name, m.count, m.visible, m.castShadow, m.receiveShadow]));
      }
    }
  }
  return {
    label, updated, instances: system.stats.instances, drawn: system.stats.drawn, tris: system.stats.tris,
    lodScale: system.stats.lodScale, counts, history: history.digest('hex'), matrices: matrices.digest('hex'), colors: colors.digest('hex'),
    parts: createHash('sha256').update(JSON.stringify(parts)).digest('hex'), allocatedPages,
  };
}
