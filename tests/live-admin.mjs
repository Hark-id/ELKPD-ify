/* Live E2E: admin console, reporting, avatars, mandated naming, reverse logout. */
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
const dir = mkdtempSync(join(tmpdir(), 'cdp-live-admin-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9430', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try { const l = await (await fetch('http://127.0.0.1:9430/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const dialogs = []; const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message.slice(0, 50));
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
await send('Runtime.enable');
await send('Network.enable');
await send('Page.navigate', { url: LIVE });
await sleep(2400);
await ev(`document.fonts ? document.fonts.ready.then(()=>1) : 1`);
await sleep(600);

/* --- A: a real room session with the mandated naming --- */
await ev(`document.getElementById('code').value = 'DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(3500);
const nm = JSON.parse(await ev(`JSON.stringify({
  ncHidden: document.getElementById('name-card').hidden,
  hasField: !!document.getElementById('nc-name')
})`));
check('A: naming stage reached', nm.ncHidden === false && nm.hasErrorCheck === undefined);
/* mandated: empty submit must NOT proceed */
await ev(`document.getElementById('nc-name').value = ''`);
await ev(`document.getElementById('name-form').dispatchEvent(new Event('submit', {cancelable:true}))`);
await sleep(300);
const mand = JSON.parse(await ev(`JSON.stringify({
  stillHere: !document.getElementById('name-card').hidden,
  errShown: !document.getElementById('nc-err').hidden,
  errClass: document.getElementById('nc-field').classList.contains('nc-error'),
  saved: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom')
})`));
check('A: empty name rejected (mandated)', mand.stillHere && mand.errShown && mand.errClass && mand.saved === null, JSON.stringify(mand));
await ev(`document.getElementById('nc-name').value = 'Uji Nama'`);
await ev(`document.getElementById('name-form').dispatchEvent(new Event('submit', {cancelable:true}))`);
await sleep(1600);
const room = JSON.parse(await ev(`JSON.stringify({
  bar: !!document.querySelector('.tool-dock'),
  mainOp: getComputedStyle(document.querySelector('main')).opacity,
  saved: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom')
})`));
check('A: entered the room after a valid name', room.bar && parseFloat(room.mainOp) > 0.99 && room.saved === 'Uji Nama', JSON.stringify(room));

/* --- B: report the room from the Lainnya menu --- */
await ev(`document.getElementById('moreBtn').click()`);
await sleep(150);
const menuOpen = await ev(`!document.getElementById('dockMenu').hidden`);
check('B: Lainnya menu opens', menuOpen === true);
await ev(`document.getElementById('reportBtn').click()`);
await sleep(400); /* confirm dialog auto-accepted */
await sleep(600);
const rep = await ev(`(async()=>{
  const r = await fetch('/api/admin/list', {method:'POST'});
  return JSON.stringify({status: r.status, body: await r.text()});
})()`);
const repObj = JSON.parse(rep);
check('B: report API blocked for non-admin (401-ish)', repObj.status >= 400, rep.slice(0, 90));

/* --- C: avatars render --- */
const av = await ev(`(function(){
  const list = document.getElementById('peerList');
  const a = list.querySelector('.peer-avatar');
  const s = list.querySelector('.peer-status');
  return JSON.stringify({chips: list.children.length, avatar: a ? a.textContent : null, status: !!s});
})()`);
const avO = JSON.parse(av);
check('C: avatar with initial + corner status', avO.chips >= 1 && !!avO.avatar && avO.status, av);

/* --- D: reverse logout motion --- */
const handoffPre = await ev(`sessionStorage.getItem('lkpd-handoff')`);
await ev(`document.getElementById('leaveBtn').click()`);
await sleep(300);
const midD = JSON.parse(await ev(`(function(){
  const b = document.querySelector('.tool-dock');
  const r = b.getBoundingClientRect();
  const v = document.getElementById('morph-veil');
  return JSON.stringify({l:Math.round(r.left), t:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height),
    veil: v && !v.hidden ? Math.round(getComputedStyle(v).opacity*100)/100 : 'hidden'});
})()`));
check('D: bar flying back to a card + veil rising', midD.w < 1227 && midD.w > 200 && midD.h > 60 && midD.veil !== 'hidden', JSON.stringify(midD));
await sleep(1200);
const afterD = JSON.parse(await ev(`JSON.stringify({
  onGate: !!document.getElementById('btn-join'),
  handoff: sessionStorage.getItem('lkpd-handoff'),
  cardW: Math.round(document.querySelector('.card').getBoundingClientRect().width),
  nameCleared: localStorage.getItem('lkpd-cerpen-name:diag-diagnosticroom')
})`));
check('D: gate received the card', afterD.onGate && afterD.cardW === 430 && afterD.nameCleared === null, JSON.stringify(afterD));

/* --- E: admin console --- */
await ev(`document.getElementById('code').value = ADMIN_CODE`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(2600);
const adm = JSON.parse(await ev(`JSON.stringify({
  isAdminPage: !!document.getElementById('rooms'),
  h1: document.querySelector('h1') ? document.querySelector('h1').textContent : null
})`));
check('E: admin console served', adm.isAdminPage && adm.h1 === 'Konsol Admin', JSON.stringify(adm));
await sleep(900);
const list = JSON.parse(await ev(`JSON.stringify((function(){
  const cards = Array.from(document.querySelectorAll('.room'));
  const diag = cards.find(c => c.querySelector('.room-code').textContent === 'DIAGNOSTICROOM');
  return {rooms: cards.length, found: !!diag, badge: diag ? !!diag.querySelector('.badge') : false,
          label: diag ? diag.querySelector('.room-label').textContent : null};
})())`));
check('E: rooms listed with codes', list.rooms >= 1, list.rooms + ' rooms');
check('E: DIAGNOSTICROOM shows the report badge', list.found && list.badge, JSON.stringify(list));
await shot('adm-1-console.png');
/* open the DIAGNOSTICROOM card's detail */
await ev(`(function(){
  const cards = Array.from(document.querySelectorAll('.room'));
  const diag = cards.find(c => c.querySelector('.room-code').textContent === 'DIAGNOSTICROOM');
  diag.querySelector('.room-head').click();
  return 1;
})()`);
await sleep(900);
const det = JSON.parse(await ev(`JSON.stringify((function(){
  const d = document.querySelector('.room.open .detail');
  return {open: !!d, acts: d ? d.querySelectorAll('.acts button').length : 0, note: d ? d.querySelector('.note').textContent.slice(0,40) : ''};
})())`));
check('E: room detail with actions', det.open && det.acts >= 2, JSON.stringify(det));
/* clear the report */
const cleared = await ev(`(function(){
  const btns = document.querySelectorAll('.room.open .acts button');
  let n = 0;
  for (const b of btns) if (b.textContent === 'Hapus laporan') { b.click(); n++; }
  return n;
})()`);
await sleep(900);
const badgeGone = JSON.parse(await ev(`JSON.stringify((function(){
  const cards = Array.from(document.querySelectorAll('.room'));
  const diag = cards.find(c => c.querySelector('.room-code').textContent === 'DIAGNOSTICROOM');
  return {badge: diag ? !!diag.querySelector('.badge') : 'gone'};
})())`));
check('E: report cleared from the console', cleared >= 1 && (badgeGone.badge === false || badgeGone.badge === 'gone'), 'clicked=' + cleared + ' ' + JSON.stringify(badgeGone));

/* --- F: admin session cannot open rooms or ws --- */
const guard = await ev(`(async()=>{
  const wsTry = await fetch('/ws', {headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13'}});
  return JSON.stringify({ws: wsTry.status});
})()`);
check('F: admin session denied the websocket', JSON.parse(guard).ws === 401, guard);
check('Z: no page exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

console.log('dialogs:', dialogs.length ? dialogs : 'none');
chrome.kill();
console.log(failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
