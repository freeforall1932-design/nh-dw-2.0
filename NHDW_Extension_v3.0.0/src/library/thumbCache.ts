// Thumbnail cache glue (INDEXER_PLAN.md §8.8, phase 3b): thumbs the user has
// browsed are kept in OPFS so covers come back instantly and survive
// offline, under an LRU cap (Settings, default 2 GB, 0 disables).
//
// Fetch path and the dynamic CDN-host grant: the cache fetches from the
// library page itself. Host permissions (static or granted through the
// panel's existing CDN notice via optional_host_permissions) apply to
// extension-page fetches, so the cache "rides the grant flow" without any
// new background plumbing — and when the host is not granted, the fetch
// fails harmless and the cover keeps rendering live from its remote URL
// exactly as before. Nothing here bypasses anything.
//
// Storage: OPFS directory "thumbs/<sha256-hex>" plus a ledger in the shared
// library IndexedDB (libraryDb.ts, store "thumbs"). The ledger is the LRU
// bookkeeping (size + lastAccess per key); a ledger row whose OPFS file has
// vanished is treated as a miss and cleaned up.

import {
    CACHE_CAP_STORAGE,
    DEFAULT_CACHE_MB,
    evictionPlan,
    normalizeThumbMode,
    ThumbLedgerEntry,
    ThumbLedger,
    ThumbMode,
    THUMB_MODE_STORAGE,
    thumbKeyFor,
} from "./thumbLru";
import { THUMBS_STORE_NAME, idbRequestToPromise, openLibraryDb } from "../utils/libraryDb";

const THUMB_DIR = "thumbs";

/** The configured thumbnail source mode; "cached" is the default. */
export function getThumbMode(): Promise<ThumbMode> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ [THUMB_MODE_STORAGE]: "cached" }, (elems: any) => {
                resolve(normalizeThumbMode(elems[THUMB_MODE_STORAGE]));
            });
        } catch (_) {
            resolve("cached");
        }
    });
}

export function setThumbMode(mode: ThumbMode): void {
    try {
        chrome.storage.local.set({ [THUMB_MODE_STORAGE]: normalizeThumbMode(mode) }, () => { /* saved */ });
    } catch (_) { /* session-only */ }
}

export type ThumbCacheStatus = "cached" | "exists" | "skipped-disabled" | "skipped-too-big" | "failed";

function storageRoot(): FileSystemDirectoryHandle {
    const navAny = navigator as any;
    if (!navAny || !navAny.storage || typeof navAny.storage.getDirectory !== "function") {
        throw new Error("This browser has no OPFS root; the thumbnail cache cannot run here.");
    }
    return navAny.storage.getDirectory();
}

async function thumbDirectory(): Promise<FileSystemDirectoryHandle> {
    const root = await storageRoot();
    return root.getDirectoryHandle(THUMB_DIR, { create: true });
}

/** The configured cap in bytes; 0 disables the cache. */
export function getThumbCapBytes(): Promise<number> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ [CACHE_CAP_STORAGE]: DEFAULT_CACHE_MB }, (elems: any) => {
                const mb = typeof elems[CACHE_CAP_STORAGE] === "number" && elems[CACHE_CAP_STORAGE] >= 0
                    ? elems[CACHE_CAP_STORAGE]
                    : DEFAULT_CACHE_MB;
                resolve(Math.round(mb * 1024 * 1024));
            });
        } catch (_) {
            resolve(DEFAULT_CACHE_MB * 1024 * 1024);
        }
    });
}

export function setThumbCapMb(mb: number): void {
    const value = Number.isFinite(mb) && mb >= 0 ? Math.round(mb) : DEFAULT_CACHE_MB;
    try {
        chrome.storage.local.set({ [CACHE_CAP_STORAGE]: value }, () => { /* saved */ });
    } catch (_) { /* session-only */ }
}

// ------------------------------------------------------------- ledger

type LedgerRow = ThumbLedgerEntry;

async function ledgerAll(): Promise<ThumbLedger> {
    const db = await openLibraryDb();
    try {
        const tx = db.transaction(THUMBS_STORE_NAME, "readonly");
        const rows = await idbRequestToPromise(tx.objectStore(THUMBS_STORE_NAME).getAll() as IDBRequest<LedgerRow[]>);
        const ledger: ThumbLedger = new Map();
        for (const row of rows) {
            if (row && typeof row.key === "string") ledger.set(row.key, row);
        }
        return ledger;
    } finally {
        db.close();
    }
}

async function ledgerPut(row: LedgerRow): Promise<void> {
    const db = await openLibraryDb();
    try {
        const tx = db.transaction(THUMBS_STORE_NAME, "readwrite");
        await idbRequestToPromise(tx.objectStore(THUMBS_STORE_NAME).put(row));
    } finally {
        db.close();
    }
}

async function ledgerDelete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await openLibraryDb();
    try {
        const tx = db.transaction(THUMBS_STORE_NAME, "readwrite");
        const store = tx.objectStore(THUMBS_STORE_NAME);
        for (const key of keys) store.delete(key);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("ledger delete failed"));
        });
    } finally {
        db.close();
    }
}

async function deleteThumbFile(key: string): Promise<void> {
    try {
        const dir = await thumbDirectory();
        await dir.removeEntry(key);
    } catch (_) { /* already gone */ }
}

// ------------------------------------------------------------- public API

/** An in-flight ensureCached per URL, so one page of covers fetches once. */
const inFlight = new Map<string, Promise<ThumbCacheStatus>>();

/**
 * Serve the cached object URL for a thumb, or null. Touches the LRU on hit.
 * A ledger row without its OPFS file is cleaned up and reported as a miss.
 */
export async function resolveCachedThumb(url: string): Promise<string | null> {
    if (!url) return null;
    let key: string;
    try {
        key = await thumbKeyFor(url);
    } catch (_) {
        return null;
    }
    const ledger = await ledgerAll();
    const row = ledger.get(key);
    if (!row) return null;
    try {
        const dir = await thumbDirectory();
        const handle = await dir.getFileHandle(key);
        const file = await handle.getFile();
        const objectUrl = URL.createObjectURL(file);
        await ledgerPut({ key, size: row.size, lastAccess: Date.now() });
        return objectUrl;
    } catch (_) {
        // Ledger row without a file: clean the row, report the miss.
        await ledgerDelete([key]);
        return null;
    }
}

/** Fetch (once), store, and evict-to-cap. Never throws: statuses tell. */
export async function ensureCachedThumb(url: string, fetchImpl?: (input: RequestInfo | URL) => Promise<Response>): Promise<ThumbCacheStatus> {
    if (!url) return "failed";
    const existing = inFlight.get(url);
    if (existing) return existing;
    const job = ensureCachedThumbInner(url, fetchImpl).finally(() => inFlight.delete(url));
    inFlight.set(url, job);
    return job;
}

async function ensureCachedThumbInner(url: string, fetchImpl?: (input: RequestInfo | URL) => Promise<Response>): Promise<ThumbCacheStatus> {
    const capBytes = await getThumbCapBytes();
    if (capBytes <= 0) return "skipped-disabled";
    const key = await thumbKeyFor(url);
    const ledger = await ledgerAll();
    if (ledger.has(key)) {
        const row = ledger.get(key)!;
        await ledgerPut({ key, size: row.size, lastAccess: Date.now() });
        return "exists";
    }
    let blob: Blob;
    try {
        const doFetch = fetchImpl || ((input: RequestInfo | URL) => fetch(input));
        const response = await doFetch(url);
        if (!response || typeof response.status === "number" && (response.status < 200 || response.status >= 300)) {
            return "failed";
        }
        blob = await response.blob();
    } catch (_) {
        // Typical cause: the host is not (yet) granted. The cover keeps
        // rendering live from the remote URL; nothing is bypassed.
        return "failed";
    }
    if (blob.size <= 0) return "failed";
    if (blob.size > capBytes) return "skipped-too-big";

    try {
        const dir = await thumbDirectory();
        const handle = await dir.getFileHandle(key, { create: true });
        const writable = await (handle as any).createWritable();
        await writable.write(blob);
        await writable.close();
        await ledgerPut({ key, size: blob.size, lastAccess: Date.now() });
    } catch (_) {
        return "failed";
    }

    // LRU pass over the ledger WITH the incoming row included. If the plan
    // names the incoming key, the cache cannot hold it under this cap at
    // all: remove it again rather than breaking the cap.
    const withIncoming: ThumbLedgerEntry[] = [];
    const refreshed = await ledgerAll();
    for (const row of refreshed.values()) withIncoming.push(row);
    const plan = evictionPlan(withIncoming, capBytes);
    if (plan.indexOf(key) !== -1) {
        await deleteThumbFile(key);
        await ledgerDelete([key]);
        return "skipped-too-big";
    }
    await deleteThumbFilesFor(plan);
    return "cached";
}

async function deleteThumbFilesFor(keys: string[]): Promise<void> {
    for (const key of keys) await deleteThumbFile(key);
    await ledgerDelete(keys);
}

/** LRU pass for a shrunk cap (or 0 = disabled: everything goes). Count returned. */
export async function pruneToCap(): Promise<number> {
    const capBytes = await getThumbCapBytes();
    const ledger = await ledgerAll();
    const plan = evictionPlan(Array.from(ledger.values()), capBytes);
    if (plan.length === 0) return 0;
    await deleteThumbFilesFor(plan);
    return plan.length;
}

/** Entries + bytes for the Settings readout. */
export async function cacheStats(): Promise<{ entries: number; bytes: number }> {
    try {
        const ledger = await ledgerAll();
        let bytes = 0;
        for (const row of ledger.values()) bytes += row.size > 0 ? row.size : 0;
        return { entries: ledger.size, bytes };
    } catch (_) {
        return { entries: 0, bytes: 0 };
    }
}

/** Drop every cached thumb and the ledger. The cap setting survives. */
export async function clearThumbCache(): Promise<void> {
    try {
        const dir = await thumbDirectory();
        try {
            for await (const name of (dir as any).keys()) {
                try { await dir.removeEntry(name); } catch (_) { /* gone */ }
            }
        } catch (_) { /* iteration unsupported: nothing enumerable */ }
    } catch (_) { /* no directory yet */ }
    try {
        const ledger = await ledgerAll();
        await ledgerDelete(Array.from(ledger.keys()));
    } catch (_) { /* ledger already unavailable */ }
}

/**
 * Whether the cache may fetch this origin today (host permission present,
 * statically or via the panel's grant). Best-effort hint text only.
 */
export function hostGrantHint(url: string): Promise<string> {
    return new Promise((resolve) => {
        let origin = "";
        try {
            origin = new URL(url).origin;
        } catch (_) {
            resolve("");
            return;
        }
        try {
            chrome.permissions.contains({ origins: [origin + "/*"] }, (granted) => {
                if (granted === true) resolve("");
                else resolve("covers display live, but the cache can only keep them after the CDN host grant (the panel's CDN notice)");
            });
        } catch (_) {
            resolve("covers display live; cache availability depends on the CDN host grant");
        }
    });
}
