// Geometry baking cache. Heavy procedural geometry (hi-res statues, sculpted rocks…) can be
// generated once by node and stored in /generated, then loaded instantly at runtime.
//
//   // in a module (works in browser AND node):
//   import { loadOrBuild } from '../core/cache.js';
//   const geo = await loadOrBuild('athena-A-v3', () => buildAthenaGeometry({ cell: 0.04 }));
//
//   // bake from the command line (runs the same build functions in node and writes generated/*.bin):
//   node tools/bake.mjs statues        → imports src/bake/statues.js and runs its bake()
//
// Bump the name/version string whenever the generator changes, otherwise a stale bake is used.
// If the file is missing, loadOrBuild just builds at runtime (slower, still correct).
import * as THREE from 'three';

const isNode = typeof window === 'undefined';
const ROOT_URL = new URL('../../', import.meta.url);
const geometryPromises = new Map();
const binaryPromises = new Map();
let manifestPromise;

/** Asset paths remain inside the project on both / and GitHub Pages /repository/ URLs. */
export const assetURL = (path) => new URL(path, ROOT_URL);

function bakedError(name, cause) {
  const error = new Error(`Unable to load baked geometry ${name}: ${cause?.message || cause}`);
  error.code = 'BAKED_ASSET_UNAVAILABLE';
  error.cause = cause;
  return error;
}

export function serializeGeometry(geo) {
  const attrs = Object.entries(geo.attributes);
  const header = { attrs: [], index: null };
  const chunks = [];
  let offset = 0;
  const push = (arr) => { const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; } const o = offset; chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); offset += arr.byteLength; return o; };
  for (const [name, a] of attrs) {
    header.attrs.push({ name, itemSize: a.itemSize, normalized: a.normalized, type: a.array.constructor.name, count: a.array.length, offset: push(a.array) });
  }
  if (geo.index) header.index = { type: geo.index.array.constructor.name, count: geo.index.array.length, offset: push(geo.index.array) };
  const hjson = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + hjson.length + offset + 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x47454f31); dv.setUint32(4, hjson.length);
  out.set(hjson, 8);
  let base = 8 + hjson.length; base += (4 - (base % 4)) % 4;
  let o = base;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  dv.setUint32(4, hjson.length);
  return out.slice(0, o).buffer;
}

export function deserializeGeometry(buf, { computeBounds = true } = {}) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) throw new Error('bad geometry blob');
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== 0x47454f31) throw new Error('bad geometry blob');
  const hlen = dv.getUint32(4);
  if (hlen > buf.byteLength - 8) throw new Error('truncated geometry header');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  let base = 8 + hlen; base += (4 - (base % 4)) % 4;
  const T = { Float32Array, Uint32Array, Uint16Array, Int16Array, Int8Array, Uint8Array, Int32Array };
  const view = (a) => {
    const C = Object.hasOwn(T, a.type) ? T[a.type] : null;
    if (!C || !Number.isSafeInteger(a.offset) || a.offset < 0 || !Number.isSafeInteger(a.count) || a.count < 0) {
      throw new Error('invalid geometry attribute');
    }
    const start = base + a.offset;
    if (start % C.BYTES_PER_ELEMENT || start + a.count * C.BYTES_PER_ELEMENT > buf.byteLength) {
      throw new Error('truncated or misaligned geometry attribute');
    }
    // Retain typed views over the one download. slice() used to duplicate every large array.
    return new C(buf, start, a.count);
  };
  const geo = new THREE.BufferGeometry();
  for (const a of header.attrs) {
    geo.setAttribute(a.name, new THREE.BufferAttribute(view(a), a.itemSize, a.normalized));
  }
  if (header.index) {
    geo.setIndex(new THREE.BufferAttribute(view(header.index), 1));
  }
  // Packed terrain obtains bounds per spatial group instead of scanning the whole container twice.
  if (computeBounds) { geo.computeBoundingBox(); geo.computeBoundingSphere(); }
  return geo;
}

/** geometries built while baking (node only): name → BufferGeometry */
export const bakeRegistry = new Map();

/**
 * Browser results are shared read-only geometries. Transform the Mesh, or request { clone: true }
 * before changing attributes or taking individual disposal ownership. clone() copies the arrays.
 * Disposing a shared geometry evicts it from this cache; existing meshes still own their refs.
 */
export async function loadOrBuild(name, build, { clone = false } = {}) {
  if (isNode) { const g = await build(); bakeRegistry.set(name, g); return g; }
  let promise = geometryPromises.get(name);
  if (!promise) {
    promise = (async () => {
      const manifest = await loadGeneratedManifest();
      const declared = !!manifest?.geometries[name];
      let geometry;
      try {
        geometry = deserializeGeometry(await loadGeneratedBinary(name));
      } catch (error) {
        // Production bakes must not silently become minutes of synchronous CPU meshing.
        if (declared || error.code === 'BAKED_ASSET_UNAVAILABLE') throw bakedError(name, error);
      }
      if (!geometry) {
        console.log(`[cache] ${name} not baked, building at runtime`);
        geometry = await build();
      }
      const evict = () => {
        if (geometryPromises.get(name) === promise) geometryPromises.delete(name);
        geometry.removeEventListener('dispose', evict);
      };
      geometry.addEventListener('dispose', evict);
      return geometry;
    })();
    geometryPromises.set(name, promise);
    promise.catch(() => { if (geometryPromises.get(name) === promise) geometryPromises.delete(name); });
  }
  const geometry = await promise;
  return clone ? geometry.clone() : geometry;
}

/** Drop cache ownership without disposing geometries still attached to a scene. */
export function clearGeometryCache() { geometryPromises.clear(); }

/** A raw checkout has no manifest; published builds enumerate their immutable compressed bakes. */
export function loadGeneratedManifest() {
  if (!manifestPromise) {
    const promise = (async () => {
      try {
        const response = await fetch(assetURL('generated/manifest.json'), { cache: 'no-cache' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json();
        if (manifest?.formatVersion !== 1 || !manifest.geometries || typeof manifest.geometries !== 'object' || Array.isArray(manifest.geometries)) {
          throw new Error('unsupported geometry manifest');
        }
        return manifest;
      } catch (error) { throw bakedError('manifest', error); }
    })();
    manifestPromise = promise;
    promise.catch(() => { if (manifestPromise === promise) manifestPromise = undefined; });
  }
  return manifestPromise;
}

/** Read one bake without also retaining the compressed response as an ArrayBuffer. */
export function loadGeneratedBinary(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return Promise.reject(bakedError(name, 'invalid bake name'));
  let promise = binaryPromises.get(name);
  if (!promise) {
    promise = (async () => {
      const manifest = await loadGeneratedManifest();
      const entry = manifest?.geometries[name];
      if (!entry) {
        const response = await fetch(assetURL(`generated/${name}.bin`));
        if (!response.ok) throw new Error(`Geometry ${name}: HTTP ${response.status}`);
        return response.arrayBuffer();
      }
      try {
        const sha = entry.sha256;
        if (entry.encoding !== 'gzip' || !/^[a-f0-9]{64}$/.test(sha) ||
            entry.file !== `${name}.${sha.slice(0, 12)}.bin.gz` ||
            !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes < 8) {
          throw new Error('invalid compressed geometry entry');
        }
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support gzip geometry loading');
        const response = await fetch(assetURL(`generated/${entry.file}`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error('empty geometry response');
        let received = 0;
        const stream = response.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TransformStream({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > entry.rawBytes) throw new Error('geometry exceeds declared size');
            controller.enqueue(chunk);
          },
        }));
        const buffer = await new Response(stream).arrayBuffer();
        if (buffer.byteLength !== entry.rawBytes) throw new Error('truncated geometry response');
        return buffer;
      } catch (error) { throw bakedError(name, error); }
    })();
    binaryPromises.set(name, promise);
    // Deduplicate concurrent reads only. Geometries own the raw buffers after decoding.
    const forget = () => { if (binaryPromises.get(name) === promise) binaryPromises.delete(name); };
    promise.then(forget, forget);
  }
  return promise;
}
