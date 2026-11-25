// Studio persistence: sheets live in this browser's IndexedDB until the
// projects backend (#11 design, step 2) exists. A sheet with images can be
// several MB, which is why this isn't localStorage.
const DB = 'elkpd-studio';
const STORE = 'sheets';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const store = {
  /** meta: { projectId } when the sheet is linked to a project on the server */
  async put(key, sheet, meta = {}) {
    try { await tx('readwrite', (s) => s.put({ key, sheet, title: sheet.title, pages: sheet.pages.length, updated: Date.now(), ...meta })); return true; }
    catch { return false; } // private mode, quota: the editor keeps working
  },
  async get(key) {
    try { const r = await tx('readonly', (s) => s.get(key)); return r || null; } catch { return null; }
  },
  async list() {
    try {
      const all = await tx('readonly', (s) => s.getAll());
      return (all || []).map(({ key, title, pages, updated, projectId }) => ({ key, title, pages, updated, projectId })).sort((a, b) => b.updated - a.updated);
    } catch { return []; }
  },
  async remove(key) {
    try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
  },
};
