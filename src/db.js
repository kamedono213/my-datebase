import { createNote, validateBackup } from './model.js';

const DB_NAME = 'personal-knowledge-db';
const DB_VERSION = 1;
const NOTES_STORE = 'notes';
const SETTINGS_STORE = 'settings';

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        const notes = db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
        notes.createIndex('updatedAt', 'updatedAt');
        notes.createIndex('deletedAt', 'deletedAt');
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function listNotes() {
  const db = await openDb();
  const tx = db.transaction(NOTES_STORE, 'readonly');
  return requestToPromise(tx.objectStore(NOTES_STORE).getAll());
}

export async function getNote(id) {
  const db = await openDb();
  const tx = db.transaction(NOTES_STORE, 'readonly');
  return requestToPromise(tx.objectStore(NOTES_STORE).get(id));
}

export async function putNote(note) {
  const db = await openDb();
  const tx = db.transaction(NOTES_STORE, 'readwrite');
  tx.objectStore(NOTES_STORE).put(createNote(note, note.createdAt ?? Date.now()));
  await transactionDone(tx);
}

export async function deleteNotePermanently(id) {
  const db = await openDb();
  const tx = db.transaction(NOTES_STORE, 'readwrite');
  tx.objectStore(NOTES_STORE).delete(id);
  await transactionDone(tx);
}

export async function getSetting(key, fallback = null) {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, 'readonly');
  const entry = await requestToPromise(tx.objectStore(SETTINGS_STORE).get(key));
  return entry ? entry.value : fallback;
}

export async function setSetting(key, value) {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, 'readwrite');
  tx.objectStore(SETTINGS_STORE).put({ key, value });
  await transactionDone(tx);
}

async function listSettings() {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, 'readonly');
  const rows = await requestToPromise(tx.objectStore(SETTINGS_STORE).getAll());
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

export async function exportData() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: await listNotes(),
    settings: await listSettings(),
  };
}

export async function importData(data) {
  if (!validateBackup(data)) throw new Error('バックアップ形式が正しくありません。');
  const db = await openDb();
  const tx = db.transaction([NOTES_STORE, SETTINGS_STORE], 'readwrite');
  const notesStore = tx.objectStore(NOTES_STORE);
  const settingsStore = tx.objectStore(SETTINGS_STORE);
  notesStore.clear();
  settingsStore.clear();
  for (const note of data.notes) notesStore.put(createNote(note, note.createdAt));
  for (const [key, value] of Object.entries(data.settings)) settingsStore.put({ key, value });
  await transactionDone(tx);
}

export async function seedInitialDataOnce(notes = [], seedId = 'initial-data-v1') {
  const markerKey = `seed:${seedId}`;
  if (await getSetting(markerKey, false)) return 0;

  const existing = await listNotes();
  const existingIds = new Set(existing.map((note) => note.id));
  const missing = notes.filter((note) => note?.id && !existingIds.has(note.id));

  const db = await openDb();
  const tx = db.transaction([NOTES_STORE, SETTINGS_STORE], 'readwrite');
  const notesStore = tx.objectStore(NOTES_STORE);
  const settingsStore = tx.objectStore(SETTINGS_STORE);
  for (const note of missing) notesStore.put(createNote(note, note.createdAt));
  settingsStore.put({ key: markerKey, value: true });
  await transactionDone(tx);
  return missing.length;
}
