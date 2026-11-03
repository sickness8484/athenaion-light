// A small, best-effort checkpoint written before expensive startup work. Native
// process termination cannot be caught by JavaScript; a later load can still
// recognize an unfinished attempt and stop before repeating it automatically.
const PHASES = new Set(['loading', 'failed']);
const MAX_AGE_MS = 20 * 60 * 1000;

function browserStorage(name) {
  try { return globalThis[name] || null; } catch { return null; }
}

function cleanRecord(value, release, now, maxAgeMs) {
  if (!value || value.schema !== 1 || value.release !== release || !PHASES.has(value.phase) ||
      typeof value.id !== 'string' || !value.id || value.id.length > 100 || typeof value.stage !== 'string' ||
      !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt) ||
      value.startedAt > value.updatedAt || now < value.updatedAt || now - value.updatedAt > maxAgeMs) return null;
  return {
    schema: 1, release, id: value.id, phase: value.phase,
    stage: value.stage.slice(0, 120), startedAt: value.startedAt, updatedAt: value.updatedAt,
    ...(typeof value.error === 'string' ? { error: value.error.slice(0, 240) } : {}),
  };
}

/**
 * Storage is deliberately local to this browser; nothing is sent to a server.
 * A marker means only "startup did not finish", not "out of memory". A manual
 * reload during loading can produce the same marker as a terminated process.
 * Call reset() only from an explicit retry action, then reload or begin again.
 */
export function createBootState({
  release = 'v4', scope = '/', storage = browserStorage('sessionStorage'),
  fallbackStorage = browserStorage('localStorage'), now = () => Date.now(),
  maxAgeMs = MAX_AGE_MS,
} = {}) {
  const key = `athenaion:boot:1:${scope}`;
  const stores = [...new Set([storage, fallbackStorage].filter(Boolean))];
  const read = store => {
    try { return JSON.parse(store.getItem(key)); } catch { return null; }
  };
  const records = stores.map(store => cleanRecord(read(store), release, now(), maxAgeMs)).filter(Boolean);
  let previous = records.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  let current = null;
  const write = record => {
    const text = JSON.stringify(record);
    for (const store of stores) { try { store.setItem(key, text); } catch { /* storage may be unavailable/full */ } }
  };
  const removeOwned = id => {
    if (!id) return;
    for (const store of stores) {
      try { if (read(store)?.id === id) store.removeItem(key); } catch { /* best effort */ }
    }
  };
  const copy = record => record ? { ...record } : null;
  return {
    get interrupted() { return previous !== null; },
    get previous() { return copy(previous); },
    snapshot() { return copy(current || previous); },
    begin(stage = 'engine') {
      if (previous || current) return false;
      const time = now();
      current = {
        schema: 1, release, id: `${time}-${Math.random().toString(36).slice(2)}`,
        phase: 'loading', stage: String(stage).slice(0, 120), startedAt: time, updatedAt: time,
      };
      write(current);
      return true;
    },
    stage(stage) {
      if (current?.phase !== 'loading') return;
      current = { ...current, stage: String(stage).slice(0, 120), updatedAt: now() };
      write(current);
    },
    complete() {
      if (current?.phase !== 'loading') return;
      removeOwned(current.id);
      current = null;
    },
    fail(error) {
      if (!current) return;
      current = { ...current, phase: 'failed', updatedAt: now(),
        error: String(error?.message || error || 'Startup failed').slice(0, 240) };
      write(current);
    },
    reset() {
      removeOwned(current?.id);
      removeOwned(previous?.id);
      current = previous = null;
    },
  };
}

/** Resolve only when commands submitted before this fence have finished. */
export async function awaitGpuFrame(gl, {
  maxWaitMs = 30000, now = () => performance.now(),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new RangeError('Invalid GPU wait time');
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) throw new Error('Could not confirm the first GPU frame');
  const deadline = now() + maxWaitMs;
  try {
    gl.flush();
    for (;;) {
      if (gl.isContextLost?.()) throw new Error('WebGL context lost before the first frame completed');
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
      if (status !== gl.TIMEOUT_EXPIRED) throw new Error('Could not confirm the first GPU frame');
      if (now() >= deadline) throw new Error('The first GPU frame did not complete in time');
      await delay(16);
    }
  } finally { gl.deleteSync(fence); }
}
