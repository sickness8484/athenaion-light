// Check a Pages-style project subpath over HTTP, including browser module URLs
// and an actual streamed gzip download. No WebGL/FPS result is implied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startServer } from './serve.mjs';
import { moduleEntryFromHTML } from './build-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function verifySiteHTTP(root = ROOT, { serve = startServer, request = fetch } = {}) {
  const server = await serve(0, root);
  const base = new URL(`http://127.0.0.1:${server.port}/dist/index.html`);
  let requests = 0;
  const get = async (relative) => {
    const url = new URL(relative, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/dist/')) throw new Error(`Module escaped the project subpath: ${relative}`);
    const response = await request(url);
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
    const mainEntry = moduleEntryFromHTML(html).replace(/^\.\//, '');
    const scriptDirectory = path.posix.dirname(mainEntry);
    const pending = new Set([mainEntry, imports.three.replace(/^\.\//, '')]);
    // World modules are imported by a template string, so seed that dispatch set.
    const moduleDirectory = path.posix.join(scriptDirectory, 'modules');
    for (const file of fs.readdirSync(path.join(root, 'dist', moduleDirectory))) if (file.endsWith('.js')) pending.add(`${moduleDirectory}/${file}`);
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["'](?!\s*\+)/g;
    const workerPattern = /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
    const workers = new Set();
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
      for (const match of code.matchAll(workerPattern)) {
        if (!match[1].startsWith('.')) throw new Error(`Unexpected browser worker URL: ${match[1]}`);
        const worker = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
        pending.add(worker); workers.add(worker);
      }
    }
    const manifest = await (await get('generated/manifest.json')).json();
    const entry = manifest.geometries[manifest.terrain.preview];
    const compressed = await get('generated/' + entry.file);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of compressed.body.pipeThrough(new DecompressionStream('gzip'))) { bytes += chunk.byteLength; hash.update(chunk); }
    if (bytes !== entry.rawBytes || hash.digest('hex') !== entry.sha256) throw new Error('HTTP gzip stream changed terrain bytes');
    return { requests, modules: pending.size, workers: workers.size, scriptDirectory, terrainBytes: bytes };
  } finally { await server.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifySiteHTTP();
  console.log(`[verify:http] ${result.requests} HTTP responses and ${result.modules} browser modules (${result.workers} workers) work below /dist/ via ${result.scriptDirectory}; ${result.terrainBytes} terrain bytes survived streamed gzip download.`);
}
