// ============================================================
// Kaawen sky — quality policy
// ============================================================
// One place decides how hard the GPU is asked to work. A tier is
// chosen once from the device's shape; on top of it a short ladder
// of degradations answers *measured* frame pressure — render scale
// first, then bloom, then star density. The bodies themselves and
// the reading are never touched.

export const SKY_QUALITY_PROFILES = {
  ULTRA:  { maxDPR: 2.5,  stars: 1400, texSize: 1024, seg: [64, 48], bloom: true },
  HIGH:   { maxDPR: 2,    stars: 1400, texSize: 1024, seg: [64, 48], bloom: true },
  MEDIUM: { maxDPR: 1.5,  stars: 1000, texSize: 512,  seg: [48, 32], bloom: true },
  LOW:    { maxDPR: 1.25, stars: 700,  texSize: 512,  seg: [48, 32], bloom: false },
  MOBILE: { maxDPR: 1.5,  stars: 600,  texSize: 512,  seg: [48, 32], bloom: false }
};

export function skyQualityTier() {
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width || 1e4, screen.height || 1e4) < 820;
  if (coarse && small) return 'MOBILE';
  const mem = navigator.deviceMemory || 8;   // Chrome-only hint; others assume ample
  const cores = navigator.hardwareConcurrency || 8;
  if (mem <= 2 || cores <= 2) return 'LOW';
  if (mem <= 4 || cores <= 4) return 'MEDIUM';
  return (window.devicePixelRatio || 1) >= 2 ? 'ULTRA' : 'HIGH';
}

// The pressure ladder, applied on top of the tier — resolution and
// glow are traded away long before anything structural.
export const SKY_PRESSURE = [
  { scale: 1.0,  bloom: true,  stars: 1.0 },
  { scale: 0.85, bloom: true,  stars: 1.0 },
  { scale: 0.7,  bloom: true,  stars: 1.0 },
  { scale: 0.7,  bloom: false, stars: 1.0 },
  { scale: 0.55, bloom: false, stars: 0.5 }
];

export const SKY_DEV = /[?&]dev=1/.test(location.search);

export const skyReducedMotion = () => !!(window.matchMedia
  && matchMedia('(prefers-reduced-motion: reduce)').matches);
