import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { loadBakedCloudTextures, validateCloudTextureManifest } from '../src/core/cloud-textures.js';
import { prepareCloudTextures, ensureCloudTextures, SKY } from '../src/core/sky.js';

function fixture() {
  const manifest = { formatVersion: 1, sourceHash: 'c'.repeat(64), textures: {} };
  const files = new Map(), requests = [];
  for (const [name, size] of [['shape', 128], ['detail', 64]]) {
    const raw = Uint8Array.from({ length: size ** 3 * 4 }, (_, i) => (i * 31 + (i >>> 11)) & 255);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const file = `${name}-${size}.${sha256.slice(0, 12)}.rgba8.gz`;
    const compressed = gzipSync(raw);
    manifest.textures[name] = { size, rawBytes: raw.byteLength, bytes: compressed.length, sha256, file, encoding: 'gzip' };
    files.set(file, compressed);
  }
  const fetcher = async (url, options) => {
    assert(url.pathname.includes('/assets/cloud-noise/'));
    const name = url.pathname.split('/').at(-1);
    requests.push({ name, options });
    if (name === 'manifest.json') return Response.json(manifest);
    return files.has(name) ? new Response(files.get(name)) : new Response('not found', { status: 404 });
  };
  return { manifest, files, requests, fetcher };
}

function preserveClouds() {
  const uniforms = [SKY.uCloudReady, SKY.tCloudShape, SKY.tCloudDetail];
  const values = uniforms.map(uniform => uniform.value);
  SKY.uCloudReady.value = 0;
  SKY.tCloudShape.value = SKY.tCloudDetail.value = null;
  return () => uniforms.forEach((uniform, i) => { uniform.value = values[i]; });
}

test('cloud loader preserves every baked byte, dimensions, axis order and original sampling settings', async () => {
  const { manifest, fetcher, requests } = fixture();
  const progress = [];
  const textures = await loadBakedCloudTextures({ fetcher, onProgress: entry => progress.push(entry) });
  try {
    for (const [name, size] of [['shape', 128], ['detail', 64]]) {
      const texture = textures[name];
      assert(texture.isData3DTexture);
      assert.equal(createHash('sha256').update(texture.image.data).digest('hex'), manifest.textures[name].sha256);
      assert.deepEqual([texture.image.width, texture.image.height, texture.image.depth], [size, size, size]);
      assert.equal(texture.format, THREE.RGBAFormat);
      assert.equal(texture.type, THREE.UnsignedByteType);
      assert.equal(texture.colorSpace, THREE.NoColorSpace);
      assert.equal(texture.flipY, false);
      assert.equal(texture.unpackAlignment, 1);
      assert.deepEqual([texture.wrapS, texture.wrapT, texture.wrapR], Array(3).fill(THREE.RepeatWrapping));
      assert.deepEqual([texture.minFilter, texture.magFilter], Array(2).fill(THREE.LinearFilter));
      assert.equal(texture.generateMipmaps, false);
      assert.equal(texture.version, 1);
    }
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0].options, { cache: 'no-cache' });
    assert.deepEqual(progress, [
      { name: 'shape', phase: 'loading' }, { name: 'shape', phase: 'ready' },
      { name: 'detail', phase: 'loading' }, { name: 'detail', phase: 'ready' },
    ]);
  } finally { Object.values(textures).forEach(texture => texture.dispose()); }
});

test('invalid cloud dimensions, lengths or filenames fail before allocating or fetching volumes', async () => {
  const { manifest, fetcher, requests } = fixture();
  for (const patch of [{ size: 1024 }, { rawBytes: 2 ** 31 }, { file: '../../elsewhere' }, { encoding: 'raw' }]) {
    const invalid = structuredClone(manifest);
    Object.assign(invalid.textures.shape, patch);
    assert.throws(() => validateCloudTextureManifest(invalid), /Invalid shape cloud texture entry/);
  }
  manifest.textures.shape.rawBytes++;
  await assert.rejects(loadBakedCloudTextures({ fetcher }), { code: 'BAKED_ASSET_UNAVAILABLE' });
  assert.equal(requests.length, 1);
});

test('a partial cloud load is disposed, never marked ready, and never falls back to GPU generation', async () => {
  const { manifest, files, fetcher } = fixture();
  files.delete(manifest.textures.detail.file);
  const restore = preserveClouds();
  const originalDispose = THREE.Texture.prototype.dispose;
  let disposals = 0;
  THREE.Texture.prototype.dispose = function () {
    if (this.isData3DTexture) disposals++;
    return originalDispose.call(this);
  };
  try {
    await assert.rejects(prepareCloudTextures({ fetcher }), { code: 'BAKED_ASSET_UNAVAILABLE' });
    assert.equal(disposals, 1);
    assert.equal(SKY.uCloudReady.value, 0);
    assert.equal(SKY.tCloudShape.value, null);
    assert.equal(SKY.tCloudDetail.value, null);
    assert.throws(() => ensureCloudTextures({ render() { assert.fail('must not generate on GPU'); } }), /must be prepared/);
  } finally {
    THREE.Texture.prototype.dispose = originalDispose;
    restore();
  }
});

test('cloud preparation retries after failure, deduplicates concurrent loads and does no GPU work', async () => {
  const { fetcher, requests } = fixture();
  const restore = preserveClouds();
  try {
    await assert.rejects(prepareCloudTextures({ fetcher: async () => new Response('unavailable', { status: 503 }) }), { code: 'BAKED_ASSET_UNAVAILABLE' });
    await Promise.all([prepareCloudTextures({ fetcher }), prepareCloudTextures({ fetcher })]);
    assert.equal(requests.length, 3);
    assert.equal(SKY.uCloudReady.value, 1);
    ensureCloudTextures({ render() { assert.fail('must not generate on GPU'); } });
    await prepareCloudTextures({ fetcher: () => assert.fail('ready volumes must be reused') });
  } finally {
    SKY.tCloudShape.value?.dispose();
    SKY.tCloudDetail.value?.dispose();
    restore();
  }
});

test('a truncated decoded cloud volume rejects without returning a partially filled texture', async () => {
  const { manifest, files, fetcher } = fixture();
  files.set(manifest.textures.shape.file, gzipSync(new Uint8Array(32)));
  await assert.rejects(loadBakedCloudTextures({ fetcher }), error => {
    assert.equal(error.code, 'BAKED_ASSET_UNAVAILABLE');
    assert.match(error.message, /truncated/);
    return true;
  });
});
