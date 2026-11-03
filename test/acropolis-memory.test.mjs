import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ChunkedBuilders } from '../src/acropolis/geo.js';

function fixture() {
  const builders = new ChunkedBuilders(48);
  const a = builders.get('stone', 0, 0);
  a.aux = [0.2, 0.7, 0.35, 0.1];
  a.quad([0.1, 0.2, 0.3], [3.7, 0.2, 0.3], [3.7, 2.6, 0.3], [0.1, 2.6, 0.3], [0.7, 0.4, 0.2]);
  const b = builders.get('gold', 140, -90);
  b.tri([140, 1, -90], [141, 1, -90], [140, 2, -91], [[1, 0.8, 0.1], [0.7, 0.5, 0.1], [1, 0.9, 0.2]]);
  // The very wide case exercises the unquantized toGeometry() branch too.
  builders.get('stone', 500, 0).quad([200, 0, 0], [800, 0, 0], [800, 4, 1], [200, 4, 1], [0.4, 0.5, 0.6]);
  return builders;
}

function bytes(attribute) {
  return new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
}

function assertSameMesh(actual, expected) {
  assert.equal(actual.name, expected.name);
  assert.equal(actual.material, expected.material);
  assert.equal(actual.castShadow, expected.castShadow);
  assert.deepEqual(actual.userData, expected.userData);
  assert.deepEqual(actual.position.toArray(), expected.position.toArray());
  assert.deepEqual(actual.scale.toArray(), expected.scale.toArray());
  assert.deepEqual(actual.matrixWorld.elements, expected.matrixWorld.elements);
  assert.deepEqual(actual.geometry.boundingBox, expected.geometry.boundingBox);
  assert.deepEqual(actual.geometry.boundingSphere, expected.geometry.boundingSphere);
  assert.deepEqual(Object.keys(actual.geometry.attributes), Object.keys(expected.geometry.attributes));
  for (const name of [...Object.keys(expected.geometry.attributes), 'index']) {
    const a = name === 'index' ? actual.geometry.index : actual.geometry.attributes[name];
    const b = name === 'index' ? expected.geometry.index : expected.geometry.attributes[name];
    assert.equal(a.array.constructor, b.array.constructor, name);
    assert.equal(a.itemSize, b.itemSize, name);
    assert.equal(a.normalized, b.normalized, name);
    assert.deepEqual(bytes(a), bytes(b), name);
  }
}

test('consuming finalized acropolis builders releases construction ownership and preserves every mesh byte', () => {
  const builders = fixture();
  const mats = { stone: new THREE.MeshStandardMaterial(), gold: new THREE.MeshStandardMaterial() };
  const opts = { noShadowMats: ['gold'] };
  const originalBuffers = new Set([...builders.map.values()].flatMap(b => [b.P, b.N, b.C, b.A, b.I].map(a => a.a.buffer)));
  assert([...originalBuffers].reduce((n, b) => n + b.byteLength, 0) > 0);
  const expected = builders.meshes(mats, opts);
  const triangles = builders.tris;
  assert.equal(builders.map.size, 3, 'The default API remains reusable');
  let disposed = 0;
  for (const mesh of expected) mesh.geometry.addEventListener('dispose', () => disposed++);
  const actual = builders.meshes(mats, { ...opts, consume: true });
  assert.equal(builders.map.size, 0, 'Retained scene hooks must not retain completed growable buffers through this map');
  assert.equal(builders.tris, triangles, 'Module statistics remain available after consumption');
  assert.equal(actual.length, expected.length);
  actual.forEach((mesh, i) => {
    assertSameMesh(mesh, expected[i]);
    for (const a of [...Object.values(mesh.geometry.attributes), mesh.geometry.index]) {
      assert(!originalBuffers.has(a.array.buffer), 'Output geometry must own its data before a builder is released');
    }
  });
  assert.equal(disposed, 0, 'Releasing construction ownership must never dispose scene geometry');
  // New work, including the later colossus-dressing hook, gets a fresh builder.
  const fresh = builders.get('stone', 0, 0);
  assert.equal(fresh.count, 0);
  assert.equal(fresh.empty, true);
  actual.forEach((mesh, i) => assertSameMesh(mesh, expected[i]));
});
