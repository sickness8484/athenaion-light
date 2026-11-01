import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VegSystem } from '../src/vegetation/instances.js';
import { runVegetationScenario } from './vegetation-scenario.mjs';

test('vegetation preserves upstream LODs, histories, active transforms/colors and shadows', () => {
  // Generated from unmodified Leonxlnx/athenaion instances.js at the recorded upstream commit.
  // Stored outputs keep this regression test independent of the optimized planning implementation.
  const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/vegetation-upstream.json', import.meta.url), 'utf8'));
  class ObservedVegetation extends VegSystem {
    _applyPlan() { this.applications = (this.applications || 0) + 1; return super._applyPlan(); }
  }
  const maxima = new Map();
  let applications = 0;
  const { snapshots, system } = runVegetationScenario(ObservedVegetation, (sys, snapshot) => {
    if (snapshot.updated) applications++;
    assert.equal(sys.applications, applications, 'Only the final plan should copy instance buffers');
    for (const v of sys.variants) {
      assert.equal(v.inst, null, 'Temporary per-tree object records should be released');
      assert.equal(v.instanceCount, v.mat ? v.mat.length / 16 : 0);
      for (const lod of v.lodMeshes || []) {
        const key = v.name + ':' + lod.l;
        const required = Math.max(maxima.get(key) || 0, Math.ceil(lod.count / lod.page));
        maxima.set(key, required);
        assert.equal(lod.pages.length, required, 'No page may be allocated for a discarded trial LOD');
      }
    }
  });
  assert.equal(snapshots.length, baseline.scenarios.length);
  for (let i = 0; i < snapshots.length; i++) {
    const { allocatedPages: originalPages, ...expected } = baseline.scenarios[i];
    const { allocatedPages: optimizedPages, ...actual } = snapshots[i];
    assert.deepEqual(actual, expected, 'Upstream output mismatch: ' + expected.label);
    assert(optimizedPages <= originalPages, 'The optimized planner should not increase page allocations');
  }
  assert(snapshots[0].allocatedPages < baseline.scenarios[0].allocatedPages, 'The tight-budget case must actually remove discarded allocations');
  assert.throws(() => system.add(system.variants[0], 0, 0, 0, 0, 1), /before finalize/);
});
