import assert from 'node:assert/strict';
const { MeshPool, terrainWorkerCount } = await import('../src/terrain/pool.js');
const previousWorker = globalThis.Worker;
const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const previousMedia = globalThis.matchMedia;
let mode = 'normal', workers = [], constructCount = 0;
class FakeWorker {
  constructor(url) {
    constructCount++;
    if (mode === 'constructor-failure' && constructCount === 2) throw new Error('unsupported worker');
    this.url = url;
    this.messages = [];
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message, transfer = []) {
    if (mode === 'post-failure') throw new Error('send failed');
    const copy = structuredClone(message, { transfer });
    this.messages.push(copy);
    if (copy.type === 'far') {
      if (mode !== 'grid-timeout') queueMicrotask(() => this.onmessage?.({ data: { type: 'far-ok' } }));
    } else if (mode === 'normal') {
      queueMicrotask(() => this.onmessage?.({ data: { id: copy.id, r: { marker: copy.job.marker } } }));
    }
  }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;
const setup = next => { mode = next; workers = []; constructCount = 0; };
const bounded = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('test hung')), 500); timer.unref();
})]);

setup('normal');
const pool = new MeshPool(2, { timeoutMs: 100 });
const grid = { x0: 0, z0: 0, nx: 2, nz: 2, cell: 1, data: new Float32Array([1, 2, 3, 4]) };
await pool.setFar(grid);
assert.equal(grid.data.buffer.byteLength, 16, 'Grid transfer must not detach the original');
assert(workers.every(w => w.messages[0].grid.data.buffer !== grid.data.buffer));
assert(workers.every(w => new URL(w.url).pathname.endsWith('/src/terrain/worker.js')));
const values = await bounded(Promise.all(Array.from({ length: 6 }, (_, marker) => pool.run({ marker }))));
assert.deepEqual(values.map(v => v.marker), [0, 1, 2, 3, 4, 5]);
pool.dispose();
assert(workers.every(w => w.terminated));
console.log('PASS worker queue ordering, independent transferred grids, successful disposal');

for (const failure of ['error', 'messageerror', 'timeout', 'dispose']) {
  setup('silent');
  const p = new MeshPool(2, { timeoutMs: 15 });
  const waiting = Array.from({ length: 5 }, (_, marker) => p.run({ marker }));
  const settled = Promise.allSettled(waiting);
  if (failure === 'error') workers[0].onerror({ message: 'worker crashed' });
  if (failure === 'messageerror') workers[0].onmessageerror({});
  if (failure === 'dispose') p.dispose();
  const result = await bounded(settled);
  assert(result.every(r => r.status === 'rejected'), failure);
  assert.equal(p.pending.size, 0);
  assert.equal(p.queue.length, 0);
  assert(workers.every(w => w.terminated));
  await assert.rejects(p.run({ marker: 8 }));
}
for (const failure of ['grid-timeout', 'post-failure']) {
  setup(failure);
  const p = new MeshPool(3, { timeoutMs: 15 });
  await assert.rejects(bounded(p.setFar(grid)), /timed out|send failed/);
  assert.equal(p.farWaiters.size, 0);
  assert(workers.every(w => w.terminated));
}
setup('constructor-failure');
const fallbackPool = new MeshPool(3);
assert.equal(fallbackPool.ok, false);
assert(workers[0].terminated, 'Partially created workers must be terminated');
const cancelled = fallbackPool.run({ marker: 1 });
fallbackPool.dispose();
await assert.rejects(cancelled, /disposed/);
console.log('PASS worker failures, message errors, job/grid timeout, partial creation, cancellation');

Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 16, deviceMemory: 8 }, configurable: true });
globalThis.matchMedia = () => ({ matches: true });
assert.equal(terrainWorkerCount(24 * 1024 * 1024), 2);
globalThis.matchMedia = () => ({ matches: false });
assert.equal(terrainWorkerCount(24 * 1024 * 1024), 4);
Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8, deviceMemory: 2 }, configurable: true });
assert.equal(terrainWorkerCount(24 * 1024 * 1024), 1);
console.log('PASS mobile/desktop/low-memory worker limits');

globalThis.Worker = previousWorker;
globalThis.matchMedia = previousMedia;
if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
else delete globalThis.navigator;
