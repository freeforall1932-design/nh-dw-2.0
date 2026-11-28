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
import { CACHE_CAP_STORAGE, DEFAULT_CACHE_MB } from "./thumbLru";
import {
    cacheStats,
    clearThumbCache,
    ensureCachedThumb,
    getThumbCapBytes,
    hostGrantHint,
    pruneToCap,
    resolveCachedThumb,
    setThumbCapMb,
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

/** §8.8 thumb cache: best-effort fetch+store, then swap the live img to the
    cached object URL so the next render is instant and offline-safe. A
    failed fetch (host not granted, offline) leaves the live img as-is. */
function queueThumbCache(url: string, img: HTMLImageElement): void {
    void (async () => {
        try {
            const status = await ensureCachedThumb(url);
            if (status !== "cached") return;
            const objectUrl = await resolveCachedThumb(url);
            if (objectUrl && img.isConnected) img.src = objectUrl;
        } catch (_) { /* cache is best-effort, never load-bearing */ }
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
        img.src = url;
        wrap.appendChild(img);
        queueThumbCache(url, img);
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
            img.src = entry.cover;
            cover.appendChild(img);
            queueThumbCache(entry.cover, img);
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

function wireSettings(): void {
    // Thumbnail cache (§8.8): cap, readout, clear.
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
    wireTheme();
    wireRail();
    wireBrowse();
    wireSettings();
    renderStubCounts();
    reloadFromStore();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
