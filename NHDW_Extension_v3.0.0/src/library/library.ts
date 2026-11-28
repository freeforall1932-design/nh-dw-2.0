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

// ---------------------------------------------------------------- state

const WINDOW_STEP = 200; // same windowed rendering as the panel bookmark list

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
    send.disabled = true; // Phase 3 (INDEXER_PLAN.md §8): queue integration
    send.title = "Send-to-queue lands with the queue integration phase; the selection is kept while this tab is open";
}

// ------------------------------------------------------------- stubs

function renderStubCounts(): void {
    try {
        chrome.storage.local.get(["bookmarkQueue", "downloadHistory"], (elems: any) => {
            const queue = elems && elems.bookmarkQueue;
            const queued = Array.isArray(queue)
                ? queue.length
                : (queue && Array.isArray(queue.items)) ? queue.items.length : null;
            const history = elems && elems.downloadHistory;
            const downloaded = history && typeof history === "object" ? Object.keys(history).length : null;
            const bookmarkLine = $("bookmarkStubCount");
            if (bookmarkLine) bookmarkLine.textContent = "Live count: " + (queued === null ? "…" : queued.toLocaleString() + " bookmarked titles waiting in the queue store.");
            const historyLine = $("historyStubCount");
            if (historyLine) historyLine.textContent = "Live count: " + (downloaded === null ? "…" : downloaded.toLocaleString() + " recorded downloads in history.");
        });
    } catch (_) {
        // No storage in this context; the stubs' static copy still explains.
    }
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
        if (name === "bookmarks" || name === "history") renderStubCounts();
        if (name === "settings") {
            renderSourceList();
            refreshUsage();
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
}

function wireSettings(): void {
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
