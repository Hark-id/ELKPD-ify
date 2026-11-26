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
/* Answer styling is deliberately not blue: CONTRIBUTING forbids anything
   that reads as the OS focus/selection blue (tests/test-blue.mjs). Slate,
   like the hand-built worksheet's fields. */
.esh-sheet{--esh-accent:#334155;--esh-ink:#1e293b;--esh-tint:rgba(71,85,105,.07);--esh-page-gap:16px}
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
.esh-f:focus,.esh-f:focus-visible{box-shadow:0 0 0 1.5px var(--esh-accent),0 0 0 4px rgba(15,23,42,.07);background:rgba(255,255,255,.85)}
.esh-f::selection{background:rgba(30,41,59,.18)}
input.esh-f[type=checkbox]{padding:0;accent-color:var(--esh-accent);cursor:pointer;background:transparent}
.esh-f[data-peer]{box-shadow:0 0 0 2px var(--peer-color,#e8710a)}
.esh-peer-flag{position:absolute;transform:translateY(-100%);font:600 10px/1.4 'Arimo',Arial,sans-serif;color:#fff;
  background:var(--peer-color,#e8710a);padding:0 5px;border-radius:4px 4px 4px 0;white-space:nowrap;pointer-events:none;z-index:2}
.esh-sheet.esh-bare .esh-f{background:transparent}
/* Multiple choice: one ring per option letter, drawn over the printed
   letter (how a paper answer is marked). The group itself is invisible. */
.esh-f.esh-choice{background:transparent;padding:0;box-shadow:none}
.esh-opt{position:absolute;box-sizing:border-box;margin:0;padding:0;-webkit-appearance:none;appearance:none;border:0;border-radius:50%;
  background:var(--esh-tint);cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;transition:box-shadow .15s,background-color .15s}
.esh-opt:checked{background:transparent;box-shadow:inset 0 0 0 2px var(--esh-accent)}
.esh-opt:focus-visible{box-shadow:0 0 0 1.5px var(--esh-accent),0 0 0 4px rgba(15,23,42,.07)}
.esh-opt:checked:focus-visible{box-shadow:inset 0 0 0 2px var(--esh-accent),0 0 0 3px rgba(15,23,42,.12)}
.esh-sheet.esh-bare .esh-opt:not(:checked){background:transparent}
.esh-choice[data-peer]{box-shadow:0 0 0 2px var(--peer-color,#e8710a)}
.esh-sheet[data-readonly] .esh-f{pointer-events:none}
.esh-f.esh-editing{box-shadow:0 0 0 2px var(--esh-accent);background:rgba(71,85,105,.14)}
.esh-ed{position:fixed;left:0;right:0;bottom:0;z-index:60;background:#fff8f7;border-radius:20px 20px 0 0;box-shadow:0 -4px 16px rgba(0,0,0,.18);
  padding:12px 16px calc(12px + env(safe-area-inset-bottom));font-family:'Roboto Flex',Roboto,Arial,sans-serif;color:#231919;
  transform:translateY(110%);transition:transform .3s cubic-bezier(.2,0,0,1)}
.esh-ed.open{transform:none}
.esh-ed-head{display:flex;align-items:baseline;gap:8px;margin:0 2px 8px}
.esh-ed-label{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:18px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.esh-ed-pos{font-size:12px;color:#534342;white-space:nowrap}
.esh-ed-q{margin:-4px 2px 10px;font-size:13px;line-height:18px;color:#534342;max-height:54px;overflow:auto}
.esh-ed-input{display:block;width:100%;box-sizing:border-box;border:1px solid #857372;border-radius:8px;padding:10px 12px;font:16px/1.4 'Arimo',Arial,sans-serif;color:#0d2a57;background:#fff;resize:none}
textarea.esh-ed-input{min-height:96px;max-height:40vh}
.esh-ed-input:focus{outline:none;border-color:#a80029;box-shadow:inset 0 0 0 1px #a80029}
.esh-ed-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.esh-ed-row button{height:40px;border:0;border-radius:999px;font:500 14px/1 inherit;padding:0 16px;-webkit-tap-highlight-color:transparent;transition:border-radius .15s}
.esh-ed-row button:active{border-radius:8px}
.esh-ed-nav{background:#ffdad9;color:#2c1515;min-width:48px}
.esh-ed-nav:disabled{opacity:.38}
.esh-ed-done{margin-left:auto;background:#a80029;color:#fff}
/* Print at the paper's real size: geometry is in pt and 1pt = 96/72 CSS px.
   The zoom is a hair under 4/3 because PDF producers round page sizes up
   (Chrome's A4 is 842.25pt, the paper 841.89pt), and that sliver would push
   a blank sheet after every page. A page that grew past the paper
   continues on the next sheet. */
@page{margin:0}
@media print{
  .esh-sheet .esh-pw{margin:0;width:auto!important;height:auto!important;break-after:page;break-inside:auto}
  .esh-sheet .esh-pw:last-child{break-after:auto}
  .esh-sheet .esh-page{position:relative;transform:none!important;box-shadow:none;zoom:1.3313}
  .esh-ed{display:none}
  .esh-sheet .esh-f,.esh-sheet .esh-opt:not(:checked){background:transparent}
  .esh-sheet .esh-f:focus-visible{box-shadow:none}
  .esh-peer-flag{display:none}
}
`;

const r2 = (v) => Math.round(v * 100) / 100;
// Kinds answered in place on the page (a tick, a choice), never in the
// phone editor's text box.
const inPlace = (f) => f.kind === 'checkbox' || f.kind === 'choice';
let groupSeq = 0;

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

  const fieldEls = new Map(); // id -> element
  // phone answer editor state (see openEditor)
  const order = [];       // field defs in reading order
  const pageOf = new Map(); // field id -> page record
  const editor = { el: null, input: null, id: null };
  const pages = sheet.pages.map((pg) => buildPage(pg));
  for (const p of pages) for (const { f } of p.fields) { order.push(f); pageOf.set(f.id, p); }

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
      // A data: URL, not a blob: one. A sheet can come from someone else,
      // and a blob URL is same-origin: opened as a document (not as an
      // <img>) its SVG could run script with this page's cookies. A data:
      // document gets an opaque origin, and as an <img> neither runs script.
      bgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pg.background);
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
    } else if (f.kind === 'choice') {
      // One radio per option, placed on its letter; the value is the letter.
      // Clicking the chosen option again clears it (radios can't otherwise).
      el = doc.createElement('div');
      el.setAttribute('role', 'radiogroup');
      el.classList.add('esh-choice');
      const name = 'esh-c' + (++groupSeq) + '-' + f.id;
      for (const o of f.options || []) {
        const r = doc.createElement('input');
        r.type = 'radio';
        r.name = name;
        r.value = o.value;
        r.className = 'esh-opt';
        r.setAttribute('aria-label', o.value);
        r.style.cssText = `left:${r2(o.x - f.x)}px;top:${r2(o.y - f.y)}px;width:${o.w}px;height:${o.h}px`;
        if (opts.readOnly) r.disabled = true;
        let was = false;
        r.addEventListener('pointerdown', () => { was = r.checked; });
        r.addEventListener('click', () => {
          if (!was) return;
          was = false;
          r.checked = false;
          el.dispatchEvent(new Event('change'));
        });
        el.appendChild(r);
      }
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
    } else if (f.kind !== 'textarea' && !inPlace(f)) {
      st.fontSize = Math.max(8, Math.min(12, r2((f.size || f.h) * 0.72))) + 'px';
    }
    const v = opts.values && opts.values[f.id];
    if (v != null) setElValue(el, v);
    const fire = () => {
      if (opts.onInput) opts.onInput(f.id, getElValue(el));
      schedule();
    };
    el.addEventListener(inPlace(f) ? 'change' : 'input', fire);
    el.addEventListener(f.kind === 'choice' ? 'focusin' : 'focus', () => {
      if (useEditor(f)) { openEditor(f.id); return; }
      if (opts.onFocus) opts.onFocus(f.id);
    });
    el.addEventListener(f.kind === 'choice' ? 'focusout' : 'blur', () => { if (!editor.id && opts.onFocus) opts.onFocus(null); });
    return el;
  }

  // ------------------------------------------------- phone answer editor
  // On a phone an A4 page is shown at ~60%, so its fields are a few px
  // tall. Tapping one opens a bottom sheet with the question's label and a
  // full-size input (16px: no iOS zoom-on-focus) that writes through to the
  // field, with previous/next to walk the sheet in reading order.
  function useEditor(f) {
    if (opts.readOnly || opts.focusEditor === false || inPlace(f)) return false;
    const p = pageOf.get(f.id);
    return !!p && p.scale < 0.8;
  }
  function buildEditor() {
    if (editor.el) return;
    const ed = doc.createElement('div');
    ed.className = 'esh-ed';
    ed.setAttribute('role', 'dialog');
    ed.innerHTML = '<div class="esh-ed-head"><span class="esh-ed-label"></span><span class="esh-ed-pos"></span></div>' +
      '<p class="esh-ed-q"></p><div class="esh-ed-box"></div><div class="esh-ed-row"><button type="button" class="esh-ed-nav" data-d="-1" aria-label="Isian sebelumnya">&#8249;</button>' +
      '<button type="button" class="esh-ed-nav" data-d="1" aria-label="Isian berikutnya">&#8250;</button><button type="button" class="esh-ed-done">Selesai</button></div>';
    ed.querySelectorAll('.esh-ed-nav').forEach((b) => b.addEventListener('click', () => step(+b.dataset.d)));
    ed.querySelector('.esh-ed-done').addEventListener('click', closeEditor);
    doc.body.appendChild(ed);
    editor.el = ed;
    const vv = doc.defaultView.visualViewport;
    // Keep the sheet above the on-screen keyboard.
    if (vv) vv.addEventListener('resize', editor.onVV = () => {
      ed.style.bottom = Math.max(0, doc.defaultView.innerHeight - vv.height - vv.offsetTop) + 'px';
    });
  }
  function openEditor(id) {
    buildEditor();
    const f = order.find((q) => q.id === id);
    const el = fieldEls.get(id);
    if (!f || !el) return;
    if (editor.id && editor.id !== id) fieldEls.get(editor.id)?.classList.remove('esh-editing');
    editor.id = id;
    el.blur();
    el.classList.add('esh-editing');
    const box = editor.el.querySelector('.esh-ed-box');
    box.textContent = '';
    const input = doc.createElement(f.kind === 'textarea' ? 'textarea' : 'input');
    if (f.kind !== 'textarea') input.type = f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text';
    input.className = 'esh-ed-input';
    input.value = el.value;
    input.placeholder = f.placeholder || 'Tulis jawabanmu…';
    input.setAttribute('aria-label', f.label || 'Isian');
    input.addEventListener('input', () => {
      el.value = input.value;
      if (opts.onInput) opts.onInput(id, input.value);
      schedule();
    });
    if (f.kind !== 'textarea') input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); step(1); } });
    box.appendChild(input);
    editor.input = input;
    editor.el.querySelector('.esh-ed-label').textContent = f.label || 'Isian';
    const q = editor.el.querySelector('.esh-ed-q');
    q.textContent = f.prompt || '';
    q.hidden = !f.prompt;
    const i = order.indexOf(f);
    editor.el.querySelector('.esh-ed-pos').textContent = `${i + 1}/${order.length}`;
    const navs = editor.el.querySelectorAll('.esh-ed-nav');
    navs[0].disabled = !order.slice(0, i).some((q) => !inPlace(q));
    navs[1].disabled = !order.slice(i + 1).some((q) => !inPlace(q));
    editor.el.classList.add('open');
    input.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (opts.onFocus) opts.onFocus(id);
  }
  function step(d) {
    let i = order.findIndex((q) => q.id === editor.id);
    do i += d; while (order[i] && inPlace(order[i]));
    if (order[i]) openEditor(order[i].id);
  }
  function closeEditor() {
    if (!editor.id) return;
    fieldEls.get(editor.id)?.classList.remove('esh-editing');
    editor.id = null;
    editor.el.classList.remove('open');
    if (editor.input) editor.input.blur();
    if (opts.onFocus) opts.onFocus(null);
  }

  function getElValue(el) {
    if (el.dataset.kind === 'choice') { const c = el.querySelector('input:checked'); return c ? c.value : ''; }
    return el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
  }
  function setElValue(el, v) {
    if (el.dataset.kind === 'choice') { for (const r of el.querySelectorAll('input')) r.checked = v != null && r.value === String(v); }
    else if (el.type === 'checkbox') el.checked = v === '1' || v === true;
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
      if (!el || doc.activeElement === el || editor.id === id) return;
      setElValue(el, v);
      schedule();
    },
    setValues(values) {
      for (const [id, v] of Object.entries(values || {})) {
        const el = fieldEls.get(id);
        if (el && doc.activeElement !== el && editor.id !== id) setElValue(el, v);
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
      if (editor.el) { editor.el.remove(); const vv = doc.defaultView.visualViewport; if (vv && editor.onVV) vv.removeEventListener('resize', editor.onVV); }
      cancelAnimationFrame(refitRaf);
      cancelAnimationFrame(raf);
      container.textContent = '';
    },
  };
}
