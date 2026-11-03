// Release gate for the authored, offline-baked cloud volumes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { validateCloudTextureManifest } from '../src/core/cloud-textures.js';

export function cloudShaderHash(sourceFile) {
  const source = fs.readFileSync(sourceFile, 'utf8');
  const shader = source.match(/(?:export )?const (?:CLOUD_NOISE_FRAGMENT_SHADER|GEN_FRAG) = \/\* glsl \*\/ `([\s\S]*?)`;/)?.[1];
  if (!shader) throw new Error('Authored cloud generator shader not found');
  return createHash('sha256').update(shader).digest('hex');
}

export async function verifyCloudAssets(directory, sourceFile) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Missing cloud bake. Run npm run bake:clouds before npm run build.');
  const manifest = validateCloudTextureManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  if (manifest.sourceHash !== cloudShaderHash(sourceFile)) throw new Error('Cloud volumes do not match the authored shader. Run npm run bake:clouds again.');
  const files = ['manifest.json'];
  let rawBytes = 0, compressedBytes = 0;
  for (const [name, entry] of Object.entries(manifest.textures)) {
    if (!['shape', 'detail'].includes(name)) throw new Error(`Unexpected cloud volume: ${name}`);
    const file = path.join(directory, entry.file);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || fs.statSync(file).size !== entry.bytes) throw new Error(`Cloud compressed byte count mismatch: ${name}`);
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(fs.createReadStream(file), createGunzip(), new Writable({ write(chunk, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(); } }));
    if (bytes !== entry.rawBytes || hash.digest('hex') !== entry.sha256) throw new Error(`Cloud lossless round-trip failed: ${name}`);
    files.push(entry.file);
    rawBytes += bytes;
    compressedBytes += entry.bytes;
  }
  return { manifest, files, rawBytes, compressedBytes };
}
