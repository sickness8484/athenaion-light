import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SKY } from '../src/core/sky.js';
import { ATMO } from '../src/core/atmosphere.js';
import { halton } from '../src/core/rng.js';
import { mockEngine } from './helpers/mock-engine.js';

test('shot defaults preserve cloud texture identity/upload versions while restoring ordinary uniform values', () => {
  const { engine } = mockEngine();
  const previousShape = SKY.tCloudShape.value;
  const previousZenith = SKY.uZenith.value.clone(), previousSun = ATMO.uSunDir.value.clone();
  const texture = new THREE.Texture(), replacement = new THREE.Texture();
  try {
    SKY.tCloudShape.value = texture;
    const version = texture.version, sourceVersion = texture.source.version;
    engine._snapshotDefaults();
    assert.equal(engine._defaults.SKY.tCloudShape, texture);
    assert.equal(texture.version, version);
    assert.equal(texture.source.version, sourceVersion);
    SKY.uZenith.value.r += 0.1;
    ATMO.uSunDir.value.set(0.3, 0.4, 0.5).normalize();
    const changedSun = ATMO.uSunDir.value.toArray();
    engine._restoreDefaults(); engine._restoreDefaults();
    assert.equal(SKY.tCloudShape.value, texture);
    assert.equal(texture.version, version);
    assert.equal(texture.source.version, sourceVersion);
    assert.deepEqual(SKY.uZenith.value.toArray(), previousZenith.toArray());
    assert.deepEqual(ATMO.uSunDir.value.toArray(), changedSun);
    SKY.tCloudShape.value = replacement;
    engine._restoreDefaults();
    assert.equal(SKY.tCloudShape.value, texture);
  } finally {
    SKY.tCloudShape.value = previousShape;
    SKY.uZenith.value.copy(previousZenith); ATMO.uSunDir.value.copy(previousSun);
    texture.dispose(); replacement.dispose();
  }
});

test('interactive motion resets accumulation, stop restores shadows, refinement finishes, and idle draws nothing', () => {
  const { engine, events } = mockEngine();
  const previousSteps = SKY.uCloudSteps.value;
  try {
    const position = engine.camera.position.toArray(), projection = engine.camera.projectionMatrix.toArray();
    const frame = (changed, moving, nowMs) => engine.renderInteractive(changed, { moving, nowMs, maxAcc: 4 });
    assert.equal(frame(true, true, 0), true);
    assert.equal(engine._accFrames, 1);
    assert.equal(frame(true, true, 16), true);
    assert.equal(engine._accFrames, 1);
    assert.equal(frame(true, true, 80), true);
    assert.equal(frame(false, false, 96), true);
    assert.equal(engine._accFrames, 1);
    for (const now of [112, 128, 144]) assert.equal(frame(false, false, now), true);
    assert.equal(engine._accFrames, 4);
    assert.equal(engine.pipeline.state.final, true);
    assert.equal(engine.registry.clouds.state.final, true);
    assert.equal(engine.registry.clouds.state.moving, false);
    assert.equal(engine.registry.water.reflection.state.final, true);
    assert.deepEqual(events.filter(e => e[0] === 'sample').map(e => e[1].refresh), [true, false, true, true, false, false, false]);
    assert.equal(events.filter(e => e[0] === 'begin').length, 4);
    assert.equal(events.filter(e => e[0] === 'patch').length, 1);
    const beforeIdle = events.length;
    assert.equal(frame(false, false, 160), false);
    assert.equal(events.length, beforeIdle);
    assert.deepEqual(engine.camera.position.toArray(), position);
    assert.deepEqual(engine.camera.projectionMatrix.toArray(), projection);
    // A new input event wakes a completed still and begins a fresh frame.
    assert.equal(frame(true, true, 1000), true);
    assert.equal(engine._accFrames, 1);
  } finally { SKY.uCloudSteps.value = previousSteps; }
});

test('high-quality static refinement refreshes jittered shadows on each additional sample', () => {
  const { engine, events } = mockEngine({ softShadows: true });
  const previousSteps = SKY.uCloudSteps.value;
  try {
    engine.renderInteractive(true, { moving: false, nowMs: 0, maxAcc: 3 });
    engine.renderInteractive(false, { moving: false, nowMs: 16, maxAcc: 3 });
    engine.renderInteractive(false, { moving: false, nowMs: 32, maxAcc: 3 });
    const updates = events.filter(e => e[0] === 'lighting');
    assert.equal(updates[0][1], null);
    assert.deepEqual(updates[1][1], [halton(2, 11), halton(2, 13)]);
    assert.deepEqual(updates[2][1], [halton(3, 11), halton(3, 13)]);
    assert(updates.every(e => e[2] === true));
    assert.equal(engine.pipeline.state.final, true);
  } finally { SKY.uCloudSteps.value = previousSteps; }
});

test('resize updates render dimensions and projection, invalidates vegetation/shadows, and resumes refinement', () => {
  const { engine, events } = mockEngine();
  engine._accFrames = 4; engine._shadowDirty = false;
  assert.equal(engine.resize(800, 600), true);
  assert.equal(engine.width, 800); assert.equal(engine.height, 600);
  assert.equal(engine.camera.aspect, 4 / 3);
  assert.equal(engine._accFrames, undefined);
  assert.equal(engine._shadowDirty, true);
  assert.equal(engine.registry.vegetation.lastCam, null);
  assert.deepEqual(events.filter(e => e[0].startsWith('resize-')), [
    ['resize-renderer', 800, 600], ['resize-pipeline', 800, 600], ['resize-reflection', 800, 600],
  ]);
  const count = events.length;
  assert.equal(engine.resize(800, 600), false);
  assert.equal(events.length, count);
});

test('offline still rendering disables interactive throttles and refreshes shadows for every original sample', async () => {
  const { engine, events } = mockEngine({ softShadows: true });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousSteps = SKY.uCloudSteps.value;
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
  engine.shot.dof = { aperture: 0.2, focus: 100 };
  engine.pipeline.state = { moving: true };
  const position = engine.camera.position.toArray(), projection = engine.camera.projectionMatrix.toArray();
  try {
    assert.equal(await engine.renderStill(3), 'data:image/png;base64,test');
    assert.equal(engine.pipeline.state, null);
    assert.equal(engine.registry.clouds.state, null);
    assert.equal(engine.registry.water.reflection.state, null);
    const updates = events.filter(e => e[0] === 'lighting');
    assert.equal(updates.length, 3);
    updates.forEach((e, i) => {
      assert.equal(e[2], true);
      assert.deepEqual(e[1], [halton(i + 1, 11), halton(i + 1, 13)]);
    });
    assert(events.filter(e => e[0] === 'sample').every(e => e[1].refresh));
    assert.deepEqual(events.filter(e => e[0] === 'resolve'), [['resolve', 0]]);
    assert.deepEqual(engine.camera.position.toArray(), position);
    assert.deepEqual(engine.camera.projectionMatrix.toArray(), projection);
    assert.equal(engine.stats.spp, 3);
    assert.equal(SKY.uCloudSteps.value, engine.quality.cloudSteps);
  } finally {
    SKY.uCloudSteps.value = previousSteps;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});

test('a failed sample restores the unjittered camera before propagating the render error', () => {
  const { engine } = mockEngine({ softShadows: true });
  engine.shot.dof = { aperture: 0.2, focus: 100 };
  const position = engine.camera.position.toArray(), projection = engine.camera.projectionMatrix.toArray();
  engine.pipeline.addSample = () => { throw new Error('injected sample failure'); };
  assert.throws(() => engine.renderSample(2), /injected sample failure/);
  assert.deepEqual(engine.camera.position.toArray(), position);
  assert.deepEqual(engine.camera.projectionMatrix.toArray(), projection);
});

test('scene preparation compiles HDR and volume programs, restoring the previous target on success or failure', async () => {
  const { engine } = mockEngine();
  const previous = { name: 'previous' }, hdr = { name: 'hdr' }, volume = new THREE.Scene();
  let target = previous;
  const compiled = [];
  engine.pipeline.target = hdr;
  engine.registry.clouds.volumePasses = [{ scene: volume }];
  engine.renderer.getRenderTarget = () => target;
  engine.renderer.setRenderTarget = (value) => { target = value; };
  engine.renderer.compileAsync = async (scene, camera) => {
    assert.equal(target, hdr);
    assert.equal(camera, engine.camera);
    assert.equal(engine._needsMaterialPatch, false);
    compiled.push(scene);
  };
  await engine.compileScene();
  assert.deepEqual(compiled, [engine.scene, volume]);
  assert.equal(target, previous);
  engine.renderer.compileAsync = async () => { throw new Error('injected compile failure'); };
  await assert.rejects(engine.compileScene(), /injected compile failure/);
  assert.equal(target, previous);
});
