// Freeze local transforms of the audited, procedural scene after construction.
// World-matrix propagation stays entirely under Three.js: a moving parent still
// updates its static children, and instance buffers/shader animation are untouched.
import * as THREE from 'three';

const STATIC_TYPES = new Set([
  THREE.Scene, THREE.Group, THREE.Mesh, THREE.InstancedMesh,
  THREE.Points, THREE.Line, THREE.LineSegments, THREE.LineLoop, THREE.Sprite,
]);

/** Mark Object3D TRS animation with userData.dynamicTransform before calling.
 * Unknown subclasses, rigs, cameras, lights, light targets and manually managed
 * world matrices are conservative exclusions. Pre-authored local matrices with
 * matrixAutoUpdate=false are never recomposed.
 */
export function freezeStaticTransforms(root) {
  if (!root?.isObject3D) throw new TypeError('A Three.js Object3D root is required');
  let sceneRoot = root;
  while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
  const targets = new Set();
  // A light's target is commonly a sibling of the light, not its child. Search
  // the containing scene even when a late-added subtree is being prepared.
  sceneRoot.traverse((object) => { if (object.isLight && object.target) targets.add(object.target); });
  const stats = { frozen: 0, alreadyStatic: 0, dynamic: 0, excluded: 0 };
  const visit = (object) => {
    if (targets.has(object) || object.isCamera || object.isLight || object.isSkinnedMesh || object.isBone || object.matrixWorldAutoUpdate === false) {
      stats.excluded++; return;
    }
    if (object.userData.dynamicTransform === true) stats.dynamic++;
    else if (!STATIC_TYPES.has(object.constructor)) { stats.excluded++; return; }
    else if (object.matrixAutoUpdate) {
      object.updateMatrix();
      object.matrixAutoUpdate = false;
      stats.frozen++;
    } else stats.alreadyStatic++;
    for (const child of object.children) visit(child);
  };
  visit(root);
  return stats;
}
