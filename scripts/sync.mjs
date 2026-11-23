#!/usr/bin/env node
/* Sync the single source of truth into the deployable layout.
 *
 * The gate's landing page and the worksheet are each needed in more than
 * one place at deploy time (Pages serves from `public/`, and the gate
 * imports `landing.js` from beside `_worker.js`). Editing three copies by
 * hand is how they drift — this script makes `src/` authoritative.
 *
 *   node scripts/sync.mjs          # copy src/ -> build/
 *   node scripts/sync.mjs --check  # verify build/ matches src/, exit 1 if not
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/* src path -> build path */
const MAP = [
  ['src/gate/_worker.js', 'build/gate/public/_worker.js'],
  ['src/gate/landing.js', 'build/gate/public/landing.js'],
  ['src/gate/admin.js', 'build/gate/public/admin.js'],
  ['src/gate/_routes.json', 'build/gate/public/_routes.json'],
  ['src/gate/wrangler.toml', 'build/gate/wrangler.toml'],
  ['src/worksheet/worksheet.html', 'build/gate/public/worksheet.html'],
  ['src/worksheet/wave.js', 'build/gate/public/wave.js'],
  // Studio + sheet player (#12): static, public (code only, no data). The
  // gate's _routes.json excludes /studio/* and /sheet/* so Pages serves them
  // directly; nothing here is behind the room gate.
  ['src/sheet/import.js', 'build/gate/public/sheet/import.js'],
  ['src/sheet/player.js', 'build/gate/public/sheet/player.js'],
  ['src/studio/index.html', 'build/gate/public/studio/index.html'],
  ['src/studio/studio.css', 'build/gate/public/studio/studio.css'],
  ['src/studio/studio.js', 'build/gate/public/studio/studio.js'],
  ['src/studio/store.js', 'build/gate/public/studio/store.js'],
  ['src/studio/export.js', 'build/gate/public/studio/export.js'],
  ['src/studio/play.html', 'build/gate/public/studio/play.html'],
  ['src/studio/samples/ekosistem-kolam.pdf', 'build/gate/public/studio/samples/ekosistem-kolam.pdf'],
  ['src/rooms/rooms.js', 'build/rooms/rooms.js'],
  ['src/rooms/wrangler.toml', 'build/rooms/wrangler.toml'],
  ['src/webhook/webhook.js', 'build/webhook/webhook.js'],
  ['src/webhook/wrangler.toml', 'build/webhook/wrangler.toml'],
];

let drift = 0;
for (const [from, to] of MAP) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    console.error(`missing source: ${from}`);
    process.exitCode = 1;
    continue;
  }
  const want = readFileSync(src);
  const have = existsSync(dst) ? readFileSync(dst) : null;

  if (check) {
    if (!have || !have.equals(want)) {
      console.error(`DRIFT  ${to}  (differs from ${from})`);
      drift++;
    }
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, want);
    console.log(`synced ${from} -> ${to}`);
  }
}

if (check) {
  if (drift) {
    console.error(`\n${drift} file(s) out of sync. Run: node scripts/sync.mjs`);
    process.exit(1);
  }
  console.log('build/ is in sync with src/');
}
