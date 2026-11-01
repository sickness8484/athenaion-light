// Shared by the offline baker and the release verifier. These are the original
// mesh generators and detail=1 names, not a reduced-quality substitute.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FAR_NAME } from '../src/terrain/far.js';
import { PLAN_OPTS } from '../src/terrain/meshgeo.js';
import { meshInputsHash, meshBakeName } from '../src/terrain/meshpack.js';
import { LIB_VERSION, SHIELD_VERSION, SHIELD_STYLE } from '../src/sculpt/library.js';
import { STATUARY_VERSION } from '../src/sculpt/statuary-lib.js';
import { STATUE_TYPES, PED_TYPES } from '../src/sculpt/statuary.js';
import { ruinsJobs } from '../src/ruins/jobs.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED = path.join(ROOT, 'generated');

function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(file) : [file];
  });
}

export function bakeSourceHash() {
  const hash = createHash('sha256');
  const roots = ['src/terrain', 'src/sculpt', 'src/ruins', 'src/world'];
  // World orchestration reports progress and assembles modules in the browser;
  // offline geometry never imports it. Its UI/error handling is not a bake input.
  const files = roots.flatMap((root) => allFiles(path.join(ROOT, root))).filter((file) => /\.(?:js|mjs)$/.test(file) && file !== path.join(ROOT, 'src/world/index.js'));
  for (const relative of ['src/core/cache.js', 'src/core/noise.js', 'src/core/rng.js', 'tools/geometry-io.mjs', 'tools/bake-plan.mjs', 'tools/bake-site-worker.mjs', 'tools/bake-site.mjs', 'package-lock.json', `generated/${FAR_NAME}.bin`]) files.push(path.join(ROOT, relative));
  for (const file of [...new Set(files)].sort()) {
    hash.update(path.relative(ROOT, file)); hash.update('\0');
    hash.update(fs.readFileSync(file)); hash.update('\0');
  }
  return hash.digest('hex');
}

export async function bakePlan(qualities = ['preview']) {
  const jobs = [];
  const terrain = {};
  const readText = async (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const quality of qualities) {
    if (!['preview', 'high'].includes(quality)) throw new Error(`Unknown terrain quality: ${quality}`);
    const name = meshBakeName(quality, await meshInputsHash(readText, quality, PLAN_OPTS(quality)));
    terrain[quality] = name;
    jobs.push({ id: `terrain:${quality}`, type: 'terrain', value: quality, names: [name] });
  }
  for (const variant of ['A', 'B', 'C']) {
    jobs.push({ id: `colossus:${variant}`, type: 'colossus', value: variant, names: [`statue-ath${variant}-v${LIB_VERSION}`, `statue-shield${variant}-v${SHIELD_VERSION}`] });
  }
  for (const style of new Set(Object.values(SHIELD_STYLE))) {
    jobs.push({ id: `emblem:${style}`, type: 'emblem', value: style, names: [`statue-emblem-${style}-1024-s1-v4`] });
  }
  for (const type of [...STATUE_TYPES, ...PED_TYPES]) {
    jobs.push({ id: `statue:${type.id}`, type: 'statue', value: type.id, names: [0, 1, 2].map((lod) => `statue-type-${type.id}-l${lod}-v${STATUARY_VERSION}`) });
  }
  for (const job of ruinsJobs()) jobs.push({ id: `ruin:${job.name}`, type: 'ruin', value: job.name, names: [job.name] });
  return { jobs, terrain, far: FAR_NAME, names: [FAR_NAME, ...jobs.flatMap((job) => job.names)] };
}
