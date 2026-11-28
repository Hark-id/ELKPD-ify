/* Realistic scanned worksheets for the OCR engine (src/sheet/ocr.js, #23).
 * There is no scanned PDF in the repo on purpose (binaries); this builds
 * them at test time:
 *
 *   1. rasterise worksheet pages: the Studio sample (pdftoppm) and a
 *      generated multiple-choice page (HTML screenshot in headless Chrome);
 *   2. degrade them in a canvas the way a phone or flatbed scan looks:
 *      1-3 deg tilt, grey or yellow paper, uneven light, blur, noise and a
 *      dark scanner edge;
 *   3. wrap each JPEG as an image-only PDF (one DCT image XObject per page,
 *      no text, no vectors), written by hand: no pdf-lib needed.
 *
 * Also a mixed PDF (a born-digital page followed by a scanned one), printed
 * by Chrome with the scan as a full-page <img>.
 *
 *   node tests/fixtures/make-scans.mjs [outDir]
 *   import { buildScans } from './fixtures/make-scans.mjs'
 *     -> { 'scan-kolam.pdf': { path, pages, tilt: [deg...] }, 'scan-pg.pdf': …, 'mixed.pdf': … } */
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DPI = 200;

// A worksheet a teacher would scan: identity leaders, numbered multiple
// choice (stacked and inline options), and essay questions answered on
// dotted lines or in blank space.
const MC = [
  ['Ekosistem yang terdiri atas komponen biotik dan abiotik disebut ....', ['populasi', 'komunitas', 'ekosistem', 'habitat', 'individu']],
  ['Contoh komponen abiotik di kolam adalah ....', ['ikan mas', 'ganggang', 'cahaya matahari', 'katak', 'bakteri']],
  ['Organisme yang berperan sebagai produsen adalah ....', ['tumbuhan hijau', 'belalang', 'ular sawah', 'elang', 'jamur']],
];
const MC_INLINE = ['Hewan yang memakan tumbuhan disebut ....', ['karnivora', 'herbivora', 'omnivora', 'detritivor', 'pengurai']];
const mcHtml = `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box } html, body { margin: 0; background: #fff }
  body { width: 794px; height: 1123px; padding: 60px 70px; font: 12pt/1.45 'DejaVu Serif', 'Times New Roman', serif; color: #111 }
  h1 { font-size: 15pt; text-align: center; margin: 0 0 2px; letter-spacing: .5px }
  .sub { text-align: center; margin: 0 0 18px; font-size: 11pt }
  .id p { margin: 3px 0 }
  h2 { font-size: 12pt; margin: 18px 0 6px }
  ol.q { margin: 0; padding-left: 24px } ol.q > li { margin: 8px 0 0 }
  ol.o { list-style: none; margin: 2px 0 0; padding-left: 4px } ol.o li { margin: 1px 0 }
  .inline span { margin-right: 22px }
  .dots { margin: 6px 0 0; letter-spacing: 1px; white-space: nowrap; overflow: hidden }
</style></head><body>
  <h1>LEMBAR KERJA PESERTA DIDIK</h1>
  <p class="sub">IPA Kelas VII &ndash; Ekosistem</p>
  <div class="id">
    <p>Nama &nbsp;&nbsp;&nbsp;: ......................................................</p>
    <p>Kelas &nbsp;&nbsp;&nbsp;: ...........................</p>
  </div>
  <h2>A. Pilihlah jawaban yang paling tepat!</h2>
  <ol class="q">
    ${MC.map(([q, o]) => `<li>${q}<ol class="o">${o.map((t, i) => `<li>${'ABCDE'[i]}. ${t}</li>`).join('')}</ol></li>`).join('')}
    <li>${MC_INLINE[0]}<div class="inline">${MC_INLINE[1].map((t, i) => `<span>${'ABCDE'[i]}. ${t}</span>`).join('')}</div></li>
  </ol>
  <h2>B. Jawablah pertanyaan berikut!</h2>
  <ol class="q" start="5">
    <li>Sebutkan tiga contoh hewan yang hidup di kolam!
      <p class="dots">${'.'.repeat(118)}</p><p class="dots">${'.'.repeat(118)}</p></li>
    <li>Jelaskan peran pengurai dalam ekosistem kolam!<div style="height:110px"></div></li>
    <li>Apa yang terjadi jika semua ikan di kolam mati?<div style="height:40px"></div></li>
  </ol>
  <p style="margin-top:18px">Selamat mengerjakan.</p>
</body></html>`;

const BORN_DIGITAL = `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0 } * { box-sizing: border-box } html, body { margin: 0 }
  .p1 { width: 794px; height: 1123px; padding: 60px 70px; font: 12pt/1.5 'DejaVu Sans', Arial, sans-serif; break-after: page }
  .p2 { width: 794px; height: 1123px; overflow: hidden } .p2 img { display: block; width: 794px; height: 1123px }
</style></head><body><div class="p1"><h1 style="font-size:16pt">Halaman digital</h1>
  <p>1. Tuliskan namamu: ..............................................</p><p>2. Apa ibu kota Indonesia?</p></div>
  <div class="p2"><img src="__SCAN__"></div></body></html>`;

// Degrade a page image in the browser. Runs in the page; returns JPEG base64.
const DEGRADE = `async (src, o) => {
  let seed = o.seed;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const img = new Image(); img.src = src; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  // Paper, then the page multiplied onto it, tilted (a scanner bed is a bit
  // bigger than the sheet, so the tilt exposes dark bed in the corners).
  g.fillStyle = '#1d1d1f'; g.fillRect(0, 0, W, H);
  g.save(); g.translate(W / 2, H / 2); g.rotate(o.tilt * Math.PI / 180);
  g.fillStyle = o.paper; g.fillRect(-W / 2, -H / 2, W, H);
  g.globalCompositeOperation = 'multiply';
  g.filter = 'blur(' + o.blur + 'px)';
  g.drawImage(img, -W / 2, -H / 2);
  g.restore(); g.filter = 'none';
  // Uneven light: darker towards one corner.
  const lg = g.createRadialGradient(W * 0.3, H * 0.25, W * 0.1, W * 0.5, H * 0.5, W * 1.1);
  lg.addColorStop(0, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(150,150,150,1)');
  g.globalCompositeOperation = 'multiply'; g.fillStyle = lg; g.fillRect(0, 0, W, H);
  // Dark scanner edge down the left side, ragged.
  g.globalCompositeOperation = 'source-over'; g.fillStyle = '#141414';
  g.beginPath(); g.moveTo(0, 0);
  for (let y = 0; y <= H; y += 40) g.lineTo(o.edge * (0.7 + 0.6 * rnd()), y);
  g.lineTo(0, H); g.closePath(); g.fill();
  // Sensor noise.
  const d = g.getImageData(0, 0, W, H), px = d.data;
  for (let i = 0; i < px.length; i += 4) { const n = (rnd() - 0.5) * o.noise; px[i] += n; px[i + 1] += n; px[i + 2] += n; }
  g.putImageData(d, 0, 0);
  return c.toDataURL('image/jpeg', 0.72).split(',')[1];
}`;

// A PDF whose every page is one JPEG and nothing else; the page is the
// image's size at `dpi`.
export function imagePdf(jpegs, dpi = DPI) {
  const parts = []; const offsets = [];
  let len = 0;
  const push = (b) => { const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; parts.push(buf); len += buf.length; };
  const obj = (n, body, stream) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = jpegs.length;
  const kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  jpegs.forEach((j, i) => {
    const p = 3 + i * 3;
    const wPt = +(j.w * 72 / dpi).toFixed(2), hPt = +(j.h * 72 / dpi).toFixed(2);
    const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`);
    obj(p + 1, `<< /Length ${content.length} >>`, Buffer.from(content, 'latin1'));
    obj(p + 2, `<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.data.length} >>`, j.data);
  });
  const xref = len;
  const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) push(String(offsets[k]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const jpegSize = (buf) => {
  for (let i = 2; i < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF');
};

/** Build the scans into `dir` with a CDP browser from tests/cdp.mjs. */
export async function buildScans(b, dir) {
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'elkpd-scan-'));
  try {
    // 1. Rasters, as PNG data URLs.
    execFileSync('pdftoppm', ['-r', String(DPI), '-png', join(root, 'src/studio/samples/ekosistem-kolam.pdf'), join(tmp, 'kolam')]);
    const kolam = readdirSync(tmp).filter((f) => f.startsWith('kolam')).sort().map((f) => 'data:image/png;base64,' + readFileSync(join(tmp, f)).toString('base64'));
    await b.send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: DPI / 96, mobile: false });
    await b.goto('data:text/html;base64,' + Buffer.from(mcHtml).toString('base64'));
    await b.eval('document.fonts.ready.then(() => 1)');
    const shot = await b.send('Page.captureScreenshot', { format: 'png' });
    const mc = 'data:image/png;base64,' + shot.data;
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.goto('about:blank');

    // 2. Degrade. Each page gets its own tilt, paper and edge.
    const degrade = async (src, o) => {
      const b64 = await b.eval(`(${DEGRADE})(${JSON.stringify(src)}, ${JSON.stringify(o)})`);
      const data = Buffer.from(b64, 'base64');
      return { data, ...jpegSize(data), tilt: o.tilt };
    };
    const kolamScans = [
      await degrade(kolam[0], { seed: 7, tilt: 1.6, paper: '#f1ead2', blur: 0.7, noise: 22, edge: 34 }),
      await degrade(kolam[1], { seed: 11, tilt: -2.3, paper: '#dcdcd8', blur: 0.5, noise: 18, edge: 26 }),
    ];
    const mcScan = await degrade(mc, { seed: 5, tilt: -1.2, paper: '#efe6c8', blur: 0.6, noise: 20, edge: 30 });

    // 3. Wrap.
    const out = {};
    const save = (name, buf, meta) => { const path = join(dir, name); writeFileSync(path, buf); out[name] = { path, bytes: buf.length, ...meta }; };
    save('scan-kolam.pdf', imagePdf(kolamScans), { pages: 2, tilt: kolamScans.map((s) => s.tilt) });
    save('scan-pg.pdf', imagePdf([mcScan]), { pages: 1, tilt: [mcScan.tilt] });
    // Mixed: Chrome prints page 1 as real text and page 2 as one picture.
    await b.goto('data:text/html;base64,' + Buffer.from(BORN_DIGITAL.replace('__SCAN__', 'data:image/jpeg;base64,' + mcScan.data.toString('base64'))).toString('base64'));
    await b.eval(`Promise.all([...document.images].map(i => i.decode())).then(() => 1)`);
    const { data } = await b.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    save('mixed.pdf', Buffer.from(data, 'base64'), { pages: 2, tilt: [0, mcScan.tilt] });
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { launch } = await import('../cdp.mjs');
  const dir = process.argv[2] || mkdtempSync(join(tmpdir(), 'elkpd-scans-'));
  const b = await launch({ width: 1280, height: 900 });
  try {
    const out = await buildScans(b, dir);
    for (const [k, v] of Object.entries(out)) console.log(`${k}  ${(v.bytes / 1024).toFixed(0)} KB  tilt ${v.tilt.join(', ')}`);
    console.log('->', dir);
  } finally { await b.close(); }
}
