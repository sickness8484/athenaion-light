// Render only the expensive volumetric integration at half resolution while
// interacting. Geometry, opaque depth and transparent compositing stay full size.
import * as THREE from 'three';

export const VOLUME_COMPOSITE_GLSL = /* glsl */ `
uniform sampler2D tVolumeLow;
uniform vec2 uVolumeLowRes;
uniform float uVolumeCached;
float volumeLinearDepth(float z) {
  return (uNearFar.x * uNearFar.y) / max(uNearFar.y - (uNearFar.y - uNearFar.x) * z, 1e-6);
}
void main() {
  if (uVolumeCached < 0.5) { volumeOriginalMain(); return; }
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * uVolumeLowRes - 0.5;
  vec2 cell = floor(p), f = fract(p);
  float centerDepth = volumeLinearDepth(texture2D(tDepth, uv).r);
  float tolerance = max(0.5, centerDepth * 0.02);
  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 tap = clamp((cell + o + 0.5) / uVolumeLowRes,
      0.5 / uVolumeLowRes, 1.0 - 0.5 / uVolumeLowRes);
    float tapDepth = volumeLinearDepth(texture2D(tDepth, tap).r);
    float compatible = max(0.0, 1.0 - abs(tapDepth - centerDepth) / tolerance);
    vec2 w = mix(1.0 - f, f, o);
    float weight = w.x * w.y * compatible;
    // The low-resolution texture stores premultiplied radiance and opacity.
    sum += texture2D(tVolumeLow, tap) * weight;
    weightSum += weight;
  }
  // A thin foreground edge may have no depth-compatible low-resolution tap.
  // Integrate that pixel with the original shader instead of bleeding cloud
  // radiance across the silhouette or erasing fog in front of the geometry.
  if (weightSum < 0.001) { volumeOriginalMain(); return; }
  gl_FragColor = sum / weightSum;
}
`;

export function wrapVolumeFragmentShader(fragment) {
  const main = /\bvoid\s+main\s*\(\s*\)\s*\{/;
  if (!main.test(fragment)) throw new Error('Volume fragment shader has no main function');
  return fragment.replace(main, 'void volumeOriginalMain() {') + VOLUME_COMPOSITE_GLSL;
}

export class HalfResolutionVolumePass {
  constructor(engine, material, geometry, { scale = 0.5 } = {}) {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new RangeError('Invalid volume render scale');
    this.engine = engine;
    this.material = material;
    this.scale = scale;
    this.state = null;
    this.failed = false;
    this.inPass = false;
    this.target = null;
    this.stats = { renders: 0, raymarchPixels: 0, fullSizePixels: 0, failures: 0 };
    // Keep an unmodified raymarch shader for the offscreen pass. Sharing uniform
    // objects keeps the same camera, sun, density maps and original step count.
    // Do not clone uniforms/textures: Texture.clone can invalidate a shared
    // Source and would also duplicate render-target texture wrappers.
    this.rayMaterial = new THREE.ShaderMaterial({
      uniforms: material.uniforms, vertexShader: material.vertexShader,
      fragmentShader: material.fragmentShader, defines: { ...material.defines },
      side: material.side, fog: material.fog, lights: material.lights,
      precision: material.precision, glslVersion: material.glslVersion,
      extensions: { ...material.extensions }, toneMapped: material.toneMapped,
      transparent: false, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    });
    material.uniforms.tVolumeLow = { value: null };
    material.uniforms.uVolumeLowRes = { value: new THREE.Vector2(1, 1) };
    material.uniforms.uVolumeCached = { value: 0 };
    material.fragmentShader = wrapVolumeFragmentShader(material.fragmentShader);
    material.needsUpdate = true;
    this.scene = new THREE.Scene();
    this.scene.matrixAutoUpdate = false;
    const mesh = new THREE.Mesh(geometry, this.rayMaterial);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
  }

  setInteractiveState(state) {
    this.state = state;
    this.material.uniforms.uVolumeCached.value = 0;
  }

  render(renderer, camera) {
    const uniforms = this.material.uniforms;
    uniforms.uVolumeCached.value = 0;
    const active = this.state && (this.state.moving || this.state.animated);
    const current = renderer.getRenderTarget();
    if (!active || this.failed || this.inPass || !this.engine.quality.interactiveVolumes ||
        current !== this.engine.pipeline.target || camera !== this.engine.camera ||
        !camera.isPerspectiveCamera || camera.viewport !== undefined ||
        uniforms.uDepthValid.value < 0.5 || !uniforms.tDepth.value ||
        !renderer.extensions?.has?.('EXT_color_buffer_float')) return false;
    const width = Math.max(1, Math.ceil(current.width * this.scale));
    const height = Math.max(1, Math.ceil(current.height * this.scale));
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false,
      });
      this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
      this.target.texture.generateMipmaps = false;
      this.checkFramebuffer = true;
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
      this.checkFramebuffer = true;
    }
    const saved = {
      target: current, face: renderer.getActiveCubeFace?.() || 0, mip: renderer.getActiveMipmapLevel?.() || 0,
      viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(), clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear, xr: renderer.xr.enabled,
      shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate,
      infoAutoReset: renderer.info.autoReset, resolution: uniforms.uRes.value.clone(),
    };
    this.inPass = true;
    let succeeded = false;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.info.autoReset = false;
      uniforms.uRes.value.set(width, height);
      renderer.setRenderTarget(this.target);
      renderer.setViewport(0, 0, width, height);
      renderer.setScissor(0, 0, width, height);
      renderer.setScissorTest(false);
      if (this.checkFramebuffer) {
        const gl = renderer.getContext();
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Half-float volume framebuffer is unavailable');
        this.checkFramebuffer = false;
      }
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(this.scene, camera);
      succeeded = true;
      this.stats.renders++;
      this.stats.raymarchPixels += width * height;
      this.stats.fullSizePixels += current.width * current.height;
    } catch (error) {
      this.failed = true;
      this.stats.failures++;
      console.warn('[clouds] half-resolution pass unavailable; preserving original volume shader', error);
    } finally {
      uniforms.uRes.value.copy(saved.resolution);
      renderer.setRenderTarget(saved.target, saved.face, saved.mip);
      renderer.setViewport(saved.viewport);
      renderer.setScissor(saved.scissor);
      renderer.setScissorTest(saved.scissorTest);
      renderer.setClearColor(saved.clearColor, saved.clearAlpha);
      renderer.autoClear = saved.autoClear;
      renderer.xr.enabled = saved.xr;
      renderer.shadowMap.autoUpdate = saved.shadowAuto;
      renderer.shadowMap.needsUpdate = saved.shadowNeeds;
      renderer.info.autoReset = saved.infoAutoReset;
      this.inPass = false;
    }
    if (succeeded) {
      uniforms.tVolumeLow.value = this.target.texture;
      uniforms.uVolumeLowRes.value.set(width, height);
      uniforms.uVolumeCached.value = 1;
    } else {
      this.target?.dispose(); this.target = null;
      uniforms.tVolumeLow.value = null;
    }
    this.material.uniformsNeedUpdate = true;
    return succeeded;
  }

  dispose() {
    this.failed = true;
    this.state = null;
    this.material.uniforms.uVolumeCached.value = 0;
    this.material.uniforms.tVolumeLow.value = null;
    this.target?.dispose(); this.target = null;
    this.rayMaterial.dispose();
    // The fullscreen geometry belongs to the original volume mesh.
  }
}
