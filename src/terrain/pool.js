// Bounded workers for development-time meshing. Production loads the same pre-baked geometry.
import { meshChunk } from './voxel.js';

/** Leave room for the shared world and each worker's grid/scratch space; never reduce mesh detail. */
export function terrainWorkerCount(farBytes = 0) {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const hc = Math.max(1, Math.floor(nav.hardwareConcurrency || 4));
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const memoryGB = Number(nav.deviceMemory) || (coarse ? 4 : 8);
  const MB = 1024 * 1024;
  const budget = (memoryGB <= 2 ? 128 : memoryGB <= 4 ? 256 : 512) * MB;
  // 64 MiB is a conservative scratch reservation, not a measured per-chunk footprint.
  const perWorker = Math.max(0, farBytes) + 64 * MB;
  return Math.max(1, Math.min(hc - 2, coarse ? 2 : 4, Math.floor(budget / perWorker)));
}

export class MeshPool {
  constructor(size, { timeoutMs = 120000 } = {}) {
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.farWaiters = new Map();
    this.nextId = 1;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 120000);
    this.closed = false;
    this.failure = null;
    this.mainBusy = false;
    this.mainTimer = null;
    this.ok = typeof Worker !== 'undefined';
    if (!this.ok) return;
    try {
      for (let i = 0; i < Math.max(1, Math.floor(size) || 1); i++) {
        const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        w.busy = false; w.jobId = null; w.timer = null;
        w.onmessage = (e) => {
          if (e.data?.type === 'far-ok') {
            const waiter = this.farWaiters.get(w);
            if (waiter) { clearTimeout(waiter.timer); this.farWaiters.delete(w); waiter.resolve(); this._pump(); }
            return;
          }
          this._done(w, e.data);
        };
        w.onerror = (e) => this._fail(new Error(e.message || 'Terrain worker failed'));
        w.onmessageerror = () => this._fail(new Error('Terrain worker response could not be read'));
        this.workers.push(w);
      }
    } catch (error) {
      for (const w of this.workers) w.terminate();
      this.workers = [];
      this.ok = false;
      console.warn('[terrain] workers unavailable, meshing on the main thread', error);
    }
  }

  /** Keep the original grid in the main thread and transfer exactly one copy to each worker. */
  async setFar(grid) {
    if (this.closed) throw this.failure || new Error('Terrain mesh pool is closed');
    if (!this.ok || !grid) return;
    await Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      if (this.closed) { reject(this.failure || new Error('Terrain mesh pool is closed')); return; }
      const timer = setTimeout(() => this._fail(new Error('Terrain worker grid initialization timed out')), this.timeoutMs);
      this.farWaiters.set(w, { resolve, reject, timer });
      try {
        const data = grid.data.slice();
        w.postMessage({ type: 'far', grid: { ...grid, data } }, [data.buffer]);
      } catch (error) { this._fail(error); }
    })));
  }

  run(job) {
    if (this.closed) return Promise.reject(this.failure || new Error('Terrain mesh pool is closed'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, job });
      this._pump();
    });
  }

  _pump() {
    if (this.closed) return;
    if (!this.ok) {
      if (this.mainBusy || !this.queue.length) return;
      this.mainBusy = true;
      const task = this.queue.shift();
      // Yield a browser task between chunks instead of blocking every queued chunk in microtasks.
      this.mainTimer = setTimeout(() => {
        if (this.closed) return;
        try { this._done(null, { id: task.id, r: meshChunk(task.job) }); }
        catch (error) { this._done(null, { id: task.id, error: String(error?.stack || error) }); }
      }, 0);
      return;
    }
    for (const w of this.workers) {
      if (w.busy || this.farWaiters.has(w) || !this.queue.length) continue;
      const task = this.queue.shift();
      w.busy = true; w.jobId = task.id;
      w.timer = setTimeout(() => this._fail(new Error('Terrain mesh job ' + task.id + ' timed out')), this.timeoutMs);
      try { w.postMessage(task); }
      catch (error) { this._fail(error); return; }
    }
  }

  _done(w, message) {
    if (this.closed) return;
    if (!message || (w && message.id !== w.jobId)) {
      this._fail(new Error('Unexpected terrain worker response'));
      return;
    }
    if (w) { clearTimeout(w.timer); w.timer = null; w.busy = false; w.jobId = null; }
    else { this.mainBusy = false; this.mainTimer = null; }
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.r);
    }
    this._pump();
  }

  _fail(error) {
    if (this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this._close(this.failure);
  }

  _close(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.mainTimer);
    this.mainTimer = null;
    for (const w of this.workers) { clearTimeout(w.timer); w.terminate(); }
    this.workers = [];
    for (const waiter of this.farWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.farWaiters.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.queue = [];
  }

  dispose() { this._close(new Error('Terrain mesh pool disposed')); }
}
