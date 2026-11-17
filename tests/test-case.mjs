/* Verifies the room-code field: what you SEE equals what is SENT.
   - typing lowercase uppercases the value (not just the display)
   - the caret does not jump when editing mid-string
   - the server still accepts any case (belt-and-braces) */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = mkdtempSync(join(tmpdir(), 'case-'));
const c = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9800', `--user-data-dir=${d}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let t = null;
for (let i = 0; i < 50; i++) { await sleep(200); try { const l = await (await fetch('http://127.0.0.1:9800/json/list')).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch { } }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const h = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 984000 + (++mid), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'C' } }));
  if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  if (m.id && h.has(m.id)) { h.get(m.id)(m); h.delete(m.id); }
};
const send = (me, p = {}) => new Promise(res => { const id = ++mid; h.set(id, res); ws.send(JSON.stringify({ id, method: me, params: p })); });
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240)); return r.result.result.value; };
let failures = 0;
const check = (n, cond, d2 = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + n + (d2 ? '  — ' + d2 : '')); if (!cond) failures++; };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'https://lkpd-cerpen-gate.pages.dev/' });
await sleep(2800);

/* type lowercase into the real field, the way a user would */
await ev(`(function(){
  var el=document.getElementById('code');
  el.focus();
  el.value='diagnosticroom';
  el.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;
})()`);
const typed = JSON.parse(await ev(`JSON.stringify((function(){
  var el=document.getElementById('code');
  return {value:el.value, display:getComputedStyle(el).textTransform,
          caret:el.selectionStart};
})())`));
console.log('after typing lowercase:', JSON.stringify(typed));
check('C1: the VALUE is uppercased, not just the display',
  typed.value === 'DIAGNOSTICROOM', typed.value);
check('C1: display transform still uppercase (visual match)',
  typed.display === 'uppercase', typed.display);
check('C1: caret preserved at the end', typed.caret === typed.value.length, 'caret=' + typed.caret);

/* mid-string edit must not jump the caret. NOTE: assigning el.value
   resets the caret to the end, so a real edit must be simulated with
   setRangeText (which preserves/advances the caret like typing does). */
const midEdit = JSON.parse(await ev(`JSON.stringify((function(){
  var el=document.getElementById("code");
  el.value="DIAGNOSTICROOM";
  el.focus();
  el.setSelectionRange(4,4);
  el.setRangeText("x", 4, 4, "end");   /* insert at position 4 */
  el.dispatchEvent(new Event("input",{bubbles:true}));
  return {value:el.value, caret:el.selectionStart};
})())`));
console.log("mid-string edit:", JSON.stringify(midEdit));
check("C2: mid-string edit keeps the caret position",
  midEdit.caret === 5, "caret=" + midEdit.caret);
check("C2: and still uppercases", midEdit.value === "DIAGXNOSTICROOM", midEdit.value);

/* the submitted value must be the uppercase one */
const sent = await ev(`(function(){
  var el=document.getElementById('code');
  el.value='diagnosticroom';
  el.dispatchEvent(new Event('input',{bubbles:true}));
  return el.value;
})()`);
check('C3: what would be submitted is uppercase', sent === 'DIAGNOSTICROOM', sent);

/* server-side tolerance still holds (belt and braces) */
const srv = JSON.parse(await ev(`(async function(){
  var out={};
  for (var i=0;i<3;i++){
    var code=['DIAGNOSTICROOM','diagnosticroom','DiAgNoStIcRoOm'][i];
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})});
    out[code]=r.status;
  }
  return JSON.stringify(out);
})()`));
console.log('server acceptance:', JSON.stringify(srv));
check('C4: server accepts any case (case-insensitive)',
  Object.keys(srv).every(k => srv[k] === 200), JSON.stringify(srv));

check('C5: no exceptions', errs.length === 0, errs.slice(0, 2).join(' | '));
c.kill();
console.log(failures === 0 ? '\nALL CASE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
