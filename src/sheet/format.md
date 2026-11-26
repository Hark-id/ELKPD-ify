# `sheet.json` — format v1

One imported worksheet. Produced by [`import.js`](import.js), edited by the
Studio ([`../studio/`](../studio/)), rendered by [`player.js`](player.js).
Design context: [`docs/design/projects.md`](../../docs/design/projects.md).

All geometry is in **PDF points, origin top-left**. A page renders at
1 pt = 1 CSS px and is scaled as a whole.

```jsonc
{
  "format": "elkpd-sheet",
  "version": 1,
  "title": "Ekosistem Kolam",
  "source": { "name": "kolam.pdf", "pages": 2, "sha256": "…", "producer": "…" },
  "fonts": {                       // referenced by text[].font
    "g_d0_f1": { "css": "'Georgia', 'Gelasio', serif", "web": ["Gelasio"], "pdf": "BAAAAA+Georgia-Bold" }
  },
  "pages": [{
    "id": "p1", "width": 595.5, "height": 842.25,
    "background": "<svg xmlns=…>…</svg>",   // everything painted except text
    "text": [{
      "id": "p1-t3", "x": 62.3, "baseline": 115.5, "size": 10, "font": "g_d0_f1",
      "str": "1. Siapakah tokoh-tokoh utama…",
      "w": 445.9,          // PDF width; the player scaleX-fits to it. Absent = natural width (edited text)
      "weight": 700, "italic": true, "color": "#0f172a", "alpha": 0.35, "rot": -30,  // optional
      "conf": 0.62         // optional, OCR runs only: confidence 0..1 of the run's least certain word
    }],
    "fields": [{
      "id": "p1-f3",       // answer key in the room: keep stable across edits
      "kind": "textarea",  // text | textarea | checkbox | date | number | choice
      "x": 66, "y": 140, "w": 460, "h": 40,
      "label": "Jawaban no. 1",   // accessible name, and what the teacher sees
      "prompt": "1. Siapakah …",  // optional: the question it answers (shown in the phone editor)
      "placeholder": "…",         // optional
      "lineGap": 22, "lines": 3,  // optional: answer written on ruled lines
      "grow": false,              // optional: textarea doesn't grow (default: grows)
      "size": 11,                 // optional: font size hint for single-line fields
      "source": "lines"           // how it was found: acroform | leader | table | line | lines | box | checkbox | space | ocr | manual
    }, {
      "id": "p1-f4", "kind": "choice",     // multiple choice: one answer, the value is the option's letter
      "x": 70, "y": 192, "w": 14, "h": 86, // bounds of all options
      "label": "Jawaban no. 1", "prompt": "1. Ekosistem yang …",
      "options": [                          // 2-10; value matches ^[A-Za-z0-9]{1,4}$, unique
        { "value": "A", "x": 70, "y": 192, "w": 13, "h": 13 }   // the ring over the printed letter
      ]
    }],
    "unsupported": { "tilingPattern": 4 },   // importer diagnostics, informational
    "stats": { … }
  }]
}
```

## Rules a consumer can rely on

- `background` is shown as an **image** (`<img src="data:image/svg+xml,…">`), never
  inlined into the page DOM. SVG in an image context runs no script and
  loads nothing external, so a sheet from someone else can't inject code
  through it. Keep it that way.
- Text and labels are always set with `textContent` / attributes, never
  `innerHTML`.
- Field ids match `^[A-Za-z0-9_-]{1,60}$` and are unique across the sheet.
- Field ids are stored, not derived: `p1-f3` is just the id the importer
  gave it. Reordering or deleting pages, moving fields between pages, or
  re-publishing never renames a field, so answers stay bound to it.

## Scanned pages (OCR)

[`ocr.js`](ocr.js) rewrites pages that are a picture of a page. Their
`background` becomes one cleaned JPEG `<image>` (deskewed, paper flattened
to white, scanner edges removed). OCR text runs use the `ocr` font and carry
`conf`; they have `alpha: 0` (invisible, still searchable and selectable)
unless the page was made editable ("digital"), in which case the words are
erased from the background and the runs are drawn. Runs with a low `conf`
are the ones to review. Fields found on a scan have `source: "ocr"`, and
`page.stats.ocr` records timing, word count and the deskew angle.

## Reflow

A growing `textarea` cuts the page at its bottom edge (for lined fields,
just below the last line) and everything below moves down by the growth.
The gap is painted by repeating the background band just above the cut
(one line pitch for lined fields, an ≤ 8 pt slice for boxes), so writing
lines and box sides continue. Fields whose bottoms are within 3 pt (a table
row) grow together. See `measure()` / `renderStrips()` in `player.js`.
