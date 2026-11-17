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
      const value = String(msg.value ?? "");
      if (!field) return;

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
      const { codeHash, roomId, label, code } = await request.json();

      if (!codeHash || !roomId || !code) {
        return Response.json({ ok: false }, { status: 400 });
      }

      this.sql.exec(
        `INSERT OR IGNORE INTO rooms (code_hash, room_id, code, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        codeHash, roomId, String(code).slice(0, 20), String(label || "").slice(0, 60), Date.now()
      );

      const took = this.sql.exec("SELECT changes() AS n").one().n === 1;
      return Response.json({ ok: took });
    }

    if (url.pathname === "/lookup" && request.method === "POST") {
      const { codeHash } = await request.json();
      if (!codeHash) return Response.json({ ok: false }, { status: 400 });

      const row = this.sql
        .exec("SELECT room_id, label FROM rooms WHERE code_hash = ?", codeHash)
        .toArray()[0];

      return Response.json(row ? { ok: true, roomId: row.room_id, label: row.label } : { ok: false });
    }

    if (url.pathname === "/by-room" && request.method === "POST") {
      const { roomId } = await request.json();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(roomId || ""))) {
        return Response.json({ ok: false }, { status: 400 });
      }

      const row = this.sql
        .exec("SELECT label, code FROM rooms WHERE room_id = ?", roomId)
        .toArray()[0];

      return Response.json(row
        ? { ok: true, label: row.label, code: row.code }
        : { ok: false });
    }

    /* ---- admin console routes (authorised by the gate) ---- */
    if (url.pathname === "/admin-list" && request.method === "POST") {
      const rooms = this.sql.exec(
        "SELECT room_id, code, label, created_at, reported, report_note FROM rooms ORDER BY created_at DESC"
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
