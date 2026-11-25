#!/usr/bin/env node
// Measure how close scaffold.html looks to the source PDF.
//
//   node compare.mjs <in.pdf> <scaffold.html> <outDir> [--pages 1-3] [--scale 2]
//
// Rasterises each PDF page with pdftoppm (poppler) and screenshots the same
// page of the scaffold with headless Chrome (?page=N&bare: one page, no
// margins, field tint off), then diffs them with @napi-rs/canvas.
// Two numbers per page:
//   strict  - % of pixels whose max channel difference is > 40 at full res.
//             Anti-aliasing and font substitution alone keep this above 0.
//   layout  - the same after downsampling both images 8x, which forgives
//             glyph shapes but not misplaced text, missing boxes or colours.
// Writes <outDir>/page-N.png = PDF | scaffold | diff, side by side.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { findChrome } from '../../tests/helpers.mjs';

function chromePath() {
  try { return findChrome(); } catch { /* fall through to Playwright's cache */ }
  const pw = path.join(os.homedir(), '.cache/ms-playwright');
  if (existsSync(pw)) {
    for (const d of fs.readdirSync(pw).sort().reverse()) {
      for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(pw, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chrome found; set CHROME_PATH');
}

function pageSizes(pdf) {
  const out = execFileSync('pdfinfo', ['-f', '1', '-l', '9999', pdf], { encoding: 'utf8' });
  const sizes = {};
  for (const m of out.matchAll(/Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/g)) sizes[+m[1]] = [+m[2], +m[3]];
  const n = +(/Pages:\s+(\d+)/.exec(out) || [])[1];
  if (!Object.keys(sizes).length) { const m = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(out); for (let i = 1; i <= n; i++) sizes[i] = [+m[1], +m[2]]; }
  return { n, sizes };
}

function pixels(img, w, h, down = 1) {
  const c = createCanvas(Math.max(1, Math.round(w / down)), Math.max(1, Math.round(h / down)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

function diffPct(a, b, thr = 40) {
  let bad = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > thr) bad++;
  }
  return (100 * bad) / n;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
  const pagesArg = opt('--pages', null);
  const scale = +opt('--scale', '2');
  const [pdf, html, outDir] = args;
  if (!pdf || !html || !outDir) { console.error('usage: node compare.mjs <in.pdf> <scaffold.html> <outDir> [--pages a-b] [--scale 2]'); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfcmp-'));
  const { n, sizes } = pageSizes(pdf);
  let [from, to] = pagesArg ? pagesArg.split('-').map(Number) : [1, n];
  to = to || from;
  const chrome = chromePath();
  const results = [];
  for (let p = from; p <= Math.min(to, n); p++) {
    const [wPt, hPt] = sizes[p];
    const refBase = path.join(tmp, `ref-${p}`);
    execFileSync('pdftoppm', ['-r', String(72 * scale), '-f', String(p), '-l', String(p), '-png', '-singlefile', pdf, refBase]);
    const shot = path.join(tmp, `shot-${p}.png`);
    const url = pathToFileURL(path.resolve(html)).href + `?page=${p}&bare`;
    execFileSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`,
      `--window-size=${Math.ceil(wPt)},${Math.ceil(hPt)}`, '--virtual-time-budget=8000', `--screenshot=${shot}`, url], { stdio: 'ignore' });
    const ref = await loadImage(fs.readFileSync(refBase + '.png'));
    const got = await loadImage(fs.readFileSync(shot));
    const W = ref.width, H = ref.height;
    const a = pixels(ref, W, H), b = pixels(got, W, H);
    const strict = diffPct(a, b);
    const layout = diffPct(pixels(ref, W, H, 8), pixels(got, W, H, 8), 24);
    // Side-by-side: PDF | scaffold | diff (red = differs)
    const c = createCanvas(W * 3, H);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W * 3, H);
    ctx.drawImage(ref, 0, 0, W, H);
    ctx.drawImage(got, W, 0, W, H);
    const dimg = ctx.createImageData(W, H);
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      const g = 255 - (255 - (a[i] + a[i + 1] + a[i + 2]) / 3) * 0.25;
      if (d > 40) { dimg.data[i] = 220; dimg.data[i + 1] = 30; dimg.data[i + 2] = 30; } else { dimg.data[i] = dimg.data[i + 1] = dimg.data[i + 2] = g; }
      dimg.data[i + 3] = 255;
    }
    ctx.putImageData(dimg, W * 2, 0);
    ctx.fillStyle = '#888'; ctx.fillRect(W - 1, 0, 2, H); ctx.fillRect(W * 2 - 1, 0, 2, H);
    fs.writeFileSync(path.join(outDir, `page-${p}.png`), await c.encode('png'));
    results.push({ page: p, strict: +strict.toFixed(2), layout: +layout.toFixed(2) });
    console.log(`page ${p}: strict ${strict.toFixed(2)}% differing pixels, layout (1/8 res) ${layout.toFixed(2)}%`);
  }
  fs.writeFileSync(path.join(outDir, 'compare.json'), JSON.stringify({ pdf: path.basename(pdf), scale, results }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
