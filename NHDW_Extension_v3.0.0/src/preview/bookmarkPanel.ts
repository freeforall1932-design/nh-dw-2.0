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
import { readListSettings, resolveMasterFolder, ListModeSettings } from "../utils/listSettings";
import { getActiveTabId } from "./activeTabGallery";

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
    const tabId = await getActiveTabId();
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
    showNotice("Bookmarked " + added + (added === 1 ? " title" : " titles") + rejectedNote + truncatedNote + ". Resolving titles\u2026");
    // A pasted id has no title and no thumbnail: ask the worker to resolve it
    // through the open nhentai tab, the same route the panel's own resolver
    // uses. Rows stay usable (and downloadable) even when this fails.
    const enriched = await send({ action: "bookmarkEnrich", ids: parsed.ids });
    if (enriched && enriched.state) {
        state = normalizeBookmarkState(enriched.state);
        renderList();
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

    list.textContent = "";
    if (total === 0) {
        const empty = el("div");
        empty.className = "nhdwBmEmpty";
        empty.textContent = "Nothing bookmarked yet. Click the \u2606 on a gallery card, paste ids below, or turn on auto-capture in Settings.";
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
    footerHint.textContent = "One file per title, named by the list-mode template in Settings. Format, folder and naming are shared with the in-page bar.";
    footer.appendChild(footerHint);
    body.appendChild(footer);
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
