/**
 * utils/storage.js
 *
 * IndexedDB helper managing Room ID persistence, role tracking,
 * and Sender/Receiver state persistence.
 */

const DB_NAME = "SyncDropSessionDB";
const STORE_NAME = "session_store";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRoomId(roomId) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const getReq = store.get("current_session");
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      existing.roomId = roomId;
      existing.timestamp = Date.now();
      store.put(existing, "current_session");
    };
  } catch (err) {
    console.warn("[Storage] Failed to save roomId:", err);
  }
}

/**
 * Saves transfer metadata along with the active user role ('sender' | 'receiver').
 */
export async function saveTransferState(data) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const getReq = store.get("current_session");
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const updated = {
        ...existing,
        ...data, // includes role, senderFile, fileId, fileName, fileSize, fileType
        timestamp: Date.now(),
      };
      store.put(updated, "current_session");
    };
  } catch (err) {
    console.warn("[Storage] Failed to save transfer state:", err);
  }
}

/**
 * Clears file metadata/sender binary from IndexedDB while PRESERVING the roomId.
 */
export async function clearFileMetadataOnly() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const getReq = store.get("current_session");
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (existing) {
        const cleanedSession = {
          roomId: existing.roomId,
          timestamp: existing.timestamp,
        };
        store.put(cleanedSession, "current_session");
      }
    };
  } catch (err) {
    console.warn("[Storage] Failed to clear file metadata:", err);
  }
}

export async function clearSenderFile() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const getReq = store.get("current_session");
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (existing) {
        delete existing.senderFile;
        delete existing.role;
        store.put(existing, "current_session");
      }
    };
  } catch (err) {
    console.warn("[Storage] Failed to clear sender file:", err);
  }
}

export async function getSessionState() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve) => {
      const request = store.get("current_session");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn("[Storage] Failed to read session state:", err);
    return null;
  }
}

export async function clearSessionState() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    await store.delete("current_session");
  } catch (err) {
    console.warn("[Storage] Failed to clear session state:", err);
  }
}
