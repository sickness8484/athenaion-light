import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { freezeStaticTransforms } from '../src/core/static-transforms.js';

function fixture() {
  const scene = new THREE.Scene(); scene.name = 'scene';
  const town = new THREE.Group(); town.name = 'town';
  town.position.set(2, 3, -4); town.rotation.y = 0.2; scene.add(town);
  for (let i = 0; i < 256; i++) {
    const mesh = new THREE.Mesh(); mesh.name = 'house-' + i;
    mesh.position.set(i % 16, (i % 7) * 0.25, Math.floor(i / 16));
    mesh.rotation.y = i * 0.03; mesh.scale.set(1, 1 + (i % 3), 0.8); town.add(mesh);
  }
  const ship = new THREE.Group(); ship.name = 'ship'; ship.userData.dynamicTransform = true; town.add(ship);
  for (const name of ['hull', 'sail', 'wake']) { const mesh = new THREE.Mesh(); mesh.name = name; mesh.position.set(1, 2, 3); ship.add(mesh); }
  const flame = new THREE.Mesh(); flame.name = 'flame'; flame.userData.dynamicTransform = true; town.add(flame);
  const camera = new THREE.PerspectiveCamera(); camera.name = 'camera'; scene.add(camera);
  const light = new THREE.DirectionalLight(); light.name = 'sun';
  light.target = new THREE.Group(); light.target.name = 'sun-target'; scene.add(light, light.target);
  const manual = new THREE.Mesh(); manual.name = 'manual'; manual.matrixAutoUpdate = false;
  manual.position.set(1000, 2000, 3000);
  manual.matrix.set(1, 0.3, 0, 7, 0, 2, 0.4, 8, 0, 0, 1, 9, 0, 0, 0, 1); town.add(manual);
  const birds = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2); birds.name = 'birds'; town.add(birds);
  class AnimatedGroup extends THREE.Group {}
  const custom = new AnimatedGroup(); custom.name = 'custom';
  const customChild = new THREE.Mesh(); customChild.name = 'custom-child'; custom.add(customChild); scene.add(custom);
  const bone = new THREE.Bone(); bone.name = 'bone'; scene.add(bone);
  return scene;
}

function animate(scene, t) {
  const get = (name) => scene.getObjectByName(name);
  get('ship').position.set(Math.cos(t) * 4, 0.1 * Math.sin(t), Math.sin(t) * 3);
  get('ship').rotation.set(0.01 * Math.sin(t), t, 0);
  get('flame').scale.y = 0.85 + 0.2 * Math.sin(t * 7);
  get('flame').position.y = 2 + get('flame').scale.y;
  get('camera').position.set(t, 7, 30);
  get('sun').position.set(20, 30 + t, 10);
  get('sun-target').position.set(3, 4, -t);
  get('custom-child').rotation.z = t * 0.3;
  get('bone').rotation.y = t;
  get('birds').setMatrixAt(0, new THREE.Matrix4().makeTranslation(t * 3, 12, t));
  get('birds').instanceMatrix.needsUpdate = true;
}

function countMatrixWork(action) {
  const originalCompose = THREE.Matrix4.prototype.compose;
  const originalMultiply = THREE.Matrix4.prototype.multiplyMatrices;
  const counts = { compose: 0, worldMultiply: 0 };
  THREE.Matrix4.prototype.compose = function (...args) { counts.compose++; return originalCompose.apply(this, args); };
  THREE.Matrix4.prototype.multiplyMatrices = function (...args) { counts.worldMultiply++; return originalMultiply.apply(this, args); };
  try { action(); } finally {
    THREE.Matrix4.prototype.compose = originalCompose;
    THREE.Matrix4.prototype.multiplyMatrices = originalMultiply;
  }
  return counts;
}

test('static local matrices preserve world transforms, moving children and instance animation while reducing repeated work', () => {
  const baseline = fixture(), optimized = fixture();
  baseline.updateMatrixWorld(true); optimized.updateMatrixWorld(true);
  const manual = optimized.getObjectByName('manual').matrix.clone();
  const stats = freezeStaticTransforms(optimized);
  optimized.updateMatrixWorld(true);
  assert(stats.frozen >= 260);
  assert.equal(optimized.matrixAutoUpdate, false);
  assert.equal(optimized.getObjectByName('ship').matrixAutoUpdate, true);
  assert.equal(optimized.getObjectByName('hull').matrixAutoUpdate, false);
  assert.equal(optimized.getObjectByName('camera').matrixAutoUpdate, true);
  assert.equal(optimized.getObjectByName('sun-target').matrixAutoUpdate, true);
  assert.equal(optimized.getObjectByName('custom-child').matrixAutoUpdate, true);
  assert.equal(optimized.getObjectByName('bone').matrixAutoUpdate, true);
  assert.deepEqual(optimized.getObjectByName('manual').matrix.elements, manual.elements);
  const totals = { baseline: { compose: 0, worldMultiply: 0 }, optimized: { compose: 0, worldMultiply: 0 } };
  for (const time of [0.1, 0.7, 2.4, 5.9]) {
    animate(baseline, time); animate(optimized, time);
    for (const [name, scene] of [['baseline', baseline], ['optimized', optimized]]) {
      const work = countMatrixWork(() => scene.updateMatrixWorld());
      for (const key of Object.keys(work)) totals[name][key] += work[key];
    }
    baseline.traverse((object) => {
      const other = optimized.getObjectByName(object.name);
      assert.deepEqual(other.matrixWorld.elements, object.matrixWorld.elements, object.name);
      if (object.isInstancedMesh) assert.deepEqual(other.instanceMatrix.array, object.instanceMatrix.array);
    });
  }
  assert(totals.optimized.compose < totals.baseline.compose / 4);
  assert(totals.optimized.worldMultiply < totals.baseline.worldMultiply / 4);
  assert.equal(freezeStaticTransforms(optimized).frozen, 0, 'Repeated preparation must be idempotent');
  console.log('Representative hierarchy matrix work (four updates):', JSON.stringify(totals));
});

test('late subtrees preserve targets referenced by sibling lights and authored world matrices', () => {
  const scene = new THREE.Scene(), branch = new THREE.Group(), target = new THREE.Group();
  const light = new THREE.DirectionalLight(); light.target = target;
  const staticMesh = new THREE.Mesh(); branch.add(target, staticMesh); scene.add(branch, light);
  const externalTarget = new THREE.Group(), innerLight = new THREE.SpotLight(); innerLight.target = externalTarget; branch.add(innerLight);
  const world = new THREE.Group(); world.matrixWorldAutoUpdate = false; world.matrixWorld.makeTranslation(9, 8, 7);
  const child = new THREE.Mesh(); world.add(child); branch.add(world);
  const skin = new THREE.SkinnedMesh(); branch.add(skin);
  freezeStaticTransforms(branch);
  assert.equal(target.matrixAutoUpdate, true);
  assert.equal(externalTarget.matrixAutoUpdate, true);
  assert.equal(innerLight.matrixAutoUpdate, true);
  assert.equal(staticMesh.matrixAutoUpdate, false);
  assert.equal(world.matrixWorldAutoUpdate, false);
  assert.equal(world.matrixAutoUpdate, true);
  assert.equal(child.matrixAutoUpdate, true);
  assert.deepEqual(world.matrixWorld.elements, new THREE.Matrix4().makeTranslation(9, 8, 7).elements);
  assert.equal(skin.matrixAutoUpdate, true);
});
