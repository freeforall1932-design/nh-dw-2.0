// Item 68 — the Bookmark tab's search, filters and row windowing.
//
// What this file is for. The Bookmark tab is a working set that grows until the
// user prunes it, so "find the ones I mean" has to work before a batch runs:
// search by title / id / tag, narrow by site (item 66), by recorded state, by
// when it was added - and never change the stored order, because that order IS
// the download order the drag handle edits.
//
// Design rules:
//   * Pure. No chrome.*, no DOM: the panel renders with these, so every rule
//     (matching, buckets, the already-downloaded mark, chunking) is unit-tested
//     in Node and the e2e phases only prove the wiring.
//   * The already-downloaded mark is HISTORY, never row status. A row can say
//     "done" long after the file was deleted, and a row that failed a retry can
//     still sit on top of a file from an earlier success. The owner's rule was
//     "green check only on true success": history is written only when a job
//     actually produced its artifact, so it is the honest source - and a row
//     that merely claims "done" is NOT marked.
//   * Windowing over virtualization. A true absolutely-positioned virtual list
//     would fight drag-reorder, the row checkbox hit targets and the collapsed
//     dock in a 500px popup. A bounded chunk (render N, grow on demand) keeps
//     the DOM at a few hundred rows regardless of list size, which is the
//     requirement the item actually stated.
//   * The cap is NOT raised here. MAX_BOOKMARK_ITEMS stays where the owner set
//     it; windowing makes the list cheap at any size they choose later.

import { BookmarkItem, BookmarkState, normalizeBookmarkSiteFilter } from "./bookmarkQueue";
import { normalizeSite, toGalleryKey } from "./siteKeys";

/** Rows rendered at once; "Show more" grows the window by this much. */
export const BOOKMARK_PAGE_SIZE = 200;

/** The recorded-state views the filter offers, canonical order. */
export const BOOKMARK_STATUS_FILTERS = ["all", "saved", "selected", "done", "failed", "downloading"] as const;
export type BookmarkStatusFilter = typeof BOOKMARK_STATUS_FILTERS[number];

/** Date buckets, canonical order. Each is its own predicate (see the reader). */
export const BOOKMARK_DATE_BUCKETS = ["all", "today", "week", "month", "older"] as const;
export type BookmarkDateBucket = typeof BOOKMARK_DATE_BUCKETS[number];

export interface BookmarkQuery {
    /** Site slug or SITE_FILTER_ALL. */
    site: string;
    /** Free text; every whitespace-separated term must match. */
    text: string;
    status: BookmarkStatusFilter;
    date: BookmarkDateBucket;
}

export const BOOKMARK_QUERY_DEFAULTS: BookmarkQuery = { site: "all", text: "", status: "all", date: "all" };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tolerant read of a query. Unknown sites/statuses/buckets read as "all" and a
 * non-string text is stringified then trimmed, so a corrupt persisted value can
 * never blank the list with no way back (same rule as the site filter).
 */
export function normalizeBookmarkQuery(raw: any): BookmarkQuery {
    const source = raw !== null && typeof raw === "object" ? raw : {};
    const text = source.text === undefined || source.text === null ? "" : String(source.text).trim();
    const status = BOOKMARK_STATUS_FILTERS.indexOf(source.status) !== -1 ? source.status : "all";
    const date = BOOKMARK_DATE_BUCKETS.indexOf(source.date) !== -1 ? source.date : "all";
    return { site: normalizeBookmarkSiteFilter(source.site), text: text, status: status, date: date };
}

/** True when the query would show the whole list (the panel hides its filter line). */
export function isDefaultBookmarkQuery(raw: any): boolean {
    const query = normalizeBookmarkQuery(raw);
    return query.site === BOOKMARK_QUERY_DEFAULTS.site
        && query.text === ""
        && query.status === "all"
        && query.date === "all";
}

function startOfLocalDay(now: number): number {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

/**
 * Bucket predicates. They are deliberately not exclusive of each other:
 * "week" means the last seven days INCLUDING today, which is what a user
 * means by "this week" when they are hunting for something they just added.
 * "older" is the only one that looks backwards past a window.
 */
export function bookmarkMatchesDate(item: BookmarkItem, bucket: BookmarkDateBucket, now: number): boolean {
    const at = item && Number.isFinite(item.addedAt) ? item.addedAt : 0;
    switch (bucket) {
        case "today": return at >= startOfLocalDay(now);
        case "week": return at >= now - WEEK_MS;
        case "month": return at >= now - MONTH_MS;
        case "older": return at < now - MONTH_MS;
        default: return true;
    }
}

/**
 * Text search over title, id, site and stored tags. Every term must match
 * (AND), because "artist tag plus language" is the actual way people search a
 * library, and an OR would answer with everything either term hits.
 */
export function bookmarkMatchesText(item: BookmarkItem, text: string): boolean {
    const terms = String(text === undefined || text === null ? "" : text).trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
    if (terms.length === 0) {
        return true;
    }
    const tags = item && Array.isArray(item.tags) ? item.tags.join(" ") : "";
    const haystack = [
        item && item.title ? item.title : "",
        item && item.id ? item.id : "",
        normalizeSite(item && item.site),
        tags
    ].join(" ").toLowerCase();
    for (const term of terms) {
        if (haystack.indexOf(term) === -1) {
            return false;
        }
    }
    return true;
}

/** One predicate for the whole query; the panel and the tests share it. */
export function bookmarkMatchesQuery(item: BookmarkItem, rawQuery: any, now: number): boolean {
    if (!item) {
        return false;
    }
    const query = normalizeBookmarkQuery(rawQuery);
    if (query.site !== "all" && normalizeSite(item.site) !== query.site) {
        return false;
    }
    if (query.status === "selected") {
        if (item.selected !== true) {
            return false;
        }
    } else if (query.status !== "all" && item.status !== query.status) {
        return false;
    }
    return bookmarkMatchesText(item, query.text) && bookmarkMatchesDate(item, query.date, now);
}

/** The rows a query shows - same order as stored (the download order). */
export function queryBookmarks(state: BookmarkState, rawQuery: any, now: number = Date.now()): BookmarkItem[] {
    const items = state && Array.isArray(state.items) ? state.items : [];
    return items.filter((item) => bookmarkMatchesQuery(item, rawQuery, now));
}

/**
 * Is this title on disk? Composite keys only: the same gallery number on
 * another site is a different title, and item 48's lesson was exactly that.
 */
export function bookmarkIsDownloaded(item: BookmarkItem, historyKeys: string[]): boolean {
    if (!item) {
        return false;
    }
    const keys = Array.isArray(historyKeys) ? historyKeys : [];
    return keys.indexOf(toGalleryKey(item.id, item.site)) !== -1;
}

/** The artifact name behind the mark, "" when there is no record. */
export function bookmarkHistoryName(item: BookmarkItem, history: any): string {
    if (!item || history === null || typeof history !== "object") {
        return "";
    }
    const entry = history[toGalleryKey(item.id, item.site)];
    return entry && typeof entry.filename === "string" ? entry.filename : "";
}

/**
 * Counts for the panel's own line. `downloadNow` is what the queue would
 * actually fetch with its default behaviour (skip what history records):
 * selected rows minus the ones already on disk.
 */
export function bookmarkQuerySummary(items: BookmarkItem[], historyKeys: string[]): {
    matched: number;
    alreadyDownloaded: number;
    selected: number;
    downloadNow: number;
} {
    const rows = Array.isArray(items) ? items : [];
    let alreadyDownloaded = 0;
    let selectedCount = 0;
    let downloadNow = 0;
    for (const row of rows) {
        const downloaded = bookmarkIsDownloaded(row, historyKeys);
        if (downloaded) {
            alreadyDownloaded++;
        }
        if (row.selected === true) {
            selectedCount++;
            if (!downloaded) {
                downloadNow++;
            }
        }
    }
    return { matched: rows.length, alreadyDownloaded: alreadyDownloaded, selected: selectedCount, downloadNow: downloadNow };
}

/** The window of rows the panel actually renders right now. */
export function chunkBookmarkRows(items: BookmarkItem[], shown: number, pageSize: number = BOOKMARK_PAGE_SIZE): BookmarkItem[] {
    const rows = Array.isArray(items) ? items : [];
    const size = Number.isFinite(Number(shown)) ? Math.max(0, Math.floor(Number(shown))) : pageSize;
    return rows.slice(0, size);
}

/** What "shown" becomes after one "Show more" click, never past the end. */
export function nextBookmarkChunkSize(shown: number, matched: number, pageSize: number = BOOKMARK_PAGE_SIZE): number {
    const total = Number.isFinite(Number(matched)) ? Math.max(0, Math.floor(Number(matched))) : 0;
    const current = Number.isFinite(Number(shown)) ? Math.max(0, Math.floor(Number(shown))) : 0;
    const size = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0 ? Math.floor(Number(pageSize)) : BOOKMARK_PAGE_SIZE;
    return Math.min(total, current + size);
}
