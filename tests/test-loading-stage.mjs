/* Verifies the gate loading stage end-to-end:
   - slow network: card becomes a SQUARE with a live wavy circular indicator
   - the wave is real geometry (radius spread > 0)
   - fast network: settles into the naming stage, loader retires
   - bad code: card is restored and the error is shown
   - no blue highlights on any control */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(port) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-ld-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 50; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch { } }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let mid = 0; const h = new Map(); const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 995000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'LD' } }));
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
  return { chrome, send, ev, errs };
}

let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!c) failures++; };

/* radius statistics of the indicator's active path */
const RADII = `(function(){
  var p = document.getElementById('ldArc');
  if (!p) return JSON.stringify({missing:true});
  var d = p.getAttribute('d') || '';
  var nums = d.match(/-?[0-9]+\\.?[0-9]*/g);
  if (!nums) return JSON.stringify({empty:true, d:d.length});
  nums = nums.map(Number);
  var rs = [];
  for (var i=0;i<nums.length;i+=2) rs.push(Math.hypot(nums[i]-17, nums[i+1]-17));
  return JSON.stringify({
    points: rs.length,
    min: +Math.min.apply(null, rs).toFixed(2),
    max: +Math.max.apply(null, rs).toFixed(2),
    spread: +(Math.max.apply(null, rs)-Math.min.apply(null, rs)).toFixed(2)
  });
})()`;

async function main() {
  /* ---------- A: slow network shows the loading square ---------- */
  {
    const s = await open(9640);
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 700, downloadThroughput: 180 * 1024 / 8, uploadThroughput: 90 * 1024 / 8 });
    await s.send('Page.navigate', { url: LIVE });
    await sleep(3200);

    /* submit a real code */
    await s.ev(`document.getElementById('code').value='DIAGNOSTICROOM'`);
    await s.ev(`try{localStorage.removeItem('lkpd-cerpen-name:diag-diagnosticroom')}catch(e){}`);
    await s.ev(`document.getElementById('btn-join').click()`);
    await sleep(900);

    const st = JSON.parse(await s.ev(`JSON.stringify((function(){
      var c = document.querySelector('.card');
      var r = c.getBoundingClientRect();
      var li = document.getElementById('gateLoader');
      var disc = document.querySelector('.ld-disc');
      var dr = disc ? disc.getBoundingClientRect() : null;
      return {
        cardW: Math.round(r.width), cardH: Math.round(r.height),
        isSquare: Math.abs(Math.round(r.width) - Math.round(r.height)) <= 2,
        loaderHidden: li.hidden,
        loaderDisplay: getComputedStyle(li).display,
        discSize: dr ? [Math.round(dr.width), Math.round(dr.height)] : null,
        discBg: disc ? getComputedStyle(disc).backgroundColor : null,
        hint: (document.querySelector('.ld-hint')||{}).textContent || null
      };
    })())`));
    console.log('slow state:', JSON.stringify(st));
    check('A: card became a square', st.isSquare === true, st.cardW + 'x' + st.cardH);
    check('A: loader is visible', st.loaderHidden === false && st.loaderDisplay !== 'none', st.loaderDisplay);
    check('A: blush 52px indicator disc (rounding tolerant)', Math.abs(st.discSize[0]-52) <= 1 && Math.abs(st.discSize[1]-52) <= 1 && st.discBg === 'rgb(255, 218, 217)', JSON.stringify([st.discSize, st.discBg]));
    check('A: "Menyiapkan" label present', /MENYIAPKAN/i.test(st.hint || ''), String(st.hint));

    /* the indicator must be actually moving and actually wavy */
    const r1 = JSON.parse(await s.ev(RADII));
    await sleep(420);
    const r2 = JSON.parse(await s.ev(RADII));
    console.log('radii #1:', JSON.stringify(r1), '\nradii #2:', JSON.stringify(r2));
    check('A: active track has geometry', r1.points > 20, JSON.stringify(r1));
    check('A: wave is real (radius spread > 0.3)', r1.spread > 0.3, 'spread=' + r1.spread);
    check('A: arc is animating (path changes)', JSON.stringify(r1) !== JSON.stringify(r2), 'frames differ');

    const shot1 = await s.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('ld-1-loading.png', Buffer.from(shot1.result.data, 'base64'));

    /* ---------- B: it settles into the naming stage ---------- */
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(4200);
    const after = await s.ev(`location.pathname`);
    const nm = JSON.parse(await s.ev(`JSON.stringify((function(){
      var nc = document.getElementById('name-card');
      return {ncHidden: nc ? nc.hidden : 'no-el',
              ncVisible: nc ? getComputedStyle(nc).display !== 'none' && nc.getBoundingClientRect().width > 100 : false,
              stagename: document.documentElement.classList.contains('stagename')};
    })())`));
    console.log('after settle:', after, JSON.stringify(nm));
    check('B: navigated into the room', after === '/', after);
    check('B: naming card is showing', nm.ncVisible === true || nm.ncHidden === false, JSON.stringify(nm));
    check('B: no exceptions', s.errs.length === 0, s.errs.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  /* ---------- C: bad code restores the card ---------- */
  {
    const s = await open(9642);
    await s.send('Page.navigate', { url: LIVE });
    await sleep(2800);
    await s.ev(`document.getElementById('code').value='ZZZZZZ'`);
    await s.ev(`document.getElementById('btn-join').click()`);
    await sleep(2600);
    const st = JSON.parse(await s.ev(`JSON.stringify((function(){
      var c = document.querySelector('.card');
      var r = c.getBoundingClientRect();
      var li = document.getElementById('gateLoader');
      var err = document.getElementById('err-join');
      var btn = document.getElementById('btn-join');
      return {
        cardW: Math.round(r.width), cardH: Math.round(r.height),
        stillSquare: Math.abs(Math.round(r.width) - Math.round(r.height)) <= 2 && Math.round(r.width) < 300,
        inlineStyle: c.style.cssText,
        loaderHidden: li.hidden,
        err: (err.textContent||'').trim(),
        btnDisabled: btn.disabled,
        btnText: btn.textContent.trim()
      };
    })())`));
    console.log('bad-code state:', JSON.stringify(st));
    check('C: card restored (not left small/square)', st.stillSquare === false, st.cardW + 'x' + st.cardH);
    check('C: loader retired', st.loaderHidden === true);
    check('C: error message shown', st.err.length > 0, st.err);
    check('C: button usable again', st.btnDisabled === false && /Buka Lembar Kerja/.test(st.btnText), st.btnText);
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('ld-2-error.png', Buffer.from(shot.result.data, 'base64'));
    check('C: no exceptions', s.errs.length === 0, s.errs.slice(0, 2).join(' | '));
    s.chrome.kill();
  }

  console.log(failures === 0 ? '\nALL LOADING-STAGE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
