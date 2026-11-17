/* Admin console page — served only to a session signed for "admin-console".
   Lists every running room with its code, live presence and report status,
   and grants reset / delete / report-clear actions over each room. */

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Konsol Admin — LKPD Teks Cerpen</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&display=swap" rel="stylesheet">
<style>
  :root{
    --surface:#a80029; --container:#50000e; --primary:#ffdad9; --on-primary:#40000a;
    --on-surface:#ffe9e8; --on-variant:#f4b7b7; --rim:#613637; --accent:#ffbbbb;
    --error:#ffb4ab; --ok:#22C55E;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  /* no OS-blue anywhere: tap flash, text selection and focus rings all
     take the console's own blush/ink palette */
  ::selection{background:rgba(255,218,217,.30);color:inherit}
  button:focus-visible{
    outline:2.5px solid #ffdad9;
    outline-offset:2px;
  }
  html,body{min-height:100%}
  body{
    margin:0;padding:clamp(16px,4vw,40px);
    font-family:"Roboto Flex","Segoe UI",Roboto,Arial,sans-serif;
    color:var(--on-surface);
    background:
      radial-gradient(85% 65% at 10% -8%, rgba(182,0,45,.35) 0%, rgba(182,0,45,0) 62%),
      linear-gradient(162deg,#b6002d 0%,#a80029 40%,#890020 75%,#680015 100%);
    background-attachment:fixed;
  }
  .head{display:flex;flex-wrap:wrap;gap:10px;align-items:end;justify-content:space-between;max-width:880px;margin:0 auto 18px}
  .eyebrow{margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--on-variant)}
  h1{margin:0;font-size:clamp(24px,5vw,32px);font-weight:800;letter-spacing:-.01em}
  .head-actions{display:flex;gap:8px}
  button{font-family:inherit;cursor:pointer;touch-action:manipulation}
  .tbtn{
    font-size:12px;font-weight:600;color:var(--primary);
    background:rgba(255,218,217,.10);border:1px solid rgba(255,218,217,.22);
    border-radius:999px;padding:9px 16px;
    transition:background .15s ease;
  }
  .tbtn:hover{background:rgba(255,218,217,.20)}
  .tbtn:active{transform:scale(.96)}
  .tbtn.danger{color:var(--error);border-color:rgba(255,180,171,.3)}
  .wrap{max-width:880px;margin:0 auto}
  .room{
    background:var(--container);border:1px solid var(--rim);border-radius:20px;
    padding:16px 18px;margin:0 0 12px;
    box-shadow:0 18px 40px -24px rgba(0,0,0,.6);
  }
  .room.open{border-color:rgba(255,218,217,.4)}
  .room-head{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;cursor:pointer;width:100%;background:none;border:0;color:inherit;text-align:left;padding:0}
  .room-label{font-size:15px;font-weight:700;color:var(--on-surface)}
  .room-code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;letter-spacing:.14em;color:var(--primary);background:rgba(255,218,217,.12);border-radius:999px;padding:3px 10px}
  .room-meta{font-size:11px;color:var(--on-variant)}
  .badge{font-size:9px;font-weight:800;letter-spacing:.1em;color:var(--error);border:1px solid rgba(255,180,171,.5);border-radius:999px;padding:3px 9px}
  .live{width:7px;height:7px;border-radius:50%;background:var(--ok);display:inline-block;margin-right:4px}
  .detail{display:none;margin-top:14px;border-top:1px solid var(--rim);padding-top:14px}
  .room.open .detail{display:block}
  .ans{margin:0 0 12px}
  .ans-row{display:flex;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(255,218,217,.15);font-size:12px}
  .ans-row:last-child{border-bottom:0}
  .ans-field{color:var(--accent);font-family:ui-monospace,Consolas,monospace;flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis}
  .ans-val{color:var(--on-surface);white-space:pre-wrap;word-break:break-word}
  .ans-empty{font-size:12px;color:var(--on-variant);font-style:italic}
  .acts{display:flex;flex-wrap:wrap;gap:8px}
  .note{font-size:11px;color:var(--on-variant);margin:10px 2px 0}
  .empty{max-width:880px;margin:40px auto;text-align:center;color:var(--on-variant);font-size:13px}

  /* MD3 Expressive circular progress indicator, wavy — the same
     instrument as the gate loading stage and the worksheet tool bar */
  .loader{display:flex;justify-content:center;padding:56px 0}
  .load-box{
    width:52px;height:52px;border-radius:50%;
    background:#ffdad9;display:flex;align-items:center;justify-content:center;
  }
  .load-box svg{width:34px;height:34px;display:block;overflow:visible}
  .load-box .ld-arc{fill:none;stroke:#40000a;stroke-width:4;stroke-linecap:round}
  .load-box .ld-track{fill:none;stroke:rgba(64,0,10,.20);stroke-width:4}
  @media (prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important}}
</style>
</head>
<body>
<div class="head">
  <div>
    <p class="eyebrow">LKPD Teks Cerpen &middot; SMA Negeri 3 Yogyakarta</p>
    <h1>Konsol Admin</h1>
  </div>
  <div class="head-actions">
    <button class="tbtn" id="refresh" type="button">Muat ulang</button>
    <button class="tbtn danger" id="leave" type="button">Keluar</button>
  </div>
</div>
<div class="wrap" id="rooms"><p class="empty">Memuat daftar grup…</p></div>

<script>
(function(){
/* Shared circular wavy indeterminate progress indicator.
   M3 Expressive progress indicator, circular variant: the active track
   is one circle whose radius is modulated along its length,

       r(θ) = R + A·sin(2π·s/λ − φ)

   where s is arc length — which is exactly the spec's definition of
   amplitude (rest position → peak) and wavelength (peak → peak). The
   arc rotates while growing and shrinking.

   Used by the gate card's loading stage AND the worksheet's tool bar,
   so the instrument reads identically everywhere. */

var WAVE = {
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
function wavePath(startDeg, sweepDeg, t, cfg) {
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
function waveLoop(pathEl, cfg) {
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

window.WaveLoading={WAVE:WAVE,wavePath:wavePath,waveLoop:waveLoop};
})();
</script>
<script>
(function () {
  "use strict";
  var roomsEl = document.getElementById("rooms");
  var openId = null;
  var RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var loaderHTML = '<div class="loader"><span class="load-box">' +
    '<svg viewBox="0 0 34 34" aria-hidden="true">' +
    '<circle class="ld-track" cx="17" cy="17" r="13"></circle>' +
    '<path class="ld-arc" d=""></path></svg></span></div>';

  /* the wave is the shared construction site (inlined below) */
  function startLoader() {
    var path = roomsEl.querySelector(".load-box .ld-arc");
    if (!path || !window.WaveLoading) return;
    if (RM) { path.setAttribute("d", window.WaveLoading.wavePath(-90, 250, 0)); return; }
    var stop = window.WaveLoading.waveLoop(path);
    /* stop when this loader leaves the DOM */
    var iv = setInterval(function(){ if(!path.isConnected){ stop(); clearInterval(iv); } }, 500);
  }

  function fmtDate(t) {
    try { return new Date(Number(t)).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function loadList() {
    roomsEl.innerHTML = loaderHTML;
    startLoader();
    var data;
    try {
      data = await (await fetch("/api/admin/list", { method: "POST" })).json();
    } catch (e) {
      roomsEl.appendChild(el("p", "empty", "Tidak dapat memuat daftar grup."));
      return;
    }
    roomsEl.textContent = "";
    var rooms = data.rooms || [];
    if (!rooms.length) {
      roomsEl.appendChild(el("p", "empty", "Belum ada grup yang dibuat."));
      return;
    }
    rooms.forEach(function (r) {
      var card = el("div", "room" + (r.room_id === openId ? " open" : ""));
      var head = el("button", "room-head");
      head.type = "button";
      head.appendChild(el("span", "room-label", r.label || "(tanpa nama)"));
      head.appendChild(el("span", "room-code", r.code || "—"));
      var meta = el("span", "room-meta");
      var live = el("span", "live");
      meta.appendChild(live);
      meta.appendChild(document.createTextNode((r.peers || 0) + " online · " + fmtDate(r.created_at)));
      head.appendChild(meta);
      if (r.reported) head.appendChild(el("span", "badge", "DILAPORKAN"));
      card.appendChild(head);

      var detail = el("div", "detail");
      var ans = el("div", "ans");
      detail.appendChild(ans);
      var acts = el("div", "acts");
      detail.appendChild(acts);
      var note = el("p", "note");
      detail.appendChild(note);
      card.appendChild(detail);
      roomsEl.appendChild(card);

      /* the roster cascades in — motion carries the eye down the list */
      if (!RM && card.animate) {
        card.animate(
          [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
          { duration: 320, delay: Math.min(Math.floor(rooms.indexOf(r)) * 55, 440), easing: "cubic-bezier(.34,.88,.34,1)", fill: "both" }
        );
      }

      head.addEventListener("click", function () {
        var isOpen = card.classList.contains("open");
        document.querySelectorAll(".room.open").forEach(function (n) { n.classList.remove("open"); });
        if (!isOpen) {
          card.classList.add("open");
          if (!RM && detail.animate) {
            detail.animate(
              [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }],
              { duration: 260, easing: "cubic-bezier(.34,.88,.34,1)", fill: "both" }
            );
          }
          loadRoom(r, ans, acts, note);
        }
      });
      if (r.room_id === openId) loadRoom(r, ans, acts, note);
    });
  }

  async function loadRoom(r, ans, acts, note) {
    openId = r.room_id;
    ans.textContent = "Memuat jawaban…";
    note.textContent = r.report_note ? ("Catatan laporan: " + r.report_note) : "";
    acts.textContent = "";
    var data = { answers: {}, peers: [] };
    try {
      data = await (await fetch("/api/admin/room", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: r.room_id })
      })).json();
    } catch (e) { }
    var keys = Object.keys(data.answers || {});
    ans.textContent = "";
    if (!keys.length) {
      ans.appendChild(el("p", "ans-empty", "Lembar jawaban masih kosong."));
    } else {
      keys.forEach(function (k) {
        var row = el("div", "ans-row");
        row.appendChild(el("span", "ans-field", k));
        var v = String(data.answers[k] || "");
        row.appendChild(el("span", "ans-val", v.length > 160 ? v.slice(0, 160) + "…" : v));
        ans.appendChild(row);
      });
      note.textContent = keys.length + " isian tersimpan" +
        (data.peers && data.peers.length ? " · online: " + data.peers.map(function (p) { return p.name; }).join(", ") : "");
    }

    function mk(label, cls, fn) {
      var b = el("button", "tbtn" + (cls ? " " + cls : ""), label);
      b.type = "button";
      b.addEventListener("click", fn);
      acts.appendChild(b);
    }
    if (r.reported) {
      mk("Hapus laporan", "", async function () {
        await fetch("/api/admin/report-clear", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: r.room_id })
        });
        loadList();
      });
    }
    mk("Kosongkan jawaban", "danger", async function () {
      if (!confirm("Kosongkan SEMUA jawaban di grup \\"" + (r.label || r.code) + "\\"?")) return;
      await fetch("/api/admin/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: r.room_id })
      });
      loadList();
    });
    mk("Hapus grup", "danger", async function () {
      if (!confirm("Hapus grup \\"" + (r.label || r.code) + "\\"? Kode grup tidak akan berlaku lagi.")) return;
      await fetch("/api/admin/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: r.room_id })
      });
      openId = null;
      loadList();
    });
  }

  document.getElementById("refresh").addEventListener("click", loadList);
  document.getElementById("leave").addEventListener("click", async function () {
    try { await fetch("/api/logout", { method: "POST" }); } catch (e) { }
    location.reload();
  });
  loadList();
})();
</script>
</body>
</html>`;
