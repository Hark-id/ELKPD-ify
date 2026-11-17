/* Site-wide verification of the circular wavy indicator + centering. */
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

async function open(port, mobile) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', mobile ? '--window-size=390,844' : '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 50; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch { } }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let mid = 0; const h = new Map(); const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 994000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'SW' } }));
    if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
  };
  const send = (me, p = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method: me, params: p })); });
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240));
    return r.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  if (mobile) await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true });
  return { chrome, send, ev, errs };
}

let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

/* radius stats of any .ld-arc path */
const radiiOf = sel => `(function(){
  var p = document.querySelector(${JSON.stringify(sel)});
  if (!p) return JSON.stringify({missing:true});
  var d = p.getAttribute('d') || '';
  var nums = d.match(/-?[0-9]+\\.?[0-9]*/g);
  if (!nums) return JSON.stringify({empty:true});
  nums = nums.map(Number);
  var rs = [];
  for (var i=0;i<nums.length;i+=2) rs.push(Math.hypot(nums[i]-17, nums[i+1]-17));
  if (!rs.length) return JSON.stringify({empty:true});
  return JSON.stringify({points: rs.length,
    min:+Math.min.apply(null,rs).toFixed(2), max:+Math.max.apply(null,rs).toFixed(2),
    spread:+(Math.max.apply(null,rs)-Math.min.apply(null,rs)).toFixed(2)});
})()`;

async function main() {
  /* ---------- 1: gate loading stage — centering ---------- */
  {
    const s = await open(9670, false);
    await s.send('Page.navigate', { url: LIVE });
    await sleep(3000);
    await s.ev(`try{localStorage.removeItem('lkpd-cerpen-name:diag-diagnosticroom')}catch(e){}`);
    await s.ev(`document.getElementById('code').value='DIAGNOSTICROOM'`);
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 40 * 1024 / 8 });
    await s.ev(`document.getElementById('btn-join').click()`);
    await sleep(1700);

    const c = JSON.parse(await s.ev(`JSON.stringify((function(){
      var card=document.querySelector('.card'), disc=document.querySelector('.ld-disc'), hint=document.querySelector('.ld-hint');
      function b(e){var r=e.getBoundingClientRect();return {cx:+(r.left+r.width/2).toFixed(1),cy:+(r.top+r.height/2).toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)};}
      var cb=b(card), db=b(disc), hb=b(hint);
      return {card:cb, disc:db, hint:hb,
        dx:+(db.cx-cb.cx).toFixed(1), dy:+(db.cy-cb.cy).toFixed(1),
        square: Math.abs(cb.w-cb.h) <= 2,
        hintBelow: hb.cy > db.cy};
    })())`));
    console.log('gate centering:', JSON.stringify(c));
    check('G1: card is a square', c.square, c.card.w + 'x' + c.card.h);
    check('G1: disc is horizontally dead-centre', Math.abs(c.dx) <= 0.6, 'dx=' + c.dx);
    check('G1: disc is vertically dead-centre', Math.abs(c.dy) <= 0.6, 'dy=' + c.dy);
    check('G1: label hangs below the indicator', c.hintBelow === true);

    const g1 = JSON.parse(await s.ev(radiiOf('#ldArc')));
    check('G1: indicator is wavy (radius spread)', (g1.spread || 0) > 0.3, JSON.stringify(g1));
    s.chrome.kill();
  }

  /* ---------- 2: worksheet tool bar ---------- */
  {
    const s = await open(9672, false);
    await s.send('Page.navigate', { url: LIVE });
    await sleep(2600);
    await s.ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.status)`);
    await s.ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','SW')}catch(e){}`);
    await s.send('Page.navigate', { url: LIVE });
    await sleep(4200);

    /* hold the bar loader open and sample it */
    const w = JSON.parse(await s.ev(`JSON.stringify((function(){
      var li=document.getElementById('loadInd'), box=document.querySelector('.load-box'), path=document.getElementById('loadPath');
      li.hidden=false; li.style.opacity='1'; li.style.transform='none';
      var lr=li.getBoundingClientRect(), br=box.getBoundingClientRect();
      return {wrap:[Math.round(lr.width),Math.round(lr.height)],
              box:[Math.round(br.width),Math.round(br.height)],
              boxBg:getComputedStyle(box).backgroundColor,
              hasTrack:!!document.querySelector('.load-box .ld-track'),
              hasArc:!!path, dLen:(path?path.getAttribute('d'):'').length};
    })())`));
    console.log('worksheet loader:', JSON.stringify(w));
    check('W1: bar loader is 44/38dp contained', JSON.stringify(w.wrap) === '[44,44]' && JSON.stringify(w.box) === '[38,38]', JSON.stringify([w.wrap, w.box]));
    check('W1: blush container + resting track + active arc', w.boxBg === 'rgb(255, 218, 217)' && w.hasTrack && w.hasArc, JSON.stringify(w));
    check('W1: arc has geometry', w.dLen > 40, 'len=' + w.dLen);

    /* force the wave on and confirm it is wavy + animating */
    await s.ev(`if(window.WaveLoading){window.WaveLoading.waveLoop(document.getElementById('loadPath'));}`);
    await sleep(300);
    const r1 = JSON.parse(await s.ev(radiiOf('#loadPath')));
    await sleep(350);
    const r2 = JSON.parse(await s.ev(radiiOf('#loadPath')));
    console.log('bar wave:', JSON.stringify(r1), JSON.stringify(r2));
    check('W1: bar indicator is wavy', r1.spread > 0.3, 'spread=' + r1.spread);
    check('W1: bar indicator animates', JSON.stringify(r1) !== JSON.stringify(r2));
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('sw-bar.png', Buffer.from(shot.result.data, 'base64'));
    check('W1: no exceptions', s.errs.length === 0, s.errs.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  /* ---------- 3: admin console ---------- */
  {
    const s = await open(9674, false);
    await s.send('Page.navigate', { url: LIVE });
    await sleep(2600);
    await s.ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:ADMIN_CODE})}).then(r=>r.status)`);
    /* re-load so the console paints its loader, and sample DURING the fetch */
    await s.send('Page.navigate', { url: LIVE });
    await sleep(2200);
    /* now armed in the live page: hold the list response so the
       console stays in its loading state while we inspect it */
    await s.ev("window.__origFetch = window.fetch; window.__origFetch('/api/admin/list',{method:'POST'}).catch(function(){}); window.fetch = function(u){ if(String(u).indexOf('/api/admin/list')>=0){ return new Promise(function(){}); } return window.__origFetch.apply(this, arguments); }; document.getElementById('refresh').click();");
    await sleep(700);
    const a = JSON.parse(await s.ev(`JSON.stringify((function(){
      var box=document.querySelector('.load-box');
      var arc=document.querySelector('.load-box .ld-arc');
      var tr=document.querySelector('.load-box .ld-track');
      return {hasLoader:!!box, box:box?[Math.round(box.getBoundingClientRect().width),Math.round(box.getBoundingClientRect().height)]:null,
              bg:box?getComputedStyle(box).backgroundColor:null,
              track:!!tr, arc:!!arc, dLen:arc?(arc.getAttribute('d')||'').length:0};
    })())`));
    console.log('admin loader:', JSON.stringify(a));
    check('A1: console renders the same 52dp disc', a.hasLoader && JSON.stringify(a.box) === '[52,52]', JSON.stringify(a.box));
    check('A1: blush container + track + arc', a.bg === 'rgb(255, 218, 217)' && a.track && a.arc, JSON.stringify(a));
    check('A1: arc has geometry', a.dLen > 40, 'len=' + a.dLen);
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(2600);
    check('A1: no exceptions', s.errs.length === 0, s.errs.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  console.log(failures === 0 ? '\nALL SITE-WIDE INDICATOR CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
