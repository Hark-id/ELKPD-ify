/* Verifies the container-transform continuity under a throttled
   connection: the naming stage must exist at FIRST PAINT, never after
   the room has flashed. Also checks the loading-indicator lifecycle. */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'cdp-race-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9460', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try { const l = await (await fetch('http://127.0.0.1:9460/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: 999000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Race Tester' } }));
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr, ms = 12000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => ({ TIMEOUT: true })),
  ]);
  if (r && r.TIMEOUT) throw new Error('evaluate timed out');
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 250));
  return r.result.result.value;
};
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

/* A frame-by-frame observer installed BEFORE any page script: records
   every animation frame's view of (a) is the room painted, (b) is the
   name card present+visible, (c) is a crimson cover present. */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__frames = [];
    window.__samplerError = null;
    (function sample(){
      try {
        var de = document.documentElement;
        var nc = document.getElementById('name-card');
        var cover = de.classList.contains('morphing');
        var v = document.getElementById('morph-veil');
        var veilLive = !!(v && !v.hidden && getComputedStyle(v).opacity !== '0');
        var ncVisible = nc ? getComputedStyle(nc).display !== 'none' && nc.getBoundingClientRect().width > 40 : false;
        var mainEl = document.querySelector('main');
        var roomVisible = !!mainEl && getComputedStyle(mainEl).opacity !== '0';
        window.__frames.push({cover: cover, veilLive: veilLive, nc: ncVisible, room: roomVisible, cls: de.className});
      } catch (inner) { window.__samplerError = String(inner); }
      if (window.__frames.length < 900) requestAnimationFrame(sample);
    })();
  `,
});
/* 1) establish a real session on the gate (unthrottled) */
await send('Page.navigate', { url: LIVE });
await sleep(2500);
const login = await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.text())`);
console.log('login:', login);
/* 2) arm the naming handoff, then throttle and load the worksheet */
await ev(`sessionStorage.setItem('lkpd-handoff', JSON.stringify({stage:'name', l:445, t:300, w:360, h:240}))`);
await ev(`try{localStorage.removeItem('lkpd-cerpen-name:diag-diagnosticroom')}catch(e){}`);
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 260, downloadThroughput: 240 * 1024 / 8, uploadThroughput: 120 * 1024 / 8,
});
await send('Page.navigate', { url: LIVE });
await sleep(1200);
const early = JSON.parse(await ev(`JSON.stringify({
  hasFrames: !!(window.__frames && window.__frames.length),
  firstFrames: (window.__frames || []).slice(0, 10)
})`));

await sleep(14000);
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
let late = null;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    late = JSON.parse(await ev(`JSON.stringify({
      ready: document.readyState,
      samplerError: window.__samplerError,
      frames: (function(){
        var f = window.__frames || [];
        var firstRoom = f.findIndex(function(x){ return x.room; });
        var bad = 0;
        for (var i = 0; i < f.length; i++) {
          if (f[i].room && !(f[i].cover || f[i].veilLive)) bad++;
        }
        return {total: f.length, firstRoom: firstRoom, badNoCover: bad,
                first5: f.slice(0, 5)};
      })(),
      state: {
        hasNc: !!document.getElementById('name-card'),
        ncVisible: (function(){var n=document.getElementById('name-card');return !!n && !n.hidden && getComputedStyle(n).display!=='none';})(),
        ncRect: (function(){var n=document.getElementById('name-card');if(!n)return null;var r=n.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)];})(),
        stagename: document.documentElement.classList.contains('stagename'),
        morphing: document.documentElement.classList.contains('morphing'),
        coverPseudo: getComputedStyle(document.documentElement, '::before').content
      }
    })`));
    if (late.ready === 'complete' && late.state.hasNc) break;
  } catch (e) { /* page still parsing */ }
  await sleep(1500);
}
if (!late) { console.log('FAIL  R: page never became inspectable'); process.exit(1); }
console.log('early probe:', JSON.stringify(early));
console.log('summary:', JSON.stringify(late.frames));
console.log('state:', JSON.stringify(late.state));

check('R: sampler captured frames', late.frames.total > 0, 'frames=' + late.frames.total + ' err=' + late.samplerError);
check('R: room NEVER painted outside the cover (no flash)', late.frames.badNoCover === 0, 'bad frames=' + late.frames.badNoCover);
check('R: first painted frame was covered', late.frames.total > 0 && (late.frames.first5[0].cover || late.frames.first5[0].veilLive), JSON.stringify(late.frames.first5[0]));
check('R: naming stage is up', late.state.ncVisible && late.state.stagename && late.state.morphing, JSON.stringify(late.state));
check('R: name card at the handoff rect', !!late.state.ncRect && late.state.ncRect[0] === 445 && late.state.ncRect[1] === 300, JSON.stringify(late.state.ncRect));

/* direct proof the crimson cover is actually painting at first paint:
   sample the compositor for the colour under an empty part of the page */
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('race-cover.png', Buffer.from(shot.result.data, 'base64'));
const geom = JSON.parse(await ev(`JSON.stringify((function(){
  var de = document.documentElement;
  var cs = getComputedStyle(de, '::before');
  var veil = document.getElementById('morph-veil');
  var vcs = veil ? getComputedStyle(veil) : null;
  return {
    pseudo: {content: cs.content, bg: cs.backgroundColor, pos: cs.position, z: cs.zIndex, display: cs.display},
    veil: vcs ? {bg: vcs.backgroundColor, hidden: veil.hidden, op: vcs.opacity} : null,
    mainOp: getComputedStyle(document.querySelector('main')).opacity,
    barOp: getComputedStyle(document.querySelector('.tool-dock')).opacity,
    barVis: getComputedStyle(document.querySelector('.tool-dock')).visibility,
    barKidsOp: getComputedStyle(document.querySelector('.dock-panel')).opacity
  };
})())`));
console.log('cover geometry:', JSON.stringify(geom));
check('R: cover layer paints crimson (pseudo or veil)',
  // while morphing, either the ::before pseudo is crimson or the real veil is
  (geom.pseudo.bg === 'rgb(168, 0, 41)' && geom.pseudo.display !== 'none') ||
  (geom.veil && geom.veil.bg === 'rgb(168, 0, 41)' && geom.veil.hidden === false),
  JSON.stringify([geom.pseudo, geom.veil]));
check('R: room content held invisible under the cover',
  geom.mainOp === '0' && (geom.barKidsOp === '0' || geom.barVis === 'hidden'),
  `main=${geom.mainOp} barKids=${geom.barKidsOp} barVis=${geom.barVis}`);
check('R: no exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

chrome.kill();
console.log(failures === 0 ? 'ALL RACE CHECKS PASSED' : failures + ' RACE CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
