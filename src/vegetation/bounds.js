// Conservative bounds for the foliage vertex shader, including wind and rotating billboards.
// Geometry is unchanged; these envelopes only let each render/shadow camera skip whole pages
// that cannot contribute a pixel. Bounds are in the page mesh's local space, after instancing.
import * as THREE from 'three';

const envelopes = new WeakMap();

export function vegetationEnvelope(geometry, billboard = false) {
  let cached = envelopes.get(geometry);
  if (!cached) { cached = []; envelopes.set(geometry, cached); }
  const key = billboard ? 1 : 0;
  if (cached[key]) return cached[key];
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox.clone();
  if (billboard) {
    // BB_VERT rotates the quad around its own Y axis for EACH render camera. A radial
    // envelope must cover main, reflection and shadow cameras, independently of yaw/tilt.
    const radial = Math.hypot(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)), Math.max(Math.abs(box.min.z), Math.abs(box.max.z)));
    box.min.x = box.min.z = -radial;
    box.max.x = box.max.z = radial;
  }
  const wind = new THREE.Vector3();
  const fol = geometry.getAttribute('aFol'), normal = geometry.getAttribute('normal');
  if (fol) {
    for (let i = 0; i < fol.count; i++) {
      // VERT_WIND: x sway <= (1 + .35) * .08 * w², z <= .6 * .08 * w²,
      // plus normal * sin(phase) * .015 * tip. Do not assume normalized normals or w <= 1.
      const sway = fol.getW(i) ** 2;
      const tip = Math.abs(fol.getY(i)) * 0.015;
      wind.x = Math.max(wind.x, 0.108 * sway + tip * Math.abs(normal?.getX(i) || 0));
      wind.y = Math.max(wind.y, tip * Math.abs(normal?.getY(i) || 0));
      wind.z = Math.max(wind.z, 0.048 * sway + tip * Math.abs(normal?.getZ(i) || 0));
    }
  }
  return cached[key] = { center: box.getCenter(new THREE.Vector3()), half: box.getSize(new THREE.Vector3()).multiplyScalar(0.5), wind };
}

/** Update each part using only the active instance prefix, never the unused capacity. */
export function updateVegetationPageBounds(page, amplitude) {
  const amp = Math.abs(amplitude), a = page.im.array;
  for (const mesh of page.parts) {
    if (!mesh.count) continue;
    if (!Number.isFinite(amp)) { mesh.frustumCulled = false; continue; }
    const { center: c, half: h, wind: w } = vegetationEnvelope(mesh.geometry, mesh.userData.vegetationBillboard);
    const ex = h.x + w.x * amp, ey = h.y + w.y * amp, ez = h.z + w.z * amp;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0, n = mesh.count * 16; i < n; i += 16) {
      const x = a[i] * c.x + a[i + 4] * c.y + a[i + 8] * c.z + a[i + 12];
      const y = a[i + 1] * c.x + a[i + 5] * c.y + a[i + 9] * c.z + a[i + 13];
      const z = a[i + 2] * c.x + a[i + 6] * c.y + a[i + 10] * c.z + a[i + 14];
      // Absolute linear transform of an AABB: conservative for rotations, unequal scales,
      // negative scales AND shear. A max-column-length sphere transform would miss shear.
      const rx = Math.abs(a[i]) * ex + Math.abs(a[i + 4]) * ey + Math.abs(a[i + 8]) * ez;
      const ry = Math.abs(a[i + 1]) * ex + Math.abs(a[i + 5]) * ey + Math.abs(a[i + 9]) * ez;
      const rz = Math.abs(a[i + 2]) * ex + Math.abs(a[i + 6]) * ey + Math.abs(a[i + 10]) * ez;
      x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx);
      y0 = Math.min(y0, y - ry); y1 = Math.max(y1, y + ry);
      z0 = Math.min(z0, z - rz); z1 = Math.max(z1, z + rz);
    }
    if (![x0, x1, y0, y1, z0, z1].every(Number.isFinite)) { mesh.frustumCulled = false; continue; }
    const sphere = mesh.boundingSphere ||= new THREE.Sphere();
    sphere.center.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
    sphere.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.5;
    // Cover Float32 vertex/matrix arithmetic at the boundary, including large world offsets.
    sphere.radius += 1e-4 + Math.max(sphere.radius, Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1), Math.abs(z0), Math.abs(z1)) * 1e-6;
    mesh.frustumCulled = true;
  }
}
