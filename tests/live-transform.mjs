/* Live end-to-end container transform on pages.dev: real DIAGNOSTICROOM login,
   gate morph → navigation → worksheet reveal. Captures screenshots at key moments. */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync } from 'fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'cdp-live-tf-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9410', `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try { const l = await (await fetch('http://127.0.0.1:9410/json/list')).json(); target = l.find(t => t.type === 'page'); if (target) break; } catch { }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const h = new Map(); const dialogs = []; const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message);
    ws.send(JSON.stringify({ id: 999999 + dialogs.length, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Uji E2E' } }));
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr, ms = 8000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => ({ TIMEOUT: true })),
  ]);
  if (r && r.TIMEOUT) throw new Error('evaluate timed out');
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(name, Buffer.from(r.result.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
/* pre-seed the collaboration name so no modal ever blocks the run */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.setItem('lkpd-cerpen-name:diag-diagnosticroom','Uji E2E')}catch(e){}`,
});
await send('Page.navigate', { url: LIVE });
await sleep(2200);
await ev(`document.fonts ? document.fonts.ready.then(()=>1) : 1`);
await sleep(800);

const H0 = await ev(`Math.round(document.querySelector('.card').getBoundingClientRect().top)`);
console.log('gate ready, card top =', H0);

/* submit the real code */
await ev(`document.getElementById('code').value = 'DIAGNOSTICROOM'`);
await ev(`document.getElementById('btn-join').click()`);
await sleep(300);
await shot('tf-1-gate-midflight.png');
const midFlight = await ev(`(function(){const r=document.querySelector('.card').getBoundingClientRect();return JSON.stringify({l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)})})()`);
console.log('gate mid-flight rect:', midFlight);

/* navigation fires at morph end (~650ms) */
await sleep(3500);
console.log('dialogs:', dialogs.length, 'exceptions:', exceptions.length);
const st = JSON.parse(await ev(`JSON.stringify({
  url: location.pathname,
  veil: !!document.getElementById('morph-veil'),
  veilOp: document.getElementById('morph-veil') && !document.getElementById('morph-veil').hidden ? getComputedStyle(document.getElementById('morph-veil')).opacity : 'hidden/gone',
  bar: (function(){const b=document.querySelector('.tool-dock');if(!b)return null;const r=b.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),r:getComputedStyle(b).borderRadius};})(),
  title: document.querySelector('.cover h1') ? document.querySelector('.cover h1').textContent.trim().slice(0,40) : null,
  mainOp: getComputedStyle(document.querySelector('main')).opacity
})`));
console.log('worksheet state:', JSON.stringify(st));
await shot('tf-2-worksheet.png');
await sleep(800);
await shot('tf-3-settled.png');
console.log('final dialogs:', dialogs, 'exceptions:', exceptions.slice(0, 2));
chrome.kill();
console.log('DONE');
process.exit(0);
