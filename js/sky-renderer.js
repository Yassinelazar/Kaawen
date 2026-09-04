// ============================================================
// Kaawen sky — RendererManager
// ============================================================
// The single owner of the rendering backend. Everything above it —
// the sky engine, the page, the astrology — speaks to this interface
// and never to WebGL or WebGPU directly.
//
// Backend choice: WebGPU when the browser offers it and its renderer
// initializes cleanly; otherwise the classic WebGL2 chain that shipped
// for years. `?gpu=0` forces the classic chain. Both builds share
// three.core.js, so scene objects are the same classes either way.
//
// The renderer, the post chain and their GPU context are created once
// and outlive every chart: a fresh renderer on the same canvas would
// strand the previous context's copies of the cached planet surfaces
// and upload them all over again. Rebuilding a chart only re-attaches
// a scene.

export class RendererManager {
  constructor() {
    this.THREE = null;
    this.renderer = null;
    this.backend = null;
    this.tier = null;
    this.wantBloom = false;
    // classic chain
    this.composer = null;
    this.bloomPass = null;
    this.renderPass = null;
    // webgpu chain
    this.post = null;
    this.sceneNode = null;
    this.bloomNode = null;
    this.withBloom = null;
    this.scene = null;
    this.camera = null;
  }

  detectCapabilities() {
    let webgl2 = false;
    try { webgl2 = !!document.createElement('canvas').getContext('webgl2'); }
    catch (e) { /* leave false */ }
    return { webgpu: !!navigator.gpu, webgl2 };
  }

  // Selects the build, creates the renderer and (on WebGPU) awaits its
  // init. First call wins; later calls only refresh the tier so the
  // context survives chart rebuilds. `opts`: { baseDPR, bloom, dev, tier }.
  async initialize(canvas, opts) {
    this.tier = opts.tier;
    if (this.renderer) return this;
    const wantGpu = !/[?&]gpu=0/.test(location.search) && !!navigator.gpu;
    if (wantGpu) {
      try {
        // Some browsers expose navigator.gpu yet stall or crawl when the
        // device is actually requested. A slow adapter is a fallback, not
        // a wait: probe it first (touching nothing), and give init itself
        // a deadline, so the classic chain opens before the visitor
        // wonders whether the page is broken.
        const adapter = await Promise.race([
          navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
          new Promise(res => setTimeout(() => res(null), 3000))
        ]);
        if (!adapter) throw new Error('webgpu adapter unavailable or slow');
        const THREE = await import('three/webgpu');
        const renderer = new THREE.WebGPURenderer({
          canvas, antialias: true, alpha: true,
          powerPreference: 'high-performance',
          // GPU timestamp queries for the ?dev=1 profiler only
          trackTimestamp: !!opts.dev
        });
        await Promise.race([
          renderer.init(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('webgpu init deadline')), 5000))
        ]);
        this.THREE = THREE;
        this.renderer = renderer;
        this.backend = 'webgpu';
      } catch (e) { this.THREE = null; }
    }
    if (!this.THREE) {
      // The proven classic chain — also the landing spot when WebGPU
      // exists but fails to initialize, so the sky always opens.
      const THREE = await import('three');
      this.THREE = THREE;
      this.backend = 'webgl2';
      // The drawing buffer is NOT preserved: the export re-renders its
      // frame and reads it back instead, so every ordinary frame keeps
      // the fast swap path.
      this.renderer = new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: true,
        powerPreference: 'high-performance'
      });
    }
    const { renderer, THREE } = this;
    renderer.setPixelRatio(opts.baseDPR);
    if (opts.dev && renderer.info) renderer.info.autoReset = false;
    renderer.setClearColor(0x000000, 0);
    // Film-mapped so highlights roll off instead of clipping to white.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.wantBloom = !!opts.bloom;

    // The classic bloom chain is scene-independent and can be built
    // now; the WebGPU post graph binds scene and camera, so it is
    // rebuilt in attach(). Bloom is optional by design: the lower
    // quality tiers skip it, and if the addon modules can't be fetched
    // the scene simply renders without it.
    if (this.wantBloom && this.backend === 'webgl2') try {
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
  async attach(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    if (this.renderPass) { this.renderPass.scene = scene; this.renderPass.camera = camera; }
    if (this.backend === 'webgpu' && this.wantBloom) try {
      if (this.sceneNode) {
        // The graph persists like the classic chain: a rebuilt chart
        // only retargets the scene pass. Recreating the graph per chart
        // would leak its render targets — pipeline dispose does not
        // reach them. The pass caches its render context by version,
        // so the retarget must announce itself or the pass keeps
        // drawing the disposed scene.
        this.sceneNode.scene = scene;
        this.sceneNode.camera = camera;
      } else {
        const [{ pass }, { bloom }] = await Promise.all([
          import('three/tsl'),
          import('three/addons/tsl/display/BloomNode.js')
        ]);
        const Pipeline = this.THREE.RenderPipeline || this.THREE.PostProcessing;
        this.post = new Pipeline(this.renderer);
        const scenePass = pass(scene, camera);
        // Same voicing as the classic chain: strength, radius, threshold.
        this.bloomNode = bloom(scenePass, 0.55, 0.32, 0.62);
        this.withBloom = scenePass.add(this.bloomNode);
        this.sceneNode = scenePass;
        this.post.outputNode = this.withBloom;
      }
    } catch (e) { this.post = null; this.sceneNode = null; this.withBloom = null; this.bloomNode = null; }
  }

  render() {
    if (this.post) this.post.render();
    else if (this.composer) this.composer.render();
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

  // The render loop is scheduled by the renderer itself on both
  // backends. The WebGL renderer parks its internal rAF when the loop
  // is null; the WebGPU renderer's pump keeps spinning regardless, so
  // it is stopped and restarted explicitly. (_animation is a private
  // field with a documented stop/start — last verified against r185;
  // the guard makes a future rename degrade to "keeps idling", not a
  // crash.)
  setAnimationLoop(cb) {
    this.renderer.setAnimationLoop(cb);
    const anim = this.renderer._animation;
    if (anim && anim.stop && anim.start) {
      if (cb === null) anim.stop();
      else if (anim._requestId === null) anim.start();
    }
  }

  setBloom(on) {
    let lit = false;
    if (this.bloomPass) { this.bloomPass.enabled = on; lit = on; }
    if (this.post && this.withBloom) {
      // A pipeline rebuild (needsUpdate) re-resolves cached bindings,
      // and after a canvas resize that path can resurrect the disposed
      // pre-resize pass target (r185). Rebuild only on a real change.
      const want = on ? this.withBloom : this.sceneNode;
      if (this.post.outputNode !== want) {
        this.post.outputNode = want;
        this.post.needsUpdate = true;
      }
      lit = on;
    }
    // Up to r160 the bloom chain incidentally rendered an opaque black
    // backdrop, and that accident is Kaawen's shipped deep-space look.
    // The backdrop is now explicit whenever bloom is lit, on either
    // backend, and the canvas returns to transparent whenever not.
    if (this.bloomPass || this.post) this.renderer.setClearColor(0x000000, lit ? 1 : 0);
  }

  getBackend() { return this.backend; }
  getQualityTier() { return this.tier; }

  // Full teardown — not used in the normal life of the page (the chain
  // persists deliberately), but the owner of last resort must exist.
  dispose() {
    if (this.post && this.post.dispose) this.post.dispose();
    if (this.composer) {
      this.composer.passes.forEach(p => { if (p.dispose) p.dispose(); });
      if (this.composer.dispose) this.composer.dispose();
      else { this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose(); }
    }
    if (this.renderer) this.renderer.dispose();
    this.renderer = this.composer = this.bloomPass = this.renderPass = null;
    this.post = this.sceneNode = this.withBloom = null;
    this.scene = this.camera = this.backend = null;
  }
}

export const rendererManager = new RendererManager();
