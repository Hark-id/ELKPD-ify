// ELKPD Studio: PDF -> reviewed, fillable sheet, entirely in the browser.
//
//   start  : pick or drop a PDF (or a sheet.json, or the sample); continue
//            a recent sheet or a published project
//   busy   : pdf.js + src/sheet/import.js, page by page
//   editor : Sunting (fix the answer boxes and text), Coba isi (the real
//            player, reflow and all), Kelas (live rooms of a project)
//
// Layout rule: tools sit where the work is. The dock floats on the canvas,
// page actions sit on their page, a field's settings sit in the panel only
// while it is selected, and the panel is a bottom sheet on phones.
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
const KIND_LABEL = { text: 'Singkat', textarea: 'Panjang', checkbox: 'Centang', date: 'Tanggal', number: 'Angka', choice: 'Pilihan' };
const UNSURE = 0.6; // OCR runs below this confidence are flagged for review
const KIND_ICON = {
  text: '<path d="M4 17h16"/><path d="M7 13V7h5"/>',
  textarea: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  checkbox: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  date: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 10h16M9 4v4M15 4v4"/>',
  number: '<path d="M10 4L8 20M16 4l-2 16M5 9h15M4 15h15"/>',
  choice: '<circle cx="7" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><circle cx="7" cy="7" r="1" fill="currentColor"/><path d="M13 7h7M13 17h7"/>',
};
const SOURCE = { leader: 'titik-titik', line: 'garis', lines: 'garis tulis', table: 'tabel', box: 'kotak', checkbox: 'kotak centang', acroform: 'formulir PDF', space: 'ruang kosong', ocr: 'hasil pindai' };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const PHONE = matchMedia('(max-width: 840px)');

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
let popId = null;     // a field that was just added: it pops in once
let panelFrom = '';   // direction the next panel slides in from
const undo = [], redo = [];

// Student mode (#15): /studio/?untuk=kelompok turns a PDF into a group room
// with no account; /studio/?ruang=edit fixes the sheet of the room this
// browser is in. Both end in a room, not in an account's project.
const QS = new URLSearchParams(location.search);
const GROUP = QS.get('untuk') === 'kelompok';
const ROOM_EDIT = QS.get('ruang') === 'edit';
const STUDENT = GROUP || ROOM_EDIT;

// ------------------------------------------------------------ helpers
const svg = (inner, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); if (cls) s.setAttribute('class', cls); s.innerHTML = inner; return s; };
const icon = (id) => svg(`<use href="#i-${id}"/>`);

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

function show(view) {
  for (const v of ['start', 'busy', 'editor']) {
    const el = $(v);
    const was = !el.hidden;
    el.hidden = v !== view;
    if (v === view && !was) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  }
  const inEditor = view === 'editor';
  document.body.classList.toggle('editor-on', inEditor);
  $('brand').hidden = inEditor;
  $('homeBtn').hidden = !inEditor || ROOM_EDIT;
  $('title').hidden = $('modeSeg').hidden = $('exportBtn').hidden = $('hist').hidden = !inEditor;
  $('classTab').hidden = !inEditor || !project;
  if (STUDENT) {
    $('exportBtn').textContent = ROOM_EDIT ? 'Simpan ke ruang' : 'Buat ruang';
    $('exportBtn').removeAttribute('aria-haspopup');
    $('accountBtn').hidden = true;
  }
  renderLogin();
  if (inEditor) requestAnimationFrame(() => placeSegInd(false));
  if (!inEditor) stopClassPolling();
}

function renderLogin() {
  $('loginBtn').hidden = STUDENT || !cloud.available || !!cloud.user || $('start').hidden;
}

// A small in-app text dialog; resolves the text, or null when cancelled.
function askText({ title, sub, label, placeholder, ok }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', maxlength: '60', placeholder: placeholder || '', id: 'askInput' });
    const done = (v) => { scrim.remove(); resolve(v); };
    const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) done(null); } },
      h('form', { class: 'dialog', id: 'askForm', onsubmit: (e) => { e.preventDefault(); done(input.value.trim()); } },
        h('h2', { class: 'dialog-title' }, title),
        sub ? h('p', { class: 'p-sub' }, sub) : null,
        h('label', { class: 'fld' }, h('span', {}, label), input),
        h('div', { class: 'row end' },
          h('button', { class: 'btn text', type: 'button', onclick: () => done(null) }, 'Batal'),
          h('button', { class: 'btn filled', type: 'submit' }, ok))));
    scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    document.body.appendChild(scrim);
    setTimeout(() => input.focus(), 30);
  });
}

// One step from a reviewed sheet to a live room (group mode), or back into
// the room after fixing its sheet (room edit mode).
async function studentAction() {
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    if (ROOM_EDIT) {
      const r = await fetch('/api/room/sheet', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sheet) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || 'HTTP ' + r.status);
      location.href = '/';
      return;
    }
    const label = await askText({ title: 'Buat ruang kelompok', sub: 'Kamu dapat kode untuk teman sekelompok.',
      label: 'Nama kelompok', placeholder: 'mis. Kelompok 3', ok: 'Buat ruang' });
    if (label === null) return;
    const r = await fetch('/api/rooms/from-sheet?label=' + encodeURIComponent(label.trim()), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sheet) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(r.status === 404 ? 'Server ini belum mendukung ruang dari PDF.' : (d.error || 'HTTP ' + r.status));
    // The response set this browser's room session: the gate now serves
    // the room. The code is shown there, in the tool bar, to share.
    try { sessionStorage.setItem('esh-new-room', JSON.stringify(d.room)); } catch {}
    location.href = '/';
  } catch (e) {
    snack('Gagal: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

let snackTimer = 0;
function snack(msg, action) {
  const el = $('snack');
  el.textContent = '';
  el.classList.remove('out');
  el.append(msg);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { hideSnack(); action.run(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideSnack, action ? 8000 : 4000);
}
function hideSnack() {
  const el = $('snack');
  clearTimeout(snackTimer);
  if (el.hidden) return;
  el.classList.add('out');
  snackTimer = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, REDUCED.matches ? 0 : 160);
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
  updateHist();
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
function updateHist() {
  $('undoBtn').disabled = !undo.length;
  $('redoBtn').disabled = !redo.length;
}
function afterHistory() {
  updateHist();
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
  $('busyNote').textContent = '';
  setBar(0.04);
  try {
    const lib = await loadPdfjs();
    const s = await importPdf(lib, bytes, {
      name,
      docOptions: { standardFontDataUrl: `${PDFJS}/standard_fonts/`, cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true },
      onProgress(done, total) {
        setBar(0.04 + (0.96 * done) / total);
        $('busyNote').textContent = `Halaman ${done} dari ${total}`;
      },
    });
    // Scanned pages (#23): ask how to take them, at the moment it matters,
    // then OCR on this device. Keep the scan's look, or turn it into real
    // editable text on clean paper ("digital book").
    const ocr = await import('../sheet/ocr.js');
    let ocrFailed = false;
    if (ocr.needsOcr(s)) {
      const pick = QS.get('ocr') || await askScanMode();
      const digital = pick === 'digital';
      $('busyTitle').textContent = 'Membaca teks pindaian';
      $('busyNote').textContent = 'Memuat pengenal teks…';
      setBar(0);
      try {
        await ocr.ocrSheet(lib, bytes, s, {
          digital,
          docOptions: { standardFontDataUrl: `${PDFJS}/standard_fonts/`, cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true },
          onProgress({ page, pages, pct }) {
            setBar(pct);
            $('busyNote').textContent = `Halaman ${page} dari ${pages}`;
          },
        });
      } catch (e) { console.warn('OCR failed', e); ocrFailed = true; }
    }
    const n = s.pages.reduce((k, p) => k + p.fields.length, 0);
    openSheet(s, null);
    if (ocrFailed) snack('Teks pindaian tidak terbaca (perlu internet). Tambahkan isian dengan tombol Isian.');
    else snack(n ? `${n} isian ditemukan` : 'Belum ada isian. Tambahkan dengan tombol Isian.');
  } catch (e) {
    console.error(e);
    show('start');
    snack(/password/i.test(String(e && e.name) + e) ? 'PDF ini dikunci kata sandi.' : 'PDF tidak bisa dibaca: ' + (e && e.message || e));
  }
}

// The busy screen asks once, before OCR starts: the spinner steps aside
// for two choices, the first one (keep the scan) is the safe default.
function askScanMode() {
  return new Promise((resolve) => {
    const card = $('busy').querySelector('.busy-card');
    const box = $('scanChoice');
    card.hidden = true;
    box.hidden = false;
    box.querySelectorAll('[data-ocr]').forEach((b) => { b.onclick = () => { box.hidden = true; card.hidden = false; resolve(b.dataset.ocr); }; });
    box.querySelector('[data-ocr]').focus();
  });
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
  updateHist();
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
  canvas.classList.remove('empty');
  if (mode === 'class') {
    const room = classData && classData.rooms.find((r) => r.id === classRoom);
    if (!room) {
      canvas.textContent = '';
      canvas.classList.add('empty');
      canvas.append(h('div', { class: 'empty-canvas' }, icon('class'), classData && classData.rooms.length ? 'Pilih ruang untuk melihat jawabannya.' : 'Belum ada ruang.'));
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
  if (mode === 'design') { buildOverlay(); buildPageBars(); wireText(); }
  updateZoomLabel();
}

function updateZoomLabel() {
  $('zoomLabel').textContent = player ? Math.round(player.scale * 100) + '%' : '';
}

// Page actions sit above their page, outside the scaled page element, so
// they stay the same size at any zoom.
function buildPageBars() {
  const n = sheet.pages.length;
  player.pages.forEach((pp, pi) => {
    const pw = pp.element.parentElement;
    const blank = !sheet.pages[pi].fields.length && !sheet.pages[pi].text.length;
    const btn = (ic, label, dis, fn) => h('button', { class: 'icon-btn' + (ic === 'trash' ? ' danger' : ''), type: 'button', title: label, 'aria-label': `${label} ${pi + 1}`, disabled: dis, onclick: fn }, icon(ic));
    pw.append(h('div', { class: 'pg-bar' },
      h('span', { class: 'pg-name' }, `Halaman ${pi + 1}` + (blank ? ' · kosong' : '')),
      n > 1 ? [btn('up', 'Naikkan halaman', pi === 0, () => movePage(pi, -1)), btn('down', 'Turunkan halaman', pi === n - 1, () => movePage(pi, 1)), btn('trash', 'Hapus halaman', false, () => deletePage(pi))] : null));
  });
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
  el.className = 'st-fb kind-' + f.kind + (f.lineGap ? ' lined' : '') + (f.label ? '' : ' unnamed') + (f.id === selected ? ' sel' : '') + (f.id === popId && !REDUCED.matches ? ' pop' : '');
  if (f.id === popId) { popId = null; el.addEventListener('animationend', () => el.classList.remove('pop'), { once: true }); }
  if (f.lineGap) el.style.setProperty('--gap', f.lineGap + 'px'); else el.style.removeProperty('--gap');
  el.querySelector('.st-chip').textContent = f.label || 'Tanpa nama';
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
  if (id === selected) return;
  panelFrom = id ? 'from-right' : 'from-left';
  selected = id;
  if (id && PHONE.matches) setSheetOpen(true);
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
      popId = f.id;
      panelFrom = 'from-right';
      commit(() => { pg.fields.push(f); selected = f.id; });
      setDrawing(false);
      if (PHONE.matches) setSheetOpen(true);
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
    if (!moved) { moved = true; undo.push(snapshot()); redo.length = 0; updateHist(); }
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
  $('editor').classList.toggle('drawing', on);
  $('canvas').classList.toggle('drawing', on);
  if (on) snack(PHONE.matches ? 'Ketuk atau seret di halaman' : 'Seret di halaman untuk menggambar kotak');
  else if ($('snack').textContent.startsWith('Ketuk atau seret') || $('snack').textContent.startsWith('Seret di halaman')) hideSnack();
}

const textRun = (id) => { for (const p of sheet.pages) { const t = p.text.find((q) => q.id === id); if (t) return t; } return null; };
const unsureRuns = () => sheet.pages.flatMap((p) => p.text.filter((t) => t.conf != null && t.conf < UNSURE && t.alpha !== 0));

// Jump to a text run and open it for editing (the "kata ragu" walk).
function editRun(id) {
  const el = $('canvas').querySelector(`.esh-t[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  if (PHONE.matches) setSheetOpen(false);
  el.scrollIntoView({ block: 'center', behavior: REDUCED.matches ? 'auto' : 'smooth' });
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

// Double-click a text run to fix a typo or reword it.
function wireText() {
  $('canvas').querySelectorAll('.esh-t').forEach((el) => {
    el.title = 'Klik dua kali untuk mengubah';
    const run = textRun(el.dataset.id);
    if (run && run.conf != null && run.conf < UNSURE && run.alpha !== 0) { el.classList.add('unsure'); el.title = 'Mungkin salah baca. Klik dua kali untuk memperbaiki'; }
    el.addEventListener('dblclick', () => {
      if (el.isContentEditable) return;
      const id = el.dataset.id;
      el.contentEditable = 'true';
      el.style.transform = 'none';
      el.focus();
      const sel = getSelection();
      sel.selectAllChildren(el);
      let next = false;
      const done = (save) => {
        el.removeEventListener('blur', onBlur);
        el.removeEventListener('keydown', onKey);
        el.contentEditable = 'false';
        const str = el.textContent.replace(/\s+/g, ' ').trim();
        const t = textRun(id);
        const unsure = !!t && t.conf != null;
        // Saving an unsure word, changed or not, means a person checked it.
        if (save && t && (str !== t.str || unsure)) {
          commit(() => {
            if (!str) sheet.pages.forEach((p) => { p.text = p.text.filter((q) => q.id !== id); });
            else { if (str !== t.str) { t.str = str; delete t.w; } delete t.conf; } // edited: natural width, the PDF width no longer applies
          }, { rerender: true });
        } else renderSheet();
        // Enter on a flagged word goes on to the next one.
        if (save && next && unsure) { const u = unsureRuns()[0]; if (u) requestAnimationFrame(() => editRun(u.id)); }
      };
      const onBlur = () => done(true);
      const onKey = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); next = true; el.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      };
      el.addEventListener('blur', onBlur);
      el.addEventListener('keydown', onKey);
    });
  });
}

// ---------------------------------------------------------- panel
// Design mode shows one thing at a time: the list of fields (what is
// left to do on top), or the selected field. Preview has no panel at all:
// the sheet gets the whole width, like a student sees it.
function renderInspector() {
  const box = $('inspector');
  const wide = mode === 'preview';
  $('editor').querySelector('.workspace').classList.toggle('wide', wide);
  document.body.classList.toggle('panel-off', wide);
  box.textContent = '';
  let el;
  if (mode === 'class') el = classPanel();
  else if (mode === 'design') {
    const hit = selected && findField(selected);
    el = hit ? fieldPanel(hit.f, hit.pg, hit.pi) : overviewPanel();
  }
  if (el) {
    if (panelFrom) el.classList.add(panelFrom);
    panelFrom = '';
    box.append(el);
  }
  renderHandle();
}

function renderHandle() {
  let t = '';
  if (mode === 'design' && sheet) {
    const hit = selected && findField(selected);
    const fields = allFields();
    const unnamed = fields.filter((x) => !x.f.label).length;
    t = hit ? (hit.f.label || 'Isian tanpa nama') : `${fields.length} isian` + (unnamed ? ` · ${unnamed} tanpa nama` : '');
  } else if (mode === 'class') t = classData ? `${classData.rooms.length} ruang` : 'Ruang kelompok';
  $('handleText').textContent = t;
}

function setSheetOpen(on) {
  $('panel').classList.toggle('open', on);
  $('sheetHandle').setAttribute('aria-expanded', String(on));
}

function kindIcon(k) { return svg(KIND_ICON[k] || KIND_ICON.text); }

function overviewPanel() {
  const fields = allFields();
  const unnamed = fields.filter((x) => !x.f.label);
  const wrap = h('div', { class: 'insp' },
    h('div', { class: 'p-head' }, h('h2', {}, 'Isian ', h('span', { class: 'count' }, String(fields.length)))));
  if (!fields.length) {
    wrap.append(h('div', { class: 'empty' }, 'Belum ada isian.', h('br'),
      h('button', { class: 'btn tonal', type: 'button', onclick: () => setDrawing(true) }, icon('plus'), 'Tambah isian')));
    return wrap;
  }
  // Words the OCR wasn't sure of (digital pages): one button walks to them.
  const unsure = unsureRuns();
  if (unsure.length) {
    wrap.append(h('button', { class: 'todo soft', type: 'button', onclick: () => editRun(unsure[0].id) },
      h('span', {}, `Periksa ${unsure.length} kata ragu`), svg('<path d="M9 6l6 6-6 6"/>')));
  }
  // The one thing left to do, as a button that does it.
  if (unnamed.length) {
    wrap.append(h('button', { class: 'todo', type: 'button', onclick: () => { select(unnamed[0].f.id, { scroll: true }); requestAnimationFrame(() => { const n = $('inspector').querySelector('.name-input'); if (n && !PHONE.matches) n.focus(); }); } },
      h('span', {}, `Beri nama ${unnamed.length} isian`), icon('back')));
    wrap.lastChild.querySelector('svg').style.transform = 'rotate(180deg)';
  } else {
    wrap.append(h('p', { class: 'done-note' }, icon('check'), 'Semua isian sudah bernama'));
  }
  const many = sheet.pages.length > 1;
  sheet.pages.forEach((pg, pi) => {
    if (!pg.fields.length) return;
    if (many) wrap.append(h('p', { class: 'group' }, `HALAMAN ${pi + 1}`));
    wrap.append(h('ul', { class: 'flist' }, pg.fields.map((f) => h('li', {}, h('button', {
      type: 'button',
      onclick: () => select(f.id, { scroll: true }),
      onpointerenter: () => hot(f.id, true), onpointerleave: () => hot(f.id, false),
      onfocus: () => hot(f.id, true), onblur: () => hot(f.id, false),
    },
    h('span', { class: 'fl-k', title: KIND_LABEL[f.kind] }, kindIcon(f.kind)),
    h('span', { class: 'fl-l' + (f.label ? '' : ' fl-empty') }, f.label || 'Tanpa nama'),
    f.label ? null : h('span', { class: 'fl-dot', 'aria-label': 'belum bernama' }))))));
  });
  return wrap;
}

// Hovering a row in the list lights up its box on the page.
function hot(id, on) {
  const el = $('canvas').querySelector(`.st-fb[data-id="${CSS.escape(id)}"]`);
  if (el) el.classList.toggle('hot', on);
}

function fieldPanel(f, pg, pi) {
  const edit = (fn, opts) => commit(fn, opts);
  const num = (label, key) => h('label', { class: 'fld' }, h('span', {}, label),
    h('input', { type: 'number', step: '0.5', inputmode: 'decimal', value: f[key], onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit(() => { f[key] = v; }); } }));
  const idErr = h('small', {}, 'Dipakai untuk menyimpan jawaban.');
  const idFld = h('label', { class: 'fld' }, h('span', {}, 'Kunci'),
    h('input', { type: 'text', value: f.id, spellcheck: 'false', autocapitalize: 'none', onchange: (e) => {
      const v = e.target.value.trim();
      const ok = /^[A-Za-z0-9_-]{1,60}$/.test(v) && !allFields().some((x) => x.f.id === v && x.f !== f);
      idFld.classList.toggle('err', !ok);
      idErr.textContent = ok ? 'Dipakai untuk menyimpan jawaban.' : 'Huruf, angka, - dan _ saja, dan harus unik.';
      if (ok && v !== f.id) edit(() => { f.id = v; selected = v; });
    } }), idErr);

  // choice only exists where OCR found the options; it can be left, not entered
  const kindList = Object.keys(KIND_LABEL).filter((k) => k !== 'choice' || f.kind === 'choice');
  const kinds = h('div', { class: 'kinds', role: 'group', 'aria-label': 'Jenis isian', style: `grid-template-columns:repeat(${kindList.length},1fr)` }, kindList.map((k) =>
    h('button', { type: 'button', 'aria-pressed': String(f.kind === k), onclick: () => { if (f.kind !== k) edit(() => {
      f.kind = k;
      if (k !== 'textarea') { delete f.lineGap; delete f.lines; }
      if (k !== 'choice') delete f.options;
      if (k === 'checkbox') { const s = Math.min(f.w, f.h, 14); f.w = f.h = s; }
    }); } }, kindIcon(k), KIND_LABEL[k])));

  const name = h('input', { class: 'name-input', type: 'text', value: f.label || '', placeholder: 'Beri nama, mis. Jawaban no. 1', 'aria-label': 'Nama isian', maxlength: '200',
    onchange: (e) => edit(() => { f.label = e.target.value.trim(); }),
    // Enter names it and moves on to the next unnamed field, so naming a
    // whole sheet is: type, Enter, type, Enter.
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = e.target.value.trim();
      if (v !== (f.label || '')) edit(() => { f.label = v; });
      if (!v) return;
      const order = allFields().map((x) => x.f);
      const i = order.indexOf(f);
      const next = [...order.slice(i + 1), ...order.slice(0, i)].find((q) => !q.label);
      select(next ? next.id : null, { scroll: !!next });
      if (next) requestAnimationFrame(() => { const n = $('inspector').querySelector('.name-input'); if (n) n.focus(); });
    } });

  const more = h('details', { class: 'more' }, h('summary', {}, 'Lainnya', icon('down')), h('div', {}));
  const body = more.lastChild;
  if (f.kind !== 'checkbox') {
    body.append(h('label', { class: 'fld' }, h('span', {}, 'Teks bantuan'),
      h('input', { type: 'text', value: f.placeholder || '', placeholder: 'mis. Tulis jawabanmu…', onchange: (e) => edit(() => { const v = e.target.value.trim(); if (v) f.placeholder = v; else delete f.placeholder; }) })));
  }
  if (f.kind === 'textarea') {
    body.append(
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.grow !== false, onchange: (e) => edit(() => { if (e.target.checked) delete f.grow; else f.grow = false; }) }),
        h('span', {}, 'Memanjang mengikuti jawaban')),
      h('label', { class: 'fld' }, h('span', {}, 'Jarak garis tulis (pt), 0 = kotak'),
        h('input', { type: 'number', min: '0', step: '0.5', inputmode: 'decimal', value: f.lineGap || 0, onchange: (e) => edit(() => { const v = parseFloat(e.target.value); if (v > 4) f.lineGap = v; else { delete f.lineGap; delete f.lines; } }) })));
  }
  body.append(
    h('div', { class: 'fld' }, h('span', {}, 'Posisi & ukuran (pt)'), h('div', { class: 'grid4' }, num('X', 'x'), num('Y', 'y'), num('Lebar', 'w'), num('Tinggi', 'h'))),
    idFld,
    h('p', { class: 'where' }, f.source === 'manual' ? 'Ditambahkan manual' : 'Ditemukan dari ' + (SOURCE[f.source] || f.source)));

  return h('div', { class: 'insp' },
    h('div', { class: 'p-head' },
      h('button', { class: 'back', type: 'button', onclick: () => select(null) }, icon('back'), 'Semua isian'),
      h('span', { class: 'appbar-spacer' }),
      h('button', { class: 'icon-btn', type: 'button', title: 'Duplikat (Ctrl+D)', 'aria-label': 'Duplikat isian', onclick: () => duplicate(f, pg) }, icon('copy')),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Hapus (Delete)', 'aria-label': 'Hapus isian', onclick: () => remove(f.id) }, icon('trash'))),
    name,
    h('p', { class: 'where' }, `Halaman ${pi + 1}`),
    kinds,
    h('label', { class: 'fld' }, h('span', {}, 'Pertanyaan'),
      h('textarea', { rows: '2', placeholder: 'Ditampilkan saat siswa mengisi di HP', onchange: (e) => edit(() => { const v = e.target.value.replace(/\s+/g, ' ').trim().slice(0, 600); if (v) f.prompt = v; else delete f.prompt; }) }, f.prompt || '')),
    more);
}

function movePage(i, d) {
  commit(() => { const [p] = sheet.pages.splice(i, 1); sheet.pages.splice(i + d, 0, p); }, { rerender: true });
}
function deletePage(i) {
  const pg = sheet.pages[i];
  commit(() => { sheet.pages.splice(i, 1); if (selected && pg.fields.some((f) => f.id === selected)) selected = null; }, { rerender: true });
  snack(`Halaman ${i + 1} dihapus`, { label: 'Urungkan', run: doUndo });
}

function duplicate(f, pg) {
  const c = { ...f, id: nextFieldId(pg), y: r1(Math.min(pg.height - f.h, f.y + f.h + 6)), source: 'manual' };
  popId = c.id;
  commit(() => { pg.fields.push(c); selected = c.id; });
}
function remove(id) {
  panelFrom = 'from-left';
  commit(() => { sheet.pages.forEach((p) => { p.fields = p.fields.filter((q) => q.id !== id); }); selected = null; });
  snack('Isian dihapus', { label: 'Urungkan', run: doUndo });
}

// ------------------------------------------------------- publish + class
function updatePublishItem() {
  $('publishItem').hidden = !cloud.available || STUDENT;
  $('publishLabel').textContent = project ? 'Terbitkan perubahan' : 'Terbitkan untuk kelas';
  $('publishNote').textContent = project ? 'Ruang kelompok memakai versi baru' : 'Buat ruang untuk tiap kelompok';
  $('classTab').hidden = $('editor').hidden || !project;
  placeSegInd(false);
}

async function publish() {
  if (!cloud.user && !(await authDialog('login'))) return;
  try {
    if (project) {
      const r = await projects.publish(project.id, sheet);
      snack(`Versi ${r.version} diterbitkan`);
    } else {
      const r = await projects.create(sheet);
      project = { id: r.id, role: 'owner' };
      scheduleSave();
      updatePublishItem();
      refreshMe();
      snack('Diterbitkan', { label: 'Buat ruang', run: () => setMode('class') });
    }
  } catch (e) {
    snack('Gagal menerbitkan: ' + e.message);
  }
}

async function openProject(id, role) {
  show('busy');
  $('busyTitle').textContent = 'Membuka proyek…';
  $('busyNote').textContent = '';
  setBar(0.6);
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
  classTimer = setInterval(() => { if (!document.hidden) classTick(); }, 4000);
}
function stopClassPolling() { clearInterval(classTimer); classTimer = 0; }

function classPanel() {
  const total = allFields().length;
  const rooms = (classData && classData.rooms) || [];
  const canEdit = project && project.role !== 'viewer';
  const wrap = h('div', { class: 'insp' }, h('div', { class: 'p-head' }, h('h2', {}, 'Ruang ', h('span', { class: 'count' }, classData ? String(rooms.length) : ''))));
  if (!classData) { wrap.append(h('p', { class: 'p-sub' }, 'Memuat…')); return wrap; }
  if (canEdit) {
    const input = h('input', { type: 'text', placeholder: `Kelompok ${rooms.length + 1}`, maxlength: '60', 'aria-label': 'Nama ruang baru' });
    wrap.append(h('form', { class: 'room-new', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await projects.addRoom(project.id, input.value.trim() || `Kelompok ${rooms.length + 1}`);
        classRoom = r.room.id;
        await classTick();
        snack(`Ruang dibuat · kode ${r.room.code}`);
      } catch (err) { snack(err.message); }
    } }, h('label', { class: 'fld' }, input), h('button', { class: 'btn filled', type: 'submit' }, 'Buat')));
    if (!rooms.length) wrap.append(h('p', { class: 'p-sub' }, 'Satu ruang untuk tiap kelompok. Siswa masuk dengan kodenya, tanpa akun.'));
  }
  for (const r of rooms) {
    const filled = Object.values(r.answers || {}).filter((v) => v !== '' && v != null).length;
    const pct = total ? filled / total : 0;
    const link = `${location.origin}/j/${r.code}`;
    const sel = r.id === classRoom;
    wrap.append(h('div', { class: 'room-card' + (sel ? ' sel' : ''), onclick: (e) => { if (e.target.closest('button')) return; classRoom = r.id; renderSheet(); renderInspector(); } },
      h('div', { class: 'rc-top' }, h('span', { class: 'rc-label' }, r.label), r.code ? h('code', {}, r.code) : null),
      h('div', { class: 'rc-meta' },
        h('span', { class: 'live' + (r.peers.length ? '' : ' off') }, r.peers.length ? r.peers.map((p) => p.name).join(', ') : 'offline'),
        h('span', {}, r.error ? 'gagal dimuat' : `${filled}/${total}`)),
      h('div', { class: 'progress' }, h('i', { style: `transform:scaleX(${pct})` })),
      sel ? h('div', { class: 'row rc-acts' },
        r.code ? h('button', { class: 'btn tonal', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); snack('Tautan disalin'); } catch { snack(link); } } }, 'Salin tautan') : null,
        canEdit ? h('button', { class: 'btn text', type: 'button', onclick: async () => { if (!confirm(`Kosongkan semua jawaban ${r.label}?`)) return; await projects.resetRoom(project.id, r.id); classTick(); } }, 'Kosongkan') : null,
        canEdit ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (!confirm(`Hapus ${r.label}? Kode ${r.code} tidak bisa dipakai lagi dan jawabannya hilang.`)) return; await projects.removeRoom(project.id, r.id); classRoom = null; classTick(); } }, 'Hapus') : null) : null));
  }
  if (rooms.length) wrap.append(h('div', { class: 'row', style: 'margin:8px 0 20px' }, h('button', { class: 'btn text', type: 'button', onclick: () => exportCsv(rooms) }, 'Unduh jawaban (.csv)')));
  if (project.role === 'owner') wrap.append(sharePanel());
  return wrap;
}

function exportCsv(rooms) {
  const fields = allFields().map((x) => x.f);
  // Quote every cell, and defuse spreadsheet formulas: a student can type
  // =HYPERLINK(...) as an answer, and Excel would run it on the teacher's PC.
  const q = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const rows = [['Ruang', 'Kode', ...fields.map((f) => f.label || f.id)].map(q).join(',')];
  for (const r of rooms) rows.push([r.label, r.code, ...fields.map((f) => (f.kind === 'checkbox' ? (r.answers[f.id] ? 'ya' : '') : r.answers[f.id]))].map(q).join(','));
  // BOM so Excel opens UTF-8 (Indonesian text) correctly
  download(slug(sheet.title) + '-jawaban.csv', '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
}

function sharePanel() {
  const box = h('details', { class: 'more' }, h('summary', {}, 'Guru lain', icon('down')));
  const inner = h('div', {});
  box.append(inner);
  const list = h('div', {});
  inner.append(list);
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
  box.addEventListener('toggle', () => { if (box.open && !list.childElementCount) fill().catch(() => {}); });
  const user = h('input', { type: 'text', placeholder: 'nama pengguna', spellcheck: 'false', autocapitalize: 'none', 'aria-label': 'Nama pengguna guru' });
  const role = h('select', { 'aria-label': 'Peran' }, h('option', { value: 'editor' }, 'Penyunting'), h('option', { value: 'viewer' }, 'Pemeriksa'));
  inner.append(h('form', { class: 'row', style: 'margin-top:8px', onsubmit: async (e) => {
    e.preventDefault();
    try { await projects.share(project.id, user.value.trim(), role.value); user.value = ''; fill(); snack('Akses diberikan'); } catch (err) { snack(err.message); }
  } }, h('label', { class: 'fld', style: 'flex:1;margin:0' }, user), h('label', { class: 'fld', style: 'margin:0' }, role), h('button', { class: 'btn tonal', type: 'submit' }, 'Tambah')));
  inner.append(h('p', { class: 'where', style: 'margin-top:10px' }, 'Penyunting: ubah lembar dan ruang. Pemeriksa: lihat jawaban.'));
  return box;
}

// ------------------------------------------------------------ home
// One list: published projects first (they live on the server), then
// sheets in this browser that aren't one of those projects.
async function renderHome() {
  const list = $('recentList');
  const local = await store.list();
  const items = [];
  const ROLE = { editor: 'penyunting', viewer: 'pemeriksa' };
  const when = (t) => new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  if (cloud.user && !GROUP) {
    for (const p of cloud.projects) items.push({ cloud: true, title: p.title, meta: 'Diterbitkan · ' + when(p.updated), role: ROLE[p.role], open: () => openProject(p.id, p.role) });
  }
  const published = new Set(cloud.user ? cloud.projects.map((p) => p.id) : []);
  for (const r of local.slice(0, 8)) {
    if (r.projectId && published.has(r.projectId)) continue;
    if (r.key === 'room-edit') continue;
    items.push({ title: r.title, meta: `${r.pages} hlm · ${when(r.updated)}`, open: async () => { const rec = await store.get(r.key); if (rec) openSheet(rec.sheet, r.key, rec.projectId ? { id: rec.projectId, role: 'owner' } : null); } });
  }
  list.textContent = '';
  items.forEach((it, i) => list.append(h('li', { style: `--i:${Math.min(i, 8)}` }, h('button', { type: 'button', onclick: it.open },
    h('span', { class: 'r-ic' + (it.cloud ? ' cloud' : '') }, icon(it.cloud ? 'class' : 'file')),
    h('span', { class: 'r-main' }, h('span', { class: 'r-title' }, it.title || 'Tanpa judul'), h('span', { class: 'r-meta' }, it.meta)),
    it.role ? h('span', { class: 'r-role' }, it.role) : null))));
  $('recent').hidden = !items.length;
}

function goHome() {
  history.replaceState(null, '', location.pathname + location.search);
  sheet = null;
  if (player) { player.destroy(); player = null; }
  show('start');
  renderHome();
}

// --------------------------------------------------------------- mode
function setMode(m) {
  mode = m;
  if (m === 'class') startClassPolling(); else stopClassPolling();
  for (const b of $('modeSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
  placeSegInd(true);
  $('addTool').hidden = m !== 'design';
  $('clearBtn').hidden = $('printBtn').hidden = m !== 'preview';
  setDrawing(false);
  if (m !== 'design' || !selected) setSheetOpen(false);
  if (sheet) { renderSheet(); renderInspector(); }
}

// The selected segment's pill slides to its new place on the gate's fast
// spring, with the same squash the gate's tab indicator has.
let segAt = null;
function placeSegInd(animate) {
  const seg = $('modeSeg');
  const ind = $('segInd');
  const b = seg.querySelector('button[aria-checked=true]');
  if (!b || seg.hidden || !b.offsetWidth) return;
  const to = { x: b.offsetLeft, w: b.offsetWidth, h: b.offsetHeight, t: b.offsetTop };
  ind.style.cssText = `width:${to.w}px;height:${to.h}px;top:${to.t}px;transform:translateX(${to.x}px)`;
  seg.classList.add('ready');
  if (animate && segAt && segAt.x !== to.x && ind.animate && !REDUCED.matches) {
    ind.getAnimations().forEach((a) => a.cancel());
    const sx = segAt.w / to.w;
    ind.animate([
      { transform: `translateX(${segAt.x}px) scaleX(${sx})`, transformOrigin: '0 0' },
      { transform: `translateX(${(segAt.x + to.x) / 2}px) scaleX(${(1 + sx) / 2 * 1.08}) scaleY(.92)`, transformOrigin: '0 0', offset: 0.45 },
      { transform: `translateX(${to.x}px)`, transformOrigin: '0 0' },
    ], { duration: 350, easing: 'cubic-bezier(.42,1.67,.21,.90)' });
  }
  segAt = to;
}

function setBar(f) { $('busyBar').style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`; }

// --------------------------------------------------------------- wire up
function init() {
  const input = $('pdfInput');
  $('pickBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { openFile(input.files[0]); input.value = ''; });
  $('sampleBtn').addEventListener('click', async () => {
    const res = await fetch(new URL('samples/ekosistem-kolam.pdf', import.meta.url));
    if (!res.ok) { snack('Contoh tidak tersedia.'); return; }
    importBytes(new Uint8Array(await res.arrayBuffer()), 'ekosistem-kolam.pdf');
  });
  // Drop anywhere while the start screen is up.
  const start = $('start');
  let depth = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); if (start.hidden) return; depth++; start.classList.add('over'); });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; start.classList.remove('over'); } });
  addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    start.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && !start.hidden) openFile(f);
  });

  $('homeBtn').addEventListener('click', goHome);
  $('brand').addEventListener('click', (e) => { if (!$('start').hidden) return; e.preventDefault(); goHome(); });
  $('title').addEventListener('change', (e) => commit(() => { sheet.title = e.target.value.trim() || sheet.title; }));
  $('title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.mode !== mode) setMode(b.dataset.mode); });
  addEventListener('resize', () => placeSegInd(false));
  if (document.fonts) document.fonts.ready.then(() => placeSegInd(false));
  $('undoBtn').addEventListener('click', doUndo);
  $('redoBtn').addEventListener('click', doRedo);
  $('addTool').addEventListener('click', () => setDrawing(!drawing));
  $('clearBtn').addEventListener('click', () => { previewValues = {}; player.clear(); });
  $('printBtn').addEventListener('click', () => window.print());
  const zoomBy = (d) => { const cur = player ? player.scale : 1; zoom = Math.max(0.4, Math.min(3, Math.round((cur + d) * 10) / 10)); player.setScale(zoom); updateZoomLabel(); };
  $('zoomIn').addEventListener('click', () => zoomBy(0.1));
  $('zoomOut').addEventListener('click', () => zoomBy(-0.1));
  $('zoomLabel').addEventListener('click', () => { zoom = null; if (player) player.setScale(null); updateZoomLabel(); });
  $('sheetHandle').addEventListener('click', () => setSheetOpen(!$('panel').classList.contains('open')));

  $('loginBtn').addEventListener('click', async () => { if (await authDialog('login')) { renderLogin(); renderHome(); updatePublishItem(); } });
  const amenu = $('accountMenu');
  $('accountBtn').addEventListener('click', (e) => { e.stopPropagation(); amenu.hidden = !amenu.hidden; });
  addEventListener('click', (e) => { if (!amenu.hidden && !amenu.contains(e.target)) amenu.hidden = true; });
  $('logoutBtn').addEventListener('click', async () => { amenu.hidden = true; await logout(); updatePublishItem(); renderLogin(); renderHome(); snack('Anda telah keluar'); });

  const menu = $('exportMenu');
  const setMenu = (open) => { menu.hidden = !open; $('exportBtn').setAttribute('aria-expanded', String(open)); };
  $('exportBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (STUDENT) { studentAction(); return; }
    setMenu(menu.hidden);
    if (!menu.hidden) menu.querySelector('button:not([hidden])').focus();
  });
  addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); $('exportBtn').focus(); } });
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setMenu(false);
    const name = slug(sheet.title);
    if (b.dataset.export === 'json') download(name + '.elkpd.json', JSON.stringify(sheet), 'application/json');
    if (b.dataset.export === 'html') {
      const missing = allFields().filter((x) => !x.f.label).length;
      download(name + '.html', await buildStandaloneHtml(sheet), 'text/html');
      snack(missing ? `Tersimpan · ${missing} isian belum bernama` : 'Tersimpan');
    }
    if (b.dataset.export === 'publish') publish();
  });

  addEventListener('keydown', (e) => {
    if ($('editor').hidden) return;
    const typing = e.target.closest('input,textarea,select,[contenteditable=true]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); doRedo(); return; }
    if (typing || mode !== 'design' || e.target.closest('.scrim')) return;
    if (e.key === 'Escape') { if (drawing) setDrawing(false); else select(null); return; }
    if ((e.key === 'a' || e.key === 'A') && !mod) { setDrawing(!drawing); return; }
    const hit = selected && findField(selected);
    if (!hit) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(hit.f.id); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(hit.f, hit.pg); return; }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); commit(() => { hit.f.x = r1(hit.f.x + d[0]); hit.f.y = r1(hit.f.y + d[1]); }); }
  });

  if (GROUP) {
    $('startTitle').textContent = 'Buat ruang kelompok dari PDF';
    $('startSub').textContent = 'Kamu dapat kode untuk teman sekelompok. Tanpa akun.';
    $('startSub').hidden = false;
  }
  if (ROOM_EDIT) {
    show('busy');
    $('busyTitle').textContent = 'Membuka lembar ruang…';
    setBar(0.5);
    fetch('/api/room/sheet', { credentials: 'same-origin', cache: 'no-store' }).then(async (r) => {
      if (r.headers.get('X-Sheet-Editable') !== '1') throw new Error(r.status === 401 ? 'Masuk ke ruang dulu.' : 'Lembar ini dikelola guru, tidak bisa diubah dari ruang.');
      openSheet(await r.json(), 'room-edit');
    }).catch((e) => { show('start'); snack(e.message); });
    return;
  }

  // Reopen the sheet in the URL hash (a reload keeps you where you were).
  const key = decodeURIComponent(location.hash.slice(1));
  refreshMe().then(() => {
    if (GROUP) { $('accountBtn').hidden = true; return; }
    renderLogin();
    if (!$('start').hidden) renderHome();
    updatePublishItem();
  });
  if (key) store.get(key).then((rec) => { if (rec) openSheet(rec.sheet, key, rec.projectId ? { id: rec.projectId, role: 'owner' } : null); else renderHome(); });
  else renderHome();
}

init();
