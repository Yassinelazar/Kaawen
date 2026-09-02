// ============================================================
// Kaawen sky — planet surface noise
// ============================================================
// Pure pixels in, pixels out — no DOM, no THREE — so the exact same
// function runs on the main thread (instant preview) and inside the
// texture Worker (full resolution). Deterministic per planet name.

export function SKY_TEX_GEN(planet, hex, cfg, S) {
  const r = (hex >> 16) & 255, gg = (hex >> 8) & 255, bb = hex & 255;
  // Deterministic value noise, so a body looks the same every visit
  let seed = 0;
  for (let i = 0; i < planet.length; i++) seed = (seed * 31 + planet.charCodeAt(i)) & 0xffff;
  const rand = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + seed) * 43758.5453;
    return n - Math.floor(n);
  };
  const smooth = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return rand(xi, yi) * (1 - u) * (1 - v) + rand(xi + 1, yi) * u * (1 - v)
         + rand(xi, yi + 1) * (1 - u) * v + rand(xi + 1, yi + 1) * u * v;
  };
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // six octaves — the last ones carry the fine grain that keeps
      // the surface convincing at close range
      let n = 0, amp = 0.5, freq = 4;
      for (let o = 0; o < 6; o++) {
        n += smooth(x / S * freq, y / S * freq) * amp;
        amp *= 0.5; freq *= 2.35;
      }
      n = (n - 0.5) * cfg.contrast;
      if (cfg.bands) n += Math.sin(y / S * Math.PI * cfg.bands * 2) * cfg.grain * 0.30;
      const k = 1 + n;
      const i = (y * S + x) * 4;
      d[i]     = Math.max(0, Math.min(255, r * k));
      d[i + 1] = Math.max(0, Math.min(255, gg * k));
      d[i + 2] = Math.max(0, Math.min(255, bb * k));
      d[i + 3] = 255;
    }
  }
  return d;
}
