import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Pipeline, GRADE, LENS } from '../src/core/pipeline.js';
import { PlanarReflection } from '../src/water/reflection.js';
import { ATMO } from '../src/core/atmosphere.js';
import { SKY } from '../src/core/sky.js';
import * as upstream from './fixtures/upstream-pipeline.js';
const upstreamText = fs.readFileSync(new URL('./fixtures/upstream-pipeline.js', import.meta.url), 'utf8');

function renderer(floatOK = true) {
  return {
    reads: 0, passLog: [], target: null, seed: 0,
    getContext: () => ({ getExtension: () => floatOK ? {} : null }),
    setRenderTarget(target) { this.target = target; },
    render(mesh) { this.passLog.push({ target: this.target, material: mesh.material }); },
    readRenderTargetPixels(rt, x, y, w, h, buf) {
      this.reads++;
      for (let i = 0; i < buf.length; i += 4) {
        const value = ((i / 4) * 13 + this.seed * 31) % 256;
        buf[i] = value; buf[i + 1] = (value * 3 + 17) % 256; buf[i + 2] = (value * 7 + 23) % 256; buf[i + 3] = 255;
      }
    },
  };
}
const quality = { msaa: 0, bloom: true, toneMapIntervalMs: 250 };

// Isolation=none is useful in constrained runtimes; leave shared uniforms as we found them.
const test = (name, fn) => nodeTest(name, async () => {
  const uniforms = [GRADE.uAutoLevels, upstream.GRADE.uAutoLevels, LENS.uEnabled, upstream.LENS.uEnabled];
  const previous = uniforms.map((uniform) => uniform.value);
  uniforms.forEach((uniform, index) => { uniform.value = index < 2 ? 0.8 : 0; });
  try { await fn(); }
  finally { uniforms.forEach((uniform, index) => { uniform.value = previous[index]; }); }
});

test('exposure reduction retains upstream tap coordinates, weights, order and float fallback', () => {
  const r = renderer(), p = new Pipeline(r, 640, 360, quality);
  p.resolve();
  const original = upstreamText.match(/float meterLum\(\)\{[\s\S]*?float s = 0.0, w = 0.0;([\s\S]*?)return exp\(s \/ w\);/)[1];
  const reduced = p.meterReduceMat.fragmentShader.match(/float s = 0.0, w = 0.0;([\s\S]*?)gl_FragColor/)[1];
  const normalize = s => s.replaceAll('tMeter', 'tSrc').replace(/\s+/g, '');
  assert.equal(normalize(reduced), normalize(original));
  assert.equal(p.meterReduceRT.width, 1);
  assert.equal(p.meterReduceRT.height, 1);
  assert.equal(p.meterReduceRT.texture.type, THREE.FloatType);
  assert.equal(p.meterReduceRT.texture.minFilter, THREE.NearestFilter);
  assert.equal(p.gradeMat.uniforms.tMeter.value, p.meterReduceRT.texture);
  assert(r.passLog.findIndex(x => x.material === p.meterReduceMat) < r.passLog.findIndex(x => x.material === p.gradeMat));
  const fallback = new Pipeline(renderer(false), 640, 360, quality);
  fallback.resolve();
  assert.equal(fallback.gradeMat.defines.CG_REDUCED_METER, 0);
  assert.equal(fallback.meterReduceRT, undefined);
  assert.equal(fallback.gradeMat.uniforms.tMeter.value, fallback.meterRT.texture);
  assert.equal(fallback.gradeMat.uniforms.uMeterOn.value, 1);
  p.dispose(); fallback.dispose();
});

test('offline readback, tone curve and temporal meter sequence match upstream for consecutive and discontinuous frames', () => {
  const oldR = renderer(), newR = renderer();
  const oldP = new upstream.Pipeline(oldR, 640, 360, quality);
  const newP = new Pipeline(newR, 640, 360, quality);
  for (const frame of [0, 1, 2, 5, 6]) {
    oldR.seed = newR.seed = frame;
    oldP.resolve(null, frame); newP.resolve(null, frame);
    assert.deepEqual(newP.gradeMat.uniforms.uLut.value, oldP.gradeMat.uniforms.uLut.value);
    assert.equal(newP.meterMat.uniforms.uW.value, oldP.meterMat.uniforms.uW.value);
    assert.deepEqual(newP._meter, oldP._meter);
  }
  assert.equal(newR.reads, 5);
  assert.equal(newR.reads, oldR.reads);
  newP.dispose();
});

test('interactive readback throttles motion, refines rest and always honors final/invalidation', () => {
  const r = renderer(), p = new Pipeline(r, 640, 360, quality);
  const frame = (nowMs, moving, count = 1, final = false) => {
    p.count = count; p.setInteractiveState({ moving, nowMs, final }); p.resolve();
  };
  frame(0, true); assert.equal(r.reads, 1);
  frame(16, true); frame(249, true); assert.equal(r.reads, 1);
  frame(250, true); assert.equal(r.reads, 2);
  frame(260, false); assert.equal(r.reads, 3);
  frame(270, false, 2); assert.equal(r.reads, 4);
  frame(280, false, 3); assert.equal(r.reads, 4);
  frame(290, false, 8); assert.equal(r.reads, 5);
  frame(300, false, 9, true); assert.equal(r.reads, 6);
  p.invalidateToneMapping(); frame(301, true); assert.equal(r.reads, 7);
  p.setInteractiveState(null); p.resolve(); p.resolve(); assert.equal(r.reads, 9);
  p.dispose();
});

test('pipeline resizing releases old attachments and keeps dimensions, texel uniforms and accumulation coherent', () => {
  const r = renderer(), p = new Pipeline(r, 640, 360, quality);
  p.resolve(); p.count = 12;
  let sceneDisposals = 0, levelDisposals = 0, lensDisposals = 0;
  p.sceneRT.addEventListener('dispose', () => sceneDisposals++);
  p.lvRT.addEventListener('dispose', () => levelDisposals++);
  p.lensFX.t.forEach(t => t.addEventListener('dispose', () => lensDisposals++));
  assert.equal(p.resize(641, 361), true);
  assert.equal(sceneDisposals, 1);
  assert.equal(levelDisposals, 1);
  assert.equal(lensDisposals, 0);
  assert.deepEqual(p.lensFX.full, [641, 361]);
  assert.equal(p.count, 0);
  assert.equal(p.accIndex, 0);
  assert.equal(p.lvRT, null);
  assert.equal(p._lv, null);
  assert.deepEqual(p.gradeMat.uniforms.uRes.value.toArray(), [641, 361]);
  assert.equal(p.setSize(320, 180), true);
  assert.equal(lensDisposals, 3);
  assert.deepEqual(p.lensFX.size, [80, 45]);
  assert(p.acc.every(t => t.width === 320 && t.height === 180));
  let w = 320, h = 180;
  for (let i = 0; i < 7; i++) {
    w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
    assert.equal(p.mips[i].width, w); assert.equal(p.mips[i].height, h);
    assert.equal(p.ltm[i].width, w); assert.equal(p.ltm[i].height, h);
  }
  p.resolve();
  assert.equal(p.lvRT.width, 80); assert.equal(p.lvRT.height, 45);
  assert.deepEqual(p.gradeMat.uniforms.uTx0.value.toArray(), [1 / 160, 1 / 90]);
  assert.equal(p.resize(320, 180), false);
  assert.throws(() => p.resize(NaN, 180), TypeError);
  p.dispose();
});

function reflectionFixture() {
  const engine = { width: 640, height: 360, time: 0, quality: { name: 'preview', reflectionIntervalMs: 80 } };
  const refl = new PlanarReflection(engine);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  camera.position.set(0, 5, 10); camera.lookAt(0, 2, 0); camera.updateMatrixWorld();
  const originalTarget = { name: 'main' };
  const hidden = [{ visible: true }, { visible: false }];
  refl.hidden = hidden;
  const r = {
    shadowMap: { autoUpdate: false, needsUpdate: true }, xr: { enabled: true },
    target: originalTarget, calls: 0, fail: false,
    getRenderTarget() { return this.target; },
    setRenderTarget(t) { this.target = t; },
    state: { buffers: { depth: { setMask() {} } }, viewport() {} },
    clear() {},
    render() {
      this.calls++;
      assert.equal(this.shadowMap.autoUpdate, false);
      assert.equal(this.shadowMap.needsUpdate, false);
      assert.equal(this.xr.enabled, false);
      assert.equal(ATMO.uAtmoEnabled.value, 0);
      assert.equal(SKY.uSunDisk.value, 0);
      assert(hidden.every(o => !o.visible));
      if (this.fail) throw new Error('injected renderer failure');
    },
  };
  return { engine, refl, camera, r, originalTarget, hidden };
}

test('reflection throttles small motion/animation but immediately refreshes large changes, rest and final', () => {
  const { engine, refl, camera, r } = reflectionFixture();
  const update = (nowMs, moving, animated = false, final = false) => {
    camera.updateMatrixWorld(); refl.setInteractiveState({ moving, animated, final, nowMs }); refl.update(r, {}, camera);
  };
  update(0, true); assert.equal(refl.renders, 1);
  camera.position.x = 0.1; update(16, true); assert.equal(refl.renders, 1);
  camera.position.x = 0.2; update(80, true); assert.equal(refl.renders, 2);
  camera.rotation.y += 0.1; update(81, true); assert.equal(refl.renders, 3);
  camera.position.x = 3; update(82, true); assert.equal(refl.renders, 4);
  update(83, false); assert.equal(refl.renders, 5);
  update(84, false); assert.equal(refl.renders, 5);
  engine.time = 0.1; update(120, false, true); assert.equal(refl.renders, 5);
  engine.time = 0.2; update(164, false, true); assert.equal(refl.renders, 6);
  update(165, false, false, true); assert.equal(refl.renders, 7);
  refl.setInteractiveState(null);
  camera.position.x += 0.01; camera.updateMatrixWorld(); refl.update(r, {}, camera);
  assert.equal(refl.renders, 8);
  refl.invalidate(); refl.update(r, {}, camera); assert.equal(refl.renders, 9);
  assert.throws(() => refl.configureUpdatePolicy({ movingIntervalMs: -1 }), TypeError);
  refl.dispose();
});

test('reflection resize preserves texture references and restores all render state even if nested rendering fails', () => {
  const { engine, refl, camera, r, originalTarget, hidden } = reflectionFixture();
  const depth = refl.rt.depthTexture, color = refl.rt.texture;
  let disposed = 0;
  refl.rt.addEventListener('dispose', () => disposed++);
  engine.width = 800; engine.height = 600;
  assert.equal(refl.resize(engine.width, engine.height), true);
  assert.equal(disposed, 1);
  assert.equal(refl.rt.texture, color);
  assert.equal(refl.rt.depthTexture, depth);
  assert.equal(depth.image.width, 448);
  assert.equal(depth.image.height, 336);
  assert.deepEqual(refl.uniforms.uReflSize.value.toArray(), [448, 336]);
  const atmo = ATMO.uAtmoEnabled.value, disk = SKY.uSunDisk.value;
  for (const fail of [true, false]) {
    r.fail = fail;
    if (fail) assert.throws(() => refl.update(r, {}, camera), /injected renderer failure/);
    else refl.update(r, {}, camera);
    assert.equal(r.shadowMap.autoUpdate, false);
    assert.equal(r.shadowMap.needsUpdate, true);
    assert.equal(r.xr.enabled, true);
    assert.equal(r.target, originalTarget);
    assert.equal(ATMO.uAtmoEnabled.value, atmo);
    assert.equal(SKY.uSunDisk.value, disk);
    assert.deepEqual(hidden.map(o => o.visible), [true, false]);
    assert.equal(refl._inPass, false);
    assert.equal(refl.renders, fail ? 0 : 1);
  }
  refl.dispose();
  assert.equal(refl.uniforms.uReflOn.value, 0);
});
