# ELKPD-ify

Turns static PDF worksheets into interactable HTML-based e-worksheets.

Turn a teacher's printed worksheet (LKPD) into a **fillable, collaborative web page** that looks like the original document — then let a class work on it together, one room per group, without anyone else being able to read it.

Built for SMA Negeri 3 Yogyakarta, Bahasa Indonesia, *LKPD Teks Cerpen*. The architecture is generic: any LKPD PDF can be reproduced the same way.

---

## What it does

- **Faithful reproduction.** The worksheet is rebuilt from the source PDF shape-by-shape — same colours sampled from the PDF's own vector fills, same typography, same layout. It is meant to be indistinguishable from the printed sheet.
- **Real-time collaboration.** Each group gets a private room. Answers sync live over WebSockets; the server is the source of truth, `localStorage` is only an offline cache.
- **Server-side gate.** The worksheet HTML is never sent to a client without a valid session. There is no client-side "hide the content" trick.
- **Self-service rooms.** Any group can create a room and receives a 6-character code. Codes are isolated: one group can never read or write another's work.
- **Any PDF, not just this one.** The Studio (`/studio/`) imports a worksheet PDF in the browser, finds the answer areas, lets a teacher fix them, and publishes it to a project. Answers *grow*: a long answer pushes the rest of the page down instead of scrolling inside a box. Students can do it themselves: *Buat ruang dari PDF* turns the PDF the teacher sent into a group room with a code, no account. Teachers who want more get accounts, rooms per group and a live view of every group's answers; students still only need the code.
- **An admin console.** A separate code opens a console listing every running room with live presence, answer previews, and reset/delete/report actions.
- **Material 3 Expressive.** The application chrome (gate, tool bar, admin) follows M3 Expressive — official motion curves, the shape scale, connected button groups, and a circular wavy progress indicator.

## Architecture

Three deployables, because Cloudflare Pages cannot host Durable Objects itself:

```
src/gate/       Pages project — the landing page, login, admin console, and the
                gate that serves the worksheet. Advanced mode (_worker.js).
src/worksheet/  The worksheet itself (static HTML + the shared wave module).
src/rooms/      A Worker hosting the Durable Object classes:
                  WorksheetRoom  — one instance per group (SQLite + WebSockets)
                  RoomRegistry   — code → room mapping (hashes only) + project
                  AccountStore   — teacher accounts, project index
                  Project        — one imported sheet (versioned) + members + rooms
src/sheet/      Imported sheets: importer (PDF → sheet.json), player (reflow),
                room page for project rooms, validator. Format: src/sheet/format.md
src/studio/     The Studio: import, review, publish, run a class. Static.
```

Accounts and projects: [`docs/design/projects.md`](docs/design/projects.md). A room whose project is the built-in `lkpd-cerpen` serves the hand-built worksheet; any other project's rooms serve its imported sheet in the player, over the same `WorksheetRoom` protocol.

The Pages project binds to the rooms Worker's Durable Objects via `script_name`.

```
Browser ──► Pages (gate) ──► RoomRegistry DO ──► room lookup
                │
                └──► WorksheetRoom DO ──► WebSocket fan-out per room
```

### One source of truth

`src/` is authoritative. At deploy time the gate needs `landing.js` beside `_worker.js`, and Pages serves from `public/` — so a small script assembles the deployable layout:

```bash
node scripts/sync.mjs          # src/ -> build/
node scripts/sync.mjs --check  # fail if build/ has drifted
```

`build/` is generated and gitignored. Never edit it by hand; edit `src/` and re-sync. (Editing three copies by hand is exactly how they drifted before.)

### The login container transform

The gate card does not simply disappear on login. It **morphs into the room's tool bar**:

1. The card shrinks into a **square** parked where the naming card will land, holding a circular wavy indeterminate indicator.
2. The worksheet is **prefetched while the indicator is still spinning**, then written into the page in place — so the loader covers the real download instead of preceding it.
3. The square expands into the name card (first visit) or the tool bar (returning user).

On logout the whole thing runs in reverse.

## Getting started

```bash
git clone https://github.com/Hark-id/ELKPD-ify.git
cd ELKPD-ify
npm install -g wrangler        # or use npx wrangler
```

### 1. Build and deploy the rooms Worker

```bash
node scripts/sync.mjs
cd build/rooms
npx wrangler deploy
```

Note the Worker name — the Pages project must reference it.

### 2. Configure the gate

Edit `src/gate/wrangler.toml` so the `script_name` on both Durable Object bindings matches the Worker you just deployed.

### 3. Set secrets

```bash
cd build/gate
npx wrangler pages secret put SESSION_SECRET   # any 32+ random bytes
npx wrangler pages secret put ADMIN_CODE       # e.g. ADMIN!@#$%^
```

`GROUP_CODE` is optional — it preserves a legacy fixed room. Leave it unset for a pure self-service deployment.

### 4. Deploy the gate

```bash
node scripts/sync.mjs
cd build/gate
npx wrangler pages deploy --project-name elkpd-ify
```

### Local development

The Studio alone (no backend: import, edit, preview, export .html) needs only a static server:

```bash
node scripts/dev-studio.mjs            # http://127.0.0.1:8788/src/studio/
```

The whole stack, accounts and live project rooms included:

```bash
node scripts/sync.mjs
(cd build/rooms && npx wrangler dev --port 8801)
(cd build/gate  && npx wrangler pages dev public --port 8802 \
   --do ROOM=WorksheetRoom@lkpd-cerpen-rooms --do REGISTRY=RoomRegistry@lkpd-cerpen-rooms \
   --do ACCOUNTS=AccountStore@lkpd-cerpen-rooms --do PROJECT=Project@lkpd-cerpen-rooms)   # with .dev.vars as below
# Studio: http://127.0.0.1:8802/studio/
```

Some wrangler versions don't read the `script_name` bindings from `wrangler.toml` in `pages dev`; the `--do` flags make it explicit. Without them every `/api/account/*` call answers 501.

The rooms Worker carries Durable Object migration `v2` (AccountStore, Project): deploy it before the gate. Set `REGISTER_CODE` on the gate to require a code for teacher sign-up.

```bash
node scripts/sync.mjs
cd build/gate
cp ../../src/gate/.dev.vars.example .dev.vars   # then edit
npx wrangler pages dev public
```

## Tests

CI runs on every push and PR: a fast **static** job (build sync, syntax, secret guard) and, when `ELKPD_URL` is configured, the **browser suites**.

The `tests/` directory holds the browser-driven suites used to verify behaviour. They run against a **deployed** URL via the Chrome DevTools Protocol, so they need no test framework:

```bash
node tests/test-btngroup2.mjs     # connected button group behaviour
node tests/test-loading-stage.mjs # the loading square + indicator
node tests/test-race.mjs          # first-paint continuity under throttling
node tests/test-blue.mjs          # no OS-blue highlights anywhere
```

Each suite prints `PASS`/`FAIL` per assertion and exits non-zero on failure. Point them at your own deployment with `ELKPD_URL=https://your-project.pages.dev`; the browser is located automatically (override with `CHROME_PATH`).

The Studio and imported sheets have local suites that need no deployment (`npm ci` in `scripts/pdf-import` first, for pdf.js under Node):

```bash
node tests/test-import.mjs     # importer on the demo PDF and the LKPD
node tests/test-studio.mjs     # Studio end to end in headless Chrome
ELKPD_URL=http://127.0.0.1:8802 node tests/test-projects.mjs   # accounts, projects, two students live
ELKPD_URL=http://127.0.0.1:8802 node tests/test-student-rooms.mjs   # a student's PDF -> a room, no account
```

## Design notes

The M3 decisions are documented in [`docs/design-notes.md`](docs/design-notes.md), including the ones that were counterintuitive:

- **Optical roundness** — nested corners use `outer − padding = inner`, not the same radius twice.
- **Small travel needs a duration floor** — a corner-radius change on a 32px control takes *longer* than a 14px pane slide, not shorter.
- **Connected button groups do not resize** — the width animation belongs to the *standard* variant.
- **A selected state must hold** — morphing and immediately reverting makes the change meaningless.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: keep the worksheet faithful to the source PDF, keep the chrome in M3, and run the test suites before opening a PR.

## Licence

MIT — see [`LICENSE`](LICENSE).

The worksheet content itself belongs to its author (SMA Negeri 3 Yogyakarta); the PDF in `reference/` is included only so contributors can verify reproduction fidelity.
