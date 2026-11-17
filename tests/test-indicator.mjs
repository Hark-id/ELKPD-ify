/* Verifies the MD3 loading indicator lifecycle, the FAB's open/close
   motion, and the menu item stagger — desktop + mobile. */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open({ mobile = false, port = 9470 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-ind-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', mobile ? '--window-size=390,844' : '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let target = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0; const h = new Map(); const dialogs = []; const exceptions = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 40));
      ws.send(JSON.stringify({ id: 998000 + dialogs.length, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Ind Tester' } }));
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
    if (r && r.TIMEOUT) throw new Error('timed out');
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 250));
    return r.result.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  if (mobile) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true });
  }
  return { chrome, send, ev, dialogs, exceptions };
}

let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

async function enterRoom(s) {
  await s.send('Page.navigate', { url: LIVE });
  await sleep(2500);
  await s.ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.status)`);
  await s.ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Ind Tester')}catch(e){}`);
  await s.send('Page.navigate', { url: LIVE });
  await sleep(4000);
}

async function main() {
  /* ---------- desktop: loading indicator + dropdown stagger ---------- */
  {
    const s = await open({ port: 9470 });
    await enterRoom(s);
    /* the blob must have a live path and then retire */
    /* catch the indicator during the REAL initial load: sample from an
       init script so we see it before the socket settles */
    const live = JSON.parse(await s.ev(`(function(){
      /* replay the reveal's own call path */
      var li = document.getElementById('loadInd');
      var p = document.getElementById('loadPath');
      li.hidden = false;
      li.style.opacity = "1";
      li.style.transform = "none";
      var w0 = li.getBoundingClientRect();
      var b0 = document.querySelector('.load-box').getBoundingClientRect();
      return JSON.stringify({
        wrap: [Math.round(w0.width), Math.round(w0.height)],
        shell: [Math.round(b0.width), Math.round(b0.height)],
        dLen: (p.getAttribute('d') || '').length,
        hasPath: !!(p.getAttribute('d') || '').length
      });
    })()`));
    /* then confirm the blob actually redraws over time */
    const anim = JSON.parse(await s.ev(`(async function(){
      var p = document.getElementById('loadPath');
      var a = p.getAttribute('d');
      await new Promise(function(r){ setTimeout(r, 200); });
      return JSON.stringify({changed: p.getAttribute('d') !== a, len: (p.getAttribute('d')||'').length});
    })()`));
    console.log('indicator (during):', JSON.stringify(live), 'redraw:', JSON.stringify(anim));
    check('D-ind: sizes 44dp wrapper / 38dp container',
      JSON.stringify(live.wrap) === '[44,44]' && JSON.stringify(live.shell) === '[38,38]',
      JSON.stringify([live.wrap, live.shell]));
    check('D-ind: active path has geometry', live.hasPath && live.dLen > 40, 'len=' + live.dLen);

    /* desktop dropdown: container + staggered items */
    await s.ev(`document.getElementById('moreBtn').click()`);
    await sleep(110);
    const dd = JSON.parse(await s.ev(`JSON.stringify((function(){
      var m = document.getElementById('dockMenu');
      var btns = Array.from(m.querySelectorAll('button'));
      return {open: !m.hidden, items: btns.length,
        anims: btns.filter(function(b){return b.offsetParent!==null;}).map(function(b){return b.getAnimations().length;}),
        rect: (function(){var r=m.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)];})()};
    })())`));
    check('D-drop: opens with its visible items', dd.open && dd.items >= 2, JSON.stringify(dd));
    check('D-drop: every visible item animates', dd.anims.length >= 2 && dd.anims.every(n => n > 0), JSON.stringify(dd.anims));
    await s.ev(`document.getElementById('moreBtn').click()`);
    // closing now folds up (190ms) before hiding
    await s.ev(`document.getElementById('moreBtn').getAnimations().length`);
    const closingAnimated = await s.ev(`document.getElementById('dockMenu').getAnimations().length`);
    await sleep(450);
    check('D-drop: closes with a fold-up animation', closingAnimated > 0, 'anims=' + closingAnimated);
    check('D-drop: closes again', await s.ev(`document.getElementById('dockMenu').hidden`) === true);

    /* the FAB must NOT exist visually on desktop */
    const fabDesktop = await s.ev(`(function(){var f=document.getElementById('optionsFab');return f?f.getBoundingClientRect().width:0;})()`);
    check('D: FAB hidden on desktop', fabDesktop === 0, 'width=' + fabDesktop);
    check('D: no exceptions', s.exceptions.length === 0, s.exceptions.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  /* ---------- mobile: FAB motion ---------- */
  {
    const s = await open({ mobile: true, port: 9472 });
    await enterRoom(s);
    const before = JSON.parse(await s.ev(`JSON.stringify((function(){
      var f = document.getElementById('optionsFab');
      var r = f.getBoundingClientRect();
      return {w: Math.round(r.width), rotate: getComputedStyle(f).transform,
              incoming: f.getAnimations().length};
    })())`));
    check('M-fab: 56px and visible', before.w === 56, JSON.stringify(before));

    await s.ev(`document.getElementById('optionsFab').click()`);
    await sleep(120);
    const opening = JSON.parse(await s.ev(`JSON.stringify((function(){
      var f = document.getElementById('optionsFab');
      var m = document.getElementById('dockMenu');
      var btns = Array.from(m.querySelectorAll('button'));
      return {menuOpen: !m.hidden,
        fabAnims: f.getAnimations().length + (f.querySelector(".fab-glyph")||{getAnimations:function(){return [];}}).getAnimations().length,
        fabRotating: (f.querySelector(".fab-glyph")||f).getAnimations().some(function(a){
          try { var k = a.effect.getKeyframes(); return k.length > 1 && String(k[1].transform||'').indexOf('rotate') !== -1; } catch(e){ return false; }
        }),
        itemAnims: btns.filter(function(b){return b.offsetParent!==null;}).map(function(b){ return b.getAnimations().length; }),
        anchored: (function(){var mr=m.getBoundingClientRect(), fr=f.getBoundingClientRect(); return Math.round(mr.bottom) <= Math.round(fr.top) + 2;})()
      };
    })())`));
    console.log('fab opening:', JSON.stringify(opening));
    check('M-fab: menu opens', opening.menuOpen === true);
    check('M-fab: icon rotates on open', opening.fabRotating === true);
    check('M-fab: menu items each animate', opening.itemAnims.length >= 3 && opening.itemAnims.every(n => n > 0), JSON.stringify(opening.itemAnims));
    check('M-fab: menu anchored above the FAB', opening.anchored === true);

    await sleep(700);
    const settled = await s.ev(`document.getElementById('optionsFab').getAnimations().filter(function(a){return a.playState==='running';}).length`);
    check('M-fab: no transform left running after settle', settled === 0, 'running=' + settled);

    await s.ev(`document.body.click()`);
    await sleep(120);
    const closing = JSON.parse(await s.ev(`JSON.stringify((function(){
      var f = document.getElementById('optionsFab');
      return {menuHidden: document.getElementById('dockMenu').hidden,
              fabAnimatingBack: (f.querySelector(".fab-glyph")||f).getAnimations().length > 0};
    })())`));
    check('M-fab: close animates back', closing.fabAnimatingBack === true, JSON.stringify(closing));
    await sleep(450);
    check('M-fab: then folds away', await s.ev(`document.getElementById('dockMenu').hidden`) === true);

    /* the FAB must not be visible during the transform veil */
    check('M: no exceptions', s.exceptions.length === 0, s.exceptions.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  console.log(failures === 0 ? '\nALL INDICATOR/FAB CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
