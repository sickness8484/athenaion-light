import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { createBootState } from '../src/core/boot-state.js';
import { SKY } from '../src/core/sky.js';
import { ATMO } from '../src/core/atmosphere.js';
import { mockEngine } from './helpers/mock-engine.js';

class Emitter {
  constructor() { this.listeners = new Map(); this.children = []; this.hidden = false; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type, detail = {}) { for (const callback of this.listeners.get(type) || []) callback({ type, target: this, ...detail }); }
  appendChild(node) { this.children.push(node); }
  setAttribute(name, value) { this[name] = value; }
}
function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(predicate(), 'Expected asynchronous startup work to complete');
}
let pageNumber = 0;

// Keep main.js, interactive.js, the boot marker and the GPU fence implementation
// intact. Only browser surfaces, asset/network work and engine creation are faked.
async function withPage(options, run) {
  const { engine, events } = mockEngine();
  engine.registry.water.reflection.configureUpdatePolicy = () => {};
  engine.canvas = new Emitter();
  const session = memoryStorage(), local = memoryStorage();
  const path = '/athenaion-light/';
  const readMarker = () => JSON.parse(session.getItem(`athenaion:boot:1:${path}`));
  if (options.previousStage) createBootState({ release: 'v4', scope: path, storage: session, fallbackStorage: local }).begin(options.previousStage);
  const cloud = deferred(), compile = deferred(), nodes = new Map(), frames = new Map();
  const doc = new Emitter(), appEvents = new Emitter(), win = { devicePixelRatio: 1 };
  let now = 100, nextFrame = 1, app, reloads = 0, copied = '', renders = 0;
  const calls = [], errors = [], navigations = [];
  const checkpoint = name => calls.push({ name, marker: readMarker() });
  doc.hidden = false; doc.fullscreenEnabled = false;
  doc.body = { classList: { add() {} } };
  doc.getElementById = id => {
    if (!nodes.has(id)) {
      const node = new Emitter();
      node.hidden = ['brand', 'controls', 'help', 'retry', 'copy-error'].includes(id);
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  doc.createElement = () => new Emitter();
  class FakeOrbitControls extends Emitter {
    constructor() { super(); this.target = new THREE.Vector3(); }
    update() { if (this.changeOnUpdate) this.emit('change'); }
  }
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, TIMEOUT_EXPIRED: 4,
    ready: false, lost: false, fences: 0, deleted: 0,
    fenceSync() { this.fences++; return {}; }, flush() {},
    isContextLost() { return this.lost; },
    clientWaitSync() { return this.ready ? this.CONDITION_SATISFIED : this.TIMEOUT_EXPIRED; },
    deleteSync() { this.deleted++; },
  };
  engine.renderer.getContext = () => gl;
  engine.prepareScene = () => checkpoint('prepare');
  engine.applyShot = shot => { checkpoint('environment'); engine.shot = shot; };
  engine.compileScene = async ({ onProgress }) => {
    checkpoint('compile'); onProgress?.({ completed: 1, total: 1 });
    if (options.pauseCompile) await compile.promise;
  };
  const render = engine.renderInteractive.bind(engine);
  engine.renderInteractive = (...args) => { renders++; return render(...args); };
  const harness = {
    SHOTS: [engine.shot],
    prepareCloudTextures: () => { checkpoint('cloud'); return cloud.promise; },
    createEngine: async () => { checkpoint('engine'); return engine; },
    buildWorld: async engine => { engine.onProgress({ name: 'terrain', index: 0, total: 1 }); checkpoint('terrain'); },
    clearGeometryCache() {}, setupVideo() {},
  };
  const replacements = {
    document: doc, window: win, innerWidth: 1024, innerHeight: 768,
    sessionStorage: session, localStorage: local,
    location: { search: options.search || '', pathname: path, href: `https://example.test${path}${options.search || ''}`,
      reload: () => { reloads++; }, assign: url => navigations.push(url) },
    navigator: { userAgent: 'startup-test', clipboard: { writeText: async value => { copied = value; } } },
    matchMedia: () => ({ matches: false }), history: { replaceState() {} },
    addEventListener: appEvents.addEventListener.bind(appEvents),
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    __startupOrbitControls: FakeOrbitControls, __startupPage: harness,
  };
  const previous = new Map(Object.keys(replacements).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const uniformValues = [SKY.uCloudSteps, SKY.uSkyTime, ATMO.uAtmoTime].map(uniform => [uniform, uniform.value]);
  const oldError = console.error, oldLog = console.log;
  let entry;
  try {
    for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
    console.error = error => errors.push(error); console.log = () => {};
    const serial = ++pageNumber;
    const interactiveSource = fs.readFileSync(new URL('../src/interactive.js', import.meta.url), 'utf8')
      .replace("from 'three';", 'from ' + JSON.stringify(import.meta.resolve('three')) + ';')
      .replace("import { OrbitControls } from 'three/addons/controls/OrbitControls.js';", 'const OrbitControls = globalThis.__startupOrbitControls;')
      .replace("from './core/performance.js';", 'from ' + JSON.stringify(new URL('../src/core/performance.js', import.meta.url).href) + ';');
    const { startInteractive } = await import('data:text/javascript;base64,' + Buffer.from(interactiveSource).toString('base64') + '#' + serial);
    harness.startInteractive = async (...args) => { app = await startInteractive(...args); return app; };
    let source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
      .replace("from 'three';", 'from ' + JSON.stringify(import.meta.resolve('three')) + ';');
    for (const [bindings, module] of [
      ['createEngine', 'core/engine'], ['SHOTS', 'world/shots'],
      ['clearGeometryCache', 'core/cache'], ['prepareCloudTextures', 'core/sky'],
    ]) source = source.replace(`import { ${bindings} } from './${module}.js';`, `const { ${bindings} } = globalThis.__startupPage;`);
    for (const module of ['quality', 'performance', 'boot-state']) source = source.replace(`from './core/${module}.js';`, 'from ' + JSON.stringify(new URL(`../src/core/${module}.js`, import.meta.url).href) + ';');
    for (const module of ['world/index', 'video/player', 'interactive']) source = source.replace(`await import('./${module}.js')`, 'globalThis.__startupPage');
    source = source.replace('boot().catch(showError);', 'export const bootDone = boot().catch(showError);');
    entry = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + serial);
    const page = {
      engine, events, doc, win, gl, cloud, compile, frames, calls, errors, navigations, appEvents, session, local,
      readMarker, get app() { return app; }, get renders() { return renders; },
      get reloads() { return reloads; }, get copied() { return copied; },
      bootDone: entry.bootDone,
      finishCloud: async () => { cloud.resolve(); await entry.bootDone; },
      advance(step = 16) { now += step; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(now); },
    };
    await run(page);
  } finally {
    win.__stopInteractive?.(); gl.lost = true; cloud.resolve(); compile.resolve();
    if (entry) await entry.bootDone;
    if (gl.fences > gl.deleted) await until(() => gl.deleted === gl.fences);
    console.error = oldError; console.log = oldLog;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    if (previousNow) Object.defineProperty(performance, 'now', previousNow);
    else delete performance.now;
    for (const [uniform, value] of uniformValues) uniform.value = value;
  }
}

test('startup loads clouds before WebGL and pauses all further draws until the first GPU frame finishes', async () => {
  await withPage({}, async page => {
    assert.deepEqual(page.calls.map(call => call.name), ['cloud']);
    assert.match(page.readMarker().stage, /雲/);
    assert.equal(page.frames.size, 0);
    await page.finishCloud();
    assert.deepEqual(page.calls.map(call => call.name), ['cloud', 'engine', 'terrain', 'prepare', 'environment', 'compile']);
    for (const call of page.calls) assert.equal(call.marker.phase, 'loading', call.name);
    assert.match(page.calls.find(call => call.name === 'terrain').marker.stage, /地形/);
    assert.match(page.calls.find(call => call.name === 'environment').marker.stage, /反射/);
    assert.match(page.readMarker().stage, /最初の画面/);
    assert.equal(page.win.__READY, false);
    assert.equal(page.app.controls.enabled, false);
    page.app.controls.changeOnUpdate = true;
    page.advance();
    page.app.controls.changeOnUpdate = false;
    assert.equal(page.renders, 1);
    assert.equal(page.gl.fences, 1);
    assert.equal(page.frames.size, 0);
    assert.equal(page.doc.getElementById('loading').hidden, false);
    page.app.controls.emit('change');
    page.appEvents.emit('resize');
    page.appEvents.emit('keydown', { key: '1' });
    page.doc.getElementById('shot').emit('change', { target: { value: 1 } });
    page.doc.getElementById('profile').emit('change', { target: { value: 'fast' } });
    page.doc.hidden = true; page.doc.emit('visibilitychange');
    page.doc.hidden = false; page.doc.emit('visibilitychange');
    page.advance(1000);
    assert.equal(page.renders, 1);
    assert.equal(page.calls.filter(call => call.name === 'environment').length, 1);
    assert.equal(page.frames.size, 0);
    assert.deepEqual(page.navigations, []);
    assert.equal(page.win.__READY, false);
    assert.equal(page.win.__FIRST_FRAME_MS, undefined);
    page.gl.ready = true;
    await until(() => page.win.__READY);
    assert.equal(page.session.values.size, 0);
    assert.equal(page.local.values.size, 0);
    assert.equal(page.gl.deleted, 1);
    assert.equal(page.doc.getElementById('loading').hidden, true);
    assert.equal(page.doc.getElementById('controls').hidden, false);
    assert.equal(page.app.controls.enabled, true);
    assert.equal(page.frames.size, 1);
    page.advance();
    assert.equal(page.renders, 2);
    assert.deepEqual(page.errors, []);
  });
});

test('an interrupted startup stops before assets or WebGL and only explicit retry clears both markers', async () => {
  await withPage({ previousStage: '空と反射を準備中' }, async page => {
    await page.bootDone;
    assert.deepEqual(page.calls, []);
    assert.equal(page.frames.size, 0);
    assert.equal(page.win.__READY, false);
    assert.match(page.doc.getElementById('load-detail').textContent, /空と反射を準備中/);
    assert.equal(page.doc.getElementById('retry').hidden, false);
    assert.equal(page.reloads, 0);
    await page.doc.getElementById('copy-error').onclick();
    const diagnostic = JSON.parse(page.copied);
    assert.equal(diagnostic.release, 'v4');
    assert.equal(diagnostic.stage, '空と反射を準備中');
    page.doc.getElementById('retry').onclick();
    assert.equal(page.session.values.size, 0);
    assert.equal(page.local.values.size, 0);
    assert.equal(page.reloads, 1);
    assert.deepEqual(page.calls, []);
  });
});

test('cloud asset errors never create WebGL and remain distinct from context-loss errors', async () => {
  await withPage({}, async page => {
    const error = new Error('Unable to load cloud textures: HTTP 404');
    error.code = 'BAKED_ASSET_UNAVAILABLE';
    page.cloud.reject(error);
    await page.bootDone;
    assert.deepEqual(page.calls.map(call => call.name), ['cloud']);
    assert.match(page.doc.getElementById('load-detail').textContent, /雲のデータを読み込めません/);
    assert.doesNotMatch(page.doc.getElementById('load-detail').textContent, /WebGL|描画が中断/);
    assert.equal(page.readMarker().phase, 'failed');
    assert.equal(page.win.__READY, false);
    page.doc.getElementById('retry').onclick();
    assert.equal(page.readMarker(), null);
  });
});

test('context loss during compilation prevents late compilation success from starting the interactive loop', async () => {
  await withPage({ pauseCompile: true }, async page => {
    page.cloud.resolve();
    await until(() => page.calls.some(call => call.name === 'compile'));
    page.gl.lost = true;
    page.engine.canvas.emit('webglcontextlost', { preventDefault() {} });
    page.compile.resolve();
    await page.bootDone;
    assert.equal(page.app, undefined);
    assert.equal(page.frames.size, 0);
    assert.equal(page.win.__READY, false);
    assert.equal(page.doc.getElementById('loading').hidden, false);
    assert.match(page.doc.getElementById('load-detail').textContent, /3D描画が中断/);
    assert.equal(page.readMarker().phase, 'failed');
    assert.match(page.readMarker().stage, /光と影/);
    assert.equal(page.errors.length, 1);
  });
});

test('late first-frame completion after stop cannot hide loading or erase the unfinished marker', async () => {
  await withPage({}, async page => {
    await page.finishCloud(); page.advance();
    page.app.stop(); page.gl.ready = true;
    await until(() => page.gl.deleted === 1);
    assert.equal(page.win.__READY, false);
    assert.equal(page.doc.getElementById('loading').hidden, false);
    assert.equal(page.doc.getElementById('controls').hidden, true);
    assert.equal(page.readMarker().phase, 'loading');
    assert.equal(page.frames.size, 0);
    assert.equal(page.app.controls.enabled, false);
  });
});

test('context loss during the first GPU frame keeps its error after the fence rejects', async () => {
  await withPage({}, async page => {
    await page.finishCloud(); page.advance();
    page.gl.lost = true;
    page.engine.canvas.emit('webglcontextlost', { preventDefault() {} });
    await until(() => page.gl.deleted === 1);
    assert.equal(page.win.__READY, false);
    assert.equal(page.doc.getElementById('loading').hidden, false);
    assert.match(page.doc.getElementById('load-detail').textContent, /3D描画が中断/);
    assert.match(page.readMarker().stage, /最初の画面/);
    assert.equal(page.readMarker().phase, 'failed');
    assert.equal(page.errors.length, 1);
    assert.equal(page.frames.size, 0);
  });
});

test('offline tools become ready after compilation without reading or clearing interactive startup markers', async () => {
  await withPage({ search: '?mode=still', previousStage: '前回の対話モード' }, async page => {
    await page.finishCloud();
    assert.equal(page.win.__READY, true);
    assert.equal(page.app, undefined);
    assert.equal(page.gl.fences, 0);
    assert.equal(page.frames.size, 0);
    assert.equal(typeof page.win.__renderShot, 'function');
    assert.equal(page.readMarker().stage, '前回の対話モード');
    assert.equal(page.doc.getElementById('loading').hidden, true);
    assert.deepEqual(page.errors, []);
  });
});
