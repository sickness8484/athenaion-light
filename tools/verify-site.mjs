// Verify the actual published bytes, including lossless decompression, before
// uploading a Pages artifact. This does not claim to measure GPU performance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { moduleEntryFromHTML, sourceScriptDirectory } from './build-site.mjs';
import { verifyCloudAssets } from './cloud-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const entry = moduleEntryFromHTML(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'));
const scriptDirectory = path.posix.dirname(entry.replace(/^\.\//, ''));
const buildInfo = JSON.parse(fs.readFileSync(path.join(DIST, 'build-info.json'), 'utf8'));
if (!/^src-[a-f0-9]{16}$/.test(scriptDirectory) || buildInfo.scriptDirectory !== scriptDirectory ||
    sourceScriptDirectory(path.join(DIST, scriptDirectory)) !== scriptDirectory) throw new Error('Published source files do not match their content-hashed directory');
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'generated', 'manifest.json'), 'utf8'));
if (manifest.formatVersion !== 1 || !manifest.terrain?.preview) throw new Error('Invalid geometry release manifest');
let verified = 0;
for (const [name, entry] of Object.entries(manifest.geometries)) {
  if (entry.file !== `${name}.${entry.sha256.slice(0, 12)}.bin.gz` || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid asset manifest entry: ${name}`);
  const file = path.join(DIST, 'generated', entry.file);
  if (fs.statSync(file).size !== entry.bytes) throw new Error(`Compressed byte count mismatch: ${name}`);
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(fs.createReadStream(file), createGunzip(), new Writable({ write(chunk, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(); } }));
  } catch (cause) { throw new Error(`Invalid compressed geometry: ${name}`, { cause }); }
  if (bytes !== entry.rawBytes || hash.digest('hex') !== entry.sha256) throw new Error(`Lossless round-trip failed: ${name}`);
  verified++;
}
for (const name of Object.values(manifest.terrain)) if (!manifest.geometries[name]) throw new Error(`Terrain is absent from release: ${name}`);
const clouds = await verifyCloudAssets(path.join(DIST, 'assets/cloud-noise'), path.join(DIST, scriptDirectory, 'core/sky.js'));
if (buildInfo.cloudShaderHash !== clouds.manifest.sourceHash || buildInfo.rawCloudTextureBytes !== clouds.rawBytes || buildInfo.compressedCloudTextureBytes !== clouds.compressedBytes) throw new Error('Cloud release report does not match published assets');
for (const file of ['index.html', 'LICENSE', '.nojekyll', entry, 'vendor/three/build/three.module.js', 'vendor/three/build/three.core.js', 'vendor/three/examples/jsm/controls/OrbitControls.js']) if (!fs.statSync(path.join(DIST, file)).isFile()) throw new Error(`Missing static asset: ${file}`);
console.log(`[verify] ${verified} geometry assets and 2 cloud volumes passed gzip + SHA-256 round-trip verification; required Pages assets and ${scriptDirectory} are present.`);
