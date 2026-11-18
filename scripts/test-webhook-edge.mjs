/* Runs the webhook security suite through a direct-to-edge connection.
 *
 * This machine's network DNS-hijacks *.workers.dev, so a normal fetch to the
 * Worker host fails. We connect to a real Cloudflare edge IP with the correct
 * SNI instead, which is the documented workaround for this network.
 *
 * Usage: node scripts/test-webhook-edge.mjs
 *   env: WEBHOOK_HOST, WEBHOOK_SECRET, WEBHOOK_READ_TOKEN
 */
import https from 'node:https';
import crypto from 'node:crypto';

const HOST = process.env.WEBHOOK_HOST || 'elkpd-webhook.haufanhazza.workers.dev';
const EDGE = process.env.WEBHOOK_EDGE || '104.21.75.98';
const SECRET = process.env.WEBHOOK_SECRET || '';
const READ_TOKEN = process.env.WEBHOOK_READ_TOKEN || '';

let failures = 0;
const check = (n, c, d = '') => {
  console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : ''));
  if (!c) failures++;
};

function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: EDGE, port: 443, path, method,
      servername: HOST,
      headers: { Host: HOST, ...headers },
      timeout: 20000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const sign = (secret, body) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

const prPayload = (action = 'opened') => JSON.stringify({
  action,
  repository: { full_name: 'Hark-id/ELKPD-ify' },
  pull_request: {
    number: 99, title: 'test: webhook probe', html_url: 'https://example.invalid/pr/99',
    user: { login: 'probe' }, merged: false, draft: false,
    base: { ref: 'main' }, head: { ref: 'test/webhook-probe' },
  },
});

async function deliver(body, { secret = SECRET, event = 'pull_request', delivery = 'probe-' + Date.now() } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': delivery,
  };
  if (secret) headers['X-Hub-Signature-256'] = sign(secret, body);
  return request('POST', '/', { headers, body });
}

async function main() {
  console.log(`target: ${HOST} via edge ${EDGE}\n`);

  {
    const r = await request('GET', '/health');
    check('H1: /health responds', r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r.body));
  }

  const body = prPayload();

  const unsigned = await deliver(body, { secret: '' });
  check('S1: unsigned delivery is REJECTED', unsigned.status === 401, 'status=' + unsigned.status);

  const wrong = await deliver(body, { secret: 'definitely-not-the-secret' });
  check('S2: wrongly signed delivery is REJECTED', wrong.status === 401, 'status=' + wrong.status);

  {
    const good = sign(SECRET, body);
    const r = await request('POST', '/', {
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'probe-tamper-' + Date.now(),
        'X-Hub-Signature-256': good,
      },
      body: body.replace('webhook probe', 'tampered'),
    });
    check('S3: body tampered after signing is REJECTED', r.status === 401, 'status=' + r.status);
  }

  if (!SECRET) {
    console.log('SKIP  S4/S5 — WEBHOOK_SECRET not set');
  } else {
    const ok = await deliver(body);
    check('S4: correctly signed delivery is ACCEPTED',
      ok.status === 200 && ok.body && ok.body.ok === true, JSON.stringify(ok.body));

    const id = 'probe-dup-' + Date.now();
    await deliver(body, { delivery: id });
    const dup = await deliver(body, { delivery: id });
    check('S5: a repeated delivery id is deduped',
      dup.status === 200 && dup.body && dup.body.duplicate === true, JSON.stringify(dup.body));
  }

  {
    const r = await deliver(JSON.stringify({ action: 'created' }), { event: 'star' });
    check('E1: uninteresting events are acknowledged and dropped',
      r.status === 200 && r.body && r.body.ignored === 'star', JSON.stringify(r.body));
  }

  {
    const noAuth = await request('GET', '/recent');
    check('R1: /recent without a token is REJECTED', noAuth.status === 401, 'status=' + noAuth.status);

    const bad = await request('GET', '/recent', { headers: { Authorization: 'Bearer nope' } });
    check('R2: /recent with a wrong token is REJECTED', bad.status === 401, 'status=' + bad.status);

    if (!READ_TOKEN) {
      console.log('SKIP  R3/R4 — WEBHOOK_READ_TOKEN not set');
    } else {
      const r = await request('GET', '/recent?limit=5', { headers: { Authorization: 'Bearer ' + READ_TOKEN } });
      check('R3: /recent with the right token returns events',
        r.status === 200 && r.body && r.body.ok === true && Array.isArray(r.body.events),
        'count=' + (r.body && r.body.count));
      if (r.body && r.body.events && r.body.events.length) {
        const e = r.body.events[0];
        check('R4: events are shaped, not raw payloads',
          typeof e.kind === 'string' && typeof e.summary === 'string' && !('pull_request' in e),
          JSON.stringify(Object.keys(e)));
      }
    }
  }

  console.log(failures === 0 ? '\nALL WEBHOOK CHECKS PASSED' : `\n${failures} WEBHOOK CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
