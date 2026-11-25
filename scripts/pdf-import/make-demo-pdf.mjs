#!/usr/bin/env node
// Writes the acceptance PDF for issue #2: a small, original 2-page science
// worksheet that is deliberately *unlike* the LKPD reference:
//   - written by hand (no Skia/Chrome), US Letter instead of A4
//   - non-embedded Standard-14 fonts (Helvetica, Times, Courier) with TJ
//     kerning, Tc/Tw spacing and rotated, semi-transparent text
//   - an axial gradient as a pattern fill and a radial gradient via `sh`
//   - an RGB image XObject, an inline image, a reused form XObject (footer)
//   - answer areas of every kind the importer guesses at: underscore and dot
//     leaders, dashed and solid writing lines, empty boxes, a box with a
//     caption, a ruled table with empty cells, checkboxes, and one real
//     AcroForm text field
//
//   node make-demo-pdf.mjs [out.pdf]     (default: out/demo-worksheet.pdf)
//
// The generator is committed, the PDF is not: it is reproducible.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = process.argv[2] || 'out/demo-worksheet.pdf';
const W = 612, H = 792;

// ---------------------------------------------------------- content helpers
const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
const f = (n) => +n.toFixed(3);
const rgb = (hex) => [1, 3, 5].map((i) => f(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

class Content {
  constructor() { this.ops = []; }
  raw(s) { this.ops.push(s); return this; }
  fill(hex) { return this.raw(`${rgb(hex)} rg`); }
  stroke(hex) { return this.raw(`${rgb(hex)} RG`); }
  rect(x, y, w, h, op = 'f') { return this.raw(`${f(x)} ${f(y)} ${f(w)} ${f(h)} re ${op}`); }
  line(x0, y0, x1, y1, { width = 0.75, color = '#000000', dash = null } = {}) {
    return this.raw(`q ${width} w ${rgb(color)} RG ${dash ? `[${dash.join(' ')}] 0 d` : ''} ${f(x0)} ${f(y0)} m ${f(x1)} ${f(y1)} l S Q`);
  }
  roundRect(x, y, w, h, r, op) {
    const k = 0.5523 * r;
    return this.raw([
      `${f(x + r)} ${f(y)} m`, `${f(x + w - r)} ${f(y)} l`,
      `${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)} c`,
      `${f(x + w)} ${f(y + h - r)} l`,
      `${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)} c`,
      `${f(x + r)} ${f(y + h)} l`,
      `${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)} c`,
      `${f(x)} ${f(y + r)} l`,
      `${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)} c h ${op}`,
    ].join(' '));
  }
  text(x, y, font, size, str, color = '#000000', extra = '') {
    return this.raw(`BT /${font} ${size} Tf ${rgb(color)} rg ${extra} ${f(x)} ${f(y)} Td (${esc(str)}) Tj ET`);
  }
  // Several lines with leading, using T* and ' like a typesetter would.
  para(x, y, font, size, leading, lines, color = '#000000') {
    const body = lines.map((l, i) => (i === 0 ? `(${esc(l)}) Tj` : `(${esc(l)}) '`)).join(' ');
    return this.raw(`BT /${font} ${size} Tf ${leading} TL ${rgb(color)} rg ${f(x)} ${f(y)} Td ${body} ET`);
  }
  toString() { return this.ops.join('\n'); }
}

// ---------------------------------------------------------------- page 1
function page1() {
  const c = new Content();
  // Watermark first, so everything else paints over it: rotated 30 deg,
  // 35% opacity (ExtGState), light grey.
  c.raw(`q /GSa gs BT /F2 72 Tf ${rgb('#9AA5B1')} rg 0.866 0.5 -0.5 0.866 150 250 Tm (CONTOH) Tj ET Q`);
  // Header band: axial gradient as a *pattern fill*.
  c.raw('q /Pattern cs /P1 scn 0 712 612 80 re f Q');
  c.text(40, 752, 'F2', 22, 'LEMBAR KERJA SISWA', '#FFFFFF');
  c.text(40, 731, 'F1', 11, 'IPA Kelas VII  -  Ekosistem Kolam Sekolah', '#E0F2F1');
  c.raw('q 44 0 0 44 528 730 cm /Im1 Do Q'); // logo image
  // Identity: underscore and dot leaders, plus a real AcroForm field.
  c.text(40, 680, 'F1', 11, 'Nama      : ______________________________');
  c.text(330, 680, 'F1', 11, 'Kelas : _______________');
  c.text(40, 658, 'F1', 11, 'Tanggal  : ..........................................');
  c.text(330, 658, 'F1', 11, 'Nilai :');
  c.raw(`q 0.75 w ${rgb('#607D8B')} RG 368 652 60 20 re S Q`);
  // Instructions callout: rounded, tinted, with a coloured left bar.
  c.raw(`q ${rgb('#E8F4FD')} rg ${rgb('#2B7BB9')} RG 1 w`).roundRect(40, 552, 532, 84, 8, 'B').raw('Q');
  c.raw(`q ${rgb('#2B7BB9')} rg 40 560 4 68 re f Q`);
  c.text(54, 618, 'F2', 11, 'Petunjuk', '#1F5F8F');
  c.raw(`BT /F3 11 Tf 14 TL ${rgb('#263238')} rg 54 602 Td ` +
    `[(1. Amati kolam sekolah selama 10 menit. Catat semua makhluk hidup yang kamu temukan.)] TJ T* ` +
    `[(2. W) 60 (ork) 10 (ing in pairs: satu mengamati, satu mencatat. T) 70 (ukar peran setelah 5 menit.)] TJ T* ` +
    `0.6 Tw (3. Jawab pertanyaan dengan kalimatmu sendiri, bukan salinan buku.) Tj ET`);
  // Section A with a solid underline rule (must NOT become a field).
  c.text(40, 520, 'F2', 13, 'A. Pengamatan', '#1F5F8F');
  c.line(40, 514, 572, 514, { width: 1.2, color: '#1F5F8F' });
  c.para(40, 496, 'F3', 11, 14, ['1. Sebutkan tiga makhluk hidup yang kamu lihat di kolam dan di mana', '    masing-masing ditemukan (permukaan, dalam air, dasar kolam).']);
  // Three dashed writing lines, 22pt apart -> one multi-line textarea.
  for (let i = 0; i < 3; i++) c.line(56, 450 - i * 22, 572, 450 - i * 22, { width: 0.6, color: '#90A4AE', dash: [2, 2] });
  c.para(40, 380, 'F3', 11, 14, ['2. Jelaskan bagaimana sinar matahari memengaruhi kehidupan di kolam.']);
  // Empty answer box.
  c.raw(`q 0.8 w ${rgb('#78909C')} RG 56 280 516 84 re S Q`);
  c.text(40, 258, 'F3', 11, '3. Gambarkan satu rantai makanan dari hasil pengamatanmu.');
  // Box with a caption at the top -> textarea below the caption.
  c.raw(`q ${rgb('#FAFAF5')} rg 0.8 w ${rgb('#78909C')} RG 56 104 516 140 re B Q`);
  c.text(64, 232, 'F4', 9, 'Gambar atau tulis rantai makanan di sini (gunakan tanda panah).', '#78909C');
  c.raw('q /Fm1 Do Q');
  c.text(540, 40, 'F1', 9, 'Hal. 1', '#607D8B');
  return c.toString();
}

// ---------------------------------------------------------------- page 2
function page2() {
  const c = new Content();
  // Header band: radial gradient painted with `sh` inside a clip.
  c.raw('q 0 742 612 50 re W n /Sh1 sh Q');
  c.text(40, 760, 'F2', 16, 'B. Data Pengamatan', '#FFFFFF');
  c.raw('q 18 0 0 18 548 756 cm BI /W 8 /H 8 /CS /RGB /BPC 8 /F /AHx ID ' + inlineIconHex() + '> EI Q');
  c.para(40, 712, 'F3', 11, 14, ['Isi tabel berikut. Baris 1 dan 2 sudah dicontohkan.']);
  // Ruled table: full-width horizontal rules + vertical rules (Word-style).
  const cols = [40, 72, 222, 302, 572];
  const rows = [690, 666, 636, 606, 576, 546];
  c.raw(`q ${rgb('#E0F2E9')} rg 40 666 532 24 re f Q`);
  for (const y of rows) c.line(40, y, 572, y, { width: 0.75, color: '#455A64' });
  for (const x of cols) c.line(x, rows[0], x, rows[rows.length - 1], { width: 0.75, color: '#455A64' });
  const head = ['No', 'Organisme', 'Jumlah', 'Peran dalam ekosistem'];
  head.forEach((t, i) => c.text(cols[i] + 6, 674, 'F2', 10, t, '#1B5E20'));
  for (let r = 0; r < 4; r++) c.text(52, rows[r + 1] - 19, 'F1', 10, String(r + 1));
  c.text(78, rows[1] - 19, 'F4', 10, 'Ikan mas', '#455A64');
  c.text(78, rows[2] - 19, 'F4', 10, 'Eceng gondok', '#455A64');
  // Section C: formula in Courier, then five solid writing lines.
  c.text(40, 516, 'F2', 13, 'C. Kesimpulan', '#1F5F8F');
  c.text(40, 496, 'F5', 10, 'Kepadatan populasi:  D = N / A   (individu per m2)', '#37474F');
  c.para(40, 476, 'F3', 11, 14, ['Tuliskan kesimpulanmu tentang keseimbangan ekosistem kolam sekolah.']);
  for (let i = 0; i < 5; i++) c.line(40, 446 - i * 24, 572, 446 - i * 24, { width: 0.5, color: '#B0BEC5' });
  // Self-check: checkboxes with labels.
  c.text(40, 300, 'F2', 13, 'D. Cek Diri', '#1F5F8F');
  const checks = ['Saya mencatat minimal tiga makhluk hidup.', 'Saya bekerja bergantian dengan pasangan.', 'Saya menjawab dengan kalimat sendiri.'];
  checks.forEach((t, i) => {
    const y = 276 - i * 20;
    c.raw(`q 0.8 w ${rgb('#455A64')} RG 40 ${y - 1} 10 10 re S Q`);
    c.text(58, y, 'F1', 10.5, t);
  });
  // Teacher note: rounded box, dark fill, light text (should NOT be a field).
  c.raw(`q ${rgb('#263238')} rg`).roundRect(40, 120, 532, 76, 10, 'f').raw('Q');
  c.text(56, 176, 'F2', 10, 'Catatan guru', '#FFD54F');
  c.para(56, 160, 'F1', 10, 13, ['Bagian ini diisi guru setelah diskusi kelas. Siswa tidak perlu menulis', 'apa pun di kotak ini.'], '#ECEFF1');
  c.raw('q /Fm1 Do Q');
  c.text(540, 40, 'F1', 9, 'Hal. 2', '#607D8B');
  return c.toString();
}

function inlineIconHex() {
  // 8x8 RGB "leaf": green diamond on white.
  let s = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const on = Math.abs(x - 3.5) + Math.abs(y - 3.5) < 4;
    s += on ? '2E7D32' : 'FFFFFF';
  }
  return s;
}

function logoImage() {
  // 32x32 RGB: teal disc with a white ring on transparent-looking white.
  const n = 32, buf = Buffer.alloc(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5);
    const c = d < 9 ? [0x00, 0x89, 0x7B] : d < 11 ? [0xFF, 0xFF, 0xFF] : d < 15 ? [0x26, 0x32, 0x9A] : [0xFF, 0xFF, 0xFF];
    buf.set(c, (y * n + x) * 3);
  }
  return zlib.deflateSync(buf);
}

// ------------------------------------------------------------- assemble
function build() {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const stream = (dict, data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    return Buffer.concat([Buffer.from(`<< ${dict} /Length ${b.length} >>\nstream\n`, 'latin1'), b, Buffer.from('\nendstream', 'latin1')]);
  };
  const deflated = (dict, text) => stream(`${dict} /Filter /FlateDecode`, zlib.deflateSync(Buffer.from(text, 'latin1')));

  const catalog = add(null), pagesId = add(null);
  const font = (base) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
  const fonts = { F1: font('Helvetica'), F2: font('Helvetica-Bold'), F3: font('Times-Roman'), F4: font('Times-Italic'), F5: font('Courier') };
  const gsA = add('<< /Type /ExtGState /ca 0.35 /CA 0.35 >>');
  const fnAxial = '<< /FunctionType 2 /Domain [0 1] /C0 [0.0 0.537 0.482] /C1 [0.149 0.196 0.604] /N 1 >>';
  const p1 = add(`<< /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 612 0] /Function ${fnAxial} /Extend [true true] >> /Matrix [1 0 0 1 0 0] >>`);
  const sh1 = add('<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [80 800 0 80 800 520] /Function << /FunctionType 2 /Domain [0 1] /C0 [0.180 0.490 0.196] /C1 [0.004 0.341 0.608] /N 1 >> /Extend [true true] >>');
  const im1 = add(stream('/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', logoImage()));
  const footer = new Content();
  footer.line(40, 56, 572, 56, { width: 0.5, color: '#B0BEC5' });
  footer.text(40, 40, 'F1', 9, 'Lembar kerja contoh untuk uji impor PDF - ELKPD-ify', '#607D8B');
  const fontDict = '<< ' + Object.entries(fonts).map(([k, v]) => `/${k} ${v} 0 R`).join(' ') + ' >>';
  const fm1 = add(deflated(`/Type /XObject /Subtype /Form /BBox [0 0 612 80] /Resources << /Font ${fontDict} >>`, footer.toString()));
  const res = `<< /Font ${fontDict} /ExtGState << /GSa ${gsA} 0 R >> /Pattern << /P1 ${p1} 0 R >> /Shading << /Sh1 ${sh1} 0 R >> /XObject << /Im1 ${im1} 0 R /Fm1 ${fm1} 0 R >> >>`;

  const c1 = add(deflated('', page1()));
  const c2 = add(deflated('', page2()));
  // One real AcroForm text field ("nilai") on page 1, over the drawn frame.
  const pg1 = add(null);
  const field = add(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (nilai) /Rect [368 652 428 672] /F 4 /P ${pg1} 0 R /DA (/F1 11 Tf 0 g) /MK << >> >>`);
  objs[pg1 - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources ${res} /Contents ${c1} 0 R /Annots [${field} 0 R] >>`;
  const pg2 = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources ${res} /Contents ${c2} 0 R >>`);
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pg1} 0 R ${pg2} 0 R] /Count 2 >>`;
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm << /Fields [${field} 0 R] /DA (/F1 11 Tf 0 g) /DR << /Font ${fontDict} >> >> >>`;
  const info = add('<< /Title (Lembar Kerja Siswa - Ekosistem Kolam \\(demo\\)) /Producer (ELKPD-ify make-demo-pdf.mjs) /Creator (hand-written PDF) >>');

  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = parts[0].length;
  const xref = [];
  objs.forEach((body, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    xref.push(offset); parts.push(b); offset += b.length;
  });
  const xrefStr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + xref.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xrefStr, 'latin1'));
  return Buffer.concat(parts);
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, build());
console.log(`wrote ${out}`);
