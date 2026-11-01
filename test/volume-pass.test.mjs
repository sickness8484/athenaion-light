import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HalfResolutionVolumePass } from '../src/core/volume-pass.js';
import { CLOUD_VOLUME_VERTEX_SHADER, CLOUD_VOLUME_FRAGMENT_SHADER } from '../src/modules/clouds.js';

function fixture() {
  const depth = new THREE.DepthTexture(800, 450);
  const camera = new THREE.PerspectiveCamera(50, 800 / 450, 0.5, 60000);
  const target = new THREE.WebGLRenderTarget(800, 450);
  const engine = { quality: { interactiveVolumes: true }, camera, pipeline: { target } };
  const uniforms = {
    uDepthValid: { value: 1 }, tDepth: { value: depth },
    uRes: { value: new THREE.Vector2(800, 450) }, uNearFar: { value: new THREE.Vector2(0.5, 60000) },
    uVolSteps: { value: 24 }, uInvVP: { value: new THREE.Matrix4() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: CLOUD_VOLUME_VERTEX_SHADER, fragmentShader: CLOUD_VOLUME_FRAGMENT_SHADER,
    defines: { VOL_BANKS: 1 }, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const geometry = new THREE.BufferGeometry(), version = depth.source.version;
  const pass = new HalfResolutionVolumePass(engine, material, geometry);
  assert.equal(depth.source.version, version, 'Creating a volume pass must not invalidate shared depth textures');
  const state = {
    target, face: 2, mip: 3, viewport: new THREE.Vector4(7, 11, 800, 450),
    scissor: new THREE.Vector4(13, 17, 600, 300), scissorTest: true,
    clearColor: new THREE.Color(0.1, 0.3, 0.7), clearAlpha: 0.6,
  };
  const renderer = {
    autoClear: true, xr: { enabled: true }, shadowMap: { autoUpdate: true, needsUpdate: true }, info: { autoReset: true },
    extensions: { has: () => true }, calls: 0, framebufferComplete: true, onRender: null,
    getRenderTarget: () => state.target, getActiveCubeFace: () => state.face, getActiveMipmapLevel: () => state.mip,
    setRenderTarget: (v, face = 0, mip = 0) => { state.target = v; state.face = face; state.mip = mip; },
    getViewport: (v) => v.copy(state.viewport), getScissor: (v) => v.copy(state.scissor),
    setViewport: (...a) => a[0]?.isVector4 ? state.viewport.copy(a[0]) : state.viewport.set(...a),
    setScissor: (...a) => a[0]?.isVector4 ? state.scissor.copy(a[0]) : state.scissor.set(...a),
    getScissorTest: () => state.scissorTest, setScissorTest: (v) => { state.scissorTest = v; },
    getClearColor: (v) => v.copy(state.clearColor), getClearAlpha: () => state.clearAlpha,
    setClearColor: (v, a) => { state.clearColor.set(v); state.clearAlpha = a; }, clear: () => {},
    getContext: () => ({ FRAMEBUFFER: 1, FRAMEBUFFER_COMPLETE: 2, checkFramebufferStatus: () => renderer.framebufferComplete ? 2 : 3 }),
    render: (scene, c) => { renderer.calls++; renderer.onRender?.(scene, c); },
  };
  const snapshot = () => ({
    ...state, viewport: state.viewport.toArray(), scissor: state.scissor.toArray(), clearColor: state.clearColor.toArray(),
    autoClear: renderer.autoClear, xr: renderer.xr.enabled, shadowAuto: renderer.shadowMap.autoUpdate,
    shadowNeeds: renderer.shadowMap.needsUpdate, infoAuto: renderer.info.autoReset, resolution: uniforms.uRes.value.toArray(),
  });
  return { pass, engine, renderer, snapshot, camera, material, uniforms, state, geometry, target };
}

test('moving volume integration uses a quarter of the pixels and restores the complete renderer state', () => {
  const f = fixture(), before = f.snapshot();
  f.pass.setInteractiveState({ moving: true, animated: false });
  f.renderer.onRender = (scene, camera) => {
    assert.equal(camera, f.camera, 'The original camera supplies world/view uniforms');
    assert.equal(scene.children[0].material.fragmentShader, CLOUD_VOLUME_FRAGMENT_SHADER);
    assert.equal(scene.children[0].material.uniforms, f.uniforms);
    assert.equal(scene.children[0].material.blending, THREE.NoBlending);
    assert.equal(scene.children[0].geometry, f.geometry);
    assert.deepEqual(f.uniforms.uRes.value.toArray(), [400, 225]);
    assert.equal(f.state.target.width * f.state.target.height, 90000);
    assert.equal(f.state.target.texture.type, THREE.HalfFloatType);
    assert.equal(f.state.target.texture.minFilter, THREE.NearestFilter);
    assert.equal(f.renderer.shadowMap.autoUpdate, false);
    assert.equal(f.renderer.shadowMap.needsUpdate, false);
    assert.equal(f.renderer.info.autoReset, false);
    assert.equal(f.state.scissorTest, false);
    assert.equal(f.state.clearAlpha, 0);
  };
  assert.equal(f.pass.render(f.renderer, f.camera), true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.uniforms.uVolumeCached.value, 1);
  assert.equal(f.uniforms.tVolumeLow.value, f.pass.target.texture);
  assert.equal(f.uniforms.uVolSteps.value, 24, 'No raymarch steps are removed');
  assert.equal(f.material.transparent, true);
  assert.equal(f.material.blending, THREE.CustomBlending);
  assert.equal(f.material.blendSrc, THREE.OneFactor);
  assert.equal(f.material.blendDstAlpha, THREE.OneFactor);
  assert.deepEqual(f.pass.stats, { renders: 1, raymarchPixels: 90000, fullSizePixels: 360000, failures: 0 });
});

test('odd-sized resizing, still/reflection frames and unsupported devices preserve the original shader', () => {
  const f = fixture(); f.pass.setInteractiveState({ animated: true });
  assert.equal(f.pass.render(f.renderer, f.camera), true);
  const texture = f.pass.target.texture;
  f.target.setSize(801, 451); f.uniforms.uRes.value.set(801, 451);
  const before = f.snapshot();
  assert.equal(f.pass.render(f.renderer, f.camera), true);
  assert.deepEqual(f.uniforms.uVolumeLowRes.value.toArray(), [401, 226]);
  assert.equal(f.pass.target.texture, texture);
  assert.deepEqual(f.snapshot(), before);
  const attempts = f.renderer.calls;
  for (const state of [null, { moving: false, animated: false }]) {
    f.pass.setInteractiveState(state);
    assert.equal(f.pass.render(f.renderer, f.camera), false);
    assert.equal(f.uniforms.uVolumeCached.value, 0);
  }
  f.pass.setInteractiveState({ moving: true });
  f.state.target = new THREE.WebGLRenderTarget(256, 256);
  assert.equal(f.pass.render(f.renderer, f.camera), false);
  f.state.target = f.target;
  assert.equal(f.pass.render(f.renderer, new THREE.PerspectiveCamera()), false);
  f.uniforms.uDepthValid.value = 0;
  assert.equal(f.pass.render(f.renderer, f.camera), false);
  f.uniforms.uDepthValid.value = 1; f.renderer.extensions.has = () => false;
  assert.equal(f.pass.render(f.renderer, f.camera), false);
  assert.equal(f.renderer.calls, attempts);
  assert.equal(f.uniforms.uVolumeCached.value, 0);
});

test('nested render failures or incomplete framebuffers fall back and preserve renderer state', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    for (const failure of ['render', 'framebuffer']) {
      const f = fixture(); f.pass.setInteractiveState({ moving: true });
      const before = f.snapshot();
      if (failure === 'render') f.renderer.onRender = () => { throw new Error('simulated WebGL failure'); };
      else f.renderer.framebufferComplete = false;
      assert.equal(f.pass.render(f.renderer, f.camera), false);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.uniforms.uVolumeCached.value, 0);
      assert.equal(f.pass.target, null);
      assert.equal(f.pass.failed, true);
      assert.equal(f.pass.inPass, false);
      assert.equal(f.pass.stats.failures, 1);
      const calls = f.renderer.calls;
      assert.equal(f.pass.render(f.renderer, f.camera), false);
      assert.equal(f.renderer.calls, calls, 'A failed pass must not repeat GPU allocation');
    }
  } finally { console.warn = warn; }
});

test('dispose releases owned GPU objects without disposing the original fullscreen geometry', () => {
  const f = fixture(); f.pass.setInteractiveState({ animated: true });
  f.pass.render(f.renderer, f.camera);
  const released = { geometry: 0, rayMaterial: 0, target: 0 };
  f.geometry.addEventListener('dispose', () => { released.geometry++; });
  f.pass.rayMaterial.addEventListener('dispose', () => { released.rayMaterial++; });
  f.pass.target.addEventListener('dispose', () => { released.target++; });
  f.pass.dispose();
  assert.deepEqual(released, { geometry: 0, rayMaterial: 1, target: 1 });
  assert.equal(f.uniforms.tVolumeLow.value, null);
  f.pass.setInteractiveState({ moving: true });
  assert.equal(f.pass.render(f.renderer, f.camera), false);
});
