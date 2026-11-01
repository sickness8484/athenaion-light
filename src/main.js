// Entry point.
//   Interactive:  http://localhost:8080/?shot=3&quality=preview      (orbit with mouse; keys 1-9 jump to shots; P prints camera)
//   Offline:      driven by tools/render.mjs (mode=still) which calls window.__renderShot(id)
//   Module test:  ?test=temple&view=0   renders src/modules/temple.js test() in a neutral scene
import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { getQuality, withRuntimeProfile } from './core/quality.js';
import { getRuntimeProfile, viewportSize } from './core/performance.js';
import { SHOTS } from './world/shots.js';

const P = new URLSearchParams(location.search);
const mobile = matchMedia('(pointer: coarse)').matches;
const profile = getRuntimeProfile(P.get('profile') || 'auto', mobile);
const MODULE_NAMES = { terrain:'地形',water:'海と川',temple:'神殿',acropolis:'城塞と階段',aqueducts:'水道橋',sets:'前景',statues:'彫刻',city:'街並み',ruins:'遺跡',banners:'旗と灯火',vegetation:'樹木',flora:'草花',waterfalls:'滝',clouds:'雲',birds:'鳥' };
function stage(text, value) {
  document.getElementById('load-stage').textContent = text;
  document.getElementById('load-progress').value = value;
}
function showError(error) {
  console.error(error);
  window.__RENDER_ERROR = error?.stack || error?.message || String(error);
  document.getElementById('loading').hidden = false;
  document.getElementById('load-stage').textContent = '3Dを表示できませんでした';
  document.getElementById('load-progress').hidden = true;
  const text = error?.code === 'BAKED_ASSET_UNAVAILABLE'
    ? '風景データを読み込めませんでした。接続を確認して再読み込みしてください。'
    : /WebGL|context|GPU/i.test(error?.message || '')
      ? 'WebGL 2が利用できません。ブラウザのハードウェアアクセラレーションを有効にして、再読み込みしてください。'
      : '読み込み中にエラーが発生しました。再読み込みしても続く場合は、次の内容を報告してください。\n' + (error?.message || String(error));
  document.getElementById('load-detail').textContent = text;
  const retry = document.getElementById('retry'); retry.hidden = false; retry.onclick = () => location.reload();
}


async function boot() {
  const mode = P.get('mode') || 'interactive';
  const baseQuality = getQuality(P.get('quality') || 'preview');
  const quality = mode === 'interactive' ? withRuntimeProfile(baseQuality, profile) : baseQuality;
  if (P.get('spp')) quality.spp = Number(P.get('spp'));
  const initial = viewportSize(innerWidth, innerHeight, profile.pixelBudget, profile.movingScale);
  const W = Number(P.get('w')) || (mode === 'interactive' ? initial.width : 1672);
  const H = Number(P.get('h')) || (mode === 'interactive' ? initial.height : 941);
  if (mode === 'interactive') document.body.classList.add('interactive');

  const engine = await createEngine({ width: W, height: H, quality, params: P });
  window.engine = engine;
  engine.onProgress = ({ name, index, total }) => stage(`${MODULE_NAMES[name] || name}を準備中 (${index + 1}/${total})`, index + 1);
  engine.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); window.__stopInteractive?.(); showError(new Error('WebGL context lost')); });
  const t0 = performance.now();

  let testInfo = null;
  if (P.get('test')) {
    const { buildTestScene } = await import('./test/testScene.js');
    testInfo = await buildTestScene(engine, P.get('test'), Number(P.get('view') || 0));
  } else {
    const { buildWorld } = await import('./world/index.js');
    await buildWorld(engine);
  }
  stage('光と空を準備中', 16);
  engine.prepareScene({ deferEnvironment: true });
  const buildMs = Math.round(performance.now() - t0);
  window.__STATS = { buildMs };
  console.log(`[main] world built in ${buildMs} ms`);


  const shotById = (id) => SHOTS.find((s) => String(s.id) === String(id));

  window.__renderShot = async (id) => {
    const s = shotById(id);
    if (!s) throw new Error('unknown shot ' + id);
    engine.applyShot(s);
    return await engine.renderStill(quality.spp);
  };
  // used by tools/session.mjs (persistent render session for camera direction / look-dev)
  window.__SHOTS = SHOTS;
  window.__renderShotObj = async (s, spp) => {
    engine.applyShot(s);
    return await engine.renderStill(spp ?? quality.spp);
  };
  // GPU profiler: time per sample with each module hidden in turn (tools/session.mjs + snap --eval)
  window.__profile = async (shotId, spp = 2) => {
    engine.applyShot(shotById(shotId));
    const time = async () => { await engine.renderStill(spp); return engine.stats.renderMs / spp; };
    await time(); // warm-up (lazy shader compiles)
    const base = await time();
    const rows = [];
    const tris = (objs) => { let t = 0; for (const o of objs) o.traverse((m) => { if (!m.isMesh || !m.geometry) return; const g = m.geometry; const n = (g.index ? g.index.count : g.attributes.position?.count || 0) / 3; t += n * (m.isInstancedMesh ? m.count : 1); }); return t; };
    for (const [name, roots] of Object.entries(engine.moduleRoots || {})) {
      const vis = roots.map((r) => r.visible);
      roots.forEach((r) => (r.visible = false));
      const ms = await time();
      roots.forEach((r, i) => (r.visible = vis[i]));
      rows.push({ module: name, msSaved: Math.round(base - ms), mTris: +(tris(roots) / 1e6).toFixed(2), objects: roots.length });
    }
    rows.sort((a, b) => b.msSaved - a.msSaved);
    return { shot: shotId, msPerSample: Math.round(base), calls: engine.stats.calls, mTrisDrawn: +((engine.stats.triangles || 0) / 1e6).toFixed(1), rows };
  };
  // video frame renderer (tools/render-video.mjs)
  if (!P.get('test')) { const { setupVideo } = await import('./video/player.js'); setupVideo(engine, SHOTS); }
  window.__renderTest = async () => {
    engine.applyShot(testInfo.shot);
    return await engine.renderStill(quality.spp);
  };
  // compile everything up front so the first sample isn't a hitch
  if (!P.get('test')) engine.applyShot(shotById(P.get('shot') || 1) || SHOTS[0]);
  else engine.applyShot(testInfo.shot);
  stage('光と影を仕上げています', 17);
  const tc = performance.now();
  await engine.renderer.compileAsync(engine.scene, engine.camera);
  console.log(`[main] shaders compiled in ${Math.round(performance.now() - tc)} ms`);
  window.__READY = true;

  if (mode === 'interactive') {
    const { startInteractive } = await import('./interactive.js');
    await startInteractive(engine, { shotById, shots: SHOTS, profile, params: P, showError });
  } else document.getElementById('loading').hidden = true;
}

boot().catch(showError);
