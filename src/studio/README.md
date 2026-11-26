# ELKPD Studio

Turn any worksheet PDF into a fillable sheet, in the browser (#12; design:
[`docs/design/projects.md`](../../docs/design/projects.md)).

1. **Import**: *Pilih PDF* or drop one anywhere on the start screen.
   pdf.js + [`../sheet/import.js`](../sheet/import.js) extract text, vector
   art, images and likely answer areas. Nothing is uploaded. Recent sheets
   and published projects are listed under *Lanjutkan*.
2. **Review** (*Sunting*): every detected answer area is a box. The panel
   lists them with what is left to do on top (*Beri nama N isian*: name,
   Enter, name, Enter). Select a box to edit it; rarely needed settings are
   under *Lainnya*. The dock on the canvas draws new boxes (*Isian*, or
   `A`) and zooms (click the percentage to fit). Drag to move, handles to
   resize, `Delete`, arrows to nudge (`Shift` = 10 pt), `Ctrl+D` duplicate,
   `Ctrl+Z`/`Ctrl+Shift+Z`. Double-click page text to fix it. Page actions
   sit above each page. On a phone the panel is a bottom sheet.
3. **Try it** (*Coba isi*): the real player at full width. Long answers
   grow and push the rest of the page down.
4. **Share** (*Bagikan*): publish to a class (with an account), a
   self-contained `.html` (works offline, saves answers on the device,
   prints in full), or the `sheet.json` to edit later. Sheets also autosave
   in this browser (IndexedDB).

Motion uses the gate's springs (`--spring-fast`, `--spring`), so the Studio
and the gate move alike.


```bash
node scripts/dev-studio.mjs          # http://127.0.0.1:8788/src/studio/
node tests/test-import.mjs           # importer, Node (npm ci in scripts/pdf-import first)
node tests/test-studio.mjs           # Studio end to end, headless Chrome
```

On a deployment the Studio is static at `/studio/` (the gate's
`_routes.json` lets `/studio/*` and `/sheet/*` bypass the room gate).
