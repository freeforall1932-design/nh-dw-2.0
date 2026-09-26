// The Queue tab: the persistent bookmark list, rendered inside the same
// document that serves as the toolbar popup and the side panel.
//
// Why it lives here and not in its own page: index.html is already both
// surfaces (see src/preview/preview.ts), so one tab gives the popup and the
// panel the identical feature with no duplicated markup and no panel-only code
// path. The list itself is storage, not a window — closing the popup loses
// nothing.
//
// Rendering rules:
//   * Built with createElement / textContent, never innerHTML with a value
//     that came from a web page. nhentai titles are attacker-controlled text.
//   * The static chrome is built ONCE and only the row list is re-rendered, so
//     a `bookmarkChanged` broadcast cannot wipe what the user is typing in the
//     paste box.
//   * Every mutation is a worker message. The worker is the single writer.
//
// Downloads reuse the existing pipeline (downloadAllDoujinshis) with the
// existing list-mode settings, so the queue and the in-page floating bar can
// never disagree about format, folder or naming. The queue always downloads
// SEPARATE files: it is a set of individual titles, and merging them would
// mean deciding on the user's behalf that they wanted one archive.

import {
    BookmarkItem,
    BookmarkState,
    SITE_FILTER_ALL,
    bookmarkFilterSites,
    bookmarkSelectionKeys,
    bookmarkSiteCounts,
    emptyBookmarkState,
    normalizeBookmarkSiteFilter,
    normalizeBookmarkState,
    parseGalleryInput,
    planBookmarkDownload
} from "../utils/bookmarkQueue";
import {
    BOOKMARK_PAGE_SIZE,
    BOOKMARK_QUERY_DEFAULTS,
    BookmarkQuery,
    bookmarkHistoryName,
    bookmarkIsDownloaded,
    bookmarkQuerySummary,
    chunkBookmarkRows,
    isDefaultBookmarkQuery,
    nextBookmarkChunkSize,
    normalizeBookmarkQuery,
    queryBookmarks
} from "../utils/bookmarkFilters";
import { DOWNLOAD_HISTORY_KEY, historyIds, readHistory } from "../utils/downloadHistory";
import { DEFAULT_SITE, normalizeSite, toGalleryKey } from "../utils/siteKeys";
import {
    buildTransferPayload,
    mergeImportedHistory,
    parseTransferPayload,
    serializeTransfer
} from "../utils/queueTransfer";
import { readListSettings, resolveMasterFolder, ListModeSettings } from "../utils/listSettings";
import { getActiveNhentaiTabId } from "./activeTabGallery";

function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return document.createElement(tag);
}

function send(message: any): Promise<any> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(message, (response: any) => {
                // Reading lastError keeps Chrome quiet when the worker is
                // mid-restart; the UI then shows its "worker unreachable" note.
                try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
                resolve(response || null);
            });
        } catch (_) {
            resolve(null);
        }
    });
}

let state: BookmarkState = emptyBookmarkState();
// Drag-reorder: the id being dragged right now (null when no drag is active).
// Module-level because the handle and the drop targets are built by different
// calls and the browser's drag events carry no usable payload in every engine.
let draggingId: string | null = null;
let built = false;
let includeAlready = false;
let noticeTimer: any = null;
// Item 66: the per-site filter. A VIEW over the list - it never rewrites the
// stored state - remembered in chrome.storage.sync (like uiMode / darkMode),
// never in the worker-owned local store.
const SITE_FILTER_KEY = "bookmarkSiteFilter";
let siteFilter: string = SITE_FILTER_ALL;
let selectAllButton: HTMLButtonElement | null = null;
let selectNoneButton: HTMLButtonElement | null = null;

function readSiteFilter(done: () => void): void {
    let answered = false;
    const finish = (value: any) => {
        if (answered) {
            return;
        }
        answered = true;
        siteFilter = normalizeBookmarkSiteFilter(value);
        // Item 68: the site filter is one field of the query, always in sync.
        bookmarkQuery = normalizeBookmarkQuery(Object.assign({}, bookmarkQuery, { site: siteFilter }));
        done();
    };
    try {
        chrome.storage.sync.get({ [SITE_FILTER_KEY]: SITE_FILTER_ALL }, (values: any) => {
            finish(values ? values[SITE_FILTER_KEY] : SITE_FILTER_ALL);
        });
    } catch (_) {
        // No runtime (or no sync permission): show the whole list.
        finish(SITE_FILTER_ALL);
    }
}

// Item 68: the search/filter query, the rendered window, and the history the
// downloaded mark comes from.
//
// The query is deliberately NOT persisted: a forgotten search that hides rows
// is a nastier surprise than retyping one. The window IS reset whenever the
// query changes, so a freshly typed search can never hide behind a stale
// "shown" count - and the history is refreshed on open and whenever storage
// reports a change, because the mark means "this file is on disk" and comes
// from the same disk verification the batch skip trusts.
let bookmarkQuery: BookmarkQuery = Object.assign({}, BOOKMARK_QUERY_DEFAULTS);
let shownRows: number = BOOKMARK_PAGE_SIZE;
let historyKeys: string[] = [];
let historyMap: any = {};
let watchingHistory = false;
let historyRefresh = 0;

async function refreshHistory(): Promise<void> {
    const refresh = ++historyRefresh;
    try {
        const stored = await readHistory();
        // The history record only says a download once succeeded. A user may
        // have deleted the file since then. Ask the worker (which has the
        // downloads API even when this panel runs inside a content-script
        // drawer) for the SAME on-disk check used by the download skip guard.
        const reply = await send({ action: "historyPresent" });
        if (refresh !== historyRefresh) {
            return; // a later storage event/open has already begun a new read
        }
        historyKeys = reply && reply.result === "success" && Array.isArray(reply.ids)
            ? reply.ids.filter((id: any) => typeof id === "string" && Object.prototype.hasOwnProperty.call(stored, id))
            : []; // worker unreachable: never claim a file exists
        historyMap = stored;
    } catch (_) {
        if (refresh !== historyRefresh) {
            return;
        }
        historyKeys = [];
        historyMap = {};
    }
}

/** Live marks: the worker records history on success, storage says so. */
function watchHistoryChanges(): void {
    if (watchingHistory) {
        return;
    }
    watchingHistory = true;
    try {
        (chrome.storage as any).onChanged.addListener((changes: any, area: string) => {
            if (area !== "local" || !changes || !changes[DOWNLOAD_HISTORY_KEY]) {
                return;
            }
            void refreshHistory().then(() => renderList());
        });
    } catch (_) { /* no storage events here: the open-time read still marks rows */ }
}

function writeSiteFilter(value: string): void {
    try {
        chrome.storage.sync.set({ [SITE_FILTER_KEY]: value }, () => {
            try { void chrome.runtime.lastError; } catch (_) { /* preference only */ }
        });
    } catch (_) { /* preference only */ }
}

// ---- notices -------------------------------------------------------------

function showNotice(text: string, isError: boolean = false): void {
    const notice = document.getElementById("nhdwBmNotice");
    if (notice === null) {
        return;
    }
    notice.textContent = text;
    notice.className = "nhdwBmNotice" + (isError ? " nhdwBmNoticeError" : "");
    notice.hidden = text === "";
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
    }
    if (text !== "") {
        noticeTimer = setTimeout(() => {
            notice.textContent = "";
            notice.hidden = true;
        }, 6000);
    }
}

// ---- downloads -----------------------------------------------------------

// One entry point for every download the Queue tab can start: a single row,
// the whole selection, or a paste that was never bookmarked.
async function startDownload(groups: Array<{ site: string; titles: Record<string, string> }>, fromQueue: boolean, skippedCount: number = 0): Promise<void> {
    // The final notice keeps the "already downloaded" suffix: it is the last
    // thing the user sees, and losing it made a partial download look complete.
    const skipSuffix = skippedCount > 0 ? " (" + skippedCount + " already downloaded skipped)" : "";
    const jobs = groups
        .map((group) => ({ site: normalizeSite(group.site), titles: group.titles || {} }))
        .filter((group) => Object.keys(group.titles).length > 0);
    const total = jobs.reduce((sum, group) => sum + Object.keys(group.titles).length, 0);
    if (total === 0) {
        showNotice("Nothing to download.", true);
        return;
    }
    let settings: ListModeSettings;
    try {
        settings = await readListSettings();
    } catch (_) {
        showNotice("Could not read the list-mode settings.", true);
        return;
    }
    // Guarded: the Queue tab can be open while the active tab is any website,
    // and the pipeline injects into whatever tab id it is handed. undefined is
    // the correct answer there - the pipeline then resolves metadata from the
    // extension origin, which is the fallback it already has.
    const tabId = await getActiveNhentaiTabId();
    if (fromQueue) {
        // Rows read "downloading" before the first byte arrives rather than
        // after the first broadcast. The ids are composite here: a row's status
        // lives under "site:id", and a bare id would mark the wrong row once two
        // sites use the same gallery number (item 48).
        const ids: string[] = [];
        for (const group of jobs) {
            for (const id of Object.keys(group.titles)) {
                ids.push(toGalleryKey(id, group.site));
            }
        }
        await send({ action: "bookmarkMarkDownloading", ids: ids });
    }

    // ONE JOB PER SITE (item 48): a job payload carries a single site, because
    // the pipeline composes every store key with it. The jobs are sent in
    // sequence, so the worker queues them in the order the sites appear in the
    // list and each one reports its own progress and summary.
    let started = 0;
    let queued = 0;
    let unanswered = 0;
    for (const group of jobs) {
        const message: any = {
            action: "downloadAllDoujinshis",
            allDoujinshis: group.titles,
            galleryMetadata: {},
            finalName: "bookmarks",
            tabId: tabId,
            formatOverride: settings.format,
            // Always one file per title (see the file header).
            separate: true,
            masterFolder: resolveMasterFolder(settings),
            nameTemplate: settings.template
        };
        if (group.site !== DEFAULT_SITE) {
            message.site = group.site;
        }
        const response = await send(message);
        if (response === null) {
            unanswered++;
            continue;
        }
        if (response.result === "queued") {
            queued++;
        } else {
            started++;
        }
    }
    if (unanswered === jobs.length) {
        showNotice("The extension worker did not answer. Reopen the panel and try again.", true);
        return;
    }
    const sites = jobs.length;
    if (queued > 0 && queued === jobs.length) {
        showNotice((total === 1
            ? "Queued behind the download already running."
            : total + " titles queued behind the download already running.") + skipSuffix);
        return;
    }
    if (sites > 1) {
        showNotice("Downloading " + total + " titles across " + sites + " sites, one file each."
            + (queued > 0 ? " " + queued + " queued behind the running download." : "")
            + (unanswered > 0 ? " " + unanswered + " site(s) could not be started." : "")
            + skipSuffix,
            unanswered > 0);
        return;
    }
    showNotice((total === 1 ? "Downloading 1 title." : "Downloading " + total + " titles, one file each.") + skipSuffix);
}

// ---- backup: export / import --------------------------------------------

async function exportBackup(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
        const history = await readHistory();
        const payload = buildTransferPayload(state, history);
        const text = serializeTransfer(payload);
        // A blob URL plus a plain <a download> click: the panel is a document,
        // so this needs no permission and never passes through the download
        // path (thumbnails and exports alike stay out of chrome.downloads).
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = el("a");
        link.href = url;
        link.download = "nh-downloader-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* already gone */ } }, 30000);
        showNotice("Exported " + payload.bookmarkCount + " bookmarks and " + payload.historyCount + " history records.");
    } catch (_) {
        showNotice("Could not build the backup file.", true);
    } finally {
        button.disabled = false;
    }
}

async function importBackup(input: HTMLInputElement): Promise<void> {
    const file = input.files && input.files[0] ? input.files[0] : null;
    input.value = ""; // so picking the SAME file again still fires change
    if (file === null) {
        return;
    }
    let text = "";
    try {
        text = await file.text();
    } catch (_) {
        showNotice("Could not read that file.", true);
        return;
    }
    const parsed = parseTransferPayload(text);
    if (!parsed.ok) {
        showNotice("Import failed: " + parsed.error, true);
        return;
    }

    // History first (its write does not depend on the worker's reply), then the
    // queue through the worker so the single-writer rule holds.
    let localHistory: any = {};
    try {
        localHistory = await readHistory();
    } catch (_) { /* an unreadable history just means nothing to merge with */ }
    const mergedHistory = mergeImportedHistory(localHistory, parsed.history as any);
    const beforeBookmarks = state.items.length;

    const response = await send({ action: "bookmarkImport", state: parsed.bookmarks });
    if (response === null) {
        showNotice("The extension worker did not answer. Nothing was imported.", true);
        return;
    }
    if (response.state) {
        state = normalizeBookmarkState(response.state);
        renderList();
    }
    // The history merge is expressed as what is NEW, so a re-import of the same
    // file is a no-op rather than a rewrite.
    const addedHistory = Object.keys(mergedHistory).length - Object.keys(localHistory || {}).length;
    if (addedHistory > 0) {
        await send({ action: "historyImport", history: mergedHistory });
    }
    const addedBookmarks = Math.max(0, state.items.length - beforeBookmarks);
    showNotice("Import done: added " + addedBookmarks + " bookmark" + (addedBookmarks === 1 ? "" : "s") +
        " and " + addedHistory + " history record" + (addedHistory === 1 ? "" : "s") +
        ". Rows already here were kept unchanged.");
}

async function downloadSelection(): Promise<void> {
    let history: string[] = [];
    try {
        history = historyIds(await readHistory());
    } catch (_) {
        history = [];
    }
    // "Download anyway": the forced ids must be composite, so the exemption
    // lands on the row that was ticked and not on a same-numbered gallery of
    // another site.
    const forced: string[] = includeAlready
        ? state.items.filter((item) => item.selected).map((item) => toGalleryKey(item.id, item.site))
        : [];
    const plan = planBookmarkDownload(state, history, forced);
    if (plan.download.length === 0) {
        if (plan.skip.length > 0) {
            showNotice("All " + plan.skip.length + " selected titles are already downloaded. Tick \"include already downloaded\" to fetch them again.", true);
        } else {
            showNotice("Nothing selected.", true);
        }
        return;
    }
    const suffix = plan.skip.length > 0 ? " (" + plan.skip.length + " already downloaded skipped)" : "";
    const siteCount = plan.bySite.filter((group) => group.download.length > 0).length;
    showNotice("Starting " + plan.download.length + (plan.download.length === 1 ? " title" : " titles")
        + (siteCount > 1 ? " across " + siteCount + " sites" : "") + suffix + "\u2026");
    // Only the rows that actually download, grouped per site.
    await startDownload(plan.bySite.map((group) => ({ site: group.site, titles: group.titles })), true, plan.skip.length);
}

async function downloadOne(item: BookmarkItem): Promise<void> {
    const titles: Record<string, string> = {};
    titles[item.id] = item.title !== "" ? item.title : item.id;
    // A single row is always a single-site job; its site is the row's own.
    await startDownload([{ site: item.site, titles: titles }], true);
}

// ---- paste ---------------------------------------------------------------

async function addPasted(downloadNow: boolean): Promise<void> {
    const box = document.getElementById("nhdwBmPaste") as HTMLTextAreaElement | null;
    if (box === null) {
        return;
    }
    const parsed = parseGalleryInput(box.value);
    if (parsed.ids.length === 0) {
        showNotice(parsed.rejected.length > 0
            ? "No gallery ids found in: " + parsed.rejected.slice(0, 5).join(", ")
            : "Paste gallery ids or links first.", true);
        return;
    }
    const rejectedNote = parsed.rejected.length > 0 ? " (ignored " + parsed.rejected.length + " unreadable)" : "";
    const truncatedNote = parsed.truncated ? " (list capped)" : "";

    if (downloadNow) {
        // Download straight away without bookmarking: the paste box doubles as
        // a "just get these" entry point.
        const titles: Record<string, string> = {};
        for (const id of parsed.ids) {
            titles[id] = id;
        }
        box.value = "";
        // The paste box parses ids and nhentai URLs only (parseGalleryInput),
        // so this is a default-site job: one group, no site field on the wire.
        await startDownload([{ site: DEFAULT_SITE, titles: titles }], false);
        return;
    }

    const items = parsed.ids.map((id) => ({ id: id, source: "paste" as const, sourceUrl: "" }));
    const response = await send({ action: "bookmarkAdd", items: items });
    if (response === null) {
        showNotice("The extension worker did not answer.", true);
        return;
    }
    const added = Array.isArray(response.added) ? response.added.length : parsed.ids.length;
    box.value = "";
    const bookmarkedNote = "Bookmarked " + added + (added === 1 ? " title" : " titles") + rejectedNote + truncatedNote + ".";
    showNotice(bookmarkedNote + " Resolving titles\u2026");
    // A pasted id has no title and no thumbnail: ask the worker to resolve it
    // through the open nhentai tab, the same route the panel's own resolver
    // uses. Rows stay usable (and downloadable) even when this fails.
    const enriched = await send({ action: "bookmarkEnrich", ids: parsed.ids });
    if (enriched && enriched.state) {
        state = normalizeBookmarkState(enriched.state);
        renderList();
    }
    // Say what actually happened. "Resolving..." that never resolves is worse
    // than naming the reason, and the reason is actionable.
    if (!enriched || enriched.result !== "success") {
        showNotice(bookmarkedNote + " Titles could not be resolved - the rows are still downloadable by id.", true);
    } else if (enriched.skipped) {
        showNotice(bookmarkedNote + " Open an nhentai.net tab to fill in the titles and covers.", true);
    } else if (enriched.resolved === 0) {
        showNotice(bookmarkedNote + " No metadata came back - nhentai may be challenging this session. The rows are still downloadable by id.", true);
    } else {
        const missing = parsed.ids.length - enriched.resolved;
        showNotice(bookmarkedNote + " Resolved " + enriched.resolved + (enriched.resolved === 1 ? " title." : " titles.")
            + (missing > 0 ? " " + missing + " still unresolved." : ""));
    }
}

// ---- list rendering ------------------------------------------------------

function statusLabel(item: BookmarkItem): string {
    switch (item.status) {
        case "downloading": return "downloading";
        case "done": return "done";
        case "failed": return "failed";
        default: return "bookmarked";
    }
}

function buildRow(item: BookmarkItem): HTMLElement {
    const row = el("div");
    row.className = "nhdwBmRow nhdwBmStatus-" + item.status;

    const select = el("input");
    select.type = "checkbox";
    select.className = "nhdwBmSelect";
    select.checked = item.selected;
    select.title = "Include this title in Download selected";
    select.addEventListener("change", () => {
        send({ action: "bookmarkSelect", ids: [item.id], selected: select.checked }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    row.appendChild(select);

    // Drag handle. Only the handle is draggable, so a drag can never start by
    // accident on the row's checkbox, Download button or Remove button - those
    // keep their own hit targets (item 44's explicit requirement).
    const dragHandle = el("span");
    dragHandle.className = "nhdwBmDrag";
    dragHandle.textContent = "\u28ff\u28ff";
    dragHandle.title = "Drag to reorder - the queue downloads in this order";
    dragHandle.setAttribute("draggable", "true");
    dragHandle.addEventListener("dragstart", (event: any) => {
        draggingId = item.id;
        row.className = row.className + " nhdwBmDragging";
        if (event && event.dataTransfer && typeof event.dataTransfer.setData === "function") {
            // Firefox refuses to start a drag without data in the transfer.
            try { event.dataTransfer.setData("text/plain", item.id); } catch (_) { /* ignore */ }
        }
    });
    dragHandle.addEventListener("dragend", () => {
        draggingId = null;
        row.className = row.className.replace(" nhdwBmDragging", "");
    });
    row.appendChild(dragHandle);

    // Drop target: dropping on a row moves the dragged bookmark to that row's
    // position. Reordering happens in the WORKER (single writer) - the panel
    // only asks for the move and repaints from the state it gets back.
    row.addEventListener("dragover", (event: any) => {
        if (draggingId === null || draggingId === item.id) {
            return;
        }
        if (event && typeof event.preventDefault === "function") {
            event.preventDefault(); // required so the drop event fires
        }
        row.className = row.className.indexOf("nhdwBmDropTarget") === -1
            ? row.className + " nhdwBmDropTarget"
            : row.className;
    });
    row.addEventListener("dragleave", () => {
        row.className = row.className.replace(" nhdwBmDropTarget", "");
    });
    row.addEventListener("drop", (event: any) => {
        row.className = row.className.replace(" nhdwBmDropTarget", "");
        if (event && typeof event.preventDefault === "function") {
            event.preventDefault();
        }
        const movingId = draggingId;
        draggingId = null;
        if (movingId === null || movingId === item.id) {
            return;
        }
        const targetIndex = state.items.map((candidate) => candidate.id).indexOf(item.id);
        if (targetIndex === -1) {
            return;
        }
        send({ action: "bookmarkReorder", id: movingId, toIndex: targetIndex }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });

    // Thumbnail. Display only: a remote <img> needs no host permission, and no
    // thumbnail ever reaches the download path.
    const thumbBox = el("div");
    thumbBox.className = "nhdwBmThumb";
    if (item.thumbnail !== "") {
        const img = el("img");
        img.src = item.thumbnail;
        // setAttribute rather than the .loading property: the typed property
        // is not in every lib.dom.d.ts this project builds against.
        img.setAttribute("loading", "lazy");
        img.alt = "";
        // A stale or blocked thumbnail must not leave a broken-image icon.
        img.addEventListener("error", () => {
            img.remove();
            thumbBox.textContent = "#";
        });
        thumbBox.appendChild(img);
    } else {
        thumbBox.textContent = "#";
        thumbBox.title = "No cover yet - it fills in once the title is resolved";
    }
    row.appendChild(thumbBox);

    const info = el("div");
    info.className = "nhdwBmInfo";

    const title = el("div");
    title.className = "nhdwBmTitle";
    title.textContent = item.title !== "" ? item.title : "(untitled) " + item.id;
    title.title = title.textContent;
    info.appendChild(title);

    // Item 68: the mark is drawn from HISTORY, never from item.status. A row
    // that only says "done" gets no check (the owner's rule: a green check
    // means the file is really there), and a row whose retry failed after an
    // earlier success keeps it, because the artifact is still on disk.
    if (bookmarkIsDownloaded(item, historyKeys)) {
        const mark = el("span");
        mark.className = "nhdwBmAlready";
        mark.textContent = "\u2713";
        const artifact = bookmarkHistoryName(item, historyMap);
        mark.title = artifact !== ""
            ? "Already downloaded: " + artifact
            : "Already downloaded (the history records this title)";
        info.appendChild(mark);
    }

    const meta = el("div");
    meta.className = "nhdwBmMeta";
    const metaBits: string[] = ["#" + item.id];
    if (item.pages > 0) {
        metaBits.push(item.pages + (item.pages === 1 ? " page" : " pages"));
    }
    if (item.source === "auto") {
        metaBits.push("auto-captured");
    } else if (item.source === "paste") {
        metaBits.push("pasted");
    }
    meta.textContent = metaBits.join(" \u00b7 ");
    info.appendChild(meta);

    if (item.error !== "") {
        const error = el("div");
        error.className = "nhdwBmError";
        error.textContent = item.error;
        info.appendChild(error);
    } else if (item.filename !== "") {
        const saved = el("div");
        saved.className = "nhdwBmSaved";
        saved.textContent = item.filename;
        saved.title = "Saved as " + item.filename;
        info.appendChild(saved);
    }
    row.appendChild(info);

    const right = el("div");
    right.className = "nhdwBmRight";

    const status = el("span");
    status.className = "nhdwBmStatus nhdwBmStatusBadge-" + item.status;
    status.textContent = statusLabel(item);
    right.appendChild(status);

    if (item.status === "downloading") {
        const cancelButton = el("button");
        cancelButton.type = "button";
        cancelButton.className = "nhdwBmCancel";
        cancelButton.textContent = "Cancel";
        cancelButton.title = "Cancel downloading this title";
        cancelButton.addEventListener("click", () => {
            cancelButton.disabled = true;
            send({ action: "cancelGallery", id: item.id, site: item.site });
        });
        right.appendChild(cancelButton);
    } else {
        const downloadButton = el("button");
        downloadButton.type = "button";
        downloadButton.className = "nhdwBmDownload";
        downloadButton.textContent = "Download";
        downloadButton.title = "Download just this title now, using the list-mode settings";
        downloadButton.addEventListener("click", () => {
            downloadButton.disabled = true;
            downloadOne(item).then(() => {
                downloadButton.disabled = false;
            });
        });
        right.appendChild(downloadButton);
    }

    const removeButton = el("button");
    removeButton.type = "button";
    removeButton.className = "nhdwBmRemove";
    removeButton.textContent = "\u00d7";
    removeButton.title = "Take this title off the bookmark list (nothing is un-downloaded)";
    removeButton.addEventListener("click", () => {
        send({ action: "bookmarkRemove", ids: [item.id] }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    right.appendChild(removeButton);

    row.appendChild(right);
    return row;
}

function renderList(): void {
    const list = document.getElementById("nhdwBmList");
    const counts = document.getElementById("nhdwBmCounts");
    const dockButton = document.getElementById("nhdwBmToggle");
    const downloadButton = document.getElementById("nhdwBmDownloadSelected") as HTMLButtonElement | null;
    if (list === null || counts === null || dockButton === null || downloadButton === null) {
        return;
    }

    const total = state.items.length;
    const selectedCount = state.items.filter((item) => item.selected).length;
    const doneCount = state.items.filter((item) => item.status === "done").length;
    counts.textContent = total + " bookmarked \u00b7 " + selectedCount + " selected \u00b7 " + doneCount + " done";

    // Items 66 + 68: the query (site, text, state, date) is a VIEW, so the
    // counts line above and the footer button keep reporting the WHOLE list;
    // the filter line states how much of it the query matches, and the list
    // below renders a bounded window of those matches.
    const queryActive = !isDefaultBookmarkQuery(bookmarkQuery);
    const matched = queryBookmarks(state, bookmarkQuery);
    const visible = chunkBookmarkRows(matched, shownRows);
    const querySummary = bookmarkQuerySummary(matched, historyKeys);
    syncSiteFilterSelect();
    const filterInfo = document.getElementById("nhdwBmFilterInfo");
    if (filterInfo !== null) {
        filterInfo.textContent = queryActive ? "showing " + matched.length + " of " + total : "";
    }
    const historyInfo = document.getElementById("nhdwBmHistoryInfo");
    if (historyInfo !== null) {
        historyInfo.textContent = querySummary.alreadyDownloaded > 0
            ? querySummary.alreadyDownloaded + " already downloaded"
            : "";
        historyInfo.title = querySummary.alreadyDownloaded > 0
            ? "The browser confirms saved files for these rows. Ticking \"include already downloaded\" re-fetches them."
            : "";
    }
    if (selectAllButton !== null) {
        selectAllButton.title = queryActive
            ? "Tick every row this search and these filters match (" + matched.length + ")"
            : "Tick every bookmark";
    }
    if (selectNoneButton !== null) {
        selectNoneButton.title = queryActive
            ? "Untick every row this search and these filters match (" + matched.length + ")"
            : "Untick every bookmark";
    }

    dockButton.textContent = state.collapsed ? "Expand \u25be" : "Minimise \u25b4";
    dockButton.title = state.collapsed
        ? "Show the bookmark list"
        : "Collapse to a single bar - the list itself is saved either way";

    downloadButton.disabled = selectedCount === 0;
    downloadButton.textContent = selectedCount > 0
        ? "Download " + selectedCount + " selected"
        : "Download selected";
    // Item 68: what the batch would really fetch, BEFORE it runs (the owner's
    // note: re-downloads must be obvious before you commit to the job).
    downloadButton.title = querySummary.alreadyDownloaded > 0
        ? "Download every ticked title, one file each. " + querySummary.alreadyDownloaded
            + " of the rows matching this view are already on disk - tick \"include already downloaded\" to fetch them again."
        : "Download every ticked title, one file each, using the list-mode settings";

    const body = document.getElementById("nhdwBmBody");
    if (body !== null) {
        body.hidden = !!state.collapsed;
    }

    // Show the launcher only when this document is the hovering popup. The
    // nhdwPanel class is applied by preview.ts from the stored uiMode - the same
    // value the worker uses to decide what the toolbar click opens - so it is a
    // setting-driven proxy, not true context detection: Chrome exposes no "am I
    // a side panel" API. Re-evaluated on every render because applyUiModeClass
    // resolves asynchronously and may not have run when the chrome was built.
    const openPanel = document.getElementById("nhdwBmOpenPanel");
    if (openPanel !== null) {
        openPanel.hidden = document.documentElement.classList.contains("nhdwPanel");
    }

    list.textContent = "";
    if (total === 0) {
        const empty = el("div");
        empty.className = "nhdwBmEmpty";
        empty.textContent = "Nothing bookmarked yet. Tap the bookmark icon on a card or the Bookmark button on a gallery page, paste ids below, or turn on auto-capture in Settings.";
        list.appendChild(empty);
        return;
    }
    if (matched.length === 0) {
        // A filtered-empty list must say why it is empty and how to get out.
        // "no result for this search" and "nothing for hitomi" are different
        // answers, so the notice names the thing that is actually hiding rows.
        const empty = el("div");
        empty.className = "nhdwBmEmpty";
        const narrowed = bookmarkQuery.text !== "" || bookmarkQuery.status !== "all" || bookmarkQuery.date !== "all";
        empty.textContent = narrowed
            ? "No bookmark matches this search. Clear the search box, or set the state and date filters back to all, to see the whole list."
            : "No bookmarks for " + siteFilter + " yet. Pick \"All sites\" to see the other "
                + (total === 1 ? "title" : total + " titles") + ".";
        list.appendChild(empty);
        return;
    }
    for (const item of visible) {
        list.appendChild(buildRow(item));
    }
    // Item 68: a bounded window keeps the DOM small at any list size. "Show
    // more" grows it by one page; the control states exactly how much is on
    // screen, so nobody has to guess whether the list is truncated.
    if (visible.length < matched.length) {
        const more = el("button");
        more.type = "button";
        more.className = "nhdwBmMore";
        more.textContent = "Show more (" + visible.length + " of " + matched.length + ")";
        more.title = "Render the next " + BOOKMARK_PAGE_SIZE + " rows. The list stays this size in the page however big the queue gets.";
        more.addEventListener("click", () => {
            shownRows = nextBookmarkChunkSize(shownRows, matched.length);
            renderList();
        });
        list.appendChild(more);
    }
}

// Item 66: the <select> keeps its options for the whole life of the panel
// (rebuilding them would close an open dropdown), so a render only refreshes
// the counts and the current value. Options are the six known sites plus All
// sites, in one canonical order - a site with no rows is still offered, and
// picking it shows the filtered-empty note above.
function syncSiteFilterSelect(): void {
    const select = document.getElementById("nhdwBmSiteFilter") as HTMLSelectElement | null;
    if (select === null) {
        return;
    }
    const counts = bookmarkSiteCounts(state);
    const sites = [SITE_FILTER_ALL].concat(bookmarkFilterSites());
    // A real <select> exposes .options; the window-less harness only has the
    // appended children. Both are indexable, so accept either.
    const options: any = (select as any).options && (select as any).options.length
        ? (select as any).options
        : select.children;
    for (let i = 0; i < options.length; i++) {
        const option = options[i] as any;
        const site = String(option.value);
        if (sites.indexOf(site) === -1) {
            continue;
        }
        const count = counts[site] || 0;
        const name = site === SITE_FILTER_ALL ? "All sites" : site;
        option.textContent = count > 0 ? name + " (" + count + ")" : name;
    }
    select.value = siteFilter;
}

// ---- static chrome -------------------------------------------------------

function buildChrome(container: HTMLElement): void {
    container.textContent = "";

    // Dock header: the "small taskbar" the request asked for. Collapsing hides
    // the rows but keeps the counts and the download button, and the flag is
    // stored with the list so it comes back the same way after a restart.
    const header = el("div");
    header.className = "nhdwBmHeader";

    const heading = el("div");
    const title = el("strong");
    title.textContent = "Bookmark queue";
    heading.appendChild(title);
    const counts = el("span");
    counts.className = "nhdwBmCounts";
    counts.id = "nhdwBmCounts";
    heading.appendChild(counts);
    header.appendChild(heading);

    // The Twitter sibling makes its popup a pure launcher for the side panel,
    // because its popup had nothing else to do. This popup is the primary UI
    // for single-title and list downloads, so it stays functional - but the
    // launcher belongs HERE, not buried in Settings: the Queue tab is the one
    // place where a hovering popup is actively the wrong surface, since it dies
    // on blur and a queue is meant to be watched.
    const openPanel = el("button");
    openPanel.type = "button";
    openPanel.id = "nhdwBmOpenPanel";
    openPanel.className = "nhdwBmToggle";
    openPanel.textContent = "Open docked \u2197";
    openPanel.title = "Open this queue in the resizable side panel, which stays open while you browse";
    openPanel.addEventListener("click", () => {
        const sidePanelApi: any = (chrome as any).sidePanel;
        if (!sidePanelApi || typeof sidePanelApi.open !== "function") {
            showNotice("This browser has no side panel (Chrome 116+). The list is saved either way.", true);
            return;
        }
        try {
            chrome.windows.getCurrent((currentWindow: any) => {
                const options: any = currentWindow && currentWindow.id !== undefined ? { windowId: currentWindow.id } : {};
                const opened = sidePanelApi.open(options);
                if (opened && typeof opened.catch === "function") {
                    opened.catch((error: any) => {
                        showNotice("Chrome refused to open the panel: " + (error && error.message ? error.message : String(error)), true);
                    });
                }
            });
        } catch (error: any) {
            showNotice("Could not open the panel: " + (error && error.message ? error.message : String(error)), true);
        }
    });
    header.appendChild(openPanel);
    // Item 66: the per-site filter sits in the header, right after the counts.
    // The wrapper keeps the select and its "showing X of Y" line together when
    // the header wraps in a narrow side panel.
    const filterBox = el("div");
    filterBox.className = "nhdwBmFilter";
    const filterSelect = el("select");
    filterSelect.id = "nhdwBmSiteFilter";
    filterSelect.className = "nhdwBmSiteSelect";
    filterSelect.title = "Show only the bookmarks of one site";
    (filterSelect as any).setAttribute("aria-label", "Filter bookmarks by site");
    for (const site of [SITE_FILTER_ALL].concat(bookmarkFilterSites())) {
        const option = el("option");
        option.value = site;
        option.textContent = site === SITE_FILTER_ALL ? "All sites" : site;
        filterSelect.appendChild(option);
    }
    filterSelect.value = siteFilter;
    filterSelect.addEventListener("change", () => {
        siteFilter = normalizeBookmarkSiteFilter((filterSelect as HTMLSelectElement).value);
        bookmarkQuery.site = siteFilter;
        shownRows = BOOKMARK_PAGE_SIZE;
        writeSiteFilter(siteFilter);
        renderList();
    });
    filterBox.appendChild(filterSelect);
    const filterInfo = el("span");
    filterInfo.id = "nhdwBmFilterInfo";
    filterInfo.className = "nhdwBmFilterInfo";
    filterBox.appendChild(filterInfo);
    // Item 68: how much of the current view is already on disk. Its own element
    // so the "showing X of Y" line keeps its exact wording.
    const historyInfo = el("span");
    historyInfo.id = "nhdwBmHistoryInfo";
    historyInfo.className = "nhdwBmHistoryInfo";
    filterBox.appendChild(historyInfo);
    header.appendChild(filterBox);

    const toggle = el("button");
    toggle.type = "button";
    toggle.id = "nhdwBmToggle";
    toggle.className = "nhdwBmToggle";
    toggle.addEventListener("click", () => {
        send({ action: "bookmarkCollapse", collapsed: !state.collapsed }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
            } else {
                state.collapsed = !state.collapsed;
            }
            renderList();
        });
    });
    header.appendChild(toggle);
    container.appendChild(header);

    const notice = el("div");
    notice.id = "nhdwBmNotice";
    notice.className = "nhdwBmNotice";
    notice.hidden = true;
    container.appendChild(notice);

    const body = el("div");
    body.id = "nhdwBmBody";
    container.appendChild(body);

    // Paste box: ids or links, single or batch. Two buttons because "save it
    // for later" and "get it now" are different intents over the same text.
    const pasteBox = el("div");
    pasteBox.className = "nhdwBmPasteBox";

    const pasteLabel = el("label");
    pasteLabel.textContent = "Paste gallery ids or links";
    pasteLabel.htmlFor = "nhdwBmPaste";
    pasteBox.appendChild(pasteLabel);

    const paste = el("textarea");
    paste.id = "nhdwBmPaste";
    paste.rows = 3;
    // Some browsers offer no right-click menu on extension pages, which made
    // pasting a long id list impossible. Same workaround as the API-key field.
    paste.addEventListener("paste", (event: ClipboardEvent) => {
        const data = event.clipboardData ? event.clipboardData.getData("text") : "";
        if (data && data.trim().length > 0) {
            event.preventDefault();
            paste.value = data.trim();
        }
    });
    pasteBox.appendChild(paste);

    const pasteHint = el("small");
    pasteHint.textContent = "Accepts 366224, https://nhentai.net/g/366224/, /v/366224, ranges like 366220-366224, mixed and separated by commas, spaces or new lines.";
    pasteBox.appendChild(pasteHint);

    const pasteActions = el("div");
    pasteActions.className = "nhdwBmActions";

    const addButton = el("button");
    addButton.type = "button";
    addButton.textContent = "Add to queue";
    addButton.title = "Bookmark every id in the box; titles and covers resolve in the background";
    addButton.addEventListener("click", () => { void addPasted(false); });
    pasteActions.appendChild(addButton);

    const nowButton = el("button");
    nowButton.type = "button";
    nowButton.textContent = "Download now";
    nowButton.title = "Download every id in the box immediately, without bookmarking it";
    nowButton.addEventListener("click", () => { void addPasted(true); });
    pasteActions.appendChild(nowButton);

    pasteBox.appendChild(pasteActions);
    body.appendChild(pasteBox);

    // Toolbar
    const toolbar = el("div");
    toolbar.className = "nhdwBmToolbar";

    // Item 68: search and filters. The search is a plain input: this document
    // is a page, so a <form> would reload the panel on Enter.
    const search = el("input");
    search.type = "search";
    search.id = "nhdwBmSearch";
    search.className = "nhdwBmSearch";
    search.placeholder = "Search titles, ids, tags";
    search.title = "Type part of a title, an id (240001) or a tag (artist:someone). Every word must match.";
    (search as any).setAttribute("aria-label", "Search bookmarks");
    search.addEventListener("input", () => {
        bookmarkQuery = normalizeBookmarkQuery(Object.assign({}, bookmarkQuery, { text: (search as HTMLInputElement).value }));
        shownRows = BOOKMARK_PAGE_SIZE;
        renderList();
    });
    toolbar.appendChild(search);

    const statusSelect = el("select");
    statusSelect.id = "nhdwBmStatusFilter";
    statusSelect.className = "nhdwBmQuerySelect";
    statusSelect.title = "Show only rows in one recorded state";
    (statusSelect as any).setAttribute("aria-label", "Filter bookmarks by state");
    const statusOptions: Array<{ value: string; label: string }> = [
        { value: "all", label: "Any state" },
        { value: "saved", label: "Not downloaded" },
        { value: "selected", label: "Ticked" },
        { value: "done", label: "Done" },
        { value: "failed", label: "Failed" },
        { value: "downloading", label: "Downloading" }
    ];
    for (const option of statusOptions) {
        const node = el("option");
        node.value = option.value;
        node.textContent = option.label;
        statusSelect.appendChild(node);
    }
    statusSelect.value = bookmarkQuery.status;
    statusSelect.addEventListener("change", () => {
        bookmarkQuery = normalizeBookmarkQuery(Object.assign({}, bookmarkQuery, { status: (statusSelect as HTMLSelectElement).value }));
        shownRows = BOOKMARK_PAGE_SIZE;
        renderList();
    });
    toolbar.appendChild(statusSelect);

    const dateSelect = el("select");
    dateSelect.id = "nhdwBmDateFilter";
    dateSelect.className = "nhdwBmQuerySelect";
    dateSelect.title = "Show only rows added in one window";
    (dateSelect as any).setAttribute("aria-label", "Filter bookmarks by date added");
    const dateOptions: Array<{ value: string; label: string }> = [
        { value: "all", label: "Any date" },
        { value: "today", label: "Added today" },
        { value: "week", label: "Last 7 days" },
        { value: "month", label: "Last 30 days" },
        { value: "older", label: "Older than 30 days" }
    ];
    for (const option of dateOptions) {
        const node = el("option");
        node.value = option.value;
        node.textContent = option.label;
        dateSelect.appendChild(node);
    }
    dateSelect.value = bookmarkQuery.date;
    dateSelect.addEventListener("change", () => {
        bookmarkQuery = normalizeBookmarkQuery(Object.assign({}, bookmarkQuery, { date: (dateSelect as HTMLSelectElement).value }));
        shownRows = BOOKMARK_PAGE_SIZE;
        renderList();
    });
    toolbar.appendChild(dateSelect);

    // Item 66/68: with a query on, "all" means all of the MATCHING rows. Sending
    // the whole-list form would tick rows the user cannot see, and a following
    // "Download N selected" would then fetch them. The ids travel as composite
    // keys, because a bare id reads as the default site.
    const selectAll = el("button");
    selectAll.type = "button";
    selectAll.textContent = "Select all";
    selectAll.addEventListener("click", () => {
        const message: any = isDefaultBookmarkQuery(bookmarkQuery)
            ? { action: "bookmarkSelect", all: true, selected: true }
            : { action: "bookmarkSelect", ids: bookmarkSelectionKeys(queryBookmarks(state, bookmarkQuery)), selected: true };
        send(message).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    toolbar.appendChild(selectAll);
    selectAllButton = selectAll;

    const selectNone = el("button");
    selectNone.type = "button";
    selectNone.textContent = "Select none";
    selectNone.addEventListener("click", () => {
        const message: any = isDefaultBookmarkQuery(bookmarkQuery)
            ? { action: "bookmarkSelect", all: true, selected: false }
            : { action: "bookmarkSelect", ids: bookmarkSelectionKeys(queryBookmarks(state, bookmarkQuery)), selected: false };
        send(message).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    toolbar.appendChild(selectNone);
    selectNoneButton = selectNone;

    const includeLabel = el("label");
    includeLabel.className = "nhdwBmCheck";
    includeLabel.title = "Also re-download titles the history already records";
    const includeBox = el("input");
    includeBox.type = "checkbox";
    includeBox.checked = includeAlready;
    includeBox.addEventListener("change", () => { includeAlready = includeBox.checked; });
    includeLabel.appendChild(includeBox);
    includeLabel.appendChild(document.createTextNode(" include already downloaded"));
    toolbar.appendChild(includeLabel);

    const clearButton = el("button");
    clearButton.type = "button";
    clearButton.className = "nhdwBmDanger";
    clearButton.textContent = "Clear list";
    clearButton.title = "Forget every bookmark. Files already on disk are untouched.";
    clearButton.addEventListener("click", () => {
        if (state.items.length === 0) {
            return;
        }
        if (!window.confirm("Remove all " + state.items.length + " bookmarks?\n\nFiles already downloaded stay on disk.")) {
            return;
        }
        send({ action: "bookmarkClear" }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    toolbar.appendChild(clearButton);

    body.appendChild(toolbar);

    const list = el("div");
    list.id = "nhdwBmList";
    list.className = "nhdwBmList";
    body.appendChild(list);

    const footer = el("div");
    footer.className = "nhdwBmFooter";
    const downloadSelected = el("button");
    downloadSelected.type = "button";
    downloadSelected.id = "nhdwBmDownloadSelected";
    downloadSelected.className = "nhdwBmPrimary";
    downloadSelected.title = "Download every ticked title, one file each, using the list-mode settings";
    downloadSelected.addEventListener("click", () => { void downloadSelection(); });
    footer.appendChild(downloadSelected);

    const footerHint = el("small");
    footerHint.textContent = "One file per title, named by the list-mode template in Settings. Format, folder and naming are shared with the in-page bar. The list downloads in this order - drag a row by its handle to change it.";
    footer.appendChild(footerHint);
    body.appendChild(footer);

    // ---- backup (item 52) ------------------------------------------------
    // Export/import the queue AND the history as one JSON file. Import MERGES
    // (nothing is ever deleted by a file): a wrong file cannot wipe the list,
    // and this machine's records win, because only it knows whether the file
    // is still on disk.
    const backup = el("div");
    backup.className = "nhdwBmToolbar nhdwBmBackup";

    const exportButton = el("button");
    exportButton.type = "button";
    exportButton.id = "nhdwBmExport";
    exportButton.textContent = "Export backup";
    exportButton.title = "Save the bookmark queue and the download history as one JSON file";
    exportButton.addEventListener("click", () => { void exportBackup(exportButton); });
    backup.appendChild(exportButton);

    const importInput = el("input");
    importInput.type = "file";
    importInput.accept = ".json,application/json";
    importInput.id = "nhdwBmImportFile";
    importInput.style.display = "none";
    importInput.addEventListener("change", () => { void importBackup(importInput); });
    backup.appendChild(importInput);

    const importButton = el("button");
    importButton.type = "button";
    importButton.id = "nhdwBmImport";
    importButton.textContent = "Import backup";
    importButton.title = "Merge a previously exported JSON file into this profile (nothing is removed)";
    importButton.addEventListener("click", () => importInput.click());
    backup.appendChild(importButton);

    const backupHint = el("small");
    backupHint.textContent = "Merges, never replaces: rows already here keep their status and file name.";
    backup.appendChild(backupHint);
    body.appendChild(backup);
}

// ---- entry point ---------------------------------------------------------

export function renderBookmarks(container: HTMLElement): void {
    if (!built) {
        buildChrome(container);
        built = true;
    }
    // Item 66: the remembered filter is read first, so the very first paint is
    // already filtered (and re-read on every open, so a change made in the
    // other surface - popup vs side panel vs the site drawer - is picked up).
    readSiteFilter(() => {
        // Item 68: the marks are history, so read it before the first paint.
        // Then keep watching: a download that settles while the tab is open
        // ticks its row without a reopen.
        watchHistoryChanges();
        void refreshHistory().then(() => {
            send({ action: "bookmarkGet" }).then((response) => {
                state = response && response.state ? normalizeBookmarkState(response.state) : emptyBookmarkState();
                renderList();
            });
        });
    });
}

// Live updates: the worker broadcasts after every mutation, including the ones
// it makes on its own when a download settles. Registered once.
let listening = false;
export function watchBookmarkChanges(): void {
    if (listening) {
        return;
    }
    listening = true;
    try {
        chrome.runtime.onMessage.addListener((request: any) => {
            if (!request || request.action !== "bookmarkChanged") {
                return;
            }
            if (request.state) {
                state = normalizeBookmarkState(request.state);
            }
            if (built) {
                renderList();
            }
        });
    } catch (_) { /* no runtime: single-shot render only */ }
}
