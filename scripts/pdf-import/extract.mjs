#!/usr/bin/env node
// PDF -> editable worksheet scaffold. Spike for issue #2; see
// docs/pdf-import-spike.md for what this does well and where it breaks.
//
//   node extract.mjs <in.pdf> <outDir> [--pages 2-3]
//
// Writes <outDir>/outline.json (everything we extracted, in top-left pt
// coordinates) and <outDir>/scaffold.html (one absolutely-positioned page per
// PDF page: an SVG background layer, a text layer, and an answer-field layer
// whose <textarea>/<input data-store> elements use the same binding
// convention as src/worksheet).
//
// Why we walk the operator list instead of using getTextContent() alone:
// getTextContent() gives strings and positions but no colour and only a
// generic font family. The operator list is the same data the canvas renderer
// consumes, so interpreting it gives text colour, real font names, vector
// shapes, gradients, clips and images in one pass. getTextContent() is still
// run as a cross-check (character coverage in outline.json stats).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { OPS } = pdfjs;

// ---------------------------------------------------------------- matrices
// Row-vector convention, same as PDF: mul(a, b) applies a first, then b.
const ID = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const r2 = (v) => Math.round(v * 100) / 100;
const hex = (rgb) => '#' + [...rgb].slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join('');
const fmtM = (m) => m.map((v) => +v.toFixed(4)).join(' ');

// ------------------------------------------------------------------- PNG
function png(width, height, colorType, bitDepth, rows) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function withFilterBytes(data, rowBytes, height) {
  const out = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (rowBytes + 1)] = 0;
    out.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  return out;
}
// pdf.js decoded image -> PNG data URI. kind 1 = 1bpp gray (bit 1 = white,
// rows byte-aligned, which is exactly PNG's 1-bit grayscale), 2 = RGB, 3 = RGBA.
function imageToDataUri(img) {
  const { width: w, height: h, kind, data } = img;
  if (!data) return null;
  let buf;
  if (kind === 1) buf = png(w, h, 0, 1, withFilterBytes(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (w + 7) >> 3, h));
  else if (kind === 2) buf = png(w, h, 2, 8, withFilterBytes(Buffer.from(data.buffer, data.byteOffset, data.byteLength), w * 3, h));
  else if (kind === 3) buf = png(w, h, 6, 8, withFilterBytes(Buffer.from(data.buffer, data.byteOffset, data.byteLength), w * 4, h));
  else return null;
  return 'data:image/png;base64,' + buf.toString('base64');
}
// Stencil mask (paintImageMaskXObject): bit 0 = paint with the fill colour,
// bit 1 = transparent (matches pdf.js convertBlackAndWhiteToRGBA).
function maskToDataUri(img, rgb) {
  const { width: w, height: h, data } = img;
  if (!data) return null;
  const rowIn = (w + 7) >> 3;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bit = (data[y * rowIn + (x >> 3)] >> (7 - (x & 7))) & 1;
    const o = (y * w + x) * 4;
    rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = bit ? 0 : 255;
  }
  return 'data:image/png;base64,' + png(w, h, 6, 8, withFilterBytes(rgba, w * 4, h)).toString('base64');
}

// ------------------------------------------------------------------ fonts
// Type 3 and subset fonts can't be reused on the web (see the findings doc),
// so we map the PDF font *name* to a CSS stack. Where a metric-compatible
// Google font exists we load it, so line widths survive on machines that
// don't have the original (Georgia -> Gelasio, Arial/Helvetica -> Arimo, ...).
const KNOWN = {
  arial: ['Arial', 'Arimo', 'sans-serif'],
  helvetica: ['Helvetica', 'Arimo', 'sans-serif'],
  helveticaneue: ['Helvetica Neue', 'Arimo', 'sans-serif'],
  liberationsans: ['Liberation Sans', 'Arimo', 'sans-serif'],
  times: ['Times New Roman', 'Tinos', 'serif'],
  timesnewroman: ['Times New Roman', 'Tinos', 'serif'],
  liberationserif: ['Liberation Serif', 'Tinos', 'serif'],
  courier: ['Courier New', 'Cousine', 'monospace'],
  couriernew: ['Courier New', 'Cousine', 'monospace'],
  georgia: ['Georgia', 'Gelasio', 'serif'],
  calibri: ['Calibri', 'Carlito', 'sans-serif'],
  cambria: ['Cambria', 'Caladea', 'serif'],
  symbol: ['Symbol', null, 'serif'],
  zapfdingbats: ['ZapfDingbats', null, 'serif'],
};
const GOOGLE = new Set(['Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Inter', 'Merriweather',
  'Noto Sans', 'Noto Serif', 'Nunito', 'Raleway', 'Playfair Display', 'Source Sans 3', 'PT Sans', 'PT Serif',
  'Arimo', 'Tinos', 'Cousine', 'Gelasio', 'Carlito', 'Caladea']);

function parseFontName(name) {
  let raw = (name || '').replace(/^[A-Z]{6}\+/, '');
  const m = raw.match(/^([^-,]+)[-,]?(.*)$/) || [raw, raw, ''];
  let base = m[1].replace(/(PSMT|PS|MT)$/, '');
  let style = m[2].replace(/(PSMT|PS|MT)$/, '');
  // "TimesNewRomanPS-BoldItalicMT", "Times-Roman", "ArialMT", "Calibri,Bold"
  const lower = (base + ' ' + style).toLowerCase();
  let weight = 400;
  if (/black|heavy/.test(lower)) weight = 900;
  else if (/extrabold|ultrabold/.test(lower)) weight = 800;
  else if (/semibold|demibold|demi/.test(lower)) weight = 600;
  else if (/bold/.test(lower)) weight = 700;
  else if (/medium/.test(lower)) weight = 500;
  else if (/extralight|ultralight/.test(lower)) weight = 200;
  else if (/light/.test(lower)) weight = 300;
  else if (/thin|hairline/.test(lower)) weight = 100;
  const italic = /italic|oblique/.test(lower);
  base = base.replace(/(Bold|Italic|Oblique|Regular)+$/, '');
  const pretty = base.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'sans-serif';
  return { family: pretty, key: pretty.toLowerCase().replace(/\s+/g, ''), weight, italic };
}

function fontInfo(font, cache) {
  const id = font.loadedName;
  if (cache.has(id)) return cache.get(id);
  const p = parseFontName(font.name);
  const known = KNOWN[p.key];
  const generic = known ? known[2] : font.isMonospace ? 'monospace' : font.isSerifFont ? 'serif' : (font.fallbackName || 'sans-serif');
  const stack = [];
  const web = [];
  if (known) { stack.push(known[0]); if (known[1]) { stack.push(known[1]); web.push(known[1]); } }
  else { stack.push(p.family); if (GOOGLE.has(p.family)) web.push(p.family); }
  stack.push(generic);
  const info = {
    id, pdfName: font.name, family: p.family, weight: p.weight, italic: p.italic,
    css: stack.map((f) => (/^(serif|sans-serif|monospace)$/.test(f) ? f : `'${f}'`)).join(', '),
    web, type3: !!font.isType3Font, embedded: !font.missingFile,
    fontMatrix: font.fontMatrix || [0.001, 0, 0, 0.001, 0, 0],
  };
  cache.set(id, info);
  return info;
}

// --------------------------------------------------------------- per page
async function extractPage(page, pageNo) {
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const ops = await page.getOperatorList();
  const fontCache = new Map();
  const unsupported = {};
  const bump = (k) => { unsupported[k] = (unsupported[k] || 0) + 1; };

  const shapes = [];   // background layer, in paint order (paths, shading rects, images)
  const glyphs = [];   // individual glyph placements, merged into spans later
  const clips = new Map(); // key -> {id, d, rule, parent}
  const gradients = [];
  let clipSeq = 0;

  const getObj = (store, id) => { try { return store.get(id); } catch { return null; } };
  const getCommon = (id) => getObj(page.commonObjs, id);
  const getImg = (id) => (id.startsWith('g_') ? getCommon(id) : getObj(page.objs, id)) || getCommon(id);

  const fresh = () => ({
    ctm: vp.transform.slice(), base: vp.transform.slice(),
    fill: [0, 0, 0], stroke: [0, 0, 0], fillPat: null, strokePat: null,
    fa: 1, sa: 1, lw: 1, dash: null, dashPhase: 0, cap: 0, join: 0, blend: null,
    clip: null, clipBox: [0, 0, W, H],
    font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0,
  });
  let st = fresh();
  const stack = [];
  let tm = ID.slice(), tlm = ID.slice();
  let cur = null; // path under construction: {d, pts, rect, bbox}
  let pendingClip = null;

  function addClip(p, rule) {
    // Skia/Chrome PDFs wrap nearly every element in page-sized rectangle
    // clips; a rect clip that already contains the current clip changes
    // nothing, so drop it. Identical chains are shared via the key.
    const bb = p.bbox;
    if (p.rect && bb[0] <= st.clipBox[0] + 0.5 && bb[1] <= st.clipBox[1] + 0.5 &&
        bb[2] >= st.clipBox[2] - 0.5 && bb[3] >= st.clipBox[3] - 0.5) return;
    const key = (st.clip || '') + '|' + rule + '|' + p.d;
    let c = clips.get(key);
    if (!c) { c = { id: `c${pageNo}-${++clipSeq}`, d: p.d, rule, parent: st.clip }; clips.set(key, c); }
    st.clip = c.id;
    st.clipBox = [Math.max(st.clipBox[0], bb[0]), Math.max(st.clipBox[1], bb[1]),
      Math.min(st.clipBox[2], bb[2]), Math.min(st.clipBox[3], bb[3])];
  }

  function buildPath(subOps, coords) {
    const m = st.ctm;
    const d = [];
    const pts = [];
    let i = 0, cx = 0, cy = 0, sx = 0, sy = 0;
    const P = (x, y) => { const q = apply(m, x, y); pts.push(q); return r2(q[0]) + ' ' + r2(q[1]); };
    let segs = 0, onlyLines = true;
    for (const op of subOps) {
      switch (op) {
        case OPS.moveTo: cx = sx = coords[i++]; cy = sy = coords[i++]; d.push('M' + P(cx, cy)); break;
        case OPS.lineTo: cx = coords[i++]; cy = coords[i++]; d.push('L' + P(cx, cy)); segs++; break;
        case OPS.curveTo: {
          const [a, b, c, e, x, y] = coords.slice(i, i + 6); i += 6;
          d.push('C' + P(a, b) + ' ' + P(c, e) + ' ' + P(x, y)); cx = x; cy = y; segs++; onlyLines = false; break;
        }
        case OPS.curveTo2: { // first control point = current point
          const [c, e, x, y] = coords.slice(i, i + 4); i += 4;
          d.push('C' + P(cx, cy) + ' ' + P(c, e) + ' ' + P(x, y)); cx = x; cy = y; segs++; onlyLines = false; break;
        }
        case OPS.curveTo3: { // second control point = end point
          const [a, b, x, y] = coords.slice(i, i + 4); i += 4;
          d.push('C' + P(a, b) + ' ' + P(x, y) + ' ' + P(x, y)); cx = x; cy = y; segs++; onlyLines = false; break;
        }
        case OPS.closePath: d.push('Z'); cx = sx; cy = sy; break;
        case OPS.rectangle: {
          const [x, y, w, h] = coords.slice(i, i + 4); i += 4;
          d.push('M' + P(x, y) + 'L' + P(x + w, y) + 'L' + P(x + w, y + h) + 'L' + P(x, y + h) + 'Z');
          cx = sx = x; cy = sy = y; segs += 4; break;
        }
        default: break;
      }
    }
    if (!cur) cur = { d: [], pts: [], subOps: [], segs: 0, onlyLines: true };
    cur.d.push(...d); cur.pts.push(...pts); cur.subOps.push(...subOps); cur.segs += segs;
    cur.onlyLines = cur.onlyLines && onlyLines;
  }

  function finishPath() {
    const p = cur; cur = null;
    if (!p || !p.pts.length) return null;
    const xs = p.pts.map((q) => q[0]), ys = p.pts.map((q) => q[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // Axis-aligned single rectangle? (either `re` or M + 3/4 L + Z)
    let rect = null;
    if (p.onlyLines && (p.pts.length === 4 || p.pts.length === 5)) {
      const ok = p.pts.every((q) => (Math.abs(q[0] - bbox[0]) < 0.01 || Math.abs(q[0] - bbox[2]) < 0.01) &&
        (Math.abs(q[1] - bbox[1]) < 0.01 || Math.abs(q[1] - bbox[3]) < 0.01));
      if (ok) rect = { x: r2(bbox[0]), y: r2(bbox[1]), w: r2(bbox[2] - bbox[0]), h: r2(bbox[3] - bbox[1]) };
    }
    // Single straight segment (an answer line or a rule)
    let line = null;
    if (p.onlyLines && p.pts.length === 2) line = p.pts.map((q) => [r2(q[0]), r2(q[1])]);
    // "Boxy": most points (incl. Bezier control points) sit on the bbox
    // edges, true for rects and rounded rects, false for illustration shapes.
    const near = (v, a, b) => Math.abs(v - a) < 1.5 || Math.abs(v - b) < 1.5;
    const onEdge = p.pts.filter((q) => near(q[0], bbox[0], bbox[2]) || near(q[1], bbox[1], bbox[3])).length;
    const boxy = !!rect || onEdge >= 0.85 * p.pts.length;
    return { d: p.d.join(''), bbox, rect, line, boxy, closed: p.d.includes('Z') || !!rect, subCount: p.subOps.length };
  }

  function paint(fill, stroke, rule) {
    const p = finishPath();
    if (pendingClip && p) addClip(p, pendingClip);
    pendingClip = null;
    if (fill && st.fillPat === 'none') fill = false;
    if (stroke && st.strokePat === 'none') stroke = false;
    if (!p || (!fill && !stroke)) return;
    const s = st.ctm;
    const sh = {
      type: 'path', d: p.d, bbox: p.bbox.map(r2), rect: p.rect, line: p.line, closed: p.closed, boxy: p.boxy, subCount: p.subCount,
      fill: fill ? (st.fillPat ? `url(#${st.fillPat})` : hex(st.fill)) : null,
      fillRule: rule, fa: st.fa,
      stroke: stroke ? (st.strokePat ? `url(#${st.strokePat})` : hex(st.stroke)) : null,
      sa: st.sa, lw: stroke ? r2(Math.max(st.lw * scaleOf(s), 0.3)) : 0,
      dash: stroke && st.dash && st.dash.length ? st.dash.map((v) => r2(v * scaleOf(s))) : null,
      cap: st.cap, join: st.join, blend: st.blend, clip: st.clip,
    };
    if (fill && sh.fa === 0 && (!stroke || sh.sa === 0)) return;
    shapes.push(sh);
  }

  function gradientFromIR(ir, matrix) {
    if (!ir) return null;
    if (ir[0] === 'RadialAxial') {
      const [, kind, , stopsRaw, p0, p1, r0, r1] = ir;
      const id = `g${pageNo}-${gradients.length + 1}`;
      const stops = stopsRaw.map(([o, c]) => [r2(o), c]);
      gradients.push({ id, kind: kind === 'radial' ? 'radial' : 'linear', p0, p1, r0, r1, stops, transform: matrix });
      return id;
    }
    if (ir[0] === 'Mesh') {
      // Mesh shadings (types 4-7) have no SVG equivalent; approximate with
      // a flat average colour and report it.
      bump('meshShading');
      const colors = ir[3];
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i + 2 < colors.length; i += 3) { r += colors[i]; g += colors[i + 1]; b += colors[i + 2]; n++; }
      const id = `g${pageNo}-${gradients.length + 1}`;
      const c = n ? hex([Math.round(r / n), Math.round(g / n), Math.round(b / n)]) : '#888888';
      gradients.push({ id, kind: 'flat', stops: [[0, c], [1, c]], transform: ID });
      return id;
    }
    bump('unknownShading:' + ir[0]);
    return null;
  }

  function setPattern(args, which) {
    if (args[0] === 'Shading') {
      // Pattern IRs are sent per page (page.objs); shadings via `sh` may be common.
      const ir = getObj(page.objs, args[1]) || getCommon(args[1]);
      const id = gradientFromIR(ir, mul(args[2] || ID, st.base));
      st[which] = id;
    } else if (args[0] === 'TilingPattern') {
      // Tiling patterns would need their own operator list rendered into an
      // SVG <pattern>; out of scope for the spike. Chrome/Skia emits them for
      // gradients with alpha (glows), wrapped in a luminosity soft mask: for
      // those, painting nothing is closer than any opaque fallback.
      bump('tilingPattern');
      const sub = args[2];
      const masked = sub && sub.argsArray.some((x) => x && x[0] && x[0].smask);
      const shIdx = sub ? sub.fnArray.indexOf(OPS.shadingFill) : -1;
      if (masked) st[which] = 'none';
      else if (shIdx >= 0) st[which] = gradientFromIR(getObj(page.objs, sub.argsArray[shIdx][0]) || getCommon(sub.argsArray[shIdx][0]), mul(args[3] || ID, st.base));
      else { st[which] = null; st[which === 'fillPat' ? 'fill' : 'stroke'] = [200, 200, 200]; }
    } else bump('pattern:' + args[0]);
  }

  function placeImage(dataUri, w, h, kind) {
    if (!dataUri) { bump('undecodedImage'); return; }
    const m = mul([1, 0, 0, -1, 0, 1], st.ctm);
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(m, x, y));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    shapes.push({ type: 'image', href: dataUri, matrix: m, pxW: w, pxH: h, kind,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r2), fa: st.fa, clip: st.clip, blend: st.blend });
  }

  function showGlyphs(glyphsArg) {
    const font = st.font;
    if (!font) return;
    const fi = fontInfo(font, fontCache);
    const fm = fi.fontMatrix;
    const fs = st.fs, th = st.th;
    const invisible = st.mode === 3 || st.mode === 7;
    if (invisible) bump('invisibleText');
    for (const g of glyphsArg) {
      if (typeof g === 'number') { // TJ adjustment, thousandths of text space
        const tx = (-g / 1000) * fs * th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
        continue;
      }
      if (!g) continue;
      const w = (g.width || 0) * fm[0] * fs;
      const tx = (w + st.tc + (g.isSpace ? st.tw : 0)) * th;
      const trm = mul(mul([fs * th, 0, 0, fs, 0, st.rise], tm), st.ctm);
      if (!invisible && g.unicode) {
        const o = apply(trm, 0, 0);
        const size = Math.hypot(trm[2], trm[3]);
        const angle = Math.atan2(trm[1], trm[0]);
        // Advance on the page = (tx, 0) through the text matrix and CTM.
        const tmc = mul(tm, st.ctm);
        const adv = Math.hypot(tx * tmc[0], tx * tmc[1]);
        const stroke = st.mode === 1 || st.mode === 5;
        const color = stroke ? st.stroke : st.fill;
        glyphs.push({
          ch: g.unicode, x: o[0], y: o[1], size, angle, adv,
          font: fi.id, color: hex(color), alpha: stroke ? st.sa : st.fa,
          pattern: !stroke && st.fillPat && st.fillPat !== 'none' ? true : undefined,
        });
      }
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
  }

  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ...st, ctm: st.ctm.slice() }); break;
      case OPS.restore: if (stack.length) st = stack.pop(); break;
      case OPS.transform: st.ctm = mul(a, st.ctm); break;
      case OPS.setLineWidth: st.lw = a[0]; break;
      case OPS.setLineCap: st.cap = a[0]; break;
      case OPS.setLineJoin: st.join = a[0]; break;
      case OPS.setDash: st.dash = a[0]; st.dashPhase = a[1]; break;
      case OPS.setFillRGBColor: st.fill = a; st.fillPat = null; break;
      case OPS.setStrokeRGBColor: st.stroke = a; st.strokePat = null; break;
      case OPS.setFillColorN: setPattern(a, 'fillPat'); break;
      case OPS.setStrokeColorN: setPattern(a, 'strokePat'); break;
      case OPS.setGState:
        for (const [k, v] of a[0]) {
          if (k === 'LW') st.lw = v;
          else if (k === 'LC') st.cap = v;
          else if (k === 'LJ') st.join = v;
          else if (k === 'D') { st.dash = v[0]; st.dashPhase = v[1]; }
          else if (k === 'ca') st.fa = v;
          else if (k === 'CA') st.sa = v;
          else if (k === 'BM') { st.blend = v && v !== 'source-over' ? v : null; if (st.blend) bump('blendMode:' + v); }
          else if (k === 'SMask') { if (v) bump('softMask'); }
          else if (k === 'Font') { st.font = getCommon(v[0]); st.fs = v[1]; }
        }
        break;
      case OPS.constructPath: buildPath(a[0], a[1]); break;
      case OPS.clip: pendingClip = 'nonzero'; break;
      case OPS.eoClip: pendingClip = 'evenodd'; break;
      case OPS.endPath: paint(false, false); break;
      case OPS.fill: paint(true, false, 'nonzero'); break;
      case OPS.eoFill: paint(true, false, 'evenodd'); break;
      case OPS.stroke: paint(false, true); break;
      case OPS.closeStroke: if (cur) cur.d.push('Z'); paint(false, true); break;
      case OPS.fillStroke: paint(true, true, 'nonzero'); break;
      case OPS.eoFillStroke: paint(true, true, 'evenodd'); break;
      case OPS.closeFillStroke: if (cur) cur.d.push('Z'); paint(true, true, 'nonzero'); break;
      case OPS.closeEOFillStroke: if (cur) cur.d.push('Z'); paint(true, true, 'evenodd'); break;
      case OPS.shadingFill: {
        const id = gradientFromIR(getObj(page.objs, a[0]) || getCommon(a[0]), st.ctm);
        if (id) {
          const [x0, y0, x1, y1] = st.clipBox;
          shapes.push({ type: 'path', d: `M${r2(x0)} ${r2(y0)}H${r2(x1)}V${r2(y1)}H${r2(x0)}Z`, bbox: st.clipBox.map(r2),
            rect: null, fill: `url(#${id})`, fa: st.fa, stroke: null, clip: st.clip, blend: st.blend, shading: true });
        }
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...st, ctm: st.ctm.slice() });
        if (a[0]) st.ctm = mul(a[0], st.ctm);
        st.base = st.ctm.slice();
        if (a[1]) {
          const [x0, y0, x1, y1] = a[1];
          buildPath([OPS.rectangle], [x0, y0, x1 - x0, y1 - y0]);
          pendingClip = 'nonzero'; paint(false, false);
        }
        break;
      }
      case OPS.paintFormXObjectEnd: if (stack.length) st = stack.pop(); break;
      case OPS.beginGroup: {
        const g = a[0] || {};
        if (g.smask) bump('groupSoftMask');
        if (g.knockout) bump('knockoutGroup');
        break;
      }
      case OPS.paintImageXObject: case OPS.paintImageXObjectRepeat: {
        const img = getImg(a[0]);
        if (img && img.bitmap) { bump('bitmapImage'); break; }
        if (fn === OPS.paintImageXObjectRepeat) bump('imageRepeat');
        placeImage(img && imageToDataUri(img), a[1] || img?.width, a[2] || img?.height, 'image');
        break;
      }
      case OPS.paintInlineImageXObject: placeImage(imageToDataUri(a[0]), a[0].width, a[0].height, 'inline'); break;
      case OPS.paintImageMaskXObject: placeImage(maskToDataUri(a[0], st.fill), a[0].width, a[0].height, 'mask'); break;
      case OPS.paintSolidColorImageMask: {
        buildPath([OPS.rectangle], [0, 0, 1, 1]); paint(true, false, 'nonzero'); break;
      }
      case OPS.paintImageMaskXObjectGroup: case OPS.paintImageMaskXObjectRepeat: case OPS.paintInlineImageXObjectGroup:
        bump('imageGroup'); break;
      // ---- text
      case OPS.beginText: tm = ID.slice(); tlm = ID.slice(); break;
      case OPS.endText: break;
      case OPS.setFont: st.font = getCommon(a[0]); st.fs = a[1]; break;
      case OPS.setCharSpacing: st.tc = a[0]; break;
      case OPS.setWordSpacing: st.tw = a[0]; break;
      case OPS.setHScale: st.th = a[0] / 100; break;
      case OPS.setLeading: st.tl = a[0]; break;
      case OPS.setTextRise: st.rise = a[0]; break;
      case OPS.setTextRenderingMode: st.mode = a[0]; break;
      case OPS.setTextMatrix: tm = a.slice(); tlm = a.slice(); break;
      case OPS.moveText: tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm.slice(); break;
      case OPS.setLeadingMoveText: st.tl = -a[1]; tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm.slice(); break;
      case OPS.nextLine: tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm.slice(); break;
      case OPS.showText: case OPS.showSpacedText: showGlyphs(a[0]); break;
      case OPS.nextLineShowText:
        tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm.slice(); showGlyphs(a[0]); break;
      case OPS.nextLineSetSpacingShowText:
        st.tw = a[0]; st.tc = a[1]; tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm.slice(); showGlyphs(a[2]); break;
      default: break;
    }
  }

  // Text colour from a pattern fill (gradient text) is reduced to the base colour.
  if (glyphs.some((g) => g.pattern)) bump('patternFilledText');

  const fonts = Object.fromEntries([...fontCache.values()].map((f) => [f.id, f]));
  const spans = mergeGlyphs(glyphs, fonts);

  // Cross-check against getTextContent()
  const tc = await page.getTextContent();
  const tcChars = tc.items.reduce((n, it) => n + (it.str || '').replace(/\s/g, '').length, 0);
  const ourChars = spans.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);

  const annots = (await page.getAnnotations()).filter((an) => an.subtype === 'Widget');
  const widgets = annots.map((an) => {
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(an.rect);
    return { fieldType: an.fieldType, name: an.fieldName, multiLine: !!an.multiLine, checkBox: !!an.checkBox,
      x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  });

  const pageData = { page: pageNo, width: r2(W), height: r2(H), fonts, spans, shapes,
    clips: [...clips.values()], gradients, widgets, unsupported,
    stats: { opCount: fnArray.length, glyphs: glyphs.length, spans: spans.length, shapes: shapes.length,
      images: shapes.filter((s) => s.type === 'image').length, clips: clips.size, gradients: gradients.length,
      textContentChars: tcChars, extractedChars: ourChars } };
  pageData.fields = detectFields(pageData);
  return pageData;
}

// Merge glyphs (Skia/Chrome PDFs place every glyph separately) into spans:
// same baseline, same style, contiguous in x. A gap wider than ~0.18em
// between two non-space glyphs becomes a space.
function mergeGlyphs(glyphs, fonts) {
  const spans = [];
  let s = null;
  const styleKey = (g) => `${g.font}|${g.color}|${g.alpha}|${g.size.toFixed(2)}|${g.angle.toFixed(3)}`;
  for (const g of glyphs) {
    const key = styleKey(g);
    if (s && s.key === key && Math.abs(g.angle) < 0.001) {
      const gap = g.x - s.endX;
      if (Math.abs(g.y - s.y) < 0.2 * g.size && gap > -0.5 * g.size && gap < 0.9 * g.size) {
        const last = s.text[s.text.length - 1];
        if (gap > 0.18 * g.size && last !== ' ' && g.ch !== ' ') s.text += ' ';
        s.text += g.ch; s.chars.push([r2(g.x - s.x), g.ch]); s.endX = g.x + g.adv;
        continue;
      }
    }
    if (s && s.key === key && Math.abs(g.angle) >= 0.001 && Math.abs(g.y - s.endY) < 0.6 * g.size && Math.abs(g.x - s.endX) < 0.6 * g.size) {
      s.text += g.ch; s.chars.push([0, g.ch]); s.endX = g.x + g.adv * Math.cos(g.angle); s.endY = g.y + g.adv * Math.sin(g.angle);
      s.rotAdv += g.adv;
      continue;
    }
    if (s) spans.push(s);
    s = { key, x: g.x, y: g.y, endX: g.x + g.adv * Math.cos(g.angle), endY: g.y + g.adv * Math.sin(g.angle), rotAdv: g.adv,
      size: g.size, angle: g.angle, font: g.font, color: g.color, alpha: g.alpha, text: g.ch, chars: [[0, g.ch]] };
  }
  if (s) spans.push(s);
  return spans
    .map((sp) => {
      const t = sp.text.replace(/\s+$/, '');
      if (!t.trim()) return null;
      const lead = t.length - t.trimStart().length;
      const f = fonts[sp.font];
      const rotated = Math.abs(sp.angle) >= 0.001;
      const width = rotated ? sp.rotAdv : sp.endX - sp.x;
      return {
        text: t.trimStart(), x: r2(sp.x + (lead && sp.chars[lead] ? sp.chars[lead][0] : 0)), baseline: r2(sp.y),
        width: r2(width - (lead && sp.chars[lead] ? sp.chars[lead][0] : 0)), size: r2(sp.size),
        angle: rotated ? +(sp.angle * 180 / Math.PI).toFixed(2) : 0,
        font: sp.font, family: f.family, weight: f.weight, italic: f.italic, color: sp.color, alpha: sp.alpha,
        charX: sp.chars.slice(lead).map((c) => r2(c[0] - (lead ? sp.chars[lead][0] : 0))),
      };
    })
    .filter(Boolean);
}

// ----------------------------------------------------------- field finder
// Heuristics, most specific first. Every field gets a stable id
// (p<page>-f<n>) in reading order so the rooms layer can bind to it.
function detectFields(pg) {
  const { spans, shapes, widgets, width: W, height: H } = pg;
  const cands = [];
  const textBox = (s) => [s.x, s.baseline - s.size * 0.8, s.x + s.width, s.baseline + s.size * 0.2];
  // Watermarks (rotated or translucent text) don't make an area "full".
  const tboxes = spans.filter((s) => !s.angle && s.alpha >= 0.5).map(textBox);
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const textIn = (b, pad = 0) => tboxes.filter((t) => overlap(t, [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]) > 0.3 * area(t));

  // 0. Real AcroForm text widgets: exact, no guessing.
  for (const w of widgets) {
    if (w.fieldType === 'Tx') cands.push({ src: 'acroform', kind: w.multiLine ? 'textarea' : 'input', box: [w.x, w.y, w.x + w.w, w.y + w.h], prio: 0, name: w.name });
    else if (w.checkBox) cands.push({ src: 'acroform', kind: 'checkbox', box: [w.x, w.y, w.x + w.w, w.y + w.h], prio: 0, name: w.name });
  }

  // 1. Leader runs in text: "Nama: ..........." or "____".
  for (const s of spans) {
    if (s.angle) continue;
    const re = /[._…]{4,}/g;
    let m;
    while ((m = re.exec(s.text))) {
      const x0 = s.x + (s.charX[m.index] ?? 0);
      const endIdx = m.index + m[0].length;
      const x1 = endIdx < s.charX.length ? s.x + s.charX[endIdx] : s.x + s.width;
      if (x1 - x0 < 20) continue;
      // Label: the words before the leader in the same run ("Nama :").
      const before = s.text.slice(0, m.index).split(/[._\u2026]{4,}/).pop().replace(/[:\s]+$/, '').trim();
      cands.push({ src: 'leader', kind: 'input', box: [x0, s.baseline - s.size * 1.15, x1, s.baseline + s.size * 0.25], prio: 1, size: s.size,
        name: before || undefined });
    }
  }

  // Rules: anything long and at most 2pt thick, whatever drew it: a stroked
  // segment, a thin filled rect, or (Skia/Chrome) one filled compound path
  // made of hundreds of tiny dot subpaths.
  const TEXTAREA_MIN_H = 26;
  const hRules = [], vRules = [];
  for (const sh of shapes) {
    if (sh.type !== 'path' || sh.shading || (!sh.fill && !sh.stroke)) continue;
    const [x0, y0, x1, y1] = sh.bbox;
    const dashed = !!sh.dash || (sh.subCount > 8 && !sh.line);
    if (y1 - y0 <= 2 && x1 - x0 > 8) hRules.push({ x0, x1, y: (y0 + y1) / 2, dashed });
    else if (x1 - x0 <= 2 && y1 - y0 > 8) vRules.push({ y0, y1, x: (x0 + x1) / 2 });
  }
  // Dotted lines drawn as separate tiny dot/dash shapes: cluster them.
  const dots = shapes.filter((sh) => sh.type === 'path' && sh.fill && !sh.stroke &&
    sh.bbox[2] - sh.bbox[0] < 6 && sh.bbox[3] - sh.bbox[1] < 3 && sh.bbox[2] - sh.bbox[0] > 0).map((sh) => sh.bbox);
  dots.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (let i = 0; i < dots.length;) {
    let j = i + 1; let x1 = dots[i][2];
    const run = [dots[i]];
    while (j < dots.length && Math.abs(dots[j][1] - dots[i][1]) < 0.5 && dots[j][0] - x1 < 8) { x1 = Math.max(x1, dots[j][2]); run.push(dots[j]); j++; }
    if (run.length >= 8) hRules.push({ x0: run[0][0], x1, y: (run[0][1] + run[0][3]) / 2, dashed: true });
    i = j;
  }
  // Collapse duplicates (Skia paints some rules several times).
  const hs = [];
  for (const h of hRules.filter((r) => r.x1 - r.x0 > 20).sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    if (!hs.some((o) => Math.abs(o.y - h.y) < 1 && Math.abs(o.x0 - h.x0) < 1.5 && Math.abs(o.x1 - h.x1) < 1.5)) hs.push(h);
  }

  // 2. Tables. A row of cells shows up either as vertical rules between two
  //    horizontal rules, or (Chrome tables with border-collapse) as one
  //    horizontal segment per column with no inner verticals at all. In both
  //    cases a cell is a horizontal segment with a matching segment (same x
  //    extent) below it. Only rows that look tabular (side-by-side segments,
  //    or verticals at the ends) count, so plain writing lines stay lines.
  // Filled rects contribute their top/bottom edges too: a table's first
  // row often starts at the bottom of a dark header cell, with no rule.
  const edges = hs.slice();
  for (const sh of shapes) {
    if (sh.type !== 'path' || !sh.rect || !sh.fill || sh.rect.w <= 20 || sh.rect.h < 10) continue;
    const { x, y, w, h } = sh.rect;
    for (const yy of [y, y + h]) if (!edges.some((o) => Math.abs(o.y - yy) < 1 && Math.abs(o.x0 - x) < 1.5 && Math.abs(o.x1 - x - w) < 1.5)) edges.push({ x0: x, x1: x + w, y: yy, edge: true });
  }
  edges.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const usedH = new Set();
  const tableCells = [];
  const sameY = (a, b) => Math.abs(a.y - b.y) < 1.2;
  const hasVert = (x, ya, yb) => vRules.some((v) => Math.abs(v.x - x) < 2 && v.y0 <= ya + 2 && v.y1 >= yb - 2);
  const tabular = (h) => edges.some((o) => o !== h && sameY(o, h) && (Math.abs(o.x0 - h.x1) < 2 || Math.abs(o.x1 - h.x0) < 2));
  for (const top of edges) {
    let bot = null;
    for (const o of edges) if (o.y - top.y >= 10 && o.y - top.y <= 200 && Math.abs(o.x0 - top.x0) < 2 && Math.abs(o.x1 - top.x1) < 2) { bot = o; break; }
    if (!bot) continue;
    const boxed = hasVert(top.x0, top.y, bot.y) && hasVert(top.x1, top.y, bot.y);
    if (!(tabular(top) || tabular(bot) || boxed)) continue;
    // Split by inner verticals, if any.
    const xs = [top.x0, ...vRules.filter((v) => v.x > top.x0 + 2 && v.x < top.x1 - 2 && v.y0 <= top.y + 2 && v.y1 >= bot.y - 2).map((v) => v.x).sort((a, b) => a - b), top.x1];
    usedH.add(top); usedH.add(bot);
    for (let k = 0; k + 1 < xs.length; k++) {
      const cell = [xs[k], top.y, xs[k + 1], bot.y];
      if (cell[2] - cell[0] < 20) continue;
      tableCells.push(cell);
      if (textIn(cell, -1).length) continue;
      cands.push({ src: 'table', kind: bot.y - top.y >= TEXTAREA_MIN_H ? 'textarea' : 'input', box: [cell[0] + 3, cell[1] + 3, cell[2] - 3, cell[3] - 3], prio: 2,
        name: tableLabel(cell, spans, tableCells) });
    }
  }
  // Rules with vertical edges at both ends (box outlines drawn as 4 rules)
  // are not writing lines either.
  for (const h of hs) if (vRules.some((v) => Math.abs(v.x - h.x0) < 2 && (Math.abs(v.y0 - h.y) < 2 || Math.abs(v.y1 - h.y) < 2)) &&
    vRules.some((v) => Math.abs(v.x - h.x1) < 2 && (Math.abs(v.y0 - h.y) < 2 || Math.abs(v.y1 - h.y) < 2))) usedH.add(h);

  // 3. Answer lines: long rules with empty writing space above them.
  //    Excluded: rules with any text sitting on them (section underlines),
  //    and header/footer separators (in the top/bottom 10% of the page with
  //    running text just beyond them).
  const isSeparator = (h) => (h.y > H * 0.9 && tboxes.some((t) => t[1] > h.y && t[1] < h.y + 24)) ||
    (h.y < H * 0.1 && tboxes.some((t) => t[3] < h.y && t[3] > h.y - 24));
  const lines = hs.filter((h) => !usedH.has(h) && h.x1 - h.x0 >= 40 && h.x1 - h.x0 < W * 0.95 && !isSeparator(h))
    .filter((h) => !tboxes.some((t) => overlap(t, [h.x0, h.y - 10, h.x1, h.y + 1]) > 0));
  // Stack equally spaced lines of equal extent into one multi-line textarea.
  const groups = [];
  for (const l of lines) {
    const g = groups.find((gr) => {
      const last = gr[gr.length - 1];
      const gap = l.y - last.y;
      const prevGap = gr.length > 1 ? last.y - gr[gr.length - 2].y : null;
      return Math.abs(l.x0 - last.x0) < 3 && Math.abs(l.x1 - last.x1) < 3 && gap > 10 && gap < 40 && (prevGap === null || Math.abs(gap - prevGap) < 2) &&
        !tboxes.some((t) => overlap(t, [l.x0, last.y + 1, l.x1, l.y - 1]) > 0);
    });
    if (g) g.push(l); else groups.push([l]);
  }
  for (const g of groups) {
    const first = g[0], last = g[g.length - 1];
    if (g.length === 1) {
      // A lone rule with no prompt anywhere near it is decoration.
      if (!labelFor([first.x0, first.y - 18, first.x1, first.y], spans)) continue;
      // Height: whatever empty space is above, capped at 18pt.
      const above = tboxes.filter((t) => t[3] <= first.y && Math.min(t[2], first.x1) > Math.max(t[0], first.x0)).map((t) => t[3]);
      const top = Math.max(first.y - 18, above.length ? Math.max(...above) + 1 : -Infinity);
      cands.push({ src: 'line', kind: 'input', box: [first.x0, top, first.x1, first.y - 0.5], prio: 3 });
    } else {
      const gap = (last.y - first.y) / (g.length - 1);
      cands.push({ src: 'lines', kind: 'textarea', box: [first.x0, first.y - gap, first.x1, last.y], prio: 3, lineGap: r2(gap), lines: g.length });
    }
  }

  // 3b. Checkboxes: small, empty, square boxes with text just to the right.
  for (const sh of shapes) {
    if (sh.type !== 'path' || !sh.closed || !sh.boxy || !sh.stroke) continue;
    const [x0, y0, x1, y1] = sh.bbox, w = x1 - x0, h = y1 - y0;
    if (w < 6 || w > 16 || Math.abs(w - h) > 2) continue;
    if (textIn(sh.bbox).length) continue;
    const label = spans.find((s) => !s.angle && s.x > x1 && s.x - x1 < 15 && s.baseline > y0 && s.baseline - s.size * 0.7 < y1);
    if (label) cands.push({ src: 'checkbox', kind: 'checkbox', box: [x0, y0, x1, y1], prio: 1, name: label.text });
  }

  // 4. Empty boxes: closed shapes big enough to write in whose interior is
  //    empty (or only holds a heading at the top). Innermost wins. Dark
  //    fills are skipped: nobody writes on a dark panel, but illustrations
  //    are full of dark closed shapes.
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
  const dark = shapes.filter((sh) => sh.type === 'path' && sh.fill && (sh.fill.startsWith('url') || lum(sh.fill) < 0.6)).map((sh) => sh.bbox);
  const sameBox = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 3);
  const boxes = shapes.filter((sh) => sh.type === 'path' && sh.closed && sh.boxy && !sh.shading && (sh.fill || sh.stroke))
    .map((sh) => sh.bbox)
    .filter((b) => !dark.some((d) => sameBox(d, b)))
    .filter((b) => !tableCells.some((c) => b[0] >= c[0] - 2 && b[2] <= c[2] + 2 && b[1] >= c[1] - 2 && b[3] <= c[3] + 2))
    .filter((b) => b[2] - b[0] >= 60 && b[3] - b[1] >= 24 && area(b) < 0.6 * W * H);
  const uniq = [];
  for (const b of boxes) if (!uniq.some((u) => u.every((v, k) => Math.abs(v - b[k]) < 3))) uniq.push(b);
  const inner = uniq.filter((b) => !uniq.some((o) => o !== b && o[0] >= b[0] - 0.5 && o[1] >= b[1] - 0.5 && o[2] <= b[2] + 0.5 && o[3] <= b[3] + 0.5 &&
    area(o) < area(b) * 0.9 && o[2] - o[0] >= 60 && o[3] - o[1] >= 24));
  for (const b of inner) {
    if (shapes.some((s) => s.type === 'image' && overlap(s.bbox, b) > 0.2 * area(b))) continue;
    const inside = textIn(b);
    let top = b[1];
    if (inside.length) {
      const bottom = Math.max(...inside.map((t) => t[3]));
      if (bottom > b[1] + 0.5 * (b[3] - b[1])) continue; // a callout full of text, not an answer box
      top = bottom + 2;
    }
    const box = [b[0] + 4, top + 2, b[2] - 4, b[3] - 4];
    if (box[3] - box[1] < 16) continue;
    // A box holding several writing lines is better served by the lines; a
    // box with a single decorative rule inside is still one answer box.
    const inLines = cands.filter((c) => (c.src === 'line' || c.src === 'lines') && overlap(c.box, box) > 0.5 * area(c.box));
    if (inLines.some((c) => c.src === 'lines') || inLines.length > 1) continue;
    for (const c of inLines) c.drop = true;
    cands.push({ src: 'box', kind: box[3] - box[1] >= TEXTAREA_MIN_H ? 'textarea' : 'input', box, prio: 4 });
  }

  // De-duplicate: a lower-priority candidate that overlaps an accepted one
  // is dropped.
  cands.sort((a, b) => a.prio - b.prio);
  const accepted = [];
  for (const c of cands) {
    if (c.drop) continue;
    if (accepted.some((a) => overlap(a.box, c.box) > 0.25 * Math.min(area(a.box), area(c.box)))) continue;
    accepted.push(c);
  }
  // Reading order: top-to-bottom, then left-to-right (rows within 6pt).
  accepted.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < 6 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]));
  return accepted.map((c, i) => ({
    id: `p${pg.page}-f${i + 1}`, kind: c.kind, source: c.src,
    x: r2(c.box[0]), y: r2(c.box[1]), w: r2(c.box[2] - c.box[0]), h: r2(c.box[3] - c.box[1]),
    lineGap: c.lineGap, lines: c.lines, size: c.size ? r2(c.size) : undefined,
    label: c.name || labelFor(c.box, spans),
  }));
}

// Table cell: "<row label> - <column header>": the leftmost text in the
// same row band, and the nearest text above that sits inside the column.
function tableLabel(cell, spans, cells) {
  const rowText = spans.filter((s) => s.baseline > cell[1] && s.baseline - s.size < cell[3] && s.x + s.width <= cell[0] + 2)
    .sort((a, b) => a.x - b.x || a.baseline - b.baseline)[0];
  // Column header: text in the topmost cell of this column (cells are
  // collected top-down), else the nearest text above inside the column.
  const head = cells.find((c) => Math.abs(c[0] - cell[0]) < 2 && Math.abs(c[2] - cell[2]) < 2 && c[1] < cell[1] && cell[1] - c[1] < 400);
  const inCol = (s) => s.x >= cell[0] - 2 && s.x < cell[2];
  const colText = (head && spans.filter((s) => inCol(s) && s.baseline > head[1] && s.baseline - s.size < head[3]).sort((a, b) => a.baseline - b.baseline)[0]) ||
    spans.filter((s) => inCol(s) && s.baseline <= cell[1] + 1 && cell[1] - s.baseline < 400).sort((a, b) => b.baseline - a.baseline)[0];
  return [rowText && rowText.text, colText && colText.text].filter(Boolean).join(' - ').slice(0, 80);
}

// Nearest text to the left on the same row, else the nearest text above.
function labelFor(box, spans) {
  let best = null, bestD = Infinity;
  for (const s of spans) {
    const sb = [s.x, s.baseline - s.size, s.x + s.width, s.baseline];
    const sameRow = sb[3] > box[1] && sb[1] < box[3] && sb[2] <= box[0] + 4;
    const above = sb[3] <= box[1] + 2 && sb[2] > box[0] - 10 && sb[0] < box[2];
    let d = Infinity;
    if (sameRow) d = box[0] - sb[2];
    else if (above) d = (box[1] - sb[3]) * 1.5 + Math.max(0, sb[0] - box[0]) * 0.1;
    if (d >= 0 && d < bestD && d < 60) { bestD = d; best = s.text; }
  }
  return best ? best.replace(/[._…:]{2,}.*$/, '').replace(/[:\s]+$/, '').slice(0, 80) : '';
}

// ------------------------------------------------------------- HTML out
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderSvg(pg) {
  const defs = [];
  // Clip chains: each <clipPath> is itself clipped by its parent, which
  // gives the intersection semantics PDF clipping needs.
  for (const c of pg.clips) {
    defs.push(`<clipPath id="${c.id}" clipPathUnits="userSpaceOnUse"${c.parent ? ` clip-path="url(#${c.parent})"` : ''}><path d="${c.d}" clip-rule="${c.rule}"/></clipPath>`);
  }
  for (const g of pg.gradients) {
    const stops = g.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
    const tf = `gradientUnits="userSpaceOnUse" gradientTransform="matrix(${fmtM(g.transform)})"`;
    if (g.kind === 'linear') defs.push(`<linearGradient id="${g.id}" ${tf} x1="${g.p0[0]}" y1="${g.p0[1]}" x2="${g.p1[0]}" y2="${g.p1[1]}">${stops}</linearGradient>`);
    else if (g.kind === 'radial') defs.push(`<radialGradient id="${g.id}" ${tf} fx="${g.p0[0]}" fy="${g.p0[1]}" fr="${g.r0}" cx="${g.p1[0]}" cy="${g.p1[1]}" r="${g.r1}">${stops}</radialGradient>`);
    else defs.push(`<linearGradient id="${g.id}">${stops}</linearGradient>`);
  }
  const body = pg.shapes.map((s) => {
    const common = (s.clip ? ` clip-path="url(#${s.clip})"` : '') + (s.blend ? ` style="mix-blend-mode:${s.blend}"` : '');
    if (s.type === 'image') {
      return `<image href="${s.href}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(${fmtM(s.matrix)})"${s.fa < 1 ? ` opacity="${s.fa}"` : ''}${common}/>`;
    }
    let attrs = `d="${s.d}"`;
    attrs += s.fill ? ` fill="${s.fill}"${s.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${s.fa < 1 ? ` fill-opacity="${s.fa}"` : ''}` : ' fill="none"';
    if (s.stroke) {
      attrs += ` stroke="${s.stroke}" stroke-width="${s.lw}"${s.sa < 1 ? ` stroke-opacity="${s.sa}"` : ''}`;
      if (s.dash) attrs += ` stroke-dasharray="${s.dash.join(' ')}"`;
      if (s.cap) attrs += ` stroke-linecap="${['butt', 'round', 'square'][s.cap]}"`;
      if (s.join) attrs += ` stroke-linejoin="${['miter', 'round', 'bevel'][s.join]}"`;
    }
    return `<path ${attrs}${common}/>`;
  });
  return `<svg class="bg" width="${pg.width}" height="${pg.height}" viewBox="0 0 ${pg.width} ${pg.height}" aria-hidden="true"><defs>${defs.join('')}</defs>${body.join('')}</svg>`;
}

function renderPage(pg) {
  const text = pg.spans.map((s) => {
    const style = [`left:${s.x}px`, `top:${r2(s.baseline - s.size)}px`, `font-size:${s.size}px`,
      `font-family:${pg.fonts[s.font].css}`, s.weight !== 400 ? `font-weight:${s.weight}` : '', s.italic ? 'font-style:italic' : '',
      s.color !== '#000000' ? `color:${s.color}` : '', s.alpha < 1 ? `opacity:${s.alpha}` : '',
      s.angle ? `--rot:${s.angle}deg` : ''].filter(Boolean).join(';');
    return `<span class="t" style="${esc(style)}" data-b="${s.baseline}" data-w="${s.width}">${esc(s.text)}<i class="b"></i></span>`;
  }).join('\n');
  const fields = pg.fields.map((f) => {
    const style = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px` +
      (f.lineGap ? `;line-height:${f.lineGap}px;font-size:${Math.min(13, r2(f.lineGap * 0.62))}px` : f.size ? `;font-size:${f.size}px` : '');
    const al = esc(f.label || `Isian ${f.id}`);
    if (f.kind === 'checkbox') return `<input class="f" type="checkbox" id="${f.id}" data-store aria-label="${al}" style="${style}">`;
    if (f.kind === 'textarea') return `<textarea class="f${f.lineGap ? ' lined' : ''}" id="${f.id}" data-store aria-label="${al}" data-source="${f.source}" style="${style}"></textarea>`;
    return `<input class="f" type="text" id="${f.id}" data-store autocomplete="off" aria-label="${al}" data-source="${f.source}" style="${style}">`;
  }).join('\n');
  return `<div class="pw" data-w="${pg.width}" data-h="${pg.height}"><section class="page" id="page-${pg.page}" style="width:${pg.width}px;height:${pg.height}px">
${renderSvg(pg)}
<div class="tl">
${text}
</div>
<div class="fl">
${fields}
</div>
</section></div>`;
}

function renderHtml(title, pages) {
  const web = new Set();
  for (const p of pages) for (const f of Object.values(p.fonts)) if (p.spans.some((s) => s.font === f.id)) f.web.forEach((w) => web.add(w));
  const gf = web.size ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...web].map((f) => 'family=' + f.replace(/ /g, '+') + ':ital,wght@0,400;0,700;1,400;1,700').join('&')}&display=block">` : '';
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="generator" content="ELKPD-ify pdf-import spike (scripts/pdf-import/extract.mjs)">
${gf}
<style>
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:#E7EAEE;font-family:sans-serif}
  .pw{margin:16px auto;position:relative}
  .page{position:absolute;left:0;top:0;transform-origin:0 0;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);overflow:hidden}
  .bg{position:absolute;left:0;top:0}
  .t{position:absolute;white-space:pre;line-height:1;transform-origin:0 0;color:#000}
  .t .b{display:inline-block;width:0;height:0;vertical-align:baseline}
  .edit .t{outline:1px dashed transparent}
  .edit .t:hover,.edit .t:focus{outline-color:rgba(25,118,210,.5)}
  .f{position:absolute;box-sizing:border-box;margin:0;padding:0 2px;border:0;border-radius:2px;background:rgba(25,118,210,.07);
     font:inherit;font-family:'Arimo',Arial,sans-serif;font-size:12px;color:#0D2A57;resize:none;outline:none;
     -webkit-tap-highlight-color:transparent}
  textarea.f{padding:2px}
  textarea.f.lined{background:transparent;padding:0 2px;overflow:hidden}
  .f:focus-visible{box-shadow:0 0 0 2px #1976D2}
  input.f[type=checkbox]{padding:0;opacity:.85;accent-color:#1976D2;cursor:pointer}
  .bare .f{background:transparent}
  .solo body,body.solo{background:#fff}
  body.solo .pw{margin:0}
  body.solo .page{box-shadow:none}
</style>
</head>
<body>
${pages.map(renderPage).join('\n')}
<script>
(function () {
  var q = location.search;
  var solo = /[?&]page=(\\d+)/.exec(q);
  if (solo) {
    document.body.className += ' solo';
    var keep = document.getElementById('page-' + solo[1]);
    var all = document.querySelectorAll('.pw');
    for (var i = 0; i < all.length; i++) if (!keep || all[i] !== keep.parentNode) all[i].style.display = 'none';
  }
  if (/[?&]bare/.test(q)) document.body.className += ' bare';
  if (/[?&]edit/.test(q)) {
    document.body.className += ' edit';
    var ts = document.querySelectorAll('.t');
    for (var j = 0; j < ts.length; j++) ts[j].contentEditable = 'true';
  }
  // Fit each span to the PDF's measured width (like the pdf.js text layer)
  // and put its baseline exactly where the PDF had it, whatever font the
  // browser actually ended up using.
  function fitText() {
    var ts = document.querySelectorAll('.t');
    for (var i = 0; i < ts.length; i++) {
      var s = ts[i], b = s.querySelector('.b');
      s.style.transform = 'none';
      if (b) s.style.top = (parseFloat(s.getAttribute('data-b')) - b.offsetTop) + 'px';
      var target = parseFloat(s.getAttribute('data-w')), w = s.offsetWidth;
      var k = w > 0 && target > 0 ? target / w : 1;
      if (k < 0.5 || k > 2) k = 1;
      var rot = s.style.getPropertyValue('--rot');
      s.style.transformOrigin = '0 ' + (b ? b.offsetTop : 0) + 'px';
      s.style.transform = (rot ? 'rotate(' + rot + ') ' : '') + 'scaleX(' + k.toFixed(4) + ')';
    }
  }
  // Scale whole pages down to the viewport on phones; layout stays in pt.
  function fitPages() {
    var avail = document.documentElement.clientWidth - 32;
    var ps = document.querySelectorAll('.pw');
    for (var i = 0; i < ps.length; i++) {
      var w = +ps[i].getAttribute('data-w'), h = +ps[i].getAttribute('data-h');
      var k = solo ? 1 : Math.min(1.5, Math.max(0.3, avail / w));
      ps[i].style.width = (w * k) + 'px';
      ps[i].style.height = (h * k) + 'px';
      ps[i].firstChild.style.transform = 'scale(' + k + ')';
    }
  }
  fitPages();
  window.addEventListener('resize', fitPages);
  fitText();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitText(); document.documentElement.setAttribute('data-ready', '1'); });
  else document.documentElement.setAttribute('data-ready', '1');
})();
</script>
</body>
</html>
`;
}

// ------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--pages');
  let range = null;
  if (pi >= 0) { const [a, b] = args[pi + 1].split('-').map(Number); range = [a, b || a]; args.splice(pi, 2); }
  const [inFile, outDir] = args;
  if (!inFile || !outDir) {
    console.error('usage: node extract.mjs <in.pdf> <outDir> [--pages a-b]');
    process.exit(2);
  }
  const data = new Uint8Array(fs.readFileSync(inFile));
  const doc = await pdfjs.getDocument({
    data, fontExtraProperties: true, isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0,
    standardFontDataUrl: path.join(HERE, 'node_modules/pdfjs-dist/standard_fonts/'),
  }).promise;
  const meta = await doc.getMetadata().catch(() => ({ info: {} }));
  const pages = [];
  const from = range ? range[0] : 1, to = range ? Math.min(range[1], doc.numPages) : doc.numPages;
  for (let n = from; n <= to; n++) {
    const page = await doc.getPage(n);
    pages.push(await extractPage(page, n));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const title = meta.info?.Title || path.basename(inFile, '.pdf');
  const outline = {
    source: path.basename(inFile), producer: meta.info?.Producer || null, creator: meta.info?.Creator || null,
    numPages: doc.numPages, units: 'pt, origin top-left',
    pages: pages.map((p) => ({ ...p, shapes: p.shapes.map((s) => (s.type === 'image' ? { ...s, href: `[${s.href.length} bytes]` } : s)) })),
  };
  fs.writeFileSync(path.join(outDir, 'outline.json'), JSON.stringify(outline, null, 1));
  fs.writeFileSync(path.join(outDir, 'scaffold.html'), renderHtml(title, pages));
  for (const p of pages) {
    const u = Object.entries(p.unsupported).map(([k, v]) => `${k}×${v}`).join(', ') || 'none';
    const byKind = p.fields.reduce((m, f) => ((m[f.source] = (m[f.source] || 0) + 1), m), {});
    console.log(`page ${p.page}: ${p.stats.spans} spans (${p.stats.extractedChars}/${p.stats.textContentChars} chars vs getTextContent), ` +
      `${p.stats.shapes} shapes, ${p.stats.images} images, ${p.stats.gradients} gradients, ${p.stats.clips} clips, ` +
      `fields ${p.fields.length} ${JSON.stringify(byKind)}; unsupported: ${u}`);
  }
  console.log(`wrote ${path.join(outDir, 'scaffold.html')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
