# Student rooms (#15)

An addendum to `projects.md` (#11). It covers a new access class: sheets
that students bring in themselves, with no account anywhere.

## What it is

A student imports the teacher's PDF in the Studio's group mode
(`/studio/?untuk=kelompok`) and presses **Buat ruang**. The gate stores the
sheet in an **anonymous project** (`anon-…`: no owner, no members, never
listed) and creates a room for it. It also sets a room session, minted by
`_worker.js`'s own `makeSession` through a hook.

## Who can do what

| Holder of… | Teacher project | Anonymous project |
|---|---|---|
| a room session | fill in, see presence | fill in, see presence, **re-publish the sheet** (`PUT /api/room/sheet`), **open rooms for other groups** (`POST /api/room/new-room`), **delete this room** (`POST /api/room/delete`) |
| an account | per role (owner/editor/viewer) | nothing: anonymous projects have no members |

`GET /api/room/sheet` says which case applies via `X-Sheet-Editable`. The
room page shows the extra menu items only when it is `1`.

## Limits

- **Per-IP throttles, sized for a class:** a whole class is one school IP.
  - Creating rooms: 60/hour per IP, 3000/hour overall.
  - New rooms for other groups: 100/hour per IP, 5000/hour overall.
  - Re-publishing: 120/hour per IP.
- **Sheet size:** 8 MB per student sheet (16 MB for teachers).
- **Rooms:** 40 rooms per sheet.

## Retention

- **Deleting a room** (by a student, or from the admin console) frees its
  code and answers and removes it from its project. Both paths go through
  `releaseRoom()`.
- **Last room gone:** when an anonymous project has no rooms left, the
  project and its sheet versions are deleted too.
- **Idle expiry:** an anonymous project that goes **365 days without a
  re-publish or a new room** expires through a Durable Object alarm. Its
  rooms' codes and answers go with it. A class using a sheet for a semester
  stays well inside that window.
