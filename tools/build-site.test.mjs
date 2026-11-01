import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { moduleEntryFromHTML, sourceScriptDirectory, versionSourceEntry } from './build-site.mjs';
import { verifySiteHTTP } from './verify-site-http.mjs';

const put = (root, name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const sourceHTML = '<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js","three/addons/":"./vendor/three/examples/jsm/"}}</script>\n<script type="module" src="./src/main.js"></script>';

test('source versions depend on sorted relative paths and bytes, independent of checkout location or file creation order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athenaion-source-hash-'));
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    put(a, 'main.js', 'import "./core/engine.js";'); put(a, 'core/engine.js', 'export const version = 1;');
    put(b, 'core/engine.js', 'export const version = 1;'); put(b, 'main.js', 'import "./core/engine.js";');
    const first = sourceScriptDirectory(a);
    assert.match(first, /^src-[a-f0-9]{16}$/);
    assert.equal(sourceScriptDirectory(b), first);
    put(b, 'core/engine.js', 'export const version = 2;');
    assert.notEqual(sourceScriptDirectory(b), first);
    put(b, 'core/engine.js', 'export const version = 1;');
    fs.renameSync(path.join(b, 'core/engine.js'), path.join(b, 'core/renamed.js'));
    assert.notEqual(sourceScriptDirectory(b), first);
    fs.symlinkSync(path.join(a, 'main.js'), path.join(a, 'linked.js'));
    assert.throws(() => sourceScriptDirectory(a), /symlinks/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('published HTML versions the entry while preserving the import map and all relative module, worker and asset roots', () => {
  const directory = 'src-1234567890abcdef';
  const built = versionSourceEntry(sourceHTML, directory);
  assert.equal(moduleEntryFromHTML(built), `./${directory}/main.js`);
  assert.equal(moduleEntryFromHTML(sourceHTML), './src/main.js');
  assert.equal(built.split('\n')[0], sourceHTML.split('\n')[0]);
  const main = new URL(moduleEntryFromHTML(built), 'https://example.test/project/index.html?v=2');
  const worker = new URL('./worker.js', new URL('./terrain/pool.js', main));
  const worldModule = new URL('../modules/terrain.js', new URL('./world/index.js', main));
  const assets = new URL('../../', new URL('./core/cache.js', main));
  assert.equal(worker.pathname, `/project/${directory}/terrain/worker.js`);
  assert.equal(worldModule.pathname, `/project/${directory}/modules/terrain.js`);
  assert.equal(assets.pathname, '/project/');
  assert.equal(new URL('generated/manifest.json', assets).pathname, '/project/generated/manifest.json');
  assert.equal(moduleEntryFromHTML("<script src='./src/main.js' type='module'></script>"), './src/main.js');
  assert.throws(() => moduleEntryFromHTML('<script type="module"></script>'), /one external module/);
  assert.throws(() => versionSourceEntry(built, directory), /development entry/);
});

test('module verification discovers the hashed entry, dynamic world modules and worker imports under a project subpath', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athenaion-versioned-http-'));
  const directory = 'src-1234567890abcdef';
  const prefix = `dist/${directory}`;
  let closed = 0;
  // Keep unit tests usable in sandboxes that disallow listening sockets. The CLI verifier
  // runs this same traversal with the real local HTTP server during the release gate.
  const transport = {
    serve: async () => ({ port: 12345, close: async () => { closed++; } }),
    request: async url => {
      assert.equal(url.origin, 'http://127.0.0.1:12345');
      assert(url.pathname.startsWith('/dist/'));
      const file = path.join(root, url.pathname);
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' } });
    },
  };
  try {
    put(root, 'dist/index.html', versionSourceEntry(sourceHTML, directory));
    put(root, 'dist/vendor/three/build/three.module.js', 'export const REVISION = "fixture";');
    put(root, `${prefix}/main.js`, 'import "./world/index.js"; import "./terrain/pool.js";');
    put(root, `${prefix}/world/index.js`, 'export async function load(name) { return import(`../modules/${name}.js`); }');
    put(root, `${prefix}/modules/demo.js`, 'import "../shared.js";');
    put(root, `${prefix}/shared.js`, 'export const marker = 1;');
    put(root, `${prefix}/terrain/pool.js`, 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });');
    put(root, `${prefix}/terrain/worker.js`, 'import "./voxel.js";');
    put(root, `${prefix}/terrain/voxel.js`, 'export const marker = 2;');
    const raw = Buffer.from('Lossless stream fixture');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    put(root, 'dist/generated/fixture.bin.gz', gzipSync(raw));
    put(root, 'dist/generated/manifest.json', JSON.stringify({ terrain: { preview: 'fixture' }, geometries: { fixture: { file: 'fixture.bin.gz', rawBytes: raw.length, sha256 } } }));
    const result = await verifySiteHTTP(root, transport);
    assert.equal(result.scriptDirectory, directory);
    assert.equal(result.modules, 8);
    assert.equal(result.workers, 1);
    assert.equal(result.terrainBytes, raw.length);

    fs.unlinkSync(path.join(root, `${prefix}/terrain/worker.js`));
    await assert.rejects(verifySiteHTTP(root, transport), /worker\.js: HTTP 404/);
    put(root, `${prefix}/terrain/worker.js`, 'import "./voxel.js";');
    fs.unlinkSync(path.join(root, `${prefix}/shared.js`));
    await assert.rejects(verifySiteHTTP(root, transport), /shared\.js: HTTP 404/);
    assert.equal(closed, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
