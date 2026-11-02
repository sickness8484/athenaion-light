import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolution, getRuntimeProfile, viewportSize, runtimeViewport } from '../src/core/performance.js';
import { getQuality, withRuntimeProfile } from '../src/core/quality.js';
test('runtime profiles preserve authored geometry and independent original presets', () => {
  for (const name of ['preview','high','ultra']) for (const profile of ['auto','quality','fast']) {
    const source = getQuality(name), before = structuredClone(source);
    const tuned = withRuntimeProfile(source, getRuntimeProfile(profile));
    for (const key of ['name','terrainRes','density','detail','cascades','shadowMaxFar','softShadows','ao','bloom']) assert.equal(tuned[key], source[key]);
    assert.deepEqual(source, before);
  }
  assert.equal(getRuntimeProfile('invalid').key, 'auto');
  assert.equal(getRuntimeProfile('auto', true).maxAcc, 16);
  assert.equal(getRuntimeProfile('auto').maxAcc, 32);
  assert.equal(withRuntimeProfile(getQuality('preview'), getRuntimeProfile('auto', true)).memoryConstrained, true);
  assert.equal(withRuntimeProfile(getQuality('preview'), getRuntimeProfile('auto', false)).memoryConstrained, false);
});
test('viewport budgets bound pixels and preserve aspect within rounding', () => {
  for (const [w,h] of [[3840,2160],[1440,900],[390,844],[1,1],[8000,300]]) {
    for (const profile of ['auto','quality','fast']) {
      const p = getRuntimeProfile(profile);
      for (const scale of [p.minScale,p.movingScale,1]) {
        const size = viewportSize(w,h,p.pixelBudget,scale);
        assert.ok(size.width * size.height <= p.pixelBudget);
        assert.ok(size.width >= 1 && size.height >= 1);
        assert.ok(size.width <= w && size.height <= h);
        assert.ok(Math.abs(size.width - size.height * w / h) <= 1 + w / h);
      }
    }
  }
  assert.deepEqual(viewportSize(NaN,-1,Infinity), {width:1,height:1});
});
test('adaptive resolution handles stalls, respects floor and recovers slowly', () => {
  const p = getRuntimeProfile('auto'); const controller = new AdaptiveResolution(p);
  for (let i=1;i<=60;i++) controller.observe(600,i*600);
  assert.equal(controller.scale,p.minScale);
  const afterSlow=controller.scale;
  for (let i=1;i<=400;i++) controller.observe(16,36000+i*16);
  assert.ok(controller.scale > afterSlow);
  assert.equal(controller.scale,p.movingScale);
  const before={scale:controller.scale,ema:controller.ema,samples:controller.samples};
  for (const dt of [0,-1,NaN,Infinity,3000]) controller.observe(dt,50000);
  assert.deepEqual({scale:controller.scale,ema:controller.ema,samples:controller.samples},before);
});
test('adaptive changes are rate limited even at low frame rates', () => {
  const c=new AdaptiveResolution(getRuntimeProfile('auto'));
  let changes=0,last=-Infinity;
  for(let i=1;i<=100;i++) if(c.observe(60,i*60)){assert.ok(i*60-last>=1200);last=i*60;changes++;}
  assert.ok(changes>=2); assert.ok(changes<=4);
});

test('phone and Retina views use physical pixels without exceeding the selected budget', () => {
  const phone = getRuntimeProfile('auto', true);
  assert.deepEqual(runtimeViewport(390, 844, phone, 1, 3), { width: 679, height: 1471 });
  assert.deepEqual(runtimeViewport(390, 844, phone, phone.minScale, 3), { width: 577, height: 1250 });
  assert.deepEqual(runtimeViewport(1920, 1080, getRuntimeProfile('auto'), 1, 1), { width: 1920, height: 1080 });
  for (const name of ['auto', 'quality', 'fast']) for (const mobile of [false, true]) {
    const p = getRuntimeProfile(name, mobile);
    for (const [w, h] of [[390, 844], [1440, 900], [3840, 2160]]) for (const dpr of [1, 2, 3]) {
      const size = runtimeViewport(w, h, p, 1, dpr);
      assert.ok(size.width * size.height <= p.pixelBudget);
      assert.ok(size.width <= w * Math.min(dpr, p.maxPixelRatio));
      assert.ok(Math.abs(size.width - size.height * w / h) <= 1 + w / h);
    }
  }
  assert.deepEqual(runtimeViewport(390, 844, phone, 1, NaN), { width: 390, height: 844 });
});

test('sustained load cannot collapse the sharpness floor or downscale the quality profile', () => {
  for (const name of ['auto', 'quality', 'fast']) {
    const p = getRuntimeProfile(name), c = new AdaptiveResolution(p);
    for (let i = 1; i <= 100; i++) c.observe(120, i * 120);
    assert.ok(c.scale >= (name === 'fast' ? 0.8 : 0.85));
    if (name === 'quality') assert.equal(c.scale, 1);
  }
});
