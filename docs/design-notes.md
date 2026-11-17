# Design notes

Decisions that shaped this project, including the ones where the obvious approach turned out to be wrong. If you're changing the UI, read this first — several of these were bugs that took real debugging to find.

## The two halves

The project deliberately has **two visual languages**:

| | Language | Why |
|---|---|---|
| The worksheet | The source PDF's own design | It has to pass as the teacher's document |
| The gate, tool bar, admin | Material 3 Expressive | It's application chrome, and it should feel like a modern app |

Mixing them is the most common mistake. The worksheet's navy/gold palette and serif headings are *document fidelity*, not a design choice to be modernised. The chrome's crimson/blush palette is *app*, not something to be made to match the sheet.

## Shape

### Optical roundness

When nesting rounded objects, **do not use the same radius for both**. MD3's rule:

```
inner radius = outer radius − padding
```

The dropdown is a 20dp container with 6dp padding, so its items take 14dp. Using 10dp for both made the nested corners look pinched.

### The bar is a full pill, deliberately

The tool bar was `border-radius: 28px` at 60px tall — **2px short of a pill** — while every control inside was a true pill. That near-miss is what read as "ugly near the corners": the container's corners and its children's corners were competing curvatures. Making the bar a full pill put everything in one shape family.

Note the vertical nesting was already near-concentric (pill radius 14.5 + gap 14 = 28.5 vs bar 28). The fix was not arithmetic — it was making the container a *deliberate* shape from the scale.

### The radius must morph with the box

The gate card and name card are 28dp; the bar is a pill. Both the forward and reverse flights animate `borderRadius` alongside position and size, and the handoff rect carries the radius. Otherwise the corner visibly jumps at handoff.

## Motion

### Small travel needs a duration floor

This one is counterintuitive. The usual instinct is "shorter distance → shorter duration". That breaks down at small deltas.

The gateway panes travel **14px** over 300ms. A corner-radius change on a ~32px control is a much smaller visual delta — and scaling the duration down proportionally makes it read as a **snap**, because the eye needs a minimum amount of time to register *any* shape change. So the button group's shape change runs **420ms**, deliberately *longer* than the panes.

### No overshoot on small shapes

The expressive *fast spatial* curve has `y > 1` — it overshoots by design. On a small corner radius that overshoot reads as a jiggle. Shape changes use the emphasized curve `cubic-bezier(.2, 0, 0, 1)` instead.

### Connected button groups do not resize

MD3 has two button-group variants, and the difference matters:

- **Standard** — selecting a button changes the width and shape of that button *and its neighbours*.
- **Connected** — *"only affects the shape of the button being selected or activated."*

The first implementation here animated width, which is the *standard* behaviour. On buttons of unequal width (61 / 84 / 64px) that width change shifts the neighbours' positions and reads as jitter. A connected group must not resize at all.

### A selected state must hold

MD3 lists "connected button group **selected** states" as its own state. Morphing to round and immediately reverting makes the change meaningless. `is-selected` is a real held state driven by actual app state (the Lainnya trigger holds it while its sheet is open), and the shape only eases back when that state ends.

## The loading state

### The loader must cover the load

The original flow finished the loader animation, then called `location.reload()` — which started a **fresh ~230KB document fetch** with the old page frozen on screen. The indicator ended exactly where the real wait began. At 22 kbps that dead pause was ~21 seconds.

Now the worksheet is prefetched **while the indicator is still spinning**, then written into the page in place (`document.open()` / `document.write()` / `document.close()`). Measured: the HTML arrives and the loader retires 6–13ms later.

### The indicator is a real M3 progress indicator

Circular variant, indeterminate, with a **wavy active track**. The wave is the spec's own construction — one circle with its radius modulated along its length:

```
r(θ) = R + A·sin(2π·s/λ − φ)
```

where `s` is arc length. That is exactly the spec's definition of amplitude (rest → peak) and wavelength (peak → peak). Sample at ≤0.9° or it renders as a polygon.

### First-paint continuity

The naming stage used to flash: the room painted, *then* the stage appeared. The cause was that the pre-paint script sat after 230KB of body markup. Now:

1. A `<head>` script sets `html.morphing` / `html.stagename` before any body byte parses.
2. The crimson barrier is a `html.morphing::before` pseudo-element — it exists before any DOM.
3. The name card's first-paint geometry comes from CSS variables written in that same head script.

Verified under 240kbps throttling: 860 frames sampled, the room never painted outside the cover.

## Traps worth knowing

These are all real bugs that shipped at least once.

- **A `fill: 'both'` transform animation holds its end value forever.** Even `transform: none` computes to the identity matrix, which still creates a containing block for `position: fixed` descendants. Cancel fills on finish.
- **Never rely on a CSS keyframe to un-hide an element.** If the animation doesn't run, the element stays at the `from` state — usually `opacity: 0` — and renders invisible.
- **`display` on an author rule defeats `[hidden]`.** The dropdown was never actually folded because `.dock-menu { display: flex }` outranked the UA `[hidden] { display: none }`.
- **`display: none → flex` kills a CSS transition.** Set the state, force a reflow (`void el.offsetWidth`), *then* transition.
- **Assigning `input.value` resets the caret to the end.** Read `selectionStart` before assigning if you're transforming the value.
- **`performance.now()` resets on a document swap.** Cross-document timing needs `Date.now()`.
- **Headless Chrome freezes animations between style recalcs.** A screenshot taken 500ms after opening a staggered menu shows it mid-flight and looks broken. Measure rects with a script, or shoot with `--force-prefers-reduced-motion`.

## Colour

The gate's palette is generated from a crimson seed with Google's `@material/material-color-utilities` (HCT tonal palettes), not hand-picked hexes. Three tiers: surface (tone 35), container (tone 14), primary (tone 90).

For this user, **"pastel" means soft in texture, not pale in colour** — the softness comes from matte grain and feathered gradients, never from mixing toward white.
