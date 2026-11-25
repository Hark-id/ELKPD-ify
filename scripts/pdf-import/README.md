# pdf-import (spike for #2)

Turns a worksheet PDF into an editable, look-alike HTML scaffold. Findings,
measurements and limits: [`docs/pdf-import-spike.md`](../../docs/pdf-import-spike.md).

This is a **prototype**, separate from the app: nothing in `src/` uses it, and
`scripts/sync.mjs` ignores it.

```bash
npm ci                     # pdfjs-dist 4.10.38 (+ @napi-rs/canvas for compare)

node extract.mjs <in.pdf> <outDir> [--pages 2-3]
#   outDir/outline.json  - text spans (font, size, colour, baseline), shapes,
#                          clips, gradients, images, detected fields; pt, top-left
#   outDir/scaffold.html - one page per PDF page; open it in a browser
#                          ?edit      make the text editable
#                          ?page=N    one page, no chrome (used by compare)
#                          &bare      hide the field tint

node make-demo-pdf.mjs [out.pdf]    # the acceptance PDF (not the LKPD)
node compare.mjs <in.pdf> <scaffold.html> <outDir> [--pages a-b] [--scale 2]
#   pixel diff vs poppler's rendering; writes PDF | scaffold | diff PNGs

npm run demo               # all three for the demo PDF
npm run lkpd               # extract + compare for reference/ LKPD
```

Fields are emitted as `<textarea|input data-store id="p<page>-f<n>">`, the
same binding convention as `src/worksheet`, so a generated page could be
served through a room as-is. `compare.mjs` needs poppler (`pdftoppm`,
`pdfinfo`) and Chrome (`CHROME_PATH` overrides discovery). Output goes to
`out/` (gitignored).
