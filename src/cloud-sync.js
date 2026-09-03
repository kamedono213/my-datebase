// Orchestrates Google sign-in and Firestore mirroring on top of the existing
// IndexedDB store (src/db.js), which always stays the source of truth for
// offline / signed-out use. Firestore is treated as a durable cloud copy of
// everything except image attachments (Firestore documents cap at 1MiB,
// which attachments can exceed).
import {
  putNote as localPutNote,
  deleteNotePermanently as localDeleteNotePermanently,
  listNotes,
} from './db.js';
import { createNote } from './model.js';
import {
  watchAuthState,
  signInWithGoogle,
  completeRedirectSignIn,
  signOutOfGoogle,
  fetchCloudNotesOnce,
  subscribeToCloudNotes,
  writeCloudNote,
  deleteCloudNote,
} from './cloud.js';

let currentUser = null;
let unsubscribeSnapshot = null;
let status = 'signed-out';
const statusListeners = new Set();
const notesChangedListeners = new Set();

function setStatus(next) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(status);
}

function computeOnlineStatus(meta) {
  if (!navigator.onLine) return 'offline';
  if (meta?.hasPendingWrites) return 'syncing';
  return 'synced';
}

function notifyNotesChanged() {
  for (const listener of notesChangedListeners) listener();
}

async function applyRemoteNote(note) {
  const local = await listNotes();
  const existing = local.find((item) => item.id === note.id);
  if (existing && (existing.updatedAt || 0) >= (note.updatedAt || 0)) return false;
  await localPutNote(createNote({ ...note, attachments: existing?.attachments ?? [] }, note.createdAt));
  return true;
}

// Runs once per sign-in (and is safe to re-run any time): unions local and
// cloud notes by id, and lets the newer `updatedAt` win per note. Never
// treats an empty side as "nothing to keep" — that is how data loss happens.
async function mergeLocalAndCloud(uid) {
  const [local, remote] = await Promise.all([listNotes(), fetchCloudNotesOnce(uid)]);
  const remoteById = new Map(remote.map((note) => [note.id, note]));
  const localById = new Map(local.map((note) => [note.id, note]));

  for (const note of remote) {
    const localNote = localById.get(note.id);
    if (!localNote || (note.updatedAt || 0) > (localNote.updatedAt || 0)) {
      await applyRemoteNote(note);
    }
  }

  for (const note of local) {
    const remoteNote = remoteById.get(note.id);
    if (!remoteNote || (note.updatedAt || 0) > (remoteNote.updatedAt || 0)) {
      await writeCloudNote(uid, note).catch((error) => console.warn('Cloud upload failed', note.id, error));
    }
  }
}

export function initCloudSync({ onNotesChanged, onStatusChange, onAuthChanged } = {}) {
  if (onStatusChange) statusListeners.add(onStatusChange);
  if (onNotesChanged) notesChangedListeners.add(onNotesChanged);

  window.addEventListener('online', () => setStatus(computeOnlineStatus()));
  window.addEventListener('offline', () => setStatus('offline'));

  completeRedirectSignIn().then(() => {
    watchAuthState(async (user) => {
      currentUser = user;
      onAuthChanged?.(user);
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }
      if (!user) {
        setStatus('signed-out');
        return;
      }

      setStatus('syncing');
      try {
        await mergeLocalAndCloud(user.uid);
      } catch (error) {
        console.warn('Initial cloud merge failed', error);
        setStatus('error');
      }
      notifyNotesChanged();

      unsubscribeSnapshot = subscribeToCloudNotes(
        user.uid,
        async (remoteNotes, meta) => {
          let changed = false;
          for (const note of remoteNotes) {
            if (await applyRemoteNote(note)) changed = true;
          }
          if (changed) notifyNotesChanged();
          setStatus(computeOnlineStatus(meta));
        },
        (error) => {
          console.warn('Cloud subscription error', error);
          setStatus('error');
        },
      );
    });
  });
}

export function getCloudStatus() {
  return status;
}

export function getCloudUser() {
  return currentUser;
}

export function signIn() {
  return signInWithGoogle();
}

export function signOutCloud() {
  return signOutOfGoogle();
}

export async function putNote(note) {
  await localPutNote(note);
  if (currentUser) {
    writeCloudNote(currentUser.uid, note).catch((error) => {
      console.warn('Cloud sync failed for note', note.id, error);
      setStatus('error');
    });
  }
}

export async function deleteNotePermanently(id) {
  await localDeleteNotePermanently(id);
  if (currentUser) {
    deleteCloudNote(currentUser.uid, id).catch((error) => {
      console.warn('Cloud delete failed for note', id, error);
      setStatus('error');
    });
  }
}
