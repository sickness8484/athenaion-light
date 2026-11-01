// Full-detail, resumable build-time baking. No GPU or browser is required.
// Default: original preview terrain plus full-quality sculptures and ruins.
// --quality high also produces the original high-resolution terrain.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, GENERATED, bakePlan, bakeSourceHash } from './bake-plan.mjs';
import { fileDigest, readGeometryHeader, writeJsonAtomic } from './geometry-io.mjs';

const args = process.argv.slice(2);
const high = args.includes('--quality') && args[args.indexOf('--quality') + 1] === 'high';
const listOnly = args.includes('--list');
if (args.includes('--quality') && !['preview', 'high'].includes(args[args.indexOf('--quality') + 1])) throw new Error('--quality must be preview or high');
if (process.env.STATUES_DETAIL && Number(process.env.STATUES_DETAIL) !== 1) throw new Error('Release baking requires STATUES_DETAIL=1; reduced-detail cache names are not safe.');
const sourceHash = bakeSourceHash();
const plan = await bakePlan(high ? ['preview', 'high'] : ['preview']);
if (listOnly) { console.log(JSON.stringify({ sourceHash, ...plan }, null, 2)); process.exit(0); }
fs.mkdirSync(GENERATED, { recursive: true });
const farFile = path.join(GENERATED, `${plan.far}.bin`);
if (!fs.existsSync(farFile)) throw new Error(`Missing original ${plan.far}.bin. Restore the tracked far-field grid; do not replace it with approximate mountains.`);
const progressPath = path.join(GENERATED, '.bake-progress.json');
const outputPath = path.join(GENERATED, '.bake-manifest.json');
let previous;
try { previous = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch {}
const progress = previous?.sourceHash === sourceHash ? previous : { formatVersion: 1, sourceHash, jobs: {} };
const started = Date.now();
const children = new Set();
const record = () => writeJsonAtomic(progressPath, progress);
const onSignal = () => { for (const child of children) child.kill('SIGTERM'); process.exitCode = 130; };
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

async function validateExisting(job) {
  const saved = progress.jobs[job.id];
  if (!saved) return false;
  try {
    for (const name of job.names) {
      const file = path.join(GENERATED, `${name}.bin`);
      const expected = saved.files?.[name];
      if (!expected || !fs.existsSync(file) || fs.statSync(file).size !== expected.bytes) return false;
      readGeometryHeader(file);
      if ((await fileDigest(file)).sha256 !== expected.sha256) return false;
    }
  } catch { return false; }
  return true;
}

async function run(job) {
  if (await validateExisting(job)) { console.log(`[bake] ${job.id}: verified cache`); return; }
  const begin = Date.now();
  console.log(`[bake] starting ${job.id}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(ROOT, 'tools/bake-site-worker.mjs'), job.id], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, STATUES_DETAIL: '1' } });
    children.add(child);
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Bake job ${job.id} exceeded 90 minutes`)); }, 90 * 60 * 1000);
    child.on('error', (error) => { clearTimeout(timeout); children.delete(child); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); children.delete(child); code === 0 ? resolve() : reject(new Error(`Bake job ${job.id} failed (${signal || code})`)); });
  });
  const files = {};
  for (const name of job.names) { const file = path.join(GENERATED, `${name}.bin`); readGeometryHeader(file); files[name] = await fileDigest(file); }
  progress.jobs[job.id] = { milliseconds: Date.now() - begin, files };
  record();
}

try {
  // Terrain itself uses a bounded worker pool and has the largest transient RAM.
  for (const job of plan.jobs.filter((entry) => entry.type === 'terrain')) await run(job);
  const rest = plan.jobs.filter((entry) => entry.type !== 'terrain');
  const parallel = Math.max(1, Math.min(4, Math.floor(Number(process.env.ATHENAION_BAKE_JOBS) || 2)));
  let cursor = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (cursor < rest.length) await run(rest[cursor++]);
  }));
  if (bakeSourceHash() !== sourceHash) throw new Error('Bake inputs changed during generation. Rerun baking against the final source state.');
  const geometries = { [plan.far]: await fileDigest(farFile) };
  for (const job of plan.jobs) Object.assign(geometries, progress.jobs[job.id].files);
  const manifest = { formatVersion: 1, sourceHash, detail: 1, terrain: plan.terrain, geometries, jobs: progress.jobs, elapsedMs: Date.now() - started };
  writeJsonAtomic(outputPath, manifest);
  const bytes = Object.values(geometries).reduce((total, item) => total + item.bytes, 0);
  console.log(`[bake] ready: ${Object.keys(geometries).length} full-detail assets, ${(bytes / 1e6).toFixed(1)} MB raw, ${((Date.now() - started) / 1000).toFixed(1)} s this run`);
} catch (error) {
  for (const child of children) child.kill('SIGTERM');
  throw error;
}
