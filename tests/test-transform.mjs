/* CDP verification for the login container transform (offline file:// harness).
   Renders gate-test.html / worksheet-test.html first (see commands at bottom). */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let PORT = 9300;
const GATE = 'file:///C:/Users/haufa/.zcode/workspace/draft-26cce703-4e51-4a8c-a6a1-75d67f686644/gate-test.html';
const SHEET = 'file:///C:/Users/haufa/.zcode/workspace/draft-26cce703-4e51-4a8c-a6a1-75d67f686644/worksheet-test.html';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openSession({ reducedMotion = false } = {}) {
  PORT += 1;
  const dir = mkdtempSync(join(tmpdir(), 'cdp-tf-'));
  const args = [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${dir}`, '--no-first-run', '--mute-audio',
    '--window-size=1280,900',
    ...(reducedMotion ? ['--force-prefers-reduced-motion'] : []),
    'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d; });
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('CDP never came up on port ' + PORT + ' — chrome stderr: ' + chromeErr.slice(0, 400));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const handlers = new Map();
  const exceptions = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.id && handlers.has(m.id)) { handlers.get(m.id)(m); handlers.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++mid;
    handlers.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async expr => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(6000).then(() => { throw new Error('evaluate timed out'); }),
    ]);
    if (r && r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r ? r.result.result.value : undefined;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    chrome, send, evalJS, exceptions,
    close() { ws.close(); try { chrome.kill(); } catch { } try { spawn('taskkill', ['/F', '/PID', String(chrome.pid), '/T']); } catch { } },
  };
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
}

async function main() {
  /* ---------- A: gate outbound morph (login success) ---------- */
  {
    const s = await openSession();
    await s.send('Page.navigate', { url: GATE });
    await sleep(1600);
    await s.evalJS(`(document.fonts ? document.fonts.ready.then(()=>1) : 1)`);
    await sleep(700); /* entrance settles */

    /* fire-and-forget sampler that survives the reload via sessionStorage */
    await s.evalJS(`(function(){
      const card = document.querySelector('.card');
      const log = [];
      const push = () => {
        const r = card.getBoundingClientRect();
        const first = card.children[0];
        log.push({l:Math.round(r.left), t:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height),
                  o: first ? Math.round((getComputedStyle(first).opacity)*100)/100 : 1});
      };
      push();  /* pre-click frame: the card at rest, tall and centered */
      const iv = setInterval(() => {
        const r = card.getBoundingClientRect();
        const first = card.children[0];
        log.push({l:Math.round(r.left), t:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height),
                  o: first ? Math.round((getComputedStyle(first).opacity)*100)/100 : 1});
        try { sessionStorage.setItem('morph-log', JSON.stringify({ log: log.slice(-90), handoff: sessionStorage.getItem('lkpd-handoff') })); } catch(e){}
        if (log.length > 120) clearInterval(iv);
      }, 16);
      window.fetch = function(){
        return Promise.resolve(new Response(JSON.stringify({ok:true,roomId:'room-x',label:'Uji'}),
          {status:200,headers:{'Content-Type':'application/json'}}));
      };
      localStorage.setItem('lkpd-cerpen-name:room-x', 'Uji');  /* returning user → straight to the bar */
      document.getElementById('code').value = 'MORPH01';
      return 1;
    })()`);
    await s.evalJS(`document.getElementById('btn-join').click()`);
    await sleep(2200); /* morph 650ms → reload → fresh gate */

    const rec = JSON.parse(await s.evalJS(`sessionStorage.getItem('morph-log') || 'null'`));
    check('A: morph log captured across reload', !!rec && Array.isArray(rec.log) && rec.log.length > 10, rec ? rec.log.length + ' frames' : 'null');
    if (rec) {
      const first = rec.log[0], last = rec.log[rec.log.length - 1];
      const cw = await s.evalJS(`document.documentElement.clientWidth`);
      const T = { l: 10, t: 10, w: cw - 20, h: 60 };
      check('A: handoff rect stored', !!rec.handoff, rec.handoff || '');
      if (rec.handoff) {
        const ho = JSON.parse(rec.handoff);
        check('A: handoff == bar geometry', ho.l === T.l && ho.t === T.t && ho.h === T.h && Math.abs(ho.w - T.w) <= 1, JSON.stringify(ho) + ' vs ' + JSON.stringify(T));
      }
      check('A: flight passed through the tall card', rec.log.some(f => f.h > 300), 'sampled');
      check('A: card ended at bar position', Math.abs(last.l - T.l) <= 2 && Math.abs(last.t - T.t) <= 2, `${last.l},${last.t}`);
      /* the last pre-reload tick lands in the settle tail — allow it */
      check('A: card ended at bar size (settle tail)', Math.abs(last.w - T.w) <= 2 && Math.abs(last.h - T.h) <= 25, `${last.w}x${last.h}`);
      check('A: content faded out', last.o < 0.05, `opacity=${last.o}`);
      const flew = rec.log.some(f => f.t < 145 && f.t > T.t + 2);
      check('A: flight passed through intermediate tops', flew, 'sampled');
    }
    /* after reload the gate is fresh: no lingering pin, handoff NOT consumed by the gate */
    const st = await s.evalJS(`JSON.stringify({pin: document.querySelector('.card').style.height || '', handoff: sessionStorage.getItem('lkpd-handoff')})`);
    const o = JSON.parse(st);
    check('A: reloaded gate has no pinned height', o.pin === '', o.pin);
    s.close();
  }

  /* ---------- B: worksheet inbound reveal (seeded handoff) ---------- */
  {
    const s = await openSession();
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{
        sessionStorage.setItem('lkpd-handoff', JSON.stringify({l:10,t:10,w:1265,h:60}));
        localStorage.setItem('lkpd-cerpen-name:test-room','Uji Tester');
        window.__blog = [];
        const iv = setInterval(() => {
          const v = document.getElementById('morph-veil');
          const m = document.querySelector('main');
          const p = document.querySelector('.dock-panel');
          if (v && m && p) {
            __blog.push({
              v: Math.round(getComputedStyle(v).opacity * 100) / 100,
              h: v.hidden,
              p: Math.round(getComputedStyle(p).opacity * 100) / 100,
              m: Math.round(getComputedStyle(m).opacity * 100) / 100
            });
          }
          if (__blog.length > 150) clearInterval(iv);
        }, 16);
      }catch(e){}`,
    });
    await s.send('Page.navigate', { url: SHEET });
    /* the veil sits near the end of a ~230KB document — poll until the
       parser reaches it (the reveal may already be fading by then) */
    let veilSeen = false;
    for (let i = 0; i < 60; i++) {
      await sleep(60);
      if (await s.evalJS(`!!document.getElementById('morph-veil')`)) { veilSeen = true; break; }
    }
    check('B: veil element parsed', veilSeen);
    const t0 = await s.evalJS(`JSON.stringify({
      veil: !document.getElementById('morph-veil').hidden,
      veilOp: getComputedStyle(document.getElementById('morph-veil')).opacity,
      morphing: document.documentElement.classList.contains('morphing'),
      mainOp: getComputedStyle(document.querySelector('main')).opacity,
      bar: (function(){const r=document.querySelector('.tool-dock').getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})()
    })`);
    const a = JSON.parse(t0);
    check('B: veil visible at first paint', a.veil && a.veilOp > 0.9, `op=${a.veilOp}`);
    check('B: morphing class pre-applied', a.morphing);
    check('B: document pre-hidden', parseFloat(a.mainOp) < 0.1, `main op=${a.mainOp}`);
    check('B: bar already at rest geometry', a.bar.l === 10 && a.bar.t === 10 && a.bar.h === 60, JSON.stringify(a.bar));

    /* the pre-navigation sampler ticks the WAAPI clock through the reveal */
    await sleep(1100);
    const blog = await s.evalJS(`window.__blog`);
    check('B: reveal sampled', blog.length > 20, blog.length + ' frames');
    const veilFade = blog.filter(b => b.v > 0.02 && b.v < 0.98).length;
    check('B: veil fading mid-reveal', veilFade > 3, veilFade + ' fading frames');
    check('B: veil hidden at end', blog.length > 0 && blog[blog.length - 1].h === true);
    check('B: bar contents appearing', blog[blog.length - 1].p > 0.9, `op=${blog[blog.length - 1].p}`);
    check('B: document revealed progressively', blog.some(b => b.m > 0.05 && b.m < 0.95), 'sampled');

    await sleep(900);
    const t2 = JSON.parse(await s.evalJS(`JSON.stringify({
      veilHidden: document.getElementById('morph-veil').hidden,
      morphing: document.documentElement.classList.contains('morphing'),
      handoff: sessionStorage.getItem('lkpd-handoff'),
      mainOp: getComputedStyle(document.querySelector('main')).opacity,
      running: document.querySelectorAll('.tool-dock > *').length
        ? Array.from(document.querySelectorAll('.tool-dock > *')).filter(el => el.getAnimations().some(x => x.playState === 'running')).length : -1
    })`));
    check('B: veil removed', t2.veilHidden);
    check('B: morphing class cleared', !t2.morphing);
    check('B: handoff consumed', t2.handoff === null, String(t2.handoff));
    check('B: document revealed', parseFloat(t2.mainOp) > 0.99, `op=${t2.mainOp}`);
    check('B: no running bar animations', t2.running === 0, String(t2.running));
    check('B: no page exceptions', s.exceptions.length === 0, s.exceptions.slice(0, 2).join(' | '));
    s.close();
  }

  /* ---------- D: gate name-stage flight (no saved name) ---------- */
  {
    const s = await openSession();
    await s.send('Page.navigate', { url: GATE });
    await sleep(1600);
    await s.evalJS(`(document.fonts ? document.fonts.ready.then(()=>1) : 1)`);
    await sleep(700);
    await s.evalJS(`(function(){
      const card = document.querySelector('.card');
      const log = [];
      const push = () => {
        const r = card.getBoundingClientRect();
        log.push({l:Math.round(r.left), t:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height)});
      };
      push();
      const iv = setInterval(() => {
        push();
        try { sessionStorage.setItem('morph-log', JSON.stringify({ log: log.slice(-90), handoff: sessionStorage.getItem('lkpd-handoff') })); } catch(e){}
        if (log.length > 120) clearInterval(iv);
      }, 16);
      window.fetch = function(){
        return Promise.resolve(new Response(JSON.stringify({ok:true,roomId:'room-fresh',label:'Uji Baru'}),
          {status:200,headers:{'Content-Type':'application/json'}}));
      };
      try { localStorage.removeItem('lkpd-cerpen-name:room-fresh'); } catch(e){}
      document.getElementById('code').value = 'MORPH01';
      window.__card0 = card.getBoundingClientRect();
      return 1;
    })()`);
    await s.evalJS(`document.getElementById('btn-join').click()`);
    await sleep(2200);
    const rec = JSON.parse(await s.evalJS(`sessionStorage.getItem('morph-log') || 'null'`));
    check('D: morph log captured', !!rec && rec.log.length > 5, rec ? rec.log.length + ' frames' : 'null');
    if (rec && rec.handoff) {
      const ho = JSON.parse(rec.handoff);
      const c0 = await s.evalJS(`JSON.parse(sessionStorage.getItem('morph-log')).log[0]`);
      const cw = await s.evalJS(`document.documentElement.clientWidth`);
      const cx = c0.l + c0.w / 2, cy = c0.t + c0.h / 2;
      const expL = Math.max(10, Math.min(Math.round(cx - 180), cw - 370));
      check('D: handoff stage is "name"', ho.stage === 'name', rec.handoff);
      check('D: name-card size', Math.abs(ho.w - 360) <= 2 && Math.abs(ho.h - 240) <= 2, `${ho.w}x${ho.h}`);
      check('D: name-card centred on the card', Math.abs(ho.l - expL) <= 2 && Math.abs(ho.t - Math.round(cy - 120)) <= 2, `${ho.l},${ho.t} vs ${expL},${Math.round(cy - 120)}`);
      const last = rec.log[rec.log.length - 1];
      check('D: card ended at name-card rect (settle tail)', Math.abs(last.w - ho.w) <= 2 && Math.abs(last.h - ho.h) <= 25 && Math.abs(last.l - ho.l) <= 2 && Math.abs(last.t - ho.t) <= 2, `${last.l},${last.t},${last.w}x${last.h}`);
    }
    s.close();
  }

  /* ---------- E: worksheet naming stage — two-flight reveal ---------- */
  {
    const s = await openSession();
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{sessionStorage.setItem('lkpd-handoff', JSON.stringify({stage:'name',l:451,t:281,w:360,h:240}));localStorage.removeItem('lkpd-cerpen-name:test-room')}catch(e){}`,
    });
    await s.send('Page.navigate', { url: SHEET });
    let seen = false;
    for (let i = 0; i < 60; i++) {
      await sleep(60);
      if (await s.evalJS(`!!document.getElementById('name-card')`)) { seen = true; break; }
    }
    check('E: name card parsed', seen);
    const t0 = JSON.parse(await s.evalJS(`JSON.stringify({
      veilOp: document.getElementById('morph-veil').hidden ? 'hidden' : getComputedStyle(document.getElementById('morph-veil')).opacity,
      morphing: document.documentElement.classList.contains('morphing'),
      stagename: document.documentElement.classList.contains('stagename'),
      ncHidden: document.getElementById('name-card').hidden,
      nc: (function(){const r=document.getElementById('name-card').getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})(),
      barVis: getComputedStyle(document.querySelector('.tool-dock')).visibility,
      mainOp: getComputedStyle(document.querySelector('main')).opacity
    })`));
    check('E: veil up during naming', parseFloat(t0.veilOp) > 0.9, `op=${t0.veilOp}`);
    check('E: morphing + stagename classes', t0.morphing && t0.stagename);
    check('E: name card shown at handoff rect', !t0.ncHidden && t0.nc.l === 451 && t0.nc.t === 281 && t0.nc.w === 360 && t0.nc.h === 240, JSON.stringify(t0.nc));
    check('E: bar out of sight during naming', t0.barVis === 'hidden', t0.barVis);
    check('E: document pre-hidden', parseFloat(t0.mainOp) < 0.1, `op=${t0.mainOp}`);

    /* submit the name — a resident sampler ticks the WAAPI clock and
       records the bar's second flight */
    await s.evalJS(`(function(){
      window.__elog = [];
      const bar = document.querySelector('.tool-dock');
      const iv = setInterval(() => {
        const r = bar.getBoundingClientRect();
        __elog.push({l:Math.round(r.left), t:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height)});
        if (__elog.length > 140) clearInterval(iv);
      }, 16);
      document.getElementById('nc-name').value = 'Tester';
      document.getElementById('name-form').dispatchEvent(new Event('submit', {cancelable:true}));
      return 1;
    })()`);
    await sleep(300);
    const elog = await s.evalJS(`window.__elog`);
    const grew = elog.some(f => f.w > 400 && f.w < 1220 && f.t < 281);
    check('E: bar visible mid-flight and growing', grew, elog.length + ' frames, last ' + JSON.stringify(elog[elog.length - 1]));

    await sleep(1100);
    const t2 = JSON.parse(await s.evalJS(`JSON.stringify({
      ncHidden: document.getElementById('name-card').hidden,
      veilHidden: document.getElementById('morph-veil').hidden,
      classes: document.documentElement.className,
      handoff: sessionStorage.getItem('lkpd-handoff'),
      savedName: localStorage.getItem('lkpd-cerpen-name:test-room'),
      mainOp: getComputedStyle(document.querySelector('main')).opacity,
      bar: (function(){const r=document.querySelector('.tool-dock').getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})()
    })`));
    const cw2 = await s.evalJS(`document.documentElement.clientWidth`);
    check('E: name card gone', t2.ncHidden);
    check('E: veil removed', t2.veilHidden);
    check('E: classes cleared', !t2.classes.includes('morphing') && !t2.classes.includes('stagename'), t2.classes);
    check('E: handoff consumed', t2.handoff === null, String(t2.handoff));
    check('E: name saved', t2.savedName === 'Tester', String(t2.savedName));
    check('E: document revealed', parseFloat(t2.mainOp) > 0.99, `op=${t2.mainOp}`);
    check('E: bar at rest geometry', t2.bar.l === 10 && t2.bar.t === 10 && Math.abs(t2.bar.w - (cw2 - 20)) <= 2 && t2.bar.h === 60, JSON.stringify(t2.bar));
    check('E: no page exceptions', s.exceptions.length === 0, s.exceptions.slice(0, 2).join(' | '));
    s.close();
  }

  /* ---------- C: reduced motion — no veil, instant reveal ---------- */
  {
    const s = await openSession({ reducedMotion: true });
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{sessionStorage.setItem('lkpd-handoff', JSON.stringify({l:10,t:10,w:1265,h:60}));localStorage.setItem('lkpd-cerpen-name:test-room','Uji Tester')}catch(e){}`,
    });
    await s.send('Page.navigate', { url: SHEET });
    await sleep(400);
    const r = JSON.parse(await s.evalJS(`JSON.stringify({
      veilHidden: document.getElementById('morph-veil').hidden,
      morphing: document.documentElement.classList.contains('morphing'),
      mainOp: getComputedStyle(document.querySelector('main')).opacity
    })`));
    check('C: no veil under reduced motion', r.veilHidden);
    check('C: no morphing class', !r.morphing);
    check('C: document visible immediately', parseFloat(r.mainOp) > 0.99, `op=${r.mainOp}`);
    s.close();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
