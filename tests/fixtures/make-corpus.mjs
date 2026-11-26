/* A small corpus of realistic Indonesian worksheets (LKPD) for the PDF
 * importer's field detection. Each sheet is HTML (below), printed to PDF by
 * headless Chrome over CDP (Page.printToPDF), and differs from the others on
 * purpose: text leaders, ruled lines, option glyphs, drawn checkboxes, two
 * columns, tables with header fills and zebra rows, inline gaps, dotted and
 * rounded boxes.
 *
 * Ground truth: every intended answer area carries data-f="text|textarea|
 * checkbox" in the HTML. Its rectangle is read from the DOM before printing
 * (pages are A4 with zero @page margin, so CSS px * 0.75 = PDF pt), and
 * `expect` states the intended count per kind, written down before any
 * import was run. Things that look like fields but are not (callouts, word
 * banks, prefilled cells, signature rules) carry no data-f.
 *
 *   node tests/fixtures/make-corpus.mjs [outDir]     # writes <name>.pdf + truth.json
 *   import { buildCorpus, score } from './fixtures/make-corpus.mjs'      */
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = `
  @page { size: A4; margin: 0 }
  * { box-sizing: border-box }
  html, body { margin: 0 }
  body { width: 794px; padding: 56px 64px; font: 12pt/1.5 'DejaVu Sans', Arial, sans-serif; color: #111 }
  h1 { font-size: 16pt; text-align: center; margin: 0 0 4px }
  h2 { font-size: 12pt; margin: 18px 0 6px }
  p { margin: 6px 0 }
  .sub { text-align: center; margin: 0 0 14px; font-size: 10.5pt }
`;
const page = (css, body) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>${BASE}${css}</style></head><body>${body}</body></html>`;
const F = (kind, inner = '', attrs = '') => `<span data-f="${kind}"${attrs}>${inner}</span>`;

// ---------------------------------------------------------------- (a)
// Word-style: underscore leaders in the identity block, numbered questions
// each followed by three ruled lines drawn as CSS borders: solid for 1-3
// (3 starts with "Jawab :" on its first line), dotted for 4-5.
const wordQuestions = [
  'Jelaskan pengertian teks eksposisi dengan bahasamu sendiri!',
  'Sebutkan tiga ciri kebahasaan teks eksposisi yang kamu temukan pada bacaan!',
  'Apa gagasan utama paragraf kedua pada teks "Manfaat Membaca"?',
  'Mengapa penulis menyertakan data dan fakta dalam tulisannya?',
  'Tuliskan simpulan teks tersebut dalam dua kalimat!',
];
const wordStyle = page(`
  body { font-family: 'DejaVu Serif', 'Times New Roman', serif }
  .id p { margin: 2px 0 }
  ol { padding-left: 22px; margin: 6px 0 }
  li { margin: 10px 0 0 }
  .lines { display: block; margin-top: 2px }
  .lines i { display: block; height: 24px; border-bottom: 1px solid #000 }
  .lines.dotted i { border-bottom: 1.5px dotted #000 }
  .jw { display: flex; align-items: flex-end; gap: 6px }
  .jw i { flex: 1 }
  .sign { margin-top: 26px; margin-left: 420px; width: 200px; text-align: center; font-size: 10.5pt }
  .sign .rule { border-bottom: 1px solid #000; height: 54px; margin-bottom: 2px }
`, `
  <h1>LEMBAR KERJA PESERTA DIDIK</h1>
  <p class="sub">Bahasa Indonesia Kelas VIII &ndash; Teks Eksposisi</p>
  <div class="id">
    <p>Nama&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: ${F('text', '______________________________')}</p>
    <p>Kelas&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: ${F('text', '__________')} &nbsp; No. Absen : ${F('text', '________')}</p>
    <p>Hari/Tanggal : ${F('text', '_________________________')}</p>
  </div>
  <h2>A. Jawablah pertanyaan berikut dengan tepat!</h2>
  <ol>${wordQuestions.map((q, i) => `<li>${q}<span class="lines${i >= 3 ? ' dotted' : ''}" data-f="textarea">${
    i === 2 ? '<span class="jw">Jawab :<i></i></span>' : '<i></i>'}<i></i><i></i></span></li>`).join('')}</ol>
  <div class="sign"><div class="rule"></div>Guru Mata Pelajaran</div>
`);

// ---------------------------------------------------------------- (b)
// Multiple choice: option glyphs typed as text (☐ and ○), drawn squares
// (bordered spans), and a Benar/Salah grid whose boxes sit alone in cells.
const quiz = [
  ['☐', 'Planet yang paling dekat dengan Matahari adalah ...', ['Venus', 'Merkurius', 'Mars', 'Bumi']],
  ['☐', 'Benda langit yang mengelilingi planet disebut ...', ['Satelit', 'Komet', 'Asteroid', 'Meteor']],
  ['○', 'Peristiwa bulan menutupi matahari disebut gerhana ...', ['Bulan', 'Matahari', 'Bintang', 'Cincin']],
  ['box', 'Planet terbesar di tata surya adalah ...', ['Saturnus', 'Uranus', 'Yupiter', 'Neptunus']],
  ['box', 'Bumi berputar pada porosnya disebut ...', ['Revolusi', 'Rotasi', 'Gravitasi', 'Orbit']],
];
const benarSalah = [
  'Matahari adalah sebuah bintang.',
  'Bulan memancarkan cahayanya sendiri.',
  'Satu kali revolusi Bumi memerlukan waktu 365¼ hari.',
  'Mars dijuluki planet merah.',
];
const mcq = page(`
  .q { margin: 10px 0 2px }
  .opts { display: grid; grid-template-columns: 1fr 1fr; margin-left: 22px }
  .opts div { margin: 1px 0 }
  .sq { display: inline-block; width: 13px; height: 13px; border: 1.2px solid #000; vertical-align: -2px; margin-right: 7px }
  .g { margin-right: 4px }
  table { border-collapse: collapse; width: 100%; margin-top: 6px }
  td, th { border: 1px solid #000; padding: 5px 8px; font-size: 11pt }
  th { background: #d9e2f3 }
  td.c { text-align: center; width: 64px }
  td.c .sq { margin: 0 }
`, `
  <h1>KUIS IPA: TATA SURYA</h1>
  <p class="sub">Kelas VII &ndash; Semester 2</p>
  <p>Nama : ${F('text', '..............................................')} &nbsp; Kelas : ${F('text', '..............')}</p>
  <h2>I. Beri tanda centang pada jawaban yang benar!</h2>
  ${quiz.map(([g, q, opts], i) => `<p class="q">${i + 1}. ${q}</p><div class="opts">${opts.map((o) =>
    `<div>${g === 'box' ? `<span class="sq" data-f="checkbox"></span>` : F('checkbox', g, ' class="g"')}${o}</div>`).join('')}</div>`).join('')}
  <h2>II. Benar atau Salah?</h2>
  <table><tr><th>Pernyataan</th><th>Benar</th><th>Salah</th></tr>
  ${benarSalah.map((s) => `<tr><td>${s}</td><td class="c"><span class="sq" data-f="checkbox"></span></td><td class="c"><span class="sq" data-f="checkbox"></span></td></tr>`).join('')}
  </table>
`);

// ---------------------------------------------------------------- (c)
// Two columns: answer boxes side by side, a full-width box underneath.
const twoColItems = [
  ['Alat dan Bahan', 'Tuliskan alat dan bahan yang kelompokmu gunakan.'],
  ['Langkah Kerja', 'Tuliskan langkah percobaan secara berurutan.'],
  ['Hasil Pengamatan', 'Apa yang terjadi pada es batu setelah 5 menit?'],
  ['Dugaan Sementara', 'Mengapa hal itu terjadi? Tuliskan dugaanmu.'],
  ['Perubahan Wujud', 'Sebutkan perubahan wujud yang kamu amati.'],
  ['Contoh Lain', 'Tuliskan dua contoh lain di sekitarmu.'],
];
const twoCol = page(`
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 22px }
  .item h3 { font-size: 11pt; margin: 0 }
  .item p { font-size: 10.5pt; margin: 0 0 4px }
  .box { display: block; height: 96px; border: 1px solid #333 }
  .wide { display: block; height: 110px; border: 1.5px solid #333; margin-top: 4px }
  .info { background: #fff4d6; border: 1px solid #e0b84a; padding: 8px 12px; font-size: 10.5pt; margin: 8px 0 14px }
`, `
  <h1>LKPD IPA &ndash; PERUBAHAN WUJUD BENDA</h1>
  <p class="sub">Kelas V SD &ndash; Kegiatan Kelompok</p>
  <p>Nama Kelompok : ${F('text', '..................................')} &nbsp; Kelas : ${F('text', '............')}</p>
  <div class="info"><b>Petunjuk:</b> Lakukan percobaan bersama kelompokmu. Amati es batu yang diletakkan di atas piring,
  lalu catat hasilnya pada kotak yang tersedia. Bekerjalah dengan tertib dan jaga kebersihan meja.</div>
  <div class="grid">${twoColItems.map(([h, p]) => `<div class="item"><h3>${h}</h3><p>${p}</p><span class="box" data-f="textarea"></span></div>`).join('')}</div>
  <h2>Kesimpulan</h2>
  <span class="wide" data-f="textarea"></span>
`);

// ---------------------------------------------------------------- (d)
// Tables: a dark header fill, a light header fill with zebra rows, cells
// that are empty (fields) next to cells that are prefilled (not fields).
// Table 1 rows are tall (textarea), table 2 rows hold one line (text).
const unsur = ['Tema', 'Tokoh dan Penokohan', 'Latar', 'Alur', 'Amanat'];
const tableSheet = page(`
  table { border-collapse: collapse; width: 100%; margin: 6px 0 4px }
  td, th { border: 1px solid #444; padding: 6px 8px; font-size: 10.5pt; vertical-align: top }
  .t1 th { background: #1f3864; color: #fff }
  .t1 td { height: 52px }
  .t2 th { background: #e7e6e6 }
  .t2 td { height: 34px }
  .t2 tr:nth-child(odd) td { background: #f6f6f6 }
  .t3 td { height: 26px }
  .t3 td.k { width: 150px; background: #eef3fa; font-weight: bold }
`, `
  <h1>LKPD &ndash; UNSUR INTRINSIK CERPEN</h1>
  <p class="sub">Bahasa Indonesia Kelas IX</p>
  <table class="t3">
    <tr><td class="k">Nama Kelompok</td><td data-f="text"></td></tr>
    <tr><td class="k">Judul Cerpen</td><td data-f="text"></td></tr>
  </table>
  <h2>Tabel 1. Analisis Unsur Intrinsik</h2>
  <table class="t1"><tr><th style="width:36px">No</th><th style="width:150px">Unsur</th><th>Kutipan Teks</th><th>Penjelasan</th></tr>
  ${unsur.map((u, i) => `<tr><td>${i + 1}</td><td>${u}</td><td data-f="textarea"></td><td data-f="textarea"></td></tr>`).join('')}</table>
  <h2>Tabel 2. Watak Tokoh</h2>
  <table class="t2"><tr><th>Tokoh</th><th>Watak</th><th>Bukti dalam Cerita</th></tr>
  <tr><td>Pak Hasan (contoh)</td><td>Sabar</td><td>Ia tetap tersenyum meski dagangannya tidak laku.</td></tr>
  ${[0, 1, 2].map(() => `<tr><td data-f="text"></td><td data-f="text"></td><td data-f="text"></td></tr>`).join('')}</table>
`);

// ---------------------------------------------------------------- (e)
// Fill in the blanks: gaps typed as dots in the middle of sentences, in a
// justified paragraph and in numbered sentences; one gap uses "…" glyphs,
// one uses underscores.
const gap = (n = 14) => F('text', '.'.repeat(n));
const cloze = page(`
  .bank { border: 1px solid #555; padding: 8px 12px; text-align: center; margin: 8px 0 12px }
  .para { text-align: justify; line-height: 1.9 }
  ol { padding-left: 22px; line-height: 1.9; margin: 4px 0 }
`, `
  <h1>LATIHAN: MELENGKAPI KALIMAT</h1>
  <p class="sub">IPS Kelas IV &ndash; Kenampakan Alam Indonesia</p>
  <p>Nama : ${F('text', '...................................')}</p>
  <div class="bank"><b>Kata bantu:</b> Jakarta &bull; Toba &bull; Kapuas &bull; Jayawijaya &bull; khatulistiwa &bull; Sumatra &bull; kepulauan &bull; dua</div>
  <h2>A. Lengkapilah paragraf berikut!</h2>
  <p class="para">Indonesia adalah negara ${gap(16)} terbesar di dunia. Wilayahnya dilalui garis ${gap(18)} sehingga
  hanya memiliki ${gap(8)} musim, yaitu musim hujan dan musim kemarau. Ibu kota negara kita adalah ${gap(16)} yang
  terletak di Pulau Jawa. Danau ${gap(12)} merupakan danau terluas dan berada di Pulau ${gap(16)}.</p>
  <h2>B. Isilah titik-titik di bawah ini!</h2>
  <ol>
    <li>Sungai terpanjang di Indonesia adalah Sungai ${gap(16)} di Kalimantan.</li>
    <li>Puncak ${gap(18)} adalah gunung tertinggi di Indonesia.</li>
    <li>Dataran yang luas dan tinggi disebut ${F('text', '………………')} .</li>
    <li>Pulau Bali terkenal sebagai daerah tujuan ${gap(14)} karena keindahan alamnya.</li>
    <li>Ibu kota Provinsi Jawa Barat adalah ${F('text', '______________')} .</li>
  </ol>
`);

// ---------------------------------------------------------------- (f)
// Dotted / dashed borders and rounded corners; a rounded callout that is
// full of text (not a field), a borderless light-grey rounded box (a
// field) and a rounded box with a heading at the top.
const rounded = page(`
  .card { display: block; margin: 4px 0 12px }
  .dot { height: 84px; border: 2px dotted #2f6f4f; border-radius: 12px }
  .dash { height: 84px; border: 1.5px dashed #7a4fbf; border-radius: 10px }
  .solid { border: 1.5px solid #2f6f4f; border-radius: 16px; height: 120px; padding: 8px 12px; margin: 14px 0 }
  .solid b { color: #2f6f4f }
  .fill { height: 64px; background: #f1f1f1; border-radius: 12px }
  .tip { background: #e8f5ee; border-radius: 14px; padding: 10px 14px; font-size: 10.5pt; margin: 6px 0 12px }
  .row { display: flex; gap: 18px; align-items: flex-end }
  .nilai { width: 110px; text-align: center; font-size: 10.5pt }
  .nilai span { display: block; height: 56px; border: 2px dotted #c0392b; border-radius: 10px }
`, `
  <h1>LKPD MATEMATIKA &ndash; PECAHAN</h1>
  <p class="sub">Kelas IV SD</p>
  <div class="tip"><b>Ingat!</b> Pecahan senilai adalah pecahan yang nilainya sama walaupun pembilang dan penyebutnya
  berbeda. Kalikan atau bagi pembilang dan penyebut dengan bilangan yang sama untuk memperolehnya.</div>
  <p>1. Ibu memotong kue menjadi 8 bagian. Adik makan 2 bagian. Berapa bagian kue yang tersisa? Tuliskan caramu!</p>
  <span class="card dot" data-f="textarea"></span>
  <p>2. Tuliskan tiga pecahan yang senilai dengan 1/2 dan jelaskan cara menemukannya.</p>
  <span class="card dot" data-f="textarea"></span>
  <p>3. Urutkan pecahan 3/4, 1/2, dan 5/8 dari yang terkecil. Tunjukkan langkahmu.</p>
  <span class="card dash" data-f="textarea"></span>
  <p>4. Gambarlah pecahan 3/4 pada kotak berikut.</p>
  <span class="card fill" data-f="textarea"></span>
  <div class="solid" data-f="textarea"><b>Refleksi:</b> Apa yang paling sulit hari ini?</div>
  <div class="row">
    <div style="flex:1">Paraf Orang Tua : ${F('text', '....................')}</div>
    <div class="nilai">Nilai<span data-f="textarea"></span></div>
  </div>
`);

export const corpus = [
  { name: 'a-word-lines', title: 'Word-style leaders + ruled lines', html: wordStyle, expect: { text: 4, textarea: 5, checkbox: 0 } },
  { name: 'b-multiple-choice', title: 'Multiple choice, glyph + drawn boxes', html: mcq, expect: { text: 2, textarea: 0, checkbox: 28 } },
  { name: 'c-two-column', title: 'Two-column answer boxes', html: twoCol, expect: { text: 2, textarea: 7, checkbox: 0 } },
  { name: 'd-tables', title: 'Tables, header fills, prefilled cells', html: tableSheet, expect: { text: 11, textarea: 10, checkbox: 0 } },
  { name: 'e-fill-blanks', title: 'Inline gaps mid-sentence', html: cloze, expect: { text: 12, textarea: 0, checkbox: 0 } },
  { name: 'f-dotted-rounded', title: 'Dotted / rounded boxes', html: rounded, expect: { text: 1, textarea: 6, checkbox: 0 } },
];

/** Print every sheet into `dir`. Returns [{name, title, pdf, expect, truth}]
 *  where truth = [{kind, x, y, w, h}] in PDF points, read from the DOM.
 *  Throws if no Chrome is available (callers decide whether to skip). */
export async function buildCorpus(dir) {
  const { launch } = await import('../cdp.mjs');
  mkdirSync(dir, { recursive: true });
  const b = await launch({ width: 794, height: 1123 });
  const out = [];
  try {
    for (const c of corpus) {
      const htmlPath = join(dir, c.name + '.html');
      writeFileSync(htmlPath, c.html);
      await b.goto('file://' + htmlPath);
      const info = await b.eval(`(() => ({
        height: document.documentElement.scrollHeight,
        truth: [...document.querySelectorAll('[data-f]')].map((e) => { const r = e.getBoundingClientRect();
          return { kind: e.dataset.f, x: r.x * 0.75, y: r.y * 0.75, w: r.width * 0.75, h: r.height * 0.75 }; }) }))()`);
      // The px -> pt mapping only holds on page 1; keep every sheet to one page.
      if (info.height > 1123) throw new Error(`${c.name}: ${info.height}px tall, does not fit one A4 page`);
      const counts = { text: 0, textarea: 0, checkbox: 0 };
      for (const t of info.truth) counts[t.kind]++;
      if (JSON.stringify(counts) !== JSON.stringify(c.expect)) throw new Error(`${c.name}: markup has ${JSON.stringify(counts)}, expected ${JSON.stringify(c.expect)}`);
      const { data } = await b.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      const pdf = join(dir, c.name + '.pdf');
      writeFileSync(pdf, Buffer.from(data, 'base64'));
      out.push({ name: c.name, title: c.title, pdf, expect: c.expect, truth: info.truth });
    }
  } finally { await b.close(); }
  return out;
}

/** Compare detected sheet fields (all pages; the corpus is single-page)
 *  with the truth. A detection matches an intended area when its centre
 *  lies inside the area (grown by 4pt) and it is not far larger than it;
 *  each area can be matched once, so two fields in one area cost precision. */
export function score(fields, truth) {
  const free = new Set(truth);
  const extra = [];
  let tp = 0, kindOk = 0;
  for (const f of fields) {
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    const hit = [...free].find((t) => cx >= t.x - 4 && cx <= t.x + t.w + 4 && cy >= t.y - 4 && cy <= t.y + t.h + 4 &&
      f.w <= t.w * 1.5 + 12 && f.h <= t.h * 1.5 + 12);
    if (!hit) { extra.push(f); continue; }
    free.delete(hit); tp++;
    if (hit.kind === f.kind) kindOk++;
  }
  return { intended: truth.length, detected: fields.length, tp, kindOk, extra, missed: [...free],
    precision: fields.length ? tp / fields.length : 1, recall: truth.length ? tp / truth.length : 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || mkdtempSync(join(tmpdir(), 'elkpd-corpus-'));
  const built = await buildCorpus(dir);
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(built, null, 1));
  for (const c of built) console.log(`${c.pdf}  intended ${c.truth.length} (${Object.entries(c.expect).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')})`);
}
