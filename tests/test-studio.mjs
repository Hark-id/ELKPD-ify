/* The Studio end to end, against a local server (no deployment needed):
 * sample PDF -> import -> edit fields with the mouse -> undo -> preview
 * reflow -> standalone .html export that works offline and keeps answers.
 * pdf.js comes from the jsDelivr CDN, so this needs network.
 *
 *   node tests/test-studio.mjs                                         */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { startServer } from '../scripts/dev-studio.mjs';

const PORT = 8840 + Math.floor(Math.random() * 100);
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  (' + extra + ')' : ''}`); if (!ok) failed++; };

const srv = await startServer(PORT);
const b = await launch({ width: 1440, height: 900 });
const tmp = mkdtempSync(join(tmpdir(), 'elkpd-studio-'));
const mouse = async (type, x, y) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const drag = async (x0, y0, x1, y1) => {
  await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0);
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', x0 + ((x1 - x0) * k) / 5, y0 + ((y1 - y0) * k) / 5);
  await mouse('mouseReleased', x1, y1);
};
const rectOf = (sel) => b.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

try {
  await b.goto(`http://127.0.0.1:${PORT}/src/studio/`);
  check('start screen shows the drop zone', await b.eval(`!document.getElementById('start').hidden`));

  // ---- import the sample
  await b.eval(`document.getElementById('sampleBtn').click()`);
  await b.waitFor(`!document.getElementById('editor').hidden && document.querySelector('.esh-sheet')?.dataset.ready`, 60000);
  const boxes = await b.eval(`document.querySelectorAll('.st-fb').length`);
  check('sample imports with 21 answer boxes', boxes === 21, boxes);
  const imgs = await b.eval(`studio.sheet.pages.map(p => [p.stats.images, (p.unsupported || {}).undecodedImage || 0])`);
  check('images survive a browser import (none dropped)', imgs.every(([n]) => n >= 1) && imgs.every(([, lost]) => lost === 0), JSON.stringify(imgs));
  check('inspector lists the fields', await b.eval(`document.querySelectorAll('.flist li').length`) === 21);
  const fit = await b.eval(`[...document.querySelectorAll('.esh-t')].map(e => +(/scaleX\\(([\\d.]+)\\)/.exec(e.style.transform)||[0,1])[1])`);
  check('text fitted against the loaded web fonts (|scaleX-1| < 0.12 for most runs)', fit.filter((k) => Math.abs(k - 1) < 0.12).length >= fit.length * 0.8, fit.map((k) => k.toFixed(2)).join(' '));

  // ---- select + move a field with the mouse
  const sel = '.st-fb[data-id="p1-f6"]';
  const r0 = await rectOf(sel);
  const y0 = await b.eval(`studio.sheet.pages[0].fields.find(f => f.id === 'p1-f6').y`);
  await drag(r0.x + 30, r0.y + 20, r0.x + 30, r0.y + 47);
  const y1 = await b.eval(`studio.sheet.pages[0].fields.find(f => f.id === 'p1-f6').y`);
  check('dragging a field moves it (27px at 135% = 20pt)', Math.abs(y1 - y0 - 20) < 1.5, `${y0} -> ${y1}`);
  check('the dragged field is selected in the inspector', await b.eval(`document.querySelector('.insp .name-input').value.startsWith('2. Jelaskan')`));

  // ---- rename + change kind through the inspector
  await b.eval(`(() => { const i = document.querySelector('.insp .name-input'); i.value = 'Pengaruh sinar matahari'; i.dispatchEvent(new Event('change')); })()`);
  check('renaming updates the sheet', await b.eval(`studio.sheet.pages[0].fields.find(f => f.id === 'p1-f6').label`) === 'Pengaruh sinar matahari');

  // ---- undo twice restores position
  await b.eval(`document.getElementById('undoBtn').click(); document.getElementById('undoBtn').click()`);
  const y2 = await b.eval(`studio.sheet.pages[0].fields.find(f => f.id === 'p1-f6').y`);
  check('undo restores the original position', Math.abs(y2 - y0) < 0.01, y2);

  // ---- draw a new field
  await b.eval(`document.getElementById('addTool').click()`);
  const pg = await rectOf('.esh-page');
  await drag(pg.x + 100, pg.y + 380, pg.x + 400, pg.y + 440);
  const added = await b.eval(`studio.sheet.pages[0].fields.filter(f => f.source === 'manual').map(f => [f.kind, Math.round(f.w)])`);
  check('drawing adds a textarea of the drawn size', added.length === 1 && added[0][0] === 'textarea' && Math.abs(added[0][1] - 222) < 3, JSON.stringify(added));
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  check('Delete removes the selected field', await b.eval(`studio.sheet.pages[0].fields.filter(f => f.source === 'manual').length`) === 0);

  // ---- pages: delete + undo, move
  await b.eval(`[...document.querySelectorAll('.pg-bar button')].find(x => x.getAttribute('aria-label') === 'Hapus halaman 2').click()`);
  check('deleting a page removes it', await b.eval(`studio.sheet.pages.length`) === 1 && await b.eval(`document.querySelectorAll('.esh-page').length`) === 1);
  await b.eval(`document.getElementById('undoBtn').click()`);
  check('undo brings the page back with its fields', await b.eval(`studio.sheet.pages.length === 2 && studio.sheet.pages[1].fields.length === 14 && document.querySelectorAll('.esh-page').length === 2`));
  await b.eval(`[...document.querySelectorAll('.pg-bar button')].find(x => x.getAttribute('aria-label') === 'Turunkan halaman 1').click()`);
  check('moving a page reorders the sheet', await b.eval(`studio.sheet.pages.map(p => p.id).join()`) === 'p2,p1');
  await b.eval(`document.getElementById('undoBtn').click()`);

  // ---- naming flow: the to-do button and Enter walk through unnamed fields
  await b.eval(`(() => { const f = studio.sheet.pages[0].fields; f[1].label = ''; f[3].label = ''; document.querySelector('[data-mode=preview]').click(); document.querySelector('[data-mode=design]').click(); })()`);
  await b.waitFor(`document.querySelector('.canvas.design .esh-sheet')?.dataset.ready && document.querySelector('.todo')`);
  check('the panel says what is left to do', await b.eval(`document.querySelector('.todo').textContent.includes('2 isian')`));
  check('unnamed boxes are marked on the page', await b.eval(`document.querySelectorAll('.st-fb.unnamed').length`) === 2);
  await b.eval(`document.querySelector('.todo').click()`);
  await new Promise((r) => setTimeout(r, 100));
  const first = await b.eval(`studio.sheet.pages[0].fields[1].id`);
  check('the to-do button opens the first unnamed field', await b.eval(`document.querySelector('.st-fb.sel')?.dataset.id`) === first);
  await b.eval(`document.querySelector('.name-input').focus()`);
  await b.type('Kelas');
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 100));
  check('Enter names it and moves to the next unnamed field', await b.eval(`studio.sheet.pages[0].fields[1].label === 'Kelas' && document.querySelector('.st-fb.sel')?.dataset.id === studio.sheet.pages[0].fields[3].id && document.activeElement.classList.contains('name-input')`));
  await b.type('Nilai');
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 100));
  check('after the last one the list says all are named', await b.eval(`!document.querySelector('.st-fb.sel') && !!document.querySelector('.done-note')`));
  check('the mode pill sits under the selected segment', await b.eval(`(() => { const i = document.getElementById('segInd').getBoundingClientRect(), s = document.querySelector('[data-mode=design]').getBoundingClientRect(); return Math.abs(i.left - s.left) < 1 && Math.abs(i.width - s.width) < 1; })()`));

  // ---- phone: one column, the panel is a bottom sheet that opens on selection
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 600));
  check('phone: nothing wider than the screen', await b.eval(`document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390`));
  check('phone: the panel peeks at the bottom', await b.eval(`(() => { const r = document.getElementById('panel').getBoundingClientRect(); return r.top > 780 - 100 && r.top < 780; })()`));
  await b.eval(`(() => { const el = document.querySelector('.st-fb'); const r = el.getBoundingClientRect(); const o = { bubbles: true, button: 0, clientX: r.x + 3, clientY: r.y + 3 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); dispatchEvent(new PointerEvent('pointerup', o)); })()`);
  await new Promise((r) => setTimeout(r, 700));
  check('phone: selecting a field opens the sheet', await b.eval(`document.getElementById('panel').classList.contains('open') && document.getElementById('panel').getBoundingClientRect().top < 400`));
  await b.eval(`document.querySelector('.back').click(); document.getElementById('sheetHandle').click()`);
  await b.send('Emulation.clearDeviceMetricsOverride');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 400));

  // ---- preview: reflow pushes later content down
  await b.eval(`document.querySelector('[data-mode=preview]').click()`);
  await b.waitFor(`document.querySelector('.canvas.preview .esh-sheet')?.dataset.ready`);
  const before = await b.eval(`(() => { const t = [...document.querySelectorAll('.esh-t')].find(e => e.textContent.startsWith('3. Gambarkan')); return [t.getBoundingClientRect().top, document.querySelector('.esh-page').offsetHeight]; })()`);
  await b.eval(`(() => { const t = document.getElementById('p1-f6'); t.focus(); t.value = 'Sinar matahari membantu tumbuhan air berfotosintesis. '.repeat(10); t.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const after = await b.eval(`(() => { const t = [...document.querySelectorAll('.esh-t')].find(e => e.textContent.startsWith('3. Gambarkan')); return [t.getBoundingClientRect().top, document.querySelector('.esh-page').offsetHeight]; })()`);
  check('a long answer pushes the next question down', after[0] - before[0] > 40, `${Math.round(before[0])} -> ${Math.round(after[0])}`);
  check('the page grows by the same amount', Math.abs((after[1] - before[1]) * 1.35 - (after[0] - before[0])) < 3, `${before[1]} -> ${after[1]}`);
  check('preview gives the sheet the whole width (no panel)', await b.eval(`getComputedStyle(document.getElementById('panel')).display === 'none' && !document.getElementById('printBtn').hidden && document.getElementById('addTool').hidden`));

  // ---- standalone export
  const html = await b.eval(`import('./export.js').then(m => m.buildStandaloneHtml(studio.sheet))`);
  check('export inlines the player (no external module)', !/^\s*import\s/m.test(html) && html.includes('function createPlayer'));
  const file = join(tmp, 'lembar.html');
  writeFileSync(file, html);
  await b.goto('file://' + file);
  await b.waitFor(`document.querySelector('.esh-sheet')?.dataset.ready`, 20000);
  await b.eval(`(() => { const t = document.getElementById('p1-f1'); t.value = 'ikan, katak, ganggang'; t.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 500));
  await b.goto('file://' + file);
  await b.waitFor(`document.querySelector('.esh-sheet')?.dataset.ready`, 20000);
  check('exported sheet keeps answers across a reload', await b.eval(`document.getElementById('p1-f1').value`) === 'ikan, katak, ganggang');

  check('no page errors', b.errors.length === 0, b.errors.join(' | '));
} catch (e) {
  console.log('FAIL  suite crashed: ' + (e && e.stack || e));
  failed++;
} finally {
  await b.close();
  srv.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall studio checks passed');
process.exit(failed ? 1 : 0);
