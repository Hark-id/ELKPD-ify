/* Minimal CDP driver for the local suites (studio, player): launch a
 * headless Chrome, open a page, evaluate, screenshot. Uses Node's global
 * WebSocket (Node >= 22), so there is still no test framework. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { findChrome, waitForCDP } from './helpers.mjs';

function chromePath() {
  try { return findChrome(); } catch { /* Playwright's cache, for headless servers */ }
  const base = join(homedir(), '.cache/ms-playwright');
  if (existsSync(base)) {
    for (const d of readdirSync(base).sort().reverse()) {
      for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chrome found; set CHROME_PATH');
}

export async function launch({ width = 1280, height = 900, port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'elkpd-cdp-'));
  const proc = spawn(chromePath(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });
  const target = await waitForCDP(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.j(new Error(m.error.message)) : w.r(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; waiting.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // Headless pages have no focus: .focus() moves activeElement but fires no
  // focus event, so anything driven by focus (presence) would pass or fail
  // by machine. Emulate a focused page.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const errors = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });

  const api = {
    send, errors,
    on(fn) { listeners.push(fn); },
    async goto(url) {
      const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await send('Page.navigate', { url });
      let t;
      await Promise.race([loaded, new Promise((_, j) => { t = setTimeout(() => j(new Error('page load timed out: ' + url)), 30000); })]);
      clearTimeout(t);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 15000) {
      const t0 = Date.now();
      for (;;) {
        const v = await api.eval(expr).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error('timeout waiting for: ' + expr);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async screenshot(clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : { captureBeyondViewport: false }) });
      return Buffer.from(r.data, 'base64');
    },
    async setFile(selector, path) {
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files: [path] });
    },
    async type(text) { await send('Input.insertText', { text }); },
    async close() { try { ws.close(); } catch {} proc.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 200)); try { rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
  return api;
}
