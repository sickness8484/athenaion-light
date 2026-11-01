// Fast source checks; visual/GPU validation is reported separately.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? list(file) : /\.(?:js|mjs)$/.test(file) ? [file] : [];
});
const files = ['src', 'tools', 'test', 'tests'].filter((name) => fs.existsSync(path.join(ROOT, name))).flatMap((name) => list(path.join(ROOT, name)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout); throw new Error(`Syntax check failed: ${path.relative(ROOT, file)}`); }
}
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (/\b(?:src|href)=["']\/(?!\/)/.test(index)) throw new Error('Root-relative HTML asset paths would break a GitHub Pages project site.');
for (const relative of ['src/core/cache.js', 'src/modules/terrain.js']) {
  const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  if (/fetch\(\s*["'`]\/(?!\/)/.test(text)) throw new Error(`${relative} still contains a root-relative fetch.`);
}
console.log(`[check] ${files.length} JavaScript modules parse; Pages asset paths are relative.`);
