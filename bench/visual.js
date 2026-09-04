#!/usr/bin/env node
// ============================================================
// Kaawen visual benchmark — capture pass
// ============================================================
// Renders the canonical chart (1997-11-22 09:41, New York) through the
// states that exercise the whole rendering stack, and saves them under
// bench/shots/<name>/. Run it before a renderer migration to make the
// reference, after it to make the candidate, then diff the two with
// bench/compare.js.
//
//   node bench/visual.js baseline
//   node bench/visual.js after-r184
//   node bench/compare.js baseline after-r184
//
// Captures are made deterministic: prefers-reduced-motion (no drift, no
// spin, instant flights) and the random starfield switched off. Shots
// with stars stay in the set for human eyes but carry `.eyeball` in
// their name, which compare.js skips.
//
// Needs playwright-core (`npm i --no-save playwright-core` if missing)
// and a Chromium with real WebGL. Serves the repo itself on a local
// port for the duration of the run.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const NAME = process.argv[2];
if (!NAME) { console.error('usage: node bench/visual.js <run-name>'); process.exit(1); }
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots', NAME);
fs.mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!exe) { console.error('No Chrome found. Set CHROME_BIN.'); process.exit(1); }

const PORT = 8917;

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  // CHROME_ARGS escape hatch: when the default headless launch loses GPU
  // access (e.g. '--use-angle=metal' restores WebGL2 on macOS), pass flags
  // without changing default behavior. Shots taken on the WebGL2 fallback
  // are comparable for layout/structure but not pixel-exact against
  // WebGPU baselines — note the backend in the run report.
  const extraArgs = (process.env.CHROME_ARGS || '').split(' ').filter(Boolean);
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: extraArgs });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });

    // The canonical chart
    await page.click('.site-nav-cta');
    await page.fill('#dob', '1997-11-22');
    await page.fill('#tob', '09:41');
    const ny = await page.$eval('#city',
      s => [...s.options].find(o => o.textContent.includes('New York')).value);
    await page.selectOption('#city', ny);
    await page.click('#bp-form button[type="submit"]');
    // the flow now lands inside the sky, so the wheel exists but is hidden
    await page.waitForSelector('#wheel-visual svg', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(800);

    const shot = (file, target) => (target || page).screenshot({ path: path.join(OUT, file) });

    // A fresh chart now opens inside the sky; step out to shoot the wheel
    await page.evaluate(() => setWheelMode('2d'));
    await page.waitForTimeout(800);

    // 1. The flat wheel — untouched by any renderer work, must never drift
    await shot('wheel-2d.png', page.locator('#wheel-visual'));

    // Into the sky
    await page.evaluate(() => setWheelMode('3d'));
    await page.waitForFunction(() =>
      document.getElementById('sky3d-loading').style.display === 'none', null, { timeout: 30000 });
    await page.waitForTimeout(7000);          // every surface refined + settled

    // 2. Whole sky as shipped (random stars — for human eyes only)
    await shot('sky-whole.eyeball.png');

    // 3. Whole sky, stars off — the deterministic reference frame
    await page.click('.sky3d-layer[data-layer="stars"]');
    await page.waitForTimeout(600);
    await shot('sky-whole.png');

    // 4. Focused on the Moon — flight, halo, terminator, dossier layout
    await page.evaluate(() => selectWheel('planet', 'Moon'));
    await page.waitForTimeout(2500);
    await shot('sky-focus-moon.png');

    // 5. Focused on Jupiter — banding + bump detail up close
    await page.evaluate(() => selectWheel('planet', 'Jupiter'));
    await page.waitForTimeout(2500);
    await shot('sky-focus-jupiter.png');

    // 5b. Jupiter filling the frame — the zoom test for surface detail
    await page.evaluate(() => {
      const cv = document.getElementById('sky3d-canvas');
      for (let i = 0; i < 6; i++)
        cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(1800);
    await shot('jupiter-detail.png');
    await page.evaluate(() => {
      const cv = document.getElementById('sky3d-canvas');
      for (let i = 0; i < 6; i++)
        cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(1200);

    // 5c. Saturn close — the ring system reads as geometry
    await page.evaluate(() => selectWheel('planet', 'Saturn'));
    await page.waitForTimeout(2500);
    await shot('saturn-close.png');

    // 5d. Saturn from a raised angle — ring plane must respond as
    // geometry, not as a billboard
    await page.mouse.move(430, 400);
    await page.mouse.down();
    for (let y = 400; y >= 260; y -= 20) await page.mouse.move(430, y);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    await shot('saturn-angle.png');
    // return the camera for the shots that follow
    await page.mouse.move(430, 260);
    await page.mouse.down();
    for (let y = 260; y <= 400; y += 20) await page.mouse.move(430, y);
    await page.mouse.up();
    await page.waitForTimeout(800);

    // 5e. The observer at the centre, up close
    await page.evaluate(() => releaseSkyView());
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const cv = document.getElementById('sky3d-canvas');
      for (let i = 0; i < 24; i++)
        cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(2200);
    await shot('earth-center.png');
    await page.evaluate(() => {
      const cv = document.getElementById('sky3d-canvas');
      for (let i = 0; i < 24; i++)
        cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(1500);

    // 6. Sun selected — aspect lines lit/dimmed correctly
    await page.evaluate(() => selectWheel('planet', 'Sun'));
    await page.waitForTimeout(2500);
    await shot('sky-select-sun.png');

    // 7. The print-resolution export (has stars — eyeball only)
    await page.evaluate(() => releaseSkyView());
    await page.waitForTimeout(1500);
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.click('#sky3d-save')
    ]);
    fs.copyFileSync(await dl.path(), path.join(OUT, 'export.eyeball.png'));

    await ctx.close();

    // 8. Renderer metrics via the dev HUD — draw calls and triangle
    // counts catch structural regressions no screenshot can see.
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const p2 = await c2.newPage();
    await p2.goto(`http://localhost:${PORT}/index.html?dev=1`, { waitUntil: 'load' });
    await p2.click('.site-nav-cta');
    await p2.fill('#dob', '1997-11-22');
    await p2.fill('#tob', '09:41');
    await p2.selectOption('#city', ny);
    await p2.click('#bp-form button[type="submit"]');
    await p2.waitForSelector('#wheel-visual svg', { state: 'attached', timeout: 15000 });
    await p2.evaluate(() => setWheelMode('3d'));
    await p2.waitForFunction(() =>
      document.getElementById('sky3d-loading').style.display === 'none', null, { timeout: 30000 });
    await p2.waitForTimeout(2000);
    const hud = await p2.evaluate(() => {
      const el = [...document.querySelectorAll('#sky3d div')]
        .find(d => /webgl|webgpu/.test(d.textContent));
      return el ? el.textContent : null;
    });
    fs.writeFileSync(path.join(OUT, 'metrics.txt'), (hud || 'no HUD') + '\n');
    await c2.close();

    console.log(`Captured ${fs.readdirSync(OUT).length} artifacts into bench/shots/${NAME}/`);
    console.log((hud || '').replace(/\n/g, ' · '));
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
