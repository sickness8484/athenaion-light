// Entry point.
//   Interactive:  http://localhost:8080/?shot=3&quality=preview      (orbit with mouse; keys 1-9 jump to shots; P prints camera)
//   Offline:      driven by tools/render.mjs (mode=still) which calls window.__renderShot(id)
//   Module test:  ?test=temple&view=0   renders src/modules/temple.js test() in a neutral scene
import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { getQuality, withRuntimeProfile } from './core/quality.js';
import { getRuntimeProfile, runtimeViewport } from './core/performance.js';
import { SHOTS } from './world/shots.js';
import { clearGeometryCache } from './core/cache.js';
import { prepareCloudTextures } from './core/sky.js';
import { createBootState, awaitGpuFrame } from './core/boot-state.js';

const P = new URLSearchParams(location.search);
const RELEASE = 'v4';
const mode = P.get('mode') || 'interactive';
const mobile = matchMedia('(pointer: coarse)').matches;
const profile = getRuntimeProfile(P.get('profile') || 'auto', mobile);
// Offline tools deliberately become ready before they submit their first shot.
const bootState = mode === 'interactive' ? createBootState({ release: RELEASE, scope: location.pathname }) : null;
let startupError = null, startupComplete = false, lastStage = '';
window.__RELEASE = RELEASE;
window.__READY = false;
const MODULE_NAMES = { terrain:'地形',water:'海と川',temple:'神殿',acropolis:'城塞と階段',aqueducts:'水道橋',sets:'前景',statues:'彫刻',city:'街並み',ruins:'遺跡',banners:'旗と灯火',vegetation:'樹木',flora:'草花',waterfalls:'滝',clouds:'雲',birds:'鳥' };
function stage(text, value) {
  if (startupError) throw startupError;
  lastStage = text;
  bootState?.stage(text);
  document.getElementById('load-stage').textContent = text;
  document.getElementById('load-progress').value = value;
}
function showError(error) {
  // A context-loss event can arrive before an outstanding load/compile rejects.
  // Keep the first failure visible instead of allowing late progress to hide it.
  if (startupError) return;
  startupError = error;
  console.error(error);
  window.__stopInteractive?.();
  window.__READY = false;
  bootState?.fail(error);
  window.__RENDER_ERROR = error?.stack || error?.message || String(error);
  document.getElementById('loading').hidden = false;
  document.getElementById('brand').hidden = true;
  document.getElementById('controls').hidden = true;
  document.getElementById('help').hidden = true;
  const interrupted = error?.code === 'STARTUP_INTERRUPTED';
  document.getElementById('load-stage').textContent = interrupted ? '前回の読み込みが完了しませんでした' : '3Dを表示できませんでした';
  document.getElementById('load-progress').hidden = true;
  const record = bootState?.snapshot();
  const failedStage = startupComplete ? '風景の表示中' : record?.stage || lastStage;
  let text;
  if (interrupted) text = '前回の途中終了を検出したため、ここで読み込みを止めています。再開する場合は、下のボタンを押してください。';
  else if (error?.code === 'BAKED_ASSET_UNAVAILABLE') text = `${/cloud|雲/i.test(failedStage + ' ' + error.message) ? '雲のデータ' : '風景データ'}を読み込めませんでした。接続を確認してもう一度お試しください。`;
  else if (/context.*lost/i.test(error?.message || '')) text = 'ブラウザの3D描画が中断されました。自動では再読み込みしません。再開する場合は、下のボタンを押してください。';
  else if (/GPU frame/i.test(error?.message || '')) text = '最初の画面の描画を完了できませんでした。読み込みを停止しています。もう一度お試しください。';
  else if (/WebGL|context/i.test(error?.message || '')) text = 'この環境で3D描画を開始できませんでした。ブラウザを再起動してもう一度お試しください。';
  else text = '読み込み中にエラーが発生しました。もう一度読み込んでも続く場合は、診断情報をコピーして報告してください。';
  if (failedStage) text += `\n${interrupted ? '前回の段階' : '停止した段階'}: ${failedStage}`;
  document.getElementById('load-detail').textContent = text;
  window.__BOOT_DIAGNOSTICS = {
    release: RELEASE, stage: failedStage, phase: record?.phase || 'failed',
    error: error?.message || String(error), profile: profile.key,
    navigation: performance.getEntriesByType?.('navigation')[0]?.type || 'unknown',
    viewport: [innerWidth, innerHeight, window.devicePixelRatio || 1],
    browser: navigator.userAgent, gpu: window.__GPU_INFO || null,
  };
  const retry = document.getElementById('retry');
  retry.hidden = false;
  retry.onclick = () => { bootState?.reset(); location.reload(); };
  const copy = document.getElementById('copy-error');
  copy.hidden = false;
  copy.onclick = async () => {
    const diagnostic = JSON.stringify(window.__BOOT_DIAGNOSTICS, null, 2);
    try {
      await navigator.clipboard.writeText(diagnostic);
      copy.textContent = 'コピーしました';
    } catch {
      document.getElementById('load-detail').textContent = text + '\n\n' + diagnostic;
      copy.textContent = '診断情報を表示しました';
    }
  };
}


async function boot() {
  if (bootState && !bootState.begin('雲のデータを読み込み中')) {
    const error = new Error('Previous startup did not finish');
    error.code = 'STARTUP_INTERRUPTED';
    showError(error);
    return;
  }
  const baseQuality = getQuality(P.get('quality') || 'preview');
  const quality = mode === 'interactive' ? withRuntimeProfile(baseQuality, profile) : baseQuality;
  if (P.get('spp')) quality.spp = Number(P.get('spp'));
  const initial = runtimeViewport(innerWidth, innerHeight, profile, 1, window.devicePixelRatio);
  const W = Number(P.get('w')) || (mode === 'interactive' ? initial.width : 1672);
  const H = Number(P.get('h')) || (mode === 'interactive' ? initial.height : 941);
  if (mode === 'interactive') document.body.classList.add('interactive');

  stage('雲のデータを読み込み中', 0);
  await prepareCloudTextures({
    onProgress: ({ name, phase }) => stage('雲のデータを読み込み中', (name === 'detail' ? 0.5 : 0) + (phase === 'ready' ? 0.5 : 0)),
  });
  stage('3D描画を準備中', 1);
  const engine = await createEngine({ width: W, height: H, quality, params: P });
  window.engine = engine;
  engine.onProgress = ({ name, index, total }) => stage(`${MODULE_NAMES[name] || name}を準備中 (${index + 1}/${total})`, 2 + (index + 1) / total * 14);
  engine.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); showError(new Error('WebGL context lost')); });
  const t0 = performance.now();

  let testInfo = null;
  stage(P.get('test') ? `${MODULE_NAMES[P.get('test')] || P.get('test')}を準備中` : '風景を組み立てています', 2);
  if (P.get('test')) {
    const { buildTestScene } = await import('./test/testScene.js');
    testInfo = await buildTestScene(engine, P.get('test'), Number(P.get('view') || 0));
  } else {
    const { buildWorld } = await import('./world/index.js');
    await buildWorld(engine);
  }
  // Meshes keep their own buffers; release cache-only LODs before GPU preparation.
  clearGeometryCache();
  stage('光と空を準備中', 17);
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
  stage('空と反射を準備中', 18);
  if (!P.get('test')) engine.applyShot(shotById(P.get('shot') || 1) || SHOTS[0]);
  else engine.applyShot(testInfo.shot);
  stage('光と影を仕上げています', 19);
  const tc = performance.now();
  await engine.compileScene({
    onProgress: ({ completed, total }) => stage(`光と影を仕上げています (${Math.round(completed / total * 100)}%)`, 19),
  });
  console.log(`[main] shaders compiled in ${Math.round(performance.now() - tc)} ms`);
  if (startupError) throw startupError;

  if (mode === 'interactive') {
    stage('最初の画面を描いています', 20);
    const { startInteractive } = await import('./interactive.js');
    if (startupError) throw startupError;
    await startInteractive(engine, {
      shotById, shots: SHOTS, profile, params: P, showError,
      waitForFirstFrame: () => awaitGpuFrame(engine.renderer.getContext()),
      onReady: () => {
        if (startupError) throw startupError;
        bootState.complete();
        startupComplete = true;
        window.__READY = true;
      },
    });
  } else {
    startupComplete = true;
    window.__READY = true;
    document.getElementById('loading').hidden = true;
  }
}

boot().catch(showError);
