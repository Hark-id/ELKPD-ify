/* Shared circular wavy indeterminate progress indicator.
   M3 Expressive progress indicator, circular variant: the active track
   is one circle whose radius is modulated along its length,

       r(θ) = R + A·sin(2π·s/λ − φ)

   where s is arc length — which is exactly the spec's definition of
   amplitude (rest position → peak) and wavelength (peak → peak). The
   arc rotates while growing and shrinking.

   Used by the gate card's loading stage AND the worksheet's tool bar,
   so the instrument reads identically everywhere. */

export const WAVE = {
  A: 0.55,        /* amplitude, in viewBox units (0 = flat track) */
  LAMBDA: 11,     /* wavelength, peak to peak */
  R: 13,          /* resting radius inside the 34×34 viewBox */
  SWEEP_MIN: 70,  /* degrees at the shortest */
  SWEEP_MAX: 265, /* degrees at the longest */
  SPIN: 155,      /* degrees/second */
  CX: 17,
  CY: 17,
  SPEED: 5.2      /* wave travel rate */
};

/* build the SVG path for one frame.
   t is elapsed seconds. */
export function wavePath(startDeg, sweepDeg, t, cfg) {
  const c = cfg || WAVE;
  const steps = Math.max(56, Math.round(sweepDeg / 0.9));
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const th = (startDeg + u * sweepDeg) * Math.PI / 180;
    const s = u * sweepDeg * Math.PI / 180 * c.R;
    const wave = c.A * Math.sin((2 * Math.PI * s / c.LAMBDA) - t * c.SPEED);
    const r = c.R + wave;
    const x = c.CX + Math.cos(th) * r;
    const y = c.CY + Math.sin(th) * r;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return d;
}

/* drive the loop; returns a stop function. Elapsed time starts mid-cycle
   so the very first frame already shows the scallops. */
export function waveLoop(pathEl, cfg) {
  const c = cfg || WAVE;
  let raf = 0;
  const t0 = performance.now() - 900;
  function frame(now) {
    const t = (now - t0) / 1000;
    const grow = (Math.sin(t * 1.55) + 1) / 2;
    const sweep = c.SWEEP_MIN + grow * (c.SWEEP_MAX - c.SWEEP_MIN);
    pathEl.setAttribute('d', wavePath((t * c.SPIN) % 360, sweep, t, c));
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  };
}
