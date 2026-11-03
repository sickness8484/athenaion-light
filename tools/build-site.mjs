// Package a self-contained GitHub Pages site. Geometry compression is lossless;
// all geometry coordinates, normals and baked shading remain byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { verifyCloudAssets } from './cloud-assets.mjs';

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Pages artifacts must not contain symlinks: ${file}`);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

/** Version the whole module graph together, keeping its original directory depth. */
export function sourceScriptDirectory(directory) {
  const hash = createHash('sha256');
  const names = filesBelow(directory).map(file => path.relative(directory, file).split(path.sep).join('/')).sort();
  for (const name of names) {
    const content = fs.readFileSync(path.join(directory, name));
    hash.update(`${Buffer.byteLength(name)}:${name}\0${content.length}:`);
    hash.update(content);
  }
  return `src-${hash.digest('hex').slice(0, 16)}`;
}

export function moduleEntryFromHTML(html) {
  const entries = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\btype\s*=\s*(["'])module\1/i.test(match[1])) continue;
    const source = match[1].match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
    if (source) entries.push(source[2]);
  }
  if (entries.length !== 1) throw new Error('Expected one external module entry in index.html');
  return entries[0];
}

export function versionSourceEntry(html, directory) {
  if (!/^src-[a-f0-9]{16}$/.test(directory)) throw new Error(`Invalid source directory: ${directory}`);
  if (moduleEntryFromHTML(html) !== './src/main.js') throw new Error('Source index.html must keep its development entry ./src/main.js');
  return html.replace(/(\bsrc\s*=\s*)(["'])\.\/src\/main\.js\2/g,
    (_match, prefix, quote) => `${prefix}${quote}./${directory}/main.js${quote}`);
}

export async function buildSite() {
  const { ROOT, GENERATED, bakePlan, bakeSourceHash } = await import('./bake-plan.mjs');
  const { fileDigest, writeJsonAtomic, readGeometryHeader } = await import('./geometry-io.mjs');

  const DIST = path.join(ROOT, 'dist');
  const PAGES_LIMIT = 1_000_000_000;
  const bakePath = path.join(GENERATED, '.bake-manifest.json');
  if (!fs.existsSync(bakePath)) throw new Error('Missing bake manifest. Run npm run bake before npm run build.');
  const baked = JSON.parse(fs.readFileSync(bakePath, 'utf8'));
  if (baked.formatVersion !== 1 || baked.sourceHash !== bakeSourceHash() || baked.detail !== 1) throw new Error('Bakes do not match the current full-detail source. Run npm run bake again.');
  if (!baked.terrain?.preview) throw new Error('The original preview terrain is required.');
  const expectedPlan = await bakePlan(Object.keys(baked.terrain));
  if (expectedPlan.names.length !== Object.keys(baked.geometries || {}).length || expectedPlan.names.some((name) => !baked.geometries[name])) throw new Error('The bake manifest does not include every required original-quality asset. Run npm run bake again.');
  for (const [quality, name] of Object.entries(expectedPlan.terrain)) if (baked.terrain[quality] !== name) throw new Error(`Outdated ${quality} terrain name in bake manifest.`);
  if (!fs.existsSync(path.join(ROOT, 'node_modules/three/build/three.module.js'))) throw new Error('Three.js is not installed. Run npm ci.');
  const cloudBake = await verifyCloudAssets(path.join(GENERATED, 'cloud-noise'), path.join(ROOT, 'src/core/sky.js'));

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'generated'), { recursive: true });
  const publishedFiles = new Set();
  const copy = (from, to = from) => {
    const source = path.join(ROOT, from), destination = path.join(DIST, to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, dereference: true });
    for (const file of fs.statSync(source).isDirectory() ? filesBelow(source) : [source]) {
      publishedFiles.add(path.join(to, path.relative(source, file)).split(path.sep).join('/'));
    }
  };
  const scriptDirectory = sourceScriptDirectory(path.join(ROOT, 'src'));
  copy('src', scriptDirectory);
  // Include the imported Three.js modules and their relative dependencies only.
  const threeRoot = path.join(ROOT, 'node_modules/three');
  const threeModules = new Set(['build/three.module.js']);
  for (const file of filesBelow(path.join(ROOT, 'src')).filter((file) => /\.(?:js|mjs)$/.test(file))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/["']three\/addons\/([^"']+)["']/g)) threeModules.add(`examples/jsm/${match[1]}`);
  }
  const dependencyPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
  for (const relative of threeModules) {
    const file = path.resolve(threeRoot, relative);
    if (!file.startsWith(threeRoot + path.sep) || !fs.statSync(file).isFile()) throw new Error(`Invalid Three.js dependency: ${relative}`);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(dependencyPattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) threeModules.add(path.relative(threeRoot, path.resolve(path.dirname(file), specifier)));
      else if (specifier.startsWith('three/addons/')) threeModules.add(`examples/jsm/${specifier.slice('three/addons/'.length)}`);
      else if (specifier !== 'three') throw new Error(`Unsupported Three.js dependency: ${specifier}`);
    }
    copy(path.relative(ROOT, file), path.join('vendor/three', relative));
  }
  copy('node_modules/three/LICENSE', 'vendor/three/LICENSE');
  copy('LICENSE');
  for (const name of ['index.html', 'favicon.svg', 'favicon.ico', 'styles.css', 'assets']) if (fs.existsSync(path.join(ROOT, name))) copy(name);
  for (const file of cloudBake.files) copy(`generated/cloud-noise/${file}`, `assets/cloud-noise/${file}`);
  const indexPath = path.join(DIST, 'index.html');
  fs.writeFileSync(indexPath, versionSourceEntry(fs.readFileSync(indexPath, 'utf8'), scriptDirectory));
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  publishedFiles.add('.nojekyll');

  const geometries = {};
  let rawBytes = 0, compressedBytes = 0;
  for (const [name, expected] of Object.entries(baked.geometries).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid geometry name: ${name}`);
    const source = path.join(GENERATED, `${name}.bin`);
    readGeometryHeader(source);
    const digest = await fileDigest(source);
    if (digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256) throw new Error(`Baked geometry changed after validation: ${name}`);
    const file = `${name}.${digest.sha256.slice(0, 12)}.bin.gz`;
    const destination = path.join(DIST, 'generated', file);
    const temporary = `${destination}.tmp-${process.pid}`;
    let bytes;
    try {
      await pipeline(fs.createReadStream(source), createGzip({ level: 9 }), fs.createWriteStream(temporary));
      bytes = fs.statSync(temporary).size;
      fs.renameSync(temporary, destination);
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    publishedFiles.add(`generated/${file}`);
    geometries[name] = { file, encoding: 'gzip', bytes, rawBytes: digest.bytes, sha256: digest.sha256 };
    rawBytes += digest.bytes; compressedBytes += bytes;
  }
  const manifest = {
    formatVersion: 1,
    build: { sourceHash: baked.sourceHash, quality: 'original-full-detail', terrainQualities: Object.keys(baked.terrain), commit: process.env.GITHUB_SHA || null },
    terrain: baked.terrain,
    geometries,
  };
  writeJsonAtomic(path.join(DIST, 'generated', 'manifest.json'), manifest);
  publishedFiles.add('generated/manifest.json');
  for (const [name, entry] of Object.entries(geometries)) if (fs.statSync(path.join(DIST, 'generated', entry.file)).size !== entry.bytes) throw new Error(`Compressed geometry changed during build: ${name}`);

  // Count only explicitly emitted release files. A development preview/file-sync
  // process may transiently create hidden or *.tmp files alongside this build;
  // those are not part of the release and must not enter its manifest or archive.
  const files = [...publishedFiles].map((file) => path.join(DIST, file));
  const contentBytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
  const index = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  if (!index.includes('./vendor/three/build/three.module.js') || moduleEntryFromHTML(index) !== `./${scriptDirectory}/main.js`) throw new Error('index.html must use relative vendor and versioned source URLs for GitHub Pages project paths.');
  if (/\b(?:src|href)=["']\/(?!\/)/.test(index)) throw new Error('A root-relative HTML asset URL would break GitHub Pages project paths.');
  const report = { files: files.length + 1, siteBytes: contentBytes, geometryFiles: Object.keys(geometries).length, rawGeometryBytes: rawBytes, compressedGeometryBytes: compressedBytes, losslessSavingsPercent: +((1 - compressedBytes / rawBytes) * 100).toFixed(1), cloudTextureFiles: 2, rawCloudTextureBytes: cloudBake.rawBytes, compressedCloudTextureBytes: cloudBake.compressedBytes, cloudShaderHash: cloudBake.manifest.sourceHash, terrainQualities: Object.keys(baked.terrain), sourceHash: baked.sourceHash, scriptDirectory, publishedFiles: [...publishedFiles, 'build-info.json'].sort() };
  const reportPath = path.join(DIST, 'build-info.json');
  // Count the report itself, including the decimal digits of its own byte count.
  for (;;) {
    writeJsonAtomic(reportPath, report);
    const completeBytes = contentBytes + fs.statSync(reportPath).size;
    if (report.siteBytes === completeBytes) break;
    report.siteBytes = completeBytes;
  }
  if (report.siteBytes >= PAGES_LIMIT) throw new Error(`Pages site is ${(report.siteBytes / 1e6).toFixed(1)} MB, exceeding the strict 1 GB limit. No geometry has been silently removed.`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
