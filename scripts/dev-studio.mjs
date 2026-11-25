#!/usr/bin/env node
/* Local static server for the Studio and the sheet player (src/studio,
 * src/sheet). They are plain ES modules with no build step, but browsers
 * won't load modules from file://, so this serves the repo root:
 *
 *   node scripts/dev-studio.mjs [--port 8788]
 *   open http://127.0.0.1:8788/src/studio/
 *
 * Binds to 127.0.0.1 only: it serves the whole working tree. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pi = process.argv.indexOf('--port');
const port = Number(pi > 0 ? process.argv[pi + 1] : process.env.PORT || 8788);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8',
};

export function startServer(p = port) {
  const server = http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(p, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log(`studio: http://127.0.0.1:${port}/src/studio/`);
}
