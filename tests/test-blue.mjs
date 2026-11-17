/* Blue-highlight audit: walks every interactive element on each surface
   and asserts no OS-blue tap flash, focus ring, or selection colour.
   Also reports any computed outline/border that resolves to a UI blue. */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome, waitForCDP } from './helpers.mjs';

const CHROME = findChrome();

/* The admin code is a SECRET. Never hardcode it: set ELKPD_ADMIN_CODE
   in your environment. The fallback is deliberately invalid. */
const ADMIN_CODE = process.env.ELKPD_ADMIN_CODE || 'ADMIN-NOT-SET';

const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open({ mobile = false, port }) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-blue-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', mobile ? '--window-size=390,844' : '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  t = await waitForCDP(port);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let mid = 0; const h = new Map(); const exceptions = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 996000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Blue' } }));
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 150));
    if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
  };
  const send = (me, p = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method: me, params: p })); });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200)); return r.result.result.value; };
  await send('Page.enable');
  await send('Runtime.enable');
  if (mobile) await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true });
  return { chrome, send, ev, exceptions };
}

/* the audit itself: installed in the page */
const AUDIT = `(function(){
  /* classify a colour string; returns true for the browser's UI blue
     family (Chrome's default focus/selection blue is ~#1A73E8 / #0075FF) */
  function isUIBlue(col){
    if (!col) return false;
    var m = col.match(/rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s/]+([\\d.]+))?\\s*\\)/);
    if (!m) return false;
    var r = +m[1], g = +m[2], b = +m[3], a = m[4] === undefined ? 1 : +m[4];
    if (a === 0) return false;
    /* strongly blue: b dominates r and g, and it is not near-black/near-white */
    return b > 120 && b > r + 45 && b > g + 30;
  }
  var out = { tapFlash: [], outlines: [], selection: null, count: 0 };
  /* 1) every focusable/tappable element must kill the tap flash */
  var sel = 'button,a,input,textarea,select,label[for],[role="button"],[role="tab"],[tabindex],.tab,.fab,.room-chip,.peer-chip,.dock-menu';
  var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
  out.count = nodes.length;
  nodes.forEach(function(el){
    var cs = getComputedStyle(el);
    var tap = cs.webkitTapHighlightColor || cs.getPropertyValue('-webkit-tap-highlight-color');
    if (tap && tap !== 'rgba(0, 0, 0, 0)' && tap !== 'transparent') {
      out.tapFlash.push((el.id || el.className || el.tagName) + ' → ' + tap);
    }
  });
  /* 2) focus each element and read the ring colour */
  var blue = 0;
  nodes.forEach(function(el){
    try {
      el.focus({ preventScroll: true });
      var cs = getComputedStyle(el);
      var ring = [cs.outlineColor, cs.borderBottomColor, cs.borderTopColor, cs.borderLeftColor, cs.borderRightColor, cs.boxShadow];
      ring.forEach(function(v){
        if (v && isUIBlue(v)) { blue++; out.outlines.push((el.id || el.className || el.tagName) + ' → ' + v); }
      });
    } catch(e){}
  });
  /* 3) the page's selection colour */
  try {
    var s = getComputedStyle(document.documentElement);
    out.selection = { sel: (document.querySelector('::selection'), null) };
  } catch(e){}
  return JSON.stringify(out);
})()`;

/* read the resolved ::selection colour via a scratch element */
const SEL_COLOR = `(function(){
  var d = document.createElement('div');
  d.textContent = 'x';
  document.body.appendChild(d);
  var r = document.createRange(); r.selectNodeContents(d);
  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  var col = getComputedStyle(d).getPropertyValue('background-color');
  /* ::selection styles do not resolve on the element itself; fall back
     to scanning stylesheets for a ::selection rule */
  var found = [];
  for (var i = 0; i < document.styleSheets.length; i++) {
    var rules;
    try { rules = document.styleSheets[i].cssRules; } catch(e){ continue; }
    for (var j = 0; j < rules.length; j++) {
      var rr = rules[j];
      if (rr.selectorText && rr.selectorText.indexOf('::selection') !== -1) {
        found.push(rr.style.background || rr.style.backgroundColor || '(none)');
      }
    }
  }
  s.removeAllRanges();
  d.remove();
  return JSON.stringify({ rules: found });
})()`;

let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

async function runSurface(label, s, setup) {
  await setup();
  const res = JSON.parse(await s.ev(AUDIT));
  const selr = JSON.parse(await s.ev(SEL_COLOR));
  console.log(`\n[${label}] ${res.count} interactive elements, selection rules: ${JSON.stringify(selr.rules)}`);
  if (res.tapFlash.length) console.log('  tap-flash offenders:', res.tapFlash.slice(0, 6));
  if (res.outlines.length) console.log('  blue-ring offenders:', res.outlines.slice(0, 6));
  check(`${label}: no tap flash on any control`, res.tapFlash.length === 0, res.tapFlash.length + ' offenders');
  check(`${label}: no blue focus/border colour`, res.outlines.length === 0, res.outlines.length + ' offenders');
  check(`${label}: selection colour is defined (not OS default)`, selr.rules.length > 0, JSON.stringify(selr.rules));
  const blueSel = selr.rules.filter(r => /(0,\s*0,\s*255|59,\s*130,\s*246|26,\s*115,\s*232|0,\s*117,\s*255)/.test(r));
  check(`${label}: selection is not OS blue`, blueSel.length === 0, JSON.stringify(blueSel));
  check(`${label}: no page exceptions`, s.exceptions.length === 0, s.exceptions.slice(0, 1).join(''));
}

async function main() {
  /* gate */
  {
    const s = await open({ port: 9530 });
    await runSurface('gate', s, async () => {
      await s.send('Page.navigate', { url: LIVE });
      await sleep(2600);
    });
    /* and the gate's created-code state (user-select:all) */
    await s.ev(`document.getElementById('tab-new').click()`);
    await sleep(400);
    await s.ev(`document.getElementById('label').value='Audit'`);
    await s.ev(`document.getElementById('btn-new').click()`);
    await sleep(1800);
    const codeSel = JSON.parse(await s.ev(SEL_COLOR));
    check('gate: created-code box inherits the blush selection', codeSel.rules.length > 0, JSON.stringify(codeSel.rules));
    s.chrome.kill();
  }

  /* worksheet desktop */
  {
    const s = await open({ port: 9532 });
    await runSurface('worksheet', s, async () => {
      await s.send('Page.navigate', { url: LIVE });
      await sleep(2400);
      await s.ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.status)`);
      await s.ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Blue Audit')}catch(e){}`);
      await s.send('Page.navigate', { url: LIVE });
      await sleep(4200);
    });
    /* include the open menu's buttons in the audit */
    await s.ev(`document.getElementById('moreBtn').click()`);
    await sleep(400);
    const menuRes = JSON.parse(await s.ev(AUDIT));
    check('worksheet: no tap flash with the menu open', menuRes.tapFlash.length === 0, JSON.stringify(menuRes.tapFlash.slice(0, 4)));
    check('worksheet: no blue rings with the menu open', menuRes.outlines.length === 0, JSON.stringify(menuRes.outlines.slice(0, 4)));
    s.chrome.kill();
  }

  /* worksheet mobile (FAB) */
  {
    const s = await open({ mobile: true, port: 9534 });
    await runSurface('worksheet-mobile', s, async () => {
      await s.send('Page.navigate', { url: LIVE });
      await sleep(2400);
      await s.ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'DIAGNOSTICROOM'})}).then(r=>r.status)`);
      await s.ev(`try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Blue Audit')}catch(e){}`);
      await s.send('Page.navigate', { url: LIVE });
      await sleep(4200);
    });
    s.chrome.kill();
  }

  /* admin console */
  {
    const s = await open({ port: 9536 });
    await runSurface('admin', s, async () => {
      await s.send('Page.navigate', { url: LIVE });
      await sleep(2400);
      await s.ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:${JSON.stringify(ADMIN_CODE)}})}).then(r=>r.status)`);
      await s.send('Page.navigate', { url: LIVE });
      await sleep(2600);
    });
    s.chrome.kill();
  }

  console.log(failures === 0 ? '\nNO BLUE HIGHLIGHTS ANYWHERE' : `\n${failures} BLUE-HIGHLIGHT ISSUE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
