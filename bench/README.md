# Kaawen visual benchmark suite

Guards the 3D sky (and the flat wheel) through renderer migrations.
Before a risky change, capture a reference; after it, capture a
candidate; diff the two. Nothing here ships to users — it is a
development tool that happens to live in the repo so it stays
versioned with the code it tests.

## Usage

```bash
# once, if playwright-core is not installed anywhere requireable:
npm i --no-save playwright-core

node bench/visual.js baseline        # capture reference → bench/shots/baseline/
# ...perform the migration...
node bench/visual.js candidate      # capture the result
node bench/compare.js baseline candidate
```

`visual.js` serves the repo locally, renders the canonical chart
(1997-11-22 09:41, New York) and captures: the 2D wheel, the whole sky
(stars off = deterministic), Moon/Jupiter close-ups, the Sun-selected
aspect state, the print-resolution export, and the dev-HUD renderer
metrics (draw calls / triangles / resident objects).

Captures run under `prefers-reduced-motion` with the starfield layer
off, so identical code produces identical pixels. Shots named
`*.eyeball.png` contain the random starfield and are for human review
only — `compare.js` skips them.

## Verdicts

- **PASS** — under 0.5% of pixels differ (antialiasing noise).
- **CHECK** — 0.5–3%: look at both images before believing either.
- **FAIL** — over 3%, or sizes differ: the migration changed the picture.

Chrome discovery order: `$CHROME_BIN`, the Playwright
Chrome-for-Testing cache, `/Applications/Google Chrome.app`.

`bench/shots/baseline-2a/` is the committed post-Phase-2A reference
(three r160). `bench/shots/baseline-r185/` is the accepted reference
after the r185 upgrade — its only delta from 2a is a slightly
different UnrealBloomPass falloff (radially symmetric, imperceptible
side by side; verified with a diff heat map) plus the now-explicit
opaque backdrop under bloom. Later phases (WebGPU backend) diff
against baseline-r185.
