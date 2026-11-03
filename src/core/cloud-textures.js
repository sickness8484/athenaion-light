import * as THREE from 'three';
import { assetURL, readGeometryStream } from './cache.js';

const SIZES = Object.freeze({ shape: 128, detail: 64 });
const DIRECTORY = 'assets/cloud-noise/';

function cloudError(cause) {
  const error = new Error(`Unable to load cloud textures: ${cause?.message || cause}`);
  error.code = 'BAKED_ASSET_UNAVAILABLE';
  error.cause = cause;
  return error;
}

export function validateCloudTextureManifest(manifest) {
  if (manifest?.formatVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sourceHash || '')) {
    throw new Error('Invalid cloud texture manifest');
  }
  for (const [name, size] of Object.entries(SIZES)) {
    const entry = manifest.textures?.[name];
    if (!entry || entry.size !== size || entry.rawBytes !== size ** 3 * 4 ||
        entry.encoding !== 'gzip' || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
        entry.file !== `${name}-${size}.${entry.sha256.slice(0, 12)}.rgba8.gz`) {
      throw new Error(`Invalid ${name} cloud texture entry`);
    }
  }
  return manifest;
}

/** Load the exact authored RGBA8 volumes; never run their noise shader on a visitor's GPU. */
export async function loadBakedCloudTextures({ fetcher = fetch, onProgress } = {}) {
  const result = {};
  try {
    const response = await fetcher(assetURL(DIRECTORY + 'manifest.json'), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Cloud texture manifest: HTTP ${response.status}`);
    const manifest = validateCloudTextureManifest(await response.json());
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support gzip cloud textures');
    for (const [name, size] of Object.entries(SIZES)) {
      const entry = manifest.textures[name];
      onProgress?.({ name, phase: 'loading' });
      const response = await fetcher(assetURL(DIRECTORY + entry.file));
      if (!response.ok) throw new Error(`Cloud texture ${name}: HTTP ${response.status}`);
      if (!response.body) throw new Error(`Cloud texture ${name}: empty response`);
      const raw = await readGeometryStream(response.body.pipeThrough(new DecompressionStream('gzip')), entry.rawBytes);
      const texture = new THREE.Data3DTexture(new Uint8Array(raw), size, size, size);
      texture.name = `cloud-${name}`;
      texture.type = THREE.UnsignedByteType;
      texture.format = THREE.RGBAFormat;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      result[name] = texture;
      onProgress?.({ name, phase: 'ready' });
    }
    return result;
  } catch (error) {
    for (const texture of Object.values(result)) texture.dispose();
    throw cloudError(error);
  }
}
