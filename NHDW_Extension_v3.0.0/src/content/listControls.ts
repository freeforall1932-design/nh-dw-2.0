// In-page controls on listing cards (homepage, search, artist, tag, group,
// character, language, favourites...).
//
// Why: opening the extension for every download is a hassle. Each gallery card
// gets its own Download button and Select box, and a floating action bar shows
// "N selected -> format -> Download" without ever opening the panel. This is
// the rule34-style workflow the user asked for.
//
// Design rules that matter here:
//   * Idempotent injection + MutationObserver, so infinite scroll / pagination
//     / SPA-ish re-renders never produce duplicate buttons and never miss new
//     cards.
//   * Selection state is the SAME chrome.storage.local "allIds" list the panel
//     reads, so the two stay in sync in both directions.
//   * Downloads are sent to the service worker with the same message and the
//     same shared format registry the panel uses - the pipeline is identical,
//     the entry point is the only difference.
//   * The legacy caption checkbox (content.ts) is hidden while these controls
//     are on, so there is only one selection affordance on a card.

import {
    DOWNLOAD_FORMATS,
    DownloadFormat,
    OutputMode,
    effectiveOutputMode,
    formatLabel,
    normalizeFormat,
    normalizeOutputMode,
    outputModeToSeparate,
    shouldWarnPdfMerge,
    resolveListFormat,
    resolveListTemplate,
    LIST_MODE_DEFAULTS,
    PDF_MERGE_WARNING_KEY
} from "../utils/downloadFormats";
import { readHistory, partitionKnown, DownloadHistory, DOWNLOAD_HISTORY_KEY } from "../utils/downloadHistory";

interface CardInfo {
    id: string;
    title: string;
    card: HTMLElement;
}

const CONTROL_CLASS = "nhdw-card-controls";
const MARKER_ATTR = "data-nhdw-controls";

let settings = {
    format: "zip" as DownloadFormat,
    outputMode: "separate" as OutputMode,
    masterFolder: true,
    masterFolderName: "NHDW",
    template: "{pretty}",
    pdfMergeWarnDismissed: false
};

const selected = new Set<string>();
const titleById: Record<string, string> = {};

// Persistent download history (chrome.storage.local), shared with the panel:
// already-downloaded cards are labelled and skipped on re-run unless the user
// explicitly re-downloads them (per-card confirmation / bar checkbox).
let history: DownloadHistory = {};
const forcedIds = new Set<string>();
let includeAlready = false;

function readHistoryState(): Promise<void> {
    return readHistory().then((stored) => {
        history = stored;
    });
}

// ---- storage helpers -----------------------------------------------------

function readSelection(): Promise<void> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ allIds: [] }, (elems: any) => {
                selected.clear();
                const ids = elems && Array.isArray(elems.allIds) ? elems.allIds : [];
                for (const id of ids) {
                    selected.add(String(id));
                }
                resolve();
            });
        } catch (_) {
            resolve();
        }
    });
}

function persistSelection(): void {
    try {
        chrome.storage.local.set({ allIds: Array.from(selected) });
    } catch (_) { /* selection is best-effort */ }
}

function readSettings(): Promise<boolean> {
    return new Promise((resolve) => {
        const defaults: any = Object.assign({
            useZip: "zip",
            downloadName: "{pretty}",
            rawMasterFolder: "NHDW",
            inPageControls: true
        }, LIST_MODE_DEFAULTS);
        try {
            chrome.storage.sync.get(defaults, (elems: any) => {
                const stored = elems || defaults;
                settings.format = resolveListFormat(stored.listFormat, stored.useZip);
                settings.outputMode = normalizeOutputMode(stored.listOutputMode, "separate");
                settings.masterFolder = stored.listMasterFolder === undefined ? true : !!stored.listMasterFolder;
                settings.masterFolderName = String(stored.rawMasterFolder === undefined ? "NHDW" : stored.rawMasterFolder);
                settings.template = resolveListTemplate(stored.listDownloadName, String(stored.downloadName || "{pretty}"));
                const enabled = stored.inPageControls === undefined ? true : !!stored.inPageControls;
                try {
                    const localDefaults: any = {};
                    localDefaults[PDF_MERGE_WARNING_KEY] = false;
                    chrome.storage.local.get(localDefaults, (localElems: any) => {
                        settings.pdfMergeWarnDismissed = !!(localElems && localElems[PDF_MERGE_WARNING_KEY]);
                        resolve(enabled);
                    });
                } catch (_) {
                    resolve(enabled);
                }
            });
        } catch (_) {
            resolve(false);
        }
    });
}

function saveListSetting(patch: Record<string, any>): void {
    try {
        chrome.storage.sync.set(patch);
    } catch (_) { /* best effort */ }
}

// ---- card discovery ------------------------------------------------------

// On nhentai the caption sits INSIDE the cover link
// (<a class="cover" href="/g/123/"><img><div class="caption">Title</div></a>),
// so the gallery container is the link's parent (.gallery / .gallery-favorite).
function findCards(): CardInfo[] {
    const cards: CardInfo[] = [];
    const seen = new Set<string>();
    const links = document.querySelectorAll('a[href*="/g/"]');
    links.forEach((link) => {
        const match = /\/g\/([0-9]+)\//.exec(link.getAttribute("href") || "");
        if (match === null) {
            return;
        }
        const caption = link.querySelector(".caption");
        if (caption === null) {
            return; // not a listing card (e.g. a plain in-text link)
        }
        const id = match[1];
        if (seen.has(id)) {
            return; // the same gallery can appear on several cards
        }
        seen.add(id);
        const container = (link.parentElement as HTMLElement) || (link as HTMLElement);
        const title = (caption.textContent || "").replace(/NHentai Downloader:[\s\S]*$/, "").trim();
        titleById[id] = title;
        cards.push({ id: id, title: title, card: container });
    });
    return cards;
}

// ---- per-card controls ---------------------------------------------------

function buildCardControls(info: CardInfo): HTMLElement {
    const box = document.createElement("div");
    box.className = CONTROL_CLASS;

    const selectLabel = document.createElement("label");
    selectLabel.className = "nhdw-select";
    selectLabel.title = "Select this gallery";
    const selectBox = document.createElement("input");
    selectBox.type = "checkbox";
    selectBox.className = "nhdw-select-box";
    selectBox.checked = selected.has(info.id);
    selectBox.addEventListener("click", (event) => event.stopPropagation());
    selectBox.addEventListener("change", (event) => {
        event.stopPropagation();
        if (selectBox.checked) {
            selected.add(info.id);
        } else {
            selected.delete(info.id);
        }
        persistSelection();
        syncLegacyCheckbox(info.id, selectBox.checked);
        renderActionBar();
    });
    selectLabel.appendChild(selectBox);
    box.appendChild(selectLabel);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "nhdw-download";
    const recorded = history[info.id];
    downloadButton.textContent = recorded ? "Downloaded" : "Download";
    downloadButton.title = recorded
        ? "Already downloaded as " + recorded.filename + ". Click to download it again."
        : "Download this gallery with the current list-mode settings";
    downloadButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const single: Record<string, string> = {};
        single[info.id] = info.title || info.id;
        // Per-download "download anyway": an already-downloaded card asks for
        // an explicit confirmation instead of silently re-downloading.
        if (history[info.id]) {
            const again = window.confirm(
                "Already downloaded as:\n" + history[info.id].filename +
                "\n\nDownload it again?");
            if (!again) {
                flashStatus("Already downloaded - cancel again to re-download");
                return;
            }
            forcedIds.add(info.id);
        }
        downloadButton.disabled = true;
        downloadButton.textContent = "Queued";
        // A single card is always one title: no merge risk, so no warning.
        startDownload(single, "separate", forcedIds.has(info.id) ? [info.id] : []);
        setTimeout(() => {
            downloadButton.disabled = false;
            downloadButton.textContent = history[info.id] ? "Downloaded" : "Download";
        }, 2500);
    });
    box.appendChild(downloadButton);

    return box;
}

// Keep the legacy caption checkbox (content.ts) in step when it is visible.
function syncLegacyCheckbox(id: string, checked: boolean): void {
    const legacy = document.getElementById(id) as HTMLInputElement | null;
    if (legacy && legacy.type === "checkbox") {
        legacy.checked = checked;
    }
}

function injectCardControls(): void {
    const cards = findCards();
    for (const info of cards) {
        if (info.card.getAttribute(MARKER_ATTR) === info.id) {
            // Already decorated: refresh checkbox AND history-driven label.
            const existing = info.card.querySelector("." + CONTROL_CLASS + " .nhdw-select-box") as HTMLInputElement | null;
            if (existing) {
                existing.checked = selected.has(info.id);
            }
            const existingButton = info.card.querySelector("." + CONTROL_CLASS + " .nhdw-download") as HTMLButtonElement | null;
            if (existingButton) {
                existingButton.textContent = history[info.id] ? "Downloaded" : "Download";
            }
            continue;
        }
        info.card.setAttribute(MARKER_ATTR, info.id);
        info.card.classList.add("nhdw-card");
        info.card.appendChild(buildCardControls(info));
    }
}

// ---- floating action bar -------------------------------------------------

let actionBar: HTMLElement | null = null;

function buildActionBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.id = "nhdw-action-bar";
    bar.className = "nhdw-action-bar";

    const count = document.createElement("span");
    count.className = "nhdw-count";
    count.id = "nhdw-count";
    bar.appendChild(count);

    const formatSelect = document.createElement("select");
    formatSelect.id = "nhdw-format";
    formatSelect.title = "Download format";
    for (const format of DOWNLOAD_FORMATS) {
        const option = document.createElement("option");
        option.value = format;
        option.textContent = formatLabel(format);
        if (format === settings.format) {
            option.selected = true;
        }
        formatSelect.appendChild(option);
    }
    formatSelect.addEventListener("change", () => {
        settings.format = normalizeFormat(formatSelect.value, settings.format);
        saveListSetting({ listFormat: settings.format });
        renderActionBar();
    });
    bar.appendChild(formatSelect);

    const modeSelect = document.createElement("select");
    modeSelect.id = "nhdw-output";
    modeSelect.title = "One file per title, or everything merged into one file";
    const modes: Array<{ value: OutputMode; label: string }> = [
        { value: "separate", label: "Separate files" },
        { value: "batch", label: "One merged file" }
    ];
    for (const mode of modes) {
        const option = document.createElement("option");
        option.value = mode.value;
        option.textContent = mode.label;
        if (mode.value === settings.outputMode) {
            option.selected = true;
        }
        modeSelect.appendChild(option);
    }
    modeSelect.addEventListener("change", () => {
        settings.outputMode = normalizeOutputMode(modeSelect.value, settings.outputMode);
        saveListSetting({ listOutputMode: settings.outputMode });
        renderActionBar();
    });
    bar.appendChild(modeSelect);

    // Bulk "download anyway": only visible while the selection contains
    // already-downloaded galleries. Per-card confirmations remain available.
    const redownloadRow = document.createElement("label");
    redownloadRow.className = "nhdw-redownload-row";
    redownloadRow.id = "nhdw-redownload-row";
    const redownloadBox = document.createElement("input");
    redownloadBox.type = "checkbox";
    redownloadBox.id = "nhdw-redownload";
    redownloadBox.addEventListener("change", () => {
        includeAlready = redownloadBox.checked;
        renderActionBar();
    });
    redownloadRow.appendChild(redownloadBox);
    redownloadRow.appendChild(document.createTextNode(" Include already downloaded"));
    bar.appendChild(redownloadRow);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.id = "nhdw-download-selected";
    downloadButton.className = "nhdw-primary";
    downloadButton.textContent = "Download";
    downloadButton.addEventListener("click", () => {
        const chosen: Record<string, string> = {};
        selected.forEach((id) => {
            chosen[id] = titleById[id] || id;
        });
        if (Object.keys(chosen).length === 0) {
            return;
        }
        // "Download anyway" ids: per-card confirmations plus the bulk toggle.
        const forced: string[] = [];
        selected.forEach((id) => {
            if (forcedIds.has(id) || (includeAlready && history[id])) {
                forced.push(id);
            }
        });
        startDownload(chosen, settings.outputMode, forced);
    });
    bar.appendChild(downloadButton);

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.id = "nhdw-clear-selected";
    clearButton.textContent = "Clear";
    clearButton.addEventListener("click", () => {
        selected.clear();
        persistSelection();
        document.querySelectorAll<HTMLInputElement>("." + CONTROL_CLASS + " .nhdw-select-box").forEach((box) => {
            box.checked = false;
        });
        document.querySelectorAll<HTMLInputElement>('.caption input[type="checkbox"]').forEach((box) => {
            box.checked = false;
        });
        renderActionBar();
    });
    bar.appendChild(clearButton);

    return bar;
}

function renderActionBar(): void {
    if (actionBar === null) {
        return;
    }
    const count = document.getElementById("nhdw-count");
    const selectedIds = Array.from(selected);
    const alreadySelected = selectedIds.filter((id) => !!history[id]);
    const skipped = alreadySelected.filter((id) => !forcedIds.has(id) && !includeAlready);
    const mode = effectiveOutputMode(settings.format, settings.outputMode);
    if (count) {
        if (skipped.length > 0) {
            count.textContent = mode === "batch"
                ? selectedIds.length + " selected · " + skipped.length + " already downloaded (merged re-downloads them into one file)"
                : selectedIds.length + " selected · " + skipped.length + " already downloaded · "
                    + (selectedIds.length - skipped.length) + " will download";
        } else if (alreadySelected.length > 0 && mode === "batch") {
            count.textContent = selectedIds.length + " selected · " + alreadySelected.length
                + " already downloaded (merged re-downloads them into one file)";
        } else {
            count.textContent = selectedIds.length + " selected";
        }
    }
    const redownloadRow = document.getElementById("nhdw-redownload-row");
    if (redownloadRow) {
        // Merged mode never skips (one archive needs every selected title), so
        // the bulk override would be meaningless there.
        redownloadRow.hidden = alreadySelected.length === 0 || mode === "batch";
        const box = document.getElementById("nhdw-redownload") as HTMLInputElement | null;
        if (box) {
            box.checked = includeAlready;
        }
    }
    const modeSelect = document.getElementById("nhdw-output") as HTMLSelectElement | null;
    if (modeSelect) {
        // Raw has no container to merge into: it is always one folder per
        // title, so the merged option is not offered for it.
        modeSelect.disabled = settings.format === "raw";
        modeSelect.value = effectiveOutputMode(settings.format, settings.outputMode);
    }
    actionBar.classList.toggle("nhdw-hidden", selected.size === 0);
}

// ---- download ------------------------------------------------------------

function startDownload(galleries: Record<string, string>, outputMode: OutputMode, redownload: string[] = []): void {
    const force = new Set(redownload.map(String));
    const effective = effectiveOutputMode(settings.format, outputMode);
    // Persistent history: separate mode drops already-downloaded galleries
    // (minus the per-download "download anyway" picks) BEFORE sending, so the
    // skipped ones cost zero API calls. Merged mode keeps every title (the one
    // archive needs them all; it re-records everything only when the whole
    // job succeeds).
    let toDownload: Record<string, string> = {};
    let redownloadIds: string[] = [];
    let skippedCount = 0;
    if (effective === "separate") {
        const download = partitionKnown(history, Object.keys(galleries), redownload).download;
        for (const id of download) {
            toDownload[id] = galleries[id];
        }
        skippedCount = Object.keys(galleries).length - download.length;
    } else {
        toDownload = galleries;
    }
    redownloadIds = Object.keys(galleries).filter((id) => force.has(id));
    let titleCount = Object.keys(toDownload).length;
    if (titleCount === 0) {
        flashStatus("All selected are already downloaded - use Download anyway to re-fetch");
        return;
    }
    let mode = effectiveOutputMode(settings.format, outputMode);
    if (shouldWarnPdfMerge(settings.format, mode, titleCount) && !settings.pdfMergeWarnDismissed) {
        // Same guard as the panel: never merge different titles into one PDF
        // by accident. The page context has no room for the full modal, so the
        // safe path is offered through the native confirmation, defaulting to
        // separate files when the user declines the merge.
        const merge = window.confirm(
            "Merge " + titleCount + " different titles into a single PDF?\n\n" +
            "Batch PDF combines every selected gallery into one continuous document, " +
            "like a tankoubon - the individual titles cannot be separated afterwards.\n\n" +
            "OK = merge anyway.\nCancel = download one PDF per title (recommended).");
        if (!merge) {
            mode = "separate";
        }
    }
    if (effective === "batch" && mode === "separate") {
        // The merge warning just downgraded this job to separate files, so the
        // history skip applies NOW: drop the recorded galleries here instead of
        // sending them to be resolved and skipped downstream. Otherwise the
        // counts shown to the user do not match what is sent, and the skipped
        // titles cost metadata/API calls they were supposed to cost zero
        // (3.5.0 invariant).
        const keep = partitionKnown(history, Object.keys(galleries), redownload).download;
        toDownload = {};
        for (const id of keep) {
            toDownload[id] = galleries[id];
        }
        skippedCount = Object.keys(galleries).length - keep.length;
        titleCount = Object.keys(toDownload).length;
        if (titleCount === 0) {
            flashStatus("All selected are already downloaded - use Download anyway to re-fetch");
            return;
        }
    }
    const message: any = {
        action: "downloadAllDoujinshis",
        allDoujinshis: toDownload,
        galleryMetadata: {},
        finalName: document.title.replace(/[\\/:*?"<>|]/g, "").trim() || "nhentai",
        formatOverride: settings.format,
        separate: outputModeToSeparate(settings.format, mode),
        masterFolder: settings.masterFolder ? settings.masterFolderName : "",
        nameTemplate: settings.template,
        redownloadIds: redownloadIds
    };
    try {
        chrome.runtime.sendMessage(message, (response: any) => {
            // The worker answers { result: "started" | "queued" }; the panel
            // shows the progress. Reading lastError keeps Chrome quiet when
            // the worker is mid-restart.
            try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
            if (response && response.result === "existing" && response.filename) {
                // Merged re-run: the same merged file still exists. Warn (the
                // user chose warn-only for merged jobs), then re-send with
                // existingConfirmed so it becomes _part2/_part3...
                const again = window.confirm(
                    "You already have:\n" + response.filename +
                    "\n\nThis download creates a NEW copy (the name gets _part2, _part3 ...).\n\nContinue?");
                if (again) {
                    message.existingConfirmed = true;
                    chrome.runtime.sendMessage(message, () => {
                        try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
                        flashStatus(skippedCount > 0
                            ? titleCount + " will download (" + skippedCount + " already downloaded skipped)"
                            : titleCount === 1 ? "Sent 1 gallery to the downloader" : "Sent " + titleCount + " galleries to the downloader");
                    });
                } else {
                    flashStatus("Already downloaded - keeping the existing file");
                }
                return;
            }
            flashStatus(skippedCount > 0
                ? titleCount + " will download (" + skippedCount + " already downloaded skipped)"
                : titleCount === 1 ? "Sent 1 gallery to the downloader" : "Sent " + titleCount + " galleries to the downloader");
        });
    } catch (_) { /* worker unreachable; nothing else to do from a page */ }
}

let statusTimer: any = null;
function flashStatus(text: string): void {
    if (actionBar === null) {
        return;
    }
    let status = document.getElementById("nhdw-status");
    if (!status) {
        status = document.createElement("span");
        status.id = "nhdw-status";
        status.className = "nhdw-status";
        actionBar.appendChild(status);
    }
    status.textContent = text;
    if (statusTimer !== null) {
        clearTimeout(statusTimer);
    }
    statusTimer = setTimeout(() => {
        if (status && status.parentElement) {
            status.parentElement.removeChild(status);
        }
    }, 4000);
}

// ---- bootstrap -----------------------------------------------------------

function start(): void {
    document.documentElement.classList.add("nhdw-controls-on");
    injectCardControls();
    if (actionBar === null) {
        actionBar = buildActionBar();
        document.body.appendChild(actionBar);
    }
    renderActionBar();

    // Infinite scroll / pagination / late-rendered cards: re-run the
    // idempotent injection whenever new nodes appear. Debounced so a burst of
    // mutations costs one pass.
    let pending: any = null;
    const observer = new MutationObserver(() => {
        if (pending !== null) {
            return;
        }
        pending = setTimeout(() => {
            pending = null;
            injectCardControls();
        }, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // The panel writes the same selection list; mirror its changes back into
    // the page so the two views never disagree.
    try {
        chrome.storage.onChanged.addListener((changes: any, area: string) => {
            if (area !== "local" || !changes) {
                return;
            }
            if (changes.allIds) {
                readSelection().then(() => {
                    injectCardControls();
                    renderActionBar();
                });
            }
            if (changes[DOWNLOAD_HISTORY_KEY]) {
                // History changed (a download completed / was cleared): refresh
                // card labels and the bar counts.
                readHistoryState().then(() => {
                    injectCardControls();
                    renderActionBar();
                });
            }
        });
    } catch (_) { /* not fatal */ }
}

// Single-gallery pages have no listing cards, so nothing is injected there.
if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    readSettings().then((enabled) => {
        if (!enabled) {
            return;
        }
        readSelection().then(() => {
            readHistoryState().then(() => {
                if (document.readyState === "loading") {
                    document.addEventListener("DOMContentLoaded", start);
                } else {
                    start();
                }
            });
        });
    });
}
