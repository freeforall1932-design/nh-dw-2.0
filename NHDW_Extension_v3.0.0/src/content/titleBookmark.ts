// In-page Bookmark button on a single gallery page.
//
// Why: the card controls (js/listControls.js) only decorate listing cards, so a
// gallery page — the one place every site shows its own Favorite and Download
// buttons — had no way to add the title to the persistent bookmark queue. This
// script puts a third button next to those two: blue, bookmark icon,
// "Bookmark"/"Bookmarked", sized by the site's own button classes.
//
// Design rules that matter here:
//   * The service worker stays the single writer of the bookmark list. This
//     script only READS chrome.storage.local directly (so a click paints
//     instantly and a change made in the panel repaints here), and sends every
//     write through the worker as bookmarkAdd / bookmarkRemove.
//   * Insert-after-an-anchor, never a second toolbar: the button has to sit in
//     the site's own button row to inherit its sizing and to be where the user
//     is already looking (see src/utils/titleBookmark.ts for the per-site
//     table).
//   * Bounded retries, not a MutationObserver: two of the supported sites
//     render their button row with JavaScript, so the injection is retried a
//     fixed number of times and then gives up. A gallery page that never grows
//     a button row must not leave a watcher running on the user's tab.
//   * Nothing here may throw on a page whose markup moved: a missing anchor is
//     a no-op, a failed read is an empty string, and a storage failure is
//     ignored. The site itself must keep working either way.

import {
    BOOKMARK_ICON_OUTLINE_PATH,
    BOOKMARK_ICON_PATH,
    BOOKMARK_ICON_VIEWBOX,
    ResolvedTitleBookmarkPage,
    TITLE_BOOKMARK_CLASS,
    TITLE_BOOKMARK_ICON_CLASS,
    TITLE_BOOKMARK_LABEL,
    TITLE_BOOKMARK_LABEL_CLASS,
    TITLE_BOOKMARK_LABEL_ON,
    TITLE_BOOKMARK_ON_CLASS,
    TITLE_BOOKMARK_TITLE_OFF,
    TITLE_BOOKMARK_TITLE_ON,
    cleanGalleryTitle,
    parsePageCount,
    presentationalButtonClasses,
    resolveTitleBookmarkPage
} from "../utils/titleBookmark";
import { BOOKMARK_QUEUE_KEY, BookmarkState, normalizeBookmarkState } from "../utils/bookmarkQueue";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Gallery pages of JS-rendered sites need a moment; this is where we stop. */
const INJECT_ATTEMPTS = 20;
const INJECT_INTERVAL_MS = 500;
/** Ancestors that mean "this is our own UI, not the site's button row". */
const OWN_UI_CLASSES = ["nhdw-card-controls", "nhdw-action-bar", TITLE_BOOKMARK_CLASS];

/** Where the build-time class list is remembered for later repaints. */
const BASE_CLASS_ATTR = "data-nhdw-title-base-class";
const FAVORITE_TEXT_RE = /^(?:add to\s+)?(?:favourites?|favorites?)\b/i;
const DOWNLOAD_TEXT_RE = /^(?:download|download all)\b/i;

// ---- shared helpers ------------------------------------------------------

function nodeText(node: Element | null): string {
    if (node === null) {
        return "";
    }
    const tag = String(node.tagName || "").toLowerCase();
    // hentaifox / imhentai publish the gallery title in a hidden
    // <input id="gallery_title" value="…">, which has no text at all.
    const input = node as any;
    const value = input && typeof input.value === "string" ? input.value : "";
    if ((tag === "input" || tag === "textarea") && value !== "") {
        return String(value).replace(/\s+/g, " ").trim();
    }
    return String(node.textContent || "").replace(/\s+/g, " ").trim();
}

// Walk up by parentElement so this works in the plain-Node test stubs too,
// which model parentElement but not closest().
function isOwnUi(node: Element | null): boolean {
    let current: any = node;
    let hops = 0;
    while (current && hops < 40) {
        const className = typeof current.className === "string" ? current.className : "";
        if (className !== "") {
            const tokens = className.split(/\s+/);
            for (const own of OWN_UI_CLASSES) {
                if (tokens.indexOf(own) !== -1) {
                    return true;
                }
            }
        }
        if (current.id === "nhdw-action-bar") {
            return true;
        }
        current = current.parentElement;
        hops++;
    }
    return false;
}

function firstMatch(selectors: string[]): Element | null {
    for (const selector of selectors || []) {
        try {
            const node = document.querySelector(selector);
            if (node !== null) {
                return node;
            }
        } catch (_) { /* selector not supported by this browser: try the next */ }
    }
    return null;
}

// The site's own button row, by text. Last resort before giving up: it exists
// precisely for the case a site renames its ids, and it deliberately skips our
// own injected buttons (the card controls on a "More Like This" card say
// "Download" too).
function findByButtonText(patterns: RegExp[]): Element | null {
    let candidates: Element[] = [];
    try {
        candidates = Array.prototype.slice.call(document.querySelectorAll("button, a"));
    } catch (_) {
        return null;
    }
    for (const pattern of patterns) {
        for (const candidate of candidates) {
            if (isOwnUi(candidate)) {
                continue;
            }
            const text = nodeText(candidate);
            if (text !== "" && pattern.test(text)) {
                return candidate;
            }
        }
    }
    return null;
}

// ---- page metadata -------------------------------------------------------

function readTitle(page: ResolvedTitleBookmarkPage): string {
    const fromPage = firstMatch(page.target.titleSelectors);
    const raw = nodeText(fromPage);
    if (raw !== "") {
        return cleanGalleryTitle(raw, page.id);
    }
    const fromDocument = typeof document.title === "string" ? document.title : "";
    return cleanGalleryTitle(fromDocument, page.id);
}

function imageUrlFrom(node: Element | null): string {
    if (node === null) {
        return "";
    }
    const tag = String(node.tagName || "").toLowerCase();
    let url = "";
    if (tag === "meta") {
        url = String(node.getAttribute("content") || "");
    } else {
        url = String(node.getAttribute("data-src") || node.getAttribute("src") || "");
        if (url === "") {
            // <picture> sources carry the real address on some sites.
            const source = node.querySelector("source");
            if (source !== null) {
                url = String(source.getAttribute("data-srcset") || source.getAttribute("srcset") || "");
            }
        }
    }
    url = url.trim().split(/\s+/)[0];
    // Display-only: the row renders it as an <img>, so an http(s) URL is all it
    // needs — but a data: placeholder is never worth persisting.
    return /^https?:\/\//i.test(url) ? url : "";
}

function readThumbnail(page: ResolvedTitleBookmarkPage): string {
    const named = firstMatch(page.target.thumbnailSelectors);
    const url = imageUrlFrom(named);
    if (url !== "") {
        return url;
    }
    const og = document.querySelector('meta[property="og:image"]');
    return imageUrlFrom(og);
}

function readPages(page: ResolvedTitleBookmarkPage): number {
    for (const selector of page.target.pageCountSelectors || []) {
        try {
            const nodes = document.querySelectorAll(selector);
            for (let i = 0; i < nodes.length; i++) {
                const count = parsePageCount(nodeText(nodes[i]));
                if (count > 0) {
                    return count;
                }
            }
        } catch (_) { /* unsupported selector: fall through to the body scan */ }
    }
    // Whole-page fallback, capped: a page count is a nice-to-have and must
    // never turn into a second-by-second scan of a long document.
    const body = document.body;
    if (body !== null && body !== undefined) {
        return parsePageCount(String(body.textContent || "").slice(0, 20000));
    }
    return 0;
}

// ---- bookmark state ------------------------------------------------------

/** Ids confirmed by the last storage read, as composite "site:id" keys. */
let bookmarkedKeys = new Set<string>();
// Unconfirmed optimistic paint for THIS page only: the click has to feel
// instant, but the worker's write has not landed yet when it returns. Cleared
// only by the storage-change event, which fires after that write.
let optimistic: boolean | null = null;

function readBookmarkState(): Promise<void> {
    return new Promise((resolve) => {
        try {
            const defaults: any = {};
            defaults[BOOKMARK_QUEUE_KEY] = null;
            chrome.storage.local.get(defaults, (elems: any) => {
                const state: BookmarkState = normalizeBookmarkState(elems && elems[BOOKMARK_QUEUE_KEY]);
                const keys = new Set<string>();
                for (const item of state.items) {
                    keys.add(String(item.site) + ":" + String(item.id));
                }
                bookmarkedKeys = keys;
                resolve();
            });
        } catch (_) {
            resolve();
        }
    });
}

function isBookmarked(page: ResolvedTitleBookmarkPage): boolean {
    return optimistic === null ? bookmarkedKeys.has(page.galleryKey) : optimistic;
}

// The same "In-page controls" Settings toggle that owns the card buttons owns
// this one: a user who turned the page controls off does not want a new button
// injected into a site's own toolbar either. Default ON, and a storage failure
// never blocks the feature.
function readInPageControls(): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get({ inPageControls: true }, (elems: any) => {
                resolve(!(elems && elems.inPageControls === false));
            });
        } catch (_) {
            resolve(true);
        }
    });
}

function sendBookmarkMessage(message: any): void {
    try {
        chrome.runtime.sendMessage(message, () => {
            // Reading lastError keeps Chrome quiet when the worker is
            // mid-restart; a missed click is recoverable by clicking again.
            try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
        });
    } catch (_) { /* worker unreachable from this page */ }
}

// ---- the button ----------------------------------------------------------

interface BookmarkButton {
    node: HTMLButtonElement;
    label: HTMLSpanElement;
    icon: SVGPathElement;
}

function buildIcon(): { svg: SVGSVGElement; path: SVGPathElement } {
    // Built with createElementNS rather than innerHTML: the extension ships
    // under a CSP-friendly policy and Mozilla's linter flags innerHTML, so the
    // icon is constructed node by node like every other injected control.
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", TITLE_BOOKMARK_ICON_CLASS);
    svg.setAttribute("viewBox", BOOKMARK_ICON_VIEWBOX);
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", BOOKMARK_ICON_OUTLINE_PATH);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return { svg: svg as SVGSVGElement, path: path as SVGPathElement };
}

function buildBookmarkButton(page: ResolvedTitleBookmarkPage, anchor: Element | null): BookmarkButton {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "";
    // The site's own button is the source of truth for sizing: its classes are
    // copied (minus behavior hooks / state flags), with the table's list kept as
    // the fallback for the append-into-a-container path.
    const classes = [TITLE_BOOKMARK_CLASS].concat(
        page.target.buttonClasses,
        anchor === null ? [] : presentationalButtonClasses(String((anchor as any).className || ""))
    ).filter((name, index, all) => name !== "" && all.indexOf(name) === index);
    button.className = classes.join(" ");
    // Its own marker, so a second run of this script recognizes its own button
    // (and the anchor search can skip it) without depending on the site's ids.
    button.setAttribute("data-nhdw-title-bookmark", page.galleryKey);
    button.setAttribute(BASE_CLASS_ATTR, button.className);

    const icon = buildIcon();
    button.appendChild(icon.svg);

    const label = document.createElement("span");
    label.className = TITLE_BOOKMARK_LABEL_CLASS;
    button.appendChild(label);

    return { node: button, label: label, icon: icon.path };
}

function paint(button: BookmarkButton, page: ResolvedTitleBookmarkPage): void {
    const on = isBookmarked(page);
    // The base classes are remembered from build time (they include whatever
    // the site's own button wore), so a repaint never loses the sizing.
    const base = (button.node.getAttribute(BASE_CLASS_ATTR) || TITLE_BOOKMARK_CLASS).split(/\s+/);
    button.node.className = base
        .concat(on ? [TITLE_BOOKMARK_ON_CLASS] : [])
        .filter((name, index, all) => name !== "" && all.indexOf(name) === index)
        .join(" ");
    button.label.textContent = on ? TITLE_BOOKMARK_LABEL_ON : TITLE_BOOKMARK_LABEL;
    button.node.title = on ? TITLE_BOOKMARK_TITLE_ON : TITLE_BOOKMARK_TITLE_OFF;
    button.node.setAttribute("aria-pressed", on ? "true" : "false");
    button.icon.setAttribute("d", on ? BOOKMARK_ICON_PATH : BOOKMARK_ICON_OUTLINE_PATH);
}

function insertAfter(anchor: Element, node: HTMLElement): boolean {
    const parent = anchor.parentNode;
    if (parent === null || parent === undefined) {
        return false;
    }
    parent.insertBefore(node, anchor.nextSibling);
    return true;
}

function findAnchor(page: ResolvedTitleBookmarkPage): { anchor: Element; mode: "after" | "append" } | null {
    const bySelector = firstMatch(page.target.anchorSelectors);
    if (bySelector !== null && !isOwnUi(bySelector)) {
        return { anchor: bySelector, mode: "after" };
    }
    const byText = findByButtonText([FAVORITE_TEXT_RE, DOWNLOAD_TEXT_RE]);
    if (byText !== null) {
        return { anchor: byText, mode: "after" };
    }
    const container = firstMatch(page.target.containerSelectors);
    if (container !== null && !isOwnUi(container)) {
        return { anchor: container, mode: "append" };
    }
    return null;
}

function inject(page: ResolvedTitleBookmarkPage): boolean {
    if (document.querySelector("[" + "data-nhdw-title-bookmark" + "]") !== null) {
        return true; // already injected (a retry ran after a success)
    }
    const found = findAnchor(page);
    if (found === null) {
        return false;
    }
    const button = buildBookmarkButton(page, found.mode === "after" ? found.anchor : null);
    paint(button, page);
    button.node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const wasOn = isBookmarked(page);
        optimistic = !wasOn;
        paint(button, page);
        if (wasOn) {
            // Composite key: the row is identified as "<site>:<id>", so a bare
            // id would only ever match the default site's rows.
            sendBookmarkMessage({ action: "bookmarkRemove", ids: [page.galleryKey] });
        } else {
            sendBookmarkMessage({
                action: "bookmarkAdd",
                items: [{
                    id: page.id,
                    site: page.site,
                    title: readTitle(page),
                    thumbnail: readThumbnail(page),
                    pages: readPages(page),
                    source: "page",
                    sourceUrl: typeof location !== "undefined" ? location.href : ""
                }]
            });
        }
    });

    const inserted = found.mode === "after"
        ? insertAfter(found.anchor, button.node)
        : (found.anchor.appendChild(button.node), true);
    if (!inserted) {
        return false;
    }

    // Repaint when the list changes anywhere else (the Queue tab, another tab,
    // a finished download): storage is authoritative again at that moment.
    try {
        chrome.storage.onChanged.addListener((changes: any, area: string) => {
            if (area !== "local" || !changes || !changes[BOOKMARK_QUEUE_KEY]) {
                return;
            }
            optimistic = null;
            readBookmarkState().then(() => paint(button, page));
        });
    } catch (_) { /* no storage events in this context */ }

    return true;
}

function start(page: ResolvedTitleBookmarkPage): void {
    readInPageControls().then((enabled) => {
        if (!enabled) {
            return;
        }
        return ready(page);
    });
}

function ready(page: ResolvedTitleBookmarkPage): void {
    readBookmarkState().then(() => {
        if (inject(page)) {
            return;
        }
        // JS-rendered button rows (hitomi, hentaienvy) appear after load. Retry
        // a bounded number of times, then stop: never leave a timer running on
        // a page that will never grow the row.
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (inject(page) || attempts >= INJECT_ATTEMPTS) {
                clearInterval(timer);
            }
        }, INJECT_INTERVAL_MS);
    });
}

// ---- bootstrap -----------------------------------------------------------

const page = resolveTitleBookmarkPage(typeof location === "undefined" ? "" : location.href);
if (page !== null) {
    if (typeof document !== "undefined" && document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => start(page));
    } else {
        start(page);
    }
}
