#!/usr/bin/env node
// ============================================================
// Kaawen visual benchmark — diff pass
// ============================================================
//   node bench/compare.js <reference-run> <candidate-run>
//
// Compares every diffable shot (names without `.eyeball`) pixel by
// pixel, with an 8-step per-channel tolerance to absorb driver-level
// antialiasing noise. Verdict per image:
//
//   PASS   < 0.5% of pixels differ  — rendering held
//   CHECK  0.5–3%                   — look with your eyes
//   FAIL   > 3% or size mismatch    — the migration changed the picture
//
// The diff itself runs inside headless Chrome on a 2D canvas, so the
// suite needs no image libraries — only playwright-core.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const [refName, candName] = process.argv.slice(2);
if (!refName || !candName) { console.error('usage: node bench/compare.js <ref> <candidate>'); process.exit(1); }
const dirA = path.join(__dirname, 'shots', refName);
const dirB = path.join(__dirname, 'shots', candName);

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!exe) { console.error('No Chrome found. Set CHROME_BIN.'); process.exit(1); }

const files = fs.readdirSync(dirA).filter(f =>
  f.endsWith('.png') && !f.includes('.eyeball'));

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  let worst = 'PASS';
  for (const f of files) {
    const bPath = path.join(dirB, f);
    if (!fs.existsSync(bPath)) { console.log(`FAIL   ${f} — missing in ${candName}`); worst = 'FAIL'; continue; }
    const a = fs.readFileSync(path.join(dirA, f)).toString('base64');
    const b = fs.readFileSync(bPath).toString('base64');
    const r = await page.evaluate(async ([a, b]) => {
      const load = src => new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej;
        i.src = 'data:image/png;base64,' + src;
      });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height)
        return { mismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      const px = (img) => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const da = px(ia), db = px(ib);
      let diff = 0, sum = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]),
                           Math.abs(da[i + 1] - db[i + 1]),
                           Math.abs(da[i + 2] - db[i + 2]));
        sum += d;
        if (d > 8) diff++;
      }
      const total = da.length / 4;
      return { pct: diff / total * 100, mean: sum / total };
    }, [a, b]);
    if (r.mismatch) { console.log(`FAIL   ${f} — size ${r.mismatch}`); worst = 'FAIL'; continue; }
    const verdict = r.pct < 0.5 ? 'PASS ' : r.pct <= 3 ? 'CHECK' : 'FAIL ';
    if (verdict.trim() === 'FAIL') worst = 'FAIL';
    else if (verdict.trim() === 'CHECK' && worst === 'PASS') worst = 'CHECK';
    console.log(`${verdict}  ${f} — ${r.pct.toFixed(3)}% pixels differ, mean Δ ${r.mean.toFixed(2)}`);
  }
  // Metrics are worth a glance too
  for (const d of [dirA, dirB]) {
    const m = path.join(d, 'metrics.txt');
    if (fs.existsSync(m))
      console.log(`metrics ${path.basename(d)}: ${fs.readFileSync(m, 'utf8').trim().replace(/\n/g, ' · ')}`);
  }
  await browser.close();
  console.log('VERDICT:', worst);
  process.exit(worst === 'FAIL' ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
