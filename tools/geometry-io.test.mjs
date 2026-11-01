import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { serializeGeometry, deserializeGeometry } from '../src/core/cache.js';
import { writeGeometry, readGeometryHeader } from './geometry-io.mjs';

test('streaming GEO1 writer is byte-identical to the original serializer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'athenaion-geometry-'));
  try {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([1.25, -2, 3, 4, 5, 6, -0, 8, 9]), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 127, -127, 2, 3, 4, 5, 6, 7]), 3, true));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array([255, 128, 0, 64, 32, 16, 1, 2, 3]), 3, true));
    geometry.setAttribute('table', new THREE.BufferAttribute(new Int32Array([16_777_217, 3, 0, 3, 1024, -2, 4, 256]), 8));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    const file = path.join(directory, 'geometry.bin');
    const result = writeGeometry(file, geometry);
    const original = Buffer.from(serializeGeometry(geometry));
    const actual = fs.readFileSync(file);
    assert.deepEqual(actual, original);
    assert.equal(result.bytes, original.length);
    assert.equal(readGeometryHeader(file).attrs.length, 4);
    const restored = deserializeGeometry(actual.buffer.slice(actual.byteOffset, actual.byteOffset + actual.byteLength));
    for (const name of Object.keys(geometry.attributes)) assert.deepEqual(restored.attributes[name].array, geometry.attributes[name].array);
    assert.deepEqual(restored.index.array, geometry.index.array);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('streaming writer preserves custom texture geometry without an index', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'athenaion-texture-'));
  try {
    const geometry = new THREE.BufferGeometry();
    const storage = new Uint8Array([99, 10, 20, 30, 255, 88]);
    geometry.setAttribute('data', new THREE.BufferAttribute(storage.subarray(1, 5), 4, true));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const file = path.join(directory, 'texture.bin');
    writeGeometry(file, geometry);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(serializeGeometry(geometry)));
    assert.equal(readGeometryHeader(file).index, null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
