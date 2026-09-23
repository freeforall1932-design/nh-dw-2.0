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
    emptyBookmarkState,
    normalizeBookmarkState,
    parseGalleryInput,
    planBookmarkDownload
} from "../utils/bookmarkQueue";
import { historyIds, readHistory } from "../utils/downloadHistory";
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
async function startDownload(ids: string[], titles: Record<string, string>, fromQueue: boolean): Promise<void> {
    if (ids.length === 0) {
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
        // after the first broadcast.
        await send({ action: "bookmarkMarkDownloading", ids: ids });
    }
    const response = await send({
        action: "downloadAllDoujinshis",
        allDoujinshis: titles,
        galleryMetadata: {},
        finalName: "bookmarks",
        tabId: tabId,
        formatOverride: settings.format,
        // Always one file per title (see the file header).
        separate: true,
        masterFolder: resolveMasterFolder(settings),
        nameTemplate: settings.template
    });
    if (response === null) {
        showNotice("The extension worker did not answer. Reopen the panel and try again.", true);
        return;
    }
    if (response.result === "queued") {
        showNotice(ids.length === 1
            ? "Queued behind the download already running."
            : ids.length + " titles queued behind the download already running.");
        return;
    }
    showNotice(ids.length === 1
        ? "Downloading 1 title."
        : "Downloading " + ids.length + " titles, one file each.");
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
    const plan = planBookmarkDownload(state, history, includeAlready ? state.items.filter((item) => item.selected).map((item) => item.id) : []);
    if (plan.download.length === 0) {
        if (plan.skip.length > 0) {
            showNotice("All " + plan.skip.length + " selected titles are already downloaded. Tick \"include already downloaded\" to fetch them again.", true);
        } else {
            showNotice("Nothing selected.", true);
        }
        return;
    }
    const suffix = plan.skip.length > 0 ? " (" + plan.skip.length + " already downloaded skipped)" : "";
    showNotice("Starting " + plan.download.length + (plan.download.length === 1 ? " title" : " titles") + suffix + "\u2026");
    await startDownload(plan.download, plan.titles, true);
}

async function downloadOne(item: BookmarkItem): Promise<void> {
    const titles: Record<string, string> = {};
    titles[item.id] = item.title !== "" ? item.title : item.id;
    await startDownload([item.id], titles, true);
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
        await startDownload(parsed.ids, titles, false);
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

    dockButton.textContent = state.collapsed ? "Expand \u25be" : "Minimise \u25b4";
    dockButton.title = state.collapsed
        ? "Show the bookmark list"
        : "Collapse to a single bar - the list itself is saved either way";

    downloadButton.disabled = selectedCount === 0;
    downloadButton.textContent = selectedCount > 0
        ? "Download " + selectedCount + " selected"
        : "Download selected";

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
    for (const item of state.items) {
        list.appendChild(buildRow(item));
    }
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

    const selectAll = el("button");
    selectAll.type = "button";
    selectAll.textContent = "Select all";
    selectAll.addEventListener("click", () => {
        send({ action: "bookmarkSelect", all: true, selected: true }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    toolbar.appendChild(selectAll);

    const selectNone = el("button");
    selectNone.type = "button";
    selectNone.textContent = "Select none";
    selectNone.addEventListener("click", () => {
        send({ action: "bookmarkSelect", all: true, selected: false }).then((response) => {
            if (response && response.state) {
                state = normalizeBookmarkState(response.state);
                renderList();
            }
        });
    });
    toolbar.appendChild(selectNone);

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
    send({ action: "bookmarkGet" }).then((response) => {
        state = response && response.state ? normalizeBookmarkState(response.state) : emptyBookmarkState();
        renderList();
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
