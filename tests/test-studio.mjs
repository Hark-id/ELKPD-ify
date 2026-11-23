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
  check('the dragged field is selected in the inspector', await b.eval(`document.querySelector('.insp h2').textContent.startsWith('2. Jelaskan')`));

  // ---- rename + change kind through the inspector
  await b.eval(`(() => { const i = document.querySelector('.insp input[type=text]'); i.value = 'Pengaruh sinar matahari'; i.dispatchEvent(new Event('change')); })()`);
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

  // ---- preview: reflow pushes later content down
  await b.eval(`document.querySelector('[data-mode=preview]').click()`);
  await b.waitFor(`document.querySelector('.canvas.preview .esh-sheet')?.dataset.ready`);
  const before = await b.eval(`(() => { const t = [...document.querySelectorAll('.esh-t')].find(e => e.textContent.startsWith('3. Gambarkan')); return [t.getBoundingClientRect().top, document.querySelector('.esh-page').offsetHeight]; })()`);
  await b.eval(`(() => { const t = document.getElementById('p1-f6'); t.focus(); t.value = 'Sinar matahari membantu tumbuhan air berfotosintesis. '.repeat(10); t.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const after = await b.eval(`(() => { const t = [...document.querySelectorAll('.esh-t')].find(e => e.textContent.startsWith('3. Gambarkan')); return [t.getBoundingClientRect().top, document.querySelector('.esh-page').offsetHeight]; })()`);
  check('a long answer pushes the next question down', after[0] - before[0] > 40, `${Math.round(before[0])} -> ${Math.round(after[0])}`);
  check('the page grows by the same amount', Math.abs((after[1] - before[1]) * 1.35 - (after[0] - before[0])) < 3, `${before[1]} -> ${after[1]}`);
  check('answer counter updates live', await b.eval(`document.querySelector('.insp .stat b').textContent`) === '1');

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
