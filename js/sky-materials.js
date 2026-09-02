// ============================================================
// Kaawen sky — PlanetMaterial (WebGPU / TSL path only)
// ============================================================
// The smallest abstraction that upgrades a body's surface response:
// the worker-generated albedo is enriched on the GPU with seamless 3D
// micro-detail and matching roughness variation, while lighting,
// emissive, bump and `material.color` stay on the standard plumbing —
// so the Sun's terminator, the dossier dimming and the texture-refine
// swap all keep working unchanged. The WebGL2 fallback never loads
// this module and keeps the proven Phase 2 material.
//
// Deliberately NOT here yet (future tranches): atmosphere, clouds,
// rings, night lights. They will be separate layers, not more nodes
// crammed into this one.

let TSL = null;
export async function loadTSL() {
  if (!TSL) TSL = await import('three/tsl');
  return TSL;
}

// cfg: { map, color, bumpScale, radius, detail, detailScale }
export function createPlanetMaterial(THREE, cfg) {
  const { texture, positionLocal, materialColor, float } = TSL;
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.92, metalness: 0.02,
    bumpMap: cfg.map, bumpScale: cfg.bumpScale,
    emissive: cfg.color, emissiveMap: cfg.map, emissiveIntensity: 0.4
  });
  const texNode = texture(cfg.map);
  // 3D fBm sampled on the local position: no UV meridian seam, and it
  // keeps resolving as the camera approaches — perceived detail that
  // no texture size buys.
  const p = positionLocal.div(float(cfg.radius || 5)).mul(float(cfg.detailScale || 9));
  const dn = TSL.mx_fractal_noise_float(p, 4).mul(float(cfg.detail || 0.08));
  mat.colorNode = texNode.rgb.mul(dn.add(1)).mul(materialColor);
  mat.roughnessNode = dn.mul(0.6).add(float(0.9));
  mat.map = cfg.map;                    // bookkeeping: refine swap + disposal
  mat.userData.texNode = texNode;       // the node the swap must retarget
  return mat;
}
