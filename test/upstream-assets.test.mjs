import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchVerifiedAsset, UPSTREAM_FAR } from '../tools/fetch-upstream-assets.mjs';

const body = Buffer.from('Athenaion exact upstream fixture\n');
const asset = { ...UPSTREAM_FAR, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'athenaion-upstream-'));
const output = (root) => path.join(root, asset.path);
const files = (root) => fs.existsSync(path.dirname(output(root))) ? fs.readdirSync(path.dirname(output(root))) : [];

test('upstream asset reuses only verified existing bytes and never overwrites mismatches', async () => {
  const root = directory();
  let fetches = 0;
  const fetchImpl = () => { fetches++; throw new Error('Unexpected fetch'); };
  try {
    fs.mkdirSync(path.dirname(output(root)), { recursive: true });
    fs.writeFileSync(output(root), body);
    assert.equal((await fetchVerifiedAsset(asset, { root, fetchImpl })).reused, true);
    for (const corrupt of [body.subarray(1), Buffer.alloc(body.length, 42)]) {
      fs.writeFileSync(output(root), corrupt);
      await assert.rejects(fetchVerifiedAsset(asset, { root, fetchImpl }), /Existing .* failed integrity verification/);
      assert.deepEqual(fs.readFileSync(output(root)), corrupt);
    }
    assert.equal(fetches, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('upstream asset streams into a temporary file and publishes only verified complete bytes', async () => {
  const root = directory();
  try {
    let signal;
    const fetchImpl = async (url, options) => {
      assert.equal(url, UPSTREAM_FAR.url);
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(body.subarray(0, 9));
        controller.enqueue(body.subarray(9));
        controller.close();
      } }));
    };
    const result = await fetchVerifiedAsset(asset, { root, fetchImpl });
    assert.equal(result.reused, false);
    assert.equal(result.bytes, body.length);
    assert.equal(result.sha256, asset.sha256);
    assert.deepEqual(fs.readFileSync(output(root)), body);
    assert.deepEqual(files(root), ['terrain-far-v11.bin']);
    assert(signal.aborted, 'Release any remaining response resources after the transfer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('upstream asset rejects HTTP, size, stream and checksum failures without leaving partial files', async () => {
  for (const kind of ['http', 'empty', 'short', 'large', 'checksum', 'stream']) {
    const root = directory();
    try {
      const fetchImpl = async () => {
        if (kind === 'http') return new Response('missing', { status: 404 });
        if (kind === 'empty') return new Response(null, { status: 200 });
        if (kind === 'short') return new Response(body.subarray(1));
        if (kind === 'large') return new Response(Buffer.concat([body, Buffer.from('extra')]));
        if (kind === 'checksum') return new Response(Buffer.alloc(body.length, 42));
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(body.subarray(0, 5));
          controller.error(new Error('injected stream failure'));
        } }));
      };
      await assert.rejects(fetchVerifiedAsset(asset, { root, fetchImpl }), /HTTP 404|empty response body|integrity verification|exceeds the expected|injected stream failure/, kind);
      assert.equal(fs.existsSync(output(root)), false, kind);
      assert.deepEqual(files(root), [], kind);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('upstream asset timeout covers both response headers and streaming body and cleans temporary files', async () => {
  for (const phase of ['headers', 'body']) {
    const root = directory();
    try {
      const fetchImpl = (_url, { signal }) => phase === 'headers'
        ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        : Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(body.subarray(0, 5)); } })));
      await assert.rejects(fetchVerifiedAsset(asset, { root, fetchImpl, timeoutMs: 20 }), /timed out after 20 ms/);
      assert.equal(fs.existsSync(output(root)), false);
      assert.deepEqual(files(root), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
