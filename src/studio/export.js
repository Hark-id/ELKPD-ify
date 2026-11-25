// "Lembar siap pakai": one self-contained .html with the sheet and the
// player inlined. It works offline (fonts fall back), saves answers in the
// browser, prints with every answer in full, and needs no server. This is
// what a teacher can share *today*, before projects/rooms exist.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function buildStandaloneHtml(sheet) {
  const src = await (await fetch(new URL('../sheet/player.js', import.meta.url))).text();
  // The module's exports become plain declarations inside one inline module.
  const code = src.replace(/^export /gm, '').replace(/<\/script/gi, '<\\/script');
  const json = JSON.stringify(sheet).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const key = 'esh-answers:' + ((sheet.source && sheet.source.sha256) || sheet.title);
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(sheet.title)}</title>
<meta name="generator" content="ELKPD Studio">
<style>
  html,body{margin:0;background:#ece6e5;font-family:"Roboto Flex",Roboto,Arial,sans-serif;color:#231919}
  .bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fff8f7;border-bottom:1px solid #d8c2c0}
  .bar h1{flex:1;min-width:0;margin:0;font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar span{font-size:12px;color:#534342;white-space:nowrap}
  .bar button{height:36px;padding:0 16px;border:0;border-radius:999px;font:500 14px/1 inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:border-radius .15s}
  .bar button:active{border-radius:8px}
  .bar .p{background:#a80029;color:#fff}
  .bar .t{background:#ffdad9;color:#2c1515}
  .bar button:focus-visible{outline:3px solid #a80029;outline-offset:2px}
  #sheet{padding:16px 8px}
  @media print{.bar{display:none}#sheet{padding:0}html,body{background:#fff}}
</style>
</head>
<body>
<div class="bar">
  <h1>${esc(sheet.title)}</h1>
  <span id="saved" aria-live="polite"></span>
  <button class="t" id="clear" type="button">Kosongkan</button>
  <button class="p" type="button" onclick="window.print()">Cetak</button>
</div>
<div id="sheet"></div>
<script type="module">
${code}
const sheet = ${json};
const KEY = ${JSON.stringify(key)};
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
const note = document.getElementById('saved');
let t = 0;
const player = createPlayer(document.getElementById('sheet'), sheet, {
  values: saved,
  onInput() {
    clearTimeout(t);
    t = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(player.values())); note.textContent = 'Tersimpan di perangkat ini'; }
      catch (e) { note.textContent = 'Tidak bisa menyimpan'; }
    }, 300);
  },
});
document.getElementById('clear').onclick = () => {
  if (!confirm('Kosongkan semua jawaban di lembar ini?')) return;
  player.clear();
  try { localStorage.removeItem(KEY); } catch (e) {}
  note.textContent = '';
};
</script>
</body>
</html>
`;
}
