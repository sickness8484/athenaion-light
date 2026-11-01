// Each job runs in an isolated Node process so completed sculpt geometry and
// temporary SDF grids are reclaimed before the next job. The geometry itself
// remains the upstream generator's full detail=1 output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ROOT, GENERATED, bakePlan } from './bake-plan.mjs';
import { writeGeometry } from './geometry-io.mjs';
import { bakeRegistry, deserializeGeometry } from '../src/core/cache.js';

const id = process.argv[2];
const plan = await bakePlan(['preview', 'high']);
const job = plan.jobs.find((entry) => entry.id === id);
if (!job) throw new Error(`Unknown bake job: ${id}`);
fs.mkdirSync(GENERATED, { recursive: true });
const started = performance.now();
const save = (name, geometry) => {
  const stats = writeGeometry(path.join(GENERATED, `${name}.bin`), geometry);
  console.log(`[bake] ${name}: ${(stats.bytes / 1e6).toFixed(2)} MB; ${geometry.attributes.position?.count || 0} vertices`);
  geometry.dispose();
  bakeRegistry.delete(name);
};

async function terrain(quality, name) {
  const { farFromGeometry } = await import('../src/terrain/far.js');
  const { setFarGrid } = await import('../src/world/heightfield.js');
  const { planChunks } = await import('../src/terrain/lod.js');
  const { SHOTS } = await import('../src/world/shots.js');
  const { groupResults, packGroups } = await import('../src/terrain/meshpack.js');
  const { packedToGeometry, PLAN_OPTS } = await import('../src/terrain/meshgeo.js');
  const buffer = fs.readFileSync(path.join(GENERATED, `${plan.far}.bin`));
  const far = farFromGeometry(deserializeGeometry(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)));
  setFarGrid(far);
  const leaves = planChunks(SHOTS, PLAN_OPTS(quality));
  const results = new Array(leaves.length);
  const requested = Number(process.env.ATHENAION_BAKE_WORKERS || 2);
  const count = Math.max(1, Math.min(8, os.availableParallelism?.() || os.cpus().length, Number.isFinite(requested) ? requested : 2, leaves.length || 1));
  const workers = Array.from({ length: count }, () => new Worker(new URL('../src/terrain/nodeworker.mjs', import.meta.url), { workerData: { far } }));
  const order = leaves.map((_, index) => index).sort((a, b) => leaves[a].cell - leaves[b].cell);
  let cursor = 0, completed = 0;
  console.log(`[bake] terrain ${quality}: ${leaves.length} chunks, ${count} workers`);
  try {
    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      let timeout;
      const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      worker.on('error', finish);
      worker.on('exit', (code) => { if (code !== 0 && cursor <= order.length) finish(new Error(`Terrain worker exited with ${code}`)); });
      const feed = () => {
        if (cursor >= order.length) { finish(); return; }
        const index = order[cursor++];
        const leaf = leaves[index];
        timeout = setTimeout(() => finish(new Error(`Terrain chunk ${index} timed out`)), 10 * 60 * 1000);
        worker.once('message', (message) => {
          clearTimeout(timeout);
          if (message.error) { finish(new Error(message.error)); return; }
          results[index] = message.r;
          completed++;
          if (completed % 50 === 0 || completed === leaves.length) console.log(`[bake] terrain ${quality}: ${completed}/${leaves.length}`);
          feed();
        });
        worker.postMessage({ id: index, job: { x0: leaf.x0, z0: leaf.z0, n: leaf.n, cell: leaf.cell, ext: 1 } });
      };
      feed();
    })));
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  const packed = packGroups(groupResults(leaves, results));
  results.length = 0;
  save(name, packedToGeometry(packed));
}

if (job.type === 'terrain') {
  await terrain(job.value, job.names[0]);
} else if (job.type === 'colossus') {
  const { colossusGeometries } = await import('../src/sculpt/library.js');
  await colossusGeometries(job.value, 1);
  for (const name of job.names) save(name, bakeRegistry.get(name));
} else if (job.type === 'emblem') {
  const { emblemTextureCached } = await import('../src/sculpt/props.js');
  await emblemTextureCached(job.value, 1024, 1);
  save(job.names[0], bakeRegistry.get(job.names[0]));
} else if (job.type === 'statue') {
  const { buildStatueGeometry } = await import('../src/sculpt/statuary.js');
  for (let lod = 0; lod < 3; lod++) save(job.names[lod], buildStatueGeometry(job.value, lod, 1));
} else if (job.type === 'ruin') {
  const { ruinsJobs } = await import('../src/ruins/jobs.js');
  const source = ruinsJobs().find((entry) => entry.name === job.value);
  save(job.names[0], await source.build(1));
}
console.log(`[bake] job ${job.id} completed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
