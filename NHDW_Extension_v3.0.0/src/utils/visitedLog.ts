// Visited log (INDEXER_PLAN.md §5 History, phase 3): the content scripts
// already resolve the gallery they run on (titleBookmark.ts), so recording
// "opened this gallery on <date>" is one message to the worker and one
// IndexedDB put.
//
// Storage: extension-origin IndexedDB, DB "nhdw-library", store "visited" —
// NOT chrome.storage.local (§8.1 cap). The worker (which receives the
// content-script message) and the library tab (which renders History) share
// this same database because they share the extension origin.
//
// IMPORTANT CONTEXT RULE (same as bookmarkQueue.ts): this module is pure at
// module scope — no chrome.*, and IndexedDB is only touched inside functions
// — so the node test build can import the pure halves freely.

import { composeGalleryKey, normalizeSite } from "./siteKeys";

export const VISITED_DB_NAME = "nhdw-library";
export const VISITED_STORE = "visited";
export const VISITED_SCHEMA_VERSION = 1;

/** What the content script reports about one gallery visit. */
export interface VisitedInput {
    key: string;
    site: string;
    id: string;
    title: string;
    cover: string;
    pages: number | null;
    sourceUrl: string;
}

/** One stored visit row. */
export interface VisitedEntry extends VisitedInput {
    firstVisited: number;
    lastVisited: number;
    visitCount: number;
}

/** Validate a raw message payload into a VisitedInput; null when unusable. */
export function visitInputFromRequest(request: any): VisitedInput | null {
    if (!request || typeof request !== "object") return null;
    const site = normalizeSite(typeof request.site === "string" ? request.site : "");
    const id = typeof request.id === "string" && request.id !== "" ? request.id : "";
    if (id === "" || id.indexOf(":") !== -1) return null; // siteKeys rule: ids never carry ':'
    const title = typeof request.title === "string" ? request.title : "";
    const cover = typeof request.cover === "string" ? request.cover : "";
    const pages = Number.isFinite(request.pages) && request.pages >= 0 ? Math.floor(request.pages) : null;
    const sourceUrl = typeof request.sourceUrl === "string" && /^https:\/\//.test(request.sourceUrl) ? request.sourceUrl : "";
    return { key: composeGalleryKey(site, id), site, id, title, cover, pages, sourceUrl };
}

/**
 * Merge rules (pure): a revisit never loses the first date, always bumps the
 * count, and fills empty fields from the newer visit without overwriting
 * known ones with empty ones.
 */
export function upsertVisitRecord(existing: VisitedEntry | null, input: VisitedInput, now: number): VisitedEntry {
    if (!existing) {
        return {
            key: input.key,
            site: input.site,
            id: input.id,
            title: input.title,
            cover: input.cover,
            pages: input.pages,
            sourceUrl: input.sourceUrl,
            firstVisited: now,
            lastVisited: now,
            visitCount: 1,
        };
    }
    return {
        key: existing.key,
        site: existing.site,
        id: existing.id,
        title: existing.title || input.title,
        cover: existing.cover || input.cover,
        pages: existing.pages !== null ? existing.pages : input.pages,
        sourceUrl: input.sourceUrl || existing.sourceUrl,
        firstVisited: existing.firstVisited,
        lastVisited: now,
        visitCount: existing.visitCount + 1,
    };
}

// ------------------------------------------------------------- IndexedDB glue

function openVisitedDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(new Error("This context has no IndexedDB; the visited log cannot be stored here."));
    }
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(VISITED_DB_NAME, VISITED_SCHEMA_VERSION);
        open.onupgradeneeded = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains(VISITED_STORE)) {
                db.createObjectStore(VISITED_STORE, { keyPath: "key" });
            }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error || new Error("could not open the visited-log database"));
    });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
}

/** Record one visit (upsert). The worker calls this with the validated input. */
export async function recordVisit(input: VisitedInput, now: number = Date.now()): Promise<VisitedEntry> {
    const db = await openVisitedDb();
    try {
        const tx = db.transaction(VISITED_STORE, "readwrite");
        const store = tx.objectStore(VISITED_STORE);
        const existing = await requestToPromise(store.get(input.key) as IDBRequest<VisitedEntry | undefined>);
        const entry = upsertVisitRecord(existing || null, input, now);
        await requestToPromise(store.put(entry));
        return entry;
    } finally {
        db.close();
    }
}

/** Newest-visited first, windowed (History tab renders a 200-row window). */
export async function listVisits(limit: number, offset: number = 0): Promise<VisitedEntry[]> {
    const db = await openVisitedDb();
    try {
        const tx = db.transaction(VISITED_STORE, "readonly");
        const all = await requestToPromise(tx.objectStore(VISITED_STORE).getAll() as IDBRequest<VisitedEntry[]>);
        all.sort((a, b) => b.lastVisited - a.lastVisited || a.key.localeCompare(b.key));
        return all.slice(offset, offset + Math.max(0, limit));
    } finally {
        db.close();
    }
}

export async function countVisits(): Promise<number> {
    const db = await openVisitedDb();
    try {
        const tx = db.transaction(VISITED_STORE, "readonly");
        return await requestToPromise(tx.objectStore(VISITED_STORE).count());
    } finally {
        db.close();
    }
}

export async function clearVisits(): Promise<void> {
    const db = await openVisitedDb();
    try {
        const tx = db.transaction(VISITED_STORE, "readwrite");
        await requestToPromise(tx.objectStore(VISITED_STORE).clear());
    } finally {
        db.close();
    }
}
