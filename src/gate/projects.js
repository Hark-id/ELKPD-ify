/* ------------------------------------------------------------------
   Accounts + projects API (#3; design: docs/design/projects.md)

   Teachers have accounts; students never do. A project is one imported
   worksheet (a sheet.json from the Studio) plus its rooms. Rooms are the
   same WorksheetRoom DOs and room codes as always: a project room just
   serves the project's sheet in the player instead of worksheet.html.

   This module only adds routes; _worker.js calls projectsApi() first and
   falls through to its own routes when it returns null.
   ------------------------------------------------------------------ */
import { validateSheet } from "./sheet/validate.js";

const USER_COOKIE = "elkpd_user";
const USER_DAYS = 30;
const PBKDF2_ITER = 100000; // the Workers WebCrypto maximum
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const ROLES = { viewer: 1, editor: 2, owner: 3 };
export const LEGACY_PROJECT = "lkpd-cerpen";

/* ---------- crypto ---------- */
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function pbkdf2(password, saltHex, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(password) {
  const salt = randomHex(16);
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
async function checkPassword(password, stored) {
  const [alg, iter, salt, want] = String(stored).split("$");
  if (alg !== "pbkdf2" || !salt || !want) return false;
  return safeEqual(await pbkdf2(password, salt, Number(iter)), want);
}

/* ---------- user session: userId.expiry.hmac ---------- */
async function makeUserToken(secret, userId) {
  const exp = Date.now() + USER_DAYS * 864e5;
  return `${userId}.${exp}.${await hmac(secret, `user.${userId}.${exp}`)}`;
}
async function readUserToken(secret, token) {
  if (!token) return null;
  const [userId, exp, sig] = token.split(".");
  if (!ID_RE.test(userId || "") || !(Number(exp) > Date.now()) || !sig) return null;
  return safeEqual(sig, await hmac(secret, `user.${userId}.${exp}`)) ? userId : null;
}
function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function userCookie(token, url, maxAge = USER_DAYS * 86400) {
  const base = `${USER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  return url.protocol === "https:" ? base + "; Secure" : base;
}

/* ---------- room codes (same alphabet and normaliser as _worker.js) ---------- */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
const normalizeCode = (input) => String(input || "").trim().toUpperCase().replace(/[\s-]/g, "");

/* ---------- DO plumbing ---------- */
const call = async (stub, path, data) => (await stub.fetch("https://do" + path, { method: "POST", body: JSON.stringify(data || {}) })).json();
const ok = (data, init) => Response.json({ ok: true, ...data }, init);
const err = (status, error) => Response.json({ ok: false, error }, { status });

/**
 * Handle /api/account/*, /api/projects/*, /api/room/sheet, /j/:code.
 * Returns null for anything else so _worker.js carries on.
 */
export async function projectsApi(request, env, url, roomSession) {
  const p = url.pathname;
  const isOurs = p.startsWith("/api/account/") || p === "/api/projects" || p.startsWith("/api/projects/") || p === "/api/room/sheet" || p.startsWith("/j/");
  if (!isOurs) return null;
  if (!env.ACCOUNTS || !env.PROJECT) return err(501, "Akun belum diaktifkan di server ini.");

  // State-changing requests must come from this site. SameSite=Lax already
  // keeps the cookie off cross-site POSTs; this also stops cross-site
  // requests that don't need the cookie (registration spam via a form).
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return err(403, "origin");
  }

  const secret = env.SESSION_SECRET || "dev-secret-change-me";
  const accounts = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("global"));
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const project = (id) => env.PROJECT.get(env.PROJECT.idFromName(id));
  const room = (id) => env.ROOM.get(env.ROOM.idFromName(id));
  const input = async () => { try { return await request.json(); } catch { return {}; } };
  const userId = await readUserToken(secret, readCookie(request, USER_COOKIE));
  const me = async () => (userId ? (await call(accounts, "/by-id", { id: userId })).user || null : null);

  /* ---------------- join link: /j/ABC123 -> the gate with the code filled in */
  if (p.startsWith("/j/")) {
    const code = normalizeCode(decodeURIComponent(p.slice(3))).slice(0, 20);
    return Response.redirect(new URL("/?code=" + encodeURIComponent(code), url).toString(), 302);
  }

  /* ---------------- the sheet for the room this browser is in */
  if (p === "/api/room/sheet") {
    if (!roomSession || roomSession.roomId === "admin-console") return err(401, "unauthorized");
    const info = await call(registry, "/by-room", { roomId: roomSession.roomId });
    if (!info.ok || !info.projectId || info.projectId === LEGACY_PROJECT) return err(404, "no sheet");
    const res = await project(info.projectId).fetch("https://do/sheet", { method: "POST" });
    return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }

  /* ---------------- accounts */
  if (p === "/api/account/me") {
    const user = await me();
    if (!user) return Response.json({ ok: true, authed: false, registration: env.REGISTER_CODE ? "code" : "open" });
    const { projects } = await call(accounts, "/memberships", { userId: user.id });
    return ok({ authed: true, user, projects });
  }
  if (p === "/api/account/register" && request.method === "POST") {
    const b = await input();
    const username = String(b.username || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (env.REGISTER_CODE && !safeEqual(await sha256(String(b.code || "")), await sha256(env.REGISTER_CODE))) return err(403, "Kode pendaftaran salah.");
    if (!USERNAME_RE.test(username)) return err(400, "Nama pengguna 3–32 karakter: huruf kecil, angka, titik, - atau _.");
    if (password.length < 8 || password.length > 200) return err(400, "Kata sandi minimal 8 karakter.");
    const res = await call(accounts, "/create", { username, display: String(b.display || username).trim().slice(0, 60) || username, pw: await hashPassword(password) });
    if (!res.ok) return err(409, "Nama pengguna sudah dipakai.");
    return ok({ user: res.user }, { headers: { "Set-Cookie": userCookie(await makeUserToken(secret, res.user.id), url) } });
  }
  if (p === "/api/account/login" && request.method === "POST") {
    const b = await input();
    const found = await call(accounts, "/find", { username: String(b.username || "").trim().toLowerCase() });
    if (found.ok && found.lockedUntil > Date.now()) return err(429, "Terlalu banyak percobaan. Coba lagi sebentar lagi.");
    const good = found.ok && await checkPassword(String(b.password || ""), found.pw);
    if (found.ok) await call(accounts, "/login-result", { id: found.user.id, ok: good });
    if (!good) { await new Promise((r) => setTimeout(r, 400)); return err(401, "Nama pengguna atau kata sandi salah."); }
    return ok({ user: found.user }, { headers: { "Set-Cookie": userCookie(await makeUserToken(secret, found.user.id), url) } });
  }
  if (p === "/api/account/logout") {
    return ok({}, { headers: { "Set-Cookie": userCookie("", url, 0) } });
  }

  /* ---------------- projects: everything below needs an account */
  const user = await me();
  if (!user) return err(401, "Masuk dulu.");

  if (p === "/api/projects" && request.method === "POST") {
    const text = await request.text();
    const v = validateSheet(text);
    if (!v.ok) return err(400, "Lembar tidak valid: " + v.error);
    const id = "prj-" + randomHex(8);
    const title = String(v.sheet.title || "Tanpa judul").slice(0, 120);
    const stub = project(id);
    await call(stub, "/init", { id, title, ownerId: user.id, ownerName: user.username });
    await stub.fetch("https://do/publish?by=" + encodeURIComponent(user.username), { method: "POST", body: text });
    await call(accounts, "/set-membership", { userId: user.id, projectId: id, role: "owner", title });
    return ok({ id, version: 1 });
  }

  const m = /^\/api\/projects\/([a-zA-Z0-9_-]{1,64})(\/[a-z/-]*)?$/.exec(p);
  if (!m) return err(404, "not found");
  const pid = m[1], sub = m[2] || "";
  const stub = project(pid);
  const { role, title } = await call(stub, "/role", { userId: user.id });
  if (!role) return err(404, "Proyek tidak ditemukan.");
  const need = (r) => ROLES[role] >= ROLES[r];

  if (sub === "" && request.method === "GET") {
    return ok({ role, project: (await call(stub, "/info")).project });
  }
  if (sub === "/sheet" && request.method === "GET") {
    const res = await stub.fetch("https://do/sheet", { method: "POST" });
    return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Sheet-Version": res.headers.get("X-Sheet-Version") || "" } });
  }
  if (sub === "/sheet" && request.method === "PUT") {
    if (!need("editor")) return err(403, "Hanya penyunting yang bisa menerbitkan.");
    const text = await request.text();
    const v = validateSheet(text);
    if (!v.ok) return err(400, "Lembar tidak valid: " + v.error);
    const res = await (await stub.fetch("https://do/publish?by=" + encodeURIComponent(user.username), { method: "POST", body: text })).json();
    const newTitle = String(v.sheet.title || "").slice(0, 120);
    if (newTitle && newTitle !== title) {
      await call(stub, "/set-title", { title: newTitle });
      await call(accounts, "/retitle", { projectId: pid, title: newTitle });
    }
    return ok({ version: res.version });
  }
  if (sub === "/rooms" && request.method === "POST") {
    if (!need("editor")) return err(403, "Hanya penyunting yang bisa membuat ruang.");
    const label = String((await input()).label || "").trim().slice(0, 60) || "Kelompok";
    const legacy = normalizeCode(env.GROUP_CODE || "");
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode();
      if (code === legacy) continue;
      const roomId = "room-" + randomHex(8);
      const claimed = await call(registry, "/claim", { codeHash: await sha256(code), roomId, label, code, projectId: pid });
      if (claimed.ok) {
        await call(stub, "/add-room", { roomId, label, code });
        return ok({ room: { id: roomId, label, code } });
      }
    }
    return err(503, "Gagal membuat kode. Coba lagi.");
  }
  if (sub === "/rooms/delete" && request.method === "POST") {
    if (!need("editor")) return err(403, "Hanya penyunting yang bisa menghapus ruang.");
    const { roomId } = await input();
    const info = await call(stub, "/info");
    if (!ID_RE.test(String(roomId || "")) || !info.project.rooms.some((r) => r.id === roomId)) return err(404, "Ruang tidak ditemukan.");
    await room(roomId).fetch("https://room/reset-http", { method: "POST" });
    await call(registry, "/delete-room", { roomId });
    await call(stub, "/remove-room", { roomId });
    return ok({});
  }
  if (sub === "/rooms/reset" && request.method === "POST") {
    if (!need("editor")) return err(403, "Hanya penyunting yang bisa mengosongkan ruang.");
    const { roomId } = await input();
    const info = await call(stub, "/info");
    if (!info.project.rooms.some((r) => r.id === roomId)) return err(404, "Ruang tidak ditemukan.");
    await room(roomId).fetch("https://room/reset-http", { method: "POST" });
    return ok({});
  }
  if (sub === "/answers" && request.method === "GET") {
    const info = await call(stub, "/info");
    const rooms = await Promise.all(info.project.rooms.map(async (r) => {
      try {
        const st = await (await room(r.id).fetch("https://room/state", { method: "POST" })).json();
        return { ...r, answers: st.answers || {}, peers: (st.peers || []).map((q) => ({ name: q.name, focus: q.focus })) };
      } catch { return { ...r, answers: {}, peers: [] }; }
    }));
    return ok({ rooms });
  }
  if (sub === "/share" && request.method === "POST") {
    if (!need("owner")) return err(403, "Hanya pemilik yang bisa mengatur akses.");
    const b = await input();
    const target = await call(accounts, "/find", { username: String(b.username || "").trim().toLowerCase() });
    if (!target.ok) return err(404, "Pengguna tidak ditemukan.");
    if (target.user.id === user.id) return err(400, "Itu akun Anda sendiri.");
    const newRole = b.role && b.role !== "owner" && ROLES[b.role] ? b.role : null;
    await call(stub, "/set-member", { userId: target.user.id, username: target.user.username, role: newRole });
    await call(accounts, "/set-membership", { userId: target.user.id, projectId: pid, role: newRole, title });
    return ok({ project: (await call(stub, "/info")).project });
  }
  if (sub === "/delete" && request.method === "POST") {
    if (!need("owner")) return err(403, "Hanya pemilik yang bisa menghapus proyek.");
    const gone = await call(stub, "/delete");
    for (const rid of gone.rooms || []) {
      await room(rid).fetch("https://room/reset-http", { method: "POST" });
      await call(registry, "/delete-room", { roomId: rid });
    }
    for (const uid of gone.members || []) await call(accounts, "/set-membership", { userId: uid, projectId: pid, role: null });
    return ok({});
  }
  return err(404, "not found");
}

/** For the worksheet route: which project does this room serve? */
export async function roomProject(env, roomId) {
  try {
    const info = await call(env.REGISTRY.get(env.REGISTRY.idFromName("global")), "/by-room", { roomId });
    return info.ok ? info.projectId || LEGACY_PROJECT : LEGACY_PROJECT;
  } catch { return LEGACY_PROJECT; }
}
