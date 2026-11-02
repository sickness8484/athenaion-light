import test from 'node:test';
import assert from 'node:assert/strict';
import { readGeometryStream } from '../src/core/cache.js';
import { blurFarTextureHeight } from '../src/terrain/far.js';
import { boxBlur } from '../src/terrain/farfield.js';

test('geometry streaming copies transient chunks into an exact-size result without retaining them', async () => {
  const expected = Uint8Array.from({ length: 100003 }, (_, i) => (i * 131 + 17) & 255);
  const scratch = new Uint8Array(4093);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset === expected.length) { controller.close(); return; }
      const length = Math.min(scratch.length, expected.length - offset);
      scratch.set(expected.subarray(offset, offset + length));
      controller.enqueue(scratch.subarray(0, length));
      offset += length;
    },
  }, { highWaterMark: 0 });
  const buffer = await readGeometryStream(stream, expected.length);
  scratch.fill(0);
  assert.equal(buffer.byteLength, expected.length);
  assert.deepEqual(new Uint8Array(buffer), expected);
  assert.equal(stream.locked, false);
});

test('geometry streaming rejects oversized, truncated and failed input and cancels upstream work', async () => {
  let cancelled;
  const tooLarge = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(12)); },
    cancel(error) { cancelled = error; },
  });
  await assert.rejects(readGeometryStream(tooLarge, 8), /exceeds declared size/);
  assert.match(cancelled.message, /exceeds declared size/);
  assert.equal(tooLarge.locked, false);
  const tooShort = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8)); controller.close(); },
  });
  await assert.rejects(readGeometryStream(tooShort, 12), /truncated geometry response/);
  assert.equal(tooShort.locked, false);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('network interrupted')); } });
  await assert.rejects(readGeometryStream(broken, 12), /network interrupted/);
  assert.equal(broken.locked, false);
});

test('far shading blur remains bit-identical to the original generator at borders and after repeated passes', () => {
  for (const [nx, nz] of [[1, 1], [2, 17], [19, 2], [7, 7], [37, 23], [2817, 9]]) {
    const source = Float32Array.from({ length: nx * nz }, (_, i) =>
      Math.sin(i * 0.013) * 4800 + Math.cos(i * 3.17) * 0.0003 + (i % 11 ? 0 : -1200));
    const saved = source.slice();
    for (const radius of [0, 1, 3, 5]) for (const passes of [0, 1, 2, 3]) {
      const expected = boxBlur(source, nx, nz, radius, passes);
      const actual = blurFarTextureHeight(source, nx, nz, radius, passes);
      assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer),
        `${nx}x${nz}, radius ${radius}, ${passes} passes`);
    }
    assert.deepEqual(source, saved, 'heightAt must keep its original height data');
  }
});
