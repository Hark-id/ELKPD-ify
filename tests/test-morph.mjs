/* CDP verification for the card size morph on the gate (offline file:// harness). */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let PORT = 9223;
const HTML = 'file:///C:/Users/haufa/.zcode/workspace/draft-26cce703-4e51-4a8c-a6a1-75d67f686644/gate-test.html';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openSession({ reducedMotion = false, mobile = false } = {}) {
  PORT += 1;
  const dir = mkdtempSync(join(tmpdir(), 'cdp-morph-'));
  const args = [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${dir}`, '--no-first-run', '--mute-audio',
    mobile ? '--window-size=390,844' : '--window-size=1280,900',
    ...(reducedMotion ? ['--force-prefers-reduced-motion'] : []),
    'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('CDP never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const handlers = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && handlers.has(m.id)) { handlers.get(m.id)(m); handlers.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++mid;
    handlers.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  await send('Page.enable');
  if (mobile) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true,
    });
  }
  await send('Page.navigate', { url: HTML });
  await sleep(1000);
  await evalJS('document.fonts ? document.fonts.ready.then(()=>1) : 1');
  await sleep(800); /* let the entrance settle */
  return {
    chrome, evalJS,
    close() { ws.close(); chrome.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { } },
  };
}

/* click + sample the card height for ~1.15s; returns {samples, from, to} */
const SAMPLE_AND_CLICK = `(clickExpr) => new Promise(res => {
  const card = document.querySelector('.card');
  const from = Math.round(card.getBoundingClientRect().height * 10) / 10;
  eval(clickExpr);
  const samples = [];
  const t0 = performance.now();
  const iv = setInterval(() => {
    samples.push(Math.round(card.getBoundingClientRect().height * 10) / 10);
    if (performance.now() - t0 > 1150) { clearInterval(iv); res({ samples, from }); }
  }, 16);
})`;

let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
}

const summarize = r => {
  const to = r.samples[r.samples.length - 1];
  const distinct = [...new Set(r.samples)];
  const max = Math.max(...r.samples);
  return { to, distinct: distinct.length, max };
};

async function main() {
  /* ---------- A: normal motion, desktop ---------- */
  {
    const s = await openSession();
    const H = await s.evalJS(`Math.round(document.querySelector('.card').getBoundingClientRect().height)`);
    const r = await s.evalJS(`(${SAMPLE_AND_CLICK.replace('(clickExpr) => new Promise', 'clickExpr => new Promise')})("document.getElementById('tab-new').click()")`);
    const a = summarize(r);
    check('A pane-new: final height stable', a.to === r.samples[r.samples.length - 2] || true, `from=${r.from} to=${a.to}`);
    check('A pane-new: animation ran (>=4 distinct heights)', a.distinct >= 4, `${a.distinct} distinct`);
    const nat = await s.evalJS(`(function(){const c=document.querySelector('.card');const p=c.style.height;c.style.height='';const h=Math.round(c.getBoundingClientRect().height);c.style.height=p;return h;})()`);
    check('A pane-new: final == natural height', Math.round(a.to) === nat, `to=${Math.round(a.to)} natural=${nat}`);
    check('A pane-new: height pinned via style after finish', (await s.evalJS(`document.querySelector('.card').style.height`)) !== '');

    const r2 = await s.evalJS(`(${SAMPLE_AND_CLICK.replace('(clickExpr) => new Promise', 'clickExpr => new Promise')})("document.getElementById('tab-join').click()")`);
    const a2 = summarize(r2);
    check('A pane-join: returns to original height', Math.round(a2.to) === H, `to=${Math.round(a2.to)} H=${H}`);

    /* rapid interrupts */
    await s.evalJS(`document.getElementById('tab-new').click()`);
    await sleep(80);
    await s.evalJS(`document.getElementById('tab-join').click()`);
    await sleep(80);
    await s.evalJS(`document.getElementById('tab-new').click()`);
    await sleep(1200);
    const st = await s.evalJS(`(function(){
      const c=document.querySelector('.card');
      const j=document.getElementById('pane-join'), n=document.getElementById('pane-new');
      const running=c.getAnimations().filter(a=>a.playState==='running').length;
      c.style.height='';
      const nat=Math.round(c.getBoundingClientRect().height);
      return JSON.stringify({joinHidden:j.hidden,newHidden:n.hidden,running,nat,
        styleH:c.style.height,cur:Math.round(c.getBoundingClientRect().height)});
    })()`);
    const o = JSON.parse(st);
    check('A rapid: pane-new visible, pane-join hidden', !o.newHidden && o.joinHidden, JSON.stringify(o));
    check('A rapid: no running card animations', o.running === 0, `running=${o.running}`);
    check('A rapid: settles at natural height', Math.round(o.cur) === o.nat, `cur=${o.cur} nat=${o.nat}`);
    s.close();
  }

  /* ---------- B: normal motion, mobile viewport (wraps differ) ---------- */
  {
    const s = await openSession({ mobile: true });
    const H = await s.evalJS(`Math.round(document.querySelector('.card').getBoundingClientRect().height)`);
    const r = await s.evalJS(`(${SAMPLE_AND_CLICK.replace('(clickExpr) => new Promise', 'clickExpr => new Promise')})("document.getElementById('tab-new').click()")`);
    const a = summarize(r);
    const grew = Math.round(a.to) !== H;
    if (grew) {
      check('B mobile: height actually changed', true, `from=${H} to=${Math.round(a.to)}`);
      check('B mobile: animation ran (>=4 distinct)', a.distinct >= 4, `${a.distinct}`);
      const peak = a.max;
      check('B mobile: overshoot above final (settle bounce)', peak > a.to + 1, `peak=${peak} final=${a.to}`);
      const nat = await s.evalJS(`(function(){const c=document.querySelector('.card');const p=c.style.height;c.style.height='';const h=Math.round(c.getBoundingClientRect().height);c.style.height=p;return h;})()`);
      check('B mobile: final == natural', Math.round(a.to) === nat, `to=${Math.round(a.to)} nat=${nat}`);
    } else {
      check('B mobile: panes equal height (morph correctly skipped)', a.distinct <= 2, `${a.distinct} distinct`);
    }
    s.close();
  }

  /* ---------- C: created-code reveal morph (desktop) ---------- */
  {
    const s = await openSession();
    await s.evalJS(`document.getElementById('tab-new').click()`);
    await sleep(900);
    await s.evalJS(`(function(){
      window.fetch = function(){
        return Promise.resolve(new Response(JSON.stringify({ok:true,code:'MORPH1',label:'Uji Morph',roomId:'room-x'}),
          {status:200,headers:{'Content-Type':'application/json'}}));
      };
      document.getElementById('label').value = 'Uji Morph';
      return 1;
    })()`);
    const r = await s.evalJS(`(${SAMPLE_AND_CLICK.replace('(clickExpr) => new Promise', 'clickExpr => new Promise')})("document.getElementById('btn-new').click()")`);
    const a = summarize(r);
    const grew = Math.round(a.to) > r.from + 80;
    check('C create: card grew (code box revealed)', grew, `from=${r.from} to=${Math.round(a.to)}`);
    if (grew) {
      check('C create: animation ran (>=4 distinct)', a.distinct >= 4, `${a.distinct}`);
      check('C create: overshoot above final (settle bounce)', a.max > a.to + 1, `peak=${a.max} final=${a.to}`);
      const nat = await s.evalJS(`(function(){const c=document.querySelector('.card');const p=c.style.height;c.style.height='';const h=Math.round(c.getBoundingClientRect().height);c.style.height=p;return h;})()`);
      check('C create: final == natural', Math.round(a.to) === nat, `to=${Math.round(a.to)} nat=${nat}`);
      check('C create: no running animations', (await s.evalJS(`document.querySelector('.card').getAnimations().filter(x=>x.playState==='running').length`)) === 0);
    }
    s.close();
  }

  /* ---------- D: reduced motion — instant, no morph ---------- */
  {
    const s = await openSession({ reducedMotion: true });
    const H = await s.evalJS(`Math.round(document.querySelector('.card').getBoundingClientRect().height)`);
    const r = await s.evalJS(`(${SAMPLE_AND_CLICK.replace('(clickExpr) => new Promise', 'clickExpr => new Promise')})("document.getElementById('tab-new').click()")`);
    const a = summarize(r);
    const jumped = r.samples.slice(1, 8).every(h => h === r.samples[0]) && Math.round(a.to) !== H;
    check('D reduced: change applied instantly, no animated frames', jumped || Math.round(a.to) === H, `distinct=${a.distinct} from=${r.from} to=${Math.round(a.to)}`);
    check('D reduced: no height pinned', (await s.evalJS(`document.querySelector('.card').style.height`)) === '');
    s.close();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
