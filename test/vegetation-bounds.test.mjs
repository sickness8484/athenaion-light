import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js';
import { VegSystem } from '../src/vegetation/instances.js';
import { updateVegetationPageBounds } from '../src/vegetation/bounds.js';
import { WIND } from '../src/materials/foliage.js';

function pageFor(geometry, matrices, { count = matrices.length, billboard = false } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), matrices.length);
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.count = count;
  mesh.userData.vegetationBillboard = billboard;
  return { im: mesh.instanceMatrix, parts: [mesh] };
}

test('page bounds contain shader wind for arbitrary time, tilt, unequal scale and shear', () => {
  const geometry = new THREE.BoxGeometry(2, 8, 1).translate(3, 4, -2);
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
  const fol = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    fol[i * 4 + 1] = 0.4 + i % 4 * 0.3;
    fol[i * 4 + 3] = 0.2 + i % 5 * 0.3; // includes weights greater than one
  }
  geometry.setAttribute('aFol', new THREE.BufferAttribute(fol, 4));
  const matrices = [
    new THREE.Matrix4().compose(new THREE.Vector3(8, 7, -31), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -0.9, 0.3)), new THREE.Vector3(0.8, 3.2, 1.7)),
    new THREE.Matrix4().set(2, 1.2, -0.7, -40, 0.4, -1.1, 0.6, 12, -0.2, 0.3, 1.9, -70, 0, 0, 0, 1),
    new THREE.Matrix4().makeTranslation(1e6, 0, 0), // stale capacity, not an active instance
  ];
  const page = pageFor(geometry, matrices, { count: 2 });
  const mesh = page.parts[0], m = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const amp of [0, 1, 4, -2.5]) {
    updateVegetationPageBounds(page, amp);
    assert(mesh.frustumCulled);
    assert(mesh.boundingSphere.radius < 200, 'Unused page capacity must not enlarge the bounds');
    for (let instance = 0; instance < mesh.count; instance++) {
      mesh.getMatrixAt(instance, m);
      const phase = m.elements[12] * 0.071 + m.elements[13] * 0.013 + m.elements[14] * 0.053;
      for (const time of [0, 0.25, 12.3, 1047]) for (let i = 0; i < p.count; i++) {
        const weight = fol[i * 4 + 3] ** 2 * amp;
        const flutter = Math.sin(time * 5.7 + phase * 3 + p.getX(i) * 2.1 + p.getY(i) * 1.7 + p.getZ(i) * 2.9) * 0.015 * fol[i * 4 + 1] * amp;
        v.set(
          p.getX(i) + (Math.sin(time * 0.83 + phase) + 0.35 * Math.sin(time * 2.3 + phase * 1.7)) * weight * 0.08 + n.getX(i) * flutter,
          p.getY(i) + n.getY(i) * flutter,
          p.getZ(i) + 0.6 * Math.cos(time * 0.61 + phase * 1.3) * weight * 0.08 + n.getZ(i) * flutter,
        ).applyMatrix4(m);
        assert(mesh.boundingSphere.containsPoint(v), 'A shader-displaced vertex must remain inside the page sphere');
      }
    }
  }
  const previousRadius = mesh.boundingSphere.radius;
  mesh.count = 1;
  updateVegetationPageBounds(page, 1);
  assert(mesh.boundingSphere.radius < previousRadius, 'Shrinking the active prefix must refresh its bounds');
  updateVegetationPageBounds(page, Infinity);
  assert.equal(mesh.frustumCulled, false, 'Unknown displacement must fail open');
});

test('billboard bounds contain every camera-facing orientation after tilt and width scaling', () => {
  const geometry = new THREE.PlaneGeometry(6, 12).translate(0, 6, 0);
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(12, -3, -20), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 1.1, -0.8)), new THREE.Vector3(2.3, 0.7, 1.4));
  const page = pageFor(geometry, [transform], { billboard: true });
  updateVegetationPageBounds(page, 1);
  const p = geometry.getAttribute('position'), v = new THREE.Vector3(), stored = new THREE.Matrix4();
  page.parts[0].getMatrixAt(0, stored);
  for (let angle = 0; angle < Math.PI * 2; angle += 0.05) for (let i = 0; i < p.count; i++) {
    v.set(Math.cos(angle) * p.getX(i), p.getY(i), Math.sin(angle) * p.getX(i)).applyMatrix4(stored);
    assert(page.parts[0].boundingSphere.containsPoint(v));
  }
});

test('an offscreen tree remains available to a shadow camera that sees it', () => {
  const page = pageFor(new THREE.BoxGeometry(1, 1, 1), [new THREE.Matrix4().makeTranslation(10, 0, -20)]);
  const mesh = page.parts[0];
  mesh.castShadow = true;
  updateVegetationPageBounds(page, 1);
  mesh.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const shadow = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 100);
  shadow.position.set(20, 30, 0); shadow.lookAt(10, 0, -20);
  const frustum = camera => { camera.updateMatrixWorld(); return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)); };
  assert.equal(frustum(camera).intersectsObject(mesh), false);
  assert.equal(frustum(shadow).intersectsObject(mesh), true);
  assert.equal(mesh.visible, true);
  assert.equal(mesh.castShadow, true);
});

test('stable page slots avoid copies/uploads; pending upload ranges survive multiple camera updates', () => {
  const oldAmp = WIND.uWindAmp.value;
  try {
    WIND.uWindAmp.value = 1;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const engine = { camera, height: 941, quality: { name: 'preview', detail: 0.5 }, params: new URLSearchParams() };
    const sys = new VegSystem(engine);
    const geometry = new THREE.BoxGeometry(1, 4, 1).translate(0, 2, 0);
    const variant = sys.addVariant({ name: 'test', H: 4, px: [10, 5, 1], lods: [{ bark: geometry, tris: 12 }], materials: { bark: new THREE.MeshStandardMaterial() } });
    for (let i = 0; i < 4; i++) sys.add(variant, i - 1.5, 0, -20, i * 0.1, 1);
    sys.finalize(); sys.forceLod = 0; sys.update(camera);
    const page = variant.lodMeshes[0].pages[0];
    assert.equal(sys.stats.copiedInstances, 4);
    // Exercise Three's actual upload manager with a recording GL buffer, including its initial
    // bufferData path (which otherwise retains the first update range until the next edit).
    let bound, writes = 0;
    const gl = {
      FLOAT: 5126, createBuffer: () => ({}), bindBuffer: (type, buffer) => { bound = buffer; },
      bufferData: (type, array) => { bound.data = array.slice(); writes++; },
      bufferSubData: (type, offset, array, start = 0, count = array.length) => { bound.data.set(array.subarray(start, start + count), offset / 4); writes++; },
    };
    const uploader = WebGLAttributes(gl);
    uploader.update(page.im, 34962); uploader.update(page.ic, 34962);
    assert.deepEqual(page.im.updateRanges, []);
    const version = page.im.version;
    camera.position.x += 0.8;
    assert.equal(sys.maybeUpdate(camera), true);
    assert.equal(sys.stats.copiedInstances, 0);
    assert.equal(page.im.version, version);
    assert.deepEqual(page.im.updateRanges, []);
    uploader.update(page.im, 34962); uploader.update(page.ic, 34962);
    assert.equal(writes, 2, 'Stable pages should cause no bufferSubData calls');
    variant.visibleCount = 3; variant.visibleIds.set([3, 1, 2]); variant.selectedLod.fill(0); variant.planCounts[0] = 3;
    sys._applyPlan();
    assert.equal(sys.stats.copiedInstances, 1);
    assert.deepEqual(page.im.updateRanges, [{ start: 0, count: 16 }]);
    variant.visibleIds.set([3, 1, 0]);
    sys._applyPlan();
    assert.equal(sys.stats.copiedInstances, 1);
    assert.deepEqual(page.im.updateRanges, [{ start: 0, count: 48 }], 'The first pending slot must not be discarded by the second update');
    assert.deepEqual(page.ic.updateRanges, [{ start: 0, count: 9 }]);
    uploader.update(page.im, 34962); uploader.update(page.ic, 34962);
    assert.equal(writes, 4);
    assert.deepEqual(uploader.get(page.im).buffer.data.subarray(0, 48), page.im.array.subarray(0, 48), 'The actual uploaded prefix must include both pending camera edits');
    const history = variant.lastLod.slice();
    WIND.uWindAmp.value = 3;
    assert.equal(sys.maybeUpdate(camera), true);
    assert.deepEqual(variant.lastLod, history, 'Changing wind strength must not re-run LOD history');
  } finally { WIND.uWindAmp.value = oldAmp; }
});
