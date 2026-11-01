// Runtime budgets change rendering work, never authored geometry.
export const RUNTIME_PROFILES = Object.freeze({
  auto: Object.freeze({ label: '自動', targetFps: 30, movingScale: 1, minScale: 0.85, maxPixelRatio: 2, pixelBudget: 2100000, mobilePixelBudget: 1000000, maxAcc: 32, mobileAcc: 16, msaa: 0, shadowMapSize: 2048, shadowIntervalMs: 65, cloudStepsMoving: 8, cloudStepsStill: 16, reflectionIntervalMs: 80 }),
  quality: Object.freeze({ label: '画質優先', targetFps: 30, movingScale: 1, minScale: 1, maxPixelRatio: 2, pixelBudget: 2600000, mobilePixelBudget: 1500000, maxAcc: 64, mobileAcc: 32, msaa: 0, shadowMapSize: 2048, shadowIntervalMs: 40, cloudStepsMoving: 16, cloudStepsStill: 16, reflectionIntervalMs: 50 }),
  fast: Object.freeze({ label: '軽さ優先', targetFps: 30, movingScale: 1, minScale: 0.8, maxPixelRatio: 1.5, pixelBudget: 1100000, mobilePixelBudget: 650000, maxAcc: 16, mobileAcc: 12, msaa: 0, shadowMapSize: 1024, shadowIntervalMs: 100, cloudStepsMoving: 6, cloudStepsStill: 12, reflectionIntervalMs: 120 }),
});
export function getRuntimeProfile(name = 'auto', mobile = false) {
  const key = Object.hasOwn(RUNTIME_PROFILES, name) ? name : 'auto';
  const p = RUNTIME_PROFILES[key];
  return { ...p, key, mobile, pixelBudget: mobile ? p.mobilePixelBudget : p.pixelBudget, maxAcc: mobile ? p.mobileAcc : p.maxAcc };
}
export function viewportSize(width, height, budget, scale = 1, pixelRatio = 1) {
  const w = Number.isFinite(width) ? Math.max(1, width) : 1;
  const h = Number.isFinite(height) ? Math.max(1, height) : 1;
  const dpr = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  const pixels = Number.isFinite(budget) ? Math.max(1, budget) : w * h * dpr * dpr;
  const s = Math.min(dpr, Math.sqrt(pixels / (w * h))) * Math.min(1, Math.max(0.1, Number.isFinite(scale) ? scale : 1));
  return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)) };
}
// CSS pixels alone under-resolve phone/Retina screens even when the device can draw more.
// Cap physical pixels once, then allow only a small, bounded adjustment while the camera moves.
export function runtimeViewport(width, height, profile, scale = 1, devicePixelRatio = 1) {
  const dpr = Number.isFinite(devicePixelRatio) ? Math.max(1, devicePixelRatio) : 1;
  return viewportSize(width, height, profile.pixelBudget, scale, Math.min(profile.maxPixelRatio || 1, dpr));
}
// Exclude idle/tab-suspension intervals; change scale slowly to avoid oscillation.
export class AdaptiveResolution {
  constructor(profile) { this.reset(profile); }
  reset(profile) {
    this.profile = profile; this.scale = profile.movingScale;
    this.ema = 1000 / profile.targetFps; this.samples = 0;
    this.lastChange = -Infinity; this.slow = 0; this.fast = 0;
  }
  observe(dt, now) {
    if (!Number.isFinite(dt) || dt < 4 || dt > 2500) return false;
    this.ema += (dt - this.ema) * 0.18; this.samples++;
    const target = 1000 / this.profile.targetFps;
    this.slow = this.ema > target * 1.18 ? this.slow + 1 : 0;
    this.fast = this.ema < target * 0.72 ? this.fast + 1 : 0;
    if (this.samples < 12 || now - this.lastChange < 1200) return false;
    let next = this.scale;
    if (this.slow >= 8) next = Math.max(this.profile.minScale, this.scale - 0.05);
    else if (this.fast >= 20) next = Math.min(this.profile.movingScale, this.scale + 0.05);
    next = Math.round(next * 100) / 100;
    if (next === this.scale) return false;
    this.scale = next; this.lastChange = now; this.slow = this.fast = 0;
    return true;
  }
}
