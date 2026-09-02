// ============================================================
// Kaawen sky — RendererManager
// ============================================================
// The single owner of the rendering backend. Everything above it —
// the sky engine, the page, the astrology — speaks to this interface
// and never to WebGL or (later) WebGPU directly. The renderer, the
// post chain and their GPU context are created once and outlive every
// chart: a fresh renderer on the same canvas would strand the previous
// context's copies of the cached planet surfaces and upload them all
// over again. Rebuilding a chart only re-attaches a scene.

export class RendererManager {
  constructor() {
    this.THREE = null;
    this.renderer = null;
    this.composer = null;
    this.bloomPass = null;
    this.renderPass = null;
    this.scene = null;
    this.camera = null;
    this.backend = null;
    this.tier = null;
  }

  detectCapabilities() {
    let webgl2 = false;
    try { webgl2 = !!document.createElement('canvas').getContext('webgl2'); }
    catch (e) { /* leave false */ }
    return { webgpu: !!navigator.gpu, webgl2 };
  }

  // Creates the backend on first call; later calls are no-ops so the
  // context survives chart rebuilds. `opts`: { baseDPR, bloom, dev, tier }.
  async initialize(THREE, canvas, opts) {
    this.tier = opts.tier;
    if (this.renderer) return this;
    this.THREE = THREE;
    this.backend = 'webgl2';
    // The drawing buffer is NOT preserved: the export re-renders its
    // frame and reads it back in the same task instead, so every
    // ordinary frame keeps the fast swap path.
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(opts.baseDPR);
    if (opts.dev) renderer.info.autoReset = false;
    renderer.setClearColor(0x000000, 0);
    // Film-mapped so highlights roll off instead of clipping to white.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    // Bloom gives the bodies real light falloff rather than flat discs.
    // Optional by design: the lower quality tiers skip it, and if the
    // addon modules can't be fetched the scene simply renders without it.
    if (opts.bloom) try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js')
      ]);
      this.composer = new EffectComposer(renderer);
      this.renderPass = new RenderPass(null, null);
      this.composer.addPass(this.renderPass);
      // strength, radius, threshold — the threshold is deliberately high
      // so only the bodies themselves bloom. Lower values smear the
      // starfield and the sign labels into haze.
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.32, 0.62);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } catch (e) { this.composer = null; this.bloomPass = null; this.renderPass = null; }
    return this;
  }

  // Point the persistent chain at a freshly built chart scene.
  attach(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    if (this.renderPass) { this.renderPass.scene = scene; this.renderPass.camera = camera; }
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  setPixelRatio(v) {
    this.renderer.setPixelRatio(v);
    if (this.composer) this.composer.setPixelRatio(v);
  }

  setSize(w, h) {
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
  }

  setBloom(on) {
    if (!this.bloomPass) return;
    this.bloomPass.enabled = on;
    // Up to r160 the bloom chain incidentally rendered an opaque black
    // backdrop, and that accident is Kaawen's shipped deep-space look.
    // Newer three keeps the canvas properly transparent through the
    // whole chain, which would reveal the page behind it — so the
    // backdrop is now explicit whenever bloom is lit, and the canvas
    // returns to transparent (the pre-bloom look) whenever it is not.
    this.renderer.setClearColor(0x000000, on ? 1 : 0);
  }

  getBackend() { return this.backend; }
  getQualityTier() { return this.tier; }

  // Full teardown — not used in the normal life of the page (the chain
  // persists deliberately), but the owner of last resort must exist.
  dispose() {
    if (this.composer) {
      this.composer.passes.forEach(p => { if (p.dispose) p.dispose(); });
      if (this.composer.dispose) this.composer.dispose();
      else { this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose(); }
    }
    if (this.renderer) this.renderer.dispose();
    this.renderer = this.composer = this.bloomPass = this.renderPass = null;
    this.scene = this.camera = this.backend = null;
  }
}

export const rendererManager = new RendererManager();
