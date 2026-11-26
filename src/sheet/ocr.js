// Scanned pages -> text, fields and a clean page (#23). Browser only (it
// needs <canvas>); runs on the user's device. tesseract.js and its
// Indonesian + English data come from jsDelivr; the page itself is never
// uploaded anywhere.
//
//   import { needsOcr, ocrSheet } from './ocr.js';
//   const sheet = await importPdf(pdfjs, bytes);
//   if (needsOcr(sheet)) await ocrSheet(pdfjs, bytes, sheet, {
//     digital: false,                       // true: editable "digital book" page
//     onProgress({ page, pages, pct }) {},  // page i of n (1-based), pct 0..1 overall
//     docOptions,                           // passed to pdfjs.getDocument, as in importPdf
//   });
//
// needsOcr(sheet) / pageNeedsOcr(page): a page with (almost) no text runs
// whose background is mostly one picture. ocrSheet() rewrites only those
// pages, in place, so a mixed PDF keeps its born-digital pages untouched.
//
// Per scanned page:
//   1. render with pdf.js at ~300 dpi (longest side capped, for memory);
//   2. clean: deskew (projection profile, +-5 deg), flatten the paper to
//      white (per-block paper colour estimate, divided out, then levels),
//      and drop dark scanner edges. The cleaned scan becomes the page
//      background: an SVG holding one JPEG <image>, per format.md;
//   3. OCR (tesseract, LSTM) on the cleaned page; words merge into line runs
//      shaped like import.js's, with alpha 0: invisible, but searchable,
//      selectable and read by screen readers;
//   4. fields: the runs plus rules found in the bitmap go through import.js's
//      detectFields (leaders, lines, tables, boxes, blank space under a
//      question); numbered multiple-choice options (A.-E.) become one
//      `choice` field per question. Prompts come from the question text,
//      labels are "Jawaban no. N". Every field gets source: 'ocr';
//   5. digital: true also erases each recognised word from the background
//      (filled with the paper colour around it, only where that paper is
//      flat, so words inside photos stay) and makes the runs visible, with
//      estimated size, weight and ink colour. Every OCR run carries `conf`
//      (0..1, its least certain word) so the Studio can flag it for review.
//
// Returns { pages: [{ id, ms, words, angle }] } (also kept in page.stats.ocr).

import { _internal as imp } from './import.js';

export const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';
const FONT = 'ocr';
const FONT_DEF = { css: "'Arimo', 'Arial', sans-serif", web: ['Arimo'] };
const r2 = (v) => Math.round(v * 100) / 100;
const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------ detection
const IMG_RE = /<(?:image|use)\b[^>]*?\btransform="matrix\(([^)]+)\)"/g;
/** A page that is a picture of a page: no text to speak of, one big image. */
export function pageNeedsOcr(p) {
  if (!p || (p.stats && p.stats.ocr)) return false;
  const chars = (p.text || []).reduce((n, t) => n + String(t.str || '').trim().length, 0);
  if (chars > 12) return false;
  let best = 0;
  for (const m of String(p.background || '').matchAll(IMG_RE)) {
    const [a, b, c, d] = m[1].trim().split(/[\s,]+/).map(Number);
    best = Math.max(best, Math.abs(a * d - b * c));
  }
  return best >= 0.5 * p.width * p.height;
}
export const needsOcr = (sheet) => !!sheet && Array.isArray(sheet.pages) && sheet.pages.some(pageNeedsOcr);

// --------------------------------------------------------------- canvas
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
const lumAt = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// ---------------------------------------------------------------- deskew
// Text lines are the strongest horizontal structure on a page: project the
// dark pixels onto the y axis at each candidate angle; the angle that makes
// the profile spikiest (sum of squared bin counts) is the tilt. Done on a
// ~1000 px copy, coarse then fine. Returns degrees; positive means the
// content is turned clockwise (fixed by rotating it back by -angle).
export function estimateSkew(data, W, H) {
  const f = Math.max(1, Math.round(W / 1000));
  const sw = Math.floor(W / f), sh = Math.floor(H / f);
  const L = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += lumAt(data, ((y * f + dy) * W + x * f + dx) * 4);
      L[y * sw + x] = s / (f * f);
    }
  }
  // Local paper level: max over 24 px tiles (and neighbours), so uneven
  // light doesn't hide the text in dark corners.
  const T = 24, tw = Math.ceil(sw / T), th = Math.ceil(sh / T);
  const tmax = new Float32Array(tw * th);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const k = ((y / T) | 0) * tw + ((x / T) | 0); if (L[y * sw + x] > tmax[k]) tmax[k] = L[y * sw + x]; }
  const pts = [];
  const mx = Math.round(sw * 0.05), my = Math.round(sh * 0.04);
  for (let y = my; y < sh - my; y++) {
    for (let x = mx; x < sw - mx; x++) {
      const tx = (x / T) | 0, ty = (y / T) | 0;
      let bg = 0;
      for (let j = Math.max(0, ty - 1); j <= Math.min(th - 1, ty + 1); j++) for (let i = Math.max(0, tx - 1); i <= Math.min(tw - 1, tx + 1); i++) bg = Math.max(bg, tmax[j * tw + i]);
      if (L[y * sw + x] < 0.6 * bg) pts.push(x, y);
    }
  }
  const n = pts.length / 2;
  if (n < 200) return 0;
  const stride = Math.max(1, Math.floor(n / 60000));
  const off = Math.ceil(sw * 0.1) + 2;
  const bins = new Int32Array(sh + 2 * off + 2);
  const score = (deg) => {
    const t = (deg * Math.PI) / 180, s = Math.sin(t), c = Math.cos(t);
    bins.fill(0);
    for (let k = 0; k < n; k += stride) { const x = pts[2 * k], y = pts[2 * k + 1]; bins[(y * c - x * s + off) | 0]++; }
    let q = 0;
    for (let i = 0; i < bins.length; i++) q += bins[i] * bins[i];
    return q;
  };
  let best = 0, bestS = score(0);
  const s0 = bestS;
  for (let a = -5; a <= 5.001; a += 0.25) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
  const c0 = best;
  for (let a = c0 - 0.25; a <= c0 + 0.251; a += 0.025) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
  // A flat profile gain is noise, not tilt.
  if (Math.abs(best) < 0.05 || bestS < s0 * 1.02) return 0;
  return Math.round(best * 1000) / 1000;
}

// ----------------------------------------------------------------- clean
// Paper colour per ~8pt block: the mean colour of the brighter half of the
// block's pixels. Blocks that are not paper (photos, dark panels, a dark
// scanner edge, a tinted callout) are refused by brightness against their
// neighbourhood and by tint against the page's paper, then filled in from
// accepted neighbours. Dividing the page by that map makes paper white and
// keeps everything printed on it, tinted panels included.
function clean(data, W, H, scale) {
  const B = Math.max(16, Math.round(8 * scale));
  const gw = Math.ceil(W / B), gh = Math.ceil(H / B), G = gw * gh;
  const NB = 32;
  const hist = new Float32Array(G * NB * 4);
  for (let y = 0; y < H; y += 2) {
    const by = ((y / B) | 0) * gw;
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const l = lumAt(data, i);
      const k = ((by + ((x / B) | 0)) * NB + Math.min(NB - 1, (l / 256 * NB) | 0)) * 4;
      hist[k] += data[i]; hist[k + 1] += data[i + 1]; hist[k + 2] += data[i + 2]; hist[k + 3]++;
    }
  }
  const pr = new Float32Array(G), pg = new Float32Array(G), pb = new Float32Array(G), pl = new Float32Array(G);
  for (let g = 0; g < G; g++) {
    let tot = 0;
    for (let b = 0; b < NB; b++) tot += hist[(g * NB + b) * 4 + 3];
    let r = 0, gg = 0, bl = 0, c = 0;
    for (let b = NB - 1; b >= 0 && c < tot / 2; b--) { const k = (g * NB + b) * 4; r += hist[k]; gg += hist[k + 1]; bl += hist[k + 2]; c += hist[k + 3]; }
    c = c || 1;
    pr[g] = r / c; pg[g] = gg / c; pb[g] = bl / c; pl[g] = 0.299 * pr[g] + 0.587 * pg[g] + 0.114 * pb[g];
  }
  const median = (arr) => { const s = Float32Array.from(arr).sort(); return s[s.length >> 1] || 0; };
  const gl = median(pl);
  const chroma = (g) => { const s = pr[g] + pg[g] + pb[g] || 1; return [pr[g] / s, pg[g] / s, pb[g] / s]; };
  const cs = Array.from({ length: G }, (_, g) => chroma(g));
  const gc = [0, 1, 2].map((k) => median(cs.map((c) => c[k])));
  const ok = new Uint8Array(G);
  const win = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      win.length = 0;
      for (let j = Math.max(0, gy - 3); j <= Math.min(gh - 1, gy + 3); j++) for (let i = Math.max(0, gx - 3); i <= Math.min(gw - 1, gx + 3); i++) win.push(pl[j * gw + i]);
      win.sort((a, b) => a - b);
      const g = gy * gw + gx, c = cs[g];
      const tint = Math.abs(c[0] - gc[0]) + Math.abs(c[1] - gc[1]) + Math.abs(c[2] - gc[2]);
      ok[g] = pl[g] >= 0.5 * gl && pl[g] >= 0.85 * win[win.length >> 1] && tint < 0.018 ? 1 : 0;
    }
  }
  const nonPaper = Uint8Array.from(ok, (v) => 1 - v);
  // Fill refused blocks from accepted neighbours, ring by ring.
  if (!ok.some(Boolean)) { ok.fill(1); for (let g = 0; g < G; g++) { pr[g] = pg[g] = pb[g] = 255; } }
  for (let pass = 0; pass < gw + gh && ok.some((v) => !v); pass++) {
    const set = [];
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const g = gy * gw + gx;
      if (ok[g]) continue;
      let r = 0, gg = 0, bl = 0, c = 0;
      for (let j = Math.max(0, gy - 1); j <= Math.min(gh - 1, gy + 1); j++) for (let i = Math.max(0, gx - 1); i <= Math.min(gw - 1, gx + 1); i++) {
        const q = j * gw + i;
        if (ok[q]) { r += pr[q]; gg += pg[q]; bl += pb[q]; c++; }
      }
      if (c) set.push([g, r / c, gg / c, bl / c]);
    }
    for (const [g, r, gg, bl] of set) { pr[g] = r; pg[g] = gg; pb[g] = bl; ok[g] = 1; }
  }
  // Smooth twice (3x3 box).
  for (let pass = 0; pass < 2; pass++) for (const ch of [pr, pg, pb]) {
    const src = Float32Array.from(ch);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, gy - 1); j <= Math.min(gh - 1, gy + 1); j++) for (let i = Math.max(0, gx - 1); i <= Math.min(gw - 1, gx + 1); i++) { s += src[j * gw + i]; c++; }
      ch[gy * gw + gx] = s / c;
    }
  }
  // Ink level: the 1st percentile of paper-relative lightness (a sample).
  const samp = [];
  for (let k = 0; k < 4000; k++) {
    const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0, g = ((y / B) | 0) * gw + ((x / B) | 0);
    samp.push(lumAt(data, (y * W + x) * 4) / (0.299 * pr[g] + 0.587 * pg[g] + 0.114 * pb[g] || 1));
  }
  samp.sort((a, b) => a - b);
  const lo = Math.min(0.3, Math.max(0, samp[(samp.length * 0.01) | 0]));
  const hi = 0.9;
  const LUT_N = 1024; // ratio 0..2 -> output 0..255
  const lut = new Uint8ClampedArray(LUT_N + 1);
  for (let k = 0; k <= LUT_N; k++) lut[k] = Math.round(((k / LUT_N) * 2 - lo) / (hi - lo) * 255);
  // Bilinear paper map, block centres as nodes; one row of nodes per y.
  const out = new Uint8ClampedArray(data.length);
  const rowR = new Float32Array(gw), rowG = new Float32Array(gw), rowB = new Float32Array(gw);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let gx = 0; gx < gw; gx++) {
      rowR[gx] = pr[y0 * gw + gx] * (1 - ty) + pr[y1 * gw + gx] * ty;
      rowG[gx] = pg[y0 * gw + gx] * (1 - ty) + pg[y1 * gw + gx] * ty;
      rowB[gx] = pb[y0 * gw + gx] * (1 - ty) + pb[y1 * gw + gx] * ty;
    }
    for (let x = 0; x < W; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const br = rowR[x0] * (1 - tx) + rowR[x1] * tx, bg = rowG[x0] * (1 - tx) + rowG[x1] * tx, bb = rowB[x0] * (1 - tx) + rowB[x1] * tx;
      const i = (y * W + x) * 4;
      out[i] = lut[Math.min(LUT_N, (data[i] / (br || 1) * LUT_N / 2) | 0)];
      out[i + 1] = lut[Math.min(LUT_N, (data[i + 1] / (bg || 1) * LUT_N / 2) | 0)];
      out[i + 2] = lut[Math.min(LUT_N, (data[i + 2] / (bb || 1) * LUT_N / 2) | 0)];
      out[i + 3] = 255;
    }
  }
  const edges = dropEdges(out, W, H, scale);
  return { out, B, gw, gh, nonPaper, edges };
}

// Dark, colourless bands touching the page edge are the scanner bed or
// the shadow of the lid, not the worksheet. Walk in from each side on a
// coarse grid and paint them white, up to 8% of the page. Coloured bands
// (a full-bleed header) are part of the design and stay.
function dropEdges(out, W, H, scale) {
  const c = Math.max(3, Math.round(1.5 * scale));
  const cw = Math.ceil(W / c), ch = Math.ceil(H / c);
  const dark = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let l = 0, sat = 0, n = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const x = Math.min(W - 1, ((cx + ox) * c) | 0), y = Math.min(H - 1, ((cy + oy) * c) | 0), i = (y * W + x) * 4;
      l += lumAt(out, i); sat += Math.max(out[i], out[i + 1], out[i + 2]) - Math.min(out[i], out[i + 1], out[i + 2]); n++;
    }
    dark[cy * cw + cx] = l / n < 115 && sat / n < 40 ? 1 : 0;
  }
  const kill = new Uint8Array(cw * ch);
  const walk = (len, max, at) => { // at(k) -> cell index of the k-th cell inward
    // Rotation can leave a sliver of paper outside the band: skip it.
    let k = 0;
    while (k < 3 && !dark[at(k)]) k++;
    if (k >= 3) return;
    while (k < max && (dark[at(k)] || (k + 1 < max && dark[at(k + 1)]))) k++;
    for (let j = 0; j <= Math.min(len - 1, k); j++) kill[at(j)] = 1;
  };
  const mxw = Math.ceil(cw * 0.08), mxh = Math.ceil(ch * 0.08);
  for (let cy = 0; cy < ch; cy++) {
    walk(cw, mxw, (k) => cy * cw + k);
    walk(cw, mxw, (k) => cy * cw + (cw - 1 - k));
  }
  for (let cx = 0; cx < cw; cx++) {
    walk(ch, mxh, (k) => k * cw + cx);
    walk(ch, mxh, (k) => (ch - 1 - k) * cw + cx);
  }
  let n = 0;
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    if (!kill[cy * cw + cx]) continue;
    n++;
    for (let y = cy * c; y < Math.min(H, cy * c + c); y++) out.fill(255, (y * W + cx * c) * 4, (y * W + Math.min(W, cx * c + c)) * 4);
  }
  return n;
}

// ------------------------------------------------------------------ rules
// Long thin dark runs: rows (or columns) of the binarised page, merged
// across neighbouring rows into segments no thicker than 3pt. Solid runs
// bridge 0.6pt breaks. Broken runs (dots, dashes, a row of underscores)
// are evenly spaced short blobs; text rows look like that too, so a broken
// run also needs clear paper just above and below it.
function findRules(out, W, H, scale) {
  const bin = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) bin[p] = lumAt(out, i) < 128 ? 1 : 0;
  const gap = Math.max(2, Math.round(0.6 * scale)), maxThick = 3 * scale;
  const regular = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) < 0.6 * m + 1; };
  const scan = (horiz, minLen) => {
    const N = horiz ? H : W, M = horiz ? W : H;
    const at = horiz ? (r, k) => bin[r * W + k] : (r, k) => bin[k * W + r];
    const segs = [], open = [];
    for (let r = 0; r < N; r++) {
      const runs = [];
      let s = -1, last = -1;
      for (let k = 0; k <= M; k++) {
        const v = k < M && at(r, k);
        if (v) { if (s < 0) s = k; last = k; } else if (s >= 0 && k - last > gap) { if (last - s >= minLen) runs.push([s, last, false]); s = -1; }
      }
      if (horiz) {
        let blobs = [], bs = -1;
        const flush = () => {
          if (blobs.length >= 5 && blobs[blobs.length - 1][1] - blobs[0][0] >= minLen) {
            const gaps = blobs.slice(1).map((d, j) => d[0] - blobs[j][1]);
            if (regular(gaps) && regular(blobs.map((d) => d[1] - d[0] + 1))) runs.push([blobs[0][0], blobs[blobs.length - 1][1], true]);
          }
          blobs = [];
        };
        for (let k = 0; k <= M; k++) {
          const v = k < M && at(r, k);
          if (v && bs < 0) bs = k;
          else if (!v && bs >= 0) {
            if (k - bs <= 8 * scale) {
              if (blobs.length && bs - blobs[blobs.length - 1][1] > 4 * scale) flush();
              blobs.push([bs, k - 1]);
            } else flush();
            bs = -1;
          }
        }
        flush();
      }
      for (const run of runs) {
        const o = open.find((q) => q.last >= r - 2 && q.dotted === run[2] && Math.min(q.k1, run[1]) - Math.max(q.k0, run[0]) > 0.5 * Math.min(q.k1 - q.k0, run[1] - run[0]));
        if (o) { o.k0 = Math.min(o.k0, run[0]); o.k1 = Math.max(o.k1, run[1]); o.last = r; } else open.push({ r0: r, last: r, k0: run[0], k1: run[1], dotted: run[2] });
      }
      for (let j = open.length - 1; j >= 0; j--) if (open[j].last < r - 2) segs.push(...open.splice(j, 1));
    }
    segs.push(...open);
    return segs.filter((q) => q.last - q.r0 + 1 <= maxThick);
  };
  const clear = (q) => {
    const band = (y0, y1) => {
      let n = 0, a = 0;
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) for (let x = q.k0; x <= q.k1; x += 2) { n += bin[y * W + x]; a++; }
      return a ? n / a : 0;
    };
    return band(q.r0 - 4 * scale, q.r0 - 1.2 * scale) < 0.05 && band(q.last + 1.2 * scale, q.last + 4 * scale) < 0.05;
  };
  const toPt = (v) => r2(v / scale);
  const h = scan(true, 20 * scale).filter((q) => !q.dotted || clear(q))
    .map((q) => ({ x0: toPt(q.k0), x1: toPt(q.k1 + 1), y: toPt((q.r0 + q.last + 1) / 2), t: toPt(q.last - q.r0 + 1), dotted: q.dotted }));
  let v = scan(false, 8 * scale).map((q) => ({ y0: toPt(q.k0), y1: toPt(q.k1 + 1), x: toPt((q.r0 + q.last + 1) / 2), t: toPt(q.last - q.r0 + 1) }));
  // Snap ends that nearly meet, so boxes and tables close exactly the way
  // detectFields expects from vector drawings.
  const S = 5;
  for (const a of v) for (const b of h) {
    if (b.x0 - S < a.x && a.x < b.x1 + S) {
      if (Math.abs(b.y - a.y0) < S) a.y0 = b.y;
      if (Math.abs(b.y - a.y1) < S) a.y1 = b.y;
    }
  }
  // A short vertical is a box side only if both its ends meet a rule;
  // otherwise it is likely a letter stroke (l, I, d).
  v = v.filter((a) => a.y1 - a.y0 >= 20 || [a.y0, a.y1].every((y) => h.some((b) => !b.dotted && b.y === y)));
  for (const b of h) for (const a of v) {
    if (a.y0 - S < b.y && b.y < a.y1 + S) {
      if (Math.abs(a.x - b.x0) < S) b.x0 = a.x;
      if (Math.abs(a.x - b.x1) < S) b.x1 = a.x;
    }
  }
  return { h, v, bin };
}

// Closed rectangles from four rules, for detectFields' empty-box step
// (tables of several cells are left to its table step).
function rectsFrom(h, v) {
  const out = [];
  for (const top of h) {
    if (top.dotted) continue;
    for (const bot of h) {
      if (bot === top || bot.dotted || bot.y - top.y < 12 || Math.abs(bot.x0 - top.x0) > 6 || Math.abs(bot.x1 - top.x1) > 6) continue;
      const side = (x) => v.some((a) => Math.abs(a.x - x) < 6 && a.y0 <= top.y + 6 && a.y1 >= bot.y - 6);
      if (!side(top.x0) || !side(top.x1)) continue;
      if (v.some((a) => a.x > top.x0 + 6 && a.x < top.x1 - 6 && a.y0 <= top.y + 6 && a.y1 >= bot.y - 6)) break;
      out.push([top.x0, top.y, top.x1, bot.y]);
      break;
    }
  }
  return out;
}

// -------------------------------------------------------------- tesseract
let tessP = null;
async function tesseract() {
  if (!tessP) tessP = import(TESSERACT).then((m) => m.default || m).catch((e) => { tessP = null; throw e; });
  return tessP;
}

// ------------------------------------------------------------------ words
const JUNK = /^[-–—~=|'"`^*+<>«»°\\/]+$/;
function wordsOf(blocks, scale) {
  const lines = [];
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = [];
    for (const w of l.words || []) {
      const text = String(w.text || '').trim();
      if (!text || JUNK.test(text)) continue;
      if (w.confidence < 30 && !/[\p{L}\p{N}]/u.test(text)) continue;
      const { x0, y0, x1, y1 } = w.bbox;
      if (x1 <= x0 || y1 <= y0) continue;
      words.push({ text, conf: w.confidence / 100, box: [x0, y0, x1, y1], syms: (w.symbols || []).map((s) => [s.bbox.x0, s.bbox.y0, s.bbox.x1, s.bbox.y1, s.text]) });
    }
    if (!words.length) continue;
    words.sort((a, b) => a.box[0] - b.box[0]);
    const ra = l.rowAttributes || {};
    // Font size from glyph heights: x-height letters are ~0.5 em, capitals
    // and ascenders ~0.72 em in common text faces. Tesseract's row height
    // is the fallback.
    const xs = [], as = [];
    for (const w of words) for (const s of w.syms) {
      const h = s[3] - s[1];
      if (/^[acemnorsuvwxz]$/.test(s[4])) xs.push(h / 0.5);
      else if (/^[A-HK-NR-Z0-9bdhkl]$/.test(s[4])) as.push(h / 0.72);
    }
    const est = [...xs, ...as].sort((a, b) => a - b);
    const hs = words.map((w) => w.box[3] - w.box[1]).sort((a, b) => a - b);
    // (Measured glyph boxes run ~25% large: scan blur and binarisation.)
    const sizePx = est.length >= 3 ? est[est.length >> 1] / 1.25 : ra.rowHeight > 0 ? ra.rowHeight / 0.95 : hs[hs.length >> 1] / 0.85;
    const bl = l.baseline && l.baseline.x1 > l.baseline.x0 ? l.baseline : null;
    const baseAt = (x) => (bl ? bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0) : Math.max(...words.map((w) => w.box[3])));
    lines.push({ words, sizePx, baseAt });
  }
  return lines;
}

// Ink colour, stroke width, and whether the paper around a word is flat
// enough to paint over (it isn't inside a photo).
function inkOf(out, W, H, box, sizePx) {
  const pad = Math.max(2, Math.round(sizePx * 0.12));
  const x0 = Math.max(0, box[0] - pad), y0 = Math.max(0, box[1] - pad), x1 = Math.min(W - 1, box[2] + pad), y1 = Math.min(H - 1, box[3] + pad);
  const ring = [[], [], [], []];
  const take = (x, y) => { const i = (y * W + x) * 4; ring[0].push(out[i]); ring[1].push(out[i + 1]); ring[2].push(out[i + 2]); ring[3].push(lumAt(out, i)); };
  for (let t = 1; t <= 3; t++) {
    const ya = y0 - t, yb = y1 + t, xa = x0 - t, xb = x1 + t;
    for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x += 1) { if (ya >= 0) take(x, ya); if (yb < H) take(x, yb); }
    for (let y = Math.max(0, ya); y <= Math.min(H - 1, yb); y += 1) { if (xa >= 0) take(xa, y); if (xb < W) take(xb, y); }
  }
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1] ?? 255; };
  const paper = [med(ring[0]), med(ring[1]), med(ring[2])];
  const pl = med(ring[3]);
  const mad = med(ring[3].map((v) => Math.abs(v - pl)));
  const ink = [[], [], []];
  let A = 0, P = 0;
  const thr = pl - 70;
  const isInk = (x, y) => x >= box[0] && x < box[2] && y >= box[1] && y < box[3] && lumAt(out, (y * W + x) * 4) < thr;
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    if (!isInk(x, y)) continue;
    const i = (y * W + x) * 4;
    A++;
    if (A % 3 === 0) { ink[0].push(out[i]); ink[1].push(out[i + 1]); ink[2].push(out[i + 2]); }
    if (!isInk(x - 1, y) || !isInk(x + 1, y) || !isInk(x, y - 1) || !isInk(x, y + 1)) P++;
  }
  return { pad, rect: [x0, y0, x1, y1], paper, flat: mad < 14 && pl > 60, ink: ink[0].length ? [med(ink[0]), med(ink[1]), med(ink[2])] : null, inkPx: A, stroke: P ? (2 * A) / P : 0 };
}
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Words -> runs: split a line where words are far apart (columns, a label
// and its blank) and, in digital mode, where erasable and kept words meet.
function runsOf(lines, scale, keepFlag) {
  const runs = [];
  for (const l of lines) {
    let cur = null;
    for (const w of l.words) {
      const gapPx = cur ? w.box[0] - cur.words[cur.words.length - 1].box[2] : 0;
      const flag = keepFlag ? keepFlag(w) : false;
      if (!cur || gapPx > 1.6 * l.sizePx || cur.flag !== flag) {
        cur = { line: l, words: [], flag };
        runs.push(cur);
      }
      cur.words.push(w);
    }
  }
  for (const r of runs) {
    const ws = r.words, l = r.line;
    const x0 = ws[0].box[0], x1 = ws[ws.length - 1].box[2];
    // charX: symbol boxes when they line up with the text, else spread.
    const charX = [];
    let str = '';
    ws.forEach((w, k) => {
      if (k) { charX.push(r2((ws[k - 1].box[2] - x0) / scale)); str += ' '; }
      const syms = w.syms.length === [...w.text].length ? w.syms : null;
      [...w.text].forEach((ch, j) => {
        const sx = syms ? syms[j][0] : w.box[0] + ((w.box[2] - w.box[0]) * j) / w.text.length;
        for (let u = 0; u < ch.length; u++) charX.push(r2((sx - x0) / scale));
        str += ch;
      });
    });
    r.str = str;
    r.x = r2(x0 / scale);
    r.width = r2((x1 - x0) / scale);
    r.baseline = r2(l.baseAt((x0 + x1) / 2) / scale);
    r.size = r2(Math.max(4, l.sizePx / scale));
    r.charX = charX;
    r.conf = Math.min(...ws.map((w) => w.conf));
    r.box = [x0, Math.min(...ws.map((w) => w.box[1])), x1, Math.max(...ws.map((w) => w.box[3]))];
  }
  return runs;
}

// -------------------------------------------------------- multiple choice
// Option markers "A." .. "E." (also "a)", "A,"), first in their run or
// set apart by a gap, in sequence A, B, C... under a numbered question.
const MARK = /^([A-Ea-e])[.,)](?![.\d])/;
const NUM = /^\s*(\d{1,2})[.)]\s*\S/;
function findChoices(runs, scale) {
  const marks = [];
  runs.forEach((r, ri) => r.words.forEach((w, wi) => {
    const m = MARK.exec(w.text);
    if (!m) return;
    const prev = r.words[wi - 1];
    const sizePx = r.line.sizePx;
    if (prev && w.box[0] - prev.box[2] < 0.6 * sizePx) return;
    // The letter itself: its symbol box when tesseract gave one.
    const s = w.syms[0];
    const lb = s ? [s[0], s[1], s[2], s[3]] : [w.box[0], w.box[1], w.box[0] + (w.box[2] - w.box[0]) / Math.max(1, w.text.length), w.box[3]];
    marks.push({ ch: m[1], run: r, ri, w, lb, sizePx });
  }));
  const groups = [];
  let g = null;
  for (const m of marks) {
    const last = g && g[g.length - 1];
    const next = last && m.ch.charCodeAt(0) === last.ch.charCodeAt(0) + 1;
    if (next && m.lb[1] >= last.lb[1] - 0.6 * m.sizePx && m.lb[1] - last.lb[3] < 3 * m.sizePx) { g.push(m); continue; }
    g = /[Aa]/.test(m.ch) ? [m] : null;
    if (g) groups.push(g);
  }
  return groups.filter((q) => q.length >= 3).map((q) => {
    const first = q[0];
    const options = q.map((m) => {
      const cx = (m.lb[0] + m.lb[2]) / 2, cy = (m.lb[1] + m.lb[3]) / 2;
      const side = Math.max(m.lb[2] - m.lb[0], m.lb[3] - m.lb[1]) + 0.35 * m.sizePx;
      return { value: m.ch.toUpperCase(), x: r2((cx - side / 2) / scale), y: r2((cy - side / 2) / scale), w: r2(side / scale), h: r2(side / scale) };
    });
    // The question: the nearest numbered run above the first option, and
    // its continuation lines down to the options.
    const top = first.run.box[1];
    const stem = runs.slice(0, first.ri + 1).filter((r) => NUM.test(r.str) && r.box[1] < top - 2 && top - r.box[3] < 6 * first.sizePx && r.box[0] <= first.lb[2] + 2 * first.sizePx)
      .sort((a, b) => b.box[1] - a.box[1])[0];
    let prompt = '', n = null;
    if (stem) {
      n = NUM.exec(stem.str)[1];
      const cont = runs.filter((r) => r !== stem && r.box[1] > stem.box[1] + 2 && r.box[3] <= top + 2 && r.box[0] >= stem.box[0] - 4 && !q.some((m) => m.run === r));
      prompt = [stem, ...cont].sort((a, b) => a.box[1] - b.box[1]).map((r) => r.str).join(' ').replace(/\s+/g, ' ').slice(0, 400);
    }
    const xs = options.flatMap((o) => [o.x, o.x + o.w]), ys = options.flatMap((o) => [o.y, o.y + o.h]);
    const runsIn = [...new Set(q.map((m) => m.run))];
    const region = [Math.min(...xs, ...(stem ? [stem.x] : [])) - 4, (stem ? stem.box[1] / scale : Math.min(...ys)) - 2,
      Math.max(...xs, ...runsIn.map((r) => r.x + r.width), ...(stem ? [stem.x + stem.width] : [])) + 4, Math.max(...ys, ...runsIn.map((r) => r.box[3] / scale)) + 2];
    return {
      field: { kind: 'choice', x: r2(Math.min(...xs)), y: r2(Math.min(...ys)), w: r2(Math.max(...xs) - Math.min(...xs)), h: r2(Math.max(...ys) - Math.min(...ys)),
        label: n ? `Jawaban no. ${n}` : 'Pilihan ganda', prompt, options, source: 'ocr' },
      region,
    };
  });
}

// ------------------------------------------------------------- the page
async function ocrPage(page, sp, worker, o, report) {
  const t0 = performance.now();
  const W0 = sp.width, H0 = sp.height;
  const scale = Math.min(o.dpi / 72, o.maxSide / Math.max(W0, H0));
  // 1. render
  const vp = page.getViewport({ scale });
  const W = Math.round(vp.width), H = Math.round(vp.height);
  const c1 = canvas(W, H);
  const g1 = ctx2d(c1);
  g1.fillStyle = '#fff'; g1.fillRect(0, 0, W, H);
  await page.render({ canvasContext: g1, viewport: vp }).promise;
  report(0.08);
  await tick();
  // 2. clean: deskew first, so everything after works on level lines
  let data = g1.getImageData(0, 0, W, H).data;
  const angle = estimateSkew(data, W, H);
  if (angle) {
    // Fill what rotation exposes with the page's own paper (a bright
    // sample), so the corners flatten like the rest.
    const lums = [];
    for (let k = 0; k < 3000; k++) { const i = (((Math.random() * H) | 0) * W + ((Math.random() * W) | 0)) * 4; lums.push([lumAt(data, i), i]); }
    lums.sort((a, b) => b[0] - a[0]);
    const [, pi] = lums[(lums.length * 0.2) | 0];
    const c2 = canvas(W, H), g2 = ctx2d(c2);
    g2.fillStyle = `rgb(${data[pi]},${data[pi + 1]},${data[pi + 2]})`;
    g2.fillRect(0, 0, W, H);
    g2.imageSmoothingQuality = 'high';
    g2.translate(W / 2, H / 2);
    g2.rotate((-angle * Math.PI) / 180);
    g2.drawImage(c1, -W / 2, -H / 2);
    data = g2.getImageData(0, 0, W, H).data;
    c2.width = c2.height = 0;
  }
  const cl = clean(data, W, H, scale);
  data = null;
  const out = cl.out;
  const img = new ImageData(out, W, H);
  g1.setTransform(1, 0, 0, 1, 0, 0);
  g1.putImageData(img, 0, 0);
  report(0.2);
  await tick();
  // 3. OCR on the clean page
  const blob = await new Promise((r) => c1.toBlob(r, 'image/png'));
  o.onRecognize = (p) => report(0.2 + 0.65 * p);
  const { data: res } = await worker.recognize(blob, {}, { blocks: true });
  o.onRecognize = null;
  report(0.86);
  const lines = wordsOf(res.blocks, scale);
  // 4. rules and runs
  const rules = findRules(out, W, H, scale);
  let inks = null;
  if (o.digital) {
    inks = new Map();
    for (const l of lines) for (const w of l.words) inks.set(w, inkOf(out, W, H, w.box, l.sizePx));
  }
  // Digital: a word is redrawn as text only if it reads well enough and sits
  // on flat paper; the rest stay in the picture (invisible text over them).
  const erasable = (w) => w.conf >= 0.45 && /[\p{L}\p{N}]/u.test(w.text) && inks.get(w).flat;
  const runs = runsOf(lines, scale, o.digital ? (w) => !erasable(w) : null);
  const spans = runs.map((r) => ({ text: r.str, x: r.x, baseline: r.baseline, width: r.width, size: r.size, angle: 0, alpha: 1,
    charX: r.charX, font: FONT, family: 'sans-serif', weight: 400, italic: false, color: '#000000' }));
  // Rules the OCR also "read" (a row of dots as "....."): the rule is the
  // better witness, so those words don't count as text over it.
  const onRule = (s) => !/[\p{L}\p{N}]/u.test(s.text) && rules.h.some((h) => Math.abs(h.y - (s.baseline - s.size * 0.1)) < s.size * 0.6 && Math.min(h.x1, s.x + s.width) - Math.max(h.x0, s.x) > 0.5 * s.width);
  const ruleSpans = spans.filter((s) => !onRule(s));
  const shapes = [];
  for (const h of rules.h) shapes.push({ type: 'path', bbox: [h.x0, h.y - h.t / 2, h.x1, h.y + h.t / 2], stroke: '#000000', lw: h.t, dash: h.dotted ? [1, 2] : null, line: true, subCount: 1 });
  for (const v of rules.v) shapes.push({ type: 'path', bbox: [v.x - v.t / 2, v.y0, v.x + v.t / 2, v.y1], stroke: '#000000', lw: v.t, line: true, subCount: 1 });
  for (const b of rectsFrom(rules.h, rules.v)) shapes.push({ type: 'path', bbox: b, stroke: '#000000', closed: true, boxy: true });
  // Pictures and dark panels (blocks the paper estimate refused, in
  // clusters of at least 3x3): no answer goes in or across them.
  for (const b of regions(cl.nonPaper, cl.gw, cl.gh)) {
    if (b[2] - b[0] < 3 || b[3] - b[1] < 3) continue;
    shapes.push({ type: 'image', bbox: b.map((v) => r2((v * cl.B) / scale)) });
  }
  if (globalThis.__ocrDebug) globalThis.__ocrDebug.push({ page: sp.id, h: rules.h, v: rules.v });
  const det = imp.detectFields({ page: 0, spans: ruleSpans, shapes, widgets: [], width: W0, height: H0 });
  const choices = findChoices(runs, scale);
  const fields = [];
  for (const f of det) {
    const box = [f.x, f.y, f.x + f.w, f.y + f.h];
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    if (choices.some((c) => cx > c.region[0] && cx < c.region[2] && cy > c.region[1] && cy < c.region[3])) continue;
    const o2 = { kind: f.kind === 'input' ? 'text' : f.kind, x: f.x, y: f.y, w: f.w, h: f.h, label: f.label || '', source: 'ocr' };
    if (f.lineGap) { o2.lineGap = f.lineGap; o2.lines = f.lines; }
    if (f.size) o2.size = f.size;
    const prompt = imp.promptFor(box, spans);
    const n = NUM.exec(prompt || '');
    if (prompt && prompt !== o2.label) o2.prompt = prompt;
    // "Nama : ....." keeps its own label; an answer under question 3 is
    // "Jawaban no. 3".
    if (n && (!o2.label || f.source !== 'leader' || NUM.test(o2.label))) o2.label = `Jawaban no. ${n[1]}`;
    fields.push(o2);
  }
  for (const c of choices) fields.push(c.field);
  fields.sort((a, b) => (Math.abs(a.y - b.y) < 6 ? a.x - b.x : a.y - b.y));
  fields.forEach((f, i) => { f.id = `${sp.id}-f${i + 1}`; });

  // 5. digital: erase, then style the runs
  let bold = null;
  if (o.digital) {
    for (const r of runs) {
      if (r.flag) continue;
      for (const w of r.words) {
        const k = inks.get(w);
        const [x0, y0, x1, y1] = k.rect;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0, i = (y * W + x0) * 4; x <= x1; x++, i += 4) { out[i] = k.paper[0]; out[i + 1] = k.paper[1]; out[i + 2] = k.paper[2]; }
        }
      }
    }
    g1.putImageData(img, 0, 0);
    // Bold: stroke width relative to size, against the page's median.
    const ratio = (r) => { let a = 0, s = 0; for (const w of r.words) { const k = inks.get(w); a += k.inkPx; s += k.stroke * k.inkPx; } return a ? s / a / r.line.sizePx : 0; };
    const rs = runs.filter((r) => !r.flag).map((r) => [r, ratio(r)]).filter(([, v]) => v > 0);
    const sorted = rs.map(([, v]) => v).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1] || 0;
    bold = new Set(rs.length >= 5 ? rs.filter(([, v]) => v > 1.3 * med).map(([r]) => r) : []);
  }
  report(0.93);
  await tick();
  const text = runs.map((r, i) => {
    const t = { id: `${sp.id}-t${i + 1}`, x: r.x, baseline: r.baseline, w: r.width, size: r.size, font: FONT, str: r.str.slice(0, 2000), conf: r2(r.conf) };
    if (!o.digital || r.flag) { t.alpha = 0; return t; }
    if (bold.has(r)) t.weight = 700;
    const inksOf = r.words.map((w) => inks.get(w)).filter((k) => k.ink);
    if (inksOf.length) {
      const col = [0, 1, 2].map((ch) => { const v = inksOf.map((k) => k.ink[ch]).sort((a, b) => a - b); return v[v.length >> 1]; });
      // Near-black stays the default black; anything else is real colour.
      if (Math.max(...col) > 70 || Math.max(...col) - Math.min(...col) > 30) t.color = hex(col);
    }
    return t;
  });

  // Background: the cleaned (and, digitally, erased) page as one JPEG.
  const pxPerPt = Math.min(2.2, scale);
  const c3 = canvas(Math.round(W0 * pxPerPt), Math.round(H0 * pxPerPt));
  const g3 = c3.getContext('2d');
  g3.imageSmoothingQuality = 'high';
  g3.drawImage(c1, 0, 0, c3.width, c3.height);
  let q = 0.8, uri = c3.toDataURL('image/jpeg', q);
  while (uri.length > 2.5e6 && q > 0.4) { q -= 0.15; uri = c3.toDataURL('image/jpeg', q); }
  c1.width = c1.height = c3.width = c3.height = 0;
  sp.background = `<svg xmlns="http://www.w3.org/2000/svg" width="${W0}" height="${H0}" viewBox="0 0 ${W0} ${H0}" aria-hidden="true"><image href="${uri}" x="0" y="0" width="${W0}" height="${H0}" preserveAspectRatio="none"/></svg>`;
  sp.text = text;
  sp.fields = fields;
  const words = lines.reduce((n, l) => n + l.words.length, 0);
  const ms = Math.round(performance.now() - t0);
  sp.stats = { ...(sp.stats || {}), ocr: { ms, words, angle, digital: !!o.digital, edgeCells: cl.edges, rules: rules.h.length + rules.v.length } };
  return { id: sp.id, ms, words, angle };
}

// Bounding boxes (in block units) of 8-connected clusters of set cells.
function regions(mask, gw, gh) {
  const seen = new Uint8Array(mask.length), out = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const st = [s]; seen[s] = 1;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (st.length) {
      const g = st.pop(), x = g % gw, y = (g / gw) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const xx = x + i, yy = y + j, q = yy * gw + xx;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && mask[q] && !seen[q]) { seen[q] = 1; st.push(q); }
      }
    }
    out.push([x0, y0, x1, y1]);
  }
  return out;
}

/**
 * OCR the scanned pages of `sheet` (as produced by importPdf from the same
 * bytes), in place.
 * @param pdfjs  the pdf.js module
 * @param data   the PDF bytes (Uint8Array / ArrayBuffer)
 * @param sheet  sheet.json object; pages are matched by id (p<n> = page n)
 * @param opts   { digital, onProgress({page, pages, pct}), docOptions,
 *                 langs = ['ind', 'eng'], dpi = 300, maxSide = 3508 }
 */
export async function ocrSheet(pdfjs, data, sheet, opts = {}) {
  const o = { dpi: 300, maxSide: 3508, langs: ['ind', 'eng'], ...opts };
  const todo = sheet.pages.filter(pageNeedsOcr);
  const result = { pages: [] };
  if (!todo.length) return result;
  const n = todo.length;
  const report = (i) => (p) => o.onProgress && o.onProgress({ page: i + 1, pages: n, pct: Math.min(1, (i + p) / n) });
  report(0)(0);
  const T = await tesseract();
  const worker = await T.createWorker(o.langs, 1, {
    logger: (m) => { if (m.status === 'recognizing text' && o.onRecognize) o.onRecognize(m.progress || 0); },
  });
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isOffscreenCanvasSupported: false, verbosity: 0, ...(o.docOptions || {}) }).promise;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: String(Math.round(o.dpi)), preserve_interword_spaces: '0' });
    for (const [i, sp] of todo.entries()) {
      const num = parseInt(String(sp.id).replace(/^p/, ''), 10);
      if (!(num >= 1 && num <= doc.numPages)) continue;
      const page = await doc.getPage(num);
      result.pages.push(await ocrPage(page, sp, worker, o, report(i)));
      page.cleanup();
      report(i)(1);
    }
    sheet.fonts = { ...(sheet.fonts || {}), [FONT]: FONT_DEF };
  } finally {
    await worker.terminate().catch(() => {});
    await doc.destroy();
  }
  return result;
}

export const _internal = { estimateSkew, clean, findRules, findChoices };
