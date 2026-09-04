---
name: kaawen-motion
description: How Kaawen uses Lenis, GSAP and (not) Vanta — vendored motion tools, integration rules, and the sky-first flow contract
---

# Kaawen motion tools

Reference clones live in `../vendor/` (lenis, GSAP, vanta) — outside
the deploy repo, never shipped. Shipped builds are vendored in
`assets/vendor/` (self-hosted, no CDN dependency at runtime).

## Lenis (ACTIVE) — smooth scrolling
- `assets/vendor/lenis.min.js` (MIT, v1.3.x), loaded with `defer`,
  instantiated as `window.__lenis` with `autoRaf: true`.
- **Never** starts for `prefers-reduced-motion` users.
- The immersive sky pauses it: `setSkyImmersive` calls
  `__lenis.stop()/start()` — in the sky, the wheel means flight, not
  scroll. `#sky3d` carries `data-lenis-prevent` as a second guard.
- Always feature-check `window.Lenis` — the page must work if the
  file fails to load.

## GSAP + ScrollTrigger (VENDORED, not yet loaded)
- `assets/vendor/gsap.min.js` + `ScrollTrigger.min.js` (GSAP standard
  license — free since the Webflow acquisition). ~117KB combined, so
  do NOT add script tags until a tranche actually choreographs with
  them (entry transition into the sky, scroll-driven landing reveals).
  Load lazily when that work lands; respect reduced motion; never
  drive the 3D engine's camera with GSAP — the engine owns its own
  delta-time motion.

## Vanta (REFERENCE ONLY — do not integrate)
Evaluated and rejected for Kaawen: generic three.js background
effects pinned to old three versions, would run a second WebGL
context under our WebGPU engine, and reads as the "generic space
VFX" the Phase 3 brief prohibits. The sky engine IS the background.

## Threlte (REFERENCE ONLY — do not integrate)
Evaluated 2026-09-03 and rejected: it is a Svelte 5 component wrapper
around the same three.js we already drive directly — it requires the
Svelte compiler and a build step (Kaawen has none, by design), adds
no rendering capability, and its declarative layer would fight
RendererManager's ownership of the WebGPU/WebGL2 backend. Clone
lives in `../vendor/threlte` for reading only.

## awesome-design-md (ADOPTED as reference material)
`../vendor/awesome-design-md` — 73 DESIGN.md files describing the
design languages of well-known products (SpaceX, Stripe, Superhuman,
Framer…). Plain markdown, no code, no runtime. Consult when working
on landing/marketing composition; Kaawen's own tokens and voice
always win.

## The sky-first flow contract
Submitting the birth form (`#bp-form`) awaits `runBlueprint()` and,
only if `window.__wheelCtx` changed (a chart actually computed),
enters the sky via `setWheelMode('3d')`. Leaving the sky lands on the
written reading. Tests: the wheel SVG exists but is HIDDEN after
submit — wait for `#wheel-visual svg` with `state: 'attached'`, and
switch to 2D before screenshotting the wheel (see bench/visual.js).
