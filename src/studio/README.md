# ELKPD Studio

Turn any worksheet PDF into a fillable sheet, in the browser (#12; design:
[`docs/design/projects.md`](../../docs/design/projects.md)).

1. **Import**: drop a PDF. pdf.js + [`../sheet/import.js`](../sheet/import.js)
   extract text, vector art, images and likely answer areas. Nothing is
   uploaded.
2. **Review** (*Sunting*): every detected answer area is a box. Drag to move,
   handles to resize, *Tambah isian* (or `A`) to draw a new one, `Delete`
   to remove, arrows to nudge (`Shift` = 10 pt), `Ctrl+D` duplicate,
   `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo. Double-click page text to fix it.
   The side panel names fields, sets their kind, ruled-line pitch, and
   whether they grow.
3. **Try it** (*Coba isi*): the real player. Long answers grow and push the
   rest of the page down.
4. **Share** (*Simpan & bagikan*): a self-contained `.html` (works offline,
   saves answers on the device, prints in full) or the `sheet.json` to edit
   later. Sheets also autosave in this browser (IndexedDB).

Live rooms for imported sheets come with the projects backend (design doc,
step 2–3).

```bash
node scripts/dev-studio.mjs          # http://127.0.0.1:8788/src/studio/
node tests/test-import.mjs           # importer, Node (npm ci in scripts/pdf-import first)
node tests/test-studio.mjs           # Studio end to end, headless Chrome
```

On a deployment the Studio is static at `/studio/` (the gate's
`_routes.json` lets `/studio/*` and `/sheet/*` bypass the room gate).
