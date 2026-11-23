// The sheet player: renders a sheet.json (see format.md) as fillable pages.
//
//   import { createPlayer } from './player.js';
//   const player = createPlayer(container, sheet, { onInput(id, value) {} });
//   player.setValue('p1-f3', 'remote text');
//
// What it adds over the #2 spike's scaffold ("a faithful picture with holes"):
//
// REFLOW. A long answer doesn't scroll inside its box: the box grows and
// everything below it on the page moves down. The background is one SVG,
// shown through horizontal *strips*; where a field grows, the strip is cut
// at the field's bottom and the gap is filled by repeating the band just
// above the cut. For a lined answer that band is one writing line, so new
// lines appear; for a box it is a slice of the box's sides and fill, so the
// box gets taller. The paper's look survives without knowing what drew it.
//
// TEXT FIT. Text is real text (selectable, translatable, editable in the
// Studio). Each run is placed on the PDF's baseline and scaleX-fitted to
// the PDF's width, whatever fallback font the browser picked.

const STYLE_ID = 'esh-player-style';
const CSS = `
.esh-sheet{--esh-accent:#1f6feb;--esh-ink:#0d2a57;--esh-tint:rgba(31,111,235,.07);--esh-page-gap:16px}
.esh-pw{position:relative;margin:0 auto var(--esh-page-gap)}
.esh-page{position:absolute;left:0;top:0;transform-origin:0 0;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);overflow:hidden}
.esh-strip{position:absolute;left:0;overflow:hidden;pointer-events:none}
.esh-strip img{position:absolute;left:0;display:block;max-width:none;user-select:none;-webkit-user-drag:none}
.esh-t{position:absolute;white-space:pre;line-height:1;transform-origin:0 0;color:#000;margin:0}
.esh-t .esh-b{display:inline-block;width:0;height:0;vertical-align:baseline}
.esh-f{position:absolute;box-sizing:border-box;margin:0;padding:0 2px;border:0;border-radius:2px;background:var(--esh-tint);
  font-family:'Arimo',Arial,sans-serif;font-size:12px;color:var(--esh-ink);resize:none;outline:none;
  -webkit-tap-highlight-color:transparent;transition:box-shadow .15s}
textarea.esh-f{padding:2px 3px;line-height:1.35;overflow:hidden}
textarea.esh-f.esh-lined{background:transparent;padding:0 2px}
.esh-f:focus-visible{box-shadow:0 0 0 2px var(--esh-accent)}
.esh-f::selection{background:rgba(31,111,235,.25)}
input.esh-f[type=checkbox]{padding:0;accent-color:var(--esh-accent);cursor:pointer;background:transparent}
.esh-f[data-peer]{box-shadow:0 0 0 2px var(--peer-color,#e8710a)}
.esh-peer-flag{position:absolute;transform:translateY(-100%);font:600 10px/1.4 'Arimo',Arial,sans-serif;color:#fff;
  background:var(--peer-color,#e8710a);padding:0 5px;border-radius:4px 4px 4px 0;white-space:nowrap;pointer-events:none;z-index:2}
.esh-sheet.esh-bare .esh-f{background:transparent}
.esh-sheet[data-readonly] .esh-f{pointer-events:none}
@media print{
  .esh-sheet .esh-pw{margin:0;width:auto!important;height:auto!important;break-after:page}
  .esh-sheet .esh-page{position:relative;transform:none!important;box-shadow:none}
  .esh-sheet .esh-f{background:transparent}
  .esh-sheet .esh-f:focus-visible{box-shadow:none}
  .esh-peer-flag{display:none}
}
`;

const r2 = (v) => Math.round(v * 100) / 100;

function injectStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

// Web fonts for the sheet's text, plus the answer font. Resolves once the
// faces are actually loaded: document.fonts.ready alone can resolve before
// a just-inserted stylesheet has even asked for its fonts, and text fitted
// against a fallback face comes out the wrong width.
function loadWebFonts(doc, sheet) {
  const fams = new Set();
  for (const f of Object.values(sheet.fonts || {})) for (const w of f.web || []) fams.add(w);
  fams.add('Arimo'); // answer font
  const href = 'https://fonts.googleapis.com/css2?' +
    [...fams].map((f) => 'family=' + f.replace(/ /g, '+') + ':ital,wght@0,400;0,700;1,400;1,700').join('&') + '&display=block';
  // The load promise lives on the <link>: a second player created while
  // the stylesheet is still in flight must wait for it too, or it asks for
  // faces whose @font-face rules don't exist yet and gets nothing.
  let link = [...doc.querySelectorAll('link[rel=stylesheet]')].find((l) => l.href === href);
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link._eshLoaded = new Promise((resolve) => { link.onload = link.onerror = () => resolve(); });
    doc.head.appendChild(link);
  }
  const sheetLoaded = link._eshLoaded || Promise.resolve();
  if (!doc.fonts || !doc.fonts.load) return sheetLoaded;
  const faces = [];
  for (const fam of fams) for (const v of ['400', '700', 'italic 400', 'italic 700']) faces.push(`${v} 16px "${fam}"`);
  const timeout = new Promise((r) => setTimeout(r, 4000)); // offline: fit with what we have
  return Promise.race([sheetLoaded.then(() => Promise.all(faces.map((f) => doc.fonts.load(f).catch(() => null)))), timeout]);
}

/**
 * @param container  element to render into (emptied)
 * @param sheet      sheet.json object
 * @param opts       { onInput(id, value), onFocus(id|null), values: {id: value},
 *                     readOnly, bare, maxScale = 1.35, fonts = true }
 */
export function createPlayer(container, sheet, opts = {}) {
  const doc = container.ownerDocument;
  injectStyle(doc);
  const fontsReady = opts.fonts === false ? Promise.resolve() : loadWebFonts(doc, sheet);
  const maxScale = opts.maxScale || 1.35;
  const fontCss = (id) => (sheet.fonts && sheet.fonts[id] && sheet.fonts[id].css) || 'sans-serif';

  container.textContent = '';
  const root = doc.createElement('div');
  root.className = 'esh-sheet' + (opts.bare ? ' esh-bare' : '');
  if (opts.readOnly) root.dataset.readonly = '';
  container.appendChild(root);

  const blobUrls = [];
  const fieldEls = new Map(); // id -> element
  const pages = sheet.pages.map((pg) => buildPage(pg));

  function buildPage(pg) {
    const pw = doc.createElement('div');
    pw.className = 'esh-pw';
    const page = doc.createElement('section');
    page.className = 'esh-page';
    page.id = 'esh-' + pg.id;
    page.style.width = pg.width + 'px';
    page.style.height = pg.height + 'px';
    pw.appendChild(page);

    const bg = doc.createElement('div');
    bg.className = 'esh-bg';
    page.appendChild(bg);
    let bgUrl = null;
    if (pg.background) {
      bgUrl = URL.createObjectURL(new Blob([pg.background], { type: 'image/svg+xml' }));
      blobUrls.push(bgUrl);
    }

    const tl = doc.createElement('div');
    tl.className = 'esh-tl';
    page.appendChild(tl);
    const spans = (pg.text || []).map((t) => {
      const s = doc.createElement('p');
      s.className = 'esh-t';
      s.dataset.id = t.id;
      const st = s.style;
      st.left = t.x + 'px';
      st.top = r2(t.baseline - t.size) + 'px';
      st.fontSize = t.size + 'px';
      st.fontFamily = fontCss(t.font);
      if (t.weight) st.fontWeight = t.weight;
      if (t.italic) st.fontStyle = 'italic';
      if (t.color) st.color = t.color;
      if (t.alpha != null && t.alpha < 1) st.opacity = t.alpha;
      s.textContent = t.str;
      const b = doc.createElement('i');
      b.className = 'esh-b';
      s.appendChild(b);
      tl.appendChild(s);
      return { t, el: s, b };
    });

    const fl = doc.createElement('div');
    fl.className = 'esh-fl';
    page.appendChild(fl);
    const fields = (pg.fields || []).map((f) => {
      const el = makeField(f);
      fl.appendChild(el);
      fieldEls.set(f.id, el);
      return { f, el };
    });

    root.appendChild(pw);
    return { pg, pw, page, bg, bgUrl, spans, fields, sig: null, scale: 1 };
  }

  function makeField(f) {
    let el;
    if (f.kind === 'checkbox') {
      el = doc.createElement('input');
      el.type = 'checkbox';
    } else if (f.kind === 'textarea') {
      el = doc.createElement('textarea');
      el.rows = 1;
      if (f.lineGap) el.classList.add('esh-lined');
    } else {
      el = doc.createElement('input');
      el.type = f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text';
      el.autocomplete = 'off';
    }
    el.classList.add('esh-f');
    el.id = f.id;
    el.dataset.store = '';
    el.dataset.kind = f.kind;
    el.setAttribute('aria-label', f.label || 'Isian');
    if (f.placeholder) el.placeholder = f.placeholder;
    if (opts.readOnly) el.readOnly = el.disabled = true;
    const st = el.style;
    if (f.lineGap) {
      st.lineHeight = f.lineGap + 'px';
      st.fontSize = Math.min(13, r2(f.lineGap * 0.62)) + 'px';
    } else if (f.kind !== 'textarea' && f.kind !== 'checkbox') {
      st.fontSize = Math.max(8, Math.min(12, r2((f.size || f.h) * 0.72))) + 'px';
    }
    const v = opts.values && opts.values[f.id];
    if (v != null) setElValue(el, v);
    const fire = () => {
      if (opts.onInput) opts.onInput(f.id, getElValue(el));
      schedule();
    };
    el.addEventListener(f.kind === 'checkbox' ? 'change' : 'input', fire);
    el.addEventListener('focus', () => opts.onFocus && opts.onFocus(f.id));
    el.addEventListener('blur', () => opts.onFocus && opts.onFocus(null));
    return el;
  }

  function getElValue(el) {
    return el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
  }
  function setElValue(el, v) {
    if (el.type === 'checkbox') el.checked = v === '1' || v === true;
    else el.value = v == null ? '' : String(v);
  }

  // ------------------------------------------------------------- layout
  // A breakpoint is where the page gets taller: { at, grow, period }.
  // map(y) = y + total growth of breakpoints strictly above y.
  function measure(p) {
    const bps = [];
    for (const { f, el } of p.fields) {
      if (f.kind !== 'textarea' || f.grow === false) continue;
      el.style.height = f.h + 'px';
      let need = el.scrollHeight;
      if (f.lineGap) need = Math.ceil((need - 1) / f.lineGap) * f.lineGap;
      const grow = Math.max(0, Math.ceil(need - f.h));
      if (!grow) continue;
      // Lined answers cut just below their last writing line and repeat one
      // line pitch; boxes cut at the field bottom (inside the box padding)
      // and repeat a slice of the box.
      const at = f.lineGap ? f.y + f.h + 1.5 : f.y + f.h;
      const period = f.lineGap || Math.max(1, Math.min(8, f.h - 2));
      bps.push({ at, grow: f.lineGap ? Math.ceil(grow / f.lineGap) * f.lineGap : grow, period });
    }
    // Fields that end on the same line (a table row) grow together.
    bps.sort((a, b) => a.at - b.at);
    const merged = [];
    for (const b of bps) {
      const last = merged[merged.length - 1];
      if (last && b.at - last.at < 3) {
        if (b.grow > last.grow) { last.grow = b.grow; last.period = b.period; }
      } else merged.push({ ...b });
    }
    return merged;
  }

  function layout(p) {
    const bps = measure(p);
    const map = (y) => { let o = y; for (const b of bps) if (b.at < y) o += b.grow; else break; return o; };
    const growAt = (y) => { const b = bps.find((q) => Math.abs(q.at - y) < 3 || (q.at > y - 3 && q.at <= y + 1.5)); return b ? b.grow : 0; };
    const total = bps.reduce((n, b) => n + b.grow, 0);
    const H = p.pg.height + total;
    p.page.style.height = H + 'px';

    const sig = JSON.stringify(bps);
    if (sig !== p.sig) {
      p.sig = sig;
      renderStrips(p, bps);
    }
    for (const { t, el } of p.spans) {
      el.style.top = r2(map(t.baseline - t.size) + (el._dy || 0)) + 'px';
    }
    for (const { f, el } of p.fields) {
      const top = map(f.y);
      const bottomEdge = f.lineGap ? f.y + f.h + 1.5 : f.y + f.h;
      const bottom = map(f.y + f.h) + (f.kind === 'textarea' ? growAt(bottomEdge) : 0);
      el.style.left = f.x + 'px';
      el.style.top = r2(top) + 'px';
      el.style.width = f.w + 'px';
      el.style.height = r2(Math.max(f.h, bottom - top)) + 'px';
    }
    fit(p, H);
  }

  function renderStrips(p, bps) {
    p.bg.textContent = '';
    if (!p.bgUrl) return;
    const W = p.pg.width, H = p.pg.height;
    const strip = (y0, y1, top) => {
      const d = doc.createElement('div');
      d.className = 'esh-strip';
      // Half a pixel of overlap hides seams between strips at fractional zoom.
      d.style.cssText = `top:${r2(top)}px;width:${W}px;height:${r2(y1 - y0 + (bps.length ? 0.5 : 0))}px`;
      const img = doc.createElement('img');
      img.src = p.bgUrl;
      img.alt = '';
      img.draggable = false;
      img.style.cssText = `top:${r2(-y0)}px;width:${W}px;height:${H}px`;
      d.appendChild(img);
      p.bg.appendChild(d);
    };
    // Running offset rather than map(): a strip that starts exactly at a
    // breakpoint sits below that breakpoint's own growth.
    let y = 0, off = 0;
    for (const b of bps) {
      strip(y, b.at, y + off);
      const n = Math.ceil(b.grow / b.period);
      for (let k = 0; k < n; k++) {
        const h = Math.min(b.period, b.grow - k * b.period);
        strip(b.at - b.period, b.at - b.period + h, b.at + off + k * b.period);
      }
      off += b.grow;
      y = b.at;
    }
    strip(y, H, y + off);
  }

  // Each run onto its PDF baseline and width (see the header comment).
  function fitText(p) {
    for (const s of p.spans) {
      const { t, el, b } = s;
      el.style.transform = 'none';
      const base = b.offsetTop;
      el._dy = t.size - base; // baseline sits `size` below the box top in PDF space
      const w = el.offsetWidth;
      let k = w > 0 && t.w > 0 ? t.w / w : 1; // edited runs drop `w`: natural width
      if (k < 0.5 || k > 2) k = 1;
      el.style.transformOrigin = `0 ${base}px`;
      el.style.transform = (t.rot ? `rotate(${t.rot}deg) ` : '') + `scaleX(${k.toFixed(4)})`;
    }
  }

  let fixedScale = opts.scale || null;
  function fit(p, H) {
    const avail = Math.max(200, root.clientWidth || container.clientWidth || p.pg.width);
    const k = fixedScale || Math.min(maxScale, avail / p.pg.width);
    p.scale = k;
    p.pw.style.width = r2(p.pg.width * k) + 'px';
    p.pw.style.height = r2(H * k) + 'px';
    p.page.style.transform = `scale(${k})`;
  }

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; pages.forEach(layout); });
  }

  function relayoutAll() {
    pages.forEach(fitText);
    pages.forEach(layout);
  }
  relayoutAll();
  // Refit whenever a face finishes loading too: a face can land after
  // "ready" (another player on the page started it, or a fallback face
  // was swapped late), and a fit against the wrong face is visibly off.
  let refitRaf = 0;
  const refit = () => { cancelAnimationFrame(refitRaf); refitRaf = requestAnimationFrame(relayoutAll); };
  if (doc.fonts && doc.fonts.addEventListener) doc.fonts.addEventListener('loadingdone', refit);
  fontsReady.then(() => {
    relayoutAll();
    requestAnimationFrame(() => { relayoutAll(); root.dataset.ready = '1'; });
  });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  if (ro) ro.observe(container);

  const flags = new Map();
  return {
    root,
    pages: pages.map((p) => ({ id: p.pg.id, element: p.page, get scale() { return p.scale; } })),
    fields: fieldEls,
    setValue(id, v) {
      const el = fieldEls.get(id);
      if (!el || doc.activeElement === el) return;
      setElValue(el, v);
      schedule();
    },
    setValues(values) {
      for (const [id, v] of Object.entries(values || {})) {
        const el = fieldEls.get(id);
        if (el && doc.activeElement !== el) setElValue(el, v);
      }
      schedule();
    },
    values() {
      const out = {};
      for (const [id, el] of fieldEls) { const v = getElValue(el); if (v !== '') out[id] = v; }
      return out;
    },
    clear() { for (const el of fieldEls.values()) setElValue(el, ''); schedule(); },
    // Presence: outline the field a peer is typing in, with their name.
    setPeerFocus(peerId, fieldId, name, color) {
      const old = flags.get(peerId);
      if (old) { old.flag.remove(); if (old.el) { delete old.el.dataset.peer; old.el.style.removeProperty('--peer-color'); } flags.delete(peerId); }
      const el = fieldId && fieldEls.get(fieldId);
      if (!el) return;
      el.dataset.peer = peerId;
      el.style.setProperty('--peer-color', color);
      const flag = doc.createElement('span');
      flag.className = 'esh-peer-flag';
      flag.textContent = name;
      flag.style.setProperty('--peer-color', color);
      flag.style.left = el.style.left;
      flag.style.top = el.style.top;
      el.parentNode.appendChild(flag);
      flags.set(peerId, { flag, el });
    },
    relayout: relayoutAll,
    /** Fixed zoom (1 = 1pt per CSS px), or null to fit the container. */
    setScale(k) { fixedScale = k || null; pages.forEach(layout); },
    get scale() { return pages[0] ? pages[0].scale : 1; },
    destroy() {
      if (ro) ro.disconnect();
      if (doc.fonts && doc.fonts.removeEventListener) doc.fonts.removeEventListener('loadingdone', refit);
      cancelAnimationFrame(refitRaf);
      cancelAnimationFrame(raf);
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      container.textContent = '';
    },
  };
}
