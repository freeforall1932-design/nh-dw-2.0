// One shared IndexedDB for the library feature set (INDEXER_PLAN.md): the
// visited log store (visitedLog.ts) and the thumbnail-cache ledger
// (thumbCache.ts) live in the same database because both are extension-wide
// and both must never touch the capped chrome.storage.local (§8.1).
//
// Version history: 1 = visited store; 2 = + thumbs ledger store. Upgrade is
// idempotent (each store is created only when missing), so an older build's
// database upgrades in place and a newer build's open() is a no-op.

export const LIBRARY_DB_NAME = "nhdw-library";
export const LIBRARY_DB_VERSION = 2;
export const VISITED_STORE_NAME = "visited";
export const THUMBS_STORE_NAME = "thumbs";

export function openLibraryDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(new Error("This context has no IndexedDB; library stores are unavailable here."));
    }
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
        open.onupgradeneeded = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains(VISITED_STORE_NAME)) {
                db.createObjectStore(VISITED_STORE_NAME, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(THUMBS_STORE_NAME)) {
                db.createObjectStore(THUMBS_STORE_NAME, { keyPath: "key" });
            }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error || new Error("could not open the library database"));
    });
}

/** Promise wrapper for one IDBRequest (same shape as visitedLog's helper). */
export function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
}
