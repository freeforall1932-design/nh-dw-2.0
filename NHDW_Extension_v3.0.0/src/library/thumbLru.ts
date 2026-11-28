// Pure LRU core for the thumbnail cache (INDEXER_PLAN.md §8.8, phase 3b).
// No browser APIs: the ledger is plain data and the eviction plan is a pure
// function, so test/thumb-cache.test.js pins the exact behaviour.
//
// Ledger contract:
//  * key: sha256 hex of the source URL (thumbKeyFor) — the OPFS file is that
//    hex, nothing else, so the filename can never smuggle a path or ext.
//  * size: blob bytes. lastAccess: Date.now() at insert or touch.
//
// evictionPlan contract (pinned by tests):
//  * Entries are the ledger WITH the incoming item already inserted.
//  * Oldest lastAccess is evicted first, until the total is <= capBytes.
//  * A tie on lastAccess is broken by key, so the plan is deterministic.
//  * capBytes <= 0 means "cache disabled": every entry is evictable.
//  * If the newest entry alone exceeds the cap, the plan eventually names it
//    too — the caller must treat "incoming key appears in the plan" as
//    "refuse to cache this one" (too big for the whole cap).

export interface ThumbLedgerEntry {
    key: string;
    size: number;
    lastAccess: number;
}

// Settings constants are pure config (thumbCache.ts consumes them): the cap
// defaults to 2 GB (§8.8) and 0 disables the cache entirely.
export const DEFAULT_CACHE_MB = 2048;
export const CACHE_CAP_STORAGE = "libraryThumbCacheMb";

export type ThumbLedger = Map<string, ThumbLedgerEntry>;

export function totalBytes(entries: Iterable<ThumbLedgerEntry>): number {
    let total = 0;
    for (const entry of entries) {
        total += Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;
    }
    return total;
}

export function evictionPlan(entries: ThumbLedgerEntry[], capBytes: number): string[] {
    if (capBytes <= 0) return entries.map((entry) => entry.key);
    const sorted = entries.slice().sort((a, b) =>
        a.lastAccess - b.lastAccess || a.key.localeCompare(b.key));
    let total = totalBytes(sorted);
    const plan: string[] = [];
    for (const entry of sorted) {
        if (total <= capBytes) break;
        plan.push(entry.key);
        total -= Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;
    }
    return plan;
}

/** sha256 hex of the source URL — stable across sessions and contexts. */
export async function thumbKeyFor(url: string): Promise<string> {
    if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new Error("This context has no Web Crypto; thumbnail cache keys cannot be built.");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
}
