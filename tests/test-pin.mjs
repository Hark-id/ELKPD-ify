/* Regression for the hover→click pin bug: clicking a hover-opened menu
   must PIN it, and a second click must fold it. */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from './helpers.mjs';

const CHROME = findChrome();

const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'pin-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9700', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 50; i++) { await sleep(200); try { const l = await (await fetch('http://127.0.0.1:9700/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const errs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 993000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'P' } }));
  if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 180));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result.result.value;
};
let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

await send('Page.enable');
await send('Runtime.enable');
/* the hover path only exists on real hover/fine-pointer desktops */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }] });

await send('Page.navigate', { url: LIVE });
await sleep(2600);
await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.status)`);
await ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Pin Test')}catch(e){}`);
await send('Page.navigate', { url: LIVE });
await sleep(4200);

const state = async () => JSON.parse(await ev(`JSON.stringify((function(){
  var m=document.getElementById('dockMenu');
  return {hidden:m.hidden, expanded:document.getElementById('moreBtn').getAttribute('aria-expanded'),
          h:Math.round(m.getBoundingClientRect().height)};
})())`));

/* --- 0: starts folded --- */
const s0 = await state();
check('P0: starts folded', s0.hidden === true, JSON.stringify(s0));

/* --- 1: HOVER opens (preview) --- */
await ev(`document.getElementById('moreBtn').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}))`);
await sleep(420);
const s1 = await state();
check('P1: hover lowers the menu', s1.hidden === false && s1.h > 40, JSON.stringify(s1));

/* --- 2: CLICK while hover-open must PIN (the reported bug) --- */
await ev(`document.getElementById('moreBtn').click()`);
await sleep(120);
const s2 = await state();
console.log('after click on hover-opened:', JSON.stringify(s2));
check('P2: click on a hover-opened menu keeps it OPEN', s2.hidden === false && s2.h > 40, JSON.stringify(s2));
check('P2: and marks it expanded', s2.expanded === 'true', String(s2.expanded));

/* --- 3: leaving must NOT fold a pinned menu --- */
await ev(`document.getElementById('moreBtn').dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}))`);
await sleep(500);
const s3 = await state();
check('P3: pointer-leave does not fold a pinned menu', s3.hidden === false, JSON.stringify(s3));

/* --- 4: a second click folds it --- */
await ev(`document.getElementById('moreBtn').click()`);
await sleep(420);
const s4 = await state();
check('P4: second click folds it away', s4.hidden === true && s4.expanded === 'false', JSON.stringify(s4));

/* --- 5: closing from the closed state is a no-op, then hover+click still pins --- */
await ev(`document.getElementById('moreBtn').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}))`);
await sleep(420);
await ev(`document.getElementById('moreBtn').click()`);
await sleep(120);
const s5 = await state();
check('P5: repeat hover→click pins again (not flaky)', s5.hidden === false, JSON.stringify(s5));

/* --- 6: leaving folds it when it was only a preview --- */
await ev(`document.getElementById('moreBtn').click()`);  /* unpin */
await sleep(420);
await ev(`document.getElementById('moreBtn').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}))`);
await sleep(420);
await ev(`document.getElementById('moreBtn').dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}))`);
await sleep(520);
const s6 = await state();
check('P6: an unpinned hover preview still folds on leave', s6.hidden === true, JSON.stringify(s6));

check('P7: no exceptions', errs.length === 0, errs.slice(0, 2).join(' | '));

chrome.kill();
console.log(failures === 0 ? '\nALL PIN CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
