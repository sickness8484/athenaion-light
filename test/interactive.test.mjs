import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { SKY } from '../src/core/sky.js';
import { ATMO } from '../src/core/atmosphere.js';
import { getRuntimeProfile, runtimeViewport } from '../src/core/performance.js';
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

test('interactive RAF sleeps after refinement, ignores skipped draws in adaptation, and resumes on events', async () => {
  const { engine } = mockEngine();
  engine.registry.water.reflection.configureUpdatePolicy = () => {};
  const nodes = new Map(), frames = new Map();
  const doc = new Emitter(), win = {}, appEvents = new Emitter();
  let now = 0, nextFrame = 1;
  doc.hidden = false; doc.fullscreenEnabled = false;
  doc.getElementById = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Emitter());
    return nodes.get(id);
  };
  doc.createElement = () => new Emitter();
  class FakeOrbitControls extends Emitter {
    constructor() { super(); this.target = new THREE.Vector3(); }
    update() {}
  }
  const replacements = {
    document: doc, window: win, innerWidth: 1024, innerHeight: 768,
    location: { href: 'https://example.test/' }, history: { replaceState() {} },
    addEventListener: appEvents.addEventListener.bind(appEvents),
    requestAnimationFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    __testOrbitControls: FakeOrbitControls,
  };
  const previous = new Map(Object.keys(replacements).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const uniformValues = [SKY.uCloudSteps, SKY.uSkyTime, ATMO.uAtmoTime].map((uniform) => [uniform, uniform.value]);
  const advance = (step = 16) => {
    now += step;
    const batch = [...frames.values()]; frames.clear();
    for (const callback of batch) callback(now);
  };
  const settle = () => {
    for (let i = 0; i < 80 && frames.size; i++) advance();
    assert.equal(frames.size, 0, 'A completed static view must schedule no RAF callbacks');
    assert.equal(engine._accFrames, 4);
  };
  try {
    for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
    // Only the DOM/OrbitControls boundary is replaced; run the production scheduler unchanged.
    const source = fs.readFileSync(new URL('../src/interactive.js', import.meta.url), 'utf8')
      .replace("from 'three';", 'from ' + JSON.stringify(import.meta.resolve('three')) + ';')
      .replace("import { OrbitControls } from 'three/addons/controls/OrbitControls.js';", 'const OrbitControls = globalThis.__testOrbitControls;')
      .replace("from './core/performance.js';", 'from ' + JSON.stringify(new URL('../src/core/performance.js', import.meta.url).href) + ';');
    const { startInteractive } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const errors = [];
    const profile = { ...getRuntimeProfile('auto'), maxAcc: 4 };
    const app = await startInteractive(engine, {
      shotById: () => engine.shot, shots: [engine.shot], profile, params: new URLSearchParams(),
      showError: (error) => errors.push(error),
    });
    assert.equal(frames.size, 1);
    settle();
    assert.equal(win.__PERF.scale, 1);
    assert.equal(doc.getElementById('loading').hidden, true);

    // Holding a stationary pointer keeps input active but eventually skips drawing. Those skipped
    // intervals must not lower the moving resolution or pollute the measured frame rate.
    app.controls.emit('start');
    for (let i = 0; i < 100; i++) advance();
    assert.equal(win.__PERF.scale, profile.movingScale);
    assert.equal(engine.width, Math.floor(1024 * profile.movingScale));
    app.controls.emit('end'); settle();

    app.controls.emit('change');
    assert.equal(frames.size, 1);
    doc.hidden = true; doc.emit('visibilitychange');
    assert.equal(frames.size, 0);
    doc.hidden = false; doc.emit('visibilitychange');
    assert.equal(frames.size, 1); settle();

    doc.getElementById('motion').emit('click');
    const beforeTime = engine.time;
    for (let i = 0; i < 8; i++) advance();
    assert(engine.time > beforeTime);
    assert.equal(engine._accFrames, 1);
    assert.equal(frames.size, 1);
    doc.getElementById('motion').emit('click'); settle();

    // A slow moving camera may use the bounded floor. Animation with a stationary
    // camera must restore physical-pixel resolution instead of remaining there.
    win.devicePixelRatio = 2;
    appEvents.emit('resize');
    app.controls.emit('start');
    for (let i = 0; i < 65; i++) { app.controls.emit('change'); advance(100); }
    assert.equal(win.__PERF.scale, profile.minScale);
    assert.equal(engine.width, runtimeViewport(1024, 768, profile, profile.minScale, 2).width);
    app.controls.emit('end');
    doc.getElementById('motion').emit('click');
    for (let i = 0; i < 30; i++) advance();
    assert.equal(win.__PERF.animated, true);
    assert.equal(win.__PERF.moving, false);
    assert.equal(win.__PERF.scale, 1);
    assert.equal(engine.width, runtimeViewport(1024, 768, profile, 1, 2).width);
    doc.getElementById('motion').emit('click'); settle();
    assert.deepEqual(errors, []);
    app.stop(); app.controls.emit('change');
    assert.equal(frames.size, 0);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    if (previousNow) Object.defineProperty(performance, 'now', previousNow);
    else delete performance.now;
    for (const [uniform, value] of uniformValues) uniform.value = value;
  }
});
