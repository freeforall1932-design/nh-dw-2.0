// Persistent bookmark queue — the "I clicked ☆ on this title" list.
//
// Why this exists separately from the download job queue:
//   * The job queue lives in the offscreen document (`queuedJobs`,
//     src/offscreen/offscreen.ts) and is memory-only: it dies with the worker
//     and is surfaced as a count. It means WORK IN FLIGHT.
//   * This list means INTENT. It outlives the browser, the machine and the
//     extension's service worker, and it is what the user asked to see again
//     after a restart.
// A bookmark row FEEDS the existing download pipeline (downloadAllDoujinshis);
// it never replaces it.
//
// Design rules (mirroring src/utils/downloadHistory.ts, which this module is
// deliberately shaped after):
//   * chrome.storage.local — never sync. A queue carries titles and thumbnail
//     URLs; sync is capped at ~100 KB / 512 items and would silently truncate.
//   * Keyed on the GALLERY ID. Titles change with templates and language
//     edits; the id does not.
//   * The pure helpers below never touch chrome.*. Storage lives in the
//     readBookmarks/writeBookmarks functions at the bottom, so the whole core
//     is unit-testable in Node with no browser.
//   * The service worker is the single writer. The content script and the
//     panel both mutate this list; two independent read-modify-write owners
//     would clobber each other, so every mutation goes through a worker
//     message (see the bookmark* handlers in src/background/background.ts).
//   * Tolerant parsing everywhere: a corrupt or legacy record degrades to an
//     empty list rather than throwing inside the panel.

export const BOOKMARK_QUEUE_KEY = "bookmarkQueue";
export const BOOKMARK_QUEUE_VERSION = 1;

/** Hard cap on the list itself. A bookmark list is a working set, not an archive. */
export const MAX_BOOKMARK_ITEMS = 2000;
/** Hard cap on ids produced by one "a-b" range, so a typo cannot build a monster. */
export const MAX_PASTE_RANGE = 200;
/** Hard cap on ids accepted from one paste, whatever the input shape. */
export const MAX_PASTE_IDS = 500;

export type BookmarkSource = "card" | "page" | "paste" | "similar" | "auto";
export type BookmarkStatus = "saved" | "downloading" | "done" | "failed";

export interface BookmarkItem {
    /** Gallery id. The only identity that matters. */
    id: string;
    /** Best title known at add time; "" for a freshly pasted id. */
    title: string;
    /** Absolute cover-thumbnail URL for the row's UI, "" when unknown. */
    thumbnail: string;
    /** Page count, 0 when unknown. */
    pages: number;
    /** How the row got here, so the UI can explain it. */
    source: BookmarkSource;
    /** Listing page it was captured from, "" for paste / manual page. */
    sourceUrl: string;
    /** Milliseconds since epoch. */
    addedAt: number;
    selected: boolean;
    status: BookmarkStatus;
    /** Last failure reason, kept because it is the useful part of a failure. */
    error: string;
    /** Artifact name from the download history once the row completed. */
    filename: string;
}

export interface BookmarkState {
    v: number;
    items: BookmarkItem[];
    /** The dock: collapsed renders one bar instead of the list. */
    collapsed: boolean;
}

const BOOKMARK_SOURCES: BookmarkSource[] = ["card", "page", "paste", "similar", "auto"];
const BOOKMARK_STATUSES: BookmarkStatus[] = ["saved", "downloading", "done", "failed"];

export function emptyBookmarkState(): BookmarkState {
    return { v: BOOKMARK_QUEUE_VERSION, items: [], collapsed: false };
}

function normalizeSource(raw: any): BookmarkSource {
    return BOOKMARK_SOURCES.indexOf(raw) !== -1 ? raw as BookmarkSource : "card";
}

function normalizeStatus(raw: any): BookmarkStatus {
    return BOOKMARK_STATUSES.indexOf(raw) !== -1 ? raw as BookmarkStatus : "saved";
}

function normalizeItem(raw: any): BookmarkItem | null {
    if (raw === null || typeof raw !== "object") {
        return null;
    }
    // An entry without a numeric id is not a bookmark; drop it rather than
    // rendering an un-downloadable row.
    const id = String(raw.id === undefined || raw.id === null ? "" : raw.id).trim();
    if (!/^[0-9]+$/.test(id)) {
        return null;
    }
    return {
        id: id,
        title: typeof raw.title === "string" ? raw.title : "",
        thumbnail: typeof raw.thumbnail === "string" ? raw.thumbnail : "",
        pages: Number.isFinite(Number(raw.pages)) && Number(raw.pages) > 0 ? Math.floor(Number(raw.pages)) : 0,
        source: normalizeSource(raw.source),
        sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
        addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : 0,
        selected: !!raw.selected,
        status: normalizeStatus(raw.status),
        error: typeof raw.error === "string" ? raw.error : "",
        filename: typeof raw.filename === "string" ? raw.filename : ""
    };
}

/**
 * Tolerant parse of whatever is in storage. Accepts the current shape, an
 * array-shaped legacy record, and garbage — all of which yield a usable state.
 */
export function normalizeBookmarkState(raw: any): BookmarkState {
    const state = emptyBookmarkState();
    if (raw === null || typeof raw !== "object") {
        return state;
    }
    const rawItems = Array.isArray(raw) ? raw : raw.items;
    if (Array.isArray(rawItems)) {
        const seen = new Set<string>();
        for (const entry of rawItems) {
            const item = normalizeItem(entry);
            if (item === null || seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);
            state.items.push(item);
        }
    }
    if (!Array.isArray(raw) && typeof raw.collapsed === "boolean") {
        state.collapsed = raw.collapsed;
    }
    if (state.items.length > MAX_BOOKMARK_ITEMS) {
        state.items = state.items.slice(0, MAX_BOOKMARK_ITEMS);
    }
    return state;
}

// ---- paste parsing -------------------------------------------------------
//
// Accepts, mixed freely and separated by commas, spaces, newlines, semicolons
// or pipes:
//   366224                                  bare id
//   https://nhentai.net/g/366224/           gallery url (also /g/366224/1/)
//   /g/366224/                              path-only gallery url
//   https://cin.lat/v/366224                the reference site's viewer url
//   https://cin.lat/bulk?id=366224,177013   the reference site's bulk url
//   366220-366224                           inclusive range (capped)
// The parse is pure: no fetch, no DOM, so it is unit-tested without a browser.

export interface ParsedGalleryInput {
    /** Unique ids, in the order first typed. */
    ids: string[];
    /** Tokens that could not be read, echoed back so the UI can name them. */
    rejected: string[];
    /** True when a range or the id cap truncated the result. */
    truncated: boolean;
}

const NHENTAI_GALLERY_RE = /\/g\/([0-9]+)/i;
const VIEWER_GALLERY_RE = /\/v\/([0-9]+)/i;
const ID_QUERY_RE = /[?&]id=([0-9]+)/i;
const RANGE_RE = /^([0-9]+)\s*-\s*([0-9]+)$/;
const BARE_ID_RE = /^[0-9]+$/;

export function parseGalleryInput(text: string, rangeLimit: number = MAX_PASTE_RANGE): ParsedGalleryInput {
    const ids: string[] = [];
    const rejected: string[] = [];
    const seen = new Set<string>();
    let truncated = false;

    const push = (id: string) => {
        if (seen.has(id)) {
            return;
        }
        if (ids.length >= MAX_PASTE_IDS) {
            truncated = true;
            return;
        }
        seen.add(id);
        ids.push(id);
    };

    const tokens = String(text === undefined || text === null ? "" : text)
        .split(/[\s,;|]+/)
        .map((token) => token.replace(/^["'[(<]+|["'\])>.]+$/g, ""))
        .filter((token) => token !== "");

    for (const token of tokens) {
        const gallery = NHENTAI_GALLERY_RE.exec(token) || VIEWER_GALLERY_RE.exec(token) || ID_QUERY_RE.exec(token);
        if (gallery !== null) {
            push(gallery[1]);
            continue;
        }
        if (BARE_ID_RE.test(token)) {
            push(token);
            continue;
        }
        const range = RANGE_RE.exec(token);
        if (range !== null) {
            const from = parseInt(range[1], 10);
            const to = parseInt(range[2], 10);
            if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
                rejected.push(token);
                continue;
            }
            const limit = Math.min(to, from + Math.max(0, rangeLimit) - 1);
            if (limit < to) {
                truncated = true;
            }
            for (let id = from; id <= limit; id++) {
                push(String(id));
            }
            continue;
        }
        rejected.push(token);
    }

    return { ids: ids, rejected: rejected, truncated: truncated };
}

// ---- thumbnails ----------------------------------------------------------

// Reverse of extensionToTypeCode() in src/parsing/GalleryEmbed.ts, which maps
// a file extension to the one-letter code nhentai's legacy schema uses.
function typeCodeToExtension(code: any): string {
    switch (String(code === undefined || code === null ? "" : code).toLowerCase()) {
        case "j": return "jpg";
        case "p": return "png";
        case "g": return "gif";
        case "w": return "webp";
        default: return "";
    }
}

/**
 * Cover thumbnail for a resolved gallery, or "" when it cannot be built.
 * Display-only: t.nhentai.net is a thumbnail host and is never part of the
 * download path. An <img> in an extension page needs no host permission, so
 * this stays out of host_permissions on purpose.
 */
export function thumbnailUrlFromGallery(gallery: any): string {
    if (gallery === null || typeof gallery !== "object") {
        return "";
    }
    const mediaId = String(gallery.media_id === undefined || gallery.media_id === null ? "" : gallery.media_id).trim();
    if (mediaId === "" || !/^[0-9]+$/.test(mediaId)) {
        return "";
    }
    const images = gallery.images;
    const cover = images && typeof images === "object" ? images.thumbnail || images.cover : null;
    const extension = typeCodeToExtension(cover && cover.t);
    if (extension === "") {
        return "";
    }
    return "https://t.nhentai.net/galleries/" + encodeURIComponent(mediaId) + "/thumb." + extension;
}

/** Best display title from a resolved gallery, falling back to the id. */
export function titleFromGallery(gallery: any, id: string): string {
    const fallback = "(Non-titled) " + id;
    if (gallery === null || typeof gallery !== "object" || !gallery.title) {
        return fallback;
    }
    const title = gallery.title;
    const pretty = String(title.pretty || "").trim();
    if (pretty !== "") {
        return pretty;
    }
    const english = String(title.english || "").trim();
    if (english !== "") {
        return english;
    }
    const japanese = String(title.japanese || "").trim();
    return japanese !== "" ? japanese : fallback;
}

/** Page count from a resolved gallery, 0 when unknown. */
export function pagesFromGallery(gallery: any): number {
    if (gallery === null || typeof gallery !== "object") {
        return 0;
    }
    const direct = Number(gallery.num_pages);
    if (Number.isFinite(direct) && direct > 0) {
        return Math.floor(direct);
    }
    const pages = gallery.images && Array.isArray(gallery.images.pages) ? gallery.images.pages.length : 0;
    return pages > 0 ? pages : 0;
}

// ---- mutations (all pure: they return a new state) -----------------------

export interface BookmarkCandidate {
    id: string | number;
    title?: string;
    thumbnail?: string;
    pages?: number;
    source?: BookmarkSource;
    sourceUrl?: string;
}

export interface AddResult {
    state: BookmarkState;
    /** Ids that were not already in the list. */
    added: string[];
    /** Ids already present — their row is kept as-is, never downgraded. */
    duplicates: string[];
}

/**
 * Add bookmarks. Newest first, like the Twitter queue's unshift.
 *
 * An id that is already bookmarked is NOT re-added and NOT reset: re-clicking
 * ☆ on a card that already downloaded must not turn a finished row back into a
 * pending one. That is what `duplicates` reports.
 */
export function addBookmarks(state: BookmarkState, candidates: BookmarkCandidate[], now: number = Date.now()): AddResult {
    const items = state.items.slice();
    const known = new Set<string>(items.map((item) => item.id));
    const added: string[] = [];
    const duplicates: string[] = [];

    for (const candidate of candidates || []) {
        const id = String(candidate === null || candidate === undefined ? "" : candidate.id).trim();
        if (!/^[0-9]+$/.test(id)) {
            continue;
        }
        if (known.has(id)) {
            if (duplicates.indexOf(id) === -1) {
                duplicates.push(id);
            }
            continue;
        }
        known.add(id);
        added.push(id);
        items.unshift({
            id: id,
            title: typeof candidate.title === "string" ? candidate.title : "",
            thumbnail: typeof candidate.thumbnail === "string" ? candidate.thumbnail : "",
            pages: Number.isFinite(Number(candidate.pages)) && Number(candidate.pages) > 0 ? Math.floor(Number(candidate.pages)) : 0,
            source: normalizeSource(candidate.source),
            sourceUrl: typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : "",
            addedAt: now,
            // Newly bookmarked rows start ticked: the common next action is
            // "download what I just collected", and an unticked row is a click
            // the user did not ask for.
            selected: true,
            status: "saved",
            error: "",
            filename: ""
        });
    }

    if (items.length > MAX_BOOKMARK_ITEMS) {
        items.length = MAX_BOOKMARK_ITEMS;
    }
    return { state: { v: state.v, items: items, collapsed: state.collapsed }, added: added, duplicates: duplicates };
}

export function removeBookmarks(state: BookmarkState, ids: Array<string | number>): BookmarkState {
    const drop = new Set<string>((ids || []).map((id) => String(id)));
    if (drop.size === 0) {
        return state;
    }
    return { v: state.v, items: state.items.filter((item) => !drop.has(item.id)), collapsed: state.collapsed };
}

export function clearBookmarks(state: BookmarkState): BookmarkState {
    return { v: state.v, items: [], collapsed: state.collapsed };
}

export function setBookmarkSelected(state: BookmarkState, ids: Array<string | number>, selected: boolean): BookmarkState {
    const touch = new Set<string>((ids || []).map((id) => String(id)));
    if (touch.size === 0) {
        return state;
    }
    return {
        v: state.v,
        items: state.items.map((item) => touch.has(item.id) ? Object.assign({}, item, { selected: selected }) : item),
        collapsed: state.collapsed
    };
}

/** Select all / none across the whole list (the list has no filter of its own). */
export function setAllBookmarksSelected(state: BookmarkState, selected: boolean): BookmarkState {
    return {
        v: state.v,
        items: state.items.map((item) => Object.assign({}, item, { selected: selected })),
        collapsed: state.collapsed
    };
}

export function setBookmarksCollapsed(state: BookmarkState, collapsed: boolean): BookmarkState {
    return { v: state.v, items: state.items, collapsed: !!collapsed };
}

export interface StatusPatch {
    status?: BookmarkStatus;
    error?: string;
    filename?: string;
    title?: string;
    thumbnail?: string;
    pages?: number;
}

/** Update one row. Unknown ids are ignored rather than creating a ghost row. */
export function patchBookmark(state: BookmarkState, id: string | number, patch: StatusPatch): BookmarkState {
    const key = String(id);
    let touched = false;
    const items = state.items.map((item) => {
        if (item.id !== key) {
            return item;
        }
        touched = true;
        const next = Object.assign({}, item);
        if (patch.status !== undefined) {
            next.status = normalizeStatus(patch.status);
        }
        if (patch.error !== undefined) {
            next.error = String(patch.error);
        }
        if (patch.filename !== undefined) {
            next.filename = String(patch.filename);
        }
        if (patch.title !== undefined && String(patch.title).trim() !== "") {
            next.title = String(patch.title);
        }
        if (patch.thumbnail !== undefined && String(patch.thumbnail) !== "") {
            next.thumbnail = String(patch.thumbnail);
        }
        if (patch.pages !== undefined && Number(patch.pages) > 0) {
            next.pages = Math.floor(Number(patch.pages));
        }
        // A row that starts downloading is no longer "failed".
        if (next.status !== "failed") {
            next.error = "";
        }
        return next;
    });
    return touched ? { v: state.v, items: items, collapsed: state.collapsed } : state;
}

// ---- restart reconciliation (requirement: survives a PC restart) ---------

/**
 * Make a list read back from storage honest about what is actually running.
 *
 * The offscreen document that executes downloads is gone after a restart, so a
 * row persisted as "downloading" is not downloading anything — leaving it would
 * strand the row forever. This mirrors reconcileQueueAfterRestart() in the
 * sibling Twitter repo, which returns "starting" items to "queued" for exactly
 * this reason.
 *
 * `historyIds` is the set of ids the download history still records. A row
 * marked done whose record was cleared drops back to saved, so the list never
 * claims a download the extension no longer believes in.
 */
export function reconcileBookmarksAfterRestart(state: BookmarkState, historyIds?: string[]): BookmarkState {
    const known = historyIds === undefined ? null : new Set<string>(historyIds.map((id) => String(id)));
    let changed = false;
    const items = state.items.map((item) => {
        if (item.status === "downloading") {
            changed = true;
            return Object.assign({}, item, { status: "saved" as BookmarkStatus, error: "" });
        }
        if (item.status === "done" && known !== null && !known.has(item.id)) {
            changed = true;
            return Object.assign({}, item, { status: "saved" as BookmarkStatus, filename: "" });
        }
        return item;
    });
    return changed ? { v: state.v, items: items, collapsed: state.collapsed } : state;
}

// ---- download wiring -----------------------------------------------------

export interface BookmarkDownloadPlan {
    /** Selected ids to send to the pipeline, in list order. */
    download: string[];
    /** Selected ids skipped because the history already records them. */
    skip: string[];
    /** id -> display title, the shape downloadAllDoujinshis expects. */
    titles: Record<string, string>;
}

/**
 * Split the selection into what downloads and what the history already covers,
 * reusing the same skip rule as the listing pages (downloadHistory.partitionKnown).
 * Order is list order, so "reorder the list" is also "reorder the batch".
 */
export function planBookmarkDownload(state: BookmarkState, historyIds: Array<string | number>, redownloadIds: Array<string | number> = []): BookmarkDownloadPlan {
    const recorded = new Set<string>((historyIds || []).map((id) => String(id)));
    const forced = new Set<string>((redownloadIds || []).map((id) => String(id)));
    const plan: BookmarkDownloadPlan = { download: [], skip: [], titles: {} };
    for (const item of state.items) {
        if (!item.selected) {
            continue;
        }
        // A title the row never learned is still traceable by its id.
        plan.titles[item.id] = item.title !== "" ? item.title : item.id;
        if (recorded.has(item.id) && !forced.has(item.id)) {
            plan.skip.push(item.id);
        } else {
            plan.download.push(item.id);
        }
    }
    return plan;
}

export function countBookmarks(state: BookmarkState): number {
    return state.items.length;
}

export function countSelectedBookmarks(state: BookmarkState): number {
    return state.items.filter((item) => item.selected).length;
}

export function findBookmark(state: BookmarkState, id: string | number): BookmarkItem | null {
    const key = String(id);
    for (const item of state.items) {
        if (item.id === key) {
            return item;
        }
    }
    return null;
}

// ---- storage (worker / panel / content-script contexts only) -------------

export function readBookmarks(): Promise<BookmarkState> {
    return new Promise((resolve) => {
        const done = (state: BookmarkState) => resolve(state);
        try {
            const defaults: any = {};
            defaults[BOOKMARK_QUEUE_KEY] = null;
            chrome.storage.local.get(defaults, (elems: any) => {
                done(normalizeBookmarkState(elems && elems[BOOKMARK_QUEUE_KEY]));
            });
        } catch (_) {
            done(emptyBookmarkState());
        }
    });
}

// Serialize read-modify-write. Two overlapping mutations (a content-script
// bookmark landing while the panel removes a row) must not clobber each other.
// Best-effort: a storage failure must never break a download.
let bookmarkWriteChain: Promise<BookmarkState> = Promise.resolve(emptyBookmarkState());

export function mutateBookmarks(mutator: (state: BookmarkState) => BookmarkState): Promise<BookmarkState> {
    bookmarkWriteChain = bookmarkWriteChain
        .then(() => readBookmarks())
        .then((state) => {
            const next = mutator(state) || state;
            return writeBookmarkState(next).then(() => next);
        })
        .catch(() => emptyBookmarkState());
    return bookmarkWriteChain;
}

function writeBookmarkState(state: BookmarkState): Promise<void> {
    return new Promise((resolve) => {
        try {
            const patch: any = {};
            patch[BOOKMARK_QUEUE_KEY] = state;
            chrome.storage.local.set(patch, () => {
                try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                resolve();
            });
        } catch (_) {
            resolve();
        }
    });
}

export function writeBookmarks(state: BookmarkState): Promise<void> {
    return writeBookmarkState(state);
}

export function clearBookmarkStorage(): Promise<void> {
    const clear = bookmarkWriteChain.then(() => new Promise<void>((resolve) => {
        try {
            chrome.storage.local.remove(BOOKMARK_QUEUE_KEY, () => {
                try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                resolve();
            });
        } catch (_) {
            resolve();
        }
    })).catch(() => { /* best effort */ });
    bookmarkWriteChain = clear.then(() => emptyBookmarkState());
    return clear;
}

/** Test hook: drop the in-memory write chain between test cases. */
export function resetBookmarkWriteChainForTests(): void {
    bookmarkWriteChain = Promise.resolve(emptyBookmarkState());
}
