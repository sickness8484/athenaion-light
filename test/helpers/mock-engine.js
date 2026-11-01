import * as THREE from 'three';
import { Engine } from '../../src/core/engine.js';

// Exercise Engine's actual orchestration without allocating a WebGL context.
export function mockEngine(overrides = {}) {
  const events = [];
  const engine = Object.create(Engine.prototype);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 60000);
  camera.position.set(0, 20, 100); camera.lookAt(0, 5, 0); camera.updateMatrixWorld();
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, TIMEOUT_EXPIRED: 2,
    fenceSync: () => ({}), flush() {}, clientWaitSync: () => 3, deleteSync() {},
  };
  Object.assign(engine, {
    width: 640, height: 360, camera, scene: new THREE.Scene(), time: 0, updates: [],
    quality: { softShadows: false, maxAcc: 4, shadowIntervalMs: 65, cloudSteps: 16, spp: 3, ...overrides },
    shot: { id: 1, target: [0, 5, 0] },
    _lastShadowRefresh: -Infinity, _shadowDirty: true, _needsMaterialPatch: true,
    renderer: {
      shadowMap: { autoUpdate: false, needsUpdate: true },
      getContext: () => gl,
      setSize(width, height) { events.push(['resize-renderer', width, height]); },
      info: { memory: { geometries: 1, textures: 1 }, programs: [] },
    },
    canvas: { toDataURL: () => 'data:image/png;base64,test' },
    lighting: {
      update(jitter, refresh) { events.push(['lighting', jitter, refresh]); },
      refreshCSM() { events.push(['refresh-csm']); },
    },
    registry: {
      vegetation: { lastCam: [], maybeUpdate() { events.push(['vegetation']); } },
      water: { reflection: {
        setInteractiveState(state) { this.state = state; events.push(['reflection-state', state]); },
        resize(width, height) { events.push(['resize-reflection', width, height]); },
      } },
    },
    ensurePatched() { this._needsMaterialPatch = false; events.push(['patch']); },
  });
  engine.pipeline = {
    count: 0,
    begin() { this.count = 0; events.push(['begin']); },
    setInteractiveState(state) { this.state = state; events.push(['pipeline-state', state]); },
    setSize(width, height) { events.push(['resize-pipeline', width, height]); },
    addSample(scene, cam) {
      events.push(['sample', {
        refresh: engine.renderer.shadowMap.needsUpdate,
        position: cam.position.toArray(), projection: cam.projectionMatrix.toArray(),
      }]);
      engine.renderer.shadowMap.needsUpdate = false; // WebGLShadowMap consumes this flag.
      this.count++;
    },
    resolve(target, frame) { events.push(['resolve', frame]); },
  };
  return { engine, events };
}
