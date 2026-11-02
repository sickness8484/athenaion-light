import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { compileInBatches } from '../src/core/compile.js';

test('shader batches retain hidden LODs, object variants, parents and scene lighting', async () => {
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geometry, material), child = new THREE.Mesh(geometry, material);
  const instances = new THREE.InstancedMesh(geometry, material, 2);
  child.visible = false; scene.add(mesh, instances, new THREE.DirectionalLight()); mesh.add(child);
  const expected = [mesh, child, instances], parents = expected.map(o => o.parent), seen = [], events = [];
  await compileInBatches({ async compileAsync(batch, cam, target) {
    assert.equal(cam, camera); assert.equal(target, scene);
    const objects = []; batch.traverse(o => { if (o.material) objects.push(o); });
    assert.ok(objects.length <= 2); batch.traverseVisible(o => assert.ok(!o.isLight));
    seen.push(...objects); events.push('compile');
  } }, scene, camera, { batchSize: 2, yieldTask: async () => { events.push('yield'); } });
  assert.deepEqual(seen, expected); assert.deepEqual(expected.map(o => o.parent), parents);
  assert.deepEqual(events, ['compile', 'yield', 'compile']); assert.equal(child.visible, false);
  geometry.dispose(); material.dispose();
});

test('failed batch stops submission and releases temporary object references', async () => {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  const meshes = Array.from({ length: 3 }, () => new THREE.Mesh(geometry, material)); scene.add(...meshes);
  let calls = 0, retained;
  await assert.rejects(compileInBatches({ async compileAsync(batch) {
    calls++; retained = batch; throw new Error('compile failed');
  } }, scene, new THREE.Camera(), { batchSize: 1 }), /compile failed/);
  assert.equal(calls, 1); retained.traverse(o => assert.ok(!o.material));
  assert.deepEqual(scene.children, meshes); assert.ok(meshes.every(m => m.parent === scene));
  geometry.dispose(); material.dispose();
});
