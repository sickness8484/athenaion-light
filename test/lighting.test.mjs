import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Lighting } from '../src/core/lighting.js';
import { SKY } from '../src/core/sky.js';
import { ATMO } from '../src/core/atmosphere.js';
import { LENS } from '../src/core/pipeline.js';

function fixture({ memoryConstrained = false, shadowType = THREE.PCFShadowMap, reversed = false } = {}) {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 60000);
  camera.position.set(0, 20, 100); camera.lookAt(0, 5, 0); camera.updateMatrixWorld();
  const engine = {
    scene: new THREE.Scene(), camera, registry: {},
    renderer: { shadowMap: { type: shadowType }, state: { buffers: { depth: { getReversed: () => reversed } } } },
    quality: { shadowMaxFar: 2000, cascades: 3, shadowMapSize: 1024, memoryConstrained },
  };
  return new Lighting(engine);
}

test('mobile PCF shadows preserve native depth precision, comparison and map size with compact unused color', () => preserveUniforms(() => {
  for (const reversed of [false, true]) {
    const lighting = fixture({ memoryConstrained: true, reversed });
    for (const light of lighting.csm.lights) {
      const shadow = light.shadow, target = shadow.map;
      assert.equal(target.width, shadow.mapSize.x);
      assert.equal(target.height, shadow.mapSize.y);
      assert.equal(target.texture.type, THREE.UnsignedByteType);
      assert.equal(target.texture.format, THREE.RedFormat);
      assert.equal(target.depthBuffer, true);
      assert.equal(target.stencilBuffer, false);
      assert.equal(target.depthTexture.type, THREE.UnsignedIntType);
      assert.equal(target.depthTexture.format, THREE.DepthFormat);
      assert.equal(target.depthTexture.compareFunction, reversed ? THREE.GreaterEqualCompare : THREE.LessEqualCompare);
      assert.equal(target.depthTexture.minFilter, THREE.LinearFilter);
      assert.equal(target.depthTexture.magFilter, THREE.LinearFilter);
      assert.equal(shadow.normalBias, 0.06);
      let disposed = 0;
      target.addEventListener('dispose', () => disposed++);
      target.setSize(512, 512);
      assert.equal(disposed, 1, 'Three retains normal target resize/disposal ownership');
      target.dispose();
    }
    lighting.csm.remove(); lighting.csm.dispose();
  }
  for (const options of [{ memoryConstrained: false }, { memoryConstrained: true, shadowType: THREE.VSMShadowMap }]) {
    const lighting = fixture(options);
    assert(lighting.csm.lights.every(light => light.shadow.map === null), 'Other paths retain Three defaults');
    lighting.csm.remove(); lighting.csm.dispose();
  }
}));

function preserveUniforms(fn) {
  const chunks = Object.fromEntries(['lights_pars_begin', 'lights_fragment_begin'].map((name) => [name, THREE.ShaderChunk[name]]));
  const saved = [...Object.values(SKY), ...Object.values(ATMO), ...Object.values(LENS)].map((uniform) => ({
    uniform, original: uniform.value,
    copy: !uniform.value?.isTexture && uniform.value?.clone ? uniform.value.clone() : null,
  }));
  try {
    SKY.uCloudReady.value = 1; // These tests do not generate or render GPU cloud textures.
    fn();
  } finally {
    Object.assign(THREE.ShaderChunk, chunks);
    for (const { uniform, original, copy } of saved) {
      uniform.value = original;
      if (copy) original.copy(copy);
    }
  }
}

test('CSM frustums ignore camera motion/jitter and refresh when projection or cascade settings change', () => preserveUniforms(() => {
  const lighting = fixture(), { camera } = lighting.engine, { csm } = lighting;
  for (const light of csm.lights) {
    const expected = light.shadow.camera.clone(); expected.updateProjectionMatrix();
    assert.deepEqual(light.shadow.camera.projectionMatrix.toArray(), expected.projectionMatrix.toArray());
  }
  const original = csm.updateFrustums.bind(csm);
  let updates = 0;
  csm.updateFrustums = () => { updates++; original(); };
  assert.equal(lighting.refreshCSM(), false);
  camera.position.x += 10; camera.lookAt(0, 5, 0); camera.updateMatrixWorld();
  assert.equal(lighting.refreshCSM(), false);
  camera.setViewOffset(1280, 720, 0.25, -0.25, 1280, 720);
  assert.equal(lighting.refreshCSM(), false);
  camera.clearViewOffset();
  for (const name of ['near', 'far', 'fov', 'aspect', 'zoom']) {
    camera[name] *= 1.1; camera.updateProjectionMatrix();
    assert.equal(lighting.refreshCSM(), true);
    assert.equal(lighting.refreshCSM(), false);
  }
  csm.maxFar *= 0.9;
  assert.equal(lighting.refreshCSM(), true);
  csm.cascades = 2;
  assert.equal(lighting.refreshCSM(), true);
  assert.equal(updates, 7);
  assert.equal(lighting.csmUniforms.cameraNear.value, camera.near);
  assert.equal(lighting.csmUniforms.shadowFar.value, Math.min(camera.far, csm.maxFar));
  csm.remove(); csm.dispose();
}));

test('reusing shadows preserves light direction/transforms while sky jitter and lens uniforms continue', () => preserveUniforms(() => {
  const lighting = fixture(), { csm } = lighting, { camera } = lighting.engine;
  lighting.update();
  const direction = csm.lightDirection.clone();
  const poses = csm.lights.map((light) => [light.position.toArray(), light.target.position.toArray()]);
  const original = csm.update.bind(csm);
  let updates = 0;
  csm.update = () => { updates++; original(); };
  camera.position.x += 15; camera.rotateY(0.3); camera.updateMatrixWorld();
  SKY.uFrame.value = 4095;
  LENS.uSunPos.value.set(NaN, NaN);
  lighting.update([0.5, 0.25], false);
  assert.equal(updates, 0);
  assert.deepEqual(csm.lightDirection.toArray(), direction.toArray());
  assert.deepEqual(csm.lights.map((light) => [light.position.toArray(), light.target.position.toArray()]), poses);
  assert.equal(SKY.uFrame.value, 0);
  assert(LENS.uSunPos.value.toArray().every(Number.isFinite));
  lighting.update([0.5, 0.25], true);
  assert.equal(updates, 1);
  assert.notDeepEqual(csm.lightDirection.toArray(), direction.toArray());
  lighting.update();
  assert.equal(updates, 2);
  csm.remove(); csm.dispose();
}));

test('PMREM reuses equivalent uniforms, rebuilds for lighting/textures, disposes targets and restores env pass on failure', () => preserveUniforms(() => {
  const lighting = fixture(), { engine } = lighting;
  let calls = 0, fail = false;
  const targets = [], disposals = new Map();
  lighting.pmrem = {
    fromScene() {
      calls++;
      assert.equal(SKY.uEnvPass.value, 1);
      if (fail) throw new Error('injected PMREM failure');
      const target = new THREE.WebGLRenderTarget(1, 1);
      disposals.set(target, 0);
      target.addEventListener('dispose', () => disposals.set(target, disposals.get(target) + 1));
      targets.push(target);
      return target;
    },
  };
  const first = lighting.buildEnvironment();
  assert.equal(calls, 1);
  SKY.uFrame.value += 1; SKY.uSkyTime.value += 1; ATMO.uAtmoTime.value += 1;
  SKY.uEnvPass.value = 0.25;
  engine.envIntensity = 0.7;
  assert.equal(lighting.buildEnvironment(), first);
  assert.equal(calls, 1);
  assert.equal(SKY.uEnvPass.value, 0.25);
  assert.equal(engine.scene.environmentIntensity, 0.7);
  assert.equal(engine.registry.skyEnvScale, SKY.uEnvScale.value);

  SKY.uZenith.value = SKY.uZenith.value.clone();
  assert.equal(lighting.buildEnvironment(), first); // Equal values, different object identity.
  SKY.uZenith.value.r += 0.01;
  lighting.buildEnvironment();
  assert.equal(calls, 2);
  assert.equal(disposals.get(targets[0]), 1);
  assert.equal(SKY.uEnvPass.value, 0.25);
  ATMO.uHaze.value.y += 1;
  lighting.buildEnvironment(); assert.equal(calls, 3);
  SKY.tCloudShape.value = new THREE.Texture();
  lighting.buildEnvironment(); assert.equal(calls, 4);
  SKY.tCloudShape.value.needsUpdate = true;
  lighting.buildEnvironment(); assert.equal(calls, 5);

  const previousTarget = lighting.envTarget, previousKey = lighting._environmentKey;
  SKY.uCloudCover.value += 0.01;
  fail = true;
  assert.throws(() => lighting.buildEnvironment(), /injected PMREM failure/);
  assert.equal(SKY.uEnvPass.value, 0.25);
  assert.equal(lighting.envTarget, previousTarget);
  assert.equal(engine.scene.environment, previousTarget.texture);
  assert.equal(lighting._environmentKey, previousKey);
  assert.equal(disposals.get(previousTarget), 0);
  fail = false;
  lighting.buildEnvironment();
  assert.equal(disposals.get(previousTarget), 1);
  assert.equal(calls, 7);
  assert.notEqual(lighting.envTarget, previousTarget);
  lighting.envTarget.dispose();
  lighting.envSky.geometry.dispose(); lighting.envSky.material.dispose();
  lighting.csm.remove(); lighting.csm.dispose();
}));
