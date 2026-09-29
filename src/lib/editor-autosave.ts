import { isCurrentDesign, type DesignDocument } from "./design-document";

/**
 * Autosave for the design editor. The editor's document used to live only
 * in memory — Back, a refresh, an edge-swipe or an in-app browser killing a
 * backgrounded tab wiped a half-made design. Now the in-progress document is
 * saved (debounced) while editing, and re-entering the editor offers
 * "Continue your design?".
 *
 * IndexedDB first: photos ride inside the document as data URLs (up to
 * ~2.4M chars with four photos), which overflows sessionStorage's ~5 MB
 * UTF-16 quota next to the flow draft. sessionStorage is the fallback where
 * IndexedDB is missing or refused (some private modes); a quota failure
 * there just means no autosave, never a broken editor.
 *
 * ONE slot: the latest editing session wins. Cleared when the design is used
 * or discarded; entries older than a week are ignored.
 */

export type EditorAutosave = {
  doc: DesignDocument;
  // "new" = a fresh design; "edit" = changes to the design with baseKey
  // (designKey of the document the edit started from).
  mode: "new" | "edit";
  baseKey: string | null;
  savedAt: number;
};

const DB_NAME = "pinatagrams-builder";
const STORE = "kv";
const KEY = "editor-autosave";
const SS_KEY = "pinatagrams-editor-autosave";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("idb-open"));
      req.onblocked = () => reject(new Error("idb-blocked"));
    } catch (e) {
      reject(e);
    }
  });
  // A refused open (e.g. a private mode without IndexedDB) stays refused for
  // this page load: the cached rejection sends every later save straight to
  // the sessionStorage fallback instead of re-trying on each edit.
  dbPromise.catch(() => {});
  return dbPromise;
}

function idb<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = op(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error ?? new Error("idb-tx"));
        tx.onabort = () => reject(tx.error ?? new Error("idb-abort"));
      }),
  );
}

function valid(a: unknown): a is EditorAutosave {
  const x = a as EditorAutosave | null;
  return (
    !!x &&
    typeof x.savedAt === "number" &&
    Date.now() - x.savedAt < MAX_AGE_MS &&
    (x.mode === "new" || x.mode === "edit") &&
    isCurrentDesign(x.doc)
  );
}

export async function loadEditorAutosave(): Promise<EditorAutosave | null> {
  if (typeof window === "undefined") return null;
  try {
    const a = await idb<unknown>("readonly", (s) => s.get(KEY));
    if (valid(a)) return a;
    if (a) void clearEditorAutosave();
  } catch {
    // no IndexedDB here — the sessionStorage copy below is the autosave
  }
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    const a = raw ? (JSON.parse(raw) as unknown) : null;
    return valid(a) ? a : null;
  } catch {
    return null;
  }
}

// Editing sessions: each editor mount takes a token, and saves carrying a
// stale token are dropped. That's what makes "Discard" final — the editor
// flushes its latest document as it unmounts, and without the token that
// flush would resurrect the design the shopper just threw away.
let session = 0;

export function beginEditorSession(): number {
  return ++session;
}

/** Throw the autosave away AND end the current editing session. */
export function discardEditorAutosave(): Promise<void> {
  session++;
  return clearEditorAutosave();
}

export async function saveEditorAutosave(
  a: EditorAutosave,
  token: number,
): Promise<void> {
  if (token !== session) return;
  try {
    await idb("readwrite", (s) => s.put(a, KEY));
    return;
  } catch {
    // fall through to sessionStorage
  }
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(a));
  } catch {
    // over quota (photo-heavy design) — no autosave, the editor still works
  }
}

export async function clearEditorAutosave(): Promise<void> {
  try {
    sessionStorage.removeItem(SS_KEY);
  } catch {}
  try {
    await idb("readwrite", (s) => s.delete(KEY));
  } catch {}
}
