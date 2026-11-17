/* Mobile (390px) compatibility pass over every new surface. */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from './helpers.mjs';

const CHROME = findChrome();

/* The admin code is a SECRET. Never hardcode it: set ELKPD_ADMIN_CODE
   in your environment. The fallback is deliberately invalid. */
const ADMIN_CODE = process.env.ELKPD_ADMIN_CODE || 'ADMIN-NOT-SET';

const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'cdp-mobile-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9440', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try { const l = await (await fetch('http://127.0.0.1:9440/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const dialogs = []; const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message.slice(0, 40));
    ws.send(JSON.stringify({ id: 999000 + dialogs.length, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Uji Mobile' } }));
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
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: LIVE });
await sleep(2400);
await ev(`document.fonts ? document.fonts.ready.then(()=>1) : 1`);
await sleep(600);

const gate = JSON.parse(await ev(`JSON.stringify({
  cw: document.documentElement.clientWidth,
  card: (function(){const r=document.querySelector('.card').getBoundingClientRect();return {l:Math.round(r.left),w:Math.round(r.width)};})(),
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
})`));
check('M-gate: no horizontal overflow', gate.hScroll === false, JSON.stringify(gate));

/* login → name card (clamped to the 390px viewport) */
await ev(`document.getElementById('code').value = 'DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(3500);
const nm = JSON.parse(await ev(`JSON.stringify({
  cw: document.documentElement.clientWidth,
  ncHidden: document.getElementById('name-card').hidden,
  nc: (function(){const r=document.getElementById('name-card').getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width)};})(),
  fieldBottom: Math.round(document.querySelector('.nc-field').getBoundingClientRect().bottom),
  vh: document.documentElement.clientHeight
})`));
check('M-name: card clamped to viewport', nm.ncHidden === false && nm.nc.w <= nm.cw - 20 && nm.nc.l >= 10, JSON.stringify(nm));
check('M-name: field in the upper half (keyboard-safe)', nm.fieldBottom < nm.vh * 0.55, `bottom=${nm.fieldBottom} of ${nm.vh}`);
await shot('m-1-name-card.png');
await ev(`document.getElementById('nc-name').value = 'Uji Mobile'`);
await ev(`document.getElementById('name-form').dispatchEvent(new Event('submit', {cancelable:true}))`);
await sleep(1600);

/* worksheet bar at 390px */
const bar = JSON.parse(await ev(`JSON.stringify({
  cw: document.documentElement.clientWidth,
  barScroll: (function(){const b=document.querySelector('.tool-dock');return {sw:b.scrollWidth, cw:b.clientWidth};})(),
  chipLbl: getComputedStyle(document.querySelector('.room-chip .lbl')).display,
  peerName: (function(){const n=document.querySelector('.peer-name');return n?getComputedStyle(n).display:'no-peer';})(),
  avatar: (function(){const a=document.querySelector('.peer-avatar');if(!a)return null;const r=a.getBoundingClientRect();return Math.round(r.width);})(),
  moreHidden: (function(){const b=document.getElementById('moreBtn');return b.getBoundingClientRect().width === 0;})(),
  fab: (function(){const f=document.getElementById('optionsFab');const r=f.getBoundingClientRect();return r.width > 0 ? {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),rgt:Math.round(r.right),bot:Math.round(r.bottom),vh:document.documentElement.clientHeight} : null;})(),
  docW: document.documentElement.scrollWidth
})`));
check('M-bar: nothing overflows the bar (3px sub-pixel tolerance)', bar.barScroll.sw <= bar.barScroll.cw + 3, JSON.stringify(bar.barScroll));
check('M-bar: chip shows code only', bar.chipLbl === 'none');
check('M-bar: peers are avatar-only', bar.peerName === 'none' && bar.avatar === 22, `avatar=${bar.avatar}`);
check('M-bar: Lainnya replaced by the FAB', bar.moreHidden === true && !!bar.fab, JSON.stringify(bar.fab));
check('M-bar: FAB inside the viewport at thumb reach', bar.fab && bar.fab.w === 56 && bar.fab.rgt <= bar.cw - 10 && bar.fab.bot <= bar.fab.vh, JSON.stringify(bar.fab));
check('M-page: no horizontal page overflow', bar.docW <= bar.cw, `${bar.docW} vs ${bar.cw}`);
await shot('m-2-bar.png');

/* the FAB opens the options menu above it */
await ev(`document.getElementById('optionsFab').click()`);
await sleep(200);
const menu = JSON.parse(await ev(`JSON.stringify((function(){
  const m = document.getElementById('dockMenu');
  const r = m.getBoundingClientRect();
  const f = document.getElementById('optionsFab').getBoundingClientRect();
  return {hidden: m.hidden, l: Math.round(r.left), rgt: Math.round(r.right), bot: Math.round(r.bottom),
          fabTop: Math.round(f.top), items: m.querySelectorAll('button').length};
})())`));
check('M-menu: opens fully inside the viewport', menu.hidden === false && menu.l >= 0 && menu.rgt <= bar.cw, JSON.stringify(menu));
check('M-menu: anchored above the FAB', menu.bot <= menu.fabTop + 2, JSON.stringify(menu));
check('M-menu: three actions available', menu.items === 3, String(menu.items));
await shot('m-3-menu.png');
await ev(`document.body.click()`);
await sleep(420);  /* the fold-up animation runs ~190ms before hiding */
const menuClosed = await ev(`document.getElementById('dockMenu').hidden`);
check('M-menu: outside tap closes it', menuClosed === true);

/* reverse logout at mobile size */
await ev(`document.getElementById('leaveBtn').click()`);
await sleep(300);
const rev = JSON.parse(await ev(`JSON.stringify((function(){
  const b = document.querySelector('.tool-dock');
  const r = b.getBoundingClientRect();
  return {w: Math.round(r.width), h: Math.round(r.height)};
})())`));
check('M-logout: reverse flight running', rev.w < 1227 && rev.w > 200, JSON.stringify(rev));
await sleep(1300);
const back = JSON.parse(await ev(`JSON.stringify({
  onGate: !!document.getElementById('btn-join'),
  cardW: Math.round(document.querySelector('.card').getBoundingClientRect().width),
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
})`));
check('M-logout: gate card restored, no overflow', back.onGate && back.cardW <= 390 && back.hScroll === false, JSON.stringify(back));

/* keyboard-zone name card on a short viewport (640px) */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 2.625, mobile: true });
await sleep(300);
await ev(`document.getElementById('code').value = 'DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(3500);
const nmShort = JSON.parse(await ev(`JSON.stringify({
  ncHidden: document.getElementById('name-card').hidden,
  t: Math.round(document.getElementById('name-card').getBoundingClientRect().top),
  vh: document.documentElement.clientHeight
})`));
check('M-short: name card moved above the keyboard zone', nmShort.ncHidden === false && Math.abs(nmShort.t - Math.round((nmShort.vh - 240) * 0.30)) <= 3, JSON.stringify(nmShort));

/* admin console at 390px — finish the pending naming stage first,
   then log out cleanly so the gate is reachable */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true });
await sleep(300);
await ev(`document.getElementById('nc-name').value = 'Uji Mobile'`);
await ev(`document.getElementById('name-form').dispatchEvent(new Event('submit', {cancelable:true}))`);
await sleep(1500);
await ev(`fetch('/api/logout', {method:'POST'}).then(()=>location.reload())`);
await sleep(2200);
await ev(`document.getElementById('code').value = ADMIN_CODE`);
await ev(`document.getElementById('btn-join').click()`);
/* the admin login now passes through the loading square (~650ms morph
   + the response), so allow for the full choreography */
await sleep(4200);
const adm = JSON.parse(await ev(`JSON.stringify({
  isAdmin: !!document.getElementById('rooms'),
  roomCards: document.querySelectorAll('.room').length,
  headRight: Math.round(document.querySelector('.head-actions').getBoundingClientRect().right),
  cw: document.documentElement.clientWidth,
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
})`));
check('M-admin: console fits 390px', adm.isAdmin && adm.headRight <= adm.cw && adm.hScroll === false, JSON.stringify(adm));
await shot('m-4-admin.png');
check('M-final: no exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

console.log('dialogs:', dialogs.length ? dialogs : 'none');
chrome.kill();
console.log(failures === 0 ? 'ALL MOBILE CHECKS PASSED' : failures + ' MOBILE CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
