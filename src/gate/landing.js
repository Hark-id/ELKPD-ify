/* Gate / landing page — Material 3 Expressive, dark theme on a crimson field.
   Rendered only for unauthenticated visitors; the worksheet is never
   included in this response.

   Foundations are generated/read from the official sources:
   - colour roles: HCT tonal palettes generated from the crimson seed with
     Google's @material/material-color-utilities (scripts/generate-colors.mjs) —
     the three user tiers are primary-palette tones 35 / 14 / 90
   - typography: Roboto Flex (variable: weight + optical size)
   - motion: the official M3 Expressive spring→curve conversion table,
     run as WAAPI/CSS (the true-spring solver was tried and reverted as
     too jiggly): settle-bounce spatial for the card entrance and the
     card size morph, effects curves for opacity fades — panes swap
     with shared-axis Y
   - components follow the Expressive update: connected button groups
     (segmented buttons are deprecated) with shape morph on press, filled
     text fields */

export const LANDING_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#820A26">
<title>Masuk — LKPD Teks Cerpen</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&display=swap" rel="stylesheet">
<style>
  /* ============================================================
     M3 color roles — dark theme, generated from the crimson seed
     (HCT tonal palettes; see scripts/generate-colors.mjs)
     ============================================================ */
  :root{
    --surface:               #a80029;  /* tier 1 — background dark red */
    --surface-container:     #50000e;  /* tier 2 — black blended with red (card) */
    --primary:               #ffdad9;  /* tier 3 — white blended with red (CTA fill) */
    --on-primary:            #40000a;
    --primary-hover:         #ffe5e4;
    --primary-container:     #ffdad9;  /* selected segment fill */
    --on-primary-container:  #40000a;
    --on-surface:            #ffe9e8;  /* warm white text */
    --on-surface-variant:    #f4b7b7;  /* muted text (neutralVariant tone 80) */
    --outline-variant:       #613637;  /* hairline rim */
    --secondary-container:   rgba(255,255,255,.07);  /* text field well */
    --accent:                #ffbbbb;  /* rule / field indicator (primary tone 82) */
    --error:                 #ffb4ab;

    /* ---- M3 motion: official emphasized curve (legacy token set) ---- */
    --ease-emphasized:       cubic-bezier(.2,0,0,1);

    /* ---- M3 shape scale ---- */
    --shape-morph: 12px;    /* pressed segment squishes toward this */
    --shape-md:    16px;
    --shape-xl:    28px;
    --shape-full:  999px;

    /* ---- M3 motion: official expressive effects curves ---- */
    --e-effects-fast:    cubic-bezier(.31,.94,.34,1);    /* 150ms */
    --e-effects-slow:    cubic-bezier(.34,.88,.34,1);    /* 300ms */
    --e-effects-default: cubic-bezier(.34,.80,.34,1);    /* 200ms */
    --e-emphasized:      cubic-bezier(.2,0,0,1);
    --d-effects-fast:    150ms;
    --d-effects-slow:    300ms;
    --d-effects-default: 200ms;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{
    margin:0;
    display:grid;
    place-items:center;
    padding:clamp(16px,4vw,40px);
    font-family:"Roboto Flex","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    font-optical-sizing:auto;
    color:var(--on-surface);
    /* the crimson field: saturated and deep — matte via grain */
    background:
      radial-gradient(85% 65% at 10% -8%, rgba(182,0,45,.35) 0%, rgba(182,0,45,0) 62%),
      radial-gradient(75% 60% at 96% 104%, rgba(255,95,125,.14) 0%, rgba(255,95,125,0) 58%),
      linear-gradient(162deg, #b6002d 0%, #a80029 40%, #890020 75%, #680015 100%);
    background-attachment:fixed;
  }
  ::selection{background:var(--primary);color:var(--on-primary)}

  /* paper tooth — page grain */
  body::after{
    content:"";
    position:fixed;inset:0;z-index:60;pointer-events:none;
    opacity:.18;mix-blend-mode:soft-light;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  /* ---- surface container: the gate card (solid, matte) ---- */
  .card{
    position:relative;
    overflow:hidden;
    width:100%;
    max-width:430px;
    border-radius:var(--shape-xl);
    padding:clamp(24px,5vw,36px);
    background:var(--surface-container);
    border:1px solid var(--outline-variant);
    box-shadow:
      0 34px 80px -34px rgba(0,0,0,.75),
      0 12px 30px -14px rgba(0,0,0,.55);
  }
  /* paper tooth on the card — stronger than the page grain */
  .card::after{
    content:"";
    position:absolute;inset:0;
    opacity:.22;mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E");
    pointer-events:none;
  }
  .card > *{position:relative;z-index:1}

  /* ---- M3 type scale roles ---- */
  .eyebrow{  /* labelSmall */
    margin:0 0 6px;
    font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
    color:var(--on-surface-variant);
  }
  h1{        /* headlineLarge (expressive weight) */
    margin:0 0 8px;
    font-size:clamp(28px,6vw,34px);
    line-height:1.12;
    font-weight:800;
    letter-spacing:-.01em;
    color:var(--on-surface);
  }
  .sub{      /* bodyMedium */
    margin:0 0 20px;font-size:14px;line-height:1.55;color:var(--on-surface-variant)
  }

  /* ============================================================
     connected button group (M3 Expressive) — shape morph on press
     ============================================================ */
  .tabs{
    position:relative;
    display:flex;gap:4px;padding:4px;margin:0 0 20px;
    background:rgba(0,0,0,.24);
    border-radius:var(--shape-full);
  }
  .indicator{
    position:absolute;top:4px;bottom:4px;left:0;width:80px;
    background:var(--primary-container);
    border-radius:var(--shape-full);
    will-change:transform,width;
  }
  .tab{
    position:relative;z-index:1;
    touch-action:manipulation;  /* no double-tap zoom when spamming tabs */
    flex:1;
    font-family:inherit;font-size:13.5px;font-weight:600;  /* labelLarge */
    color:var(--on-surface-variant);
    background:transparent;border:0;border-radius:var(--shape-md);
    padding:11px 8px;cursor:pointer;
    /* shape morph: press squishes the corner, release springs back */
    transition:
      border-radius var(--d-effects-fast) var(--e-effects-fast),
      color var(--d-effects-default) var(--e-effects-default);
  }
  .tab:active{
    border-radius:var(--shape-morph);
  }
  .tab:hover{color:var(--on-surface)}
  .tab[aria-selected="true"]{color:var(--on-primary-container)}
  .tab:focus-visible{outline:3px solid rgba(255,218,217,.85);outline-offset:2px}
  .pane[hidden]{display:none}

  /* ---- filled text field (M3): floating label, rounded container ---- */
  .tfield{
    position:relative;
    background:var(--secondary-container, rgba(255,255,255,.07));
    border-radius:var(--shape-md);
    transition:background .15s var(--e-emphasized);
  }
  .tfield input{
    width:100%;
    padding:24px 16px 10px;
    font-family:inherit;font-size:16px;color:var(--on-surface);  /* bodyLarge */
    background:transparent;border:0;outline:none;
  }
  .tfield label{
    position:absolute;left:16px;top:17px;
    font-size:14.5px;color:var(--on-surface-variant);
    pointer-events:none;
    transition:all .18s var(--ease-emphasized);
  }
  .tfield input:focus + label,
  .tfield input:not(:placeholder-shown) + label{
    top:7px;
    font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
    color:var(--accent);
  }
  .tfield::after{
    content:"";
    position:absolute;left:14px;right:14px;bottom:0;height:2px;
    border-radius:2px 2px 0 0;
    background:transparent;
    transform:scaleX(0);
    transform-origin:left;   /* official motion: the active indicator grows from the left */
    transition:transform .3s var(--ease-emphasized);
  }
  .tfield:focus-within::after{background:var(--accent);transform:scaleX(1)}
  #code{letter-spacing:.22em;text-transform:uppercase;font-weight:700}  .support{margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--on-surface-variant)}  /* bodySmall */
  .err{margin:10px 2px 0;font-size:12px;font-weight:600;color:var(--error);min-height:17px}  /* bodySmall */

  /* ---- filled button (M3 Expressive): primary fill, labelLarge, pill.
         Pop via the official conversion curves: press squishes with fast
         effects, release springs back past rest with fast spatial. ---- */
  .btn{
    width:100%;
    margin-top:18px;
    font-family:inherit;font-size:13.5px;font-weight:600;  /* labelLarge */
    color:var(--on-primary);
    background:var(--primary);
    border:0;border-radius:var(--shape-full);
    padding:16px 22px;cursor:pointer;
    touch-action:manipulation;
    transition:
      transform 350ms cubic-bezier(.42,1.67,.21,.90),
      background-color 150ms cubic-bezier(.31,.94,.34,1);
  }
  .btn:active{
    transform:scale(.94);
    transition:
      transform 150ms cubic-bezier(.31,.94,.34,1),
      background-color 150ms cubic-bezier(.31,.94,.34,1);
  }
  .btn:hover{background:var(--primary-hover)}
  .btn:disabled{opacity:.65;cursor:default;transform:none}
  .btn:focus-visible{outline:3px solid rgba(255,255,255,.8);outline-offset:3px}

  /* ---- created-code confirmation ---- */
  .code-box{
    margin-top:16px;
    padding:20px;
    text-align:center;
    background:rgba(255,255,255,.05);
    border:1.5px dashed rgba(255,218,217,.5);
    border-radius:var(--shape-xl);
  }
  .code-box .lbl{
    margin:0 0 10px;
    font-size:9.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
    color:var(--accent);
  }
  .code-box .val{
    font-family:ui-monospace,Consolas,monospace;
    font-size:32px;font-weight:700;letter-spacing:.34em;
    color:var(--on-surface);user-select:all;word-break:break-all;
    text-indent:.34em;
  }
  .warn{margin:14px 2px 0;font-size:12px;line-height:1.55;color:var(--error)}
  /* third pane (#19): a link styled as the primary button */
  .pane-title{margin:2px 2px 8px;font-size:17px;font-weight:700;line-height:1.3;color:var(--on-surface)}
  .pane-lead{margin:0 2px 10px;font-size:14px;line-height:1.55;color:var(--on-surface)}
  .btn-link{display:block;box-sizing:border-box;text-align:center;text-decoration:none}
  .foot{
    margin:20px 0 0;
    font-size:11px;line-height:1.6;color:var(--on-surface-variant);
  }
  @media (prefers-reduced-motion:reduce){
    *{transition:none !important;animation:none !important}
  }

  /* ============================================================
     LOADING STAGE — M3 Expressive circular progress indicator
     While the login request is in flight the card becomes a SQUARE
     parked where the naming card will land, holding a circular,
     indeterminate indicator whose active track is WAVY.

     The wave is the spec's own definition: the arc is one circle with
     its radius modulated along its length —
         r(θ) = R + A·sin(2π·s/λ − φ)
     so amplitude measures rest→peak and wavelength peak→peak. A and λ
     are the two knobs below; set A to 0 for the flat configuration.
     ============================================================ */
  .card > #gateLoader{
    position:absolute;inset:0;z-index:3;
    /* a grid with ONE cell: the disc is the only in-flow child, so it is
       centred in both axes regardless of the label; the label is
       absolutely placed below it and cannot pull the indicator off
       centre (a flex column used to offset the disc by ~10px) */
    display:grid;
    place-items:center;
  }
  #gateLoader[hidden]{display:none}
  .ld-disc{
    width:52px;height:52px;border-radius:50%;
    background:var(--primary);          /* primary-container */
    display:flex;align-items:center;justify-content:center;
    flex:none;
    grid-area:1/1;
  }
  .ld-disc svg{width:34px;height:34px;display:block;overflow:visible}
  .ld-hint{
    position:absolute;
    top:50%;
    left:0;right:0;
    margin-top:38px;                   /* disc radius (26) + 12 gap */
    text-align:center;
    font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
    color:var(--on-surface-variant, #f4b7b7);
    pointer-events:none;
  }
</style>
</head>
<body>
<div class="card">
  <p class="eyebrow">SMA Negeri 3 Yogyakarta &middot; Bahasa Indonesia</p>
  <h1>LKPD Teks Cerpen</h1>
  <p class="sub">Lembar kerja bersama &mdash; satu kode per grup, satu lembar per grup.</p>

  <div class="tabs" role="tablist">
    <span class="indicator" aria-hidden="true"></span>
    <button class="tab" role="tab" id="tab-join" aria-selected="true" aria-controls="pane-join">Masuk</button>
    <button class="tab" role="tab" id="tab-new" aria-selected="false" aria-controls="pane-new">Grup Baru</button>
    <button class="tab" role="tab" id="tab-sheet" aria-selected="false" aria-controls="pane-sheet">e-LKPD Baru</button>
  </div>

  <!-- join -->
  <form class="pane" id="pane-join" role="tabpanel" aria-labelledby="tab-join">
    <div class="tfield">
      <input id="code" name="code" type="text" placeholder=" " autocomplete="off"
             autocapitalize="characters" spellcheck="false" required>
      <label for="code">Kode Grup</label>
    </div>
    <p class="support">Kode diberikan oleh ketua kelompok Anda. Contoh: A7KQ9Z</p>
    <button class="btn" id="btn-join" type="submit">Buka Lembar Kerja</button>
    <p class="err" id="err-join"></p>
  </form>

  <!-- create -->
  <form class="pane" id="pane-new" role="tabpanel" aria-labelledby="tab-new" hidden>
    <div class="tfield">
      <input id="label" name="label" type="text" placeholder=" " autocomplete="off" maxlength="60">
      <label for="label">Nama Kelompok (opsional)</label>
    </div>
    <p class="support">Kode dibuat otomatis. Bagikan hanya kepada anggota kelompok Anda.</p>
    <button class="btn" id="btn-new" type="submit">Buat Kode Grup</button>
    <p class="err" id="err-new"></p>

    <div id="created" hidden>
      <div class="code-box">
        <p class="lbl">Kode Grup Anda</p>
        <div class="val" id="new-code">&mdash;</div>
      </div>
      <p class="warn">Simpan kode ini sekarang. Kode tidak dapat ditampilkan lagi nanti &mdash; tanpa kode, kelompok Anda tidak bisa masuk kembali.</p>
      <button class="btn" id="btn-enter" type="button">Buka Lembar Kerja</button>
    </div>
  </form>

  <!-- student rooms (#15): a room from the teacher's own PDF. Only
       navigates, so it's a div, not a form. -->
  <div class="pane" id="pane-sheet" role="tabpanel" aria-labelledby="tab-sheet" hidden>
    <h2 class="pane-title">Buat e-LKPD dari PDF</h2>
    <p class="pane-lead">Punya PDF dari guru? Unggah PDF-nya, periksa kotak jawaban yang terdeteksi, lalu bagikan kode ruang ke kelompokmu. Tidak perlu akun.</p>
    <p class="support">Beda dengan <b>Grup Baru</b>: itu membuat ruang untuk LKPD Teks Cerpen ini, sedangkan di sini lembarnya dari PDF milikmu sendiri.</p>
    <a class="btn btn-link" id="btn-sheet" href="/studio/?untuk=kelompok">Buat dari PDF</a>
  </div>

  <p class="foot">Setiap grup memiliki lembar kerja sendiri. Kode grup Anda hanya membuka lembar kerja kelompok Anda, dan jawaban tidak pernah tercampur antar grup.</p>

  <!-- loading stage: while the login request is in flight the card
       becomes a square at the naming card's centre and holds a
       circular, wavy, indeterminate progress indicator (M3 Expressive
       progress indicator: circular variant, configurable thickness,
       wave on the active track) -->
  <div class="loader" id="gateLoader" hidden>
    <span class="ld-disc">
      <svg viewBox="0 0 34 34" role="progressbar" aria-label="Menyiapkan">
        <circle cx="17" cy="17" r="13" fill="none" stroke="rgba(64,0,10,.20)" stroke-width="4"></circle>
        <path id="ldArc" fill="none" stroke="#40000a" stroke-width="4" stroke-linecap="round" d=""></path>
      </svg>
    </span>
    <span class="ld-hint">Menyiapkan</span>
  </div>
</div>

<script>
(function () {
  var RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* official M3 Expressive web curves (m3.material.io motion specs) */
  var E = {
    spatialFast:  "cubic-bezier(.42,1.67,.21,.90)",   /* 350ms — indicator, button release */
    spatialSlow:  "cubic-bezier(.39,1.29,.35,.98)",   /* 650ms — card entrance */
    effectsFast:  "cubic-bezier(.31,.94,.34,1)",      /* 150ms — squish, pane out */
    effectsSlow:  "cubic-bezier(.34,.88,.34,1)"       /* 300ms — pane in */
  };
  var D = { spatialFast: 350, spatialSlow: 650, effectsFast: 150, effectsSlow: 300 };

  var tabJoin = document.getElementById('tab-join');
  var tabNew = document.getElementById('tab-new');
  var tabSheet = document.getElementById('tab-sheet');
  var paneJoin = document.getElementById('pane-join');
  var paneNew = document.getElementById('pane-new');
  var paneSheet = document.getElementById('pane-sheet');
  /* tab key -> [tab, pane]; the key is what sessionStorage remembers */
  var TABS = { join: [tabJoin, paneJoin], 'new': [tabNew, paneNew], sheet: [tabSheet, paneSheet] };
  var codeInput = document.getElementById('code');
  var labelInput = document.getElementById('label');

  /* The code is DISPLAYED in capitals (text-transform), so the value
     must be capitals too — otherwise a lowercase entry looks identical
     on screen but is a different string, which is confusing when
     reading a code back to someone. Uppercasing the value as it is
     typed keeps what you see and what is sent in agreement. The server
     also normalises (trim + uppercase + strip spaces/dashes), so this
     is belt-and-braces, not the only defence. */
  if (codeInput) {
    var upperCode = function () {
      var v = codeInput.value;
      var u = v.toUpperCase();
      if (u !== v) {
        /* read the caret BEFORE assigning value — assigning resets
           selectionStart to the end, which would jump the cursor */
        var pos = codeInput.selectionStart;
        codeInput.value = u;
        try { codeInput.setSelectionRange(pos, pos); } catch (e) { }
      }
    };
    codeInput.addEventListener('input', upperCode);
    codeInput.addEventListener('blur', upperCode);
    /* join links (/j/CODE redirect here as ?code=CODE): fill the code in
       so the student only presses the button */
    try {
      var linked = new URLSearchParams(location.search).get('code');
      if (linked && /^[A-Za-z0-9 -]{1,20}$/.test(linked)) {
        codeInput.value = linked.toUpperCase();
        history.replaceState(null, '', location.pathname);
      }
    } catch (e) { /* old browser: type it */ }
  }
  var indicator = document.querySelector('.indicator');
  var tabsBox = document.querySelector('.tabs');
  var gateCard = document.querySelector('.card');
  var gateLoader = document.getElementById('gateLoader');

  var currentTab = 'join';
  var indTask = null;
  var sizeAnim = null;

  /* ---- card size morph (the container-transform half) ----
     Any content change that alters the card's height — pane swaps,
     the created-code reveal, and whatever comes next — animates the
     height on the same settle-bounce spatial curve as the entrance
     instead of snapping. The height is pinned only for the duration
     of the animation and released afterwards, so real reflows
     (rotation, keyboard, font swap) still land naturally. */
  function releaseCardHeight() {
    if (!sizeAnim && gateCard.style.height) gateCard.style.height = '';
  }
  function morphCard(change) {
    /* drop any running height animation and release any pin from a
       finished one FIRST — otherwise both measurements below read the
       pinned value, fromH === toH, and the card keeps its stale pin */
    if (sizeAnim) { sizeAnim.cancel(); sizeAnim = null; }
    gateCard.style.height = '';

    var fromH = gateCard.offsetHeight;
    change();
    var toH = gateCard.offsetHeight;
    if (fromH === toH || RM || !gateCard.animate) return;

    gateCard.style.height = fromH + 'px';
    var a = gateCard.animate(
      [{ height: fromH + 'px' }, { height: toH + 'px' }],
      { duration: D.spatialSlow, easing: E.spatialSlow, fill: 'both' }
    );
    sizeAnim = a;
    a.onfinish = function () {
      sizeAnim = null;
      gateCard.style.height = toH + 'px';
      a.cancel();  /* release the fill — the inline style holds the value */
    };
  }

  /* ---- container transform (outbound half) ----
     On a successful login the card flies to its destination on the
     settle-bounce curve while its content yields. The destination
     depends on whether this browser already has a saved
     collaboration name for the room:
       · with one → the tool bar (floating strip at the top);
       · without → the intermediary NAME CARD, centred where the
         card was; the worksheet runs the second flight (name card
         → tool bar) once the name is submitted.
     The handoff rect + stage go to sessionStorage; the worksheet
     paints a crimson veil matching this page's last frame, then
     reveals itself beneath — no flash between the two pages. */
  /* the destination's corner radius: the bar is a FULL pill (M3
     "fully rounded") while the name card uses the 28dp extra-large
     token, so the corner must morph with the box or it visibly jumps at
     handoff. Keep these in sync with .tool-dock / #name-card. */
  var BAR = { inset: 10, h: 60, r: 30 };      /* 30 = h/2 → a true pill */
  var NAMECARD = { w: 360, h: 240, r: 28 };   /* --shape-xl */

  function barTarget() {
    /* clientWidth excludes the scrollbar the document will add */
    var w = document.documentElement.clientWidth;
    return { l: BAR.inset, t: BAR.inset, w: w - BAR.inset * 2, h: BAR.h, r: BAR.r };
  }
  function nameTarget(r) {
    var cw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var w = Math.min(NAMECARD.w, cw - BAR.inset * 2);
    var l = Math.round(r.left + r.width / 2 - w / 2);
    var t = Math.round(r.top + r.height / 2 - NAMECARD.h / 2);
    /* on short (phone) viewports keep the field above the keyboard zone */
    if (vh < 700) t = Math.round((vh - NAMECARD.h) * 0.30);
    l = Math.max(BAR.inset, Math.min(l, cw - w - BAR.inset));
    t = Math.max(BAR.inset, Math.min(t, vh - NAMECARD.h - BAR.inset));
    return { l: l, t: t, w: w, h: NAMECARD.h, r: NAMECARD.r };
  }
  function hasNameFor(roomId) {
    /* the worksheet saves the collaboration name under this exact key */
    try { return !!(roomId && localStorage.getItem('lkpd-cerpen-name:' + roomId)); }
    catch (e) { return false; }
  }

  /* ============================================================
     CIRCULAR WAVY INDETERMINATE INDICATOR
     M3 Expressive progress indicator, circular variant: the active
     track is a circle whose radius waves along its length, and the
     arc rotates while growing and shrinking.
     ============================================================ */
  var LD = { A: 0.55, LAMBDA: 11, R: 13, SWEEP_MIN: 70, SWEEP_MAX: 265, SPIN: 155 };
  var ldArc = document.getElementById('ldArc');
  var ldTask = 0, ldT0 = 0;

  function ldPath(startDeg, sweepDeg, t) {
    var steps = Math.max(56, Math.round(sweepDeg / 0.9));
    var d = '';
    for (var i = 0; i <= steps; i++) {
      var u = i / steps;
      var th = (startDeg + u * sweepDeg) * Math.PI / 180;
      /* arc length so far, in the indicator's own units */
      var s = u * sweepDeg * Math.PI / 180 * LD.R;
      var wave = LD.A * Math.sin((2 * Math.PI * s / LD.LAMBDA) - t * 5.2);
      var r = LD.R + wave;
      var x = 17 + Math.cos(th) * r;
      var y = 17 + Math.sin(th) * r;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d;
  }

  function ldStart() {
    if (!ldArc || ldTask) return;
    if (RM) { ldArc.setAttribute('d', ldPath(-90, 250, 0)); return; }
    ldT0 = performance.now();
    (function loop(now) {
      var t = (now - ldT0) / 1000;
      var grow = (Math.sin(t * 1.55) + 1) / 2;
      var sweep = LD.SWEEP_MIN + grow * (LD.SWEEP_MAX - LD.SWEEP_MIN);
      ldArc.setAttribute('d', ldPath((t * LD.SPIN) % 360, sweep, t));
      ldTask = requestAnimationFrame(loop);
    })(ldT0);
  }
  function ldStop() {
    if (ldTask) { cancelAnimationFrame(ldTask); ldTask = 0; }
  }

  /* the disc's entrance, driven here rather than by a CSS keyframe so a
     suppressed animation can never leave it stuck invisible */
  function showLoader() {
    gateLoader.hidden = false;
    var disc = gateLoader.querySelector('.ld-disc');
    var hint = gateLoader.querySelector('.ld-hint');
    if (disc && disc.animate) {
      if (RM) {
        disc.style.opacity = '1';
        disc.style.transform = 'none';
        if (hint) hint.style.opacity = '1';
      } else {
        disc.animate(
          [{ opacity: 0, transform: 'scale(.55)' }, { opacity: 1, transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(.42,1.67,.21,.90)', fill: 'both' }
        ).onfinish = function () {
          /* drop the fill, then pin the natural state inline */
          disc.style.opacity = '1';
          disc.style.transform = 'none';
        };
        if (hint) hint.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: 300, delay: 120, easing: E.effectsSlow, fill: 'both' }
        ).onfinish = function () { hint.style.opacity = '1'; };
      }
    }
  }

  /* ---- the loading stage itself ----
     The card shrinks into a SQUARE at the naming card's centre and
     holds the indicator. The done(outcome) callback runs as soon as
     the request settles, so a fast network never shows the loader. */
  var MIN_LOAD_SHOW = 420;   /* ms the loader must be visible once shown */
  var LD_SIDE = 232;         /* keep in sync with the demo */

  function loadTarget() {
    var cw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var side = Math.min(LD_SIDE, Math.min(cw, vh) - 80);
    var r = gateCard.getBoundingClientRect();
    var l = Math.round(r.left + r.width / 2 - side / 2);
    var t = Math.round(r.top + r.height / 2 - side / 2);
    if (vh < 700) t = Math.round((vh - side) * 0.30);
    l = Math.max(BAR.inset, Math.min(l, cw - side - BAR.inset));
    t = Math.max(BAR.inset, Math.min(t, vh - side - BAR.inset));
    return { l: l, t: t, w: side, h: side, r: 28 };
  }

  /* morph the card to a rect, fading its content out; resolves when
     the shell has landed */
  function morphShellTo(target, contentFadeMs) {
    var r = gateCard.getBoundingClientRect();
    if (RM || !gateCard.animate) { return Promise.resolve(); }

    gateCard.style.position = 'fixed';
    gateCard.style.margin = '0';
    gateCard.style.maxWidth = 'none';
    gateCard.style.left = r.left + 'px';
    gateCard.style.top = r.top + 'px';
    gateCard.style.width = r.width + 'px';
    gateCard.style.height = r.height + 'px';
    gateCard.style.zIndex = '70';
    gateCard.style.transition = 'border-radius 240ms cubic-bezier(.34,.88,.34,1)';

    Array.prototype.forEach.call(gateCard.children, function (el) {
      if (el === gateLoader) return;
      if (el.animate) el.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: contentFadeMs, easing: E.effectsFast, fill: 'forwards' }
      );
    });

    var a = gateCard.animate(
      [
        { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' },
        { left: target.l + 'px', top: target.t + 'px', width: target.w + 'px', height: target.h + 'px' }
      ],
      { duration: D.spatialSlow, easing: E.spatialSlow, fill: 'both' }
    );
    gateCard.__flight = a;
    return new Promise(function (res) {
      a.onfinish = function () {
        gateCard.style.left = target.l + 'px';
        gateCard.style.top = target.t + 'px';
        gateCard.style.width = target.w + 'px';
        gateCard.style.height = target.h + 'px';
        a.cancel();
        gateCard.__flight = null;
        res();
      };
    });
  }

  /* the "submit → card becomes a loading square" choreography.
     request() is already in flight; whatever it resolves to we settle
     into the right next stage. */
  function runLoading(request, done, prefetch) {
    var target = loadTarget();
    var shownAt = 0;
    var aborted = false;   /* a failed request must cancel the flight */

    var flight = morphShellTo(target, D.effectsFast).then(function () {
      if (aborted) return;      /* request already failed — leave the card alone */
      gateCard.style.height = target.h + 'px';
      showLoader();
      shownAt = performance.now();
      ldStart();
    });

    Promise.resolve(request).then(function (outcome) {
      if (!outcome.ok && !shownAt) {
        /* the request failed before the square even landed: cancel the
           flight so it can't re-pin the card after we restore it */
        aborted = true;
        ldStop();
        done(outcome);
        return;
      }
      /* hold the loader until BOTH the request AND the worksheet
         download are done, so the indicator covers the real load */
      var prep = Promise.resolve(prefetch ? prefetch() : null);
      prep.then(function (html) {
        var elapsed = shownAt ? performance.now() - shownAt : MIN_LOAD_SHOW;
        var wait = Math.max(0, MIN_LOAD_SHOW - elapsed);
        /* a fast response must still let the loader register briefly —
           otherwise the square flashes and vanishes, which reads worse
           than no animation at all */
        setTimeout(function () {
          ldStop();
          done(outcome, html);
        }, shownAt ? wait : 0);
      });
    });
  }

  /* restore the card to its in-flow size when the request failed */
  function settleBackToCard() {
    ldStop();
    /* cancel a morph that may still be running (a fast failure would
       otherwise re-pin the card right after we restore it) */
    if (gateCard.__flight) { try { gateCard.__flight.cancel(); } catch (e) {} gateCard.__flight = null; }
    gateLoader.hidden = true;
    /* reset the loader's own inline state so a retry starts clean */
    var disc = gateLoader.querySelector('.ld-disc');
    var hint = gateLoader.querySelector('.ld-hint');
    if (disc) {
      if (disc.getAnimations) disc.getAnimations().forEach(function (a) { a.cancel(); });
      disc.style.opacity = ''; disc.style.transform = '';
    }
    if (hint) {
      if (hint.getAnimations) hint.getAnimations().forEach(function (a) { a.cancel(); });
      hint.style.opacity = '';
    }
    gateCard.style.cssText = '';
    gateCard.style.transition = 'none';
    void gateCard.offsetWidth;
    /* the content fades used fill:forwards — cancel them or the restored
       card stays blank */
    Array.prototype.forEach.call(gateCard.children, function (el) {
      if (el === gateLoader) return;
      if (el.getAnimations) {
        el.getAnimations().forEach(function (a) { a.cancel(); });
      }
      el.style.opacity = '';
      if (el.animate) el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 280, delay: 40, easing: E.effectsSlow, fill: 'both' }
      );
    });
  }

  function tabMetrics(tab) {
    var r = tab.getBoundingClientRect(), tr = tabsBox.getBoundingClientRect();
    return { left: r.left - tr.left, width: r.width };
  }
  function placeIndicator(tab) {
    var m = tabMetrics(tab);
    indicator.style.width = m.width + 'px';
    indicator.style.transform = 'translateX(' + m.left + 'px)';
  }
  function slideIndicator(fromTab, toTab) {
    if (!indicator.animate) { placeIndicator(toTab); return; }
    var a = tabMetrics(fromTab), b = tabMetrics(toTab);
    indicator.animate(
      [
        { width: a.width + 'px', transform: 'translateX(' + a.left + 'px) scaleX(1) scaleY(1)' },
        { width: ((a.width + b.width) / 2) + 'px',
          transform: 'translateX(' + ((a.left + b.left) / 2) + 'px) scaleX(1.15) scaleY(.90)',
          offset: 0.5 },
        { width: b.width + 'px', transform: 'translateX(' + b.left + 'px) scaleX(1) scaleY(1)' }
      ],
      { duration: D.spatialFast, easing: E.spatialFast, fill: 'both' }
    );
  }

  /* ---- tabs: sync pane toggle + shared-axis fade (effects) ----
     Pane visibility is toggled SYNCHRONOUSLY on click — the last click
     always wins and no onfinish race can leave panes invisible. The
     incoming pane then rises in on an effects curve (purely decorative). */
  function select(which) {
    /* cheapest possible guard: one variable read — clicking the tab
       that is already active does nothing at all */
    if (which === currentTab || !Object.prototype.hasOwnProperty.call(TABS, which)) return;
    var from = currentTab;
    currentTab = which;
    Object.keys(TABS).forEach(function (k) {
      TABS[k][0].setAttribute('aria-selected', k === which ? 'true' : 'false');
    });

    slideIndicator(TABS[from][0], TABS[which][0]);

    var inEl = TABS[which][1];
    morphCard(function () {
      /* remember the tab across reloads */
      try { sessionStorage.setItem('lkpd-gate-tab', which); } catch (e) {}
      /* clear stale fill:forwards animations from superseded swaps, and
         hide every other pane: a rapid 1->2->3 must leave exactly one */
      Object.keys(TABS).forEach(function (k) {
        var p = TABS[k][1];
        if (p.getAnimations) p.getAnimations().forEach(function (a) { a.cancel(); });
        p.hidden = p !== inEl;
      });
      if (!RM && inEl.animate) {
        inEl.animate(
          [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: D.effectsSlow, easing: E.effectsSlow, fill: 'both' }
        );
      }
    });
  }
  Object.keys(TABS).forEach(function (k) {
    TABS[k][0].addEventListener('click', function () { select(k); });
  });

  /* ---- restore the last-active tab across reloads ---- */
  try {
    var saved = sessionStorage.getItem('lkpd-gate-tab');
    if (Object.prototype.hasOwnProperty.call(TABS, saved)) currentTab = saved;
  } catch (e) { /* storage unavailable */ }
  Object.keys(TABS).forEach(function (k) {
    TABS[k][1].hidden = k !== currentTab;
    TABS[k][0].setAttribute('aria-selected', k === currentTab ? 'true' : 'false');
  });

  /* ---- entrance: settle bounce (expressive slow spatial) ----
     unless the worksheet just handed its tool bar back (reverse
     container transform on logout): then the card ARRIVES at the
     handoff rect and settles into its natural place, no entrance */
  var returnH = null;
  try { returnH = JSON.parse(sessionStorage.getItem('lkpd-handoff') || 'null'); } catch (e) { }
  if (returnH && returnH.stage === 'gate' && !RM && gateCard.animate) {
    try { sessionStorage.removeItem('lkpd-handoff'); } catch (e) { }
    var nat = gateCard.getBoundingClientRect();
    gateCard.style.position = 'fixed';
    gateCard.style.margin = '0';
    gateCard.style.maxWidth = 'none';
    gateCard.style.left = returnH.l + 'px';
    gateCard.style.top = returnH.t + 'px';
    gateCard.style.width = returnH.w + 'px';
    gateCard.style.height = returnH.h + 'px';
    gateCard.style.zIndex = '70';
    var ra = gateCard.animate(
      [
        { left: returnH.l + 'px', top: returnH.t + 'px', width: returnH.w + 'px', height: returnH.h + 'px' },
        { left: nat.left + 'px', top: nat.top + 'px', width: nat.width + 'px', height: nat.height + 'px' }
      ],
      { duration: D.spatialSlow, easing: E.spatialSlow, fill: 'both' }
    );
    ra.onfinish = function () {
      gateCard.style.cssText = '';  /* back to normal flow at rest */
      ra.cancel();
    };
    /* the card's content fades in as it settles */
    Array.prototype.forEach.call(gateCard.children, function (el) {
      if (el.animate) el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 300, delay: 260, easing: E.effectsSlow, fill: 'both' }
      );
    });
  } else if (!RM && gateCard.animate) {
    gateCard.animate(
      [{ opacity: 0, transform: 'translateY(64px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: D.spatialSlow, easing: E.spatialSlow, fill: 'both' }
    );
  }

  /* ---- indicator initial placement + resizes ---- */
  placeIndicator(TABS[currentTab][0]);
  window.addEventListener('resize', function () {
    placeIndicator(TABS[currentTab][0]);
    releaseCardHeight();  /* a pinned height must not fight real reflows */
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      placeIndicator(TABS[currentTab][0]);
      releaseCardHeight();
    });
  }

  /* ---- login ---- */
  var joinForm = document.getElementById('pane-join');
  var btnJoin = document.getElementById('btn-join');
  var errJoin = document.getElementById('err-join');

  joinForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    errJoin.textContent = '';
    btnJoin.disabled = true;
    btnJoin.textContent = 'Memeriksa…';

    /* fire the request and the morph together: the card becomes the
       loading square immediately, so the wait is a designed state and
       a slow network never leaves the form sitting there */
    var request = fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('code').value })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, data: data };
      });
    }).catch(function () { return { ok: false, netError: true }; });

    runLoading(request, function (outcome, html) {
      var data = outcome.data || {};
      if (outcome.ok) {
        if (hasNameFor(data.roomId)) {
          settleToStage(barTarget(), 'bar', data.roomId, html);
        } else {
          settleToStage(nameTarget(gateCard.getBoundingClientRect()), 'name', data.roomId, html);
        }
        return;
      }
      /* failure: put the card back and report why */
      settleBackToCard();
      btnJoin.disabled = false;
      btnJoin.textContent = 'Buka Lembar Kerja';
      errJoin.textContent = outcome.netError
        ? 'Tidak dapat menghubungi server.'
        : (data.error || 'Kode grup salah.');
    }, fetchWorksheet);
  });

  /* from the loading square, continue to the destination stage.
     The square already sits at the naming card's centre, so this is a
     pure expansion — the card never travels twice. */
  /* ============================================================
     Prefetch + in-place write.
     After login the browser would normally start a FRESH ~230KB
     document fetch, leaving the old page frozen while the loader is
     already gone — the "loading finished, then the site loads" gap.
     Instead we download the worksheet WHILE the loading indicator is
     still on screen, then swap the document in place. The loader now
     genuinely covers the load instead of preceding it.
     ============================================================ */
  function fetchWorksheet() {
    return fetch('/', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .catch(function () { return null; });
  }

  /* replace this document with the fetched one, in place, with no
     second network round-trip */
  function writeWorksheet(html) {
    if (!html) { location.reload(); return; }
    try {
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      location.reload();
    }
  }

  function settleToStage(target, stage, roomId, html) {
    try {
      sessionStorage.setItem('lkpd-handoff', JSON.stringify({
        stage: stage, l: target.l, t: target.t, w: target.w, h: target.h, r: target.r
      }));
    } catch (e) { }
    gateLoader.hidden = true;
    if (RM || !gateCard.animate) { writeWorksheet(html); return; }
    var from = gateCard.getBoundingClientRect();
    var fromR = getComputedStyle(gateCard).borderTopLeftRadius;
    var toR = (target.r || 28) + 'px';
    var a = gateCard.animate(
      [
        { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px', borderRadius: fromR },
        { left: target.l + 'px', top: target.t + 'px', width: target.w + 'px', height: target.h + 'px', borderRadius: toR }
      ],
      { duration: D.spatialSlow, easing: E.spatialSlow, fill: 'both' }
    );
    a.onfinish = function () {
      gateCard.style.left = target.l + 'px';
      gateCard.style.top = target.t + 'px';
      gateCard.style.width = target.w + 'px';
      gateCard.style.height = target.h + 'px';
      writeWorksheet(html);
    };
  }

  /* ---- create ---- */
  var newForm = document.getElementById('pane-new');
  var btnNew = document.getElementById('btn-new');
  var errNew = document.getElementById('err-new');
  var created = document.getElementById('created');
  var createdRoomId = '';

  newForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    errNew.textContent = '';
    btnNew.disabled = true;
    btnNew.textContent = 'Membuat…';
    try {
      var res = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: document.getElementById('label').value })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        errNew.textContent = data.error || 'Gagal membuat grup.';
      } else {
        createdRoomId = data.roomId || '';
        morphCard(function () {
          document.getElementById('new-code').textContent = data.code;
          created.hidden = false;
          btnNew.hidden = true;
          document.getElementById('label').disabled = true;
          errNew.textContent = '';
        });
      }
    } catch (err) {
      errNew.textContent = 'Tidak dapat menghubungi server.';
    }
    btnNew.disabled = false;
    btnNew.textContent = 'Buat Kode Grup';
  });

  document.getElementById('btn-enter').addEventListener('click', function () {
    /* the session cookie is already set and the room already exists, so
       there is no request to wait for — this goes straight to the stage.
       Route it through the loading square briefly so the choreography
       matches the join path, then settle. */
    var target = hasNameFor(createdRoomId)
      ? barTarget()
      : nameTarget(gateCard.getBoundingClientRect());
    var stage = hasNameFor(createdRoomId) ? 'bar' : 'name';
    runLoading(Promise.resolve({ ok: true }), function (outcome, html) {
      settleToStage(target, stage, createdRoomId, html);
    }, fetchWorksheet);
  });
})();
</script>
</body>
</html>`;
