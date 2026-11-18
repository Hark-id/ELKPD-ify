/* GitHub webhook receiver for ELKPD-ify.
 *
 * WHY THIS EXISTS
 * The coding agent runs inside a desktop app on a workstation: it has no
 * always-on HTTP endpoint, so GitHub cannot wake it directly. This Worker
 * is the always-on half. It:
 *
 *   1. verifies the GitHub HMAC signature (nothing is trusted unverified),
 *   2. records each relevant event in KV with a monotonic sequence,
 *   3. optionally forwards a short summary to a push channel (Discord,
 *      Telegram, ntfy, …) so the HUMAN knows to start a session,
 *   4. exposes GET /recent so the agent can ask "what changed since I last
 *      looked?" instead of re-listing everything.
 *
 * That turns "instant webhook" into "instant signal, fast pickup" — the
 * honest version of what a workstation-hosted agent can actually do.
 *
 * ROUTES
 *   POST /            GitHub webhook endpoint (HMAC verified)
 *   GET  /recent      recent events, newest first (Bearer token)
 *   GET  /health      liveness, no auth, no data
 *
 * SECRETS (wrangler secret put)
 *   GITHUB_WEBHOOK_SECRET  the same string configured on the GitHub webhook
 *   READ_TOKEN             bearer token for GET /recent
 *   NOTIFY_URL             optional: POST target for human notifications
 */

const MAX_BODY = 256 * 1024;      /* GitHub payloads are far smaller */
const MAX_EVENTS = 200;           /* ring buffer size in KV */

/* ---------- helpers ---------- */

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* Constant-time compare so a wrong signature cannot be found by timing. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  /* crypto.subtle.sign requires a BufferSource, NOT a string — passing the
     raw string throws a TypeError (which surfaces as a 1101 on the edge). */
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return toHex(sig);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/* ---------- event shaping ----------
   Keep only what the agent needs to decide what to do. Never store the
   whole payload: it can contain author emails and other noise. */

function shapeEvent(kind, payload) {
  const repo = payload.repository && payload.repository.full_name;
  const base = { kind, repo, at: Date.now() };

  if (kind === "pull_request") {
    const pr = payload.pull_request || {};
    return {
      ...base,
      action: payload.action,
      number: pr.number,
      title: pr.title,
      author: pr.user && pr.user.login,
      url: pr.html_url,
      merged: !!pr.merged,
      draft: !!pr.draft,
      base: pr.base && pr.base.ref,
      head: pr.head && pr.head.ref,
    };
  }

  if (kind === "issues") {
    const issue = payload.issue || {};
    return {
      ...base,
      action: payload.action,
      number: issue.number,
      title: issue.title,
      author: issue.user && issue.user.login,
      url: issue.html_url,
      assignees: (issue.assignees || []).map(a => a.login),
    };
  }

  if (kind === "issue_comment") {
    const issue = payload.issue || {};
    const comment = payload.comment || {};
    return {
      ...base,
      action: payload.action,
      number: issue.number,
      title: issue.title,
      isPR: !!(issue.pull_request),
      author: comment.user && comment.user.login,
      url: comment.html_url,
      /* a short excerpt is enough to know whether it needs a reply */
      excerpt: String(comment.body || "").slice(0, 200),
    };
  }

  if (kind === "push") {
    return {
      ...base,
      ref: payload.ref,
      before: payload.before,
      after: payload.after,
      commits: (payload.commits || []).length,
      pusher: payload.pusher && payload.pusher.name,
    };
  }

  if (kind === "workflow_run") {
    const run = payload.workflow_run || {};
    return {
      ...base,
      action: payload.action,
      name: run.name,
      conclusion: run.conclusion,
      branch: run.head_branch,
      url: run.html_url,
    };
  }

  return { ...base, action: payload.action };
}

/* A one-line human summary for the push channel. */
function summarize(ev) {
  switch (ev.kind) {
    case "pull_request":
      return `PR #${ev.number} ${ev.action}: ${ev.title} (@${ev.author})`;
    case "issues":
      return `Issue #${ev.number} ${ev.action}: ${ev.title} (@${ev.author})`;
    case "issue_comment":
      return `Comment on ${ev.isPR ? "PR" : "issue"} #${ev.number} by @${ev.author}`;
    case "push":
      return `Push to ${String(ev.ref || "").replace("refs/heads/", "")} (${ev.commits} commit(s))`;
    case "workflow_run":
      return `CI ${ev.name} ${ev.conclusion} on ${ev.branch}`;
    default:
      return `${ev.kind} ${ev.action || ""}`.trim();
  }
}

/* ---------- KV ring buffer ----------
   KV has no atomic append, so we keep a single JSON array under one key.
   Volume here is a handful of events per day; contention is not a concern.
   If it ever is, move this to a Durable Object. */

async function readEvents(env) {
  try {
    const raw = await env.EVENTS.get("recent");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function appendEvent(env, ev) {
  const list = await readEvents(env);
  list.unshift(ev);
  const trimmed = list.slice(0, MAX_EVENTS);
  await env.EVENTS.put("recent", JSON.stringify(trimmed));
  return trimmed.length;
}

/* ---------- notification fan-out ---------- */

async function notify(env, ev) {
  if (!env.NOTIFY_URL) return;
  const text = `ELKPD-ify · ${summarize(ev)}${ev.url ? "\n" + ev.url : ""}`;
  try {
    await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      /* `content` works for Discord; `text` for Slack/ntfy-style endpoints.
         Sending both is harmless and avoids a per-service config knob. */
      body: JSON.stringify({ content: text, text }),
    });
  } catch {
    /* a failed notification must never fail the delivery */
  }
}

/* ---------- routes ---------- */

async function handleWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    /* Fail closed: an unconfigured receiver must not accept anything. */
    return json({ ok: false, error: "webhook secret not configured" }, 500);
  }

  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);

  /* --- signature --- */
  const sigHeader = request.headers.get("x-hub-signature-256") || "";
  const expected = "sha256=" + await hmacHex(secret, raw);
  if (!safeEqual(sigHeader, expected)) {
    return json({ ok: false, error: "bad signature" }, 401);
  }

  /* --- replay window ---
     GitHub does not send a timestamp header, so a true replay window is not
     possible from the request alone. The delivery-id dedupe below is the
     practical equivalent: a replayed delivery is rejected as a duplicate. */

  /* --- event --- */
  const kind = request.headers.get("x-github-event") || "unknown";
  const delivery = request.headers.get("x-github-delivery") || "";

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  /* Only the events the agent acts on. Everything else is acknowledged and
     dropped, so the ring buffer stays useful. */
  const WANTED = new Set(["pull_request", "issues", "issue_comment", "push", "workflow_run"]);
  if (!WANTED.has(kind)) {
    return json({ ok: true, ignored: kind });
  }

  /* Dedupe: GitHub retries deliveries, and a retry must not double-record. */
  if (delivery) {
    const seen = await env.EVENTS.get("delivery:" + delivery);
    if (seen) return json({ ok: true, duplicate: true });
    await env.EVENTS.put("delivery:" + delivery, "1", { expirationTtl: 86400 });
  }

  const ev = shapeEvent(kind, payload);
  ev.delivery = delivery;
  ev.summary = summarize(ev);

  const size = await appendEvent(env, ev);
  await notify(env, ev);

  return json({ ok: true, recorded: ev.kind, action: ev.action, buffered: size });
}

async function handleRecent(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.READ_TOKEN || !safeEqual(token, env.READ_TOKEN)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 50) || 50, MAX_EVENTS);
  const since = Number(url.searchParams.get("since") || 0);

  const list = await readEvents(env);
  const filtered = since ? list.filter(e => e.at > since) : list;

  return json({ ok: true, count: filtered.length, events: filtered.slice(0, limit) });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({ ok: true, service: "elkpd-webhook" });
      }
      if (url.pathname === "/recent") {
        return handleRecent(request, env);
      }
      if (url.pathname === "/" || url.pathname === "") {
        return handleWebhook(request, env);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      /* An uncaught throw becomes an opaque Cloudflare 1101 page, which is
         useless for debugging. Return the message instead — it contains no
         secret, only the failure reason. */
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
};
