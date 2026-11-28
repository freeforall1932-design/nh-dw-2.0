// Library tab (INDEXER_PLAN.md §5, Phase 1): a full-tab dashboard opened with
// chrome.tabs.create, same pattern as chapters.html. Five rail sections —
// Browse (the offline index), Bookmarks, History, Queue, Settings.
//
// Phase 1 scope: shell + Mihon-style rail + index import (§2 format, OPFS
// storage) + grid/list Browse with tag-chip AND filtering on bundled sample
// data. Bookmarks/History/Queue are stubs that move out of the panel later
// (§4); Send-to-queue is disabled until Phase 3.
//
// DOM discipline: every value from an imported index reaches the page via
// createElement + textContent — an imported file is untrusted input, never
// innerHTML.

import {
    GalleryRow,
    IndexFormatError,
    IndexMeta,
    IndexTag,
    ParsedIndex,
    TAG_NAMESPACES,
    namespaceLabel,
    parseIndexText,
    ROW,
    serializeIndex,
    TagNamespace,
} from "./indexFormat";
import {
    InvertedIndex,
    SortMode,
    buildInvertedIndex,
    countByTag,
    filterRows,
    sortRowPositions,
} from "./invertedIndex";
import { buildSampleIndex } from "./sampleIndex";
import { deleteIndexFile, libraryUsageEstimate, loadAllIndexes, saveIndexFile } from "./libraryStore";
import { composeGalleryKey } from "../utils/siteKeys";
import { clearVisits, countVisits, listVisits, VisitedEntry } from "../utils/visitedLog";
import { DOWNLOAD_HISTORY_KEY } from "../utils/downloadHistory";
import type { BookmarkCandidate } from "../utils/bookmarkQueue";
import { candidateFromGalleryRow, chunkArray, SEND_CHUNK } from "./sendQueue";
import { WATCHES_STORAGE, Watch, createWatch, sanitizeWatchList } from "./watches";
import { refreshWatch } from "./watchRefresh";
import { API_KEY_STORAGE } from "../utils/apiAuth";
import { BYPASS_SAVE_AS_STORAGE } from "../background/downloadControl";
import { CACHE_CAP_STORAGE, DEFAULT_CACHE_MB, normalizeThumbMode, THUMB_MODE_STORAGE, ThumbMode } from "./thumbLru";
import {
    cacheStats,
    clearThumbCache,
    ensureCachedThumb,
    getThumbCapBytes,
    getThumbMode,
    hostGrantHint,
    pruneToCap,
    resolveCachedThumb,
    setThumbCapMb,
    setThumbMode,
} from "./thumbCache";

// ---------------------------------------------------------------- state

const WINDOW_STEP = 200; // same windowed rendering as the panel bookmark list
const VISITED_WINDOW = 200; // History rows per window (same pattern)

interface SourceState {
    meta: IndexMeta;
    tags: Map<number, IndexTag>;
    rows: GalleryRow[];
    inverted: InvertedIndex;
    counts: Map<number, number>;
    /** Tag ids ticked in the sidebar for this source (AND semantics). */
    activeChips: Set<number>;
    isSample: boolean;
}

let sources: SourceState[] = [];
let viewMode: "grid" | "list" = "grid";
let sortMode: SortMode = "newest";
let titleQuery = "";
let sourceFilter = ""; // "" = all sources, else a source slug
let shownCount = 0;
let avgMbPerPage = 45;
let sendingQueue = false; // one Send-to-queue run at a time (§8.9 chunked writes)
let thumbMode: ThumbMode = "cached"; // thumbnail source choice (loaded at boot)
let watches: Watch[] = []; // §6 saved tag combinations (storage-glued below)
let refreshBusy = false; // one watch refresh at a time — sequential by design
const watchDraft = { site: "", tagIds: new Set<number>() }; // Settings watch builder
const selection = new Set<string>(); // composite keys, siteKeys.ts convention

function $(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error("library.html is missing #" + id);
    return el;
}

// ------------------------------------------------------------- helpers

function buildSourceState(parsed: ParsedIndex, isSample: boolean): SourceState {
    const inverted = buildInvertedIndex(parsed.rows);
    return {
        meta: parsed.meta,
        tags: parsed.tags,
        rows: parsed.rows,
        inverted,
        counts: countByTag(inverted),
        activeChips: new Set<number>(),
        isSample,
    };
}

function totalRows(): number {
    let total = 0;
    for (const source of sources) total += source.rows.length;
    return total;
}

function formatDate(unix: number): string {
    const d = new Date(unix * 1000);
    return Number.isFinite(unix) && unix > 0 ? d.toISOString().slice(0, 10) : "—";
}

function formatSize(pages: number): string {
    const mb = pages * avgMbPerPage;
    if (mb >= 1024) return "≈ " + (mb / 1024).toFixed(1) + " GB";
    return "≈ " + Math.round(mb) + " MB";
}

/** Tier-3 thumbs are derived per source, never stored (INDEXER_PLAN.md §2). */
function coverUrl(site: string, mediaId: string, thumbExt?: string): string | null {
    if (site === "nhentai" && mediaId) {
        return "https://t.nhentai.net/galleries/" + mediaId + "/thumb." + (thumbExt || "jpg");
    }
    return null; // "sample" and future sources render the placeholder card
}

function placeholderInitials(title: string): string {
    const words = title.replace(/\[.*?\]/g, "").trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return "·";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

/** §8.8 thumb cache: best-effort background fetch+store for next time. A
    failed fetch (host not granted, offline) changes nothing on screen. */
function queueThumbCache(url: string): void {
    void ensureCachedThumb(url).catch(() => { /* best-effort, never load-bearing */ });
}

/** Thumbnail source wiring (cache-first): in "cached" mode a hit serves the
    OPFS object URL directly — instant, and works with no internet; a miss
    loads live once and queues the background cache. In "live" mode every
    cover comes from the site and the cache is neither read nor written. */
function wireThumbSource(img: HTMLImageElement, url: string): void {
    if (thumbMode === "live") {
        img.src = url;
        return;
    }
    void (async () => {
        let objectUrl: string | null = null;
        try {
            objectUrl = await resolveCachedThumb(url);
        } catch (_) {
            objectUrl = null;
        }
        if (!img.isConnected) return;
        if (objectUrl) {
            img.src = objectUrl;
            return;
        }
        img.src = url;
        queueThumbCache(url);
    })();
}

// ------------------------------------------------------------- view model

interface RowRef {
    sourceIdx: number;
    rowIdx: number;
}

function computeView(): RowRef[] {
    const words = titleQuery.toLowerCase().split(/\s+/).filter((w) => w !== "");
    const refs: RowRef[] = [];
    sources.forEach((source, sourceIdx) => {
        if (sourceFilter !== "" && source.meta.site !== sourceFilter) return;
        const positions = filterRows(source.rows, source.inverted, {
            tagIds: Array.from(source.activeChips),
            titleWords: words,
        });
        sortRowPositions(positions, source.rows, sortMode);
        for (const rowIdx of positions) refs.push({ sourceIdx, rowIdx });
    });
    if (sortMode !== "title") return refs;
    // Cross-source title sort: merge the per-source runs. Rows stay tuples.
    return refs.sort((a, b) => {
        const ra = sources[a.sourceIdx].rows[a.rowIdx];
        const rb = sources[b.sourceIdx].rows[b.rowIdx];
        return ra[ROW.TITLE].localeCompare(rb[ROW.TITLE]);
    });
}

// ------------------------------------------------------------- rendering

function renderNotice(): void {
    const notice = $("libraryNotice");
    const sample = sources.some((s) => s.isSample);
    if (sample) {
        notice.textContent = "Showing the bundled sample library so the controls can be tried — import a real index file in Settings whenever one exists.";
        notice.classList.add("notice");
        notice.classList.remove("hint");
    } else {
        const parts = sources.map((s) => s.meta.site + " (" + s.rows.length.toLocaleString() + " titles)");
        notice.textContent = "Loaded " + parts.join(", ");
        notice.classList.remove("notice");
        notice.classList.add("hint");
    }
}

function renderChips(): void {
    const sidebar = $("chipSidebar");
    sidebar.textContent = "";
    sources.forEach((source, sourceIdx) => {
        const head = document.createElement("h3");
        head.textContent = source.meta.site + (source.isSample ? " · sample" : "");
        sidebar.appendChild(head);
        for (const ns of TAG_NAMESPACES) {
            const tagIds = Array.from(source.tags.keys()).filter((id) => source.tags.get(id)!.ns === ns);
            if (tagIds.length === 0) continue;
            const groupTitle = document.createElement("p");
            groupTitle.className = "chipGroupTitle";
            groupTitle.textContent = namespaceLabel(ns as TagNamespace);
            sidebar.appendChild(groupTitle);
            tagIds.sort((a, b) => source.tags.get(a)!.n.localeCompare(source.tags.get(b)!.n));
            for (const tagId of tagIds) {
                const tag = source.tags.get(tagId)!;
                const chip = document.createElement("button");
                chip.type = "button";
                chip.className = "chip" + (source.activeChips.has(tagId) ? " chipOn" : "");
                chip.textContent = tag.n + " · " + (source.counts.get(tagId) || 0).toLocaleString();
                chip.title = "Filter this source by " + tag.n + " (click again to clear)";
                chip.addEventListener("click", () => {
                    if (source.activeChips.has(tagId)) source.activeChips.delete(tagId);
                    else source.activeChips.add(tagId);
                    renderChips();
                    renderResults();
                });
                sidebar.appendChild(chip);
            }
        }
    });
    if (sidebar.children.length === 0) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No tags — the loaded index carries none.";
        sidebar.appendChild(empty);
    }
}

function coverElement(site: string, mediaId: string, thumbExt: string | undefined, title: string, small: boolean): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = (small ? "coverSmall" : "cover") + " coverBox";
    const url = coverUrl(site, mediaId, thumbExt);
    if (url) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.alt = "";
        img.addEventListener("load", () => wrap.classList.add("coverLoaded"));
        img.addEventListener("error", () => {
            img.remove();
            wrap.dataset.fallback = "1";
            wrap.textContent = placeholderInitials(title);
        });
        wireThumbSource(img, url);
        wrap.appendChild(img);
        const initials = document.createElement("span");
        initials.textContent = placeholderInitials(title);
        initials.setAttribute("aria-hidden", "true");
        wrap.appendChild(initials);
        return wrap;
    }
    wrap.textContent = placeholderInitials(title);
    return wrap;
}

function tagChipRow(source: SourceState, row: GalleryRow, max: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "rowTags";
    const tagIds = row[ROW.TAG_IDS].slice(0, max);
    for (const tagId of tagIds) {
        const tag = source.tags.get(tagId);
        if (!tag) continue;
        const chip = document.createElement("span");
        chip.className = "miniChip";
        chip.textContent = tag.n;
        wrap.appendChild(chip);
    }
    return wrap;
}

function rowKey(source: SourceState, row: GalleryRow): string {
    return composeGalleryKey(source.meta.site, row[ROW.ID]);
}

function renderResults(): void {
    const newKeys = new Set<string>();
    for (const watch of watches) {
        for (const key of watch.newKeys) newKeys.add(key);
    }
    const refs = computeView();
    const meta = $("resultsMeta");
    meta.textContent = refs.length === 0
        ? "Nothing matches the current filters."
        : "Showing " + Math.min(shownCount, refs.length).toLocaleString() + " of " + refs.length.toLocaleString() + " titles";
    const list = $("results");
    list.textContent = "";
    list.className = viewMode === "grid" ? "cardGrid" : "rowsList";

    const window_ = refs.slice(0, shownCount);
    for (const ref of window_) {
        const source = sources[ref.sourceIdx];
        const row = source.rows[ref.rowIdx];
        const key = rowKey(source, row);
        const card = document.createElement("div");
        card.className = viewMode === "grid" ? "card" : "row";

        const select = document.createElement("input");
        select.type = "checkbox";
        select.className = "rowSelect";
        select.checked = selection.has(key);
        select.setAttribute("aria-label", "Select " + row[ROW.TITLE]);
        select.addEventListener("change", () => {
            if (select.checked) selection.add(key);
            else selection.delete(key);
            renderSelectionBar();
        });
        card.appendChild(select);

        card.appendChild(coverElement(source.meta.site, row[ROW.MEDIA_ID], row[ROW.THUMB_EXT], row[ROW.TITLE], viewMode === "list"));

        const body = document.createElement("div");
        body.className = viewMode === "grid" ? "cardBody" : "rowBody";
        const title = document.createElement("p");
        title.className = viewMode === "grid" ? "cardTitle" : "rowTitle";
        title.textContent = row[ROW.TITLE];
        body.appendChild(title);
        if (newKeys.has(key)) {
            const badge = document.createElement("span");
            badge.className = "newChip";
            badge.textContent = "NEW";
            badge.title = "New since the last " + (watches.find((w) => w.newKeys.indexOf(key) !== -1) || { label: "watch" }).label + " refresh";
            body.appendChild(badge);
        }
        if (viewMode === "list") body.appendChild(tagChipRow(source, row, 4));
        const line = document.createElement("p");
        line.className = "hint";
        line.textContent = source.meta.site + " · " + row[ROW.PAGES] + " pages · " + formatDate(row[ROW.UPLOADED]) + " · id " + row[ROW.ID];
        body.appendChild(line);
        if (viewMode === "grid") body.appendChild(tagChipRow(source, row, 3));
        card.appendChild(body);

        list.appendChild(card);
    }

    const more = $("showMore") as HTMLButtonElement;
    more.hidden = refs.length > shownCount;
    more.textContent = "Show " + Math.min(WINDOW_STEP, Math.max(0, refs.length - shownCount)) + " more";
    renderSelectionBar();
}

function renderSelectionBar(): void {
    let titles = 0;
    let pages = 0;
    sources.forEach((source) => {
        for (const row of source.rows) {
            if (selection.has(rowKey(source, row))) {
                titles++;
                pages += row[ROW.PAGES];
            }
        }
    });
    const bar = $("selectionInfo");
    bar.textContent = titles === 0
        ? "Nothing selected."
        : titles.toLocaleString() + " selected — " + pages.toLocaleString() + " pages — " + formatSize(pages) + " at " + avgMbPerPage + " MB/page (rough)";
    const send = $("sendQueue") as HTMLButtonElement;
    send.disabled = sendingQueue || titles === 0;
    send.textContent = sendingQueue ? "Sending…" : "Send to queue";
    send.title = titles === 0
        ? "Select titles first"
        : "Bookmark the selection into the existing queue — the panel's Bookmark tab then downloads them (Item 48 splits mixed sources per site)";
}

// Send-to-queue (phase 3): the selection goes to the worker as bookmarkAdd
// candidates, in SEND_CHUNK-sized messages (§8.9 — never one giant storage
// write). The worker owns the store exactly as for a card's Bookmark click.
async function sendSelectionToQueue(): Promise<void> {
    if (sendingQueue || selection.size === 0) return;
    const candidates: BookmarkCandidate[] = [];
    sources.forEach((source) => {
        const tagNameOf = (tagId: number) => {
            const tag = source.tags.get(tagId);
            return tag ? tag.n : undefined;
        };
        for (const row of source.rows) {
            if (selection.has(rowKey(source, row))) {
                candidates.push(candidateFromGalleryRow(source.meta.site, row, tagNameOf));
            }
        }
    });
    if (candidates.length === 0) return;
    const info = $("selectionInfo");
    sendingQueue = true;
    renderSelectionBar();
    let added = 0;
    let duplicates = 0;
    let failed = 0;
    const chunks = chunkArray(candidates, SEND_CHUNK);
    for (let i = 0; i < chunks.length; i++) {
        info.textContent = "Sending " + candidates.length.toLocaleString() + " titles to the queue — batch " + (i + 1) + " of " + chunks.length + "…";
        try {
            const response = await new Promise<any>((resolve, reject) => {
                try {
                    chrome.runtime.sendMessage({ action: "bookmarkAdd", items: chunks[i] }, (reply: any) => {
                        let error: string | null = null;
                        try {
                            const lastError = chrome.runtime.lastError;
                            error = lastError && typeof lastError.message === "string" ? lastError.message : null;
                        } catch (_) { /* no runtime */ }
                        if (error) reject(new Error(error));
                        else resolve(reply);
                    });
                } catch (error) {
                    reject(error);
                }
            });
            if (response && response.result === "success") {
                added += Array.isArray(response.added) ? response.added.length : 0;
                duplicates += Array.isArray(response.duplicates) ? response.duplicates.length : 0;
            } else {
                failed += 1;
            }
        } catch (_) {
            failed += 1;
        }
    }
    sendingQueue = false;
    renderSelectionBar();
    if (failed === 0) {
        info.textContent = "Queue updated: " + added.toLocaleString() + " added" +
            (duplicates > 0 ? ", " + duplicates.toLocaleString() + " already in the queue (kept as-is)" : "") +
            ". Download them from the panel's Bookmark tab.";
    } else {
        info.textContent = "Queue updated with problems: " + added.toLocaleString() + " added, " +
            failed.toLocaleString() + " batch(es) refused — reopen the panel and check its Bookmark tab.";
    }
}

// ------------------------------------------------------------- watches

function loadWatches(): Promise<void> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ [WATCHES_STORAGE]: [] }, (elems: any) => {
                watches = sanitizeWatchList(elems && elems[WATCHES_STORAGE]);
                resolve();
            });
        } catch (_) {
            watches = [];
            resolve();
        }
    });
}

function saveWatches(): void {
    try {
        chrome.storage.local.set({ [WATCHES_STORAGE]: watches }, () => { /* saved */ });
    } catch (_) { /* session-only */ }
}

function findSourceForSite(site: string): SourceState | null {
    for (const source of sources) {
        if (source.meta.site === site && !source.isSample) return source;
    }
    return null;
}

/** One sequential watch refresh (§6): engine → merge → OPFS save → badges. */
async function refreshOneWatch(watch: Watch): Promise<void> {
    const status = $("watchStatus");
    const source = findSourceForSite(watch.site);
    if (!source) {
        status.textContent = "The " + watch.site + " index is not imported — refresh needs the real index (the sample never refreshes).";
        return;
    }
    const apiKey = await new Promise<string>((resolve) => {
        try {
            chrome.storage.local.get({ [API_KEY_STORAGE]: "" }, (elems: any) => resolve(typeof elems[API_KEY_STORAGE] === "string" ? elems[API_KEY_STORAGE] : ""));
        } catch (_) {
            resolve("");
        }
    });
    status.textContent = "Refreshing " + watch.label + " (" + watch.site + ") — newest first, one tag at a time…";
    const outcome = await refreshWatch(watch, { site: source.meta.site, rows: source.rows, tags: source.tags }, {
        apiKey: apiKey || undefined,
    });
    // Replace the source with the merged state and persist it.
    const meta: IndexMeta = {
        schema: source.meta.schema,
        site: source.meta.site,
        exported: source.meta.exported,
        count: outcome.rows.length,
        tagCount: outcome.tags.size,
    };
    const parsed: ParsedIndex = { meta, tags: outcome.tags, rows: outcome.rows };
    sources[sources.indexOf(source)] = buildSourceState(parsed, false);
    try {
        await saveIndexFile(meta.site, serializeIndex(parsed));
    } catch (error: any) {
        status.textContent = "Refresh merged in memory but saving failed: " + (error && error.message ? error.message : String(error));
    }
    watch.lastRefresh = Date.now();
    watch.lastError = outcome.stopped ? outcome.lines.join(" ") : "";
    watch.newKeys = outcome.newKeys;
    saveWatches();
    renderAll();
    renderSourceList();
    status.textContent = watch.label + ": " + outcome.lines.join(" · ");
}

async function refreshAllWatches(): Promise<void> {
    if (refreshBusy) return;
    refreshBusy = true;
    renderWatchBar();
    try {
        for (const watch of watches) {
            await refreshOneWatch(watch);
        }
    } finally {
        refreshBusy = false;
        renderWatchBar();
    }
}

function renderWatchBar(): void {
    const bar = $("watchBar");
    bar.textContent = "";
    const title = document.createElement("p");
    title.className = "chipGroupTitle";
    title.textContent = "Watches — saved tag combinations, refreshed newest-first";
    bar.appendChild(title);
    if (watches.length === 0) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "None yet — create one in Settings, e.g. vanilla + english on nhentai, then Refresh all walks each tag's newest listings and stops at what the index already knows.";
        bar.appendChild(empty);
    }
    for (const watch of watches) {
        const row = document.createElement("div");
        row.className = "watchRow";
        const label = document.createElement("span");
        label.className = "watchLabel";
        const fresh = watch.newKeys.length;
        label.textContent = watch.label + " · " + watch.site + (fresh > 0 ? " · " + fresh.toLocaleString() + " new" : "");
        row.appendChild(label);
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "secondary";
        refresh.textContent = "Refresh";
        refresh.disabled = refreshBusy || !findSourceForSite(watch.site);
        refresh.title = findSourceForSite(watch.site) ? "Walk this watch's tags newest-first and merge the new titles" : "Import the " + watch.site + " index first";
        refresh.addEventListener("click", () => {
            void (async () => {
                refreshBusy = true;
                renderWatchBar();
                try {
                    await refreshOneWatch(watch);
                } finally {
                    refreshBusy = false;
                    renderWatchBar();
                }
            })();
        });
        row.appendChild(refresh);
        if (fresh > 0) {
            const clear = document.createElement("button");
            clear.type = "button";
            clear.className = "secondary";
            clear.textContent = "Clear new";
            clear.title = "The new marks were seen — forget them until the next refresh";
            clear.addEventListener("click", () => {
                watch.newKeys = [];
                saveWatches();
                renderWatchBar();
                renderResults();
            });
            row.appendChild(clear);
        }
        if (watch.lastError) {
            const warn = document.createElement("p");
            warn.className = "bad";
            warn.textContent = watch.lastError;
            row.appendChild(warn);
        } else if (watch.lastRefresh) {
            const when = document.createElement("p");
            when.className = "hint";
            when.textContent = "Last refreshed " + new Date(watch.lastRefresh).toISOString().slice(0, 16).replace("T", " ");
            row.appendChild(when);
        }
        bar.appendChild(row);
    }
    const actions = document.createElement("div");
    actions.className = "buttons";
    const refreshAll = document.createElement("button");
    refreshAll.type = "button";
    refreshAll.textContent = "Refresh all";
    refreshAll.disabled = refreshBusy || watches.length === 0;
    refreshAll.title = "Sequential by design: one tag listing at a time, never parallel (§6)";
    refreshAll.addEventListener("click", () => {
        void refreshAllWatches();
    });
    actions.appendChild(refreshAll);
    bar.appendChild(actions);
    const status = document.createElement("p");
    status.id = "watchStatus";
    status.className = "hint";
    bar.appendChild(status);
}

// ------------------------------------------------------------- stubs

function renderStubCounts(): void {
    try {
        chrome.storage.local.get(["bookmarkQueue"], (elems: any) => {
            const queue = elems && elems.bookmarkQueue;
            const queued = Array.isArray(queue)
                ? queue.length
                : (queue && Array.isArray(queue.items)) ? queue.items.length : null;
            const bookmarkLine = $("bookmarkStubCount");
            if (bookmarkLine) bookmarkLine.textContent = "Live count: " + (queued === null ? "…" : queued.toLocaleString() + " bookmarked titles waiting in the queue store.");
        });
    } catch (_) {
        // No storage in this context; the stub's static copy still explains.
    }
}

// ------------------------------------------------------------- history

/** Download-history keys, for the ✓ badge. Best-effort: history is optional context. */
function downloadedKeySet(): Promise<Set<string>> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ [DOWNLOAD_HISTORY_KEY]: {} }, (elems: any) => {
                const history = elems && elems[DOWNLOAD_HISTORY_KEY];
                const keys = new Set<string>();
                if (history && typeof history === "object") {
                    for (const key of Object.keys(history)) keys.add(key);
                }
                resolve(keys);
            });
        } catch (_) {
            resolve(new Set());
        }
    });
}

let visitedShown = VISITED_WINDOW;

async function renderVisited(): Promise<void> {
    const list = $("visitedList");
    const counts = $("historyCounts");
    let entries: VisitedEntry[] = [];
    let total = 0;
    try {
        entries = await listVisits(visitedShown);
        total = await countVisits();
    } catch (error: any) {
        counts.textContent = "The visited log could not be read: " + (error && error.message ? error.message : String(error));
        list.textContent = "";
        return;
    }
    const downloaded = await downloadedKeySet();
    let downloadCount = 0;
    try {
        downloadCount = await new Promise((resolve) => {
            try {
                chrome.storage.local.get({ [DOWNLOAD_HISTORY_KEY]: {} }, (elems: any) => {
                    const history = elems && elems[DOWNLOAD_HISTORY_KEY];
                    resolve(history && typeof history === "object" ? Object.keys(history).length : 0);
                });
            } catch (_) {
                resolve(0);
            }
        });
    } catch (_) { /* the count line just omits it */ }
    counts.textContent = total === 0
        ? "Nothing recorded yet — open a gallery page on a supported site and it lands here."
        : total.toLocaleString() + " visited titles recorded (" + Math.min(total, visitedShown).toLocaleString() + " shown) · " + downloadCount.toLocaleString() + " downloads in history.";
    list.textContent = "";
    for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "row";
        const cover = coverElement(entry.site, "", undefined, entry.title || entry.key, true);
        if (entry.cover) {
            // The visit stored its own cover URL; render it directly.
            const img = document.createElement("img");
            img.loading = "lazy";
            img.referrerPolicy = "no-referrer";
            img.alt = "";
            img.addEventListener("load", () => cover.classList.add("coverLoaded"));
            img.addEventListener("error", () => img.remove());
            wireThumbSource(img, entry.cover);
            cover.appendChild(img);
            const initials = document.createElement("span");
            initials.setAttribute("aria-hidden", "true");
            initials.textContent = placeholderInitials(entry.title || entry.key);
            cover.appendChild(initials);
        }
        row.appendChild(cover);
        const body = document.createElement("div");
        body.className = "rowBody";
        const title = document.createElement("p");
        title.className = "rowTitle";
        title.textContent = entry.title || entry.key;
        body.appendChild(title);
        const line = document.createElement("p");
        line.className = "hint";
        line.textContent = entry.site + " · " + entry.id + " · visited " + (entry.visitCount === 1 ? "once" : entry.visitCount + " times") +
            " · last " + formatDate(Math.floor(entry.lastVisited / 1000));
        body.appendChild(line);
        row.appendChild(body);
        if (downloaded.has(entry.key)) {
            const mark = document.createElement("span");
            mark.className = "downloadedMark";
            mark.textContent = "✓ downloaded";
            mark.title = "This title finished downloading (download history)";
            row.appendChild(mark);
        }
        list.appendChild(row);
    }
    const more = $("visitedMore") as HTMLButtonElement;
    more.hidden = total <= visitedShown;
    more.textContent = "Show " + Math.min(VISITED_WINDOW, Math.max(0, total - visitedShown)) + " more";
}

// ------------------------------------------------------------- settings

function renderSourceList(): void {
    const host = $("sourceList");
    host.textContent = "";
    const imported = sources.filter((s) => !s.isSample);
    if (imported.length === 0) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "No imported index yet — Browse is running on the bundled sample.";
        host.appendChild(p);
    }
    for (const source of imported) {
        const line = document.createElement("div");
        line.className = "sourceLine";
        const label = document.createElement("span");
        label.textContent = source.meta.site + " — " + source.rows.length.toLocaleString() + " titles, " + source.tags.size.toLocaleString() + " tags (exported " + (source.meta.exported || "unknown date") + ")";
        line.appendChild(label);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = "Remove";
        remove.addEventListener("click", async () => {
            try {
                await deleteIndexFile(source.meta.site);
            } catch (_) { /* fall through to reload anyway */ }
            await reloadFromStore();
            setImportStatus("Removed the " + source.meta.site + " index.", false);
        });
        line.appendChild(remove);
        host.appendChild(line);
    }
}

function setImportStatus(text: string, bad: boolean): void {
    const status = $("importStatus");
    status.textContent = text;
    status.className = bad ? "bad" : "hint";
}

async function reloadFromStore(): Promise<void> {
    const loaded = await loadAllIndexes();
    sources = [];
    let loadProblems = 0;
    for (const item of loaded) {
        try {
            sources.push(buildSourceState(parseIndexText(item.text), false));
        } catch (_) {
            loadProblems++;
        }
    }
    if (sources.length === 0) sources.push(buildSourceState(buildSampleIndex(), true));
    resetFilters();
    renderAll();
    renderSourceList();
    if (loadProblems > 0) setImportStatus(loadProblems + " stored index file(s) could not be parsed and were skipped.", true);
    else setImportStatus("", false);
}

async function importIndexFile(file: File): Promise<void> {
    setImportStatus("Reading " + file.name + "…", false);
    let text: string;
    try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer.slice(0, 2));
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
            const DS = (window as any).DecompressionStream;
            if (typeof DS !== "function") throw new Error("This browser cannot decompress gzip — import the .jsonl unpacked instead.");
            const stream = new Blob([buffer]).stream().pipeThrough(new DS("gzip"));
            text = await new Response(stream).text();
        } else {
            text = await new Blob([buffer]).text();
        }
    } catch (error: any) {
        setImportStatus("Could not read the file: " + (error && error.message ? error.message : String(error)), true);
        return;
    }
    try {
        const parsed = parseIndexText(text);
        await saveIndexFile(parsed.meta.site, text);
        await reloadFromStore();
        setImportStatus("Imported " + parsed.meta.site + ": " + parsed.rows.length.toLocaleString() + " titles, " + parsed.tags.size.toLocaleString() + " tags. Browse now runs on it.", false);
    } catch (error: any) {
        setImportStatus("Import refused: " + (error instanceof IndexFormatError || (error && error.message) ? error.message : String(error)), true);
    }
}

async function refreshUsage(): Promise<void> {
    const usage = await libraryUsageEstimate();
    const line = $("storageUsage");
    if (!usage) {
        line.textContent = "";
        return;
    }
    line.textContent = "Extension storage: " + (usage.usage / (1024 * 1024)).toFixed(1) + " MB used of " + (usage.quota / (1024 * 1024)).toFixed(0) + " MB reported.";
}

async function refreshThumbCacheStatus(): Promise<void> {
    const line = $("thumbCacheStatus");
    try {
        const stats = await cacheStats();
        const capBytes = await getThumbCapBytes();
        const capMb = capBytes / (1024 * 1024);
        let text = stats.entries === 0
            ? "No thumbnails cached yet — browse Browse and covers are kept as you go."
            : stats.entries.toLocaleString() + " thumbnails cached (" + (stats.bytes / (1024 * 1024)).toFixed(1) + " MB)";
        text += " · cap " + (capMb >= 1024 ? (capMb / 1024).toFixed(1) + " GB" : capMb + " MB") + (capMb === 0 ? " (cache disabled)" : "");
        text += " · source: " + (thumbMode === "live" ? "live only (stored covers kept, unused)" : "cached first, live fallback");
        if (capMb > 0) {
            const hint = await hostGrantHint("https://t.nhentai.net/galleries/m1/thumb.jpg");
            if (hint) text += " · " + hint;
        }
        line.textContent = text;
    } catch (error: any) {
        line.textContent = "The thumbnail cache is unavailable here: " + (error && error.message ? error.message : String(error));
    }
}

// ------------------------------------------------------------- filters

function resetFilters(): void {
    for (const source of sources) source.activeChips.clear();
    titleQuery = "";
    sourceFilter = "";
    sortMode = "newest";
    shownCount = WINDOW_STEP;
    ($("titleSearch") as HTMLInputElement).value = "";
    ($("sourceFilter") as HTMLSelectElement).value = "";
    ($("sortMode") as HTMLSelectElement).value = "newest";
}

function renderSourceFilterOptions(): void {
    const select = $("sourceFilter") as HTMLSelectElement;
    select.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All sources";
    select.appendChild(all);
    for (const source of sources) {
        const option = document.createElement("option");
        option.value = source.meta.site;
        option.textContent = source.meta.site + (source.isSample ? " (sample)" : "");
        select.appendChild(option);
    }
}

function renderAll(): void {
    renderNotice();
    renderSourceFilterOptions();
    renderWatchBar();
    renderChips();
    shownCount = WINDOW_STEP;
    renderResults();
}

// ------------------------------------------------------------- wiring

function applyDarkMode(on: boolean): void {
    document.documentElement.id = on ? "htmlDark" : "htmlLight";
}

function wireTheme(): void {
    try {
        chrome.storage.sync.get({ darkMode: false }, (elems: any) => applyDarkMode(!!elems.darkMode));
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "sync" && changes && changes.darkMode) applyDarkMode(!!changes.darkMode.newValue);
        });
    } catch (_) { /* keep the light theme when storage is unavailable */ }
}

function wireRail(): void {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#rail button[data-section]"));
    const show = (name: string) => {
        for (const button of buttons) {
            const target = button.dataset.section!;
            button.classList.toggle("active", target === name);
            button.setAttribute("aria-current", target === name ? "page" : "false");
        }
        for (const section of Array.from(document.querySelectorAll<HTMLElement>("main > section[data-name]"))) {
            section.hidden = section.dataset.name !== name;
        }
        if (name === "bookmarks") renderStubCounts();
        if (name === "history") {
            visitedShown = VISITED_WINDOW;
            void renderVisited();
        }
        if (name === "settings") {
            renderSourceList();
            renderWatchSettings();
            refreshUsage();
            refreshThumbCacheStatus();
        }
    };
    for (const button of buttons) button.addEventListener("click", () => show(button.dataset.section!));
}

function wireBrowse(): void {
    let debounce: number | undefined;
    $("titleSearch").addEventListener("input", (event) => {
        titleQuery = (event.target as HTMLInputElement).value;
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
            shownCount = WINDOW_STEP;
            renderResults();
        }, 200);
    });
    $("sourceFilter").addEventListener("change", (event) => {
        sourceFilter = (event.target as HTMLSelectElement).value;
        shownCount = WINDOW_STEP;
        renderResults();
    });
    $("sortMode").addEventListener("change", (event) => {
        sortMode = (event.target as HTMLSelectElement).value as SortMode;
        shownCount = WINDOW_STEP;
        renderResults();
    });
    const gridButton = $("viewGrid") as HTMLButtonElement;
    const listButton = $("viewList") as HTMLButtonElement;
    const setView = (mode: "grid" | "list") => {
        viewMode = mode;
        gridButton.setAttribute("aria-pressed", String(mode === "grid"));
        listButton.setAttribute("aria-pressed", String(mode === "list"));
        renderResults();
    };
    gridButton.addEventListener("click", () => setView("grid"));
    listButton.addEventListener("click", () => setView("list"));
    setView("grid");

    $("clearFilters").addEventListener("click", () => {
        resetFilters();
        renderAll();
    });
    $("showMore").addEventListener("click", () => {
        shownCount += WINDOW_STEP;
        renderResults();
    });
    $("selectDisplayed").addEventListener("click", () => {
        const refs = computeView().slice(0, shownCount);
        for (const ref of refs) {
            const source = sources[ref.sourceIdx];
            selection.add(rowKey(source, source.rows[ref.rowIdx]));
        }
        renderResults();
    });
    $("clearSelection").addEventListener("click", () => {
        selection.clear();
        renderResults();
    });
    $("sendQueue").addEventListener("click", () => {
        void sendSelectionToQueue();
    });
}

function renderWatchSettings(): void {
    const sourceSelect = $("watchSource") as HTMLSelectElement;
    const imported = sources.filter((s) => !s.isSample);
    sourceSelect.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = imported.length === 0 ? "Import an index first" : "Choose a source…";
    sourceSelect.appendChild(none);
    for (const source of imported) {
        const option = document.createElement("option");
        option.value = source.meta.site;
        option.textContent = source.meta.site;
        if (watchDraft.site === source.meta.site) option.selected = true;
        sourceSelect.appendChild(option);
    }

    const chosen = $("watchChosen");
    chosen.textContent = "";
    for (const tagId of watchDraft.tagIds) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip chipOn";
        const source = findSourceForSite(watchDraft.site);
        chip.textContent = source && source.tags.get(tagId) ? source.tags.get(tagId)!.n : "tag " + tagId;
        chip.title = "Remove from the watch";
        chip.addEventListener("click", () => {
            watchDraft.tagIds.delete(tagId);
            renderWatchSettings();
        });
        chosen.appendChild(chip);
    }

    const create = $("watchCreate") as HTMLButtonElement;
    create.disabled = watchDraft.site === "" || watchDraft.tagIds.size === 0;
    create.textContent = "Create watch";

    const list = $("watchList");
    list.textContent = "";
    if (watches.length === 0) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No watches yet.";
        list.appendChild(empty);
    }
    for (const watch of watches) {
        const line = document.createElement("div");
        line.className = "sourceLine";
        const label = document.createElement("span");
        label.textContent = watch.label + " on " + watch.site + (watch.newKeys.length > 0 ? " — " + watch.newKeys.length.toLocaleString() + " new" : "");
        line.appendChild(label);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
            watches = watches.filter((w) => w.id !== watch.id);
            saveWatches();
            renderWatchSettings();
            renderWatchBar();
            renderResults();
        });
        line.appendChild(remove);
        list.appendChild(line);
    }
}

function wireWatchSettings(): void {
    const sourceSelect = $("watchSource") as HTMLSelectElement;
    sourceSelect.addEventListener("change", () => {
        watchDraft.site = sourceSelect.value;
        watchDraft.tagIds.clear();
        renderWatchSettings();
    });
    const search = $("watchTagSearch") as HTMLInputElement;
    const results = $("watchTagResults");
    search.addEventListener("input", () => {
        results.textContent = "";
        const source = findSourceForSite(watchDraft.site);
        if (!source) return;
        const needle = search.value.trim().toLowerCase();
        if (needle === "") return;
        const matches = Array.from(source.tags.values())
            .filter((tag) => tag.n.toLowerCase().indexOf(needle) !== -1)
            .sort((a, b) => b.c - a.c)
            .slice(0, 40);
        for (const tag of matches) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip" + (watchDraft.tagIds.has(tag.id) ? " chipOn" : "");
            chip.textContent = tag.n + " · " + tag.c.toLocaleString();
            chip.addEventListener("click", () => {
                if (watchDraft.tagIds.has(tag.id)) watchDraft.tagIds.delete(tag.id);
                else watchDraft.tagIds.add(tag.id);
                renderWatchSettings();
            });
            results.appendChild(chip);
        }
        if (matches.length === 0) {
            const none = document.createElement("p");
            none.className = "hint";
            none.textContent = "No tag in this source's dictionary matches.";
            results.appendChild(none);
        }
    });
    $("watchCreate").addEventListener("click", () => {
        const source = findSourceForSite(watchDraft.site);
        if (!source || watchDraft.tagIds.size === 0) return;
        const names = Array.from(watchDraft.tagIds).map((id) => {
            const tag = source.tags.get(id);
            return tag ? tag.n : "tag " + id;
        });
        const watch = createWatch("w" + Date.now().toString(36), source.meta.site, Array.from(watchDraft.tagIds), names.join(" + "), Date.now());
        watches.push(watch);
        saveWatches();
        watchDraft.site = "";
        watchDraft.tagIds.clear();
        search.value = "";
        $("watchTagResults").textContent = "";
        renderWatchSettings();
        renderWatchBar();
    });
    const bypass = $("bypassSaveAs") as HTMLInputElement;
    try {
        chrome.storage.local.get({ [BYPASS_SAVE_AS_STORAGE]: false }, (elems: any) => {
            bypass.checked = !!elems && elems[BYPASS_SAVE_AS_STORAGE] === true;
        });
    } catch (_) {
        bypass.checked = false;
    }
    bypass.addEventListener("change", () => {
        try {
            chrome.storage.local.set({ [BYPASS_SAVE_AS_STORAGE]: bypass.checked }, () => { /* saved */ });
        } catch (_) { /* session-only */ }
    });
}

function wireSettings(): void {
    // Watches (§6): builder + list + downloads toggle.
    wireWatchSettings();
    // Thumbnail cache (§8.8): source mode, cap, readout, clear.
    const modeSelect = $("thumbMode") as HTMLSelectElement;
    getThumbMode().then((mode) => {
        modeSelect.value = mode;
    });
    modeSelect.addEventListener("change", () => {
        const mode = normalizeThumbMode(modeSelect.value);
        setThumbMode(mode);
        thumbMode = mode; // the storage listener also re-renders; this is the local echo
        renderResults();
        refreshThumbCacheStatus();
    });
    const capInput = $("thumbCacheMb") as HTMLInputElement;
    try {
        chrome.storage.local.get({ [CACHE_CAP_STORAGE]: DEFAULT_CACHE_MB }, (elems: any) => {
            capInput.value = String(typeof elems[CACHE_CAP_STORAGE] === "number" ? elems[CACHE_CAP_STORAGE] : DEFAULT_CACHE_MB);
        });
    } catch (_) {
        capInput.value = String(DEFAULT_CACHE_MB);
    }
    capInput.addEventListener("change", () => {
        const value = Number(capInput.value);
        if (!Number.isFinite(value) || value < 0) return;
        setThumbCapMb(value);
        void pruneToCap().then(() => refreshThumbCacheStatus());
    });
    $("thumbCacheClear").addEventListener("click", () => {
        if (!window.confirm("Clear every cached thumbnail? Covers reload live the next time you browse.")) return;
        clearThumbCache().then(() => refreshThumbCacheStatus());
    });
    $("visitedMore").addEventListener("click", () => {
        visitedShown += VISITED_WINDOW;
        void renderVisited();
    });
    $("visitedClear").addEventListener("click", () => {
        if (!window.confirm("Clear the whole visited log? Download history is kept — only the visited list is forgotten.")) return;
        clearVisits().then(() => renderVisited()).catch(() => { /* the next open re-renders */ });
    });
    $("indexFile").addEventListener("change", (event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files && input.files[0];
        if (file) importIndexFile(file);
        input.value = "";
    });
    $("loadSample").addEventListener("click", () => {
        if (!sources.some((s) => s.isSample)) {
            sources.push(buildSourceState(buildSampleIndex(), true));
            renderAll();
        }
        setImportStatus("Sample data is on alongside any imported indexes.", false);
    });
    try {
        chrome.storage.local.get({ libraryAvgMbPerPage: 45 }, (elems: any) => {
            avgMbPerPage = typeof elems.libraryAvgMbPerPage === "number" ? elems.libraryAvgMbPerPage : 45;
            const input = $("avgMbPerPage") as HTMLInputElement;
            input.value = String(avgMbPerPage);
            renderSelectionBar();
        });
    } catch (_) { /* keep the 45 MB default */ }
    $("avgMbPerPage").addEventListener("change", (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(value) && value > 0 && value <= 1000) {
            avgMbPerPage = value;
            try {
                chrome.storage.local.set({ libraryAvgMbPerPage: value }, () => { /* saved */ });
            } catch (_) { /* session-only */ }
            renderSelectionBar();
        }
    });
}

function boot(): void {
    try {
        chrome.storage.local.get({ [THUMB_MODE_STORAGE]: "cached" }, (elems: any) => {
            thumbMode = normalizeThumbMode(elems[THUMB_MODE_STORAGE]);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes && changes[THUMB_MODE_STORAGE]) {
                thumbMode = normalizeThumbMode(changes[THUMB_MODE_STORAGE].newValue);
                renderResults();
            }
        });
    } catch (_) { /* default mode stands without storage */ }
    wireTheme();
    wireRail();
    wireBrowse();
    wireSettings();
    renderStubCounts();
    loadWatches().then(() => renderWatchBar());
    reloadFromStore();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
