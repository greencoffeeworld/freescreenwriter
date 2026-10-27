// Persistence: Cloud Firestore (when public/firebase-config.js is filled in),
// with automatic fallback to the local Node server (/api/projects) + localStorage backup.
import { firebaseConfig } from './firebase-config.js';

export const configured = !String(firebaseConfig.projectId).includes('REPLACE_ME');

// Unambiguous alphabet (no 0/o/1/l/i) so IDs are easy to read aloud and share.
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => ALPHA[b % ALPHA.length]).join('');
}

function fail(status) { return Object.assign(new Error(String(status)), { status }); }

/* ---------------- Firestore adapter (used on GitHub Pages) ---------------- */

let fsPromise = null;
function getFs() {
  if (!configured) return Promise.resolve(null);
  return (fsPromise ||= (async () => {
    const [{ initializeApp }, fs] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]);
    const db = fs.getFirestore(initializeApp(firebaseConfig));
    return { db, ...fs, ref: (id) => fs.doc(db, 'projects', id) };
  })());
}

let live = { id: null, version: 0, data: null, unsub: null };

export async function watch(id) {
  if (!configured || live.id === id) return;
  const fs = await getFs();
  live.unsub?.();
  live = { id, version: 0, data: null, unsub: null };
  live.unsub = fs.onSnapshot(fs.ref(id), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const v = snap.get('version');
    if (v >= live.version) { live.version = v; live.data = snap.get('data'); }
  }, () => { /* offline / permission — local backup still works */ });
}

/* ---------------- Local REST adapter (used with `npm start`) ---------------- */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw fail(res.status);
  return res.json();
}

/* ---------------- Unified public API ---------------- */

export async function createProject(data) {
  if (!configured) return api('POST', '/api/projects', { data });
  const fs = await getFs();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId();
    const ok = await fs.runTransaction(fs.db, async (tx) => {
      const snap = await tx.get(fs.ref(id));
      if (snap.exists()) return false;
      tx.set(fs.ref(id), {
        data: JSON.stringify(data),
        version: 1,
        created: fs.serverTimestamp(),
        updated: fs.serverTimestamp(),
      });
      return true;
    });
    if (ok) return { id, version: 1 };
  }
  throw fail(500);
}

export async function loadProject(id) {
  if (!configured) return api('GET', `/api/projects/${id}`);
  if (live.id === id && live.data) return { id, data: JSON.parse(live.data), version: live.version };
  const fs = await getFs();
  const snap = await fs.getDoc(fs.ref(id));
  if (!snap.exists()) throw fail(404);
  return { id, data: JSON.parse(snap.get('data')), version: snap.get('version') };
}

export async function saveProject(id, data) {
  if (!configured) return api('PUT', `/api/projects/${id}`, { data });
  const json = JSON.stringify(data);
  if (json.length > 900000) throw fail(413);
  const fs = await getFs();
  const version = await fs.runTransaction(fs.db, async (tx) => {
    const snap = await tx.get(fs.ref(id));
    if (!snap.exists()) throw fail(404);
    const v = snap.get('version') + 1;
    tx.set(fs.ref(id), { data: json, version: v, created: snap.get('created'), updated: fs.serverTimestamp() });
    return v;
  });
  if (live.id === id && version > live.version) { live.version = version; live.data = json; }
  return { version };
}

export async function getVersion(id) {
  if (!configured) return api('GET', `/api/projects/${id}/version`);
  if (live.id === id && live.version) return { version: live.version };
  const fs = await getFs();
  const snap = await fs.getDoc(fs.ref(id));
  if (!snap.exists()) throw fail(404);
  return { version: snap.get('version') };
}

/** Best-effort save on tab close. */
export function saveOnExit(id, data) {
  if (configured) { saveProject(id, data).catch(() => {}); return; }
  try {
    fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
      keepalive: true,
    });
  } catch { /* ignore */ }
}

export const local = {
  get(id) {
    try { return JSON.parse(localStorage.getItem('sw:p:' + id)); } catch { return null; }
  },
  set(id, value) {
    try { localStorage.setItem('sw:p:' + id, JSON.stringify(value)); } catch { /* quota */ }
  },
};

export function getRecent() {
  try { return JSON.parse(localStorage.getItem('sw:recent')) || []; } catch { return []; }
}

export function addRecent(id, title) {
  const list = getRecent().filter((r) => r.id !== id);
  list.unshift({ id, title: title || '', at: Date.now() });
  localStorage.setItem('sw:recent', JSON.stringify(list.slice(0, 8)));
}

export function getName() { return localStorage.getItem('sw:name') || ''; }
export function setName(n) { localStorage.setItem('sw:name', n); }
