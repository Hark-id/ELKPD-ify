/* The browser importer (src/sheet/import.js) run under Node against the
 * two acceptance PDFs from the #2 spike: the generated demo sheet and the
 * LKPD in reference/. Guards field detection, the dotted-border compaction
 * and the sheet format. Needs `npm ci` in scripts/pdf-import (pdfjs-dist).
 * With a Chrome available it also prints and imports the layout corpus in
 * tests/fixtures/make-corpus.mjs (those checks are skipped with a note
 * when there is none).
 *
 *   node tests/test-import.mjs                                         */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfjsDir = join(root, 'scripts/pdf-import/node_modules/pdfjs-dist');
const pdfjs = await import(pathToFileURL(join(pdfjsDir, 'legacy/build/pdf.mjs')).href);
const { importPdf } = await import(pathToFileURL(join(root, 'src/sheet/import.js')).href);

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (!ok) failed++; };
const docOptions = { standardFontDataUrl: join(pdfjsDir, 'standard_fonts') + '/' };

// ---- demo PDF (generated, not the LKPD)
const tmp = mkdtempSync(join(tmpdir(), 'elkpd-import-'));
try {
  const demoPath = join(tmp, 'demo.pdf');
  execFileSync(process.execPath, [join(root, 'scripts/pdf-import/make-demo-pdf.mjs'), demoPath]);
  const demo = await importPdf(pdfjs, readFileSync(demoPath), { name: 'demo.pdf', docOptions });
  check('demo: format header', demo.format === 'elkpd-sheet' && demo.version === 1);
  check('demo: 2 pages', demo.pages.length === 2);
  const counts = demo.pages.map((p) => p.fields.length);
  check('demo: 7 + 14 fields', counts[0] === 7 && counts[1] === 14, counts.join('+'));
  const kinds = demo.pages.flatMap((p) => p.fields.map((f) => f.kind));
  check('demo: 3 checkboxes', kinds.filter((k) => k === 'checkbox').length === 3);
  check('demo: AcroForm field found', demo.pages[0].fields.some((f) => f.source === 'acroform' && f.label === 'nilai'));
  check('demo: lined textareas carry their pitch', demo.pages.flatMap((p) => p.fields).filter((f) => f.lineGap).every((f) => f.lines >= 2 && f.lineGap > 10));
  check('demo: images embedded as PNG', demo.pages[0].background.includes('data:image/png;base64,'));
  check('demo: sha256 recorded', /^[0-9a-f]{64}$/.test(demo.source.sha256 || ''));
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ---- the LKPD (Chrome/Skia PDF, Type 3 fonts, dotted borders)
const lkpd = await importPdf(pdfjs, readFileSync(join(root, 'reference/LKPD Teks Cerpen SMA Kelas XI (1).pdf')), { name: 'lkpd.pdf', docOptions });
const lc = lkpd.pages.map((p) => p.fields.length);
check('lkpd: 8 pages', lkpd.pages.length === 8);
check('lkpd: field counts per page', lc.join(',') === '0,4,1,1,6,17,11,0', lc.join(','));
const size = JSON.stringify(lkpd).length;
check('lkpd: dotted borders compacted (< 300 KB)', size < 300e3, Math.round(size / 1024) + ' KB');
check('lkpd: dashed strokes emitted', lkpd.pages.some((p) => p.background.includes('stroke-dasharray')));
check('lkpd: Georgia mapped to Gelasio', Object.values(lkpd.fonts).some((f) => f.web.includes('Gelasio')));

// ---- format invariants on both
for (const s of [lkpd]) {
  const ids = s.pages.flatMap((p) => p.fields.map((f) => f.id));
  check('ids unique and well-formed', new Set(ids).size === ids.length && ids.every((id) => /^[A-Za-z0-9_-]{1,60}$/.test(id)));
  check('backgrounds are standalone SVG', s.pages.every((p) => p.background.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')));
  check('no script in backgrounds', s.pages.every((p) => !/<script|on\w+=/i.test(p.background)));
  check('every text run references a known font', s.pages.every((p) => p.text.every((t) => s.fonts[t.font])));
}

// ---- what real worksheets do (Word, PowerPoint, Canva, LibreOffice, Keynote
// and scanner PDFs; see docs/pdf-import-spike.md, "Real-world PDFs"). The
// real files can't be committed, so each general rule they led to is pinned
// here on a hand-written PDF that does the same thing.
{
  const makePdf = (objs) => {
    let out = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => {
      offs.push(out.length);
      out += `${i + 1} 0 obj\n${typeof o === 'string' ? o : `<< ${o.dict} /Length ${o.stream.length} >>\nstream\n${o.stream}\nendstream`}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}` +
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  };
  const text = (x, y, str) => `BT /F1 12 Tf ${x} ${y} Td (${str}) Tj ET\n`;
  const page1 =
    // a picture clipped to its frame (Word does this to every picture)
    'q 100 600 200 100 re W n q 200 0 0 100 100 600 cm /Im1 Do Q Q\n' +
    // the same picture stamped twice more (an icon per table cell)
    'q 20 0 0 20 400 650 cm /Im1 Do Q q 20 0 0 20 430 650 cm /Im1 Do Q\n' +
    // a texture fill: tiling pattern whose tile is an image
    '/Pattern cs /P1 scn 50 50 100 100 re f\n' +
    text(72, 400, '1. Hitung: ... x + ... y = 12') +
    text(72, 380, '2. Ibukota Jawa Barat adalah ...') +
    text(72, 360, 'Lengkapi tanda " ... " dengan angka.') +
    text(72, 340, '3. Mengapa langit berwarna biru?') +
    text(72, 260, '4. Selesai.');
  // Page 2 is stored sideways (/Rotate 90) with a CropBox inset, the way
  // scanners and "landscape" exports write pages; its text is written
  // rotated so it reads upright on the rotated page.
  const page2 = 'BT /F1 12 Tf 0 1 -1 0 300 100 Tm (Nama: ____________________) Tj ET\n';
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Annots [10 0 R] /Resources << /Font << /F1 7 0 R >> /XObject << /Im1 8 0 R >> /Pattern << /P1 9 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /CropBox [20 20 575 822] /Rotate 90 /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    { dict: '', stream: page1 },
    { dict: '', stream: page2 },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    { dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode', stream: 'ff0000 00ff00 0000ff ffff00>' },
    { dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 8 8] /XStep 8 /YStep 8 /Resources << /XObject << /Im1 8 0 R >> >>', stream: 'q 8 0 0 8 0 0 cm /Im1 Do Q' },
    // an annotation with its own appearance (ink over a scan, a stamp)
    '<< /Type /Annot /Subtype /Square /Rect [400 700 500 750] /F 4 /AP << /N 11 0 R >> >>',
    { dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 50]', stream: '0 0.4 0 rg 0 0 100 50 re f' },
  ]);
  const real = await importPdf(pdfjs, pdf, { name: 'real-world.pdf', docOptions });
  const [p1, p2] = real.pages;
  const bg = p1.background;
  check('real: a clipped picture keeps its clip on a wrapping <g>, not on the <image>', /<g clip-path="url\(#[^"]+\)"><(image|use) /.test(bg) && !/<(image|use) [^>]*clip-path=/.test(bg));
  check('real: a picture painted several times is stored once', (bg.match(/data:image\/png/g) || []).length === 1 && (bg.match(/<use /g) || []).length >= 3, `${(bg.match(/data:image\/png/g) || []).length} data URIs`);
  check('real: an image tiling pattern becomes an SVG <pattern>, not a flat grey', /<pattern id="t1-1"[^>]*>.*<\/pattern>/.test(bg) && bg.includes('fill="url(#t1-1)"') && !bg.includes('#c8c8c8'));
  check('real: an annotation appearance lands on its rectangle', /<path d="M400 142L500 142L500 92L400 92Z" fill="#006600"/.test(bg), (bg.match(/<path d="[^"]*" fill="#006600"/) || ['none'])[0]);
  const by = (src) => p1.fields.filter((f) => f.source === src);
  check('real: short blanks "... x + ... y" are fields; a trailing or quoted "..." is not', by('leader').length === 2 && by('leader').every((f) => Math.abs(f.y + f.h - 842 + 400) < 6), p1.fields.map((f) => f.source).join(','));
  const space = by('space')[0];
  check('real: blank space under a question is an answer area', by('space').length === 1 && !!space && space.kind === 'textarea' && space.y > 842 - 340 && space.y + space.h < 842 - 260, JSON.stringify(space || null));
  check('real: nothing else detected on that page', p1.fields.length === 3, p1.fields.length);
  check('real: /Rotate 90 + CropBox gives the page as it is seen', p2.width === 802 && p2.height === 555, `${p2.width}x${p2.height}`);
  check('real: text on the rotated page reads upright and its leader is found', p2.text.length === 1 && !p2.text[0].rot && p2.fields.length === 1 && p2.fields[0].source === 'leader' &&
    p2.fields[0].x > 0 && p2.fields[0].x + p2.fields[0].w < p2.width && p2.fields[0].y > 0 && p2.fields[0].y + p2.fields[0].h < p2.height, JSON.stringify(p2.fields[0] || null));

  // A scanned sheet: one page-sized picture, no text, no vectors. It must
  // import to a loadable sheet with no fields (the teacher adds them).
  const scan = await importPdf(pdfjs, makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    { dict: '', stream: 'q 595 0 0 842 0 0 cm /Im1 Do Q' },
    { dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /ASCIIHexDecode', stream: '00000000 00000000 000000ff 00ffff00>' },
  ]), { name: 'scan.pdf', docOptions });
  check('real: a scan (one CMYK picture, no text) imports as a page with no fields', scan.pages.length === 1 && scan.pages[0].stats.images === 1 && scan.pages[0].text.length === 0 &&
    scan.pages[0].fields.length === 0 && scan.pages[0].background.includes('data:image/png'), JSON.stringify(scan.pages[0].stats));

  // Icons far denser than they are drawn are shrunk before encoding.
  const { _internal } = await import(pathToFileURL(join(root, 'src/sheet/import.js')).href);
  check('real: shrink factor follows the drawn size (1200px icon in 12pt -> 25x; a 200dpi scan -> 1x)', _internal.shrinkFactor(1200, 1200, 12, 12) === 25 && _internal.shrinkFactor(2340, 3307, 842, 1190) === 1 && _internal.shrinkFactor(10, 10, 0, 0) === 1);
  const small = _internal.shrink(new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]), 2, 2, 4, 2);
  check('real: shrinking averages colour by alpha (no dark fringe)', small.w === 1 && small.h === 1 && small.data[0] === 255 && small.data[3] === 127, [...small.data].join(','));
}

// ---- layout corpus (tests/fixtures/make-corpus.mjs): six worksheets printed
// by headless Chrome, each with its intended answer areas marked in the HTML.
// Needs a Chrome binary; without one these checks are skipped, not failed.
{
  const { buildCorpus, score } = await import('./fixtures/make-corpus.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'elkpd-corpus-'));
  let built = null;
  try { built = await buildCorpus(dir); }
  catch (e) {
    if (!/No Chrome/.test(e.message)) throw e;
    console.log('SKIP  corpus checks: no Chrome/Chromium found (set CHROME_PATH to run them)');
  }
  try {
    for (const c of built || []) {
      const sheet = await importPdf(pdfjs, readFileSync(c.pdf), { name: c.name + '.pdf', docOptions });
      const fields = sheet.pages.flatMap((p) => p.fields);
      const r = score(fields, c.truth);
      const note = `intended ${r.intended}, detected ${r.detected}, matched ${r.tp}`;
      check(`corpus ${c.name}: every intended field found`, r.recall === 1, note);
      // Known extra in a-word-lines: a "Jawab :" label on the first ruled
      // line splits that answer into a text field plus a 2-line textarea.
      check(`corpus ${c.name}: no spurious fields`, r.extra.length <= (c.name === 'a-word-lines' ? 1 : 0), note);
      if (c.name === 'b-multiple-choice') {
        // Option glyphs typed as text (☐ ○), drawn squares, and squares
        // alone in the cells of a Benar/Salah table are all checkboxes.
        check('corpus b: 28 checkboxes, 2 text leaders', fields.filter((f) => f.kind === 'checkbox').length === 28 && fields.filter((f) => f.kind === 'text').length === 2);
        check('corpus b: glyph options are labelled by their text', ['Venus', 'Merkurius', 'Bulan', 'Cincin'].every((l) => fields.some((f) => f.kind === 'checkbox' && f.label === l)));
        check('corpus b: table checkboxes are labelled row - column', fields.some((f) => f.kind === 'checkbox' && f.label === 'Mars dijuluki planet merah. - Salah'));
        check('corpus b: no text field left in a checkbox cell', !fields.some((f) => f.source === 'table'));
      }
      if (c.name === 'f-dotted-rounded') {
        // Dotted/dashed rounded borders (filled dot paths), a stroked
        // rounded box with a heading, a borderless rounded fill; the
        // rounded callout full of text is not a field.
        check('corpus f: 6 answer boxes + 1 leader', fields.filter((f) => f.source === 'box' && f.kind === 'textarea').length === 6 && fields.filter((f) => f.source === 'leader').length === 1);
        const refl = fields.find((f) => f.label === 'Refleksi');
        const area = c.truth.find((t) => refl && t.y < refl.y && t.y + t.h > refl.y);
        check('corpus f: box under a heading starts below the heading', !!refl && !!area && refl.y - area.y > 12);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall import checks passed');
process.exit(failed ? 1 : 0);
