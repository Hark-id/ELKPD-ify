/* Scanned PDFs through the Studio (#23): src/sheet/ocr.js end to end, in
 * headless Chrome against a local server. The scans are generated at test
 * time by tests/fixtures/make-scans.mjs (tilted, tinted, noisy, with a dark
 * scanner edge). pdf.js, tesseract.js and its ind/eng data come from
 * jsDelivr, so this needs network.
 *
 *   node tests/test-ocr.mjs                                            */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { startServer } from '../scripts/dev-studio.mjs';
import { buildScans } from './fixtures/make-scans.mjs';

const PORT = 8940 + Math.floor(Math.random() * 100);
let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  (' + extra + ')' : ''}`); if (ok) passed++; else failed++; };
const timings = [];

const srv = await startServer(PORT);
const b = await launch({ width: 1440, height: 900 });
const tmp = mkdtempSync(join(tmpdir(), 'elkpd-ocr-'));
const BASE = `http://127.0.0.1:${PORT}/src/studio/`;
let asked = false;

// Import a PDF through the Studio's file input; resolves with the sheet.
// `pick`: answer the "PDF ini hasil pindai" question through the UI.
async function importFile(path, query = '', pick = null) {
  await b.goto(BASE + query);
  await b.waitFor(`!document.getElementById('start').hidden`);
  const t0 = Date.now();
  await b.setFile('#pdfInput', path);
  if (pick) {
    await b.waitFor(`!document.getElementById('scanChoice').hidden`, 60000);
    asked = await b.eval(`document.getElementById('busy').querySelector('.busy-card').hidden && document.activeElement?.dataset.ocr === 'scan'`);
    await b.eval(`document.querySelector('[data-ocr=${pick}]').click()`);
  }
  await b.waitFor(`!document.getElementById('editor').hidden && document.querySelector('.esh-sheet')?.dataset.ready`, 240000);
  const ms = Date.now() - t0;
  const sheet = await b.eval(`JSON.parse(JSON.stringify(studio.sheet))`);
  for (const p of sheet.pages) if (p.stats && p.stats.ocr) timings.push(`${path.split('/').pop()}${query} ${p.id}: ${p.stats.ocr.ms} ms, ${p.stats.ocr.words} words, deskew ${p.stats.ocr.angle} deg`);
  timings.push(`${path.split('/').pop()}${query} whole import (incl. tesseract load): ${ms} ms`);
  return sheet;
}

// Pixel statistics of a page's background JPEG, decoded in the page.
const bgStats = (pi) => b.eval(`(async () => {
  const p = studio.sheet.pages[${pi}];
  const src = /href="(data:image\\/jpeg;base64,[^"]+)"/.exec(p.background)[1];
  const img = new Image(); img.src = src; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const patch = (fx, fy) => { let s = 0, n = 0; const x0 = Math.round(fx * W), y0 = Math.round(fy * H);
    for (let y = y0 - 6; y < y0 + 6; y++) for (let x = x0 - 6; x < x0 + 6; x++) { s += lum(x, y); n++; } return Math.round(s / n); };
  let dark = 0; for (let i = 0; i < d.length; i += 16) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 128) dark++;
  const { _internal } = await import('../sheet/ocr.js');
  return { corners: [patch(0.03, 0.03), patch(0.97, 0.03), patch(0.03, 0.97), patch(0.97, 0.97)], paper: patch(0.5, 0.94),
    dark: dark / (d.length / 16), residual: _internal.estimateSkew(d, W, H), bytes: p.background.length };
})()`);

try {
  const scans = await buildScans(b, tmp);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const { validateSheet } = await import('../src/sheet/validate.js');

  // ---- 1. the multiple-choice scan, default (invisible text layer)
  let s = await importFile(scans['scan-pg.pdf'].path, '', 'scan');
  check('scan: the Studio asks how to take a scan, keeping its look focused first', asked);
  let p = s.pages[0];
  check('scan: OCR ran on the page', !!(p.stats && p.stats.ocr), JSON.stringify(p.stats && p.stats.ocr));
  const strs = p.text.map((t) => t.str);
  const all = strs.join('\n');
  check('scan: text found', p.text.length >= 25 && /Pilihlah jawaban/.test(all) && /Ekosistem/.test(all), p.text.length + ' runs');
  const order = ['1. Ekosistem', '2. Contoh', '3. Organisme', '4. Hewan', '5. Sebutkan', '6. Jelaskan', '7. Apa'].map((k) => strs.findIndex((x) => x.startsWith(k)));
  check('scan: reading order is the page order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(' '));
  check('scan: text layer is invisible (alpha 0) and carries conf', p.text.every((t) => t.alpha === 0 && t.conf >= 0 && t.conf <= 1));
  const body = p.text.find((t) => t.str.startsWith('5. Sebutkan'));
  check('scan: size and position estimated (12pt body, left margin)', body && Math.abs(body.size - 12) < 2.5 && Math.abs(body.x - 56) < 6, body && `${body.size}pt @ ${body.x}`);
  check('scan: the sheet validates', validateSheet(s).ok, JSON.stringify(validateSheet(s).error || ''));
  let st = await bgStats(0);
  check('clean: corners are white paper (no yellow, no scanner edge)', st.corners.every((v) => v > 235) && st.paper > 240, st.corners.join(' ') + ' / ' + st.paper);
  check('clean: tilt measured and corrected', Math.abs(p.stats.ocr.angle - scans['scan-pg.pdf'].tilt[0]) < 0.4 && Math.abs(st.residual) < 0.3, `tilt ${scans['scan-pg.pdf'].tilt[0]}, measured ${p.stats.ocr.angle}, residual ${st.residual}`);
  check('clean: background is one image, a sensible size', /^<svg[^>]*><image href="data:image\/jpeg;base64,[^"]+"[^>]*\/><\/svg>$/.test(p.background) && st.bytes < 1.5e6, st.bytes + ' B');
  const darkScan = st.dark;
  const choices = p.fields.filter((f) => f.kind === 'choice');
  check('fields: four multiple-choice questions, options A-E', choices.length === 4 && choices.every((f) => f.options.map((o) => o.value).join('') === 'ABCDE'), choices.length);
  check('fields: choices are labelled and prompted from the question number', choices.every((f, i) => f.label === `Jawaban no. ${i + 1}` && f.prompt.startsWith(`${i + 1}. `)), choices.map((f) => f.label).join(', '));
  check('fields: the inline options row is one choice', choices[3] && choices[3].w > 300 && choices[3].h < 20, choices[3] && `${choices[3].w}x${choices[3].h}`);
  const leaders = p.fields.filter((f) => f.kind === 'text').map((f) => f.label);
  check('fields: dotted blanks for Nama and Kelas', leaders.includes('Nama') && leaders.includes('Kelas'), leaders.join(', '));
  const essays = p.fields.filter((f) => f.kind === 'textarea');
  check('fields: essay answers for 5, 6, 7 with prompts', [5, 6, 7].every((n) => essays.some((f) => f.label === `Jawaban no. ${n}` && f.prompt && f.prompt.startsWith(`${n}. `))), essays.map((f) => f.label).join(', '));
  check('fields: all marked source ocr', p.fields.every((f) => f.source === 'ocr'));
  check('fields: no stray fields', p.fields.length === 9, p.fields.length);

  // ---- choice kind in the player: one answer, the letter; click again clears
  await b.eval(`document.querySelector('[data-mode=preview]').click()`);
  await b.waitFor(`document.querySelector('.canvas.preview .esh-sheet')?.dataset.ready`);
  const fid = choices[0].id;
  const radios = await b.eval(`document.getElementById(${JSON.stringify(fid)}).querySelectorAll('input[type=radio]').length`);
  check('player: a choice renders one radio per option', radios === 5, radios);
  const click = (v) => b.eval(`document.getElementById(${JSON.stringify(fid)}).querySelector('input[value=${v}]').click()`);
  await click('B'); await click('C');
  check('player: one answer per question, the value is the letter', await b.eval(`studio.player.values()[${JSON.stringify(fid)}]`) === 'C');
  await b.eval(`(() => { const r = document.getElementById(${JSON.stringify(fid)}).querySelector('input[value=C]'); r.dispatchEvent(new PointerEvent('pointerdown')); r.click(); })()`);
  check('player: clicking the chosen option clears it', (await b.eval(`studio.player.values()[${JSON.stringify(fid)}] || ''`)) === '');
  await b.eval(`studio.player.setValue(${JSON.stringify(fid)}, 'D')`);
  check('player: setValue picks the option', await b.eval(`document.getElementById(${JSON.stringify(fid)}).querySelector('input:checked')?.value`) === 'D');
  const html = await b.eval(`import('./export.js').then(m => m.buildStandaloneHtml(studio.sheet))`);
  check('export: the standalone sheet carries the choice field', html.includes('esh-opt') && html.includes('"kind":"choice"'));

  // ---- 2. digital mode: visible, styled text over an erased page
  s = await importFile(scans['scan-pg.pdf'].path, '?ocr=digital');
  p = s.pages[0];
  const vis = p.text.filter((t) => t.alpha == null);
  check('digital: runs are visible text', vis.length >= 30 && vis.length >= p.text.length * 0.8, `${vis.length}/${p.text.length}`);
  check('digital: runs carry conf for review', p.text.every((t) => typeof t.conf === 'number'));
  const head = p.text.find((t) => /LEMBAR/.test(t.str));
  const plain = p.text.find((t) => t.str.startsWith('5. Sebutkan'));
  check('digital: bold heading detected, body regular', head && head.weight === 700 && plain && !plain.weight, `${head && head.weight} / ${plain && plain.weight}`);
  check('digital: dark ink stays black', vis.filter((t) => t.color).length <= vis.length * 0.2, vis.filter((t) => t.color).map((t) => t.color).join(' '));
  st = await bgStats(0);
  check('digital: words erased from the background', st.dark < darkScan * 0.35, `dark ${(st.dark * 100).toFixed(2)}% vs ${(darkScan * 100).toFixed(2)}%`);
  check('digital: same fields as the default mode', p.fields.length === 9 && p.fields.filter((f) => f.kind === 'choice').length === 4, p.fields.length);
  check('digital: the sheet validates', validateSheet(s).ok, JSON.stringify(validateSheet(s).error || ''));
  check('digital: the page renders the text', await b.eval(`[...document.querySelectorAll('.esh-t')].filter(e => getComputedStyle(e).opacity === '1').length`) >= 30);
  // unsure words: marked on the page, counted in the panel, walked with Enter
  // (these synthetic scans read cleanly, so two words are made doubtful here)
  await b.eval(`(() => { const t = studio.sheet.pages[0].text.filter(t => t.alpha == null && t.conf >= 0.6); t[3].conf = 0.3; t[8].conf = 0.4;
    document.querySelector('[data-mode=preview]').click(); document.querySelector('[data-mode=design]').click(); })()`);
  await b.waitFor(`document.querySelector('.canvas.design .esh-sheet')?.dataset.ready`);
  const nUnsure = await b.eval(`document.querySelectorAll('.esh-t.unsure').length`);
  const expected = await b.eval(`window.studio.sheet.pages[0].text.filter(t => t.conf < 0.6).length`);
  check('digital: unsure words are marked on the page', nUnsure === expected && expected >= 2, `${nUnsure} marked, ${expected} below 0.6`);
  {
    check('digital: the panel offers to check them', await b.eval(`document.querySelector('.todo.soft')?.textContent.includes('${expected} kata')`));
    await b.eval(`document.querySelector('.todo.soft').click()`);
    await b.waitFor(`document.querySelector('.esh-t[contenteditable=true]')`, 5000);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 400));
    const left = await b.eval(`studio.sheet.pages[0].text.filter(t => t.conf < 0.6).length`);
    check('digital: Enter confirms a word and opens the next', left === expected - 1 && (left === 0 || await b.eval(`!!document.querySelector('.esh-t[contenteditable=true]')`)), `${expected} -> ${left}`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }

  // ---- 3. the Studio sample, scanned (two pages)
  s = await importFile(scans['scan-kolam.pdf'].path, '?ocr=scan');
  const p1 = s.pages[0], p2 = s.pages[1];
  check('kolam scan: both pages OCRed', s.pages.every((q) => q.stats.ocr && q.text.length > 15), s.pages.map((q) => q.text.length).join(' '));
  const lab = p1.fields.map((f) => f.label);
  check('kolam scan: identity blanks found (Nama, Kelas, Tanggal)', ['Nama', 'Kelas', 'Tanggal'].every((l) => lab.includes(l)), lab.join(', '));
  check('kolam scan: answers 1-3 found with prompts', [1, 2, 3].every((n) => p1.fields.some((f) => f.label === `Jawaban no. ${n}` && f.kind === 'textarea' && f.prompt)), lab.join(', '));
  check('kolam scan: the table rows on page 2', p2.fields.filter((f) => /Peran dalam ekosistem/.test(f.label)).length >= 3, p2.fields.map((f) => f.label).join(', '));
  st = await bgStats(0);
  check('kolam scan: bottom corners white, tilt corrected', st.corners[2] > 235 && st.corners[3] > 235 && Math.abs(st.residual) < 0.3, `${st.corners.join(' ')} residual ${st.residual}`);
  check('kolam scan: page 2 tilt measured', Math.abs(p2.stats.ocr.angle - scans['scan-kolam.pdf'].tilt[1]) < 0.4, `${scans['scan-kolam.pdf'].tilt[1]} -> ${p2.stats.ocr.angle}`);

  // ---- 4. born-digital: untouched
  await b.goto(BASE);
  await b.eval(`document.getElementById('sampleBtn').click()`);
  await b.waitFor(`!document.getElementById('editor').hidden && document.querySelector('.esh-sheet')?.dataset.ready`, 60000);
  s = await b.eval(`JSON.parse(JSON.stringify({ pages: studio.sheet.pages.map(p => ({ ocr: !!(p.stats && p.stats.ocr), n: p.fields.length, src: p.fields.map(f => f.source) })), fonts: Object.keys(studio.sheet.fonts) }))`);
  check('born-digital: no OCR, fields as before (21)', s.pages.every((q) => !q.ocr) && s.pages.reduce((n, q) => n + q.n, 0) === 21 && !s.fonts.includes('ocr'), JSON.stringify(s.pages.map((q) => q.n)));
  check('born-digital: needsOcr is false', await b.eval(`import('../sheet/ocr.js').then(m => m.needsOcr(studio.sheet))`) === false);

  // ---- 5. mixed: a digital page, then a scan
  s = await importFile(scans['mixed.pdf'].path, '?ocr=scan');
  check('mixed: the digital page is left alone', !s.pages[0].stats.ocr && s.pages[0].text.some((t) => /Halaman digital/.test(t.str)) && s.pages[0].text.every((t) => t.conf == null));
  check('mixed: the scanned page is OCRed', !!s.pages[1].stats.ocr && s.pages[1].fields.filter((f) => f.kind === 'choice').length === 4, s.pages[1].fields.length);
  check('mixed: field ids stay unique', new Set(s.pages.flatMap((q) => q.fields.map((f) => f.id))).size === s.pages.reduce((n, q) => n + q.fields.length, 0));

  check('no page errors', b.errors.length === 0, b.errors.join(' | '));
} catch (e) {
  console.log('FAIL  suite crashed: ' + (e && e.stack || e));
  failed++;
} finally {
  await b.close();
  srv.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log('\nTimings:\n  ' + timings.join('\n  '));
console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} OCR checks passed`);
process.exit(failed ? 1 : 0);
