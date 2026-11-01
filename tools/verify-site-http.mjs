// Check a Pages-style project subpath over HTTP, including browser module URLs
// and an actual streamed gzip download. No WebGL/FPS result is implied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startServer } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startServer(0, root);
const base = new URL(`http://127.0.0.1:${server.port}/dist/index.html`);
let requests = 0;
const get = async (relative) => {
  const url = new URL(relative, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/dist/')) throw new Error(`Module escaped the project subpath: ${relative}`);
  const response = await fetch(url);
  requests++;
  if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
  return response;
};
try {
  const html = await (await get('./index.html')).text();
  const importMap = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/);
  if (!importMap) throw new Error('Missing import map');
  const imports = JSON.parse(importMap[1]).imports;
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) if (match[1].startsWith('./')) await (await get(match[1])).arrayBuffer();
  const pending = new Set(['src/main.js', imports.three.replace(/^\.\//, '')]);
  // World modules are imported by a template string, so seed that dispatch set.
  for (const file of fs.readdirSync(path.join(root, 'dist/src/modules'))) if (file.endsWith('.js')) pending.add(`src/modules/${file}`);
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["'](?!\s*\+)/g;
  for (const relative of pending) {
    const response = await get(relative);
    if (!response.headers.get('content-type')?.startsWith('text/javascript')) throw new Error(`Wrong module MIME type: ${relative}`);
    const code = await response.text();
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      let target;
      if (specifier === 'three') target = imports.three;
      else if (specifier.startsWith('three/addons/')) target = imports['three/addons/'] + specifier.slice('three/addons/'.length);
      else if (specifier.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      else throw new Error(`Unexpected browser module specifier: ${specifier}`);
      pending.add(target.replace(/^\.\//, ''));
    }
  }
  const manifest = await (await get('generated/manifest.json')).json();
  const entry = manifest.geometries[manifest.terrain.preview];
  const compressed = await get('generated/' + entry.file);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of compressed.body.pipeThrough(new DecompressionStream('gzip'))) { bytes += chunk.byteLength; hash.update(chunk); }
  if (bytes !== entry.rawBytes || hash.digest('hex') !== entry.sha256) throw new Error('HTTP gzip stream changed terrain bytes');
  console.log(`[verify:http] ${requests} HTTP responses and ${pending.size} browser modules work below /dist/; ${bytes} terrain bytes survived streamed gzip download.`);
} finally { await server.close(); }
