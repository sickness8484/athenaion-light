// Keep source uploads small without regenerating the authored, eroded mountain grid.
// Every existing or downloaded file must match the pinned upstream bytes exactly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileDigest } from './geometry-io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UPSTREAM_FAR = Object.freeze({
  path: 'generated/terrain-far-v11.bin',
  url: 'https://raw.githubusercontent.com/Leonxlnx/athenaion/9b8bd23b39c458a50fb1201037360047781c45b5/generated/terrain-far-v11.bin',
  bytes: 23809636,
  sha256: 'c1fcf89c20fe7ed3a2ef62b476be8296aca3565d45a005bd24c890c85b53eb23',
});

function verify(asset, actual, label) {
  if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) {
    throw new Error(`${label} ${asset.path} failed integrity verification: expected ${asset.bytes} bytes / SHA256 ${asset.sha256}, got ${actual.bytes} bytes / SHA256 ${actual.sha256}`);
  }
}

/** The CLI supplies only UPSTREAM_FAR. Injectable IO/metadata allows small, offline regression tests. */
export async function fetchVerifiedAsset(asset, { root = ROOT, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Asset timeout must be positive and finite');
  const destination = path.resolve(root, asset.path);
  try {
    const existing = await fileDigest(destination);
    verify(asset, existing, 'Existing');
    return { path: asset.path, ...existing, reused: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // Never replace a corrupt or unreadable existing file.
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const hash = createHash('sha256');
  let bytes = 0;
  const inspect = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > asset.bytes) { done(new Error(`Downloaded ${asset.path} exceeds the expected ${asset.bytes} bytes`)); return; }
      hash.update(chunk); done(null, chunk);
    },
  });
  try {
    const response = await fetchImpl(asset.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`Could not fetch ${asset.path}: HTTP ${response.status}`);
    if (!response.body) throw new Error(`Could not fetch ${asset.path}: empty response body`);
    await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal });
    const digest = { bytes, sha256: hash.digest('hex') };
    verify(asset, digest, 'Downloaded');
    await fs.promises.rename(temporary, destination);
    return { path: asset.path, ...digest, reused: false };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Fetching ${asset.path} timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await fs.promises.rm(temporary, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await fetchVerifiedAsset(UPSTREAM_FAR);
    console.log(`[assets] ${result.reused ? 'verified existing' : 'downloaded and verified'} ${result.path} (${result.bytes} bytes)`);
  } catch (error) {
    console.error(`[assets] ${error.message}`);
    process.exitCode = 1;
  }
}
