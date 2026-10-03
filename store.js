// IndexedDB wrapper. Stores: pieces, snapshots, results, settings.

import { DEFAULT_RULES, cloneRules } from './rules.js';
import { countWords, slugify } from './md.js';

const DB_NAME = 'proof';
const DB_VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('pieces', { keyPath: 'id' });
      const snaps = db.createObjectStore('snapshots', { keyPath: 'id' });
      snaps.createIndex('pieceId', 'pieceId');
      db.createObjectStore('results', { keyPath: 'pieceId' });
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        let result;
        const r = fn(store);
        if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

/* ---------- ids and pieces ---------- */

export const uid = () =>
  globalThis.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

export function newPiece(fields = {}) {
  const now = Date.now();
  const p = {
    id: uid(),
    title: '',
    slug: '',
    status: 'idea',
    stage: '',
    tags: [],
    excerpt: '',
    body: '',
    words: 0,
    createdAt: now,
    updatedAt: now,
    path: null,
    remoteSha: null,
    dirty: true,
    deleted: false,
    conflict: null,
    ...fields,
  };
  p.slug = p.slug || slugify(p.title);
  p.words = countWords(p.body);
  return p;
}

/* ---------- snapshots ---------- */

export function snapshotsFor(pieceId) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const r = db.transaction('snapshots').objectStore('snapshots').index('pieceId').getAll(pieceId);
        r.onsuccess = () => resolve(r.result.sort((a, b) => b.createdAt - a.createdAt));
        r.onerror = () => reject(r.error);
      })
  );
}

export async function addSnapshot(piece, label, kind = 'manual') {
  const snap = {
    id: uid(),
    pieceId: piece.id,
    label,
    kind,
    title: piece.title,
    body: piece.body,
    words: countWords(piece.body),
    createdAt: Date.now(),
  };
  await put('snapshots', snap);
  await pruneSnapshots(piece.id);
  return snap;
}

// Keep every manual checkpoint and the 60 newest automatic snapshots.
async function pruneSnapshots(pieceId) {
  const all = await snapshotsFor(pieceId);
  const auto = all.filter((s) => s.kind !== 'manual');
  const extra = auto.slice(60);
  for (const s of extra) await del('snapshots', s.id);
}

export async function deleteSnapshotsFor(pieceId) {
  const all = await snapshotsFor(pieceId);
  for (const s of all) await del('snapshots', s.id);
}

/* ---------- settings ---------- */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-sonnet-5-5',
  effort: 'low',
  maxTokens: 16000,
  ghRepo: '',
  ghBranch: 'main',
  ghToken: '',
  lastPiece: null,
  lastPass: 'revise',
  lastSync: null,
};

export async function getSettings() {
  const rows = await getAll('settings');
  const s = { ...DEFAULT_SETTINGS, rules: cloneRules(DEFAULT_RULES) };
  for (const r of rows) {
    if (r.key === 'rules') s.rules = { ...cloneRules(DEFAULT_RULES), ...r.value };
    else s[r.key] = r.value;
  }
  return s;
}

export const setSetting = (key, value) => put('settings', { key, value });

/* ---------- storage persistence and backup ---------- */

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}

export async function exportAll() {
  return {
    app: 'proof',
    version: 1,
    exportedAt: new Date().toISOString(),
    pieces: await getAll('pieces'),
    snapshots: await getAll('snapshots'),
    results: await getAll('results'),
  };
}

export async function importAll(data) {
  if (!data || data.app !== 'proof' || !Array.isArray(data.pieces)) {
    throw new Error('That file is not a Proof backup.');
  }
  for (const p of data.pieces) await put('pieces', p);
  for (const s of data.snapshots || []) await put('snapshots', s);
  for (const r of data.results || []) await put('results', r);
  return data.pieces.length;
}
