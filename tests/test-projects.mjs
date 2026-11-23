/* Accounts + projects + live project rooms, end to end (#3, #12).
 * Runs against a deployment, or a local stack:
 *
 *   node scripts/sync.mjs
 *   (cd build/rooms && npx wrangler dev --port 8801)
 *   (cd build/gate && npx wrangler pages dev public --port 8802)
 *   ELKPD_URL=http://127.0.0.1:8802 node tests/test-projects.mjs
 *
 * A teacher registers, publishes an imported sheet, opens a room; two
 * students join with the code in separate browsers and see each other's
 * answers and presence live; the teacher sees the answers; a stranger
 * sees nothing. Needs `npm ci` in scripts/pdf-import (the importer runs
 * in Node to make the sheet). */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';
import { LIVE } from './helpers.mjs';

const BASE = LIVE.replace(/\/$/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  (' + extra + ')' : ''}`); if (!ok) failed++; };

/* a tiny cookie-keeping client for the API half */
function client() {
  const jar = new Map();
  return async (path, opts = {}) => {
    const res = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    let body = text; try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, headers: res.headers };
  };
}

// The sheet: the Studio's sample PDF through the real importer.
const pdfjsDir = join(root, 'scripts/pdf-import/node_modules/pdfjs-dist');
const pdfjs = await import(pathToFileURL(join(pdfjsDir, 'legacy/build/pdf.mjs')).href);
const { importPdf } = await import(pathToFileURL(join(root, 'src/sheet/import.js')).href);
const sheet = await importPdf(pdfjs, readFileSync(join(root, 'src/studio/samples/ekosistem-kolam.pdf')), { name: 'kolam.pdf', docOptions: { standardFontDataUrl: join(pdfjsDir, 'standard_fonts') + '/' } });

const teacher = client();
const user = 'uji' + Date.now().toString(36);
const reg = await teacher('/api/account/register', { method: 'POST', body: JSON.stringify({ username: user, password: 'kata-sandi-uji', display: 'Guru Uji' }) });
check('teacher registers', reg.body.ok === true, reg.status);
const made = await teacher('/api/projects', { method: 'POST', body: JSON.stringify(sheet) });
check('publishing a sheet creates a project', made.body.ok && /^prj-/.test(made.body.id), JSON.stringify(made.body).slice(0, 80));
const pid = made.body.id;
const room = await teacher(`/api/projects/${pid}/rooms`, { method: 'POST', body: JSON.stringify({ label: 'Kelompok Uji' }) });
check('a room gets a 6-character code', /^[A-Z2-9]{6}$/.test(room.body.room?.code || ''), room.body.room?.code);
const code = room.body.room.code;

const bad = await teacher('/api/projects', { method: 'POST', body: JSON.stringify({ ...sheet, pages: [{ ...sheet.pages[0], background: '<svg><script>alert(1)</script></svg>' }] }) });
check('a sheet with script in its background is refused', bad.status === 400);

const stranger = client();
await stranger('/api/account/register', { method: 'POST', body: JSON.stringify({ username: user + 'x', password: 'kata-sandi-uji' }) });
check('another account cannot open the project', (await stranger(`/api/projects/${pid}`)).status === 404);
check('another account cannot read its answers', (await stranger(`/api/projects/${pid}/answers`)).status === 404);

const joinRes = await stranger(`/j/${code}`);
check('join link redirects to the gate with the code', joinRes.status === 302 && (joinRes.headers.get('location') || '').endsWith('?code=' + code));

// ---- two students, two browsers
const a = await launch({ width: 1100, height: 900 });
const b = await launch({ width: 420, height: 860 });
try {
  async function joinRoom(br, name) {
    await br.goto(BASE + '/?code=' + code);
    await br.waitFor(`document.getElementById('code') && document.getElementById('code').value === ${JSON.stringify(code)}`);
    const res = await br.eval(`fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ${JSON.stringify(code)} }) }).then(r => r.json())`);
    await br.goto(BASE + '/');
    await br.waitFor(`!document.getElementById('nameScrim').hidden`);
    await br.eval(`(() => { document.getElementById('nameInput').value = ${JSON.stringify(name)}; document.getElementById('nameForm').requestSubmit(); })()`);
    await br.waitFor(`document.getElementById('status').classList.contains('on')`);
    return res;
  }
  const ja = await joinRoom(a, 'Ani');
  check('the join link prefills the code and logs in', ja.ok === true);
  await joinRoom(b, 'Budi');
  check('a project room serves the imported sheet', await a.eval(`document.getElementById('title').textContent`) === sheet.title);
  await a.waitFor(`document.querySelectorAll('.peer').length === 2`);
  check('both students appear online', true);

  // Ani types; Budi sees it
  await a.eval(`(() => { const t = document.getElementById('p1-f1'); t.focus(); t.value = 'ikan mas'; t.dispatchEvent(new Event('input')); })()`);
  await b.waitFor(`document.getElementById('p1-f1').value === 'ikan mas'`, 5000).then(() => check('an answer typed by one student appears for the other', true), () => check('an answer typed by one student appears for the other', false));
  await b.waitFor(`document.getElementById('p1-f1').dataset.peer`, 5000).then(() => check('presence: the other sees which field is being edited', true), () => check('presence: the other sees which field is being edited', false));

  // Budi writes a long answer on his phone-sized screen; it reflows there and syncs
  const long = 'Sinar matahari membantu fitoplankton berfotosintesis sehingga oksigen di kolam bertambah. '.repeat(6);
  await b.eval(`(() => { const t = document.querySelector('textarea[data-store]'); t.focus(); t.value = ${JSON.stringify(long)}; t.dispatchEvent(new Event('input')); window.__id = t.id; })()`);
  const tid = await b.eval('window.__id');
  await a.waitFor(`document.getElementById(${JSON.stringify(tid)}).value.length === ${long.length}`, 5000).then(() => check('a long answer syncs', true), () => check('a long answer syncs', false));
  await new Promise((r) => setTimeout(r, 300));
  check('and grows the page for the other student too', await a.eval(`document.querySelector('.esh-page').offsetHeight > ${Math.round(sheet.pages[0].height)}`));

  // reload keeps answers (server is the source of truth)
  await a.goto(BASE + '/');
  await a.waitFor(`document.getElementById('status').classList.contains('on') && document.getElementById('p1-f1').value === 'ikan mas'`, 10000)
    .then(() => check('answers survive a reload', true), () => check('answers survive a reload', false));

  // the teacher sees the room's answers
  const ans = await teacher(`/api/projects/${pid}/answers`);
  const r0 = (ans.body.rooms || [])[0] || {};
  check("the teacher sees the room's answers", r0.answers && r0.answers['p1-f1'] === 'ikan mas' && r0.answers[tid] === long);

  check('no page errors', a.errors.length + b.errors.length === 0, [...a.errors, ...b.errors].join(' | '));
} catch (e) {
  console.log('FAIL  suite crashed: ' + (e && e.stack || e));
  failed++;
} finally {
  await a.close();
  await b.close();
  await teacher(`/api/projects/${pid}/delete`, { method: 'POST', body: '{}' });
}
const gone = await client()('/api/login', { method: 'POST', body: JSON.stringify({ code }) });
check('deleting the project frees its room codes', gone.status === 401);
console.log(failed ? `\n${failed} check(s) failed` : '\nall project checks passed');
process.exit(failed ? 1 : 0);
