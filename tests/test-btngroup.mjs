/* Verifies the connected button group per M3 specs:
   - 2dp padding between buttons
   - ROUND variant: outer edges fully round, inner corners square (8dp)
   - selection/activation morphs only the activated button (width+shape),
     neighbours untouched
   - mobile: a single visible button is a standalone pill */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from './helpers.mjs';

const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(port, mobile) {
  const d = mkdtempSync(join(tmpdir(), 'cg-'));
  const c = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${d}`, '--no-first-run', mobile ? '--window-size=390,844' : '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 50; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch { } }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let mid = 0; const h = new Map(); const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 986000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'CG' } }));
    if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
  };
  const send = (me, p = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method: me, params: p })); });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240)); return r.result.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  if (mobile) await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true });
  return { chrome: c, send, ev, errs };
}
let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

async function intoRoom(s) {
  await s.send('Page.navigate', { url: LIVE });
  await sleep(2600);
  await s.ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','CG')}catch(e){}`);
  await s.ev(`document.getElementById('code').value='DIAGNOSTICROOM'`);
  await s.ev(`document.getElementById('btn-join').click()`);
  await sleep(6000);
}

async function main() {
  /* ---------- desktop ---------- */
  {
    const s = await open(9780, false);
    await intoRoom(s);

    const geo = JSON.parse(await s.ev(`JSON.stringify((function(){
      var g=document.getElementById('dockPanel');
      var btns=Array.prototype.slice.call(g.querySelectorAll(':scope > button')).filter(function(b){return b.getClientRects().length;});
      function cs(b){var c=getComputedStyle(b);return {
        tl:parseFloat(c.borderTopLeftRadius),tr:parseFloat(c.borderTopRightRadius),
        br:parseFloat(c.borderBottomRightRadius),bl:parseFloat(c.borderBottomLeftRadius),
        cls:b.className, id:b.id||'(cetak)',
        w:Math.round(b.getBoundingClientRect().width)};}
      return {
        gap:getComputedStyle(g).gap,
        count:btns.length,
        btns:btns.map(cs),
        gaps:(function(){var r=[];for(var i=1;i<btns.length;i++){r.push(Math.round(btns[i].getBoundingClientRect().left-btns[i-1].getBoundingClientRect().right));}return r;})()
      };
    })())`));
    console.log('group:', JSON.stringify(geo, null, 0));

    check('CG1: three buttons in the group', geo.count === 3, String(geo.count));
    check('CG1: spec 2dp padding between buttons', geo.gap === '2px' && geo.gaps.every(g => Math.abs(g - 2) <= 1), JSON.stringify([geo.gap, geo.gaps]));
    const first = geo.btns[0], last = geo.btns[geo.btns.length - 1];
    check('CG1: FIRST button fully round on its outer (left) edge',
      first.tl >= 100 && first.bl >= 100, JSON.stringify([first.tl, first.bl]));
    check('CG1: FIRST button square on its inner (right) edge',
      first.tr <= 12 && first.br <= 12, JSON.stringify([first.tr, first.br]));
    check('CG1: LAST button fully round on its outer (right) edge',
      last.tr >= 100 && last.br >= 100, JSON.stringify([last.tr, last.br]));
    check('CG1: LAST button square on its inner (left) edge',
      last.tl <= 12 && last.bl <= 12, JSON.stringify([last.tl, last.bl]));
    if (geo.btns.length === 3) {
      const mid = geo.btns[1];
      check('CG1: MIDDLE button square on BOTH inner edges',
        mid.tl <= 12 && mid.tr <= 12 && mid.bl <= 12 && mid.br <= 12,
        JSON.stringify([mid.tl, mid.tr, mid.bl, mid.br]));
    }

    /* ---------- activation: only the pressed button morphs ---------- */
    const before = JSON.parse(await s.ev(`JSON.stringify((function(){
      var g=document.getElementById('dockPanel');
      return Array.prototype.slice.call(g.querySelectorAll(':scope > button')).map(function(b){
        var r=b.getBoundingClientRect(); return {w:+r.width.toFixed(1), id:b.id||'cetak'};
      });
    })())`));

    /* press the middle button and sample mid-animation */
    await s.ev(`(function(){
      var b=document.getElementById('moreBtn');
      b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      return 1;
    })()`);
    await sleep(90);
    const during = JSON.parse(await s.ev(`JSON.stringify((function(){
      var b=document.getElementById('moreBtn');
      var cs=getComputedStyle(b);
      return {radius:[cs.borderTopLeftRadius,cs.borderTopRightRadius].join(' '),
              anims:b.getAnimations().length};
    })())`));
    check('CG2: pressed button animates its shape', during.anims > 0, JSON.stringify(during));
    check('CG2: pressed button becomes fully round',
      parseFloat(during.radius) >= 100, during.radius);

    /* release: width morph runs and neighbours must not change width */
    await s.ev(`document.getElementById('moreBtn').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
    await sleep(120);
    const midAnim = await s.ev(`document.getElementById('moreBtn').getAnimations().length`);
    const neighAnim = await s.ev(`(function(){
      var g=document.getElementById('dockPanel');
      var others=Array.prototype.slice.call(g.querySelectorAll(':scope > button')).filter(function(b){return b.id!=='moreBtn';});
      return others.reduce(function(n,b){return n+b.getAnimations().length;},0);
    })()`);
    check('CG2: the activated button animates width', midAnim > 0, 'anims=' + midAnim);
    check('CG2: NEIGHBOURS do not animate (connected group rule)',
      neighAnim === 0, 'neighbour anims=' + neighAnim);

    /* the width morph runs 320ms — let it finish before comparing */
    await sleep(420);
    const after = JSON.parse(await s.ev(`JSON.stringify((function(){
      var g=document.getElementById('dockPanel');
      return Array.prototype.slice.call(g.querySelectorAll(':scope > button')).map(function(b){
        var r=b.getBoundingClientRect(); return {w:+r.width.toFixed(1), id:b.id||'cetak'};
      });
    })())`));
    console.log('widths before:', JSON.stringify(before), '\nafter:', JSON.stringify(after));
    const dbg = JSON.parse(await s.ev(`JSON.stringify((function(){var b=document.getElementById('moreBtn');return {inlineW:b.style.width,inlinePL:b.style.paddingLeft,inlinePR:b.style.paddingRight,anims:b.getAnimations().length,glyphTf:(b.querySelector('.more-glyph')||{}).style?b.querySelector('.more-glyph').style.transform:'-',scrollW:b.scrollWidth};})())`));
    console.log('moreBtn debug:', JSON.stringify(dbg));
    check('CG2: group returns to its resting widths',
      before.every((b, i) => Math.abs(b.w - after[i].w) <= 1.5),
      JSON.stringify(after.map(a => a.w)));

    /* the morph must not have broken the group's edge roles */
    const stillOk = JSON.parse(await s.ev(`JSON.stringify((function(){
      var g=document.getElementById('dockPanel');
      var btns=Array.prototype.slice.call(g.querySelectorAll(':scope > button'));
      return {first:btns[0].className, last:btns[btns.length-1].className};
    })())`));
    check('CG2: edge roles intact after interaction',
      /cg-first/.test(stillOk.first) && /cg-last/.test(stillOk.last), JSON.stringify(stillOk));

    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('cg-desktop.png', Buffer.from(r.result.data, 'base64'));
    check('CG3: no exceptions', s.errs.length === 0, s.errs.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  /* ---------- mobile: one visible button = standalone pill ---------- */
  {
    const s = await open(9782, true);
    await intoRoom(s);
    const m = JSON.parse(await s.ev(`JSON.stringify((function(){
      var g=document.getElementById('dockPanel');
      var btns=Array.prototype.slice.call(g.querySelectorAll(':scope > button'));
      var vis=btns.filter(function(b){return getComputedStyle(b).display!=='none' && b.getClientRects().length;});
      return {visible:vis.length, cls:vis.map(function(b){return b.className;}),
              radius:vis.map(function(b){var cs=getComputedStyle(b);return [parseFloat(cs.borderTopLeftRadius),parseFloat(cs.borderTopRightRadius)];})};
    })())`));
    console.log('mobile group:', JSON.stringify(m));
    check('CG4: only one button remains visible on mobile', m.visible === 1, String(m.visible));
    check('CG4: the lone button is a standalone pill (fully round both sides)',
      m.radius[0][0] >= 100 && m.radius[0][1] >= 100, JSON.stringify(m.radius));
    check('CG4: no exceptions', s.errs.length === 0, s.errs.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  console.log(failures === 0 ? '\nALL BUTTON-GROUP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
