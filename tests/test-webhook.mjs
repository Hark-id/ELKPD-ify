/* Verifies the webhook receiver's security and behaviour.
 *
 * Runs against a DEPLOYED webhook Worker (WEBHOOK_URL) because the HMAC
 * check uses the real secret. Set:
 *   WEBHOOK_URL=https://elkpd-webhook.<subdomain>.workers.dev
 *   WEBHOOK_SECRET=<the same value configured on GitHub>
 *   WEBHOOK_READ_TOKEN=<the READ_TOKEN secret>
 *
 * The point of this suite is the negative cases: an unsigned or wrongly
 * signed delivery MUST be rejected, or anyone could inject events.
 */
const BASE = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
const SECRET = process.env.WEBHOOK_SECRET || '';
const READ_TOKEN = process.env.WEBHOOK_READ_TOKEN || '';

let failures = 0;
const check = (n, c, d = '') => {
  console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : ''));
  if (!c) failures++;
};

if (!BASE) {
  console.log('SKIP  WEBHOOK_URL not set — nothing to test');
  process.exit(0);
}

/* HMAC-SHA256 in hex, matching what GitHub sends. */
async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function prPayload(action = 'opened') {
  return JSON.stringify({
    action,
    repository: { full_name: 'Hark-id/ELKPD-ify' },
    pull_request: {
      number: 99, title: 'test: webhook probe', html_url: 'https://example.invalid/pr/99',
      user: { login: 'probe' }, merged: false, draft: false,
      base: { ref: 'main' }, head: { ref: 'test/webhook-probe' },
    },
  });
}

async function deliver(body, { secret = SECRET, event = 'pull_request', delivery = 'probe-' + Date.now() } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': delivery,
  };
  if (secret) headers['X-Hub-Signature-256'] = await sign(secret, body);
  const r = await fetch(BASE + '/', { method: 'POST', headers, body });
  let j = null;
  try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
}

async function main() {
  /* ---------- health ---------- */
  {
    const r = await fetch(BASE + '/health');
    const j = await r.json().catch(() => null);
    check('H1: /health responds', r.status === 200 && j && j.ok === true, JSON.stringify(j));
  }

  /* ---------- signature enforcement (the security core) ---------- */
  {
    const body = prPayload();

    const unsigned = await deliver(body, { secret: '' });
    check('S1: unsigned delivery is REJECTED', unsigned.status === 401, 'status=' + unsigned.status);

    const wrong = await deliver(body, { secret: 'definitely-not-the-secret' });
    check('S2: wrongly signed delivery is REJECTED', wrong.status === 401, 'status=' + wrong.status);

    /* A signature computed over DIFFERENT content must also fail. */
    const tampered = await (async () => {
      const good = await sign(SECRET, body);
      const r = await fetch(BASE + '/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-GitHub-Delivery': 'probe-tamper-' + Date.now(),
          'X-Hub-Signature-256': good,
        },
        body: body.replace('webhook probe', 'tampered'),
      });
      return r.status;
    })();
    check('S3: body tampered after signing is REJECTED', tampered === 401, 'status=' + tampered);

    if (!SECRET) {
      console.log('SKIP  S4/S5 — WEBHOOK_SECRET not set, cannot test the accept path');
    } else {
      const ok = await deliver(body);
      check('S4: correctly signed delivery is ACCEPTED', ok.status === 200 && ok.body && ok.body.ok === true, JSON.stringify(ok.body));

      /* ---------- dedupe ---------- */
      const dup = await deliver(body, { delivery: 'probe-dup-fixed' });
      const dup2 = await deliver(body, { delivery: 'probe-dup-fixed' });
      check('S5: a repeated delivery id is deduped',
        dup2.status === 200 && dup2.body && dup2.body.duplicate === true,
        JSON.stringify(dup2.body));
    }
  }

  /* ---------- ignored events ---------- */
  {
    const body = JSON.stringify({ action: 'created', repository: { full_name: 'Hark-id/ELKPD-ify' } });
    const r = await deliver(body, { event: 'star' });
    check('E1: uninteresting events are acknowledged and dropped',
      r.status === 200 && r.body && r.body.ignored === 'star', JSON.stringify(r.body));
  }

  /* ---------- /recent auth ---------- */
  {
    const noAuth = await fetch(BASE + '/recent');
    check('R1: /recent without a token is REJECTED', noAuth.status === 401, 'status=' + noAuth.status);

    const badAuth = await fetch(BASE + '/recent', { headers: { Authorization: 'Bearer nope' } });
    check('R2: /recent with a wrong token is REJECTED', badAuth.status === 401, 'status=' + badAuth.status);

    if (!READ_TOKEN) {
      console.log('SKIP  R3 — WEBHOOK_READ_TOKEN not set');
    } else {
      const r = await fetch(BASE + '/recent?limit=5', { headers: { Authorization: 'Bearer ' + READ_TOKEN } });
      const j = await r.json().catch(() => null);
      check('R3: /recent with the right token returns events',
        r.status === 200 && j && j.ok === true && Array.isArray(j.events), JSON.stringify(j && j.count));
      if (j && j.events && j.events.length) {
        const e = j.events[0];
        check('R4: events are shaped, not raw payloads',
          typeof e.kind === 'string' && typeof e.summary === 'string' && !('pull_request' in e),
          JSON.stringify(Object.keys(e)));
      }
    }
  }

  console.log(failures === 0 ? '\nALL WEBHOOK CHECKS PASSED' : `\n${failures} WEBHOOK CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
