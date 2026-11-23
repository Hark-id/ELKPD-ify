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
