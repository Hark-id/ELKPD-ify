import { LANDING_HTML } from "./landing.js";
import { ADMIN_HTML } from "./admin.js";

/* ------------------------------------------------------------------
   Group worksheet — access gate + real-time collaboration

   Multi-room model (good-faith self-service):
     · Anyone may create a room and receives a private group code.
     · A code maps to exactly one room; a session is signed for that
       room only, so one group can never read or write another's work.
     · The original room keeps working via the GROUP_CODE secret, so
       an existing deployment is never disrupted by a new group.

   The worksheet HTML is never sent to a client that has not
   presented a valid code — the gate is server-side.
   ------------------------------------------------------------------ */

const COOKIE = "lkm_session";
const SESSION_DAYS = 7;

/* Room ids are used as Durable Object names and in signed tokens. */
const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/* ---------- tiny crypto helpers ---------- */

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

// Constant-time compare so code checks don't leak prefix timing.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* Codes are shown to humans: 6 characters, digits + capitals, and the
   alphabet drops I/1 and O/0 so hand-copied codes can't be misread. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

/* Normalise a typed code: uppercase, ignore spaces/dashes. */
function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/[\s-]/g, "");
}

/* ---------- session token: roomId.expiry.signature ---------- */

async function makeSession(secret, roomId) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${roomId}.${exp}`;
  const sig = await sha256(`${payload}.${secret}`);
  return `${payload}.${sig}`;
}

async function verifySession(secret, token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [roomId, exp, sig] = parts;
  if (!ROOM_RE.test(roomId)) return null;
  if (!Number(exp) || Number(exp) < Date.now()) return null;
  const expected = await sha256(`${roomId}.${exp}.${secret}`);
  return safeEqual(sig, expected) ? { roomId, exp: Number(exp) } : null;
}

function sessionCookie(token, url) {
  const base = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
  return url.protocol === "https:" ? base + "; Secure" : base;
}

/* ==================================================================
   Room registry — code → room
   One instance for the whole deployment; holds only hashes.
   ================================================================== */

/* RoomRegistry and WorksheetRoom live in the rooms Worker (deployed separately); this project binds to their namespaces via script_name. */
/* ==================================================================
   Worksheet room — one instance per group
   ================================================================== */

/* ==================================================================
   Worker entry
   ================================================================== */

async function gateHandler(request, env) {
    const url = new URL(request.url);
    const secret = env.SESSION_SECRET || "dev-secret-change-me";

    const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("global"));

    async function lookupCode(code) {
      const h = await sha256(normalizeCode(code));
      const r = await (await registry()).fetch("https://registry/lookup", {
        method: "POST",
        body: JSON.stringify({ codeHash: h }),
      });
      return r.json();
    }

    /* ---------------- create a room ---------------- */
    if (url.pathname === "/api/create" && request.method === "POST") {
      let label = "";
      try { label = String((await request.json()).label || "").trim().slice(0, 60); } catch {}

      const legacyCode = normalizeCode(env.GROUP_CODE || "");
      const reg = await registry();

      let code = "";
      let claimed = false;
      for (let attempt = 0; attempt < 6 && !claimed; attempt++) {
        code = makeCode();
        // Never hand out the original deployment's code.
        if (normalizeCode(code) === legacyCode) continue;

        const codeHash = await sha256(normalizeCode(code));
        const roomId = "room-" + randomHex(8);
        const res = await reg.fetch("https://registry/claim", {
          method: "POST",
          body: JSON.stringify({ codeHash, roomId, label, code }),
        });
        claimed = (await res.json()).ok === true;

        if (claimed) {
          const token = await makeSession(secret, roomId);
          return Response.json(
            { ok: true, code, label, roomId },
            { headers: { "Set-Cookie": sessionCookie(token, url) } }
          );
        }
      }

      return Response.json(
        { ok: false, error: "Gagal membuat kode. Coba lagi." },
        { status: 503 }
      );
    }

    /* ---------------- login ---------------- */
    if (url.pathname === "/api/login" && request.method === "POST") {
      let code = "";
      try { code = String((await request.json()).code || ""); } catch {}

      /* the admin console code is checked on the RAW input first — the
         room-code normaliser strips dashes/spaces, which are legal here.
         ADMIN + 6 keyboard-row symbols (~ to +). */
      const adminCode = env.ADMIN_CODE || "";
      if (adminCode && /^ADMIN[~`!@#$%^&*()\-_=+]{6}$/.test(code.trim())
          && safeEqual(await sha256(code.trim()), await sha256(adminCode))) {
        const token = await makeSession(secret, "admin-console");
        return Response.json(
          { ok: true, roomId: "admin-console", label: "Konsol Admin" },
          { headers: { "Set-Cookie": sessionCookie(token, url) } }
        );
      }

      const norm = normalizeCode(code);
      if (!norm) {
        return Response.json({ ok: false, error: "Masukkan kode grup." }, { status: 400 });
      }

      // 1) The original room keeps its code from the environment.
      const legacyCode = normalizeCode(env.GROUP_CODE || "");
      if (legacyCode && safeEqual(await sha256(norm), await sha256(legacyCode))) {
        const roomId = env.ROOM_ID || "kelompok-3";
        const token = await makeSession(secret, roomId);
        return Response.json(
          { ok: true, roomId, label: env.ROOM_LABEL || "Kelompok" },
          { headers: { "Set-Cookie": sessionCookie(token, url) } }
        );
      }

      // 2) Otherwise consult the registry.
      const found = await lookupCode(norm);
      if (!found.ok) {
        await new Promise(r => setTimeout(r, 400)); // blunts guessing
        return Response.json({ ok: false, error: "Kode grup salah." }, { status: 401 });
      }

      const token = await makeSession(secret, found.roomId);
      return Response.json(
        { ok: true, roomId: found.roomId, label: found.label || "Kelompok" },
        { headers: { "Set-Cookie": sessionCookie(token, url) } }
      );
    }

    /* ---------------- logout ---------------- */
    if (url.pathname === "/api/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    /* ---------------- resolve session ---------------- */
    const session = await verifySession(secret, readCookie(request, COOKIE));

    /* ---------------- websocket ---------------- */
    if (url.pathname === "/ws") {
      if (!session || session.roomId === "admin-console") return new Response("unauthorized", { status: 401 });
      const stub = env.ROOM.get(env.ROOM.idFromName(session.roomId));
      return stub.fetch(request);
    }

    if (url.pathname === "/api/session") {
      return Response.json(session
        ? { authed: true, roomId: session.roomId, admin: session.roomId === "admin-console" }
        : { authed: false });
    }

    /* ---------------- report a room (any group session) ---------------- */
    if (session && session.roomId !== "admin-console" && url.pathname === "/api/report" && request.method === "POST") {
      let note = "";
      try { note = String((await request.json()).note || "").slice(0, 200); } catch {}
      await (await registry()).fetch("https://registry/set-report", {
        method: "POST",
        body: JSON.stringify({ roomId: session.roomId, reported: 1, note })
      });
      return Response.json({ ok: true });
    }

    /* ---------------- admin console (session signed for admin-console) ---------------- */
    const isAdmin = session && session.roomId === "admin-console";
    if (isAdmin && url.pathname.startsWith("/api/admin/")) {
      const roomIdOf = async () => {
        try {
          const { roomId } = await request.json();
          return ROOM_RE.test(String(roomId || "")) ? roomId : null;
        } catch { return null; }
      };
      const roomStub = (roomId) => env.ROOM.get(env.ROOM.idFromName(roomId));

      if (url.pathname === "/api/admin/list") {
        const list = await (await registry()).fetch("https://registry/admin-list", { method: "POST", body: "{}" }).then(r => r.json());
        for (const room of list.rooms || []) {
          try {
            room.peers = (await (await roomStub(room.room_id).fetch("https://room/peer-count", { method: "POST" })).json()).peers || 0;
          } catch { room.peers = 0; }
        }
        return Response.json(list);
      }
      if (url.pathname === "/api/admin/room" && request.method === "POST") {
        const roomId = await roomIdOf();
        if (!roomId) return Response.json({ ok: false }, { status: 400 });
        const st = await (await roomStub(roomId).fetch("https://room/state", { method: "POST" })).json();
        return Response.json({ ok: true, roomId, answers: st.answers || {}, peers: st.peers || [] });
      }
      if (url.pathname === "/api/admin/reset" && request.method === "POST") {
        const roomId = await roomIdOf();
        if (!roomId) return Response.json({ ok: false }, { status: 400 });
        await roomStub(roomId).fetch("https://room/reset-http", { method: "POST" });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/admin/delete" && request.method === "POST") {
        const roomId = await roomIdOf();
        if (!roomId) return Response.json({ ok: false }, { status: 400 });
        await roomStub(roomId).fetch("https://room/reset-http", { method: "POST" });  /* purge answers */
        await (await registry()).fetch("https://registry/delete-room", {
          method: "POST", body: JSON.stringify({ roomId })
        });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/admin/report-clear" && request.method === "POST") {
        const roomId = await roomIdOf();
        if (!roomId) return Response.json({ ok: false }, { status: 400 });
        await (await registry()).fetch("https://registry/set-report", {
          method: "POST", body: JSON.stringify({ roomId, reported: 0, note: "" })
        });
        return Response.json({ ok: true });
      }
      /* known admin subpaths already returned above */
      return Response.json({ ok: false }, { status: 404 });
    }
    /* the admin API surface never falls through to the worksheet */
    if (url.pathname.startsWith("/api/admin/")) {
      return Response.json({ ok: false }, { status: 401 });
    }

    /* ---------------- unauthenticated: the gate ---------------- */
    if (!session) {
      return new Response(LANDING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    /* ---------------- authenticated admin: the console ---------------- */
    if (session.roomId === "admin-console") {
      return new Response(ADMIN_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    /* ---------------- authenticated: the worksheet ---------------- */
    const asset = await env.ASSETS.fetch(new URL("/worksheet.html", url));
    let html = await asset.text();

    // Resolve this room's own name/code from the registry so every
    // group sees its own identity, never the deployment defaults.
    let label = env.ROOM_LABEL || "Kelompok";
    let code = "";
    try {
      const info = await (await registry()).fetch("https://registry/by-room", {
        method: "POST",
        body: JSON.stringify({ roomId: session.roomId }),
      }).then(r => r.json());
      if (info.ok) { label = info.label; code = info.code; }
    } catch { /* fall back to the deployment default label */ }

    // Room scoping is injected server-side so the client cannot claim
    // a different room than the one its session was signed for.
    html = html
      .replaceAll("__ROOM_ID__", escHtml(session.roomId))
      .replaceAll("__ROOM_LABEL__", escHtml(label))
      .replaceAll("__ROOM_CODE__", escHtml(code));

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    });
}

export default {
  async fetch(request, env) {
    try {
      return await gateHandler(request, env);
    } catch (err) {
      return Response.json(
        { debugError: String((err && err.stack) || err).slice(0, 500) },
        { status: 500 }
      );
    }
  }
};
