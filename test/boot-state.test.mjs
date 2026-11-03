import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootState, awaitGpuFrame } from '../src/core/boot-state.js';

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('unfinished startup blocks automatic repetition and preserves its stage until explicit retry', () => {
  const storage = memoryStorage(), fallbackStorage = memoryStorage(); let time = 1000;
  const options = { storage, fallbackStorage, now: () => time, release: 'test', scope: '/athenaion/' };
  const first = createBootState(options);
  assert.equal(first.interrupted, false); assert.equal(first.begin(), true);
  time += 50; first.stage('terrain'); time += 50;
  const reloaded = createBootState(options);
  assert.equal(reloaded.interrupted, true); assert.equal(reloaded.previous.stage, 'terrain');
  assert.equal(reloaded.begin(), false); assert.equal(reloaded.snapshot().phase, 'loading');
  reloaded.previous.stage = 'modified'; assert.equal(reloaded.previous.stage, 'terrain');
  reloaded.complete(); reloaded.stage('unstarted');
  assert.equal(createBootState(options).interrupted, true);
  reloaded.reset(); assert.equal(reloaded.interrupted, false); assert.equal(reloaded.begin('retry'), true);
  reloaded.complete();
  assert.equal(storage.values.size, 0); assert.equal(fallbackStorage.values.size, 0);
  assert.equal(createBootState(options).interrupted, false);
});

test('persistent backup detects interruption when tab storage is lost', () => {
  const storage = memoryStorage(), fallbackStorage = memoryStorage();
  const options = { storage, fallbackStorage, now: () => 1000 };
  const state = createBootState(options); state.begin('cloud textures'); storage.values.clear();
  const recovered = createBootState(options);
  assert.equal(recovered.interrupted, true); assert.equal(recovered.previous.stage, 'cloud textures');
  recovered.reset(); assert.equal(createBootState(options).interrupted, false);
});

test('stale, future, malformed, different-release and different-path records do not block startup', () => {
  for (const kind of ['stale', 'future', 'malformed', 'release', 'path']) {
    const storage = memoryStorage(); let time = 1000;
    const options = { storage, fallbackStorage: null, now: () => time, release: 'one', scope: '/one/' };
    const state = createBootState(options); state.begin('engine');
    if (kind === 'stale') time += 20 * 60 * 1000 + 1;
    if (kind === 'future') time = 500;
    if (kind === 'malformed') storage.values.set([...storage.values.keys()][0], 'not JSON');
    if (kind === 'release') options.release = 'two';
    if (kind === 'path') options.scope = '/two/';
    const next = createBootState(options);
    assert.equal(next.interrupted, false, kind); assert.equal(next.begin(), true, kind);
  }
});

test('unavailable or full storage never prevents startup', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('denied'); } };
  const state = createBootState({ storage, fallbackStorage: storage, now: () => 1000 });
  assert.equal(state.begin(), true); state.stage('world'); state.fail(new Error('render failed')); state.reset();
  assert.equal(state.begin(), true); state.complete();
});

test('an older completion cannot erase a newer attempt, and failed attempts reject late completion', () => {
  const storage = memoryStorage(); let time = 1000;
  const options = { storage, fallbackStorage: null, now: () => time };
  const old = createBootState(options); old.begin('old'); time++;
  const next = createBootState(options); next.reset(); next.begin('first frame'); old.complete();
  assert.equal(createBootState(options).previous.stage, 'first frame');
  next.fail(new Error('x'.repeat(500))); next.complete(); next.stage('late progress');
  const retry = createBootState(options);
  assert.equal(retry.interrupted, true); assert.equal(retry.previous.phase, 'failed');
  assert.equal(retry.previous.stage, 'first frame'); assert.equal(retry.previous.error.length, 240);
  retry.reset(); assert.equal(createBootState(options).interrupted, false);
});

function fakeGL(statuses, lost = false) {
  const sync = {}, calls = [];
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3,
    TIMEOUT_EXPIRED: 4, WAIT_FAILED: 5,
    fenceSync: () => { calls.push('fence'); return sync; }, flush: () => calls.push('flush'),
    isContextLost: () => lost,
    clientWaitSync: (actual, flags, timeout) => {
      assert.equal(actual, sync); assert.equal(flags, 0); assert.equal(timeout, 0);
      calls.push('poll'); return statuses.length > 1 ? statuses.shift() : statuses[0];
    },
    deleteSync: actual => { assert.equal(actual, sync); calls.push('delete'); },
  };
  return { gl, calls };
}

test('first-frame completion yields while the GPU is busy and frees its fence after success', async () => {
  const { gl, calls } = fakeGL([4, 4, 3]); let time = 0;
  await awaitGpuFrame(gl, { now: () => time, delay: async ms => { calls.push('yield'); time += ms; } });
  assert.deepEqual(calls, ['fence', 'flush', 'poll', 'yield', 'poll', 'yield', 'poll', 'delete']);
});

test('GPU failure, context loss and timeout always free their allocated fence', async () => {
  for (const kind of ['failure', 'context', 'timeout']) {
    const { gl, calls } = fakeGL([kind === 'failure' ? 5 : 4], kind === 'context'); let time = 0;
    await assert.rejects(awaitGpuFrame(gl, { maxWaitMs: 20, now: () => time,
      delay: async ms => { time += ms; } }), /GPU frame|context lost/);
    assert.equal(calls.at(-1), 'delete'); assert.equal(calls.filter(c => c === 'delete').length, 1);
  }
});
