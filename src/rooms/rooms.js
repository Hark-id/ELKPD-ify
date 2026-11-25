/* Rooms Worker — hosts the two Durable Object classes only.
   The gate/Pages project binds to these namespaces via script_name,
   so this Worker has no routes of its own. */

/* ---- WorksheetRoom: one instance per group ---- */
export class WorksheetRoom {
  constructor(state, env) {
    this.ctx = state;
    this.env = env;

    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS answers (
        field TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    /* ws -> { id, name, focus } */
    this.sockets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") return this.handleWebSocket(request, url);

    if (url.pathname === "/state") {
      const rows = this.sql.exec("SELECT field, value FROM answers").toArray();
      const answers = {};
      for (const r of rows) answers[r.field] = r.value;
      return Response.json({ answers, peers: this.peerList() });
    }

    /* light probe for the admin console: who is online right now */
    if (url.pathname === "/peer-count") {
      return Response.json({ peers: this.sockets.size });
    }

    /* admin actions over this room (authorised by the gate's admin session) */
    if (url.pathname === "/reset-http") {
      this.sql.exec("DELETE FROM answers");
      this.broadcast({ type: "reset" });
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  peerList() {
    return [...this.sockets.values()].map(s => ({
      id: s.id, name: s.name, focus: s.focus,
    }));
  }

  broadcast(msg, except = null) {
    const data = JSON.stringify(msg);
    for (const [ws] of this.sockets) {
      if (ws === except) continue;
      try { ws.send(data); } catch { /* closing */ }
    }
  }

  async handleWebSocket(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const peerId = url.searchParams.get("pid") || crypto.randomUUID();
    const name = (url.searchParams.get("name") || "Anggota").slice(0, 40);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.sockets.set(server, { id: peerId, name, focus: null });

    const rows = this.sql.exec("SELECT field, value FROM answers").toArray();
    const answers = {};
    for (const r of rows) answers[r.field] = r.value;

    server.send(JSON.stringify({
      type: "init",
      answers,
      peers: this.peerList(),
      you: { id: peerId, name },
    }));

    this.broadcast({ type: "peers", peers: this.peerList() }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const peer = this.sockets.get(ws);
    if (!peer) return;

    if (msg.type === "edit") {
      const field = String(msg.field || "").slice(0, 80);
      /* one answer is at most 20k characters: a room's answers are sent
         whole to every member and aggregated for the teacher's view */
      const value = String(msg.value ?? "").slice(0, 20000);
      if (!field) return;
      /* a room holds one sheet's answers; refuse to grow without bound */
      const known = this.sql.exec("SELECT 1 FROM answers WHERE field = ?", field).toArray().length;
      if (!known && this.sql.exec("SELECT COUNT(*) AS n FROM answers").one().n >= 2000) return;

      this.sql.exec(
        `INSERT INTO answers (field, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        field, value, Date.now()
      );

      this.broadcast({ type: "edit", field, value, by: peer.id, byName: peer.name }, ws);
      return;
    }

    if (msg.type === "focus") {
      peer.focus = msg.field ? String(msg.field).slice(0, 80) : null;
      this.broadcast({ type: "peers", peers: this.peerList() });
      return;
    }

    if (msg.type === "name") {
      peer.name = String(msg.name || "Anggota").slice(0, 40);
      this.broadcast({ type: "peers", peers: this.peerList() });
      return;
    }

    if (msg.type === "reset") {
      this.sql.exec("DELETE FROM answers");
      this.broadcast({ type: "reset" });
      return;
    }
  }

  async webSocketClose(ws) {
    this.sockets.delete(ws);
    this.broadcast({ type: "peers", peers: this.peerList() });
  }

  async webSocketError(ws) {
    this.sockets.delete(ws);
    this.broadcast({ type: "peers", peers: this.peerList() });
  }
}

/* ---- RoomRegistry: code -> room, one global instance ---- */
export class RoomRegistry {
  constructor(state, env) {
    this.ctx = state;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code_hash TEXT PRIMARY KEY,
        room_id   TEXT NOT NULL,
        code      TEXT NOT NULL,
        label     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rooms_by_id ON rooms (room_id);
    `);

    try {
      this.sql.exec("ALTER TABLE rooms ADD COLUMN code TEXT NOT NULL DEFAULT ''");
    } catch { /* column exists */ }
    try {
      this.sql.exec("ALTER TABLE rooms ADD COLUMN reported INTEGER NOT NULL DEFAULT 0");
    } catch { /* column exists */ }
    try {
      this.sql.exec("ALTER TABLE rooms ADD COLUMN report_note TEXT NOT NULL DEFAULT ''");
    } catch { /* column exists */ }
    /* which project's sheet a room serves; every pre-project room is the
       hand-built LKPD (docs/design/projects.md, "Migration") */
    try {
      this.sql.exec("ALTER TABLE rooms ADD COLUMN project_id TEXT NOT NULL DEFAULT 'lkpd-cerpen'");
    } catch { /* column exists */ }

    /* permanent disposable diagnostics room (DIAGNOSTICROOM) — seeded once
       per cold start so it exists on every deployment */
    this.ctx.blockConcurrencyWhile(async () => {
      const enc = new TextEncoder();
      const digest = await crypto.subtle.digest("SHA-256", enc.encode("DIAGNOSTICROOM"));
      const diagHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
      this.sql.exec(
        `INSERT OR IGNORE INTO rooms (code_hash, room_id, code, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        diagHash, "diag-diagnosticroom", "DIAGNOSTICROOM", "Ruang Diagnostik", Date.now()
      );
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/claim" && request.method === "POST") {
      const { codeHash, roomId, label, code, projectId } = await request.json();

      if (!codeHash || !roomId || !code) {
        return Response.json({ ok: false }, { status: 400 });
      }

      this.sql.exec(
        `INSERT OR IGNORE INTO rooms (code_hash, room_id, code, label, created_at, project_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        codeHash, roomId, String(code).slice(0, 20), String(label || "").slice(0, 60), Date.now(),
        /^[a-zA-Z0-9_-]{1,64}$/.test(String(projectId || "")) ? projectId : "lkpd-cerpen"
      );

      const took = this.sql.exec("SELECT changes() AS n").one().n === 1;
      return Response.json({ ok: took });
    }

    if (url.pathname === "/lookup" && request.method === "POST") {
      const { codeHash } = await request.json();
      if (!codeHash) return Response.json({ ok: false }, { status: 400 });

      const row = this.sql
        .exec("SELECT room_id, label, project_id FROM rooms WHERE code_hash = ?", codeHash)
        .toArray()[0];

      return Response.json(row ? { ok: true, roomId: row.room_id, label: row.label, projectId: row.project_id } : { ok: false });
    }

    if (url.pathname === "/by-room" && request.method === "POST") {
      const { roomId } = await request.json();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(roomId || ""))) {
        return Response.json({ ok: false }, { status: 400 });
      }

      const row = this.sql
        .exec("SELECT label, code, project_id FROM rooms WHERE room_id = ?", roomId)
        .toArray()[0];

      return Response.json(row
        ? { ok: true, label: row.label, code: row.code, projectId: row.project_id }
        : { ok: false });
    }

    /* ---- admin console routes (authorised by the gate) ---- */
    if (url.pathname === "/admin-list" && request.method === "POST") {
      const rooms = this.sql.exec(
        "SELECT room_id, code, label, created_at, reported, report_note, project_id FROM rooms ORDER BY created_at DESC"
      ).toArray();
      return Response.json({ ok: true, rooms });
    }

    if (url.pathname === "/set-report" && request.method === "POST") {
      const { roomId, reported, note } = await request.json();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(roomId || ""))) {
        return Response.json({ ok: false }, { status: 400 });
      }
      this.sql.exec(
        "UPDATE rooms SET reported = ?, report_note = ? WHERE room_id = ?",
        reported ? 1 : 0, String(note || "").slice(0, 200), roomId
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/delete-room" && request.method === "POST") {
      const { roomId } = await request.json();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(roomId || ""))) {
        return Response.json({ ok: false }, { status: 400 });
      }
      this.sql.exec("DELETE FROM rooms WHERE room_id = ?", roomId);
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch() {
    return new Response("rooms worker", { status: 200 });
  }
};

/* ==================================================================
   Accounts + projects (#3; design: docs/design/projects.md)
   Internal APIs only: every route is called by the gate, which does
   the authentication (password hashing, sessions, roles). Nothing here
   is reachable from the internet: this Worker has no routes.
   ================================================================== */

const json = (data, status = 200) => Response.json(data, { status });
async function body(request) { try { return await request.json(); } catch { return {}; } }

/* ---- AccountStore: one global instance ---- */
export class AccountStore {
  constructor(state) {
    this.ctx = state;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display TEXT NOT NULL,
        pw TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attempts (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
      );
    `);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const b = await body(request);
    const user = (row) => row && { id: row.id, username: row.username, display: row.display };

    if (path === '/create') {
      const id = 'usr-' + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('');
      try {
        this.sql.exec('INSERT INTO users (id, username, display, pw, created_at) VALUES (?, ?, ?, ?, ?)',
          id, String(b.username), String(b.display || b.username).slice(0, 60), String(b.pw), Date.now());
      } catch { return json({ ok: false, error: 'taken' }); }
      return json({ ok: true, user: { id, username: b.username, display: b.display || b.username } });
    }
    /* Throttling, keyed by the gate ("login:<ip>:<user>", "login-ip:<ip>",
       "register:<ip>"). Counting happens BEFORE the password check, in one
       call, so parallel requests can't all slip under the limit. Keys are
       per client IP, so a stranger hammering a username doesn't lock the
       real teacher out from their own network. */
    if (path === '/throttle') {
      const now = Date.now();
      const key = String(b.key || '').slice(0, 200);
      const max = Number(b.max) || 5, windowMs = Number(b.windowMs) || 300000;
      const row = this.sql.exec('SELECT count, window_start FROM attempts WHERE key = ?', key).toArray()[0];
      let count = 1;
      if (row && now - row.window_start < windowMs) count = row.count + 1;
      if (row && now - row.window_start < windowMs) this.sql.exec('UPDATE attempts SET count = ? WHERE key = ?', count, key);
      else this.sql.exec('INSERT OR REPLACE INTO attempts (key, count, window_start) VALUES (?, ?, ?)', key, 1, now);
      if (Math.random() < 0.01) this.sql.exec('DELETE FROM attempts WHERE window_start < ?', now - 86400000);
      return json({ ok: count <= max, count });
    }
    if (path === '/throttle-clear') {
      this.sql.exec('DELETE FROM attempts WHERE key = ?', String(b.key || ''));
      return json({ ok: true });
    }
    if (path === '/role-of') {
      const r = this.sql.exec('SELECT role FROM memberships WHERE user_id = ? AND project_id = ?', String(b.userId || ''), String(b.projectId || '')).toArray()[0];
      return json({ ok: true, role: r ? r.role : null });
    }
    if (path === '/owned-count') {
      const r = this.sql.exec("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'", String(b.userId || '')).one();
      return json({ ok: true, count: r.n });
    }
    if (path === '/find') {
      const row = this.sql.exec('SELECT * FROM users WHERE username = ?', String(b.username || '')).toArray()[0];
      return json(row ? { ok: true, user: user(row), pw: row.pw, lockedUntil: row.locked_until } : { ok: false });
    }
    if (path === '/by-id') {
      const row = this.sql.exec('SELECT * FROM users WHERE id = ?', String(b.id || '')).toArray()[0];
      return json(row ? { ok: true, user: user(row) } : { ok: false });
    }
    if (path === '/set-password') {
      this.sql.exec('UPDATE users SET pw = ?, failures = 0, locked_until = 0 WHERE id = ?', String(b.pw), String(b.id || ''));
      return json({ ok: true });
    }
    if (path === '/memberships') {
      const rows = this.sql.exec('SELECT project_id, role, title, updated_at FROM memberships WHERE user_id = ? ORDER BY updated_at DESC', String(b.userId || '')).toArray();
      return json({ ok: true, projects: rows.map((r) => ({ id: r.project_id, role: r.role, title: r.title, updated: r.updated_at })) });
    }
    if (path === '/set-membership') {
      if (!b.role) this.sql.exec('DELETE FROM memberships WHERE user_id = ? AND project_id = ?', String(b.userId), String(b.projectId));
      else this.sql.exec(`INSERT INTO memberships (user_id, project_id, role, title, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role, title = excluded.title, updated_at = excluded.updated_at`,
        String(b.userId), String(b.projectId), String(b.role), String(b.title || '').slice(0, 120), Date.now());
      return json({ ok: true });
    }
    /* title changes fan out to every member's index entry */
    if (path === '/retitle') {
      this.sql.exec('UPDATE memberships SET title = ?, updated_at = ? WHERE project_id = ?', String(b.title || '').slice(0, 120), Date.now(), String(b.projectId));
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}

/* ---- Project: one instance per project ----
   The sheet JSON is stored in chunks: a SQLite value is capped at 2 MB
   and a sheet with images can be several MB. */
const CHUNK = 500000; // chars; sheets are mostly ASCII, so well under 2 MB
const KEEP_VERSIONS = 5;

/* Student (anonymous) sheets expire after this long without a publish or
   a new room, so storage from account-less users stays bounded. A class
   using one for a semester stays well inside it. */
const ANON_TTL_MS = 365 * 864e5;

export class Project {
  constructor(state, env) {
    this.env = env;
    this.ctx = state;
    this.sql = state.storage.sql;
    this.schema();
  }

  schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (version INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (version, n));
      CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, label TEXT NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }

  meta() {
    const m = {};
    for (const r of this.sql.exec('SELECT key, value FROM meta').toArray()) m[r.key] = r.value;
    return m;
  }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v)); }

  /* All or nothing: a failure halfway would leave chunks without a
     version row, and every later publish would collide on that version. */
  storeSheet(text, by) {
    return this.ctx.storage.transactionSync(() => {
      const cur = this.sql.exec('SELECT MAX(version) AS v FROM versions').one().v || 0;
      const v = cur + 1;
      this.sql.exec('DELETE FROM chunks WHERE version = ?', v);
      for (let i = 0, n = 0; i < text.length; n++) {
        let end = Math.min(text.length, i + CHUNK);
        // never split a surrogate pair across chunks (it would decode as U+FFFD)
        const c = text.charCodeAt(end - 1);
        if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
        this.sql.exec('INSERT INTO chunks (version, n, data) VALUES (?, ?, ?)', v, n, text.slice(i, end));
        i = end;
      }
      this.sql.exec('INSERT INTO versions (version, created_at, created_by, size) VALUES (?, ?, ?, ?)', v, Date.now(), String(by), text.length);
      this.sql.exec('DELETE FROM chunks WHERE version <= ?', v - KEEP_VERSIONS);
      this.sql.exec('DELETE FROM versions WHERE version <= ?', v - KEEP_VERSIONS);
      this.setMeta('version', v);
      this.setMeta('updated_at', Date.now());
      return v;
    });
  }

  /* anonymous projects: (re)arm the expiry alarm on every sign of use */
  async touchAnon() {
    if (this.meta().anon === '1') await this.ctx.storage.setAlarm(Date.now() + ANON_TTL_MS);
  }

  async alarm() {
    const m = this.meta();
    if (m.anon !== '1') return;
    if (Date.now() - Number(m.updated_at || m.created_at || 0) < ANON_TTL_MS - 864e5) { await this.touchAnon(); return; }
    const rooms = this.sql.exec('SELECT room_id FROM rooms').toArray().map((r) => r.room_id);
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global'));
    for (const id of rooms) {
      await registry.fetch('https://registry/delete-room', { method: 'POST', body: JSON.stringify({ roomId: id }) });
      await this.env.ROOM.get(this.env.ROOM.idFromName(id)).fetch('https://room/reset-http', { method: 'POST' });
    }
    await this.ctx.storage.deleteAll();
    this.schema();
  }

  info() {
    const m = this.meta();
    return {
      id: m.id, title: m.title, owner: m.owner, version: Number(m.version || 0),
      created: Number(m.created_at || 0), updated: Number(m.updated_at || 0),
      members: this.sql.exec('SELECT user_id AS id, username, role FROM members ORDER BY username').toArray(),
      rooms: this.sql.exec('SELECT room_id AS id, label, code, created_at AS created FROM rooms ORDER BY created_at').toArray(),
      versions: this.sql.exec('SELECT version, created_at AS created, created_by AS by, size FROM versions ORDER BY version DESC').toArray(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/sheet') {
      const m = this.meta();
      const v = Number(url.searchParams.get('v') || m.version || 0);
      const parts = this.sql.exec('SELECT data FROM chunks WHERE version = ? ORDER BY n', v).toArray();
      if (!parts.length) return new Response('not found', { status: 404 });
      return new Response(parts.map((p) => p.data).join(''), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Sheet-Version': String(v) } });
    }
    /* publish takes the raw JSON text, already validated by the gate */
    if (path === '/publish') {
      const by = url.searchParams.get('by') || '';
      const text = await request.text();
      const v = this.storeSheet(text, by);
      await this.touchAnon();
      return json({ ok: true, version: v });
    }

    const b = await body(request);
    if (path === '/init') {
      if (this.meta().id) return json({ ok: false, error: 'exists' }, 409);
      this.setMeta('id', b.id);
      this.setMeta('title', String(b.title || 'Tanpa judul').slice(0, 120));
      this.setMeta('owner', b.ownerId);
      this.setMeta('created_at', Date.now());
      this.sql.exec('INSERT INTO members (user_id, username, role) VALUES (?, ?, ?)', b.ownerId, String(b.ownerName), 'owner');
      return json({ ok: true });
    }
    if (path === '/info') return json({ ok: true, project: this.info() });
    /* a student room's project (#15): no owner, no members, never listed */
    if (path === '/init-anon') {
      if (this.meta().id) return json({ ok: false, error: 'exists' }, 409);
      this.setMeta('id', b.id);
      this.setMeta('title', String(b.title || 'Lembar kerja').slice(0, 120));
      this.setMeta('owner', '');
      this.setMeta('anon', '1');
      this.setMeta('created_at', Date.now());
      await this.touchAnon();
      return json({ ok: true });
    }
    if (path === '/version') { const m = this.meta(); return json({ ok: true, version: Number(m.version || 0), anon: m.anon === '1' }); }
    if (path === '/role') {
      const r = this.sql.exec('SELECT role FROM members WHERE user_id = ?', String(b.userId || '')).toArray()[0];
      return json({ ok: true, role: r ? r.role : null, title: this.meta().title || '' });
    }
    if (path === '/set-title') { this.setMeta('title', String(b.title || '').slice(0, 120) || 'Tanpa judul'); return json({ ok: true }); }
    /* The owner row is never changed here: one owner, set at /init. */
    if (path === '/set-member') {
      if (b.role !== null && b.role !== 'editor' && b.role !== 'viewer') return json({ ok: false, error: 'role' }, 400);
      const cur = this.sql.exec('SELECT role FROM members WHERE user_id = ?', String(b.userId)).toArray()[0];
      if (cur && cur.role === 'owner') return json({ ok: false, error: 'owner' }, 400);
      if (!b.role) this.sql.exec('DELETE FROM members WHERE user_id = ?', String(b.userId));
      else this.sql.exec(`INSERT INTO members (user_id, username, role) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, username = excluded.username`, String(b.userId), String(b.username), b.role);
      return json({ ok: true });
    }
    if (path === '/add-room') {
      this.sql.exec('INSERT OR REPLACE INTO rooms (room_id, label, code, created_at) VALUES (?, ?, ?, ?)', String(b.roomId), String(b.label || '').slice(0, 60), String(b.code), Date.now());
      this.setMeta('updated_at', Date.now());
      await this.touchAnon();
      return json({ ok: true });
    }
    if (path === '/remove-room') {
      this.sql.exec('DELETE FROM rooms WHERE room_id = ?', String(b.roomId));
      return json({ ok: true });
    }
    /* Called last, after the gate has freed the rooms and memberships
       (so a failure halfway leaves the project listable and retryable).
       deleteAll() drops the tables; recreate them so this live instance
       answers "no such project" instead of throwing until it's evicted. */
    if (path === '/delete') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.schema();
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}
