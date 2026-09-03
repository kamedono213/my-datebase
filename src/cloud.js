// Thin wrapper around the Firebase Web SDK (loaded straight from the CDN as
// ES modules, so no bundler/build step is required for this static site).
import { firebaseConfig } from './firebase-config.js';

const SDK_VERSION = '10.14.1';
const CDN_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const [{ initializeApp }, authSdk, firestoreSdk] = await Promise.all([
  import(`${CDN_BASE}/firebase-app.js`),
  import(`${CDN_BASE}/firebase-auth.js`),
  import(`${CDN_BASE}/firebase-firestore.js`),
]);

const {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} = authSdk;

const {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
} = firestoreSdk;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// Firestore's own offline cache handles queued writes and cached reads while
// offline, so we lean on it instead of hand-rolling a write queue.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export function getCurrentUser() {
  return auth.currentUser;
}

export async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    const popupIssue = [
      'auth/popup-blocked',
      'auth/popup-closed-by-user',
      'auth/cancelled-popup-request',
      'auth/operation-not-supported-in-this-environment',
    ].includes(error?.code);
    if (!popupIssue) throw error;
    // Installed PWAs / some mobile browsers don't support popups reliably.
    await signInWithRedirect(auth, provider);
  }
}

export async function completeRedirectSignIn() {
  try {
    await getRedirectResult(auth);
  } catch (error) {
    console.warn('Google redirect sign-in failed', error);
  }
}

export function signOutOfGoogle() {
  return signOut(auth);
}

function notesCollection(uid) {
  return collection(db, 'users', uid, 'notes');
}

export async function fetchCloudNotesOnce(uid) {
  const snapshot = await getDocs(notesCollection(uid));
  return snapshot.docs.map((docSnap) => docSnap.data());
}

export function subscribeToCloudNotes(uid, onChange, onError) {
  return onSnapshot(
    notesCollection(uid),
    { includeMetadataChanges: true },
    (snapshot) => {
      const notes = snapshot.docs.map((docSnap) => docSnap.data());
      onChange(notes, {
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
      });
    },
    onError,
  );
}

export function writeCloudNote(uid, note) {
  const { attachments, ...cloudNote } = note;
  return setDoc(doc(notesCollection(uid), note.id), cloudNote);
}

export function deleteCloudNote(uid, id) {
  return deleteDoc(doc(notesCollection(uid), id));
}
