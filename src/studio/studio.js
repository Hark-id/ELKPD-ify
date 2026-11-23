// ELKPD Studio: PDF -> reviewed, fillable sheet, entirely in the browser.
//
//   start  : drop a PDF (or a sheet.json, or the sample)
//   busy   : pdf.js + src/sheet/import.js, page by page
//   editor : design mode (move/resize/add/delete fields, fix text) and
//            preview mode (the real player, reflow and all)
//
// State is one sheet object; every edit goes through commit(), which keeps
// an undo stack and autosaves to IndexedDB.
import { importPdf } from '../sheet/import.js';
import { createPlayer } from '../sheet/player.js';
import { buildStandaloneHtml } from './export.js';
import { store } from './store.js';
import { cloud, refreshMe, authDialog, logout, projects } from './cloud.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38';
const $ = (id) => document.getElementById(id);
const r1 = (v) => Math.round(v * 10) / 10;
const KIND_LABEL = { text: 'Teks singkat', textarea: 'Teks panjang', checkbox: 'Kotak centang', date: 'Tanggal', number: 'Angka' };
const KIND_ICON = {
  text: '<svg viewBox="0 0 24 24"><path d="M4 16h16"/><path d="M7 12V8m0 0h4"/></svg>',
  textarea: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  checkbox: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  date: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 10h16M9 4v4M15 4v4"/></svg>',
  number: '<svg viewBox="0 0 24 24"><path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>',
};
const KIND_LETTER = { text: 'T', textarea: '¶', checkbox: '✓', date: 'D', number: '#' };

let sheet = null;     // the document being edited
let docKey = null;    // IndexedDB key
let mode = 'design';
let selected = null;  // field id
let drawing = false;
let zoom = null;      // null = fit width
let player = null;
let previewValues = {};
let project = null;   // { id, role } when this sheet is published to an account
let classData = null; // { rooms: [...] } from /answers, refreshed while in the Kelas tab
let classRoom = null; // selected room id in the Kelas tab
let classTimer = 0;
const undo = [], redo = [];

// ------------------------------------------------------------ helpers
function show(view) {
  for (const v of ['start', 'busy', 'editor']) $(v).hidden = v !== view;
  const inEditor = view === 'editor';
  $('title').hidden = $('modeSeg').hidden = $('exportBtn').hidden = $('undoBtn').hidden = !inEditor;
  $('classTab').hidden = !inEditor || !project;
  $('publishItem').hidden = !cloud.available;
  if (!inEditor) stopClassPolling();
}

let snackTimer = 0;
function snack(msg, action) {
  const el = $('snack');
  el.textContent = '';
  el.append(msg);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.run(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.hidden = true; }, action ? 8000 : 4000);
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = (s) => (s || 'lembar').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60) || 'lembar';

function allFields() {
  const out = [];
  sheet.pages.forEach((pg, pi) => pg.fields.forEach((f) => out.push({ f, pg, pi })));
  return out;
}
function findField(id) { return allFields().find((x) => x.f.id === id) || null; }
function nextFieldId(pg) {
  const used = new Set(allFields().map((x) => x.f.id));
  let n = pg.fields.length + 1;
  while (used.has(`${pg.id}-f${n}`)) n++;
  return `${pg.id}-f${n}`;
}

// --------------------------------------------------------- history
let saveTimer = 0;
// Snapshots hold what edits change (title, page order, fields, text), not
// backgrounds: pages are restored from pagePool by id, so undoing a page
// deletion brings the page back without copying its SVG into every entry.
const pagePool = new Map();
function snapshot() {
  const snap = JSON.stringify({ title: sheet.title, pages: sheet.pages.map((p) => ({ id: p.id, fields: p.fields, text: p.text })) });
  return snap.length < 4e6 ? snap : null;
}
function restore(snap) {
  const s = JSON.parse(snap);
  sheet.title = s.title;
  sheet.pages = s.pages.map((p) => Object.assign(pagePool.get(p.id), { fields: p.fields, text: p.text }));
}
/** Apply an edit. `rerender`: the player must be rebuilt (text changed). */
function commit(fn, { rerender = false } = {}) {
  const before = snapshot();
  fn();
  if (before) { undo.push(before); if (undo.length > 80) undo.shift(); }
  redo.length = 0;
  $('undoBtn').disabled = !undo.length;
  if (rerender) renderSheet(); else refreshOverlay();
  renderInspector();
  scheduleSave();
}
function doUndo() {
  if (!undo.length) return;
  redo.push(snapshot());
  restore(undo.pop());
  afterHistory();
}
function doRedo() {
  if (!redo.length) return;
  undo.push(snapshot());
  restore(redo.pop());
  afterHistory();
}
function afterHistory() {
  $('undoBtn').disabled = !undo.length;
  $('title').value = sheet.title;
  if (selected && !findField(selected)) selected = null;
  renderSheet();
  renderInspector();
  scheduleSave();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.put(docKey, sheet, project ? { projectId: project.id } : {}), 400);
}

// ----------------------------------------------------------- import
let pdfjsLib = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(`${PDFJS}/build/pdf.min.mjs`);
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
  return pdfjsLib;
}

async function openFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    try { openSheet(JSON.parse(await file.text()), null); }
    catch { snack('Berkas ini bukan berkas lembar yang valid.'); }
    return;
  }
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { snack('Pilih berkas PDF.'); return; }
  await importBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function importBytes(bytes, name) {
  show('busy');
  $('busyTitle').textContent = 'Membaca ' + name;
  $('busyNote').textContent = 'Memuat pembaca PDF…';
  $('busyBar').style.width = '4%';
  try {
    const lib = await loadPdfjs();
    $('busyNote').textContent = 'Mengenali teks, gambar, dan tempat jawaban…';
    const s = await importPdf(lib, bytes, {
      name,
      docOptions: { standardFontDataUrl: `${PDFJS}/standard_fonts/`, cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true },
      onProgress(done, total) {
        $('busyBar').style.width = Math.round(4 + (96 * done) / total) + '%';
        $('busyNote').textContent = `Halaman ${done} dari ${total}`;
      },
    });
    const n = s.pages.reduce((k, p) => k + p.fields.length, 0);
    const textless = s.pages.every((p) => !p.text.length);
    openSheet(s, null);
    if (textless) snack('PDF ini tidak memiliki teks (hasil pindai?). Isian bisa ditambahkan manual.');
    else snack(`${s.pages.length} halaman, ${n} tempat jawaban ditemukan. Periksa dan rapikan sebelum dibagikan.`);
  } catch (e) {
    console.error(e);
    show('start');
    snack(/password/i.test(String(e && e.name) + e) ? 'PDF ini dikunci kata sandi.' : 'PDF tidak bisa dibaca: ' + (e && e.message || e));
  }
}

function openSheet(s, key, proj = null) {
  if (!s || s.format !== 'elkpd-sheet' || !Array.isArray(s.pages)) { snack('Berkas ini bukan berkas lembar yang valid.'); return; }
  sheet = s;
  pagePool.clear();
  for (const p of s.pages) pagePool.set(p.id, p);
  project = proj;
  classData = null;
  classRoom = null;
  docKey = key || ((s.source && s.source.sha256) ? 'sha-' + s.source.sha256.slice(0, 16) : 'doc-' + Date.now());
  undo.length = redo.length = 0;
  selected = null;
  previewValues = {};
  $('title').value = sheet.title || '';
  $('undoBtn').disabled = true;
  show('editor'); // before rendering: the player measures text, which needs layout
  setMode('design');
  store.put(docKey, sheet, project ? { projectId: project.id } : {});
  history.replaceState(null, '', '#' + encodeURIComponent(docKey));
  updatePublishItem();
  // The saved record only remembers the project; ask the server for our role.
  if (project && cloud.available) projects.info(project.id).then((r) => { project.role = r.role; }, () => {});
}

// ----------------------------------------------------------- render
function renderSheet() {
  const canvas = $('canvas');
  const top = canvas.scrollTop;
  if (player) player.destroy();
  player = null;
  canvas.classList.toggle('design', mode === 'design');
  canvas.classList.toggle('preview', mode === 'preview');
  if (mode === 'class') {
    const room = classData && classData.rooms.find((r) => r.id === classRoom);
    if (!room) {
      canvas.textContent = '';
      canvas.append(h('p', { class: 'empty-canvas' }, classData && classData.rooms.length ? 'Pilih ruang di kanan untuk melihat jawaban kelompok itu secara langsung.'
        : 'Buat ruang untuk tiap kelompok di panel kanan. Siswa bergabung dengan kodenya, tanpa akun.'));
      updateZoomLabel();
      return;
    }
  }
  const classValues = mode === 'class' ? (classData.rooms.find((r) => r.id === classRoom) || {}).answers : null;
  player = createPlayer(canvas, sheet, {
    readOnly: mode === 'design' || mode === 'class',
    bare: mode === 'design',
    scale: zoom,
    values: mode === 'preview' ? previewValues : classValues,
    onInput: (id, v) => {
      previewValues[id] = v;
      const b = $('inspector').querySelector('.stat b');
      if (b && mode === 'preview') b.textContent = String(Object.values(previewValues).filter((x) => x !== '' && x != null).length);
    },
  });
  canvas.scrollTop = top;
  window.studio = { player, sheet }; // for the CDP suite and the console
  if (mode === 'design') { buildOverlay(); wireText(); }
  updateZoomLabel();
}

function updateZoomLabel() {
  $('zoomLabel').textContent = player ? Math.round(player.scale * 100) + '%' : '';
}

// One overlay per page, inside the scaled page element, so overlay
// coordinates are PDF points like the sheet.
function buildOverlay() {
  player.pages.forEach((pp, pi) => {
    const ov = document.createElement('div');
    ov.className = 'st-ov';
    ov.dataset.page = pi;
    pp.element.appendChild(ov);
    ov.addEventListener('pointerdown', (e) => onOverlayDown(e, pi, ov));
  });
  refreshOverlay();
}

function refreshOverlay() {
  if (!player || mode !== 'design') return;
  player.pages.forEach((pp, pi) => {
    const ov = pp.element.querySelector('.st-ov');
    if (!ov) return;
    const pg = sheet.pages[pi];
    const keep = new Set(pg.fields.map((f) => f.id));
    for (const el of [...ov.querySelectorAll('.st-fb')]) if (!keep.has(el.dataset.id)) el.remove();
    for (const f of pg.fields) {
      let el = ov.querySelector(`.st-fb[data-id="${CSS.escape(f.id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'st-fb';
        el.dataset.id = f.id;
        el.innerHTML = '<span class="st-chip"></span>';
        ov.appendChild(el);
      }
      placeBox(el, f);
    }
  });
}

function placeBox(el, f) {
  el.style.left = f.x + 'px';
  el.style.top = f.y + 'px';
  el.style.width = f.w + 'px';
  el.style.height = f.h + 'px';
  el.className = 'st-fb kind-' + f.kind + (f.lineGap ? ' lined' : '') + (f.id === selected ? ' sel' : '');
  if (f.lineGap) el.style.setProperty('--gap', f.lineGap + 'px'); else el.style.removeProperty('--gap');
  el.querySelector('.st-chip').textContent = f.label || KIND_LABEL[f.kind];
  el.querySelectorAll('.st-h').forEach((h) => h.remove());
  if (f.id === selected) {
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const d = document.createElement('span');
      d.className = 'st-h';
      d.dataset.h = h;
      el.appendChild(d);
    }
  }
}

function select(id, { scroll = false } = {}) {
  selected = id;
  refreshOverlay();
  renderInspector();
  if (scroll && id) {
    const el = $('canvas').querySelector(`.st-fb[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ------------------------------------------------- pointer: move/resize/draw
function onOverlayDown(e, pi, ov) {
  if (e.button !== 0) return;
  const scale = player.pages[pi].scale;
  const rect = ov.getBoundingClientRect();
  const pt = (ev) => [(ev.clientX - rect.left) / scale, (ev.clientY - rect.top) / scale];
  const box = e.target.closest('.st-fb');
  const handle = e.target.closest('.st-h');
  const pg = sheet.pages[pi];
  const [x0, y0] = pt(e);

  if (drawing || (!box && e.altKey)) {
    e.preventDefault();
    const band = document.createElement('div');
    band.className = 'st-band';
    ov.appendChild(band);
    let cur = [x0, y0];
    const draw = () => {
      const [x, y] = cur;
      Object.assign(band.style, { left: Math.min(x, x0) + 'px', top: Math.min(y, y0) + 'px', width: Math.abs(x - x0) + 'px', height: Math.abs(y - y0) + 'px' });
    };
    const move = (ev) => { cur = pt(ev); draw(); };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      band.remove();
      let [x, y] = cur;
      let w = Math.abs(x - x0), h = Math.abs(y - y0);
      if (w < 6 && h < 6) { w = 160; h = 18; x = x0 + w; y = y0 + h; } // a click drops a default field
      const f = { id: nextFieldId(pg), kind: h >= 26 ? 'textarea' : (Math.abs(w - h) < 3 && w <= 18 ? 'checkbox' : 'text'),
        x: r1(Math.min(x, x0)), y: r1(Math.min(y, y0)), w: r1(Math.max(8, w)), h: r1(Math.max(8, h)), label: '', source: 'manual' };
      commit(() => { pg.fields.push(f); selected = f.id; });
      setDrawing(false);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    return;
  }

  if (!box) { if (selected) select(null); return; }
  e.preventDefault();
  const id = box.dataset.id;
  if (id !== selected) select(id);
  const f = pg.fields.find((q) => q.id === id);
  const start = { x: f.x, y: f.y, w: f.w, h: f.h };
  const h = handle && handle.dataset.h;
  let moved = false;
  const el = () => ov.querySelector(`.st-fb[data-id="${CSS.escape(id)}"]`);
  const move = (ev) => {
    const [x, y] = pt(ev);
    const dx = x - x0, dy = y - y0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 1.5) return;
    if (!moved) { moved = true; undo.push(snapshot()); redo.length = 0; $('undoBtn').disabled = false; }
    const n = { ...start };
    if (!h) { n.x = start.x + dx; n.y = start.y + dy; }
    else {
      if (h.includes('w')) { n.x = Math.min(start.x + dx, start.x + start.w - 6); n.w = start.w - (n.x - start.x); }
      if (h.includes('e')) n.w = Math.max(6, start.w + dx);
      if (h.includes('n')) { n.y = Math.min(start.y + dy, start.y + start.h - 6); n.h = start.h - (n.y - start.y); }
      if (h.includes('s')) n.h = Math.max(6, start.h + dy);
    }
    n.x = Math.max(0, Math.min(pg.width - n.w, n.x));
    n.y = Math.max(0, Math.min(pg.height - n.h, n.y));
    Object.assign(f, { x: r1(n.x), y: r1(n.y), w: r1(n.w), h: r1(n.h) });
    placeBox(el(), f);
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    if (moved) { renderInspector(); scheduleSave(); }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function setDrawing(on) {
  drawing = on;
  $('addTool').setAttribute('aria-pressed', String(on));
  $('canvas').classList.toggle('drawing', on);
  $('tbNote').textContent = on ? 'Seret di halaman untuk menggambar kotak isian. Esc untuk batal.' :
    'Klik kotak isian untuk menyuntingnya. Klik dua kali teks untuk memperbaiki.';
}

// Double-click a text run to fix a typo or reword it.
function wireText() {
  $('canvas').querySelectorAll('.esh-t').forEach((el) => {
    el.addEventListener('dblclick', () => {
      if (el.isContentEditable) return;
      const id = el.dataset.id;
      el.contentEditable = 'true';
      el.style.transform = 'none';
      el.focus();
      const sel = getSelection();
      sel.selectAllChildren(el);
      const done = (save) => {
        el.removeEventListener('blur', onBlur);
        el.removeEventListener('keydown', onKey);
        el.contentEditable = 'false';
        const str = el.textContent.replace(/\s+/g, ' ').trim();
        const t = sheet.pages.flatMap((p) => p.text).find((q) => q.id === id);
        if (save && t && str !== t.str) {
          commit(() => {
            if (str) { t.str = str; delete t.w; } // natural width: the old PDF width no longer applies
            else sheet.pages.forEach((p) => { p.text = p.text.filter((q) => q.id !== id); });
          }, { rerender: true });
        } else renderSheet();
      };
      const onBlur = () => done(true);
      const onKey = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      };
      el.addEventListener('blur', onBlur);
      el.addEventListener('keydown', onKey);
    });
  });
}

// ---------------------------------------------------------- inspector
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : String(k));
  return el;
}

function renderInspector() {
  const box = $('inspector');
  box.textContent = '';
  if (mode === 'preview') { box.append(previewPanel()); return; }
  if (mode === 'class') { box.append(classPanel()); return; }
  const hit = selected && findField(selected);
  box.append(hit ? fieldPanel(hit.f, hit.pg, hit.pi) : overviewPanel());
}

function overviewPanel() {
  const fields = allFields();
  const unnamed = fields.filter((x) => !x.f.label).length;
  const wrap = h('div', { class: 'insp' },
    h('h2', {}, 'Tempat jawaban'),
    h('p', { class: 'sub' }, 'Ini yang ditemukan otomatis dari PDF. Klik untuk menyunting, atau gambar kotak baru dengan ', h('b', {}, 'Tambah isian'), '.'),
    h('div', { class: 'stat' },
      h('div', {}, h('b', {}, String(sheet.pages.length)), h('span', {}, 'halaman')),
      h('div', {}, h('b', {}, String(fields.length)), h('span', {}, 'isian')),
      h('div', {}, h('b', {}, String(unnamed)), h('span', {}, 'tanpa nama'))),
  );
  if (unnamed) wrap.append(h('p', { class: 'tip' }, 'Beri nama setiap isian (mis. "Nama", "Jawaban no. 2"). Nama dipakai pembaca layar dan saat guru melihat jawaban.'));
  const n = sheet.pages.length;
  sheet.pages.forEach((pg, pi) => {
    const blank = !pg.fields.length && !pg.text.length;
    wrap.append(h('div', { class: 'pagehead row-between' }, h('span', {}, `Halaman ${pi + 1}` + (blank ? ' (kosong)' : '')),
      h('span', { class: 'page-acts' },
        h('button', { type: 'button', title: 'Naikkan halaman', 'aria-label': `Naikkan halaman ${pi + 1}`, disabled: pi === 0, onclick: () => movePage(pi, -1) }, '↑'),
        h('button', { type: 'button', title: 'Turunkan halaman', 'aria-label': `Turunkan halaman ${pi + 1}`, disabled: pi === n - 1, onclick: () => movePage(pi, 1) }, '↓'),
        h('button', { type: 'button', title: 'Hapus halaman', 'aria-label': `Hapus halaman ${pi + 1}`, disabled: n === 1, onclick: () => deletePage(pi) }, '✕'))));
    if (!pg.fields.length) return;
    wrap.append(h('ul', { class: 'flist' }, pg.fields.map((f) => h('li', {}, h('button', { type: 'button', onclick: () => select(f.id, { scroll: true }) },
      h('span', { class: 'fl-k', 'aria-hidden': 'true' }, KIND_LETTER[f.kind] || '?'),
      h('span', { class: 'fl-l' + (f.label ? '' : ' fl-empty') }, f.label || 'Belum diberi nama'),
      h('span', { class: 'fl-p' }, KIND_LABEL[f.kind]))))));
  });
  if (!fields.length) wrap.append(h('p', { class: 'tip' }, 'Belum ada isian. Pilih Tambah isian lalu seret di halaman.'));
  return wrap;
}

function fieldPanel(f, pg, pi) {
  const edit = (fn, opts) => commit(fn, opts);
  const num = (label, key) => h('label', { class: 'fld' }, h('span', {}, label),
    h('input', { type: 'number', step: '0.5', value: f[key], onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit(() => { f[key] = v; }); } }));
  const idErr = h('small', {}, 'Kunci penyimpanan jawaban. Biarkan kecuali Anda tahu alasannya.');
  const idFld = h('label', { class: 'fld' }, h('span', {}, 'Kunci'),
    h('input', { type: 'text', value: f.id, spellcheck: 'false', onchange: (e) => {
      const v = e.target.value.trim();
      const ok = /^[A-Za-z0-9_-]{1,60}$/.test(v) && !allFields().some((x) => x.f.id === v && x.f !== f);
      idFld.classList.toggle('err', !ok);
      idErr.textContent = ok ? 'Kunci penyimpanan jawaban.' : 'Huruf, angka, - dan _ saja, dan harus unik.';
      if (ok && v !== f.id) edit(() => { f.id = v; selected = v; });
    } }), idErr);

  const kinds = h('div', { class: 'kinds', role: 'group', 'aria-label': 'Jenis isian' }, Object.keys(KIND_LABEL).map((k) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(f.kind === k), onclick: () => edit(() => {
      f.kind = k;
      if (k !== 'textarea') { delete f.lineGap; delete f.lines; }
      if (k === 'checkbox') { const s = Math.min(f.w, f.h, 14); f.w = f.h = s; }
    }) });
    b.innerHTML = KIND_ICON[k];
    b.append(KIND_LABEL[k]);
    return b;
  }));

  const wrap = h('div', { class: 'insp' },
    h('h2', {}, f.label || 'Isian tanpa nama'),
    h('p', { class: 'sub' }, `Halaman ${pi + 1} · ${f.source === 'manual' ? 'ditambahkan manual' : 'ditemukan otomatis (' + ({ leader: 'titik-titik', line: 'garis', lines: 'garis tulis', table: 'tabel', box: 'kotak', checkbox: 'kotak centang', acroform: 'formulir PDF', space: 'ruang kosong di bawah soal' }[f.source] || f.source) + ')'}`),
    h('label', { class: 'fld' }, h('span', {}, 'Nama isian'),
      h('input', { type: 'text', value: f.label || '', placeholder: 'mis. Jawaban no. 1', onchange: (e) => edit(() => { f.label = e.target.value.trim(); }) })),
    kinds,
    h('label', { class: 'fld' }, h('span', {}, 'Pertanyaan'),
      h('textarea', { rows: '2', placeholder: 'Pertanyaan yang dijawab di isian ini', onchange: (e) => edit(() => { const v = e.target.value.replace(/\s+/g, ' ').trim().slice(0, 600); if (v) f.prompt = v; else delete f.prompt; }) }, f.prompt || ''),
      h('small', {}, 'Ditampilkan bersama isian saat siswa menjawab di HP.')),
  );
  if (f.kind !== 'checkbox') {
    wrap.append(h('label', { class: 'fld' }, h('span', {}, 'Teks bantuan (placeholder)'),
      h('input', { type: 'text', value: f.placeholder || '', placeholder: 'mis. Tulis jawabanmu…', onchange: (e) => edit(() => { const v = e.target.value.trim(); if (v) f.placeholder = v; else delete f.placeholder; }) })));
  }
  if (f.kind === 'textarea') {
    wrap.append(
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.grow !== false, onchange: (e) => edit(() => { if (e.target.checked) delete f.grow; else f.grow = false; }) }),
        h('span', {}, 'Memanjang mengikuti jawaban', h('small', {}, 'Halaman ikut memanjang dan isi di bawahnya bergeser, jadi jawaban panjang tidak terpotong.'))),
      h('label', { class: 'fld' }, h('span', {}, 'Jarak garis tulis (pt)'),
        h('input', { type: 'number', min: '0', step: '0.5', value: f.lineGap || 0, onchange: (e) => edit(() => { const v = parseFloat(e.target.value); if (v > 4) f.lineGap = v; else { delete f.lineGap; delete f.lines; } }) }),
        h('small', {}, '0 = kotak biasa. Isi dengan jarak antargaris kalau jawaban ditulis di atas garis.')));
  }
  wrap.append(
    h('span', { class: 'pagehead', style: 'margin-left:2px' }, 'Posisi & ukuran (pt)'),
    h('div', { class: 'grid4' }, num('X', 'x'), num('Y', 'y'), num('Lebar', 'w'), num('Tinggi', 'h')),
    idFld,
    h('div', { class: 'row' },
      h('button', { class: 'btn tonal', type: 'button', onclick: () => duplicate(f, pg) }, 'Duplikat'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => remove(f.id) }, 'Hapus isian')),
  );
  return wrap;
}

function previewPanel() {
  const filled = Object.values(previewValues).filter((v) => v !== '' && v != null).length;
  return h('div', { class: 'insp' },
    h('h2', {}, 'Coba isi'),
    h('p', { class: 'sub' }, 'Begini tampilan lembar untuk siswa. Ketik jawaban panjang untuk melihat kotak memanjang dan isi halaman bergeser.'),
    h('div', { class: 'stat' }, h('div', {}, h('b', {}, String(filled)), h('span', {}, 'isian terisi'))),
    h('div', { class: 'row' },
      h('button', { class: 'btn tonal', type: 'button', onclick: () => { previewValues = {}; player.clear(); renderInspector(); } }, 'Kosongkan'),
      h('button', { class: 'btn text', type: 'button', onclick: () => window.print() }, 'Cetak')),
  );
}

function movePage(i, d) {
  commit(() => { const [p] = sheet.pages.splice(i, 1); sheet.pages.splice(i + d, 0, p); }, { rerender: true });
}
function deletePage(i) {
  const pg = sheet.pages[i];
  commit(() => { sheet.pages.splice(i, 1); if (selected && pg.fields.some((f) => f.id === selected)) selected = null; }, { rerender: true });
  snack(`Halaman ${i + 1} dihapus.`, { label: 'Urungkan', run: doUndo });
}

function duplicate(f, pg) {
  const c = { ...f, id: nextFieldId(pg), y: r1(Math.min(pg.height - f.h, f.y + f.h + 6)), source: 'manual' };
  commit(() => { pg.fields.push(c); selected = c.id; });
}
function remove(id) {
  commit(() => { sheet.pages.forEach((p) => { p.fields = p.fields.filter((q) => q.id !== id); }); selected = null; });
  snack('Isian dihapus.', { label: 'Urungkan', run: doUndo });
}

// ------------------------------------------------------- publish + class
function updatePublishItem() {
  $('publishItem').hidden = !cloud.available;
  $('publishLabel').textContent = project ? 'Terbitkan perubahan' : 'Terbitkan untuk kelas';
  $('publishNote').textContent = project
    ? 'Semua ruang kelompok langsung memakai versi baru. Jawaban tetap tersimpan.'
    : 'Simpan ke akun Anda, lalu buat ruang untuk tiap kelompok.';
  $('classTab').hidden = $('editor').hidden || !project;
}

async function publish() {
  if (!cloud.user && !(await authDialog('login'))) return;
  try {
    if (project) {
      const r = await projects.publish(project.id, sheet);
      snack(`Versi ${r.version} diterbitkan. Ruang kelompok memakai versi ini saat dibuka ulang.`);
    } else {
      const r = await projects.create(sheet);
      project = { id: r.id, role: 'owner' };
      scheduleSave();
      updatePublishItem();
      refreshMe();
      snack('Lembar diterbitkan ke akun Anda.', { label: 'Buat ruang', run: () => setMode('class') });
    }
  } catch (e) {
    snack('Gagal menerbitkan: ' + e.message);
  }
}

async function openProject(id, role) {
  show('busy');
  $('busyTitle').textContent = 'Membuka proyek…';
  $('busyNote').textContent = '';
  $('busyBar').style.width = '60%';
  try {
    const { sheet: s } = await projects.sheet(id);
    openSheet(s, 'prj-' + id, { id, role });
  } catch (e) {
    show('start');
    snack(e.message);
  }
}

async function loadClass() {
  if (!project) return;
  try {
    classData = await projects.answers(project.id);
    if (classRoom && !classData.rooms.some((r) => r.id === classRoom)) classRoom = null;
    if (!classRoom && classData.rooms.length) classRoom = classData.rooms[0].id;
  } catch (e) {
    classData = classData || { rooms: [] };
    snack('Gagal memuat ruang: ' + e.message);
  }
}

// Live view: poll the answers while the Kelas tab is open. Values update in
// place (no re-render) so scrolling and zoom stay put.
async function classTick() {
  if (mode !== 'class') return;
  const before = classRoom;
  await loadClass();
  if (mode !== 'class') return;
  const room = classData.rooms.find((r) => r.id === classRoom);
  if (player && room && before === classRoom) player.setValues({ ...emptyValues(), ...room.answers });
  else renderSheet();
  renderInspector();
}
const emptyValues = () => Object.fromEntries(allFields().map((x) => [x.f.id, '']));
function startClassPolling() {
  stopClassPolling();
  classTick();
  classTimer = setInterval(classTick, 4000);
}
function stopClassPolling() { clearInterval(classTimer); classTimer = 0; }

function classPanel() {
  const total = allFields().length;
  const rooms = (classData && classData.rooms) || [];
  const canEdit = project && project.role !== 'viewer';
  const wrap = h('div', { class: 'insp' },
    h('h2', {}, 'Ruang kelompok'),
    h('p', { class: 'sub' }, 'Satu ruang untuk tiap kelompok. Bagikan kode atau tautannya; anggota kelompok mengisi lembar yang sama secara langsung, tanpa akun.'));
  if (!classData) { wrap.append(h('p', { class: 'sub' }, 'Memuat…')); return wrap; }
  if (canEdit) {
    const input = h('input', { type: 'text', placeholder: `Kelompok ${rooms.length + 1}`, maxlength: '60' });
    wrap.append(h('form', { class: 'row', style: 'margin:0 0 16px', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await projects.addRoom(project.id, input.value.trim() || `Kelompok ${rooms.length + 1}`);
        classRoom = r.room.id;
        await classTick();
        snack(`Ruang dibuat. Kode: ${r.room.code}`);
      } catch (err) { snack(err.message); }
    } }, h('label', { class: 'fld', style: 'flex:1;margin:0' }, input), h('button', { class: 'btn filled', type: 'submit' }, 'Buat ruang')));
  }
  for (const r of rooms) {
    const filled = Object.values(r.answers || {}).filter((v) => v !== '' && v != null).length;
    const pct = total ? Math.round((100 * filled) / total) : 0;
    const link = `${location.origin}/j/${r.code}`;
    wrap.append(h('div', { class: 'room-card' + (r.id === classRoom ? ' sel' : ''), onclick: (e) => { if (e.target.closest('button')) return; classRoom = r.id; renderSheet(); renderInspector(); } },
      h('div', { class: 'rc-top' }, h('span', { class: 'rc-label' }, r.label), h('code', {}, r.code)),
      h('div', { class: 'rc-meta' },
        h('span', { class: 'live' + (r.peers.length ? '' : ' off') }, r.peers.length ? `${r.peers.length} online: ${r.peers.map((p) => p.name).join(', ')}` : 'tidak ada yang online'),
        h('span', {}, `${filled}/${total} isian`)),
      h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })),
      r.id === classRoom ? h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn tonal', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); snack('Tautan disalin: ' + link); } catch { snack(link); } } }, 'Salin tautan'),
        canEdit ? h('button', { class: 'btn text', type: 'button', onclick: async () => { if (!confirm(`Kosongkan semua jawaban ${r.label}?`)) return; await projects.resetRoom(project.id, r.id); classTick(); } }, 'Kosongkan') : null,
        canEdit ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (!confirm(`Hapus ${r.label}? Kode ${r.code} tidak bisa dipakai lagi dan jawabannya hilang.`)) return; await projects.removeRoom(project.id, r.id); classRoom = null; classTick(); } }, 'Hapus') : null) : null));
  }
  if (rooms.length) {
    wrap.append(h('div', { class: 'row', style: 'margin:8px 0 20px' },
      h('button', { class: 'btn text', type: 'button', onclick: () => exportCsv(rooms) }, 'Unduh semua jawaban (.csv)')));
  }
  if (project.role === 'owner') wrap.append(sharePanel());
  return wrap;
}

function exportCsv(rooms) {
  const fields = allFields().map((x) => x.f);
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['Ruang', 'Kode', ...fields.map((f) => f.label || f.id)].map(q).join(',')];
  for (const r of rooms) rows.push([r.label, r.code, ...fields.map((f) => (f.kind === 'checkbox' ? (r.answers[f.id] ? 'ya' : '') : r.answers[f.id]))].map(q).join(','));
  // BOM so Excel opens UTF-8 (Indonesian text) correctly
  download(slug(sheet.title) + '-jawaban.csv', '\ufeff' + rows.join('\r\n'), 'text/csv;charset=utf-8');
}

function sharePanel() {
  const box = h('div', {}, h('span', { class: 'pagehead', style: 'margin-left:2px' }, 'Akses guru lain'));
  const list = h('div', {});
  box.append(list);
  const fill = async () => {
    list.textContent = '';
    const { project: info } = await projects.info(project.id);
    for (const m of info.members) {
      if (m.role === 'owner') { list.append(h('div', { class: 'member' }, h('b', {}, '@' + m.username), h('span', { class: 'r-role' }, 'pemilik'))); continue; }
      const sel = h('select', { 'aria-label': 'Peran ' + m.username, onchange: async (e) => { try { await projects.share(project.id, m.username, e.target.value || null); fill(); } catch (err) { snack(err.message); } } },
        h('option', { value: 'editor', selected: m.role === 'editor' }, 'Penyunting'), h('option', { value: 'viewer', selected: m.role === 'viewer' }, 'Pemeriksa'), h('option', { value: '' }, 'Hapus akses'));
      list.append(h('div', { class: 'member' }, h('b', {}, '@' + m.username), sel));
    }
  };
  fill().catch(() => {});
  const user = h('input', { type: 'text', placeholder: 'nama pengguna', spellcheck: 'false', autocapitalize: 'none' });
  const role = h('select', {}, h('option', { value: 'editor' }, 'Penyunting'), h('option', { value: 'viewer' }, 'Pemeriksa'));
  box.append(h('form', { class: 'row', style: 'margin-top:8px', onsubmit: async (e) => {
    e.preventDefault();
    try { await projects.share(project.id, user.value.trim(), role.value); user.value = ''; fill(); snack('Akses diberikan.'); } catch (err) { snack(err.message); }
  } }, h('label', { class: 'fld', style: 'flex:1;margin:0' }, user), h('label', { class: 'fld', style: 'margin:0' }, role), h('button', { class: 'btn tonal', type: 'submit' }, 'Bagikan')));
  box.append(h('p', { class: 'sub', style: 'margin-top:8px' }, 'Penyunting bisa mengubah lembar dan membuat ruang. Pemeriksa hanya melihat jawaban.'));
  return box;
}

async function renderCloudStart() {
  const box = $('cloudBox');
  box.hidden = !cloud.available;
  if (!cloud.available) return;
  const list = $('projectList');
  list.textContent = '';
  $('loginBtn').hidden = !!cloud.user;
  if (!cloud.user) { $('cloudNote').textContent = 'Masuk untuk menerbitkan lembar ke kelas: siswa bergabung dengan kode dan mengisi bersama.'; return; }
  $('cloudNote').textContent = cloud.projects.length ? '' : 'Belum ada proyek. Impor PDF, lalu pilih Simpan & bagikan → Terbitkan untuk kelas.';
  const ROLE = { owner: 'pemilik', editor: 'penyunting', viewer: 'pemeriksa' };
  for (const p of cloud.projects) {
    list.append(h('li', {}, h('button', { type: 'button', onclick: () => openProject(p.id, p.role) },
      h('span', { class: 'r-title' }, p.title || 'Tanpa judul'),
      h('span', { class: 'r-role' }, ROLE[p.role] || p.role),
      h('span', { class: 'r-meta' }, new Date(p.updated).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })))));
  }
}

// --------------------------------------------------------------- mode
function setMode(m) {
  mode = m;
  if (m === 'class') startClassPolling(); else stopClassPolling();
  for (const b of $('modeSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
  $('toolbar').querySelector('#addTool').hidden = m !== 'design';
  $('tbNote').hidden = m === 'class';
  setDrawing(false);
  if (sheet) { renderSheet(); renderInspector(); }
}

// --------------------------------------------------------------- wire up
async function showRecent() {
  const list = await store.list();
  $('recent').hidden = !list.length;
  $('recentList').textContent = '';
  for (const r of list.slice(0, 8)) {
    $('recentList').append(h('li', {}, h('button', { type: 'button', onclick: async () => { const rec = await store.get(r.key); if (rec) openSheet(rec.sheet, r.key, rec.projectId ? { id: rec.projectId, role: 'owner' } : null); } },
      h('span', { class: 'r-title' }, r.title || 'Tanpa judul'),
      h('span', { class: 'r-meta' }, `${r.pages} hlm · ${new Date(r.updated).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}`))));
  }
}

function init() {
  const drop = $('drop');
  const input = $('pdfInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { openFile(input.files[0]); input.value = ''; });
  $('openJsonBtn').addEventListener('click', () => input.click());
  $('sampleBtn').addEventListener('click', async () => {
    const res = await fetch(new URL('samples/ekosistem-kolam.pdf', import.meta.url));
    if (!res.ok) { snack('Contoh tidak tersedia.'); return; }
    importBytes(new Uint8Array(await res.arrayBuffer()), 'ekosistem-kolam.pdf');
  });
  // Drop anywhere on the start screen
  for (const ev of ['dragenter', 'dragover']) addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) drop.classList.remove('over'); });
  addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });

  $('title').addEventListener('change', (e) => commit(() => { sheet.title = e.target.value.trim() || sheet.title; }));
  $('modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.mode !== mode) setMode(b.dataset.mode); });
  $('undoBtn').addEventListener('click', doUndo);
  $('addTool').addEventListener('click', () => setDrawing(!drawing));
  const zoomBy = (d) => { const cur = player ? player.scale : 1; zoom = Math.max(0.4, Math.min(3, Math.round((cur + d) * 10) / 10)); player.setScale(zoom); updateZoomLabel(); };
  $('zoomIn').addEventListener('click', () => zoomBy(0.1));
  $('zoomOut').addEventListener('click', () => zoomBy(-0.1));

  $('loginBtn').addEventListener('click', async () => { if (await authDialog('login')) renderCloudStart(); });
  const amenu = $('accountMenu');
  $('accountBtn').addEventListener('click', (e) => { e.stopPropagation(); amenu.hidden = !amenu.hidden; });
  addEventListener('click', (e) => { if (!amenu.hidden && !amenu.contains(e.target)) amenu.hidden = true; });
  $('logoutBtn').addEventListener('click', async () => { amenu.hidden = true; await logout(); updatePublishItem(); renderCloudStart(); snack('Anda telah keluar.'); });

  const menu = $('exportMenu');
  $('exportBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) menu.querySelector('button').focus(); });
  addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    menu.hidden = true;
    const name = slug(sheet.title);
    if (b.dataset.export === 'json') download(name + '.elkpd.json', JSON.stringify(sheet), 'application/json');
    if (b.dataset.export === 'html') {
      const missing = allFields().filter((x) => !x.f.label).length;
      download(name + '.html', await buildStandaloneHtml(sheet), 'text/html');
      snack(missing ? `Tersimpan. ${missing} isian belum diberi nama.` : 'Tersimpan. Bagikan berkas .html ini ke siswa.');
    }
    if (b.dataset.export === 'new') { history.replaceState(null, '', location.pathname); show('start'); showRecent(); renderCloudStart(); }
    if (b.dataset.export === 'publish') publish();
  });

  addEventListener('keydown', (e) => {
    if ($('editor').hidden) return;
    const typing = e.target.closest('input,textarea,select,[contenteditable=true]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); doRedo(); return; }
    if (typing || mode !== 'design') return;
    if (e.key === 'Escape') { if (drawing) setDrawing(false); else select(null); return; }
    if (e.key === 'a' || e.key === 'A') { setDrawing(!drawing); return; }
    const hit = selected && findField(selected);
    if (!hit) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(hit.f.id); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(hit.f, hit.pg); return; }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); commit(() => { hit.f.x = r1(hit.f.x + d[0]); hit.f.y = r1(hit.f.y + d[1]); }); }
  });

  // Reopen the sheet in the URL hash (a reload keeps you where you were).
  const key = decodeURIComponent(location.hash.slice(1));
  const home = () => { showRecent(); renderCloudStart(); };
  refreshMe().then(() => {
    if (!$('start').hidden) renderCloudStart();
    updatePublishItem();
  });
  if (key) store.get(key).then((rec) => { if (rec) openSheet(rec.sheet, key, rec.projectId ? { id: rec.projectId, role: 'owner' } : null); else home(); });
  else home();
}

init();
