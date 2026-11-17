# Webhook receiver

GitHub cannot wake the coding agent directly — the agent runs inside a desktop
app on a workstation, with no always-on HTTP endpoint. This Worker is the
always-on half of the pair.

```
GitHub ──webhook──► elkpd-webhook (Worker) ──► KV ring buffer
                          │
                          └──► NOTIFY_URL (optional push to a human)
                                    │
                          agent asks GET /recent when it next runs
```

It turns "instant webhook" into **instant signal, fast pickup**: the human is
notified immediately, and the agent reads the buffer at the start of its next
run instead of re-listing everything.

## What it does

1. **Verifies the GitHub HMAC signature.** Nothing is trusted unverified —
   an unsigned, wrongly-signed, or tampered delivery is rejected with 401.
2. **Records relevant events** in KV: `pull_request`, `issues`,
   `issue_comment`, `push`, `workflow_run`. Everything else is acknowledged
   and dropped so the buffer stays useful.
3. **Deduplicates** by `X-GitHub-Delivery`, because GitHub retries.
4. **Notifies** a push channel if `NOTIFY_URL` is set.
5. **Serves `GET /recent`** so the agent can ask "what changed since I last
   looked?" with `?since=<epoch-ms>`.

Events are **shaped**, not stored raw — only the fields the agent needs
(number, title, author, action, url, summary). Author emails and other payload
noise never reach storage.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /` | HMAC signature | GitHub webhook endpoint |
| `GET /recent?limit=&since=` | `Bearer READ_TOKEN` | recent events, newest first |
| `GET /health` | none | liveness, no data |

## Setup

```bash
cd build/webhook            # after `node scripts/sync.mjs`
npx wrangler kv namespace create EVENTS
# put the returned id into src/webhook/wrangler.toml, then re-sync

npx wrangler secret put GITHUB_WEBHOOK_SECRET   # any long random string
npx wrangler secret put READ_TOKEN              # any long random string
npx wrangler secret put NOTIFY_URL              # optional

npx wrangler deploy
```

Then on GitHub: **Settings → Webhooks → Add webhook**

| Field | Value |
|---|---|
| Payload URL | `https://elkpd-webhook.<subdomain>.workers.dev/` |
| Content type | `application/json` |
| Secret | the same value as `GITHUB_WEBHOOK_SECRET` |
| Events | Pull requests, Issues, Issue comments, Pushes, Workflow runs |

## Verifying it

```bash
WEBHOOK_SECRET=... WEBHOOK_READ_TOKEN=... node scripts/test-webhook-edge.mjs
```

The suite's point is the **negative** cases: an unsigned or tampered delivery
must be rejected, or anyone could inject events into the buffer.

> **Note on this network:** `*.workers.dev` is DNS-hijacked here, so a plain
> `fetch` to the Worker fails. `scripts/test-webhook-edge.mjs` connects to a
> real Cloudflare edge IP with the correct SNI instead. On a normal network,
> `tests/test-webhook.mjs` works directly.

## Reading the buffer

```bash
curl -H "Authorization: Bearer $READ_TOKEN" \
     "https://elkpd-webhook.<subdomain>.workers.dev/recent?since=1794888000000"
```

## Limits

- KV is a single JSON array under one key. Fine for a handful of events per
  day; move to a Durable Object if volume ever justifies it.
- The buffer holds the newest 200 events.
- Delivery-id dedupe entries expire after 24 hours.
- GitHub sends no timestamp header, so a true replay window is not possible
  from the request alone — the delivery-id dedupe is the practical equivalent.
