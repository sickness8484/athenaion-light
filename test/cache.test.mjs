import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const THREE = await import('three');
const cacheURL = new URL('../src/core/cache.js', import.meta.url).href;
const generatedPath = new URL('../generated/', import.meta.url).pathname;
const originalFetch = globalThis.fetch;
const originalDecompress = globalThis.DecompressionStream;
let sequence = 0;
const fresh = () => import(cacheURL + '?check=' + (++sequence));
const nodeCache = await fresh();
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2.25, 0, 0, 0, 1.5, 0], 3));
geometry.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), 3, true));
geometry.setAttribute('aTer', new THREE.BufferAttribute(new Uint8Array([0, 128, 255, 7, 55, 20, 120, 3, 9, 13, 42, 6]), 4, true));
geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
const bytes = nodeCache.serializeGeometry(geometry);
const decoded = nodeCache.deserializeGeometry(bytes);
for (const [name, attribute] of Object.entries(geometry.attributes)) {
  const result = decoded.attributes[name];
  assert.equal(result.array.constructor, attribute.array.constructor);
  assert.equal(result.normalized, attribute.normalized);
  assert.equal(result.itemSize, attribute.itemSize);
  assert.deepEqual(result.array, attribute.array);
  assert.equal(result.array.buffer, bytes, 'Every attribute must view the original download');
}
assert.deepEqual(decoded.index.array, geometry.index.array);
assert.equal(decoded.index.array.buffer, bytes);
assert.deepEqual(decoded.boundingBox.min.toArray(), [0, 0, 0]);
assert.deepEqual(decoded.boundingBox.max.toArray(), [2.25, 1.5, 0]);
assert.equal(nodeCache.deserializeGeometry(bytes, { computeBounds: false }).boundingBox, null);
assert.throws(() => nodeCache.deserializeGeometry(new ArrayBuffer(2)), /bad geometry/);
assert.throws(() => nodeCache.deserializeGeometry(bytes.slice(0, bytes.byteLength - 1)), /truncated/);
assert.deepEqual(new Uint8Array(nodeCache.serializeGeometry(decoded)), new Uint8Array(bytes));
console.log('PASS exact binary round-trip, normalized attributes, zero-copy ownership, bounds, truncation');

globalThis.window = {};
const name = 'test-geometry-v1';
const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const file = name + '.' + sha256.slice(0, 12) + '.bin.gz';
const compressed = gzipSync(new Uint8Array(bytes));
const manifest = { formatVersion: 1, geometries: { [name]: { file, encoding: 'gzip', rawBytes: bytes.byteLength, bytes: compressed.byteLength, sha256 } }, terrain: {} };
const calls = [];
let fallbackCount = 0;
function mockFetch({ declaration = manifest, asset = compressed, assetStatus = 200, rawStatus = 404 } = {}) {
  globalThis.fetch = async (url) => {
    const href = String(url); calls.push(href);
    if (href.endsWith('/manifest.json')) return declaration ? new Response(JSON.stringify(declaration)) : new Response('', { status: 404 });
    if (href.endsWith('.bin.gz')) return new Response(asset, { status: assetStatus });
    return new Response(rawStatus === 200 ? bytes : '', { status: rawStatus });
  };
}
mockFetch();
const browserCache = await fresh();
const fallback = () => { fallbackCount++; return geometry.clone(); };
const shared = await Promise.all(Array.from({ length: 4 }, () => browserCache.loadOrBuild(name, fallback)));
assert(shared.every(g => g === shared[0]));
assert.equal(fallbackCount, 0);
assert.equal(calls.filter(x => x.endsWith('/manifest.json')).length, 1);
assert.equal(calls.filter(x => x.endsWith('.bin.gz')).length, 1);
assert(calls.every(x => new URL(x).pathname.startsWith(generatedPath)), 'Project subpath must be retained');
assert.deepEqual(shared[0].attributes.position.array, geometry.attributes.position.array);
const owned = await browserCache.loadOrBuild(name, fallback, { clone: true });
assert.notEqual(owned, shared[0]);
assert.notEqual(owned.attributes.position.array.buffer, shared[0].attributes.position.array.buffer);
owned.attributes.position.array[0] = 99;
assert.equal(shared[0].attributes.position.array[0], 0);
owned.dispose();
assert.equal(await browserCache.loadOrBuild(name, fallback), shared[0]);
shared[0].dispose();
assert.notEqual(await browserCache.loadOrBuild(name, fallback), shared[0]);
assert.equal(calls.filter(x => x.endsWith('.bin.gz')).length, 2);
console.log('PASS gzip stream, subpath URLs, in-flight deduplication, clone isolation, disposal eviction');

for (const scenario of ['http', 'gzip', 'length', 'filename', 'unsupported', 'bad-header']) {
  const copy = structuredClone(manifest);
  let asset = compressed, status = 200;
  if (scenario === 'http') status = 503;
  if (scenario === 'gzip') asset = new Uint8Array([1, 2, 3]);
  if (scenario === 'length') copy.geometries[name].rawBytes++;
  if (scenario === 'filename') copy.geometries[name].file = '../outside.bin.gz';
  if (scenario === 'unsupported') globalThis.DecompressionStream = undefined;
  if (scenario === 'bad-header') { const corrupt = bytes.slice(0); new Uint8Array(corrupt)[0] = 0; asset = gzipSync(new Uint8Array(corrupt)); }
  mockFetch({ declaration: copy, asset, assetStatus: status });
  const module = await fresh();
  await assert.rejects(module.loadOrBuild(name, fallback), e => e.code === 'BAKED_ASSET_UNAVAILABLE', scenario);
  globalThis.DecompressionStream = originalDecompress;
}
assert.equal(fallbackCount, 0, 'A declared failed bake must never start heavy procedural CPU generation');
mockFetch({ declaration: null, rawStatus: 200 });
assert.deepEqual((await (await fresh()).loadOrBuild(name, fallback)).index.array, geometry.index.array);
mockFetch({ declaration: null });
const rawFallback = await fresh();
await Promise.all([rawFallback.loadOrBuild(name, fallback), rawFallback.loadOrBuild(name, fallback)]);
assert.equal(fallbackCount, 1);
let attempts = 0;
const recovery = await fresh();
const builder = () => { if (++attempts === 1) throw new Error('generation failed'); return geometry.clone(); };
await assert.rejects(recovery.loadOrBuild(name, builder), /generation failed/);
assert((await recovery.loadOrBuild(name, builder)).isBufferGeometry);
assert.equal(attempts, 2);
console.log('PASS declared-asset failures, unsupported decoder, development fallback, failed-promise recovery');

globalThis.fetch = originalFetch;
globalThis.DecompressionStream = originalDecompress;
delete globalThis.window;
