// Persistent bookmark queue — the "I bookmarked this title" list.
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
//   * Keyed on the gallery id, namespaced by site (siteKeys.ts) since 3.8.0:
//     rows keep their bare site gallery id for metadata resolution, while
//     identity (dedupe, patch, remove, history checks) compares the composite
//     "site:id" key so a second site can never shadow nhentai ids.
//   * The pure helpers below never touch chrome.*. Storage lives in the
//     readBookmarks/writeBookmarks functions at the bottom, so the whole core
//     is unit-testable in Node with no browser.
//   * The service worker is the single writer. The content script and the
//     panel both mutate this list; two independent read-modify-write owners
//     would clobber each other, so every mutation goes through a worker
//     message (see the bookmark* handlers in src/background/background.ts).
//   * Tolerant parsing everywhere: a corrupt or legacy record degrades to an
//     empty list rather than throwing inside the panel.

import { DEFAULT_SITE, toGalleryKey, normalizeSite } from "./siteKeys";

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
    /** Gallery id, in the site's own namespace (bare — never composite). */
    id: string;
    /** Source site slug (siteKeys.ts); "nhentai" until adapters exist. */
    site: string;
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
    /**
     * Tags known at add time (item 68), e.g. "artist:someone". Optional by
     * design: card bookmarks have no metadata, so a row added from a card
     * carries none and only the preview/paste paths can fill it in. The
     * Bookmark tab's search reads them; nothing depends on them being there.
     */
    tags?: string[];
}

export interface BookmarkState {
    v: number;
    items: BookmarkItem[];
    /** The dock: collapsed renders one bar instead of the list. */
    collapsed: boolean;
}

const BOOKMARK_SOURCES: BookmarkSource[] = ["card", "page", "paste", "similar", "auto"];
const BOOKMARK_STATUSES: BookmarkStatus[] = ["saved", "downloading", "done", "failed"];

// Composite identity of a row (siteKeys.ts): "<site>:<id>". Rows keep their
// bare id for metadata resolution; every identity question (dedupe, patch,
// remove, history check) compares composite keys, so ids from different
// sites can never collide once adapters exist.
function itemKey(item: BookmarkItem): string {
    return toGalleryKey(item.id, item.site);
}

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
        // Rows persisted by 3.7.x have no site and read as the default site.
        site: normalizeSite(raw.site),
        title: typeof raw.title === "string" ? raw.title : "",
        thumbnail: typeof raw.thumbnail === "string" ? raw.thumbnail : "",
        pages: Number.isFinite(Number(raw.pages)) && Number(raw.pages) > 0 ? Math.floor(Number(raw.pages)) : 0,
        source: normalizeSource(raw.source),
        sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
        addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : 0,
        selected: !!raw.selected,
        status: normalizeStatus(raw.status),
        error: typeof raw.error === "string" ? raw.error : "",
        filename: typeof raw.filename === "string" ? raw.filename : "",
        tags: normalizeTags(raw.tags)
    };
}

/** Tags are display/search text: keep strings, drop blanks and duplicates. */
function normalizeTags(raw: any): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const tags: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== "string") {
            continue;
        }
        const tag = entry.trim();
        if (tag !== "" && tags.indexOf(tag) === -1) {
            tags.push(tag);
        }
    }
    return tags;
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
            if (item === null || seen.has(itemKey(item))) {
                continue;
            }
            seen.add(itemKey(item));
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
//   https://cin.lat/v/366224                the reference viewer site's url —
//                                          ANY of its mirrors works (cin.mom,
//                                          cin.monster, cin.wiki, cin.wtf, ...):
//                                          the SHAPES are matched, never the
//                                          host, because the site rotates TLDs
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

const COMPOSITE_KEY_RE = /^([a-z0-9_-]+):([0-9]+)$/i;
const NHENTAI_GALLERY_RE = /(?:^|\/|\.)nhentai\.net\/g\/([0-9]+)/i;
const HENTAIERA_RE = /(?:^|\/|\.)hentaiera\.(?:com|to|site)\/(?:gallery|view|g)\/([0-9]+)/i;
const IMHENTAI_RE = /(?:^|\/|\.)imhentai\.(?:xxx|org|net)\/(?:gallery|view)\/([0-9]+)/i;
const HENTAIENVY_RE = /(?:^|\/|\.)hentaienvy\.com\/(?:gallery|g)\/([0-9]+)/i;
const HENTAIFOX_RE = /(?:^|\/|\.)hentaifox\.com\/(?:gallery|g)\/([0-9]+)/i;
const HITOMI_RE = /(?:^|\/|\.)hitomi\.la\/(?:galleries|doujinshi|manga|gamecg|cg|anime|reader)\/(?:.*-)?([0-9]+)(?:\.html)?/i;
const GENERIC_GALLERY_PATH_RE = /\/(?:g|v|gallery|view)\/([0-9]+)/i;
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
        const composite = COMPOSITE_KEY_RE.exec(token);
        if (composite !== null) {
            push(composite[1].toLowerCase() + ":" + composite[2]);
            continue;
        }
        const hitomi = HITOMI_RE.exec(token);
        if (hitomi !== null) {
            push("hitomi:" + hitomi[1]);
            continue;
        }
        const hentaiera = HENTAIERA_RE.exec(token);
        if (hentaiera !== null) {
            push("hentaiera:" + hentaiera[1]);
            continue;
        }
        const imhentai = IMHENTAI_RE.exec(token);
        if (imhentai !== null) {
            push("imhentai:" + imhentai[1]);
            continue;
        }
        const hentaienvy = HENTAIENVY_RE.exec(token);
        if (hentaienvy !== null) {
            push("hentaienvy:" + hentaienvy[1]);
            continue;
        }
        const hentaifox = HENTAIFOX_RE.exec(token);
        if (hentaifox !== null) {
            push("hentaifox:" + hentaifox[1]);
            continue;
        }
        const nhentai = NHENTAI_GALLERY_RE.exec(token);
        if (nhentai !== null) {
            push(nhentai[1]);
            continue;
        }
        const galleryPath = GENERIC_GALLERY_PATH_RE.exec(token) || ID_QUERY_RE.exec(token);
        if (galleryPath !== null) {
            push(galleryPath[1]);
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
    /** Tags known at add time (item 68); optional, "" when there are none. */
    tags?: string[];
    id: string | number;
    /** Source site slug; absent means the default site (siteKeys.ts). */
    site?: string;
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
 * bookmark on a card that already downloaded must not turn a finished row back into a
 * pending one. That is what `duplicates` reports.
 */
export function addBookmarks(state: BookmarkState, candidates: BookmarkCandidate[], now: number = Date.now()): AddResult {
    const items = state.items.slice();
    const known = new Set<string>(items.map(itemKey));
    const added: string[] = [];
    const duplicates: string[] = [];

    for (const candidate of candidates || []) {
        const id = String(candidate === null || candidate === undefined ? "" : candidate.id).trim();
        if (!/^[0-9]+$/.test(id)) {
            continue;
        }
        const key = toGalleryKey(id, candidate.site);
        if (known.has(key)) {
            if (duplicates.indexOf(id) === -1) {
                duplicates.push(id);
            }
            continue;
        }
        known.add(key);
        added.push(id);
        items.unshift({
            id: id,
            site: normalizeSite(candidate.site),
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
            filename: "",
            tags: normalizeTags((candidate as any).tags)
        });
    }

    if (items.length > MAX_BOOKMARK_ITEMS) {
        items.length = MAX_BOOKMARK_ITEMS;
    }
    return { state: { v: state.v, items: items, collapsed: state.collapsed }, added: added, duplicates: duplicates };
}

export function removeBookmarks(state: BookmarkState, ids: Array<string | number>): BookmarkState {
    const drop = new Set<string>((ids || []).map((id) => toGalleryKey(id)));
    if (drop.size === 0) {
        return state;
    }
    return { v: state.v, items: state.items.filter((item) => !drop.has(itemKey(item))), collapsed: state.collapsed };
}

/**
 * Move one bookmark to a new position in the list.
 *
 * The list order IS the download order (`planBookmarkDownload` walks
 * `state.items`), so this is the whole storage side of drag-reorder: no new
 * field, no separate sort key — array order was always the source of truth.
 *
 * `toIndex` is clamped into range; an unknown id or a move that changes
 * nothing returns the SAME state object, so callers can skip a re-render.
 */
export function moveBookmark(state: BookmarkState, id: string | number, toIndex: number): BookmarkState {
    const key = toGalleryKey(id);
    const from = state.items.findIndex((item) => itemKey(item) === key);
    if (from === -1) {
        return state;
    }
    const parsed = Math.floor(Number(toIndex));
    const target = Math.max(0, Math.min(state.items.length - 1, Number.isFinite(parsed) ? parsed : from));
    if (target === from) {
        return state;
    }
    const items = state.items.slice();
    const moved = items.splice(from, 1)[0];
    items.splice(target, 0, moved);
    return { v: state.v, items: items, collapsed: state.collapsed };
}

export function clearBookmarks(state: BookmarkState): BookmarkState {
    return { v: state.v, items: [], collapsed: state.collapsed };
}

export function setBookmarkSelected(state: BookmarkState, ids: Array<string | number>, selected: boolean): BookmarkState {
    const touch = new Set<string>((ids || []).map((id) => toGalleryKey(id)));
    if (touch.size === 0) {
        return state;
    }
    return {
        v: state.v,
        items: state.items.map((item) => touch.has(itemKey(item)) ? Object.assign({}, item, { selected: selected }) : item),
        collapsed: state.collapsed
    };
}

/**
 * Select all / none across the whole list. The panel's per-site filter (item
 * 66) is a VIEW: it never rewrites the list, so a filtered "Select all" sends
 * the visible rows' composite keys through setBookmarkSelected instead of
 * coming here.
 */
export function setAllBookmarksSelected(state: BookmarkState, selected: boolean): BookmarkState {
    return {
        v: state.v,
        items: state.items.map((item) => Object.assign({}, item, { selected: selected })),
        collapsed: state.collapsed
    };
}

// ---- item 66: the per-site filter (a VIEW over the list, never a rewrite) ----

/** The filter value that means "show everything". */
export const SITE_FILTER_ALL = "all";

/**
 * The sites the filter offers, in one canonical order (nhentai first, then the
 * multi-site roster of 3.9.0). Options are permanent: the dropdown never
 * changes shape as rows come and go, so a remembered choice keeps its meaning
 * and a zero-row site can still be selected - and then explains itself.
 */
export function bookmarkFilterSites(): string[] {
    return [DEFAULT_SITE, "hitomi", "hentaiera", "imhentai", "hentaienvy", "hentaifox"];
}

/**
 * Tolerant read of a stored filter value: anything that is not one of the
 * known sites reads as "all", so a corrupt or older value can never blank the
 * list with no way back.
 */
export function normalizeBookmarkSiteFilter(value: any): string {
    if (typeof value !== "string") {
        return SITE_FILTER_ALL;
    }
    const raw = value.trim().toLowerCase();
    if (raw === SITE_FILTER_ALL) {
        return SITE_FILTER_ALL;
    }
    return bookmarkFilterSites().indexOf(raw) !== -1 ? raw : SITE_FILTER_ALL;
}

/**
 * Rows per site, plus the total under SITE_FILTER_ALL. Counts are what the
 * option labels show, and they are computed from the loaded state - no extra
 * storage read, no message.
 */
export function bookmarkSiteCounts(state: BookmarkState): Record<string, number> {
    const counts: Record<string, number> = {};
    counts[SITE_FILTER_ALL] = state.items.length;
    for (const item of state.items) {
        const site = normalizeSite(item.site);
        counts[site] = (counts[site] || 0) + 1;
    }
    return counts;
}

/** The rows a filter shows. Order is preserved: it is the download order. */
export function filterBookmarksBySite(state: BookmarkState, site: string): BookmarkItem[] {
    const wanted = normalizeBookmarkSiteFilter(site);
    if (wanted === SITE_FILTER_ALL) {
        return state.items.slice();
    }
    return state.items.filter((item) => normalizeSite(item.site) === wanted);
}

/**
 * Composite keys of the given rows. Selecting a filtered slice must send
 * keys, not bare ids: a bare id reads as the default site (setBookmarkSelected
 * uses toGalleryKey), so a same-numbered gallery on another site would be the
 * one that got ticked.
 */
export function bookmarkSelectionKeys(items: BookmarkItem[]): string[] {
    return (items || []).map((item) => itemKey(item));
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
    const key = toGalleryKey(id);
    let touched = false;
    const items = state.items.map((item) => {
        if (itemKey(item) !== key) {
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
    const known = historyIds === undefined ? null : new Set<string>(historyIds.map((id) => toGalleryKey(id)));
    let changed = false;
    const items = state.items.map((item) => {
        if (item.status === "downloading") {
            changed = true;
            return Object.assign({}, item, { status: "saved" as BookmarkStatus, error: "" });
        }
        if (item.status === "done" && known !== null && !known.has(itemKey(item))) {
            changed = true;
            return Object.assign({}, item, { status: "saved" as BookmarkStatus, filename: "" });
        }
        return item;
    });
    return changed ? { v: state.v, items: items, collapsed: state.collapsed } : state;
}

// ---- download wiring -----------------------------------------------------

export interface BookmarkDownloadPlan {
    /**
     * Selected ids to send to the pipeline, in list order, bare.
     *
     * Kept for the default-site case and for callers that never see two sites.
     * Once the queue holds rows from more than one site these bare ids are NOT
     * enough to build a job - use `bySite`.
     */
    download: string[];
    /** Selected ids skipped because the history already records them. */
    skip: string[];
    /**
     * id -> display title for every SELECTED row (skipped rows included).
     *
     * This is the flat view kept for the default-site case and for messaging.
     * It is deliberately **not** a ready job payload once rows can be skipped:
     * build each command from `bySite`, whose `titles` cover only the rows that
     * group will actually download.
     */
    titles: Record<string, string>;
    /**
     * The same selection, split into ONE JOB PER SITE (item 48).
     *
     * A job payload may only carry one site (`BatchJobOptions.site`), so a
     * mixed-site selection has to become one downloadAllDoujinshis command per
     * site. Without the split, "123" from two sites would collapse into a
     * single `allDoujinshis` entry, and the pipeline's skip guard would check a
     * hitomi row against the `nhentai:123` history record.
     *
     * Groups appear in first-appearance order, and `download` inside each group
     * keeps list order, so "reorder the list" is still "reorder the batch".
     * `site` is always a real slug (never empty), and the history check for
     * every id in it used `toGalleryKey(id, site)`.
     */
    bySite: BookmarkDownloadGroup[];
}

export interface BookmarkDownloadGroup {
    /** Site slug (siteKeys.ts): every id in this group belongs to it. */
    site: string;
    /** Selected ids of this site that will be downloaded, in list order, bare. */
    download: string[];
    /** Ids of this site already covered by the history. */
    skip: string[];
    /**
     * id -> display title for the ids in `download` only, which is exactly the
     * `allDoujinshis` payload for this site's job. Skipped rows are absent, so
     * an empty object means "do not send a job for this site".
     */
    titles: Record<string, string>;
}

/**
 * Split the selection into what downloads and what the history already covers,
 * reusing the same skip rule as the listing pages (downloadHistory.partitionKnown).
 * Order is list order, so "reorder the list" is also "reorder the batch".
 */
export function planBookmarkDownload(state: BookmarkState, historyIds: Array<string | number>, redownloadIds: Array<string | number> = []): BookmarkDownloadPlan {
    const recorded = new Set<string>((historyIds || []).map((id) => toGalleryKey(id)));
    const forced = new Set<string>((redownloadIds || []).map((id) => toGalleryKey(id)));
    const plan: BookmarkDownloadPlan = { download: [], skip: [], titles: {}, bySite: [] };
    const groups = new Map<string, BookmarkDownloadGroup>();
    const groupFor = (site: string): BookmarkDownloadGroup => {
        let group = groups.get(site);
        if (!group) {
            group = { site: site, download: [], skip: [], titles: {} };
            groups.set(site, group);
            plan.bySite.push(group);
        }
        return group;
    };
    for (const item of state.items) {
        if (!item.selected) {
            continue;
        }
        // A title the row never learned is still traceable by its id.
        plan.titles[item.id] = item.title !== "" ? item.title : item.id;
        // The row's own site decides its group: a row added from a gallery page
        // carries it, and a legacy row without one is the default site.
        const site = normalizeSite(item.site);
        const group = groupFor(site);
        if (recorded.has(itemKey(item)) && !forced.has(itemKey(item))) {
            plan.skip.push(item.id);
            group.skip.push(item.id);
        } else {
            plan.download.push(item.id);
            group.download.push(item.id);
            // A group's titles cover exactly the rows it will download, so the
            // group IS a ready job payload - the skipped rows must not travel
            // in it, or a "nothing left for this site" group would still send
            // a command.
            group.titles[item.id] = item.title !== "" ? item.title : item.id;
        }
    }
    return plan;
}

/**
 * Label / tooltip / class for a bookmark toggle button, so every surface that
 * offers the toggle (panel preview, similar-gallery rows, and any future
 * consumer) shows the same words and the same on-state class.
 */
export function bookmarkTogglePresentation(on: boolean): { label: string; title: string; className: string } {
    return {
        label: on ? "Bookmarked" : "Bookmark",
        title: on
            ? "On the bookmark queue - click to take it off again (nothing is un-downloaded)"
            : "Add this title to the persistent bookmark queue (Bookmark tab). It survives a browser restart.",
        className: on ? "nhdwBookmarkToggle nhdwBookmarkOn" : "nhdwBookmarkToggle"
    };
}

export function countBookmarks(state: BookmarkState): number {
    return state.items.length;
}

export function countSelectedBookmarks(state: BookmarkState): number {
    return state.items.filter((item) => item.selected).length;
}

export function findBookmark(state: BookmarkState, id: string | number): BookmarkItem | null {
    const key = toGalleryKey(id);
    for (const item of state.items) {
        if (itemKey(item) === key) {
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
