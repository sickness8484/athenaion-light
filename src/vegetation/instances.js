// Instance manager: every tree variant has 4 LOD geometries (each split into bark / blob / card
// parts, one material each). Instances are re-bucketed into LODs from the CURRENT camera
// (projected size in pixels) and culled per instance against the view frustum extended toward
// the sun (so off-screen trees still cast their shadows into view). Re-bucketing runs on every
// shot change, whenever the camera moved (video / interactive), and costs a few ms.
import * as THREE from 'three';
import { ATMO } from '../core/atmosphere.js';
import { windDepthMaterial, WIND } from '../materials/foliage.js';
import { updateVegetationPageBounds } from './bounds.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0), _up = new THREE.Vector3(), _qt = new THREE.Quaternion();
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere();
const MAX_TRIS = 350000;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function markUpload(attribute, start, count) {
  // Several camera updates may happen before the renderer consumes this attribute. Merge
  // pending ranges so a later edit never discards an earlier, still-unuploaded change.
  let end = start + count;
  for (const range of attribute.updateRanges) { start = Math.min(start, range.start); end = Math.max(end, range.start + range.count); }
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}

export class VegSystem {
  constructor(engine) {
    this.engine = engine;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.variants = [];
    this.lastCam = null;
    this.stats = { instances: 0 };
    this.detail = engine.quality.detail ?? 1;
  }

  /**
   * @param {object} def { name, lods:[{bark,blob,card}], materials:{bark,blob,card}, H (nominal height),
   *                       px: [lod0, lod1, lod2] pixel-height thresholds, cullPx, shadowLod (max LOD casting shadows) }
   */
  addVariant(def) {
    const v = { ...def, inst: [], meshes: [] };
    this.variants.push(v);
    return v;
  }

  /**
   * add an instance: position, yaw (rad, about the tree's own axis), scale (uniform), opts:
   *   width (crown width multiplier), tint [r,g,b],
   *   up [x,y,z] (world-space growth direction; default +Y) or tilt [ax, az] (world rotations about X then Z, rad)
   */
  add(v, x, y, z, yaw, scale, opts = {}) {
    if (!v.inst) throw new Error('Vegetation instances must be added before finalize()');
    v.inst.push({ x, y, z, yaw, s: scale, w: opts.width || 1, up: opts.up || (opts.tilt ? [-Math.sin(opts.tilt[1]) * Math.cos(opts.tilt[0]), Math.cos(opts.tilt[1]) * Math.cos(opts.tilt[0]), Math.cos(opts.tilt[1]) * Math.sin(opts.tilt[0])] : null), tint: opts.tint || [1, 1, 1], h: v.H * scale });
  }

  finalize() {
    for (const v of this.variants) {
      const n = v.inst.length;
      v.instanceCount = n;
      if (!n) { v.inst = null; continue; }
      // precompute matrices
      v.mat = new Float32Array(n * 16);
      v.col = new Float32Array(n * 3);
      v.ctr = new Float32Array(n * 4);
      v.lastLod = new Int8Array(n).fill(-1);
      // Reusable planning buffers: retries share visibility/projection and never allocate GPU pages.
      // Float64 preserves the original arithmetic at LOD/cull thresholds.
      v.visibleIds = new Uint32Array(n);
      v.projected = new Float64Array(n);
      v.selectedLod = new Int8Array(n);
      v.visibleCount = 0;
      v.planCounts = new Uint32Array(v.lods.length);
      v.writeCounts = new Uint32Array(v.lods.length);
      for (let i = 0; i < n; i++) {
        const it = v.inst[i];
        // world-space tilt (growth direction) applied after the yaw about the tree's own axis
        _q.setFromAxisAngle(_Y, it.yaw);
        if (it.up) { _up.set(it.up[0], it.up[1], it.up[2]).normalize(); _qt.setFromUnitVectors(_Y, _up); _q.premultiply(_qt); }
        _s.set(it.s * it.w, it.s, it.s * it.w);
        _p.set(it.x, it.y, it.z);
        _m.compose(_p, _q, _s);
        _m.toArray(v.mat, i * 16);
        v.col.set(it.tint, i * 3);
        v.ctr[i * 4] = it.x; v.ctr[i * 4 + 1] = it.y + it.h * 0.5; v.ctr[i * 4 + 2] = it.z; v.ctr[i * 4 + 3] = it.h;
      }
      // LOD buckets are split into pages (separate instanced draws of ≤ ~MAX_TRIS triangles each):
      // keeps every single draw call short on the integrated GPU. Pages are created on demand.
      v.lodMeshes = v.lods.map((lod, l) => ({ l, lod, pages: [], page: clamp(Math.floor(MAX_TRIS / Math.max(1, lod.tris || 1)), 16, 4096) }));
      this.stats.instances += n;
      // All runtime readers use the typed transforms/colors/centres above. Do not retain a second
      // object, tint array, and optional up vector for every placed tree after finalization.
      v.inst = null;
    }
    for (const card of [false, true]) this.engine.patchMaterial?.(windDepthMaterial(card));
    // instanced pages are created lazily (first LOD update happens after engine.prepareScene()), so patch
    // every variant material here: atmosphere + CSM, and a per-shader program cache key (unpatched
    // procedural materials would all share three's default key and silently swap programs)
    for (const v of this.variants) for (const k in v.materials) this.engine.patchMaterial?.(v.materials[k]);
    // sentinel: re-bucket when the interactive camera moves (onBeforeRender of the main pass)
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    const sm = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const sentinel = new THREE.Mesh(sg, sm);
    sentinel.frustumCulled = false; sentinel.castShadow = false; sentinel.receiveShadow = false;
    sentinel.userData.castShadow = false; sentinel.userData.noPatch = true;
    sentinel.onBeforeRender = (renderer, scene, camera) => { if (camera === this.engine.camera) this.maybeUpdate(camera); };
    this.group.add(sentinel);
  }

  _newPage(v, L) {
    const cap = L.page;
    const im = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    im.setUsage(THREE.DynamicDrawUsage);
    im.onUpload(() => im.clearUpdateRanges());
    const ic = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    ic.setUsage(THREE.DynamicDrawUsage);
    ic.onUpload(() => ic.clearUpdateRanges());
    const parts = [];
    const P = this.engine.params;
    for (const part of ['bark', 'blob', 'card', 'bb']) {
      const geo = L.lod[part];
      if (!geo) continue;
      if (P?.get?.('vegNoCards') && part === 'card') continue;
      // Each part shares this page's matrix/color attributes; avoid a temporary cap-sized matrix
      // allocation and identity-fill that would be immediately replaced by im below.
      const mesh = new THREE.InstancedMesh(geo, v.materials[part], 0);
      mesh.instanceMatrix = im;
      mesh.instanceColor = ic;
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.name = `veg:${v.name}:L${L.l}:${part}:p${L.pages.length}`;
      // far LODs and mid-range leaf cards add nothing visible to the (coarse) shadow cascades
      const cast = L.l <= (v.shadowLod ?? 3) && !(part === 'card' && L.l > 0) && !P?.get?.('vegNoShadow');
      mesh.castShadow = cast; mesh.receiveShadow = true;
      mesh.userData.castShadow = cast; mesh.userData.receiveShadow = true;
      mesh.customDepthMaterial = windDepthMaterial(part === 'card' || part === 'bb');
      mesh.userData.vegetationBillboard = part === 'bb';
      this.group.add(mesh);
      parts.push(mesh);
    }
    const pg = { im, ic, parts, cap, ids: new Uint32Array(cap).fill(0xffffffff), count: 0, dirtyStart: cap, dirtyEnd: 0 };
    L.pages.push(pg);
    return pg;
  }

  /** forget LOD history (a camera cut): stills are then independent of previously rendered shots */
  resetHistory() { for (const v of this.variants) if (v.lastLod) v.lastLod.fill(-1); }

  maybeUpdate(camera = this.engine.camera) {
    const c = camera;
    const key = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w, c.fov];
    if (this.lastCam) {
      const dp = Math.hypot(key[0] - this.lastCam[0], key[1] - this.lastCam[1], key[2] - this.lastCam[2]);
      const dq = Math.abs(key[3] - this.lastCam[3]) + Math.abs(key[4] - this.lastCam[4]) + Math.abs(key[5] - this.lastCam[5]) + Math.abs(key[6] - this.lastCam[6]);
      if (dp < 0.75 && dq < 0.004 && key[7] === this.lastCam[7]) {
        const amplitude = WIND.uWindAmp.value;
        if (this.boundsWindAmp === amplitude) return false;
        // Wind strength changes bounds, not the selected trees/LOD history.
        for (const v of this.variants) for (const L of v.lodMeshes || []) for (const pg of L.pages) updateVegetationPageBounds(pg, amplitude);
        this.boundsWindAmp = amplitude;
        return true;
      }
    }
    this.update(camera);
    return true;
  }

  /**
   * re-bucket every instance into LODs for this camera. Keeps the drawn vegetation under a triangle budget
   * (default 9 M, URL param vegTris): when a view would exceed it, the LOD distances shrink (≤ 3 retries).
   */
  update(camera = this.engine.camera) {
    const t0 = performance.now();
    // (r5) the budget grows with the output height: a 4K still keeps the LOD distances of the 941 px frame
    // (otherwise the doubled projected sizes would just be traded back for coarser LODs)
    const resK = clamp((this.engine.height || 941) / 941, 1, 2.4);
    // (r5: 9 M → 13 M at high: vegetation costs ≈ 65 ms of a ≈ 0.6-0.9 s sample on the 780M, and the finer
    //  LODs are what keeps the mid-distance crowns textured instead of smooth)
    const budget = Number(this.engine.params?.get?.('vegTris')) || (this.engine.quality.name === 'ultra' ? 16e6 : this.detail >= 1 ? 13e6 : 9e6) * resK;
    this._prepareProjection(camera);
    let k = 1, st = this._plan(1, false);
    for (let i = 0; i < 3 && this.forceLod === undefined && st.tris > budget; i++) {
      k *= Math.sqrt(budget / st.tris) * 0.94;
      st = this._plan(k, true);
    }
    this._applyPlan();
    st.lodScale = +k.toFixed(3);
    st.updateMs = +(performance.now() - t0).toFixed(1);
    return st;
  }

  /** Frustum/shadow visibility and unscaled projected height do not change during budget retries. */
  _prepareProjection(camera) {
    const c = camera;
    c.updateMatrixWorld(true);
    this.lastCam = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w, c.fov];
    // Preserve the original expanded frustum (jitter / DOF / edge popping).
    const cam2 = c.clone();
    cam2.fov = Math.min(170, c.fov * 1.12);
    cam2.aspect = c.aspect * 1.04;
    cam2.near = 0.1; cam2.far = 40000;
    cam2.updateProjectionMatrix();
    cam2.updateMatrixWorld(true);
    _pm.multiplyMatrices(cam2.projectionMatrix, cam2.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const focalPx = (this.engine.height * 0.5) / Math.tan((c.fov * Math.PI) / 360);
    const sun = ATMO.uSunDir.value;
    const sy = Math.max(0.12, sun.y);
    const cx = c.position.x, cy = c.position.y, cz = c.position.z;
    for (const v of this.variants) {
      v.visibleCount = 0;
      for (let i = 0; i < v.instanceCount; i++) {
        const x = v.ctr[i * 4], y = v.ctr[i * 4 + 1], z = v.ctr[i * 4 + 2], h = v.ctr[i * 4 + 3];
        const r = h * 0.5 + 1.5;
        _sph.center.set(x, y, z); _sph.radius = r;
        let vis = _frustum.intersectsSphere(_sph);
        if (!vis) {
          // Shadow volume: from the crown away from the sun down to the ground.
          const L = Math.min(220, (h * 0.6) / sy);
          _sph.center.set(x - sun.x * L * 0.5, y - sun.y * L * 0.5, z - sun.z * L * 0.5);
          _sph.radius = r + L * 0.5;
          vis = _frustum.intersectsSphere(_sph);
          if (vis) {
            const d = Math.hypot(x - cx, y - cy, z - cz);
            if (d > 1500) vis = false;
          }
        }
        if (!vis) continue;
        const d = Math.max(0.1, Math.hypot(x - cx, y - cy, z - cz) - h * 0.25);
        const vi = v.visibleCount++;
        v.visibleIds[vi] = i;
        // Keep this division separate from lodK, exactly as in the original expression.
        v.projected[vi] = (h * focalPx) / d;
      }
    }
  }

  /** Select LODs and count triangles only; no pages, matrices, colors, or GPU uploads yet. */
  _plan(kScale, noHyst) {
    const qn = this.engine.quality.name;
    const lodK = (qn === 'ultra' ? 1.35 : this.detail >= 1 ? 1 : 0.7) * kScale;
    let drawn = 0, tris = 0;
    for (const v of this.variants) {
      if (!v.instanceCount) continue;
      const counts = v.planCounts;
      counts.fill(0);
      const px = v.px;
      for (let vi = 0; vi < v.visibleCount; vi++) {
        const i = v.visibleIds[vi];
        const p = v.projected[vi] * lodK;
        v.selectedLod[vi] = -1;
        if (p < (v.cullPx ?? 0.6)) continue;
        let l = this.forceLod !== undefined ? this.forceLod : p > px[0] ? 0 : p > px[1] ? 1 : p > px[2] ? 2 : 3;
        const prev = v.lastLod[i];
        if (prev >= 0 && prev !== l && this.forceLod === undefined && !noHyst) {
          const th = px[Math.min(prev, l)];
          if (p > th * 0.88 && p < th * 1.12) l = prev;
        }
        // Intentionally update history on EVERY trial, matching the original. A tree that is
        // culled by a later, smaller budget must retain the history written by the earlier trial.
        v.lastLod[i] = l;
        const li = Math.min(l, v.lodMeshes.length - 1);
        if (!v.lodMeshes[li]) throw new Error('Invalid vegetation LOD ' + li);
        v.selectedLod[vi] = li;
        counts[li]++;
      }
      for (let l = 0; l < v.lodMeshes.length; l++) {
        drawn += counts[l];
        tris += counts[l] * (v.lods[l].tris || 0);
      }
    }
    this.stats.drawn = drawn;
    this.stats.tris = tris;
    return this.stats;
  }

  /** Apply the final plan once, preserving original instance order in each LOD bucket. */
  _applyPlan() {
    const windAmp = WIND.uWindAmp.value, windChanged = windAmp !== this.boundsWindAmp;
    let copiedInstances = 0, changedPages = 0;
    for (const v of this.variants) {
      if (!v.instanceCount) continue;
      const counts = v.planCounts;
      const cursor = v.writeCounts;
      cursor.fill(0);
      for (const L of v.lodMeshes) for (const pg of L.pages) { pg.dirtyStart = pg.cap; pg.dirtyEnd = 0; }
      for (let vi = 0; vi < v.visibleCount; vi++) {
        const li = v.selectedLod[vi];
        if (li < 0) continue;
        const i = v.visibleIds[vi], L = v.lodMeshes[li];
        const k = cursor[li]++;
        const pi = Math.floor(k / L.page), slot = k - pi * L.page;
        const pg = L.pages[pi] || this._newPage(v, L);
        // Finalized transforms/colors are immutable. Stable slots need no CPU copies or GPU
        // upload when the camera moves but this page's visible instances and LOD stay the same.
        if (pg.ids[slot] === i) continue;
        copiedInstances++;
        pg.ids[slot] = i;
        pg.dirtyStart = Math.min(pg.dirtyStart, slot);
        pg.dirtyEnd = slot + 1;
        // Direct scalar copies avoid a short-lived subarray view per visible tree per update.
        const source = i * 16, target = slot * 16;
        for (let j = 0; j < 16; j++) pg.im.array[target + j] = v.mat[source + j];
        pg.ic.array[slot * 3] = v.col[i * 3];
        pg.ic.array[slot * 3 + 1] = v.col[i * 3 + 1];
        pg.ic.array[slot * 3 + 2] = v.col[i * 3 + 2];
      }
      for (let l = 0; l < v.lodMeshes.length; l++) {
        const L = v.lodMeshes[l];
        L.count = counts[l];
        for (let pi = 0; pi < L.pages.length; pi++) {
          const pg = L.pages[pi];
          const count = clamp(counts[l] - pi * L.page, 0, L.page);
          for (const m of pg.parts) { m.count = count; m.visible = count > 0; }
          const dirty = pg.dirtyEnd > pg.dirtyStart;
          if (count && (dirty || count !== pg.count || windChanged)) updateVegetationPageBounds(pg, windAmp);
          pg.count = count;
          if (dirty) {
            changedPages++;
            const length = pg.dirtyEnd - pg.dirtyStart;
            markUpload(pg.im, pg.dirtyStart * 16, length * 16);
            markUpload(pg.ic, pg.dirtyStart * 3, length * 3);
          }
        }
      }
    }
    this.boundsWindAmp = windAmp;
    this.stats.copiedInstances = copiedInstances;
    this.stats.changedPages = changedPages;
  }

  lodHistogram() {
    return this.variants.map((v) => `${v.name}:${v.lodMeshes ? v.lodMeshes.map((l) => l.count).join('/') : '-'}`).join(' ');
  }
}
