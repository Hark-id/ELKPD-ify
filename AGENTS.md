# AGENTS.md

Instructions for AI coding assistants — and the humans driving them — working
on ELKPD-ify. **Read this before writing code. If your memory and this file
disagree, this file wins.**

## What this project is

ELKPD-ify turns a static PDF worksheet (LKPD) into a fillable, collaborative
web page that looks like the original document, with private rooms per group.
Start with `README.md` (architecture, deploy) and `CONTRIBUTING.md` (rules,
style, testing). The source of truth is `src/`; `build/` is generated.

## Non-negotiables (from CONTRIBUTING.md)

- The worksheet must stay faithful to the source PDF in `reference/`.
- App chrome follows Material 3 Expressive.
- Never edit `build/` — edit `src/`, then run `node scripts/sync.mjs`.
- Never commit secrets; CI fails the build on them.
- Branch per change, conventional commits (`feat:`, `fix:`, `docs:`), PR
  against `main`, run the test suites your change touches.

## Coordination protocol — two developers, two AIs

This repo is developed by two humans, each driving an AI coding agent:
**@Hark-id** (DeepSeek) and **@ZafranHulaif** (other agent). So that we never
duplicate or conflict:

1. **All work is claimed through GitHub Issues.** Before starting any task,
   read the open issues (`gh issue list`). If your task has no issue, open
   one first and describe the goal. Claim an issue by assigning yourself.
   **Never start work on an issue owned by the other developer.**
2. **One issue → one branch → one PR.** Keep branches short-lived (merge
   within a day or two). Long-lived branches are how conflicts happen.
3. **Never push to `main` directly. Never force-push shared branches.**
   Everything goes through a PR reviewed by the other side.
4. **Start of every session:** `git pull origin main`, then check open PRs
   (`gh pr list`) and open issues (`gh issue list`). If your change would
   touch files another open PR is already touching, coordinate in that
   issue *before* writing code.

   **Faster:** the webhook receiver buffers recent GitHub events, so you can
   ask what changed since you last looked instead of re-listing everything.
   See `docs/webhook.md` for the endpoint and token. The buffer is a
   convenience, not the source of truth — always confirm against `gh` before
   acting.
5. **The issue is the goal.** Reference it in the PR (`Closes #N`). If the
   goal changes mid-work, update the issue first, then the code.
6. **`docs/ROADMAP.md` is the shared goal list.** Work that is not on the
   roadmap or in an issue is not agreed work — propose it first.

## Current ownership (keep this section updated)

| Area | Owner |
| --- | --- |
| `src/gate`, `src/rooms`, admin console, CI, tests | @Hark-id |
| `src/worksheet` (sheet content, faithfulness) | @Hark-id |
| Auto-fitting answer fields (#1) | @ZafranHulaif |
| Generic PDF import spike (#2) | @ZafranHulaif |
| Accounts / projects / access design (#3) | @ZafranHulaif |

Ownership is a default, not a wall: cross-area work is fine after a comment
in the relevant issue.
