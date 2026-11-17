/* Live E2E for the naming stage on pages.dev (fresh profile):
   login → name card → submit → bar; logout; login again → straight to bar. */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'cdp-live-name-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9420', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try { const l = await (await fetch('http://127.0.0.1:9420/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const dialogs = []; const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message.slice(0, 40));
    ws.send(JSON.stringify({ id: 999000 + dialogs.length, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Uji Nama' } }));
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr, ms = 9000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => ({ TIMEOUT: true })),
  ]);
  if (r && r.TIMEOUT) throw new Error('evaluate timed out: ' + expr.slice(0, 60));
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(name, Buffer.from(r.result.data, 'base64'));
};
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
};

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: LIVE });
await sleep(2400);
await ev(`document.fonts ? document.fonts.ready.then(()=>1) : 1`);
await sleep(600);

/* first login: no saved name → naming stage */
await ev(`document.getElementById('code').value = 'DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(3500); /* morph → navigation → worksheet parse */

const st1 = JSON.parse(await ev(`JSON.stringify({
  path: location.pathname,
  handoffStage: (function(){try{return JSON.parse(sessionStorage.getItem('lkpd-handoff')||'null')}catch(e){return 'err'}})(),
  ncHidden: document.getElementById('name-card') ? document.getElementById('name-card').hidden : 'no-el',
  nc: (function(){const n=document.getElementById('name-card');if(!n||n.hidden)return null;const r=n.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})(),
  veilShown: document.getElementById('morph-veil') && !document.getElementById('morph-veil').hidden,
  barVis: getComputedStyle(document.querySelector('.tool-dock')).visibility,
  eyebrow: document.querySelector('#name-card .nc-eyebrow') ? document.querySelector('#name-card .nc-eyebrow').textContent : null,
  savedBefore: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom')
})`));
console.log('stage 1 state:', JSON.stringify(st1));
check('L1: landed on the naming stage', st1.handoffStage && st1.handoffStage.stage === 'name', JSON.stringify(st1.handoffStage));
check('L1: name card shown over the veil', st1.ncHidden === false && st1.veilShown === true && st1.barVis === 'hidden');
check('L1: name card carries the room label', st1.eyebrow === 'Ruang Diagnostik', String(st1.eyebrow));
check('L1: no name saved yet', st1.savedBefore === null || st1.savedBefore === undefined, String(st1.savedBefore));
await shot('nc-1-name-card.png');

/* submit the name → second flight into the bar */
await ev(`document.getElementById('nc-name').value = 'Uji Nama'`);
await ev(`document.getElementById('name-form').dispatchEvent(new Event('submit', {cancelable:true}))`);
await sleep(1400);
const st2 = JSON.parse(await ev(`JSON.stringify({
  ncHidden: document.getElementById('name-card').hidden,
  veilShown: document.getElementById('morph-veil') && !document.getElementById('morph-veil').hidden,
  classes: document.documentElement.className,
  bar: (function(){const b=document.querySelector('.tool-dock');const r=b.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),v:getComputedStyle(b).visibility};})(),
  saved: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom'),
  mainOp: getComputedStyle(document.querySelector('main')).opacity
})`));
console.log('stage 2 state:', JSON.stringify(st2));
check('L2: name saved', st2.saved === 'Uji Nama', String(st2.saved));
check('L2: name card gone, bar at rest', st2.ncHidden === true && st2.bar.v === 'visible' && st2.bar.l === 10 && st2.bar.t === 10 && st2.bar.h === 60, JSON.stringify(st2.bar));
check('L2: veil cleared, document revealed', st2.veilShown === false && parseFloat(st2.mainOp) > 0.99, `classes=${st2.classes}`);
await shot('nc-2-bar.png');

/* logout wipes the saved name (shared-browser privacy) — then a login
   with an EXPIRED SESSION but intact storage (cookies cleared only)
   must skip the naming stage and land straight on the bar */
await ev(`document.getElementById('leaveBtn').click()`);
await sleep(2200);
const st3a = JSON.parse(await ev(`JSON.stringify({
  onGate: location.pathname === '/' && !!document.getElementById('btn-join'),
  savedAfterLogout: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom')
})`));
check('L3a: back on the gate after logout', st3a.onGate === true);
check('L3a: logout wiped the saved name (privacy)', st3a.savedAfterLogout === null, String(st3a.savedAfterLogout));

/* simulate session expiry: clear cookies, keep localStorage */
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: LIVE });
await sleep(2400);
await ev(`document.fonts ? document.fonts.ready.then(()=>1) : 1`);
/* re-seed the name as if it had survived a session expiry */
await ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Uji Nama')}catch(e){}`);
await ev(`document.getElementById('code').value = 'DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(3500);
const st3 = JSON.parse(await ev(`JSON.stringify({
  ncHidden: document.getElementById('name-card') ? document.getElementById('name-card').hidden : 'no-el',
  handoffStage: (function(){try{const v=sessionStorage.getItem('lkpd-handoff');return v?JSON.parse(v).stage:'(cleared)'}catch(e){return 'err'}})(),
  bar: (function(){const b=document.querySelector('.tool-dock');const r=b.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})(),
  saved: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom'),
  mainOp: getComputedStyle(document.querySelector('main')).opacity
})`));
console.log('stage 3 state:', JSON.stringify(st3));
check('L3b: returning user skips the naming stage', st3.ncHidden === true && (st3.handoffStage === 'bar' || st3.handoffStage === '(cleared)'), `ncHidden=${st3.ncHidden} stage=${st3.handoffStage}`);
check('L3b: bar landed directly', st3.bar.l === 10 && st3.bar.t === 10 && st3.bar.h === 60, JSON.stringify(st3.bar));
check('L3b: name kept', st3.saved === 'Uji Nama', String(st3.saved));
check('L3b: document revealed', parseFloat(st3.mainOp) > 0.99, `op=${st3.mainOp}`);
await shot('nc-3-return.png');

console.log('dialogs:', dialogs.length ? dialogs : 'none', '| exceptions:', exceptions.length ? exceptions : 'none');
chrome.kill();
console.log(failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
