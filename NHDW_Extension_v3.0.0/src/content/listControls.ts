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
import { splitGalleryKey, toGalleryKey } from "../utils/siteKeys";
import { getSourceForUrl } from "../sources/index";
import { ListCardTarget, cardIdFromHref, resolveListCardPage } from "../utils/listCards";
// Bookmark queue: the persistent "titles I clicked Bookmark on" list. The
// content script only READS the stored list directly (to render the on/off
// icon) — every WRITE goes through the worker, which is the single writer, so
// a card bookmark landing while the panel mutates the list cannot clobber it.
import { BOOKMARK_QUEUE_KEY, BookmarkState, normalizeBookmarkState } from "../utils/bookmarkQueue";
// Shared bookmark glyph (also used by the gallery-page button in
// js/titleBookmark.js): one icon definition, so both affordances always look
// like the same control.
import { BOOKMARK_ICON_OUTLINE_PATH, BOOKMARK_ICON_PATH, BOOKMARK_ICON_VIEWBOX } from "../utils/titleBookmark";
// Item 70: the live-session harvest - read what the tab already rendered, keep
// collecting as the page mutates, and let one click stop it. The pure core is
// shared with the unit tests; this file is only the DOM adapter.
import {
    HARVEST_INTERVAL_MS,
    HARVEST_MAX_ITEMS,
    HARVEST_MAX_ROUNDS,
    HARVEST_STORAGE_KEY,
    HarvestState,
    HarvestStopReason,
    emptyHarvestState,
    harvestAddCards,
    harvestShouldContinue,
    harvestSummary,
    isHarvestRun,
    mergeHarvestIntoSelection,
    nextHarvestRound,
    normalizeHarvestState,
    selectionKeyMatchesSite,
    startHarvest,
    stopHarvest
} from "../utils/listHarvest";


interface CardInfo {
    id: string;
    site: string;
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
    pdfMergeWarnDismissed: false,
    // Auto-capture: while on, every listing card found is bookmarked without a
    // click. Default OFF — on a 60-card search page it would silently build a
    // 60-item list the user never asked for. One click turns it on.
    bookmarkAutoCapture: false,
    // Item 70: the harvest's optional auto-scroll. Default OFF (item 70's own
    // wording): a page that starts scrolling itself uninvited is alarming, so
    // it is a remembered choice the user turns on once.
    harvestAutoScroll: false
};

const selected = new Set<string>();
const titleById: Record<string, string> = {};

// Persistent download history (chrome.storage.local), shared with the panel:
// already-downloaded cards are labelled and skipped on re-run unless the user
// explicitly re-downloads them (per-card confirmation / bar checkbox).
let history: DownloadHistory = {};
const forcedIds = new Set<string>();
let includeAlready = false;

// Item 70: the harvest run. `harvestToken` mirrors harvest.run while a run is
// live, and every callback checks it before writing - that is what makes Stop
// authoritative even though a timer may already be in flight.
let harvest: HarvestState = emptyHarvestState();
let harvestToken = 0;
let harvestTimer: any = null;

function readHistoryState(): Promise<void> {
    return readHistory().then((stored) => {
        history = stored;
    });
}

// ---- bookmark queue ------------------------------------------------------

// Mirror of the stored bookmark list, read directly so painting the bookmark
// button does not cost a worker round trip. Writes always go through the
// worker. The Set is the id index: it is rebuilt on every storage read and
// updated optimistically on click, so the button flips the instant it is
// clicked instead of after the round trip (the storage event then confirms
// it).
let bookmarkState: BookmarkState = normalizeBookmarkState(null);
/** Ids confirmed by the last storage read. */
const bookmarkedKeys = new Set<string>();
// Unconfirmed optimistic paint: true = "I just bookmarked this", false = "I
// just removed it". Keys are composite so a same-numbered title on another
// supported site cannot borrow this page's optimistic state.
const bookmarkOverlay = new Map<string, boolean>();

function readBookmarkState(): Promise<void> {
    return new Promise((resolve) => {
        try {
            const defaults: any = {};
            defaults[BOOKMARK_QUEUE_KEY] = null;
            chrome.storage.local.get(defaults, (elems: any) => {
                bookmarkState = normalizeBookmarkState(elems && elems[BOOKMARK_QUEUE_KEY]);
                bookmarkedKeys.clear();
                for (const item of bookmarkState.items) {
                    bookmarkedKeys.add(toGalleryKey(item.id, item.site));
                }
                resolve();
            });
        } catch (_) {
            resolve();
        }
    });
}

function bookmarkKey(infoOrId: CardInfo | string, site?: string): string {
    return typeof infoOrId === "string"
        ? toGalleryKey(infoOrId, site)
        : toGalleryKey(infoOrId.id, infoOrId.site);
}

function isBookmarked(infoOrId: CardInfo | string, site?: string): boolean {
    const key = bookmarkKey(infoOrId, site);
    return bookmarkOverlay.has(key) ? bookmarkOverlay.get(key) === true : bookmarkedKeys.has(key);
}

// nhentai lazyloads covers: the real address sits in data-src while src holds a
// placeholder. Either absolute http(s) URL is usable as an <img> source in the
// panel; a data: placeholder is not worth persisting.
function cardThumbnail(card: HTMLElement): string {
    const img = card.querySelector("img");
    if (img === null) {
        return "";
    }
    const candidates = [img.getAttribute("data-src"), img.getAttribute("src")];
    for (const candidate of candidates) {
        const url = String(candidate || "").trim();
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
    }
    return "";
}

// The caption's second line carries "N pages"; reading it here means a
// bookmarked row knows its page count without a metadata request.
function cardPages(card: HTMLElement): number {
    const caption = card.querySelector(".caption");
    const text = caption === null ? "" : (caption.textContent || "");
    // Anchored to the end of the caption: unanchored, a title containing
    // "<number> pages" would be read as the page count. 0 (unknown) is the
    // correct answer when the count is not where we expect it.
    const match = /([0-9]+)\s*pages?\s*$/i.exec(text);
    return match === null ? 0 : parseInt(match[1], 10) || 0;
}

function sendBookmarkMessage(message: any): void {
    try {
        chrome.runtime.sendMessage(message, () => {
            // Reading lastError keeps Chrome quiet when the worker is
            // mid-restart; a missed bookmark is recoverable by clicking again.
            try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
        });
    } catch (_) { /* worker unreachable from this page */ }
}

function bookmarkCard(info: CardInfo, source: "card" | "auto"): void {
    sendBookmarkMessage({
        action: "bookmarkAdd",
        items: [{
            id: info.id,
            site: info.site,
            title: info.title || info.id,
            thumbnail: cardThumbnail(info.card),
            pages: cardPages(info.card),
            source: source,
            sourceUrl: typeof location !== "undefined" ? location.href : ""
        }]
    });
}

function unbookmarkCard(info: CardInfo): void {
    sendBookmarkMessage({ action: "bookmarkRemove", ids: [bookmarkKey(info)] });
}

// The glyph is an inline SVG bookmark (outline when off, filled when on) built
// with createElementNS rather than innerHTML: the extension ships under a
// CSP-friendly policy and Mozilla's linter flags innerHTML.
function buildBookmarkGlyph(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "nhdw-bookmark-glyph");
    svg.setAttribute("viewBox", BOOKMARK_ICON_VIEWBOX);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", BOOKMARK_ICON_OUTLINE_PATH);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
}

function applyBookmarkButton(button: HTMLElement, id: string, site: string = currentSite()): void {
    const on = isBookmarked(id, site);
    button.className = "nhdw-bookmark" + (on ? " nhdw-bookmark-on" : "");
    button.title = on
        ? "Bookmarked - click to take it off the bookmark list"
        : "Bookmark this title: it waits in the Bookmark panel and survives a browser restart";
    button.setAttribute("aria-pressed", on ? "true" : "false");
    const glyph = button.querySelector("svg.nhdw-bookmark-glyph path");
    if (glyph !== null) {
        glyph.setAttribute("d", on ? BOOKMARK_ICON_PATH : BOOKMARK_ICON_OUTLINE_PATH);
    }
}

// Repaint every bookmark button on the page. Called after the stored list
// changes, so a bookmark made from the panel (or removed from it) is reflected
// here too.
function refreshBookmarkButtons(): void {
    const cards = document.querySelectorAll("[" + MARKER_ATTR + "]");
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i] as HTMLElement;
        const id = card.getAttribute(MARKER_ATTR) || "";
        const button = card.querySelector("." + CONTROL_CLASS + " .nhdw-bookmark") as HTMLElement | null;
        if (button !== null && id !== "") {
            applyBookmarkButton(button, id, currentSite());
        }
    }
}

// ---- storage helpers -----------------------------------------------------

function readSelection(): Promise<void> {
    return new Promise((resolve) => {
        try {
            // allIdsSite namespaces the transient selection and has no concrete
            // default, but storage.get answers ONLY the keys named here - the
            // sibling readers (content.ts, preview.ts, titleBookmark.ts) request
            // it for exactly this reason. Without asking, the stored site is
            // invisible and the guard below can never reject a foreign list.
            chrome.storage.local.get({ allIds: [], allIdsSite: "" }, (elems: any) => {
                selected.clear();
                const storedSite = String(elems && elems.allIdsSite ? elems.allIdsSite : currentSite());
                const site = currentSite();
                const ids = elems && Array.isArray(elems.allIds) && storedSite === site ? elems.allIds : [];
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

function currentSite(): string {
    try {
        const source = getSourceForUrl(typeof location === "undefined" ? "" : location.href);
        return source ? source.site : "";
    } catch (_) {
        return "";
    }
}

function persistSelection(): void {
    try {
        chrome.storage.local.set({ allIds: Array.from(selected), allIdsSite: currentSite() });
    } catch (_) { /* selection is best-effort */ }
}

function readSettings(): Promise<boolean> {
    return new Promise((resolve) => {
        const defaults: any = Object.assign({
            useZip: "zip",
            downloadName: "{pretty}",
            rawMasterFolder: "NHDW",
            inPageControls: true,
            bookmarkAutoCapture: false,
            // Requested explicitly so a remembered choice is visible: a
            // key-scoped get answers only what the caller asks for (item 59).
            bookmarkHarvestAutoScroll: false
        }, LIST_MODE_DEFAULTS);
        try {
            // listFormat has no concrete default (unset means inherit), but
            // storage.get must still request it to see a saved list choice.
            chrome.storage.sync.get(Object.keys(defaults).concat("listFormat"), (elems: any) => {
                const stored = Object.assign({}, defaults, elems);
                settings.format = resolveListFormat(stored.listFormat, stored.useZip);
                settings.outputMode = normalizeOutputMode(stored.listOutputMode, "separate");
                settings.masterFolder = stored.listMasterFolder === undefined ? true : !!stored.listMasterFolder;
                settings.masterFolderName = String(stored.rawMasterFolder === undefined ? "NHDW" : stored.rawMasterFolder);
                settings.template = resolveListTemplate(stored.listDownloadName, String(stored.downloadName || "{pretty}"));
                settings.bookmarkAutoCapture = !!stored.bookmarkAutoCapture;
                settings.harvestAutoScroll = !!stored.bookmarkHarvestAutoScroll;
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

function querySelectorAllForSelector(selector: string): Element[] {
    const nodes: Element[] = [];
    // A table row may carry a small fallback selector list. Query each part
    // separately so old DOM stubs and browsers agree on comma handling.
    for (const part of String(selector || "").split(",")) {
        try {
            const found = document.querySelectorAll(part.trim());
            for (let i = 0; i < found.length; i++) {
                if (nodes.indexOf(found[i]) === -1) {
                    nodes.push(found[i]);
                }
            }
        } catch (_) { /* a moved/unsupported selector is simply absent */ }
    }
    return nodes;
}

function ancestorMatching(node: Element, selector: string): HTMLElement | null {
    let current: any = node;
    let hops = 0;
    while (current !== null && current !== undefined && hops < 40) {
        try {
            if (typeof current.matches === "function" && current.matches(selector)) {
                return current as HTMLElement;
            }
            const simple = /^(?:([a-z0-9-]+))?\\.([a-z0-9_-]+)$/i.exec(selector);
            if (simple !== null
                && (!simple[1] || String(current.tagName || "").toLowerCase() === simple[1].toLowerCase())
                && current.classList && current.classList.contains(simple[2])) {
                return current as HTMLElement;
            }
        } catch (_) { /* fall through to the next ancestor */ }
        current = current.parentElement;
        hops++;
    }
    return null;
}

function contentCard(link: Element, target: ListCardTarget): HTMLElement {
    let current: any = link;
    const ancestorClass = target.containerAncestorClass || "";
    while (current && current.parentElement) {
        if (ancestorClass && current.parentElement.classList
            && current.parentElement.classList.contains(ancestorClass)) {
            return current as HTMLElement;
        }
        current = current.parentElement;
    }
    return (link.parentElement as HTMLElement) || (link as HTMLElement);
}

function cardTitle(node: Element | null, fallback: string): string {
    const raw = node === null ? "" : String(node.textContent || "");
    return raw.replace(/NHentai Downloader:[\\s\\S]*$/, "").replace(/\\s+/g, " ").trim() || fallback;
}

// Discover cards through the adapter selected by the page URL. A card's own
// cover link is the only id source; title links and related text cannot create
// duplicate or cross-site rows by accident.
function findCards(): CardInfo[] {
    const cards: CardInfo[] = [];
    // Item 63's listing-only contract lives in resolveListCardPage(): it
    // refuses every supported site's single-gallery and reader URLs. A gallery
    // page's related-gallery cards match the same selectors as its listings
    // (hentaiera: div.thumb > a.inner_thumb.img_box with a .gallery_title;
    // hitomi: .gallery-content h1 a), so the guard - not the absence of
    // card-shaped markup - is what keeps the controls off title pages.
    const resolved = resolveListCardPage(typeof location === "undefined" ? "" : location.href);
    if (resolved === null) {
        return cards;
    }
    const target = resolved.target;
    const site = resolved.site;
    const seen = new Set<string>();
    const links = querySelectorAllForSelector(target.linkSelector);
    for (const link of links) {
        const id = cardIdFromHref(target, link.getAttribute("href") || "");
        if (id === null || seen.has(id)) {
            continue;
        }
        let card: HTMLElement;
        let titleNode: Element | null = null;
        if (target.mode === "link") {
            titleNode = target.captionSelector ? link.querySelector(target.captionSelector) : null;
            if (titleNode === null) {
                continue;
            }
            card = (link.parentElement as HTMLElement) || (link as HTMLElement);
        } else if (target.mode === "content") {
            card = contentCard(link, target);
            titleNode = target.titleSelector ? card.querySelector(target.titleSelector) : null;
        } else {
            card = target.containerSelector
                ? (ancestorMatching(link, target.containerSelector) || (link.parentElement as HTMLElement) || (link as HTMLElement))
                : ((link.parentElement as HTMLElement) || (link as HTMLElement));
            titleNode = target.titleSelector ? card.querySelector(target.titleSelector) : null;
        }
        seen.add(id);
        const title = cardTitle(titleNode, id);
        titleById[id] = title;
        cards.push({ id: id, site: site, title: title, card: card });
    }
    return cards;
}

// ---- per-card controls ---------------------------------------------------

function buildCardControls(info: CardInfo): HTMLElement {
    const box = document.createElement("div");
    box.className = CONTROL_CLASS;

    // Left group (Select + Bookmark); the Download button is the box's other
    // child, so the flex pair keeps it at the top-right corner of the card.
    const left = document.createElement("div");
    left.className = "nhdw-card-controls-left";

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
    left.appendChild(selectLabel);

    // Bookmark — adds this title to the persistent Queue list. Deliberately a
    // toggle: it is the only un-bookmark affordance on the page, and a one-way
    // button would force the user into the panel to undo a misclick. Small and
    // text-free by design: the card is the site's, not ours.
    const bookmarkButton = document.createElement("button");
    bookmarkButton.type = "button";
    bookmarkButton.appendChild(buildBookmarkGlyph());
    applyBookmarkButton(bookmarkButton, info.id, info.site);
    bookmarkButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = bookmarkKey(info);
        if (isBookmarked(info)) {
            bookmarkOverlay.set(key, false);
            unbookmarkCard(info);
        } else {
            bookmarkOverlay.set(key, true);
            bookmarkCard(info, "card");
        }
        // Optimistic paint: the storage round trip lands in a few ms and the
        // onChanged listener confirms it, but the click must feel instant.
        applyBookmarkButton(bookmarkButton, info.id, info.site);
    });
    left.appendChild(bookmarkButton);
    box.appendChild(left);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "nhdw-download";
    // Composite history key (siteKeys.ts): the card's bare gallery id is
    // namespaced with the default site before the lookup.
    const recorded = history[toGalleryKey(info.id, info.site)];
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
        if (history[toGalleryKey(info.id, info.site)]) {
            const again = window.confirm(
                "Already downloaded as:\n" + history[toGalleryKey(info.id, info.site)].filename +
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
        startDownload(single, "separate", forcedIds.has(info.id) ? [info.id] : [], info.site);
        setTimeout(() => {
            downloadButton.disabled = false;
            downloadButton.textContent = history[toGalleryKey(info.id, info.site)] ? "Downloaded" : "Download";
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
                existingButton.textContent = history[toGalleryKey(info.id, info.site)] ? "Downloaded" : "Download";
            }
            const existingBookmark = info.card.querySelector("." + CONTROL_CLASS + " .nhdw-bookmark") as HTMLElement | null;
            if (existingBookmark) {
                applyBookmarkButton(existingBookmark, info.id, info.site);
            }
            continue;
        }
        info.card.setAttribute(MARKER_ATTR, info.id);
        info.card.classList.add("nhdw-card");
        info.card.appendChild(buildCardControls(info));
    }
}

// Auto-capture (Settings -> Bookmark auto-capture, off by default): bookmark
// every card on the page, so scrolling a listing collects it without a click
// per title.
//
// Deliberately its OWN pass rather than a branch of injectCardControls:
// injection is idempotent by design and skips cards it already decorated, so
// auto-capture living inside it would bookmark nothing at all when the user
// flips the setting on a page that is already open. Idempotent on its own
// terms - an id already bookmarked is skipped here AND by the worker's dedupe.
function autoCaptureCards(): void {
    if (!settings.bookmarkAutoCapture) {
        return;
    }
    for (const info of findCards()) {
        if (isBookmarked(info)) {
            continue;
        }
        bookmarkOverlay.set(bookmarkKey(info), true);
        bookmarkCard(info, "auto");
        const button = info.card.querySelector("." + CONTROL_CLASS + " .nhdw-bookmark") as HTMLElement | null;
        if (button !== null) {
            applyBookmarkButton(button, info.id, info.site);
        }
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
            if (forcedIds.has(id) || (includeAlready && history[toGalleryKey(id, currentSite())])) {
                forced.push(id);
            }
        });
        startDownload(chosen, settings.outputMode, forced, currentSite());
    });
    bar.appendChild(downloadButton);

    const selectAllButton = document.createElement("button");
    selectAllButton.type = "button";
    selectAllButton.id = "nhdw-select-all";
    selectAllButton.textContent = "Select all";
    selectAllButton.title = "Select every gallery card on this page";
    selectAllButton.addEventListener("click", () => {
        for (const info of findCards()) {
            selected.add(info.id);
            syncLegacyCheckbox(info.id, true);
        }
        document.querySelectorAll<HTMLInputElement>("." + CONTROL_CLASS + " .nhdw-select-box").forEach((box) => {
            box.checked = true;
        });
        persistSelection();
        renderActionBar();
    });
    bar.appendChild(selectAllButton);

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

    // Item 70: the harvest. It sits with the bulk controls because it is one:
    // it collects every card the page renders, including the ones that appear
    // while the user reads, and feeds the very same selection.
    const harvestButton = document.createElement("button");
    harvestButton.type = "button";
    harvestButton.id = "nhdw-harvest";
    harvestButton.textContent = "Harvest";
    harvestButton.title = "Collect the cards this page has already rendered, and keep collecting as the page loads more";
    harvestButton.addEventListener("click", () => {
        if (harvest.active) {
            stopHarvestRun("stopped");
            return;
        }
        startHarvestRun();
    });
    bar.appendChild(harvestButton);

    const harvestScrollRow = document.createElement("label");
    harvestScrollRow.className = "nhdw-harvest-scroll-row";
    harvestScrollRow.id = "nhdw-harvest-scroll-row";
    const harvestScrollBox = document.createElement("input");
    harvestScrollBox.type = "checkbox";
    harvestScrollBox.id = "nhdw-harvest-scroll";
    harvestScrollBox.title = "Scroll the page for me while harvesting (bounded: it stops at the end or after " + HARVEST_MAX_ROUNDS + " steps)";
    harvestScrollBox.addEventListener("change", () => {
        settings.harvestAutoScroll = harvestScrollBox.checked;
        saveListSetting({ bookmarkHarvestAutoScroll: harvestScrollBox.checked });
        renderActionBar();
    });
    harvestScrollRow.appendChild(harvestScrollBox);
    harvestScrollRow.appendChild(document.createTextNode(" Scroll for me"));
    bar.appendChild(harvestScrollRow);

    const harvestStatus = document.createElement("span");
    harvestStatus.className = "nhdw-harvest-status";
    harvestStatus.id = "nhdw-harvest-status";
    bar.appendChild(harvestStatus);

    return bar;
}

// ---- live-session harvest (item 70) -------------------------------------

/** The cards this page has rendered right now, in page order. */
function harvestCards(): Array<{ id: string; site: string; title: string }> {
    const site = currentSite();
    return findCards().map((info) => ({
        id: info.id,
        site: site,
        title: titleById[info.id] || info.title || ""
    }));
}

function persistHarvest(): void {
    try {
        // Persisted INACTIVE: a reload cannot resume the old page's scrolling,
        // and a stored "active" flag nobody can stop would be a lie.
        const record: any = Object.assign({}, harvest, { active: false });
        chrome.storage.local.set({ [HARVEST_STORAGE_KEY]: record });
    } catch (_) { /* the harvest is a convenience; never break the page for it */ }
}

function renderHarvestBar(): void {
    const button = document.getElementById("nhdw-harvest") as HTMLButtonElement | null;
    if (button) {
        button.textContent = harvest.active ? "Stop harvest" : "Harvest";
        button.title = harvest.active
            ? "Stop collecting. Everything already collected stays in the selection."
            : "Collect the cards this page has already rendered, and keep collecting as the page loads more";
    }
    const box = document.getElementById("nhdw-harvest-scroll") as HTMLInputElement | null;
    if (box) {
        box.checked = !!settings.harvestAutoScroll;
        box.disabled = harvest.active;
    }
    const status = document.getElementById("nhdw-harvest-status");
    if (status) {
        const visible = harvest.active || harvest.cards.length > 0;
        status.textContent = visible ? harvestSummary(harvest) : "";
    }
}

/**
 * The bare ids this harvest adds to the page's selection, in merge order.
 *
 * The ORDER is the shared core's (`mergeHarvestIntoSelection`): harvest order
 * first, then whatever was already ticked, never a duplicate. That is not
 * cosmetic - `allIds` IS the download order, so the titles the user watched
 * collect stay in front. The page's selection is stamped with one site and
 * holds bare ids, so composite keys are filtered by site (the same number on
 * another site is a different title) and stripped back to ids.
 */
function harvestSelectionIds(): string[] {
    const site = currentSite();
    const ticked = Array.from(selected).map((id) => toGalleryKey(id, site));
    return mergeHarvestIntoSelection(harvest, ticked)
        .filter((key) => selectionKeyMatchesSite(key, site))
        .map((key) => splitGalleryKey(key).id);
}

/** Tick the harvested gallery ids into the shared selection. */
function applyHarvestToSelection(): void {
    const ids = harvestSelectionIds();
    selected.clear();
    for (const id of ids) {
        selected.add(id);
        syncLegacyCheckbox(id, true);
    }
    // The harvest's contract is "collect everything on this page", so every
    // decorated card is ticked - exactly what the bar's Select all does.
    document.querySelectorAll<HTMLInputElement>("." + CONTROL_CLASS + " .nhdw-select-box").forEach((box) => {
        box.checked = true;
    });
    persistSelection();
}

function collectHarvest(): void {
    if (!isHarvestRun(harvest, harvestToken)) {
        return;
    }
    const result = harvestAddCards(harvest, harvestCards());
    harvest = result.state;
    if (result.added > 0) {
        applyHarvestToSelection();
    }
    persistHarvest();
}

function pageScrollState(): { top: number; height: number; viewport: number } {
    const doc: any = typeof document === "undefined" ? null : document.documentElement;
    const body: any = typeof document === "undefined" ? null : document.body;
    const top = Math.max(Number(doc && doc.scrollTop) || 0, Number(body && body.scrollTop) || 0);
    const height = Math.max(Number(doc && doc.scrollHeight) || 0, Number(body && body.scrollHeight) || 0);
    const viewport = Number(typeof window === "undefined" ? 0 : (window as any).innerHeight) || 0;
    return { top: top, height: height, viewport: viewport };
}

/** True when the page cannot scroll any further, so the run should end. */
function atPageBottom(): boolean {
    const state = pageScrollState();
    if (state.height <= 0 || state.viewport <= 0) {
        return false;
    }
    return state.top + state.viewport >= state.height - 24;
}

/** One auto-scroll step. False when this page cannot be scrolled at all. */
function scrollPageStep(): boolean {
    try {
        const win: any = typeof window === "undefined" ? null : window;
        if (win === null) {
            return false;
        }
        const viewport = Number(win.innerHeight) || 0;
        if (typeof win.scrollBy === "function") {
            win.scrollBy(0, Math.max(400, viewport));
            return true;
        }
        if (typeof win.scrollTo === "function") {
            const state = pageScrollState();
            if (state.height > 0) {
                win.scrollTo(0, state.height);
                return true;
            }
        }
    } catch (_) { /* a page that refuses to scroll just ends the run */ }
    return false;
}

function stopHarvestRun(reason: HarvestStopReason): void {
    harvest = stopHarvest(harvest, reason);
    if (harvestTimer !== null) {
        clearTimeout(harvestTimer);
        harvestTimer = null;
    }
    persistHarvest();
    renderActionBar();
}

/**
 * One auto-scroll round: collect what is there, count the round, and stop for a
 * named reason instead of scrolling a site forever. The observer covers the
 * non-auto-scroll case (the user scrolls, the site renders, we collect), so the
 * timer only exists while auto-scroll is on.
 */
function harvestTick(): void {
    harvestTimer = null;
    if (!isHarvestRun(harvest, harvestToken)) {
        return;
    }
    collectHarvest();
    harvest = nextHarvestRound(harvest, Date.now());
    harvestToken = harvest.run;
    persistHarvest();
    if (!harvestShouldContinue(harvest)) {
        // Both caps land here; the reason tells the user which one.
        stopHarvestRun(harvest.cards.length >= HARVEST_MAX_ITEMS ? "limit" : "rounds");
        return;
    }
    if (atPageBottom()) {
        stopHarvestRun("bottom");
        return;
    }
    if (!scrollPageStep()) {
        stopHarvestRun("stopped");
        return;
    }
    renderActionBar();
    scheduleHarvestTick();
}

function scheduleHarvestTick(): void {
    if (harvestTimer !== null) {
        clearTimeout(harvestTimer);
    }
    harvestTimer = setTimeout(harvestTick, HARVEST_INTERVAL_MS);
}

function startHarvestRun(): void {
    harvest = startHarvest(harvest, !!settings.harvestAutoScroll);
    harvestToken = harvest.run;
    collectHarvest();
    renderActionBar();
    if (harvest.autoScroll && harvest.active) {
        scheduleHarvestTick();
    }
}

/** Restore the persisted harvest and merge it into the selection (item 70). */
function readHarvestState(): Promise<void> {
    return new Promise((resolve) => {
        try {
            const defaults: any = {};
            defaults[HARVEST_STORAGE_KEY] = null;
            chrome.storage.local.get(defaults, (elems: any) => {
                harvest = normalizeHarvestState(elems && elems[HARVEST_STORAGE_KEY]);
                if (harvest.cards.length > 0) {
                    // Only this page's own namespace: the same gallery number
                    // on another site is a different title (item 48's lesson).
                    const merged = harvestSelectionIds();
                    const before = Array.from(selected).join(",");
                    selected.clear();
                    for (const id of merged) {
                        selected.add(id);
                    }
                    if (Array.from(selected).join(",") !== before) {
                        persistSelection();
                    }
                    // Write the normalized, inactive copy back so the stored
                    // shape is always the one this version understands.
                    persistHarvest();
                }
                resolve();
            });
        } catch (_) {
            resolve();
        }
    });
}

function renderActionBar(): void {
    if (actionBar === null) {
        return;
    }
    const count = document.getElementById("nhdw-count");
    const selectedIds = Array.from(selected);
    const site = currentSite();
    const alreadySelected = selectedIds.filter((id) => !!history[toGalleryKey(id, site)]);
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
    renderHarvestBar();
    // Select-all is useful before anything is checked, so the bar is a listing
    // affordance rather than a selection-only affordance. Hide it only when a
    // page has no discoverable cards at all.
    actionBar.classList.toggle("nhdw-hidden", findCards().length === 0);
}

// ---- download ------------------------------------------------------------

function startDownload(galleries: Record<string, string>, outputMode: OutputMode, redownload: string[] = [], site: string = currentSite()): void {
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
        const download = partitionKnown(history, Object.keys(galleries), redownload, site).download;
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
        const keep = partitionKnown(history, Object.keys(galleries), redownload, site).download;
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
        redownloadIds: redownloadIds,
        site: site
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
    autoCaptureCards();
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
            autoCaptureCards();
            // Item 70: the site rendered more cards (infinite scroll,
            // pagination, a late chunk) - a live harvest takes them.
            if (harvest.active) {
                collectHarvest();
            }
            renderActionBar();
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
            if (changes[BOOKMARK_QUEUE_KEY]) {
                // The bookmark list changed — from a card click here, from the
                // panel, or from the worker settling a download. Re-read and
                // repaint the stars; never re-run the full injection, so an
                // auto-capture write cannot feed back into itself.
                readBookmarkState().then(refreshBookmarkButtons);
            }
        });
    } catch (_) { /* not fatal */ }

    // Auto-capture is a Settings toggle: flipping it must apply to the page
    // that is already open, without a reload. Reached through `as any` because
    // the pinned @types/chrome (0.0.154, 2021) predates
    // StorageArea.onChanged — the same workaround the worker uses for
    // chrome.sidePanel.
    try {
        (chrome.storage.sync as any).onChanged.addListener((changes: any, area: string) => {
            if (area === "sync" && changes && changes.bookmarkAutoCapture) {
                settings.bookmarkAutoCapture = !!(changes.bookmarkAutoCapture.newValue);
                if (settings.bookmarkAutoCapture) {
                    // Read first so an id already bookmarked from elsewhere is
                    // not sent again, then sweep the cards already on the page.
                    readBookmarkState().then(autoCaptureCards);
                }
            }
        });
    } catch (_) { /* not fatal */ }
}

// Gallery and reader pages resolve to no card row (resolveListCardPage), so the
// controls only ever decorate listing pages.
if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    readSettings().then((enabled) => {
        if (!enabled) {
            return;
        }
        readSelection().then(() => {
            readHarvestState().then(() => {
                readHistoryState().then(() => {
                    readBookmarkState().then(() => {
                        if (document.readyState === "loading") {
                            document.addEventListener("DOMContentLoaded", start);
                        } else {
                            start();
                        }
                    });
                });
            });
        });
    });
}
