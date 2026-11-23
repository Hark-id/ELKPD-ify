// Studio <-> projects backend (src/gate/projects.js). Everything here is
// optional: on a plain static server (scripts/dev-studio.mjs) /api/ doesn't
// exist, `cloud.available` stays false and the Studio is local-only.
const $ = (id) => document.getElementById(id);

export const cloud = { available: false, user: null, projects: [], registration: 'open' };

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not our API */ }
  if (!data) throw Object.assign(new Error('Server tidak menjawab.'), { status: res.status });
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Gagal (' + res.status + ')'), { status: res.status });
  return data;
}

/** Probe the backend and refresh who we are. */
export async function refreshMe() {
  try {
    const me = await api('/api/account/me');
    cloud.available = true;
    cloud.user = me.authed ? me.user : null;
    cloud.projects = me.authed ? me.projects : [];
    cloud.registration = me.registration || 'open';
  } catch {
    cloud.available = false; // static server, or accounts not enabled (501)
    cloud.user = null;
    cloud.projects = [];
  }
  renderAccount();
  return cloud;
}

export function renderAccount() {
  const btn = $('accountBtn');
  btn.hidden = !cloud.user;
  if (cloud.user) {
    btn.textContent = (cloud.user.display || cloud.user.username).trim().slice(0, 1).toUpperCase();
    $('accountName').textContent = `${cloud.user.display} (@${cloud.user.username})`;
  }
}

/** The sign-in / register dialog. Resolves true when signed in. */
export function authDialog(startWith = 'login') {
  return new Promise((resolve) => {
    const scrim = $('authScrim');
    const form = $('authForm');
    let mode = startWith;
    const setMode = (m) => {
      mode = m;
      for (const b of form.querySelectorAll('[data-auth]')) b.setAttribute('aria-checked', String(b.dataset.auth === m));
      $('authDisplayFld').hidden = m !== 'register';
      $('authCodeFld').hidden = m !== 'register' || cloud.registration !== 'code';
      $('authPass').autocomplete = m === 'register' ? 'new-password' : 'current-password';
      $('authSubmit').textContent = m === 'register' ? 'Buat akun' : 'Masuk';
      $('authErr').hidden = true;
    };
    form.querySelectorAll('[data-auth]').forEach((b) => { b.onclick = () => setMode(b.dataset.auth); });
    const close = (ok) => { scrim.hidden = true; form.onsubmit = null; resolve(ok); };
    $('authCancel').onclick = () => close(false);
    scrim.onclick = (e) => { if (e.target === scrim) close(false); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      $('authSubmit').disabled = true;
      try {
        const body = { username: $('authUser').value.trim().toLowerCase(), password: $('authPass').value };
        if (mode === 'register') { body.display = $('authDisplay').value.trim(); body.code = $('authCode').value.trim(); }
        await api('/api/account/' + mode, { method: 'POST', body });
        $('authPass').value = '';
        await refreshMe();
        close(true);
      } catch (err) {
        $('authErr').textContent = err.message;
        $('authErr').hidden = false;
      } finally {
        $('authSubmit').disabled = false;
      }
    };
    setMode(startWith);
    scrim.hidden = false;
    setTimeout(() => $('authUser').focus(), 30);
  });
}

export async function logout() {
  try { await api('/api/account/logout', { method: 'POST', body: {} }); } catch { /* cookie cleared anyway */ }
  cloud.user = null;
  cloud.projects = [];
  renderAccount();
}

export const projects = {
  create: (sheet) => api('/api/projects', { method: 'POST', body: JSON.stringify(sheet), raw: true }),
  publish: (id, sheet) => api(`/api/projects/${id}/sheet`, { method: 'PUT', body: JSON.stringify(sheet), raw: true }),
  async sheet(id) {
    const res = await fetch(`/api/projects/${id}/sheet`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('Lembar tidak bisa dimuat (' + res.status + ')');
    return { sheet: await res.json(), version: Number(res.headers.get('X-Sheet-Version') || 0) };
  },
  info: (id) => api(`/api/projects/${id}`),
  answers: (id) => api(`/api/projects/${id}/answers`),
  addRoom: (id, label) => api(`/api/projects/${id}/rooms`, { method: 'POST', body: { label } }),
  removeRoom: (id, roomId) => api(`/api/projects/${id}/rooms/delete`, { method: 'POST', body: { roomId } }),
  resetRoom: (id, roomId) => api(`/api/projects/${id}/rooms/reset`, { method: 'POST', body: { roomId } }),
  share: (id, username, role) => api(`/api/projects/${id}/share`, { method: 'POST', body: { username, role } }),
  remove: (id) => api(`/api/projects/${id}/delete`, { method: 'POST', body: {} }),
};
