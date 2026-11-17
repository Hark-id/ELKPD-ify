/* Verifies the auto-growing answer fields:
   an empty box sits at its --min-h floor, a long multi-line answer grows
   the box without clipping, clearing restores the floor, and a narrowed
   viewport re-grows via the debounced resize path. */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from './helpers.mjs';

const CHROME = findChrome();

const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'cdp-autogrow-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9510', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try { const l = await (await fetch('http://127.0.0.1:9510/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: 997000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'A' } }));
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr, ms = 10000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => ({ TIMEOUT: true })),
  ]);
  if (r && r.TIMEOUT) throw new Error('timed out');
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 250));
  return r.result.result.value;
};
let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

await send('Page.enable');
await send('Runtime.enable');

await send('Page.navigate', { url: LIVE });
await sleep(2500);
await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.status)`);
await ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Autogrow T')}catch(e){}`);
await send('Page.navigate', { url: LIVE });
await sleep(4200);

/* Long multi-line Indonesian answer, built in-page so quoting stays simple. */
const FILL = `(function(){
  var lines = [];
  for (var i = 0; i < 8; i++) lines.push('Baris ' + (i + 1) + ': jawaban panjang untuk menguji pertumbuhan tinggi kotak jawaban secara otomatis tanpa memotong teks.');
  return lines.join('\\n');
})()`;
const type = `document.querySelectorAll('textarea')[0].value = ${FILL};
                document.querySelectorAll('textarea')[0].dispatchEvent(new Event('input', {bubbles:true}));`;
const clear = `var t = document.querySelectorAll('textarea')[0];
               t.value = '';
               t.dispatchEvent(new Event('input', {bubbles:true}));`;

/* ---- A1: we are really on the sheet ---- */
const count = await ev(`document.querySelectorAll('textarea').length`);
check('A1: answer fields present', count >= 10, 'textareas=' + count);

/* ---- A2: empty box sits at its --min-h floor ----
   Suites run against a shared live deployment, so the room may hold a
   saved answer from a previous run. Clear the field first (exactly as
   A4 does) so the floor measurement is independent of room state. */
await ev(clear);
await sleep(300);
const emptyBox = JSON.parse(await ev(`JSON.stringify((function(){
  var t = document.querySelectorAll('textarea')[0];
  var min = parseFloat(getComputedStyle(t).getPropertyValue('--min-h')) || 70;
  return { min: min, h: t.offsetHeight };
})())`));
check('A2: cleared box sits at the --min-h floor',
  emptyBox.h >= emptyBox.min - 2 && emptyBox.h <= emptyBox.min + 8,
  'h=' + emptyBox.h + ' min=' + emptyBox.min);

/* ---- A3: long multi-line answer grows the box without clipping ---- */
const before = await ev(`document.querySelectorAll('textarea')[0].offsetHeight`);
await ev(type);
await sleep(300);
const grown = JSON.parse(await ev(`JSON.stringify((function(){
  var t = document.querySelectorAll('textarea')[0];
  return { h: t.offsetHeight, scroll: t.scrollHeight };
})())`));
check('A3: long answer grows the box', grown.h > before + 30, 'h ' + before + ' -> ' + grown.h);
check('A3: no clipping after growth', grown.h >= grown.scroll - 1, 'h=' + grown.h + ' scroll=' + grown.scroll);

/* ---- A4: clearing restores the floor ---- */
await ev(clear);
await sleep(300);
const cleared = await ev(`document.querySelectorAll('textarea')[0].offsetHeight`);
check('A4: clearing restores the --min-h floor',
  cleared >= emptyBox.min - 2 && cleared <= emptyBox.min + 8, 'h=' + cleared + ' min=' + emptyBox.min);

/* ---- A5: narrowed viewport re-grows via the debounced resize path ---- */
await ev(type);
await sleep(300);
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await sleep(900); /* debounce is 120ms; give layout plenty */
  const narrow = JSON.parse(await ev(`JSON.stringify((function(){
    var t = document.querySelectorAll('textarea')[0];
    return { h: t.offsetHeight, scroll: t.scrollHeight };
  })())`));
  check('A5: narrow viewport keeps the answer unclipped', narrow.h >= narrow.scroll - 1, 'h=' + narrow.h + ' scroll=' + narrow.scroll);
} finally {
  await send('Emulation.clearDeviceMetricsOverride');
}

check('A6: no page exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

chrome.kill();
console.log(failures === 0 ? 'ALL AUTOGROW CHECKS PASSED' : failures + ' AUTOGROW CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
