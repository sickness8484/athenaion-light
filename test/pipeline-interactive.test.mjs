import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Pipeline, GRADE, LENS, solveToneCurve } from '../src/core/pipeline.js';

const quality = { msaa: 0, bloom: true, toneMapIntervalMs: 250, interactiveAA: true };

function fillPixels(buffer, seed) {
  for (let i = 0; i < buffer.length; i += 4) {
    const value = ((i / 4) * 13 + seed * 31) % 256;
    buffer[i] = value;
    buffer[i + 1] = (value * 3 + 17) % 256;
    buffer[i + 2] = (value * 7 + 23) % 256;
    buffer[i + 3] = 255;
  }
}

function renderer({ async = false, floatOK = true } = {}) {
  const r = {
    reads: 0, asyncReads: 0, passLog: [], pending: [], target: null, seed: 0,
    info: { autoReset: true, render: { calls: 0, triangles: 0 }, reset() { this.render.calls = 0; this.render.triangles = 0; } },
    getContext: () => ({ getExtension: () => floatOK ? {} : null }),
    setRenderTarget(target) { this.target = target; },
    clear() {},
    render(mesh) {
      this.info.render.calls++;
      this.info.render.triangles += 3;
      this.passLog.push({ target: this.target, material: mesh.material, weight: mesh.material?.uniforms.uW?.value });
    },
    readRenderTargetPixels(target, x, y, w, h, buffer) {
      this.reads++;
      fillPixels(buffer, this.seed);
    },
    complete() {
      const request = this.pending.shift();
      assert(request, 'an asynchronous read is pending');
      request.resolve(request.buffer);
    },
    fail() {
      const request = this.pending.shift();
      assert(request, 'an asynchronous read is pending');
      request.reject(new Error('injected driver failure'));
    },
  };
  if (async) r.readRenderTargetPixelsAsync = function (target, x, y, w, h, buffer) {
    this.asyncReads++;
    // The GPU read is issued immediately; completion and CPU ownership arrive later.
    fillPixels(buffer, this.seed);
    return new Promise((resolve, reject) => this.pending.push({ target, buffer, resolve, reject }));
  };
  return r;
}

// npm test may share a single module context. Restore all values touched by these tests.
const test = (name, fn) => nodeTest(name, async () => {
  const saved = [GRADE.uAutoLevels.value, LENS.uEnabled.value, LENS.uSunFacing.value, LENS.uSunPos.value.clone()];
  GRADE.uAutoLevels.value = 0;
  LENS.uEnabled.value = 0;
  try { await fn(); }
  finally {
    GRADE.uAutoLevels.value = saved[0]; LENS.uEnabled.value = saved[1];
    LENS.uSunFacing.value = saved[2]; LENS.uSunPos.value.copy(saved[3]);
  }
});

function activeFrame(p, nowMs, frame = 0) {
  p.setInteractiveState({ moving: true, nowMs });
  p.begin();
  p.addSample({}, {});
  p.resolve(null, frame);
}

test('active frames avoid history reads and writes, then restore fresh full-precision still accumulation', () => {
  const r = renderer(), p = new Pipeline(r, 640, 360, quality);
  p.setInteractiveState({ moving: true, nowMs: 0 });
  p.addSample({}, {}); p.addSample({}, {});
  assert.equal(r.passLog.length, 2);
  assert(r.passLog.every(pass => pass.target === p.sceneRT));
  assert.equal(p.hdr, p.sceneRT.texture);
  assert.equal(p._hdrDirectUniform.value, 1);
  assert.equal(p.count, 2);
  assert.deepEqual(p.sceneInfo, { calls: 1, triangles: 3 });

  p.setInteractiveState({ moving: false, nowMs: 20 });
  assert.equal(p.count, 0);
  p.addSample({}, {}); p.addSample({}, {});
  const accumulated = r.passLog.filter(pass => pass.material === p.copyMat);
  assert.deepEqual(accumulated.map(pass => pass.weight), [1, 0.5]);
  assert(accumulated.every(pass => pass.target.texture.type === THREE.FloatType));
  assert.equal(p.hdr, p.acc[p.accIndex].texture);
  assert.equal(p._hdrDirectUniform.value, 0);

  p.setInteractiveState({ animated: true, nowMs: 30 });
  const before = r.passLog.length;
  p.addSample({}, {});
  assert.equal(r.passLog.length, before + 1);
  p.setInteractiveState(null);
  p.addSample({}, {});
  assert.equal(r.passLog.at(-1).material, p.copyMat);
  assert.equal(r.passLog.at(-1).weight, 1);
  p.dispose();
});

test('active tone measurement is asynchronous, bounded to one read, and retains the exact tone solver and smoothing', async () => {
  GRADE.uAutoLevels.value = 0.8;
  const r = renderer({ async: true }), p = new Pipeline(r, 640, 360, quality);
  activeFrame(p, 0, 0);
  const first = p._levelRead;
  assert.equal(r.asyncReads, 1);
  assert.equal(r.reads, 0);
  assert.notEqual(first.buffer, p.lvBuf);
  assert.equal(p.gradeMat.uniforms.uLevelsOn.value, 0);
  activeFrame(p, 100, 0); activeFrame(p, 500, 0);
  assert.equal(r.asyncReads, 1);
  assert.equal(p._levelRead, first);
  const firstCurve = solveToneCurve(first.buffer, GRADE.uLevelTarget.value, 0.8);
  r.complete(); await first.promise;
  assert.deepEqual(p._lv.v, firstCurve);
  assert.deepEqual(p.gradeMat.uniforms.uLut.value, new Float32Array(firstCurve));

  activeFrame(p, 249, 1);
  assert.equal(r.asyncReads, 1);
  assert.equal(p.gradeMat.uniforms.uLevelsOn.value, 1);
  r.seed = 3;
  activeFrame(p, 250, 1);
  const second = p._levelRead;
  const solved = solveToneCurve(second.buffer, GRADE.uLevelTarget.value, 0.8);
  const smoothed = solved.map((value, index) => firstCurve[index] + (value - firstCurve[index]) * 0.2);
  assert.equal(r.asyncReads, 2);
  r.complete(); await second.promise;
  assert.deepEqual(p._lv.v, smoothed);
  assert.equal(r.reads, 0);
  p.dispose();
});

test('resize, look invalidation and stop discard delayed tone results without freeing an in-flight target early', async () => {
  GRADE.uAutoLevels.value = 0.8;
  const r = renderer({ async: true }), p = new Pipeline(r, 640, 360, quality);
  activeFrame(p, 0);
  const resized = p._levelRead;
  let disposals = 0;
  resized.target.addEventListener('dispose', () => disposals++);
  p.resize(800, 600);
  assert.equal(disposals, 0);
  assert.equal(p.lvRT, null);
  r.complete(); await resized.promise;
  assert.equal(disposals, 1);
  assert.equal(p._lv, null);

  activeFrame(p, 10);
  const invalidated = p._levelRead;
  p.invalidateToneMapping();
  r.complete(); await invalidated.promise;
  assert.equal(p._lv, null);
  activeFrame(p, 20);
  const stopped = p._levelRead;
  r.seed = 4;
  p.setInteractiveState({ moving: false, nowMs: 30, final: true });
  p.addSample({}, {});
  p.resolve(null, 9);
  assert.equal(r.reads, 1);
  assert.equal(p._lv.frame, 9);
  const finalCurve = p._lv;
  r.complete(); await stopped.promise;
  assert.equal(p._lv, finalCurve);
  assert.deepEqual(p.gradeMat.uniforms.uLut.value, new Float32Array(finalCurve.v));
  p.dispose();
});

test('an asynchronous driver failure falls back to the throttled synchronous meter', async () => {
  GRADE.uAutoLevels.value = 0.8;
  const r = renderer({ async: true }), p = new Pipeline(r, 640, 360, quality);
  activeFrame(p, 0);
  const request = p._levelRead;
  r.fail(); await request.promise;
  assert.equal(p._asyncLevelsDisabled, true);
  assert.equal(p._levelRead, null);
  activeFrame(p, 10); activeFrame(p, 20);
  assert.equal(r.reads, 1);
  assert.equal(r.asyncReads, 1);
  activeFrame(p, 260);
  assert.equal(r.reads, 2);
  p.dispose();
});

test('disposal waits for a pending tone read and prevents a late callback from updating disposed materials', async () => {
  GRADE.uAutoLevels.value = 0.8;
  const r = renderer({ async: true }), p = new Pipeline(r, 640, 360, quality);
  activeFrame(p, 0);
  const request = p._levelRead;
  let disposals = 0;
  request.target.addEventListener('dispose', () => disposals++);
  p.dispose();
  assert.equal(disposals, 0);
  r.complete(); await request.promise;
  assert.equal(disposals, 1);
  assert.equal(p._levelRead, null);
  assert.equal(p._lv, undefined);
});

test('spatial AA uses the official shader in perceptual space only for active non-MSAA views', () => {
  const r = renderer(), p = new Pipeline(r, 640, 360, { ...quality });
  const output = { name: 'output' };
  p.setInteractiveState({ animated: true, nowMs: 0 });
  p.addSample({}, {}); p.resolve(output);
  assert.equal(r.passLog.at(-2).material, p.gradeMat);
  assert.equal(r.passLog.at(-2).target, p.fxaaRT);
  assert.equal(r.passLog.at(-1).material, p.fxaaMat);
  assert.equal(r.passLog.at(-1).target, output);
  assert.equal(p.fxaaMat.fragmentShader, FXAAShader.fragmentShader);
  assert.equal(p.fxaaMat.vertexShader, FXAAShader.vertexShader);
  assert.equal(p.fxaaRT.texture.type, THREE.UnsignedByteType);
  assert.equal(p.fxaaRT.texture.colorSpace, THREE.NoColorSpace);
  assert.deepEqual(p.fxaaMat.uniforms.resolution.value.toArray(), [1 / 640, 1 / 360]);
  let disposals = 0;
  p.fxaaRT.addEventListener('dispose', () => disposals++);
  p.resize(800, 600);
  assert.equal(disposals, 1);
  assert.deepEqual(p.fxaaMat.uniforms.resolution.value.toArray(), [1 / 800, 1 / 600]);

  for (const state of [{ moving: false, nowMs: 20 }, null]) {
    p.setInteractiveState(state); p.addSample({}, {}); p.resolve(output);
    assert.equal(r.passLog.at(-1).material, p.gradeMat);
    assert.equal(r.passLog.at(-1).target, output);
  }
  p.quality.interactiveAA = false;
  p.setInteractiveState({ moving: true, nowMs: 30 }); p.resolve(output);
  assert.equal(r.passLog.at(-1).material, p.gradeMat);
  const msaa = new Pipeline(renderer(), 640, 360, { ...quality, msaa: 4 });
  msaa.setInteractiveState({ moving: true, nowMs: 0 }); msaa.resolve();
  assert.equal(msaa.fxaaRT, undefined);
  p.dispose(); msaa.dispose();
  assert.equal(disposals, 2);
});

test('local tone mapping omits only pyramid levels never read by the grade at each output scale', () => {
  for (const [width, offset] of [[1920, 0], [3000, 1], [6720, 2]]) {
    const r = renderer(), p = new Pipeline(r, width, Math.round(width * 9 / 16), quality);
    p.resolve();
    const rendered = r.passLog.filter(pass => p.ltm.includes(pass.target));
    assert.deepEqual(rendered.map(pass => p.ltm.indexOf(pass.target)), Array.from({ length: offset + 5 }, (_, i) => i));
    const U = p.gradeMat.uniforms;
    for (const [source, texel, index] of [[U.tL0, U.uTx0, offset], [U.tL2, U.uTx2, offset + 2], [U.tL4, U.uTx4, offset + 4]]) {
      assert.equal(source.value, p.ltm[index].texture);
      assert.deepEqual(texel.value.toArray(), [1 / p.ltm[index].width, 1 / p.ltm[index].height]);
    }
    p.dispose();
  }
});

test('lens visibility reduces the unchanged upstream solar samples once with a float fallback', () => {
  LENS.uEnabled.value = 1; LENS.uSunFacing.value = 1; LENS.uSunPos.value.set(0.5, 0.5);
  const r = renderer(), p = new Pipeline(r, 640, 360, quality);
  p.setInteractiveState({ moving: true, nowMs: 0 }); p.addSample({}, {}); p.resolve();
  const lens = p.lensFX;
  assert.equal(lens.visibilityRT.width, 1);
  assert.equal(lens.visibilityRT.height, 1);
  assert.equal(lens.visibilityRT.texture.type, THREE.FloatType);
  assert.equal(lens.visibilityRT.texture.minFilter, THREE.NearestFilter);
  assert.equal(lens.compMat.uniforms.tVisibility.value, lens.visibilityRT.texture);
  assert.equal(lens.compMat.defines.CG_REDUCED_LENS, 1);
  assert.equal(lens.visibilityMat.uniforms.uDirectHDR, p._hdrDirectUniform);
  assert.equal(lens.maskMat.uniforms.uDirectHDR, p._hdrDirectUniform);
  assert(r.passLog.findIndex(pass => pass.material === lens.visibilityMat) < r.passLog.findIndex(pass => pass.material === lens.compMat));

  const upstream = fs.readFileSync(new URL('./fixtures/upstream-pipeline.js', import.meta.url), 'utf8');
  const original = upstream.match(/\/\/ sun visibility:[^\n]*\n([\s\S]*?)  vec2 d =/)[1]
    .replace('lum(texture2D(tHDR, uSunPos + o).rgb)', 'dot(readHDR(tHDR, uSunPos + o).rgb, vec3(0.2126, 0.7152, 0.0722))');
  const reduced = lens.visibilityMat.fragmentShader.match(/float sunVisibility\(\)\{([\s\S]*?)  return vis;/)[1];
  const normalize = value => value.replace(/\s+/g, '');
  assert.equal(normalize(reduced), normalize(original));

  const fallback = new Pipeline(renderer({ floatOK: false }), 640, 360, quality);
  fallback.resolve();
  assert.equal(fallback.lensFX.compMat.defines.CG_REDUCED_LENS, 0);
  assert.equal(fallback.lensFX.visibilityRT, undefined);
  let disposals = 0;
  lens.visibilityRT.addEventListener('dispose', () => disposals++);
  p.dispose(); fallback.dispose();
  assert.equal(disposals, 1);
});
