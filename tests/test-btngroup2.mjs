/* Verifies the revised connected-button-group behaviour:
   - NO width/padding change on activation (connected group, not standard)
   - shape eases without overshoot, at 300ms
   - a SELECTED state HOLDS its round shape while the state is true,
     and only releases when the state ends
   - neighbours never animate */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from './helpers.mjs';

const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = mkdtempSync(join(tmpdir(), 'cg2-'));
const c = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=9790', `--user-data-dir=${d}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let t = null;
for (let i = 0; i < 50; i++) { await sleep(200); try { const l = await (await fetch('http://127.0.0.1:9790/json/list')).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch { } }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const h = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 985000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'CG2' } }));
  if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (me, p = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method: me, params: p })); });
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240)); return r.result.result.value; };
let failures = 0;
const check = (n, cond, d2 = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + n + (d2 ? '  — ' + d2 : '')); if (!cond) failures++; };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: LIVE });
await sleep(2600);
await ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','CG2')}catch(e){}`);
await ev(`document.getElementById('code').value='DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(6000);

const widths = async () => JSON.parse(await ev(`JSON.stringify(Array.prototype.map.call(
  document.querySelectorAll('.dock-panel > button'),
  function(b){ var r=b.getBoundingClientRect(); return {id:b.id||'cetak', w:+r.width.toFixed(2)}; }))`));

/* ---------- 1: no width change on press/release ---------- */
const w0 = await widths();
await ev(`document.getElementById('moreBtn').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
await sleep(160);
const wMid = await widths();
await ev(`document.getElementById('moreBtn').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
await sleep(420);
const w1 = await widths();
console.log('widths:', JSON.stringify(w0), JSON.stringify(wMid), JSON.stringify(w1));
check('CG5: pressing does NOT resize any button',
  wMid.every((b, i) => Math.abs(b.w - w0[i].w) <= 0.6), JSON.stringify(wMid.map(b => b.w)));
check('CG5: resting widths unchanged after release',
  w1.every((b, i) => Math.abs(b.w - w0[i].w) <= 0.6), JSON.stringify(w1.map(b => b.w)));

/* ---------- 2: shape eases at ~300ms with no overshoot ---------- */
const timing = JSON.parse(await ev(`(function(){
  var b=document.getElementById('moreBtn');
  b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  var a=b.getAnimations()[0];
  var t=a? a.effect.getTiming():null;
  var k=a? a.effect.getKeyframes():[];
  return JSON.stringify({duration:t?t.duration:null, easing:t?t.easing:null,
    kf:k.map(function(x){return x.borderRadius;})});
})()`));
console.log('press animation:', JSON.stringify(timing));
check('CG5: shape animation is 420ms — LONGER than the 300ms panes',
  timing.duration === 420, 'duration=' + timing.duration);
check('CG5: uses a no-overshoot emphasized curve',
  /cubic-bezier\(0?\.2,\s*0,\s*0,\s*1\)/.test(timing.easing || ''), String(timing.easing));

await ev(`document.getElementById('moreBtn').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
await sleep(420);

/* ---------- 3: SELECTED must hold ---------- */
await ev(`document.getElementById('moreBtn').click()`);
await sleep(500);
const sel1 = JSON.parse(await ev(`JSON.stringify((function(){
  var b=document.getElementById('moreBtn');
  var cs=getComputedStyle(b);
  return {selected:b.classList.contains('is-selected'),
          tl:parseFloat(cs.borderTopLeftRadius), tr:parseFloat(cs.borderTopRightRadius),
          menuOpen:!document.getElementById('dockMenu').hidden};
})())`));
console.log('while menu open:', JSON.stringify(sel1));
check('CG6: trigger is marked selected while the sheet is open', sel1.selected === true && sel1.menuOpen === true, JSON.stringify(sel1));
check('CG6: and HOLDS the fully-round shape', sel1.tl >= 100 && sel1.tr >= 100, JSON.stringify([sel1.tl, sel1.tr]));

/* still held a moment later — proves it is not a transient morph */
await sleep(900);
const sel2 = JSON.parse(await ev(`JSON.stringify((function(){
  var b=document.getElementById('moreBtn'); var cs=getComputedStyle(b);
  return {selected:b.classList.contains('is-selected'), tl:parseFloat(cs.borderTopLeftRadius)};
})())`));
check('CG6: the selected shape still holds ~1.4s later', sel2.selected === true && sel2.tl >= 100, JSON.stringify(sel2));

/* ---------- 4: releasing the state returns the shape ---------- */
await ev(`document.getElementById('moreBtn').click()`);
/* the shape transition is 420ms — wait it out so we assert the RESTING shape */
await sleep(900);
const sel3 = JSON.parse(await ev(`JSON.stringify((function(){
  var b=document.getElementById('moreBtn'); var cs=getComputedStyle(b);
  return {selected:b.classList.contains('is-selected'),
          tl:parseFloat(cs.borderTopLeftRadius), tr:parseFloat(cs.borderTopRightRadius),
          menuHidden:document.getElementById('dockMenu').hidden};
})())`));
console.log('after close:', JSON.stringify(sel3));
check('CG7: closing the sheet ends the selected state', sel3.selected === false && sel3.menuHidden === true, JSON.stringify(sel3));
check('CG7: shape returns to the group shape (square inner corner)',
  sel3.tr <= 12, JSON.stringify([sel3.tl, sel3.tr]));
/* moreBtn is the MIDDLE button, so per the round connected-group spec
   BOTH of its sides are inner corners (8dp) — not a fully-round edge. */
check('CG7: middle button returns to square inner corners on both sides',
  sel3.tl <= 12 && sel3.tr <= 12, JSON.stringify([sel3.tl, sel3.tr]));

/* ---------- 5: neighbours never animate ---------- */
await ev(`document.getElementById('moreBtn').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
await sleep(60);
const neigh = await ev(`(function(){
  return Array.prototype.reduce.call(document.querySelectorAll('.dock-panel > button'), function(n,b){
    return b.id === 'moreBtn' ? n : n + b.getAnimations().length; }, 0);
})()`);
check('CG8: neighbours do not animate', neigh === 0, 'neighbour anims=' + neigh);
await ev(`document.getElementById('moreBtn').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
await sleep(400);

check('CG9: no exceptions', errs.length === 0, errs.slice(0, 2).join(' | '));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('cg-revised.png', Buffer.from(shot.result.data, 'base64'));
c.kill();
console.log(failures === 0 ? '\nALL REVISED GROUP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
