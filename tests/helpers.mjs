/* Shared test helpers.
 *
 * Every suite drives a real browser over the Chrome DevTools Protocol.
 * The browser path differs per OS and per CI image, so it is resolved
 * here instead of being hardcoded in each suite.
 */
import { existsSync } from 'node:fs';

/* Resolve a Chrome/Chromium binary.
 * Order: explicit override, then the usual per-platform locations. */
export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    // Windows
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Linux (GitHub Actions ubuntu-latest ships google-chrome-stable)
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    'No Chrome/Chromium found. Set CHROME_PATH to the browser binary.'
  );
}

/* The deployment under test. Defaults to the reference deployment so the
 * suites work out of the box, but contributors should point this at their
 * own:  ELKPD_URL=https://your-project.pages.dev node tests/test-blue.mjs */
export const LIVE = process.env.ELKPD_URL || 'https://lkpd-cerpen-gate.pages.dev/';

/* The admin console code is a SECRET and must never be committed.
 * Set ELKPD_ADMIN_CODE in your environment. The fallback is deliberately
 * invalid so a missing variable fails loudly instead of silently using a
 * real code. */
export const ADMIN_CODE = process.env.ELKPD_ADMIN_CODE || 'ADMIN-NOT-SET';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Wait for a headless Chrome DevTools endpoint to come up.
 *
 * CI runners are slower and occasionally busier than a workstation, and the
 * original 50×200ms (10s) poll would give up and then dereference a null
 * target — surfacing as "Cannot read properties of null (reading
 * 'webSocketDebuggerUrl')", which looks like a product bug but is just a
 * slow start. This waits up to 30s and throws a clear message.
 */
export async function waitForCDP(port, { attempts = 150, intervalMs = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* not up yet */ }
  }
  throw new Error(
    `Chrome DevTools endpoint on port ${port} did not come up within ` +
    `${Math.round(attempts * intervalMs / 1000)}s. This is an environment ` +
    `problem (slow or failed browser start), not a test failure.`
  );
}
