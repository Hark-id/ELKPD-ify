// sheet.json validation (format.md). Used by the gate before a sheet is
// stored: another person's browser will render it, so the server checks
// shape and size, not just "is it JSON". Pure function, no DOM.
//
// The background SVG is rendered as an <img> (no script, no external
// loads), so it isn't sanitised tag by tag; anything that would only
// matter if it were ever inlined is refused outright instead.

export const LIMITS = {
  bytes: 16e6, pages: 200, fieldsPerPage: 400, textPerPage: 5000,
  backgroundBytes: 4e6, str: 2000, label: 200, title: 120,
};
const KINDS = new Set(['text', 'textarea', 'checkbox', 'date', 'number']);
const ID = /^[A-Za-z0-9_-]{1,60}$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5;
const str = (v, max) => typeof v === 'string' && v.length <= max;

/** @returns {{ok: true, sheet} | {ok: false, error: string}} */
export function validateSheet(input) {
  let sheet = input;
  if (typeof input === 'string') {
    if (input.length > LIMITS.bytes) return { ok: false, error: 'sheet too large' };
    try { sheet = JSON.parse(input); } catch { return { ok: false, error: 'not JSON' }; }
  }
  const fail = (error) => ({ ok: false, error });
  if (!sheet || sheet.format !== 'elkpd-sheet' || sheet.version !== 1) return fail('not an elkpd-sheet v1');
  if (!str(sheet.title || '', LIMITS.title)) return fail('title too long');
  if (!Array.isArray(sheet.pages) || !sheet.pages.length || sheet.pages.length > LIMITS.pages) return fail('bad pages');
  if (sheet.fonts && typeof sheet.fonts !== 'object') return fail('bad fonts');
  for (const [k, f] of Object.entries(sheet.fonts || {})) {
    if (!ID.test(k) || !f || !str(f.css, 300) || /[<>{};]|url\s*\(/i.test(f.css)) return fail('bad font ' + k);
    if (f.web && (!Array.isArray(f.web) || f.web.some((w) => !/^[A-Za-z0-9 ]{1,60}$/.test(w)))) return fail('bad web font ' + k);
  }
  const ids = new Set();
  for (const [pi, p] of sheet.pages.entries()) {
    const at = `page ${pi + 1}`;
    if (!p || !ID.test(p.id) || !num(p.width) || !num(p.height) || p.width <= 0 || p.height <= 0) return fail(at + ': bad page');
    if (p.background != null) {
      if (!str(p.background, LIMITS.backgroundBytes)) return fail(at + ': background too large');
      if (!p.background.startsWith('<svg') || /<script|<foreignObject|\son[a-z]+\s*=|javascript:|href\s*=\s*"(?!#|data:image\/(png|jpeg|gif|webp);)/i.test(p.background)) return fail(at + ': background not allowed');
    }
    if (!Array.isArray(p.text) || p.text.length > LIMITS.textPerPage) return fail(at + ': bad text');
    for (const t of p.text) {
      if (!t || !ID.test(t.id) || !num(t.x) || !num(t.baseline) || !num(t.size) || !str(t.str, LIMITS.str)) return fail(at + ': bad text run');
      if (t.font != null && !ID.test(t.font)) return fail(at + ': bad text font');
      if (t.color != null && !/^#[0-9a-f]{6}$/i.test(t.color)) return fail(at + ': bad text colour');
    }
    if (!Array.isArray(p.fields) || p.fields.length > LIMITS.fieldsPerPage) return fail(at + ': bad fields');
    for (const f of p.fields) {
      if (!f || !ID.test(f.id) || ids.has(f.id)) return fail(at + ': bad or duplicate field id ' + (f && f.id));
      ids.add(f.id);
      if (!KINDS.has(f.kind) || !num(f.x) || !num(f.y) || !num(f.w) || !num(f.h) || f.w <= 0 || f.h <= 0) return fail(at + ': bad field ' + f.id);
      if (!str(f.label || '', LIMITS.label) || !str(f.placeholder || '', LIMITS.label)) return fail(at + ': field text too long ' + f.id);
      if (f.lineGap != null && !(num(f.lineGap) && f.lineGap > 0)) return fail(at + ': bad lineGap ' + f.id);
    }
  }
  return { ok: true, sheet };
}
