// ============================================================
// Kaawen sky — the chart as a 3D scene
// ============================================================
// The same computed longitudes the flat wheel draws, placed around
// the ecliptic plane in the old geocentric order (Moon nearest,
// Pluto furthest — the seven heavens, extended). This module is
// imported only when the 3D view is first opened, so the landing page
// never pays for it. It knows nothing of the page: the chart context,
// the DOM nodes it may draw into and the selection callback all
// arrive as arguments, and everything it returns is the same handle
// shape the page has always used.
//
//   buildSky3D({ ctx, host, canvas, signs, order, glyphs, onPick, track })
//     → handle | null
//
// Backend access goes through RendererManager only (js/sky-renderer.js).

import { SKY_QUALITY_PROFILES, skyQualityTier, SKY_PRESSURE, SKY_DEV,
         skyReducedMotion } from './sky-quality.js';
import { SKY_TEX_GEN } from './sky-noise.js';
import { rendererManager } from './sky-renderer.js';

const SKY_RADII = {
  Moon: 34, Mercury: 46, Venus: 58, Sun: 70, Mars: 84,
  Jupiter: 100, Saturn: 116, Uranus: 132, Neptune: 146, Pluto: 160
};
const SKY_SIZE = {
  Sun: 7, Moon: 6, Mercury: 4.2, Venus: 4.8, Mars: 4.4,
  Jupiter: 5.6, Saturn: 5.2, Uranus: 4, Neptune: 4, Pluto: 3.6
};
const SKY_COLOR = {
  Sun: 0xF2C97A, Moon: 0xF4EBD6, Mercury: 0xD4A655, Venus: 0xE0B978,
  Mars: 0xD89580, Jupiter: 0xD4A655, Saturn: 0xC49A55,
  Uranus: 0xAC9F87, Neptune: 0x9FA8B5, Pluto: 0x9A8E78
};
const SKY_ASPECT_COLOR = {
  fusion: 0xD4A655, flow: 0x8C6F3A, friction: 0xD89580, mirror: 0xAC9F87
};
const SKY_R_ZODIAC = 196;

let current = null;    // the live sky handle, for Worker deliveries

// The scene and camera objects persist like the renderer: a rebuilt
// chart empties and repopulates them rather than replacing them. The
// WebGPU post chain caches render contexts by scene/camera identity,
// and swapping objects strands those caches on disposed resources —
// stable identities keep every cache honest.
let skyScene = null;
let skyCamera = null;

// ── Planet surfaces ───────────────────────────────────────────
// Procedural, so no image is ever fetched. Multi-octave value noise
// gives each body real high-frequency detail — up close they read as
// surfaces rather than flat discs — and the gas giants get banding.
// The maths lives in js/sky-noise.js so the Worker runs the identical
// code: the main thread paints a small instant preview, the full
// surface is computed off-thread and arrives as raw pixels, and each
// body sharpens in place. Cached across rebuilds — there are only
// ever ten.
const SKY_TEX_CACHE = {};
const SKY_SURFACE = {
  Sun:     { bands: 0, grain: 0.10, contrast: 0.20 },
  Moon:    { bands: 0, grain: 0.62, contrast: 0.52 },  // cratered
  Mercury: { bands: 0, grain: 0.58, contrast: 0.46 },
  Venus:   { bands: 3, grain: 0.30, contrast: 0.24 },  // thick cloud
  Mars:    { bands: 0, grain: 0.55, contrast: 0.44 },
  // Jupiter is the Phase 3 showcase: domain-warped two-tone banding
  // from the worker, 2048² on capable tiers, and the TSL
  // PlanetMaterial on the WebGPU path (see js/sky-materials.js).
  Jupiter: { bands: 9, grain: 0.26, contrast: 0.40, warp: 1.2, tone: 0.5,
             texSize: 2048, material: 'planet', detail: 0.09, detailScale: 10,
             // NASA/JPL-Caltech PIA07782 — Cassini's cylindrical map of
             // Jupiter (Dec 2000 flyby), public domain, resized to 2048².
             // Albedo only; relief stays procedural. Loads progressively —
             // the worker surface shows until the survey arrives.
             mapUrl: 'assets/jupiter-cassini.jpg' },
  Saturn:  { bands: 7, grain: 0.22, contrast: 0.34 },
  Uranus:  { bands: 4, grain: 0.16, contrast: 0.20 },
  Neptune: { bands: 5, grain: 0.20, contrast: 0.26 },
  Pluto:   { bands: 0, grain: 0.60, contrast: 0.50 }
};

let skyTexTHREE = null;     // pinned by the first build; the module never unloads
let skyTexWorker;           // undefined = untried, false = unavailable
const skyTexPending = {};
let skyTexFallbackAt = 0;

function skyTexWorkerGet() {
  if (skyTexWorker !== undefined) return skyTexWorker;
  try {
    skyTexWorker = new Worker(new URL('./sky-textures-worker.js', import.meta.url),
                              { type: 'module' });
    skyTexWorker.onmessage = e => skyTexArrived(e.data.planet, e.data.d, e.data.S);
    skyTexWorker.onerror = () => {
      skyTexWorker = false;
      Object.keys(skyTexPending).forEach(k => delete skyTexPending[k]);
    };
  } catch (e) { skyTexWorker = false; }
  return skyTexWorker;
}

function skyTexMake(THREE, data, S) {
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.flipY = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}

function skyTexArrived(planet, data, S) {
  delete skyTexPending[planet];
  if (!skyTexTHREE) return;
  const old = SKY_TEX_CACHE[planet];
  const tex = skyTexMake(skyTexTHREE, data, S);
  SKY_TEX_CACHE[planet] = { tex, size: S };
  if (current) current.applyTexture(planet, tex);
  if (old && old.preview) old.tex.dispose();
}

function skyTexRequest(planet, hex, cfg, size) {
  if (skyTexPending[planet]) return;
  skyTexPending[planet] = true;
  const w = skyTexWorkerGet();
  if (w) {
    w.postMessage({ planet, hex, cfg, S: size });
  } else {
    // No Worker here: generate at a friendlier size, one body per
    // timeout, so the cost is spread instead of one long freeze.
    const S = Math.min(size, 512);
    const now = performance.now();
    skyTexFallbackAt = Math.max(now, skyTexFallbackAt) + 260;
    setTimeout(() => skyTexArrived(planet, SKY_TEX_GEN(planet, hex, cfg, S), S),
               skyTexFallbackAt - now);
  }
}

function planetTexture(THREE, planet, hex, size) {
  const hit = SKY_TEX_CACHE[planet];
  if (hit && hit.size >= size) return hit.tex;
  const cfg = SKY_SURFACE[planet] || { bands: 0, grain: 0.4, contrast: 0.35 };
  if (!hit) {
    // ~3ms preview so the sky appears at once; the real surface follows
    const PS = 128;
    SKY_TEX_CACHE[planet] = { tex: skyTexMake(THREE, SKY_TEX_GEN(planet, hex, cfg, PS), PS),
                              size: PS, preview: true };
  }
  skyTexRequest(planet, hex, cfg, size);
  return SKY_TEX_CACHE[planet].tex;
}

// Real survey maps (per-planet, from authoritative sources), kept
// across rebuilds like the procedural cache — decoded once per session.
const SKY_MAP_CACHE = {};
function loadRealMap(THREE, planet, url, onReady) {
  const hit = SKY_MAP_CACHE[planet];
  if (hit) { onReady(hit); return; }
  new THREE.TextureLoader().load(url, t => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 16;
    SKY_MAP_CACHE[planet] = t;
    onReady(t);
  }, undefined, () => { /* offline — the procedural surface stands */ });
}

// Radial falloff used for the body glows — one texture, tinted per
// planet, always facing the camera so it never shows an edge.
let SKY_GLOW_TEX = null;
function glowTexture(THREE) {
  if (SKY_GLOW_TEX) return SKY_GLOW_TEX;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.60)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.26)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.07)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  SKY_GLOW_TEX = new THREE.CanvasTexture(c);
  return SKY_GLOW_TEX;
}

// Text as a sprite — canvas texture keeps glyphs crisp at any zoom.
function skyLabel(THREE, text, px, color, weight) {
  const pad = 8, size = px * 3;               // 3× for retina crispness
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = `${weight || 400} ${size}px Manrope, sans-serif`;
  c.width = Math.ceil(g.measureText(text).width) + pad * 2;
  c.height = size + pad * 2;
  const g2 = c.getContext('2d');
  g2.font = `${weight || 400} ${size}px Manrope, sans-serif`;
  g2.fillStyle = color;
  g2.textAlign = 'center';
  g2.textBaseline = 'middle';
  g2.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false
  }));
  sp.scale.set(c.width / 3 * 0.55, c.height / 3 * 0.55, 1);
  return sp;
}

export async function buildSky3D({ ctx, host, canvas, signs, order, glyphs, onPick, track }) {
  const TIER = skyQualityTier();
  const Q = SKY_QUALITY_PROFILES[TIER];
  const baseDPR = Math.min(window.devicePixelRatio || 1, Q.maxDPR);

  // The RendererManager picks the backend — WebGPU when it initializes
  // cleanly, the classic WebGL2 chain otherwise — and hands back the
  // matching three namespace. The rest of the engine never knows which
  // one it got. Density comes from the quality tier, and the frame
  // governor may pull it down further under measured pressure.
  let rm;
  try {
    rm = await rendererManager.initialize(canvas,
      { baseDPR, bloom: Q.bloom, dev: SKY_DEV, tier: TIER });
  } catch (e) {
    return null;
  }
  const THREE = rm.THREE;
  skyTexTHREE = THREE;

  const rot = (ctx.hasTime && ctx.rising) ? ctx.rising.longitude : 0;
  // Ascendant to the left, longitudes running counterclockwise —
  // the same sense as the flat wheel.
  const at = (lon, r, y) => {
    const a = Math.PI - (lon - rot) * Math.PI / 180;
    return new THREE.Vector3(Math.cos(a) * r, y || 0, Math.sin(a) * r);
  };

  if (!skyScene) {
    skyScene = new THREE.Scene();
    skyCamera = new THREE.PerspectiveCamera(42, 1, 1, 3000);
  }
  const scene = skyScene;
  const camera = skyCamera;
  await rm.attach(scene, camera);
  rm.setPixelRatio(baseDPR);        // shed any old governor pressure
  rm.setBloom(true);

  // The node-based PlanetMaterial exists only on the WebGPU path; the
  // WebGL2 fallback keeps the proven Phase 2 material untouched.
  let MATS = null;
  if (rm.getBackend() === 'webgpu') {
    try {
      MATS = await import('./sky-materials.js');
      await MATS.loadTSL();
    } catch (e) { MATS = null; }
  }

  const groups = {
    orbits:  new THREE.Group(),
    aspects: new THREE.Group(),
    zodiac:  new THREE.Group(),
    houses:  new THREE.Group(),
    stars:   new THREE.Group()
  };
  Object.values(groups).forEach(g => scene.add(g));

  // ── Stars ──────────────────────────────────────────────────
  const starGeo = new THREE.BufferGeometry();
  const starCount = Q.stars;
  const starPos = [];
  for (let i = 0; i < starCount; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), R = 700 + Math.random() * 500;
    starPos.push(R * Math.sin(ph) * Math.cos(th), R * Math.cos(ph), R * Math.sin(ph) * Math.sin(th));
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  groups.stars.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0xF4EBD6, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.55
  })));

  // ── Zodiac band: 12 divisions with their names ─────────────
  for (let i = 0; i < 12; i++) {
    const lon = i * 30;
    const div = [at(lon, SKY_R_ZODIAC - 14), at(lon, SKY_R_ZODIAC + 14)];
    groups.zodiac.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(div),
      new THREE.LineBasicMaterial({ color: 0x8C6F3A, transparent: true, opacity: 0.5 })));
    const label = skyLabel(THREE, signs[i].toUpperCase(), 11, 'rgba(212,166,85,0.85)', 500);
    label.position.copy(at(lon + 15, SKY_R_ZODIAC + 30, 0));
    groups.zodiac.add(label);
  }
  // The ecliptic ring itself. (A Line strip, not a LineLoop: the point
  // list already closes on itself, and WebGPU has no loop primitive —
  // LineLoop simply vanishes on that backend.)
  const ring = [];
  for (let d = 0; d <= 360; d += 2) ring.push(at(d, SKY_R_ZODIAC));
  groups.zodiac.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ring),
    new THREE.LineBasicMaterial({ color: 0xD4A655, transparent: true, opacity: 0.35 })));

  // ── Houses: spokes from the centre, numbered (needs a birth time) ──
  if (ctx.hasTime && ctx.rising) {
    const risingIdx = signs.indexOf(ctx.rising.sign);
    for (let n = 1; n <= 12; n++) {
      const lon = ((risingIdx + n - 1) % 12) * 30;
      groups.houses.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([at(lon, 16), at(lon, SKY_R_ZODIAC - 16)]),
        new THREE.LineDashedMaterial({ color: 0xAC9F87, transparent: true, opacity: 0.22,
                                       dashSize: 4, gapSize: 7 })).computeLineDistances());
      const num = skyLabel(THREE, String(n), 10, 'rgba(172,159,135,0.75)', 400);
      num.position.copy(at(lon + 15, 176, 0));
      groups.houses.add(num);
    }
  }

  // ── Orbit rings + the planets themselves ───────────────────
  const pickable = [];
  const planetMeshes = {};
  order.forEach(p => {
    const r = SKY_RADII[p];
    const circle = [];
    for (let d = 0; d <= 360; d += 3) circle.push(at(d, r));
    // Self-closing strip — see the ecliptic ring note on LineLoop.
    groups.orbits.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(circle),
      new THREE.LineBasicMaterial({ color: 0x8C6F3A, transparent: true, opacity: 0.16 })));

    const pos = at(ctx.positions[p], r);
    // The Sun is its own light source, so it stays unshaded; every
    // other body is lit by it and carries a textured surface.
    const cfg = SKY_SURFACE[p] || {};
    // A body may ask for a larger surface than the tier default, but
    // only on tiers that already carry full-size textures.
    const texSize = (cfg.texSize && Q.texSize >= 1024) ? cfg.texSize : Q.texSize;
    const tex = planetTexture(THREE, p, SKY_COLOR[p], texSize);
    const mat = (p === 'Sun')
      ? new THREE.MeshBasicMaterial({ map: tex, color: SKY_COLOR[p] })
      : (MATS && cfg.material === 'planet')
        ? MATS.createPlanetMaterial(THREE, {
            map: tex, color: SKY_COLOR[p],
            bumpScale: cfg.bands ? 0.4 : 0.9,
            radius: SKY_SIZE[p], detail: cfg.detail, detailScale: cfg.detailScale
          })
        : new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.92, metalness: 0.02,
            // the same noise drives relief, so the terminator breaks up
            // along real surface rather than a clean arc
            bumpMap: tex, bumpScale: cfg.bands ? 0.4 : 0.9,
            emissive: SKY_COLOR[p], emissiveMap: tex, emissiveIntensity: 0.4
          });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_SIZE[p], Q.seg[0], Q.seg[1]), mat);
    mesh.rotation.z = 0.22;           // a little axial tilt
    mesh.userData.spin = 0.072 + Math.random() * 0.096;   // rad/s
    mesh.position.copy(pos);
    mesh.userData.planet = p;
    scene.add(mesh);
    pickable.push(mesh);
    planetMeshes[p] = mesh;

    // Bodies with a real survey map upgrade their albedo when it lands;
    // the worker's procedural surface remains the relief and the
    // instant fallback. PlanetMaterial path only.
    if (MATS && cfg.material === 'planet' && cfg.mapUrl && Q.texSize >= 1024) {
      loadRealMap(THREE, p, cfg.mapUrl, t => {
        mesh.material.userData.texNode.value = t;
        mesh.material.emissiveMap = t;
        mesh.material.needsUpdate = true;
      });
    }

    // A soft halo so each body reads against the black. A billboard
    // with a radial falloff rather than a low-poly sphere — the old
    // mesh showed its facets as a hard-edged disc once you flew in.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(THREE),
      color: SKY_COLOR[p],
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    halo.scale.setScalar(SKY_SIZE[p] * 7.5);
    halo.position.copy(pos);
    scene.add(halo);

    // Glyph floating just above the body
    const glyph = skyLabel(THREE, glyphs[p] + (ctx.wheelPlacements[p].retro ? ' ℞' : ''),
                           13, '#F4EBD6', 400);
    glyph.position.copy(pos).add(new THREE.Vector3(0, SKY_SIZE[p] + 9, 0));
    scene.add(glyph);

    // A dropped line to the ecliptic plane keeps depth legible
    groups.orbits.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([at(ctx.positions[p], r - 6), at(ctx.positions[p], r + 6)]),
      new THREE.LineBasicMaterial({ color: SKY_COLOR[p], transparent: true, opacity: 0.5 })));
  });

  // ── Aspect lines, drawn body to body ───────────────────────
  // THREE.Line is clamped to one pixel on almost every platform, so
  // the connections looked thin and aliased. Line2 builds them as
  // geometry: real width, properly anti-aliased, and the tighter the
  // aspect the heavier its thread.
  const lineMats = [];
  let L2 = null;
  try {
    if (rm.getBackend() === 'webgpu') {
      // The WebGPU line addon: same geometry, node-based material that
      // reads the viewport itself — no resolution uniform to sync.
      const [{ Line2 }, { LineGeometry }] = await Promise.all([
        import('three/addons/lines/webgpu/Line2.js'),
        import('three/addons/lines/LineGeometry.js')
      ]);
      L2 = { Line2, LineGeometry, node: true };
    } else {
      const [a1, a2, a3] = await Promise.all([
        import('three/addons/lines/Line2.js'),
        import('three/addons/lines/LineMaterial.js'),
        import('three/addons/lines/LineGeometry.js')
      ]);
      L2 = { Line2: a1.Line2, LineMaterial: a2.LineMaterial, LineGeometry: a3.LineGeometry };
    }
  } catch (e) { L2 = null; }

  ctx.aspects.forEach(a => {
    const p1 = at(ctx.positions[a.a], SKY_RADII[a.a]);
    const p2 = at(ctx.positions[a.b], SKY_RADII[a.b]);
    const color = SKY_ASPECT_COLOR[a.kind] || 0xAC9F87;
    const opacity = 0.28 + a.strength * 0.5;
    let line;
    if (L2) {
      const geo = new L2.LineGeometry();
      geo.setPositions([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
      let mat;
      if (L2.node) {
        mat = new THREE.Line2NodeMaterial({
          color, transparent: true, opacity,
          linewidth: 1.1 + a.strength * 2.4,   // device pixels
          alphaToCoverage: true
        });
      } else {
        mat = new L2.LineMaterial({
          color, transparent: true, opacity,
          linewidth: 1.1 + a.strength * 2.4,   // device pixels
          dashed: false, alphaToCoverage: true
        });
        mat.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1);
        lineMats.push(mat);
      }
      line = new L2.Line2(geo, mat);
      line.computeLineDistances();
    } else {
      line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([p1, p2]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    }
    line.userData.pair = [a.a, a.b];
    line.userData.baseOpacity = opacity;
    groups.aspects.add(line);
  });

  // Earth at the centre — the observer
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(6, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x5A4A8C })));

  // The Sun in the chart actually lights the other bodies, so their
  // near sides brighten and their far sides fall into shadow.
  scene.add(new THREE.AmbientLight(0xF4EBD6, 0.5));
  const sunLight = new THREE.PointLight(0xFFE9BE, 2.6, 0, 0);
  sunLight.position.copy(at(ctx.positions.Sun, SKY_RADII.Sun));
  scene.add(sunLight);

  // ── Camera + hand-rolled orbit controls ────────────────────
  // Framed so the whole zodiac ring and its names sit inside the
  // canvas at rest: at a 42° field of view, the ring's outer edge
  // (~230 units with labels) needs roughly 620 units of distance.
  // The camera orbits a target that can move: at rest it is the
  // observer at the centre, and when a body is chosen it travels to
  // that body, so choosing a planet flies the sky to it.
  // Motion is expressed in rates per second and applied through
  // 1 − e^(−rate·dt), so a flight covers the same ground in the same
  // time at 30, 60 or 120Hz. The rates match the feel the old
  // per-frame constants had at 60fps.
  const REDUCED = skyReducedMotion();
  const MOTION = {
    rest: 0.72,                              // settle rate between flights, 1/s
    flight: 5.7,                             // full flight rate, 1/s
    zoom: 9,                                 // wheel response, 1/s
    spool: 18,                               // how fast a flight gathers, 1/s²
    scale: 7.7,                              // selection swell rate, 1/s
    drift: REDUCED ? 0 : 0.036               // idle turn, rad/s
  };
  const cam = {
    theta: Math.PI * 0.5, phi: 0.88, radius: 620,
    target: new THREE.Vector3(0, 0, 0),
    wantTarget: new THREE.Vector3(0, 0, 0),
    wantRadius: 620,
    rate: MOTION.rest
  };
  function placeCamera() {
    camera.position.set(
      cam.target.x + cam.radius * Math.sin(cam.phi) * Math.cos(cam.theta),
      cam.target.y + cam.radius * Math.cos(cam.phi),
      cam.target.z + cam.radius * Math.sin(cam.phi) * Math.sin(cam.theta)
    );
    camera.lookAt(cam.target);
  }
  placeCamera();

  // Called from the rail and from any planet selection
  function focusBody(name) {
    const m = planetMeshes[name];
    if (!m) return;
    cam.wantTarget.copy(m.position);
    // Frame the body itself: small bodies are approached closer, so
    // Pluto and the Sun both fill a comparable part of the view.
    cam.wantRadius = Math.max(58, (SKY_SIZE[name] || 5) * 15);
    // Reduced motion asks for arrival, not a voyage
    cam.rate = REDUCED ? 12 : MOTION.rest;
  }
  function releaseFocus() {
    cam.wantTarget.set(0, 0, 0);
    cam.wantRadius = 620;
    cam.rate = REDUCED ? 12 : MOTION.rest;
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    rm.setSize(w, h);
    // Line2 widths are in screen space, so they need the live size
    lineMats.forEach(m => m.resolution.set(w, h));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  const draw = () => rm.render();

  // Save the sky at print resolution: the frame is re-rendered at a
  // multiple of the display size, so the download is far sharper than
  // what is on screen rather than an upscale of it.
  function exportSky(scale) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const prevRatio = rm.renderer.getPixelRatio();
    rm.renderer.setPixelRatio(scale);
    rm.setSize(w, h);
    draw();
    // The readback must happen in the same task as the render — on
    // both backends the frame is gone once the task yields (WebGL
    // without preserveDrawingBuffer, WebGPU after presentation).
    const url = rm.renderer.domElement.toDataURL('image/png');
    rm.renderer.setPixelRatio(prevRatio);
    resize();
    draw();
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kaawen-sky.png';
    a.click();
    track('sky3d_export');
  }

  let drag = null, moved = 0;
  const pointerPos = e => {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  };
  const onDown = e => { drag = pointerPos(e); moved = 0; };
  const onMove = e => {
    if (!drag) return;
    const p = pointerPos(e);
    const dx = p.x - drag.x, dy = p.y - drag.y;
    moved += Math.abs(dx) + Math.abs(dy);
    cam.theta -= dx * 0.006;
    cam.phi = Math.max(0.12, Math.min(Math.PI - 0.12, cam.phi - dy * 0.006));
    drag = p;
    placeCamera();
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => { drag = null; };
  // Zoom moves the *desired* radius; the easing in the render loop
  // carries the camera there. (Writing cam.radius directly here is
  // what broke zoom: the loop resets radius to wantRadius each frame
  // once the camera has settled, so a direct write was overwritten
  // before it was ever drawn.) Proportional steps keep the feel even
  // whether you are beside a planet or out at the zodiac.
  const onWheel = e => {
    const step = cam.wantRadius * (e.deltaY > 0 ? 0.12 : -0.12);
    cam.wantRadius = Math.max(26, Math.min(1400, cam.wantRadius + step));
    cam.rate = Math.max(cam.rate, MOTION.zoom);  // respond promptly to the hand
    if (e.cancelable) e.preventDefault();
  };
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // Tap a planet — same selection pipeline as everywhere else
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const onTap = e => {
    if (moved > 8) return; // that was a drag, not a tap
    const r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickable, false)[0];
    if (hit) onPick(hit.object.userData.planet);
  };
  canvas.addEventListener('click', onTap);

  // ── The loop: one, and alive only while the sky is watched ──
  let running = false, lastT = 0, ema = 0;
  // Governor state — degrade under sustained pressure, recover only
  // after a long calm, and back off if a recovery didn't hold.
  let pressure = 0, lastShift = 0, calmSince = 0, lastUp = -1, upBackoff = 6000;

  function applyPressure() {
    const st = SKY_PRESSURE[pressure];
    rm.setPixelRatio(baseDPR * st.scale);
    rm.setBloom(st.bloom);
    starGeo.setDrawRange(0, Math.floor(starCount * st.stars));
  }

  function govern(now, gap) {
    if (SKY_DEV && window.__skyDev && window.__skyDev.freezeGovernor) return;
    if (gap > 250) return;                    // a pause, not a slow frame
    ema = ema ? ema * 0.92 + gap * 0.08 : gap;
    if (ema >= 17.5) calmSince = now;         // any strain resets the calm clock
    if (now - lastShift < 1600) return;       // let the last change settle
    if (ema > 22 && pressure < SKY_PRESSURE.length - 1) {
      pressure++;
      lastShift = now;
      // A recovery that immediately re-degraded earns a longer wait
      if (lastUp >= 0 && now - lastUp < 12000) upBackoff = Math.min(48000, upBackoff * 2);
      applyPressure();
    } else if (pressure > 0 && now - calmSince > upBackoff) {
      pressure--;
      lastShift = now; lastUp = now; calmSince = now;
      applyPressure();
    }
  }

  // Development-only diagnostics: ?dev=1
  let devEl = null, devAt = 0;
  function devPanel(now) {
    if (now - devAt < 250) return;
    devAt = now;
    if (!devEl) {
      devEl = document.createElement('div');
      devEl.style.cssText = 'position:absolute;left:10px;top:10px;z-index:60;' +
        'font:10px/1.5 ui-monospace,monospace;color:#D4A655;background:rgba(10,9,7,0.72);' +
        'padding:6px 9px;border:1px solid rgba(212,166,85,0.3);border-radius:6px;' +
        'pointer-events:none;white-space:pre;';
      host.appendChild(devEl);
    }
    const i = rm.renderer.info;
    // WebGPU's `calls` is cumulative; `drawCalls` is the per-frame figure
    const calls = (i.render.drawCalls !== undefined) ? i.render.drawCalls : i.render.calls;
    devEl.textContent =
      rm.getBackend() + ' · ' + TIER + ' · step ' + pressure +
      '\nfps ' + (ema ? (1000 / ema).toFixed(0) : '—') + ' · ' + ema.toFixed(1) + 'ms' +
      '\ndpr ' + rm.renderer.getPixelRatio().toFixed(2) + ' / base ' + baseDPR.toFixed(2) +
      '\ncalls ' + calls + ' · tris ' + i.render.triangles +
      '\ngeo ' + i.memory.geometries + ' · tex ' + i.memory.textures;
  }

  function loop(now) {
    const gap = lastT ? now - lastT : 8;
    lastT = now;
    const dt = Math.min(0.05, Math.max(0.0001, gap / 1000));

    // Ease toward whatever the camera has been asked to look at.
    // The rate itself spools up and settles, so a flight starts
    // gently, gathers, and lands rather than snapping.
    const dist = cam.target.distanceTo(cam.wantTarget);
    const dr = Math.abs(cam.radius - cam.wantRadius);
    if (dist > 0.12 || dr > 0.4) {
      cam.rate = REDUCED ? 12 : Math.min(MOTION.flight, cam.rate + MOTION.spool * dt);
      const k = 1 - Math.exp(-cam.rate * dt);
      cam.target.lerp(cam.wantTarget, k);
      cam.radius += (cam.wantRadius - cam.radius) * k;
    } else {
      cam.rate = MOTION.rest;                          // ready for the next
      cam.target.copy(cam.wantTarget);
    }
    // Bodies turn slowly on their own axis — the surface detail moves,
    // which is what sells them as spheres rather than discs — and the
    // selected one grows into its emphasis instead of snapping.
    const sk = 1 - Math.exp(-MOTION.scale * dt);
    for (const p in planetMeshes) {
      const m = planetMeshes[p];
      if (!REDUCED) m.rotation.y += (m.userData.spin || 0.072) * dt;
      const want = m.userData.wantScale === undefined ? 1 : m.userData.wantScale;
      const cur = m.scale.x;
      if (Math.abs(cur - want) > 0.004) m.scale.setScalar(cur + (want - cur) * sk);
    }
    if (!drag) { cam.theta += MOTION.drift * dt; }
    placeCamera();
    if (SKY_DEV && rm.renderer.info.reset) rm.renderer.info.reset();
    draw();
    govern(now, gap);
    if (SKY_DEV) devPanel(now);
  }

  // Scheduling belongs to the renderer (setAnimationLoop) — the only
  // way WebGPU's internal pump truly stops — and there is exactly one
  // loop, ever.
  function startLoop() {
    if (running) return;
    running = true;
    lastT = 0; ema = 0;
    rm.setAnimationLoop(loop);
  }
  function stopLoop() {
    if (!running) return;
    running = false;
    rm.setAnimationLoop(null);
  }
  // The loop runs only when all three are true: the 3D view is the
  // active mode, the tab is visible, and the canvas is on screen.
  let modeActive = true, onScreen = true;
  function updateRun() {
    (modeActive && !document.hidden && onScreen) ? startLoop() : stopLoop();
  }
  function setActive(on) { modeActive = !!on; updateRun(); }
  const onVis = () => updateRun();
  document.addEventListener('visibilitychange', onVis);
  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver(es => {
        onScreen = !!(es[0] && es[0].isIntersecting);
        updateRun();
      })
    : null;
  if (io) io.observe(canvas);

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // Selected planet swells; the others fall back into shadow. Dimming
  // scales color and emissive rather than flipping `transparent`: a
  // blending-mode flip forces a pipeline rebuild on WebGPU and is not
  // honored reliably there, while a color scale is a plain uniform
  // update on both backends — and reads the same against the black
  // field.
  function dimBodies(sel) {
    for (const p in planetMeshes) {
      const m = planetMeshes[p];
      const f = (!sel || p === sel) ? 1 : 0.25;
      const mat = m.material;
      if (!m.userData.baseColor) m.userData.baseColor = mat.color.clone();
      mat.color.copy(m.userData.baseColor).multiplyScalar(f);
      if (mat.emissiveIntensity !== undefined) mat.emissiveIntensity = 0.4 * f;
      // eased in the render loop rather than snapped
      m.userData.wantScale = (sel && p === sel) ? 1.45 : 1;
    }
  }

  // Fresh full-resolution surfaces swap in as the Worker delivers them
  function applyTexture(planet, tex) {
    const m = planetMeshes[planet];
    if (!m) return;
    const mat = m.material;
    // A landed survey map owns the albedo/emissive; the worker refine
    // then only sharpens the relief beneath it.
    const real = SKY_MAP_CACHE[planet];
    mat.map = tex;
    if (mat.bumpMap) mat.bumpMap = tex;
    if (mat.emissiveMap) mat.emissiveMap = real || tex;
    // PlanetMaterial reads albedo through its own texture node
    if (mat.userData.texNode) mat.userData.texNode.value = real || tex;
    // Node materials (WebGPU) bind textures into their graph at build
    // time, so a swapped surface must ask for a rebuild; on WebGL this
    // is a one-time no-op re-evaluation.
    mat.needsUpdate = true;
  }

  function disposeAll() {
    stopLoop();
    current = null;
    document.removeEventListener('visibilitychange', onVis);
    if (io) io.disconnect();
    ro.disconnect();
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('touchstart', onDown);
    canvas.removeEventListener('touchmove', onMove);
    canvas.removeEventListener('touchend', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('click', onTap);
    if (devEl) devEl.remove();
    // Everything this chart created goes back to the GPU — except the
    // planet surfaces and the shared glow, kept for the next sky
    // (they are the expensive part, and there are only ever ten), and
    // except the RendererManager's chain, which persists by design.
    const keep = new Set([SKY_GLOW_TEX]);
    Object.values(SKY_TEX_CACHE).forEach(c => keep.add(c.tex));
    Object.values(SKY_MAP_CACHE).forEach(t => keep.add(t));
    scene.traverse(o => {
      if (o.geometry && !o.isSprite) o.geometry.dispose();   // sprites share one geometry
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      mats.forEach(m => {
        ['map', 'bumpMap', 'emissiveMap', 'alphaMap'].forEach(slot => {
          if (m[slot] && !keep.has(m[slot])) m[slot].dispose();
        });
        m.dispose();
      });
    });
    scene.clear();   // the scene object itself lives on for the next chart
  }

  updateRun();

  // Profiling hooks, dev builds only — the governor can be frozen so a
  // measurement sweep isn't fought, and the manager is reachable for
  // pixel-ratio / bloom toggles and timestamp resolution.
  if (SKY_DEV) {
    window.__skyDev = {
      rm,
      freezeGovernor: false,
      stats: () => ({ ema, pressure, dpr: rm.renderer.getPixelRatio() })
    };
  }

  current = { THREE, scene, camera, renderer: rm.renderer, groups, planetMeshes,
              sizes: SKY_SIZE, composer: rm.composer,
              exportSky, focusBody, releaseFocus, applyTexture, dimBodies,
              setActive, pause: () => setActive(false), resume: () => setActive(true),
              tier: TIER, backend: rm.getBackend(),
              stop: disposeAll };
  return current;
}
