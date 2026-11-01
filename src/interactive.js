import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AdaptiveResolution, runtimeViewport } from './core/performance.js';
const SHOT_NAMES = ['岩山からの全景','ラグーンと円形神殿','オリーブのテラス','峡谷の上空','神殿の正面','大階段','川と水道橋','倒れた巨像','廃墟の回廊'];
const SETTLE_MS = 220;
export async function startInteractive(engine, { shotById, shots, profile, params, showError }) {
  const $ = (id) => document.getElementById(id);
  const camera = engine.camera;
  const controls = new OrbitControls(camera, engine.canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.minDistance = 0.2; controls.maxDistance = 20000;
  const adaptive = new AdaptiveResolution(profile);
  engine.registry.water?.reflection?.configureUpdatePolicy({ movingIntervalMs: profile.reflectionIntervalMs, animatedIntervalMs: profile.reflectionIntervalMs, maxPositionDelta: 8, maxAngleDelta: 0.08 });
  let dirty = true, pressed = false, animation = params.get('animate') === '1';
  let raf = 0, halted = false, lastChange = performance.now(), lastFrame = 0;
  let lastRendered = 0, wasActive = false, wasRendered = false, frameEMA = 0, hudAt = 0, scale = -1;
  const keys = new Set();
  const forward = new THREE.Vector3(), right = new THREE.Vector3(), delta = new THREE.Vector3();
  const wake = () => { if (!halted && !document.hidden && !raf) raf = requestAnimationFrame(tick); };
  const changed = () => { dirty = true; lastChange = performance.now(); wake(); };
  controls.addEventListener('change', changed);
  controls.addEventListener('start', () => { pressed = true; changed(); });
  controls.addEventListener('end', () => { pressed = false; changed(); });
  const syncTarget = () => { controls.target.set(...engine.shot.target); controls.update(); changed(); };
  const go = (id) => {
    const shot = shotById(id); if (!shot) return;
    engine.applyShot(shot); syncTarget(); $('shot').value = String(shot.id);
    const url = new URL(location.href); url.searchParams.set('shot', shot.id); history.replaceState(null, '', url);
  };
  for (const [index, shot] of shots.entries()) {
    const option = document.createElement('option'); option.value = shot.id; option.textContent = `${shot.id}  ${SHOT_NAMES[index] || shot.name}`; $('shot').appendChild(option);
  }
  $('shot').value = String(engine.shot.id || 1);
  $('shot').addEventListener('change', (event) => go(event.target.value));
  $('profile').value = profile.key;
  $('profile').addEventListener('change', (event) => {
    const url = new URL(location.href); url.searchParams.set('profile', event.target.value);
    url.searchParams.set('shot', engine.shot.id || 1); location.assign(url.href);
  });
  const showMotion = () => { $('motion').setAttribute('aria-pressed', String(animation)); $('motion').textContent = animation ? '動きを止める' : '動きをつける'; };
  $('motion').addEventListener('click', () => { animation = !animation; showMotion(); changed(); }); showMotion();
  $('reset').addEventListener('click', () => go(engine.shot.id || 1));
  $('fullscreen').hidden = !document.fullscreenEnabled;
  $('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { $('status').textContent = 'この環境では全画面にできません'; } });
  $('help-toggle').addEventListener('click', () => { $('help').hidden = !$('help').hidden; $('help-toggle').setAttribute('aria-expanded', String(!$('help').hidden)); });
  syncTarget();
  const formFocused = (event) => /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target?.tagName) || event.target?.isContentEditable;
  addEventListener('keydown', (event) => {
    if (formFocused(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[1-9]$/.test(event.key)) { go(event.key); return; }
    if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight'].includes(event.code)) { keys.add(event.code); event.preventDefault(); changed(); }
  });
  addEventListener('keyup', (event) => { if (keys.delete(event.code)) changed(); });
  addEventListener('blur', () => { keys.clear(); pressed = false; changed(); });
  addEventListener('resize', () => { scale = -1; changed(); });
  document.addEventListener('visibilitychange', () => {
    keys.clear(); pressed = false; lastFrame = lastRendered = 0; wasActive = wasRendered = false;
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else changed();
  });
  window.__stopInteractive = () => { halted = true; cancelAnimationFrame(raf); raf = 0; };
  function moveKeys(dt) {
    if (!keys.size) return false;
    camera.getWorldDirection(forward); forward.y = 0; forward.normalize();
    right.crossVectors(forward, camera.up).normalize(); delta.set(0,0,0);
    if (keys.has('KeyW')) delta.add(forward); if (keys.has('KeyS')) delta.sub(forward);
    if (keys.has('KeyD')) delta.add(right); if (keys.has('KeyA')) delta.sub(right);
    if (keys.has('KeyE')) delta.y += 1; if (keys.has('KeyQ')) delta.y -= 1;
    if (delta.lengthSq() === 0) return false;
    delta.normalize().multiplyScalar(dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 105 : 30));
    camera.position.add(delta); controls.target.add(delta); return true;
  }
  let presented = false;
  function tick(now) {
    raf = 0;
    if (halted || document.hidden) return;
    try {
      const dt = lastFrame ? Math.min(0.06, (now - lastFrame) / 1000) : 0;
      lastFrame = now;
      if (moveKeys(dt)) changed();
      controls.update();
      const moving = pressed || keys.size > 0 || now - lastChange < SETTLE_MS;
      const active = moving || animation;
      const interval = lastRendered ? now - lastRendered : 0;
      // Animation alone must not leave a stationary view at the moving resolution.
      const wantedScale = moving ? adaptive.scale : 1;
      if (scale !== wantedScale) {
        const size = runtimeViewport(innerWidth, innerHeight, profile, wantedScale, window.devicePixelRatio);
        dirty = engine.resize(size.width, size.height) || dirty; scale = wantedScale;
      }
      if (animation) engine.setTime(engine.time + Math.min(0.1, interval / 1000 || 1 / 30));
      const rendered = engine.renderInteractive(dirty || animation, {
        moving, animated: animation, nowMs: now, maxAcc: profile.maxAcc,
        cloudSteps: active ? profile.cloudStepsMoving : engine.quality.cloudSteps,
      });
      dirty = false;
      if (rendered) {
        // A held pointer can keep RAF awake after accumulation has finished. Only consecutive
        // rendered frames measure GPU load; skipped draws are not evidence of a slow device.
        if (active && wasActive && wasRendered && interval > 0 && interval < 2500) {
          if (moving) adaptive.observe(interval, now);
          frameEMA = frameEMA ? frameEMA * 0.85 + interval * 0.15 : interval;
        }
        lastRendered = now;
        window.__PERF = { moving, animated: animation, width: engine.width, height: engine.height, scale, samples: engine._accFrames, movingFps: frameEMA ? 1000 / frameEMA : null, calls: engine.pipeline.sceneInfo?.calls, triangles: engine.pipeline.sceneInfo?.triangles };
      }
      wasActive = active;
      wasRendered = rendered;
      const finished = !active && engine._accFrames >= profile.maxAcc;
      if (now - hudAt > 300 || finished) {
        $('status').textContent = engine.warnings?.length ? `一部の読み込みに失敗 (${engine.warnings.join(', ')})` :
          active ? `${profile.label} · ${frameEMA ? Math.round(1000 / frameEMA) + ' fps' : '操作中'}` : finished ? '静止中 · 描画を休止' : '細部を仕上げています';
        hudAt = now;
      }
      if (rendered && !presented) {
        presented = true; $('loading').hidden = true; $('brand').hidden = false; $('controls').hidden = false;
        window.__FIRST_FRAME_MS = Math.round(performance.now());
      }
      if (active || dirty || !finished) wake();
    } catch (error) { halted = true; cancelAnimationFrame(raf); raf = 0; showError(error); }
  }
  wake();
  return { controls, wake, stop: window.__stopInteractive };
}
