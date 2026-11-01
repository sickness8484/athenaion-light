import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolution, getRuntimeProfile, viewportSize } from '../src/core/performance.js';
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
  for(let i=1;i<=100;i++) if(c.observe(60,i*60)){assert.ok(i*60-last>=650);last=i*60;changes++;}
  assert.ok(changes>=2); assert.ok(changes<=4);
});
