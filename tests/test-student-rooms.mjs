/* Student rooms from a PDF (#15): no teacher, no account.
 * A student imports the teacher's PDF in the Studio's group mode and gets a
 * room; a classmate joins with the code and they sync; the room's sheet can
 * be fixed from inside the room; a teacher project's sheet cannot.
 * Runs against a deployment or the local stack (see README):
 *   ELKPD_URL=http://127.0.0.1:8802 node tests/test-student-rooms.mjs      */
import { launch } from './cdp.mjs';
import { LIVE } from './helpers.mjs';

const BASE = LIVE.replace(/\/$/, '');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  (' + extra + ')' : ''}`); if (!ok) failed++; };
const answerDialogs = (b, text) => b.on((m) => { if (m.method === 'Page.javascriptDialogOpening') b.send('Page.handleJavaScriptDialog', { accept: true, promptText: text }); });

const A = await launch({ width: 1280, height: 860 });
const B = await launch({ width: 420, height: 860 });
answerDialogs(A, 'Kelompok Mawar');
let code = '';
try {
  // ---- the landing links to it
  await A.goto(BASE + '/');
  check('the landing offers "Buat ruang dari PDF"', await A.eval(`!!document.querySelector('a[href="/studio/?untuk=kelompok"]')`));

  // ---- Studio, group mode: import, then one button to a room
  await A.goto(BASE + '/studio/?untuk=kelompok');
  check('group mode speaks to students', await A.eval(`document.querySelector('.drop h1').textContent.includes('kelompok')`));
  check('group mode shows no account UI', await A.eval(`document.getElementById('cloudBox').hidden && document.getElementById('accountBtn').hidden`));
  await A.eval(`document.getElementById('sampleBtn').click()`);
  await A.waitFor(`!document.getElementById('editor').hidden && document.querySelector('.esh-sheet')?.dataset.ready`, 60000);
  check('the main button creates a room', await A.eval(`document.getElementById('exportBtn').textContent`) === 'Buat ruang');
  await A.eval(`document.getElementById('exportBtn').click()`);
  await A.waitFor(`document.getElementById('askForm')`);
  await A.eval(`document.getElementById('askInput').value = 'Kelompok Mawar'; document.getElementById('askForm').requestSubmit()`);
  await A.waitFor(`location.pathname === '/' && document.body.dataset.room`, 30000);
  code = await A.eval(`document.body.dataset.code`);
  check('the student lands in their new room with a code', /^[A-Z2-9]{6}$/.test(code) && await A.eval(`document.body.dataset.label`) === 'Kelompok Mawar', code);
  check('no account cookie was involved', !(await A.eval(`document.cookie`)).includes('elkpd_user'));
  await A.waitFor(`!document.getElementById('nameScrim').hidden`);
  await A.eval(`document.getElementById('nameInput').value='Sari'; document.getElementById('nameForm').requestSubmit()`);
  await A.waitFor(`document.getElementById('status').classList.contains('on')`);
  check('the share notice shows the code', await A.eval(`document.getElementById('note').textContent.includes(${JSON.stringify(code)})`));
  check('room menu offers fixing the sheet and rooms for other groups', await A.eval(`!document.getElementById('fixSheetBtn').hidden && !document.getElementById('newRoomBtn').hidden`));

  // ---- a classmate joins with the code and they sync
  await B.goto(BASE + '/j/' + code);
  await B.waitFor(`document.getElementById('code')?.value === ${JSON.stringify(code)}`);
  await B.eval(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:${JSON.stringify(code)}})})`);
  await B.goto(BASE + '/');
  await B.waitFor(`!document.getElementById('nameScrim').hidden`);
  await B.eval(`document.getElementById('nameInput').value='Tono'; document.getElementById('nameForm').requestSubmit()`);
  await B.waitFor(`document.getElementById('status').classList.contains('on')`);
  await A.eval(`(() => { const t = document.getElementById('p1-f1'); t.focus(); t.value = 'Sari & Tono'; t.dispatchEvent(new Event('input')); })()`);
  await B.waitFor(`document.getElementById('p1-f1').value === 'Sari & Tono'`, 5000)
    .then(() => check('a classmate sees the answer live', true), () => check('a classmate sees the answer live', false));

  // ---- fix the sheet from inside the room
  await A.goto(BASE + '/studio/?ruang=edit');
  await A.waitFor(`!document.getElementById('editor').hidden && document.querySelector('.esh-sheet')?.dataset.ready`, 30000);
  check("room edit mode opens the room's sheet", await A.eval(`document.getElementById('exportBtn').textContent`) === 'Simpan ke ruang');
  await A.eval(`(() => { const i = document.getElementById('title'); i.value = 'Ekosistem Kolam (diperbaiki)'; i.dispatchEvent(new Event('change')); })()`);
  await A.eval(`document.getElementById('exportBtn').click()`);
  await A.waitFor(`location.pathname === '/' && document.getElementById('title').textContent === 'Ekosistem Kolam (diperbaiki)'`, 30000)
    .then(() => check('saving brings the student back into the room with the fixed sheet', true), () => check('saving brings the student back into the room with the fixed sheet', false));
  await A.waitFor(`document.getElementById('p1-f1').value === 'Sari & Tono'`, 10000)
    .then(() => check('answers survive the fix', true), () => check('answers survive the fix', false));

  // ---- a room for another group, same sheet
  await A.eval(`document.getElementById('moreBtn').click(); document.getElementById('newRoomBtn').click()`);
  await A.waitFor(`!document.getElementById('askScrim').hidden`);
  await A.eval(`document.getElementById('askInput').value = 'Kelompok Melati'; document.getElementById('askForm').requestSubmit()`);
  const other = await A.waitFor(`(/Kode: ([A-Z2-9]{6})/.exec(document.getElementById('note').textContent) || [])[1]`, 10000).catch(() => '');
  check('"Ruang untuk kelompok lain" makes a room with its own code', /^[A-Z2-9]{6}$/.test(other) && other !== code, other);

  // ---- a teacher's project can't be edited from a room session
  const jar = [];
  const api = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', Cookie: jar.join('; '), ...(o.headers || {}) } }); for (const c of r.headers.getSetCookie()) jar.push(c.split(';')[0]); return { status: r.status, body: await r.json().catch(() => null) }; };
  await api('/api/account/register', { method: 'POST', body: JSON.stringify({ username: 'guru' + Date.now().toString(36), password: 'kata-sandi-guru' }) });
  const sheet = await A.eval(`fetch('/api/room/sheet').then(r => r.json())`);
  const prj = await api('/api/projects', { method: 'POST', body: JSON.stringify(sheet) });
  const troom = await api(`/api/projects/${prj.body.id}/rooms`, { method: 'POST', body: '{}' });
  const tcode = troom.body.room.code;
  await B.eval(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:${JSON.stringify(tcode)}})})`);
  const put = await B.eval(`fetch('/api/room/sheet',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`);
  check("a teacher project's sheet cannot be changed from a room", put === 403, put);
  check('and its room page hides the fix/new-room menu', await B.eval(`fetch('/api/room/sheet').then(r=>r.headers.get('X-Sheet-Editable'))`) === '0');
  await api(`/api/projects/${prj.body.id}/delete`, { method: 'POST', body: '{}' });

  // ---- a whole class behind one school IP is not an attacker (review on #16)
  const tiny = await A.eval(`fetch('/api/room/sheet').then(r => r.json())`);
  const ipHeaders = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.' + (1 + Math.floor(Math.random() * 250)) };
  const made = [];
  for (let k = 0; k < 12; k++) {
    const r = await fetch(BASE + '/api/rooms/from-sheet?label=K' + k, { method: 'POST', headers: ipHeaders, body: JSON.stringify(tiny) });
    made.push(r.status);
    if (k === 0) {
      const c = r.headers.get('set-cookie') || '';
      check('the room cookie is HttpOnly and SameSite=Lax, like /api/login', /lkm_session=/.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c), c.replace(/=[^;]+/, '=…'));
    }
  }
  check('12 groups on one school IP can all make rooms', made.every((x) => x === 200), made.join(','));

  // ---- deleting: the room's code dies, and nothing is left behind
  await A.goto(BASE + '/');
  await A.waitFor(`document.getElementById('status').classList.contains('on')`);
  // confirm() is accepted by the answerDialogs handler set up at the top
  await A.eval(`document.getElementById('moreBtn').click(); document.getElementById('deleteRoomBtn').click()`);
  await A.waitFor(`location.pathname === '/' && !document.body.dataset.room && document.getElementById('code')`, 15000)
    .then(() => check('"Hapus ruang ini" deletes the room and returns to the start', true), () => check('"Hapus ruang ini" deletes the room and returns to the start', false));
  const dead = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  check("a deleted room's code no longer opens anything", dead.status === 401, dead.status);

  check('no page errors', A.errors.length + B.errors.length === 0, [...A.errors, ...B.errors].join(' | '));
} catch (e) {
  console.log('FAIL  suite crashed: ' + (e && e.stack || e));
  failed++;
} finally {
  await A.close(); await B.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall student-room checks passed');
process.exit(failed ? 1 : 0);
