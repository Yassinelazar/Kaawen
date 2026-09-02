// ============================================================
// Kaawen sky — texture Worker
// ============================================================
// Runs the identical noise the main thread uses for previews, at full
// resolution, off the main thread. Pixels travel back as a transferred
// buffer — no copy, no canvas, no freeze.

import { SKY_TEX_GEN } from './sky-noise.js';

onmessage = e => {
  const j = e.data;
  const d = SKY_TEX_GEN(j.planet, j.hex, j.cfg, j.S);
  postMessage({ planet: j.planet, S: j.S, d }, [d.buffer]);
};
