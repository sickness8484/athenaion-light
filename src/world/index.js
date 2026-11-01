// Builds the full world by running each module's build(engine) in dependency order.
// Optional module failures are reported; missing declared baked data is fatal.
// Order matters: terrain → architecture (registers footprints) → city → vegetation (avoids footprints).
export const MODULE_ORDER = [
  'terrain',      // ground mesh, cliffs, far mountains
  'water',        // sea, lagoon, river surfaces
  'temple',       // main Athenaion + other classical buildings at layout anchors
  'acropolis',    // terraces, retaining walls, grand stair, plazas, mosaics, balustrades
  'aqueducts',    // aqueducts & bridges
  'sets',         // shot-specific foreground sets (terraces, balustrades, props) — push slots for statues/banners
  'statues',      // colossi + statues on pedestals + pediment sculpture placement
  'city',         // town houses, harbour, boats
  'ruins',        // ruined portico, fallen columns, giant head (foreground sets)
  'banners',      // banners with owl emblem, braziers & fire, urns
  'vegetation',   // cypress, olive, pines, broadleaf trees, shrub masses
  'flora',        // ivy, grass, flowers, moss, hero foreground branches & rocks
  'waterfalls',   // waterfalls, foam, spray & mist
  'clouds',       // mountain clouds, valley mist banks
  'birds',        // seagulls
];

export async function buildWorld(engine) {
  const skip = (engine.params.get('skip') || '').split(',').filter(Boolean);
  const only = (engine.params.get('only') || '').split(',').filter(Boolean);
  const wanted = MODULE_ORDER.filter((name) => !skip.includes(name) && (!only.length || only.includes(name)));
  for (const [index, name] of wanted.entries()) {
    engine.onProgress?.({ name, index, total: wanted.length });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (skip.includes(name) || (only.length && !only.includes(name))) continue;
    let mod;
    try {
      mod = await import(`../modules/${name}.js`);
    } catch (e) {
      if (e.code === 'BAKED_ASSET_UNAVAILABLE' || name === 'terrain') throw e;
      (engine.warnings ||= []).push(name);
      console.error(`[world] module ${name} failed to load:`, e.stack || e);
      continue;
    }
    if (typeof mod.build !== 'function') continue;
    const t0 = performance.now();
    const before = new Set(engine.scene.children);
    try {
      await mod.build(engine);
      (engine.moduleRoots ||= {})[name] = engine.scene.children.filter((c) => !before.has(c));
      console.log(`[world] ${name} built in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      if (e.code === 'BAKED_ASSET_UNAVAILABLE' || name === 'terrain') throw e;
      (engine.warnings ||= []).push(name);
      console.error(`[world] module ${name} threw during build:`, e.stack || e);
    }
  }
}
