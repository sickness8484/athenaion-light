// Terrain module: the ground of the whole world.
//  - near + far terrain as LOD chunks meshed by narrow-band surface nets (src/terrain/voxel.js):
//    real 3D limestone cliffs (karst columns, strata beds, ledges, overhangs) on steep faces,
//    exact heightAt() on flat ground; cell size per region driven by the shot cameras.
//  - eroded far field (mountains) baked to generated/terrain-far-*.bin, else analytic.
//  - one world-space procedural ground material (src/terrain/material.js).
import * as THREE from 'three';
import { planChunks } from '../terrain/lod.js';
import { MESH_SOURCES, meshInputsHash, meshBakeName, groupResults, packGroups, unpackGroups } from '../terrain/meshpack.js';
import { PLAN_OPTS, geometryToPacked, groupGeometry } from '../terrain/meshgeo.js';
import { assetURL, deserializeGeometry, loadGeneratedBinary, loadGeneratedManifest } from '../core/cache.js';
import { MeshPool, terrainWorkerCount } from '../terrain/pool.js';
import { terrainMaterial, setFarTexture } from '../terrain/material.js';
import { loadFarGrid, farTexture } from '../terrain/far.js';
import { scatterBoulders } from '../terrain/boulders.js';
import { SHOTS } from '../world/shots.js';
import * as L from '../world/layout.js';
import { WEST_CRAG, HILLTOPS, MOUNT_NOTCH } from '../world/heightfield.js';

export async function buildTerrain(engine, { shots = SHOTS } = {}) {
  const t0 = performance.now();
  const q = engine.quality;
  const qname = q.terrainRes >= 1 ? 'high' : 'preview';
  const planOpts = PLAN_OPTS(qname);
  // eroded far field (mountains): registered for heightAt() and uploaded as a texture for shading
  let far = null;
  try {
    far = await loadFarGrid();
    setFarTexture(farTexture(far), far);
  } catch (e) {
    if (e.code === 'BAKED_ASSET_UNAVAILABLE') throw e;
    console.warn('[terrain] far grid unavailable, analytic mountains', e);
  }
  const tf = performance.now();
  // meshed terrain: baked (hash of all inputs) or meshed now in workers
  let packed = null, src = 'bake';
  let name = '', published = false;
  try {
    const manifest = await loadGeneratedManifest();
    published = !!manifest;
    if (manifest) {
      name = manifest.terrain?.[qname];
      if (typeof name !== 'string' || !name.startsWith(`terrain-mesh-${qname}-`)) throw new Error(`Missing ${qname} terrain bake in manifest`);
    } else {
      // Development checkouts still hash the exact generator inputs, but fetch independent source
      // files together and keep the project subpath. Published builds need none of these requests.
      const inputs = new Map(await Promise.all(MESH_SOURCES.map(async (p) => {
        const response = await fetch(assetURL(p));
        if (!response.ok) throw new Error(`${p}: HTTP ${response.status}`);
        return [p, await response.text()];
      })));
      name = meshBakeName(qname, await meshInputsHash((p) => inputs.get(p), qname, planOpts));
    }
    packed = geometryToPacked(deserializeGeometry(await loadGeneratedBinary(name), { computeBounds: false }));
  } catch (e) {
    if (published || e.code === 'BAKED_ASSET_UNAVAILABLE') {
      e.code = 'BAKED_ASSET_UNAVAILABLE';
      throw e;
    }
    // An unbaked development checkout can still build its original geometry in workers.
  }
  let nChunks = 0;
  if (!packed) {
    src = 'runtime';
    console.log(`[terrain] mesh bake ${name || '?'} not found — meshing at runtime (bake: node tools/bake.mjs terrain)`);
    const leaves = planChunks(shots, planOpts);
    nChunks = leaves.length;
    const pool = new MeshPool(terrainWorkerCount(far?.data?.byteLength || 0));
    const results = new Array(leaves.length);
    try {
      if (far) await pool.setFar(far);
      const order = leaves.map((l, i) => i).sort((a, b) => leaves[a].cell - leaves[b].cell);
      await Promise.all(order.map((i) => {
        const l = leaves[i];
        return pool.run({ x0: l.x0, z0: l.z0, n: l.n, cell: l.cell, ext: 1 }).then((r) => { results[i] = r; });
      }));
    } finally { pool.dispose(); }
    packed = packGroups(groupResults(leaves, results));
  }
  const t2 = performance.now();
  const groups = unpackGroups(packed);
  const mat = terrainMaterial();
  const root = new THREE.Group();
  root.name = 'terrain';
  let tris = 0;
  for (const g of groups) {
    const geo = groupGeometry(g);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain:' + g.key;
    const near = g.cell <= 8;
    mesh.castShadow = near; mesh.receiveShadow = true;
    mesh.userData.castShadow = near; mesh.userData.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    tris += geo.index.count / 3;
  }
  engine.add(root);
  engine.registry.terrain = {
    root, material: mat, groups: groups.length,
    // terrain sites other modules can build on
    sites: {
      templeMount: { center: L.HILL_TEMPLE.center, top: L.HILL_TEMPLE.top, summitRadius: 48, notch: MOUNT_NOTCH },
      westCrag: { center: WEST_CRAG.center, top: WEST_CRAG.top },
      hilltops: HILLTOPS.map((t) => ({ center: t.c, top: t.top, radius: t.rf })),
    },
  };
  const t3 = performance.now();
  try { scatterBoulders(engine); } catch (e) { console.error('[terrain] boulders failed', e); }
  const ms = Math.round(performance.now() - t0);
  console.log(`[terrain] ${src} mesh (${qname}${nChunks ? ', ' + nChunks + ' chunks' : ''}) → ${groups.length} meshes, ${(tris / 1e6).toFixed(2)} M tris; far ${Math.round(tf - t0)} ms, mesh ${Math.round(t2 - tf)} ms, boulders ${Math.round(performance.now() - t3)} ms, total ${ms} ms`);
  return root;
}

export async function build(engine) {
  await buildTerrain(engine);
}

export async function test(engine) {
  const tg = engine.scene.getObjectByName('testGround');
  if (tg) tg.visible = false;
  await buildTerrain(engine);
  const sun = { azimuth: L.SUN.azimuth, elevation: L.SUN.elevation };
  const S = (id) => SHOTS.find((s) => s.id === id);
  const v = (s) => ({ pos: s.pos, target: s.target, fov: s.fov, sun: s.sun || sun, near: s.near ?? 0.5, far: 60000 });
  return {
    views: [
      v(S(3)),
      v(S(1)),
      v(S(7)),
      // mountain close-up: from the north foothills toward the main massif
      { pos: [600, 900, -2600], target: [2600, 1900, -6200], fov: 40, sun, near: 1, far: 60000 },
      // cliff close-up: west face of the acropolis from the canyon floor
      { pos: [-215, 6, -40], target: [-118, 60, -70], fov: 50, sun, near: 0.3, far: 60000 },
      // ground close-up on the ruins terrace (shot 8 camera)
      v(S(8)),
      // aerial overview
      v(S(4)),
    ],
  };
}
