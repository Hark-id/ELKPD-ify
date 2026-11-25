# Design: accounts, projects, imported sheets (#3)

Status: **proposal**. Needs sign-off from both developers before any code
under `src/gate/` or `src/rooms/` changes (AGENTS.md, #3 acceptance).

## Goal

Today ELKPD-ify serves **one** hand-built worksheet. Anyone with a room code
gets that sheet. The goal (#3 + the #2 recommendation) is:

> A teacher uploads *any* worksheet PDF, reviews what the importer found,
> and publishes it. Groups open it with a room code and fill it in together,
> live. The page looks like the paper but behaves better than the paper:
> answers grow, the layout makes room for them, and it works on a phone.

That needs three things the app doesn't have: **accounts** (who owns a
worksheet), **projects** (a worksheet plus its rooms and sharing), and a
**sheet format** that the app can serve instead of one fixed HTML file.

## Concepts

```
Account ──owns / is shared──► Project ──has──► Sheet (versioned JSON)
                                  │
                                  └──has many──► Room (one per group, live)
                                                   └─ answers, presence
```

| Concept | What it is | Who uses it |
|---|---|---|
| **Account** | A person who *makes* worksheets: username + password. | Teachers, us. |
| **Project** | One worksheet: its sheet, its rooms, who can edit it. | Owner + people they share it with. |
| **Sheet** | The page content: background, text, fields. Produced by the importer, edited in the Studio. Versioned (last 5 kept); rooms always serve the latest version, so a teacher's fix reaches every group. Field ids are stable, so answers survive a re-publish. | Everyone (rendered by the player). |
| **Room** | Unchanged from today: one Durable Object per group, answers + presence over WebSocket, joined with a 6-character code. | Students. **No account needed.** |

The key decision: **students never need an account.** Classroom reality is
"type the code on the board". Accounts are only for people who create and
manage worksheets. A room code keeps being the student's whole identity,
exactly like today.

## Identity (who logs in, and how)

- **Username + password.** No email infrastructure exists and teachers at a
  school don't need password reset by mail on day one; an owner can reset a
  co-editor, the admin console can reset anyone.
- Passwords: **PBKDF2-SHA256, 100 000 iterations** (the Workers WebCrypto
  maximum), 16-byte random salt, stored as `pbkdf2$100000$salt$hash`.
- Session: a second cookie, `elkpd_user`, separate from the room cookie
  `lkm_session`, so a teacher can be logged in *and* sit in a room.
  Token = `userId.expiry.HMAC-SHA256(secret, userId.expiry)`.
  **Proposal for the room cookie too:** switch `sha256(payload.secret)` to
  HMAC. Not exploitable today (SHA-256 isn't length-extendable through a
  suffix secret this way), but HMAC is the standard construction and costs
  nothing. Old tokens stay valid until expiry by accepting both for 7 days.
- Rate limiting: per-username failure counter in the account store (5 failures
  → 30 s lockout, doubling), plus the existing 400 ms delay.
- Later (not v1): passkeys (WebAuthn works in Workers).

## Access model

Canva-like, three roles per project:

| Role | Can |
|---|---|
| **owner** | everything, incl. delete project, transfer ownership, manage sharing |
| **editor** | edit the sheet in the Studio, publish versions, create/delete rooms, see answers |
| **viewer** | open the project, see rooms and answers (e.g. a co-teacher grading) |

Sharing is by username. A project also has a **room link** per room
(`/j/<CODE>`) which is just today's room code in URL form: the "share
link" mode #3 asks about.

## Storage

All Durable Object SQLite, hosted by the existing rooms Worker (it already
is the DO host; no new deployable):

| DO | Instances | Tables |
|---|---|---|
| `AccountStore` (new) | 1, `idFromName("global")` | `users(id, username UNIQUE, pw, display_name, created_at, failures, locked_until)`, `memberships(user_id, project_id, role)` (an index: which projects can I see) |
| `Project` (new) | 1 per project | `meta(key, value)`, `sheet_versions(version, created_at, created_by, size)`, `sheet_chunks(version, n, data)`, `members(user_id, role)`, `rooms(room_id, label, created_at)` |
| `RoomRegistry` | unchanged | `rooms` gains `project_id TEXT NOT NULL DEFAULT 'lkpd-cerpen'` |
| `WorksheetRoom` | unchanged | unchanged |

- **Why chunks:** a DO SQLite value is capped at 2 MB; an imported sheet with
  images can be several MB. The sheet JSON is split into 1 MB chunks.
  Hard cap per version: 16 MB. The last 5 versions are kept.
- **Why the membership index lives in `AccountStore`:** "list my projects"
  must not fan out to every project DO. The project DO is the source of
  truth for its members; `AccountStore.memberships` is a cache that the
  gate writes alongside every sharing change.
- **D1 instead?** D1 would make cross-project queries easier but adds a
  binding, a migration story and a second consistency model. Everything we
  need is "by id" or "by user", which DOs do well. Revisit if we need
  search across all projects.

## The sheet format (`sheet.json`, v1)

Produced by the importer, edited by the Studio, rendered by the player. All
geometry in **PDF points**, origin top-left.

```jsonc
{
  "format": "elkpd-sheet", "version": 1,
  "title": "Ekosistem Kolam",
  "source": { "name": "kolam.pdf", "pages": 2, "sha256": "…" },
  "fonts": { "g_d0_f1": { "css": "'Georgia', 'Gelasio', serif", "web": ["Gelasio"] } },
  "pages": [{
    "id": "p1", "width": 612, "height": 792,
    "background": "<svg …>",          // everything painted, minus text
    "text": [{ "id": "t1", "x": 72, "y": 90, "baseline": 101, "w": 210,
               "font": "g_d0_f1", "weight": 700, "style": "normal",
               "size": 14, "color": "#1b1b1f", "str": "Nama", "rot": 0 }],
    "fields": [{ "id": "nama", "kind": "text", "x": 120, "y": 88, "w": 300, "h": 16,
                 "label": "Nama", "placeholder": "", "grow": true, "lines": 1 }]
  }]
}
```

Field kinds (v1): `text`, `textarea` (lined or boxed), `checkbox`, `date`,
`number`. (A radio-group `choice` kind is left for a later version.) The
authoritative format is `src/sheet/format.md`; this is a sketch of it.

**Answer keys.** Field ids are the answer keys in the room, and they are
stored, never derived from position: reordering pages or moving a field
keeps its id. When a sheet is re-published:
- a field that still exists keeps its answers;
- a field that was **deleted** keeps its stored answer in the room, but the
  player no longer shows it. If a field with the same id comes back, so
  does the answer. Exports (CSV) list only the fields of the current sheet;
- a field that was **added** starts empty in every room.
Nothing is ever deleted from a room by a re-publish; only "Kosongkan"
(reset) or deleting the room removes answers.

## Flexible layout: better than the paper

The spike's scaffold is "a faithful picture with holes": a long answer
scrolls inside its box. The player instead **reflows vertically**:

1. Every page is cut into horizontal **bands** at field bottoms.
2. When a field grows (auto-grow, #1), everything below it on the page
   (background slice, text, other fields) moves down by the growth; the page
   gets taller. Side-by-side fields in one band grow together (the band
   takes the tallest).
3. The background SVG is drawn once per band with a `viewBox` window, so
   nothing is re-rasterised.

Printing keeps the grown layout, so a printed sheet shows every answer in
full. This is the "more flexible than a Canva import" part: Canva imports
are fixed boxes.

Phones: v1 scales pages to the viewport width and zooms fields on focus;
true single-column reflow (reading-order blocks) is a later step.

## Where things run

| Piece | Path | Runs in | Owner |
|---|---|---|---|
| Sheet format, importer, player | `src/sheet/` (new) | browser (importer also in Node for tests) | @ZafranHulaif |
| Studio (upload, review, publish) | `src/studio/` (new) | browser, served by the gate to accounts | @ZafranHulaif |
| Accounts + projects API | `src/gate/` (new routes) | Pages Function | @ZafranHulaif proposes, @Hark-id reviews |
| `AccountStore`, `Project` DOs | `src/rooms/` | rooms Worker | @ZafranHulaif proposes, @Hark-id reviews |
| Hand-built LKPD | `src/worksheet/` | unchanged | @Hark-id |

**The importer runs in the browser**, not in a Worker. PDF parsing is
CPU-heavy (seconds for the LKPD) and Workers have tight CPU limits; the
teacher's browser has plenty and pdf.js is built for it. The server only
stores the resulting JSON. It does validate it: size caps, schema,
`background` SVG sanitised (no `<script>`, no `on*` attributes, no
`<foreignObject>`, no external `href`), since another person's browser will
render it.

## Routes (gate)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/account/register` `login` `logout` | — | accounts |
| `GET /api/account/me` | user | who am I, my projects |
| `POST /api/projects` | user | create project (with sheet v1) |
| `GET /api/projects/:id` | member | meta, members, rooms |
| `GET /api/projects/:id/sheet` | member | sheet JSON (latest) |
| `GET /api/room/sheet` | room session | the sheet of the session's room |
| `PUT /api/projects/:id/sheet` | editor | publish a new version |
| `POST /api/projects/:id/rooms` | editor | create a room → code |
| `POST /api/projects/:id/rooms/delete`, `…/rooms/reset` | editor | delete a room (frees its code) / clear its answers |
| `POST /api/projects/:id/delete` | owner | delete the project, its rooms and their answers |
| `POST /api/projects/:id/share` | owner | add/remove member, set role |
| `GET /api/projects/:id/answers` | viewer | every room's answers (grading view) |
| `GET /studio`, `/studio/:id` | user | the Studio app |
| `GET /j/:code` | — | join link: prefills the code on the gate |

The room flow is unchanged: `/api/login` with a code → room session. After
login, if the room's `project_id` is the legacy `lkpd-cerpen`, the gate
serves `worksheet.html` as today; otherwise it serves the **player**
(`src/sheet/room.html`), which loads `/api/room/sheet` and speaks the same
WebSocket protocol to the same `WorksheetRoom`. `/api/create` (self-service rooms with no project) keeps
creating LKPD rooms, so nothing about today's deployment changes.

## Migration

- Every existing room becomes a room of the built-in project
  `lkpd-cerpen` (the `DEFAULT` on the new column does this with no data
  migration). Codes, answers, the diagnostics room: unchanged.
- The admin console keeps listing all rooms, now with a project column.
- No existing route changes shape.

## Rollout, in PRs

1. **Sheet library + player + Studio, standalone** (`src/sheet/`,
   `src/studio/`; no gate/rooms changes). Import a PDF in the browser,
   review fields, preview with reflow, export/import `sheet.json`. Fully
   testable on its own; touches nothing that's deployed.
2. **Accounts + projects backend** (DOs + gate routes) behind the routes
   above, with suites. Existing flows untouched.
3. **Studio ↔ projects:** save/publish, rooms per project, the player served
   to room sessions of non-legacy projects.
4. **Teacher view:** answers per room, export (PDF via print, CSV).

Status: PR 1 is #13. PRs 2–3 are implemented as draft #14 (tested end to
end on a local stack), waiting for this doc's sign-off before they land.

## Open questions for @Hark-id

1. OK to host `AccountStore` + `Project` in the rooms Worker (one more
   migration tag), rather than a new Worker?
2. OK with the room cookie moving to HMAC (both accepted for 7 days)?
3. Should self-service `/api/create` stay LKPD-only, or be removed once
   projects exist (teachers create rooms instead)?
4. Admin console: add projects/accounts management in v1, or later?
