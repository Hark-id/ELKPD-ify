# Contributing to ELKPD-ify

Thanks for helping. This project has two very different halves, and they follow different rules.

## The two rules

**1. The worksheet must stay faithful to the source PDF.**
The sheet in `src/worksheet/worksheet.html` is a reproduction of a real printed LKPD. Colours are sampled from the PDF's own vector fills; typography and spacing match the original. Do not "improve" the document's design — if it looks different from the PDF, that is a bug. The PDF is in `reference/` so you can compare.

**2. The application chrome must follow Material 3 Expressive.**
The gate, the tool bar, and the admin console are app UI, not document content. They use the official M3 motion curves, the shape scale, and the component specs. When adding a control, check the spec on [m3.material.io](https://m3.material.io) first — `reference/m3-specs/` holds the pages already extracted.

## Non-negotiables

These have all been bugs at least once. Please don't reintroduce them.

- **No OS-blue highlights.** Every tappable or focusable element needs `-webkit-tap-highlight-color: transparent`, a palette `::selection`, and an explicit `:focus-visible` ring in the app's own colours. Never remove the focus ring — recolour it. Run `node tests/test-blue.mjs`.
- **Never rely on a CSS keyframe to un-hide an element.** If the animation doesn't run, the element stays at the keyframe's `from` state (usually `opacity: 0`) and renders invisible. Drive entrances with WAAPI and set the resting state explicitly.
- **A `fill: 'both'` transform animation holds its end value forever** — and even `transform: none` computes to the identity matrix, which still creates a containing block for `position: fixed` descendants. Cancel fills on finish.
- **`display` on an author rule defeats `[hidden]`.** If you style `display` on something toggled with the `hidden` attribute, add an explicit `.thing[hidden] { display: none }`.
- **The loader must cover the load, not precede it.** The worksheet is prefetched while the indicator spins and written in place. Don't replace that with a plain `location.reload()`.

## Workflow

```bash
git checkout -b fix/short-description
# make your change
node tests/test-btngroup2.mjs   # and whichever suites your change touches
git commit -m "fix: describe what changed and why"
```

Open a PR against `main`. Describe **what you observed** and **what you changed** — screenshots or a short screen recording are very welcome for anything visual.

## Testing

### What CI runs

Every push and PR runs the **Static checks** job, which needs no browser and takes about 5 seconds:

- assembles `build/` from `src/` and **fails if they have drifted** (so never edit `build/` by hand)
- syntax-checks every tracked `.js`/`.mjs`
- **guards against committed secrets** — a literal admin code, a session secret, or a committed `.dev.vars` fails the build

The **Browser suites** job runs the CDP suites against a deployment. It is skipped unless the repository has an `ELKPD_URL` variable set (Settings → Secrets and variables → Actions → Variables). The admin suites additionally need an `ELKPD_ADMIN_CODE` secret.

### Running them yourself

The suites in `tests/` drive a real browser over the Chrome DevTools Protocol against a deployed URL. They need no test framework:

```bash
node tests/test-blue.mjs
```

Each prints `PASS`/`FAIL` per assertion and exits non-zero on failure.

Point them at your own deployment with an environment variable — no file editing needed:

```bash
ELKPD_URL=https://your-project.pages.dev node tests/test-blue.mjs
```

The browser is found automatically (Windows, macOS, and Linux paths are tried); override with `CHROME_PATH` if yours is elsewhere. The admin suites also need `ELKPD_ADMIN_CODE` — **never hardcode it**, the repo is public.

If you add a behaviour, add a suite for it. The existing ones are named for the behaviour they guard, not the file they touch.

## Code style

- Plain ES2020 in the Workers; no build step, no bundler, no framework.
- The worksheet is a single self-contained HTML file — keep it that way (it is served as one document and written in place).
- Comments explain *why*, especially where a decision was counterintuitive. Several comments in this repo exist because the obvious approach was wrong.
- Match the surrounding style: 2-space indent, semicolons, `var`/`function` in the worksheet (it targets older mobile browsers), `const`/`let` in the Workers.

## Reporting bugs

Include the surface (gate / worksheet / admin), what you expected, what happened, and the browser. If it's visual, a screenshot helps enormously.
