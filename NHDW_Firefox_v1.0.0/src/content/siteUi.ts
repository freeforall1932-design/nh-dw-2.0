// The website-embedded UI (item 56): an invoker baked into the nhentai header
// and a slide-down drawer that carries the extension's everyday surface, so
// the tool feels like part of the site instead of a popup bolted onto it.
//
// Owner direction for this build: the in-page UI is the PRIMARY surface; the
// toolbar popup is demoted to a settings / API-key fallback. This module is
// that primary surface.
//
// Design rules that matter here:
//   * NO duplicated settings or queue logic. The drawer renders the EXISTING
//     `renderSettings(container)` (popupSettings.ts) and `renderBookmarks(container)`
//     (bookmarkPanel.ts) into its own panes, so the popup and the page can never
//     disagree about what a setting does. Downloads go to the worker with the
//     same messages the popup and the in-page card controls already send.
//   * Anchor ONLY on `.navbar` (never the page body, which changes constantly),
//     idempotently, with a MutationObserver — the pattern `listControls.ts`
//     proved on infinite-scroll listings. A second execution of this bundle
//     (the worker injects it on demand when the toolbar is clicked before the
//     content script exists) must add nothing and double-register nothing.
//   * Desktop/mobile separation (parity plan R1): mobile-only facts are
//     measured with `matchMedia("(max-width:640px) and (pointer:coarse)")` at
//     runtime and published to storage.local for the worker; nothing here
//     restructures shared DOM for phones, and no wrapper elements are added
//     around site markup.
//   * Titles are attacker-controlled text: everything is createElement /
//     textContent, never innerHTML with a page value.
//   * nhentai-only. Multi-site stays parked; the manifest matches nhentai.net.

import { renderSettings } from "../preview/popupSettings";
import { renderBookmarks } from "../preview/bookmarkPanel";
import { readListSettings, resolveMasterFolder, ListModeSettings } from "../utils/listSettings";
import { readHistory, DownloadHistory, DOWNLOAD_HISTORY_KEY } from "../utils/downloadHistory";
import {
    BOOKMARK_QUEUE_KEY,
    BookmarkState,
    findBookmark,
    normalizeBookmarkState
} from "../utils/bookmarkQueue";
import { toGalleryKey } from "../utils/siteKeys";
import {
    EMBEDDED_UI_KEY,
    MOBILE_DEVICE_KEY,
    MOBILE_LAYOUT_MEDIA,
    NAVBAR_SELECTOR,
    SITE_UI_OPEN_PANEL_ACTION,
    SITE_UI_TOGGLE_ACTION,
    galleryIdFromUrl,
    matchesMobileLayoutMedia,
    normalizeEmbeddedUi,
    resolveInvokerAnchor
} from "../utils/embeddedUi";

const INVOKER_ID = "nhdwSiteUiInvoker";
const ROOT_ID = "nhdwSiteUi";
const PANEL_ID = "nhdwSiteUiPanel";
const BACKDROP_ID = "nhdwSiteUiBackdrop";
const NOTICE_ID = "nhdwSiteUiNotice";
const PAGE_PANE_ID = "nhdwSiteUiPage";
const QUEUE_PANE_ID = "nhdwSiteUiQueue";
const SETTINGS_PANE_ID = "nhdwSiteUiSettings";
const QUEUE_BADGE_ID = "nhdwSiteUiQueueBadge";
const INVOKER_BADGE_ID = "nhdwSiteUiInvokerBadge";

// The floating bar's ids (listControls.ts). The drawer's listing-page actions
// DELEGATE to that bar by clicking its buttons instead of re-implementing the
// selection/format/merge-warning pipeline: one code path, no divergence.
const BAR_COUNT_ID = "nhdw-count";
const BAR_DOWNLOAD_ID = "nhdw-download-selected";
const BAR_CLEAR_ID = "nhdw-clear-selected";

// nhentai gallery-page selectors, ranked. Layout generations differ; the first
// hit wins and every one of them is optional.
const TITLE_SELECTORS: ReadonlyArray<string> = [
    "#info h1.title span.pretty",
    "#info h1.title",
    "h1.title span.pretty",
    "h1.title",
    "h2.title"
];
const COVER_SELECTORS: ReadonlyArray<string> = ["#cover img", ".cover img", "#cover a img"];
const INFO_SELECTORS: ReadonlyArray<string> = ["#info", ".info-block", "#tags"];

type DrawerTab = "page" | "queue" | "settings";

let enabled = false;
let history: DownloadHistory = {};
let bookmarkState: BookmarkState = normalizeBookmarkState(null);
let drawer: HTMLElement | null = null;
let drawerOpen = false;
let activeTab: DrawerTab = "page";
let queueBuilt = false;
let noticeTimer: any = null;
let invokerObserverPending: any = null;
// start() is idempotent: observers and key listeners register once, so turning
// the embedded UI off and on again cannot stack them. bookmarkPanel.ts keeps a
// module-level `built` flag, so the drawer DOM is HIDDEN on disable rather than
// destroyed — destroying it would leave that flag true and the next Queue tab
// open would skip rebuild and look empty.
let started = false;

// ---- small helpers -------------------------------------------------------

function send(message: any, callback?: (response: any) => void): void {
    try {
        chrome.runtime.sendMessage(message, (response: any) => {
            // Reading lastError keeps the browser quiet when the worker is
            // mid-restart; a missed bookmark is recoverable by clicking again.
            try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
            if (callback) {
                callback(response || null);
            }
        });
    } catch (_) { /* worker unreachable from this page */ }
}

function byId(id: string): HTMLElement | null {
    try {
        return document.getElementById(id);
    } catch (_) {
        return null;
    }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return document.createElement(tag);
}

function firstText(selectors: ReadonlyArray<string>): string {
    for (const selector of selectors) {
        let node: any = null;
        try {
            node = document.querySelector(selector);
        } catch (_) {
            node = null; // a selector the engine rejects must not stop the scan
        }
        if (node) {
            const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
            if (text !== "") {
                return text;
            }
        }
    }
    return "";
}

// nhentai lazyloads covers: the real address sits in data-src while src holds a
// placeholder. Only an absolute http(s) URL is usable as an <img> source.
function firstImage(selectors: ReadonlyArray<string>): string {
    for (const selector of selectors) {
        let node: any = null;
        try {
            node = document.querySelector(selector);
        } catch (_) {
            node = null;
        }
        if (!node) {
            continue;
        }
        const candidates = [node.getAttribute ? node.getAttribute("data-src") : "", node.getAttribute ? node.getAttribute("src") : ""];
        for (const candidate of candidates) {
            const url = String(candidate || "").trim();
            if (/^https?:\/\//i.test(url)) {
                return url;
            }
        }
    }
    return "";
}

function iconUrl(): string {
    try {
        const runtime: any = (chrome as any).runtime;
        return runtime && typeof runtime.getURL === "function" ? String(runtime.getURL("Icon.png")) : "";
    } catch (_) {
        return "";
    }
}

// The worker cannot measure a viewport, so the page publishes the fact. This is
// what makes the toolbar button open the drawer on a phone and the popup on a
// desktop without either side guessing (parity plan R1). storage.local, never
// sync: a device fact must not travel to another device.
function publishDeviceFlag(): void {
    const mobile = matchesMobileLayoutMedia();
    try {
        const defaults: any = {};
        defaults[MOBILE_DEVICE_KEY] = false;
        chrome.storage.local.get(defaults, (elems: any) => {
            const stored = !!(elems && elems[MOBILE_DEVICE_KEY]);
            if (stored === mobile) {
                return; // no write, so no storage event, so no loop
            }
            const patch: any = {};
            patch[MOBILE_DEVICE_KEY] = mobile;
            chrome.storage.local.set(patch);
        });
    } catch (_) { /* best effort only */ }
}

function readEnabled(): Promise<boolean> {
    return new Promise((resolve) => {
        const defaults: any = {};
        defaults[EMBEDDED_UI_KEY] = undefined;
        try {
            chrome.storage.sync.get(defaults, (elems: any) => {
                resolve(normalizeEmbeddedUi(elems ? elems[EMBEDDED_UI_KEY] : undefined));
            });
        } catch (_) {
            resolve(false);
        }
    });
}

function readHistoryState(): Promise<void> {
    return readHistory().then((stored) => {
        history = stored;
    }).catch(() => { /* history is a nicety, never a blocker */ });
}

function readBookmarkState(): Promise<void> {
    return new Promise((resolve) => {
        try {
            const defaults: any = {};
            defaults[BOOKMARK_QUEUE_KEY] = null;
            chrome.storage.local.get(defaults, (elems: any) => {
                bookmarkState = normalizeBookmarkState(elems && elems[BOOKMARK_QUEUE_KEY]);
                resolve();
            });
        } catch (_) {
            resolve();
        }
    });
}

function isPageBookmarked(id: string): boolean {
    return findBookmark(bookmarkState, id) !== null;
}

function showNotice(text: string, isError: boolean = false): void {
    const notice = byId(NOTICE_ID);
    if (notice === null) {
        return;
    }
    notice.textContent = text;
    notice.className = "nhdw-site-ui-notice" + (isError ? " nhdw-site-ui-notice-error" : "");
    notice.hidden = text === "";
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    if (text !== "") {
        noticeTimer = setTimeout(() => {
            notice.textContent = "";
            notice.hidden = true;
        }, 6000);
    }
}

// ---- page context --------------------------------------------------------

interface PageContext {
    galleryId: string | null;
    title: string;
    thumbnail: string;
    pages: number;
    isListing: boolean;
}

function pageContext(): PageContext {
    const href = typeof location !== "undefined" ? location.href : "";
    const galleryId = galleryIdFromUrl(href);
    let title = "";
    let thumbnail = "";
    let pages = 0;
    if (galleryId !== null) {
        title = firstText(TITLE_SELECTORS);
        if (title === "" && typeof document !== "undefined") {
            // Last resort: the document title, minus the site suffix.
            title = String(document.title || "").replace(/\s*\|\s*nhentai\s*$/i, "").trim();
        }
        thumbnail = firstImage(COVER_SELECTORS);
        const info = firstText(INFO_SELECTORS);
        const match = /([0-9]+)\s*pages?/i.exec(info);
        pages = match === null ? 0 : parseInt(match[1], 10) || 0;
    }
    let isListing = false;
    try {
        isListing = document.querySelectorAll('.caption').length > 0
            || document.querySelectorAll('a[href*="/g/"]').length > 0;
    } catch (_) {
        isListing = false;
    }
    return { galleryId: galleryId, title: title, thumbnail: thumbnail, pages: pages, isListing: isListing };
}

// ---- invoker -------------------------------------------------------------

// Reassigning even identical nonempty textContent emits a childList mutation.
// The document-wide observer calls ensureInvoker -> paintBadges, so writes here
// must be idempotent or a nonempty queue causes a permanent 200ms timer loop.
function setTextIfChanged(node: HTMLElement, value: string): void {
    if (node.textContent !== value) {
        node.textContent = value;
    }
}

function paintBadges(): void {
    const count = bookmarkState.items.length;
    const invokerBadge = byId(INVOKER_BADGE_ID);
    if (invokerBadge !== null) {
        setTextIfChanged(invokerBadge, count > 0 ? String(count) : "");
        invokerBadge.hidden = count === 0;
    }
    const tabBadge = byId(QUEUE_BADGE_ID);
    if (tabBadge !== null) {
        setTextIfChanged(tabBadge, count > 0 ? "(" + count + ")" : "");
    }
    const invoker = byId(INVOKER_ID);
    if (invoker !== null) {
        invoker.setAttribute("aria-expanded", drawerOpen ? "true" : "false");
        invoker.title = count > 0
            ? "NHentai Downloader - open the panel (" + count + " queued)"
            : "NHentai Downloader - open the panel";
    }
}

function buildInvoker(): HTMLElement {
    const button = el("button");
    button.type = "button";
    button.id = INVOKER_ID;
    button.className = "nhdw-invoker";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", PANEL_ID);
    button.title = "NHentai Downloader - open the panel";

    const icon = iconUrl();
    if (icon !== "") {
        const img = el("img");
        img.className = "nhdw-invoker-icon";
        img.src = icon;
        img.alt = "";
        // A blocked or missing icon must not leave a broken-image placeholder
        // in the site header.
        img.addEventListener("error", () => {
            try { img.remove(); } catch (_) { /* already gone */ }
        });
        button.appendChild(img);
    }

    const label = el("span");
    label.className = "nhdw-invoker-label";
    label.textContent = "Downloader";
    button.appendChild(label);

    const badge = el("span");
    badge.className = "nhdw-invoker-badge";
    badge.id = INVOKER_BADGE_ID;
    badge.hidden = true;
    button.appendChild(badge);

    button.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleDrawer();
    });
    return button;
}

// Idempotent: a navbar that already carries our invoker is left alone, a navbar
// the site re-rendered gets a fresh one. Called on load, on every debounced
// mutation pass and when the setting flips back on.
function ensureInvoker(): void {
    if (!enabled) {
        return;
    }
    const existing = byId(INVOKER_ID);
    if (existing !== null && existing.parentElement !== null) {
        paintBadges();
        return;
    }
    const anchor = resolveInvokerAnchor(document as any);
    if (anchor === null) {
        // No `.navbar` on this page: stay out of it. The toolbar click still
        // works (the worker falls back to the popup document), and no widget is
        // floated over content we cannot lay out against.
        return;
    }
    const invoker = buildInvoker();
    const asListItem = anchor.asListItem && typeof document.createElement === "function";
    const node: HTMLElement = asListItem ? el("li") : invoker;
    if (asListItem) {
        (node as HTMLElement).className = "nhdw-invoker-item";
        node.appendChild(invoker);
    }
    const container: any = anchor.container;
    const reference: any = anchor.reference;
    try {
        if (reference && reference.parentElement === container && typeof container.insertBefore === "function") {
            container.insertBefore(node, reference.nextSibling || null);
        } else {
            container.appendChild(node);
        }
    } catch (_) {
        try {
            container.appendChild(node);
        } catch (__) { /* the site rejected the insert: give up quietly */ }
    }
    paintBadges();
}

function removeInvoker(): void {
    const existing = byId(INVOKER_ID);
    const node = existing !== null && existing.parentElement !== null
        && existing.parentElement.className === "nhdw-invoker-item"
        ? existing.parentElement
        : existing;
    if (node !== null && node.parentElement !== null) {
        try {
            node.parentElement.removeChild(node);
        } catch (_) { /* already detached */ }
    }
}

// ---- drawer --------------------------------------------------------------

function positionDrawer(): void {
    const panel = byId(PANEL_ID);
    if (panel === null) {
        return;
    }
    // Slide down from under the header: the drawer starts where the navbar ends,
    // so the invoker stays visible and clickable while the panel is open. The
    // offset is measured, never assumed, and capped so a layout that reports an
    // absurd rect cannot push the panel off-screen.
    let top = 0;
    try {
        const navbar: any = document.querySelector(NAVBAR_SELECTOR);
        if (navbar && typeof navbar.getBoundingClientRect === "function") {
            const rect = navbar.getBoundingClientRect();
            if (rect && Number.isFinite(rect.bottom) && rect.bottom > 0) {
                top = Math.min(Math.round(rect.bottom), 200);
            }
        }
    } catch (_) {
        top = 0;
    }
    panel.style.top = top + "px";
    const backdrop = byId(BACKDROP_ID);
    if (backdrop !== null) {
        // The backdrop's z-index is above the site's navbar. Leaving inset:0
        // would intercept a second click on the still-visible header invoker.
        backdrop.style.top = top + "px";
    }
}

function buildDrawer(): HTMLElement {
    const root = el("div");
    root.id = ROOT_ID;
    root.className = "nhdw-site-ui";
    root.hidden = true;

    const backdrop = el("div");
    backdrop.id = BACKDROP_ID;
    backdrop.className = "nhdw-site-ui-backdrop";
    backdrop.addEventListener("click", () => closeDrawer());
    root.appendChild(backdrop);

    const panel = el("div");
    panel.id = PANEL_ID;
    panel.className = "nhdw-site-ui-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "NHentai Downloader");
    root.appendChild(panel);

    const head = el("div");
    head.className = "nhdw-site-ui-head";

    const icon = iconUrl();
    if (icon !== "") {
        const img = el("img");
        img.className = "nhdw-site-ui-head-icon";
        img.src = icon;
        img.alt = "";
        img.addEventListener("error", () => {
            try { img.remove(); } catch (_) { /* already gone */ }
        });
        head.appendChild(img);
    }

    const heading = el("strong");
    heading.className = "nhdw-site-ui-title";
    heading.textContent = "NHentai Downloader";
    head.appendChild(heading);

    // The demoted surface stays reachable: progress, similar galleries and the
    // retry-failed list live in the panel document, not here.
    const fullPanel = el("button");
    fullPanel.type = "button";
    fullPanel.className = "nhdw-site-ui-head-btn";
    fullPanel.textContent = "Full panel \u2197";
    fullPanel.title = "Open the full panel (download progress, similar galleries, retry failed) in its own tab";
    fullPanel.addEventListener("click", () => {
        send({ action: SITE_UI_OPEN_PANEL_ACTION }, (response: any) => {
            if (!response || response.ok !== true) {
                showNotice("The worker did not open the panel. Use the toolbar button instead.", true);
            }
        });
    });
    head.appendChild(fullPanel);

    const close = el("button");
    close.type = "button";
    close.id = "nhdwSiteUiClose";
    close.className = "nhdw-site-ui-head-btn";
    close.textContent = "\u2715";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close the downloader panel");
    close.addEventListener("click", () => closeDrawer());
    head.appendChild(close);
    panel.appendChild(head);

    const tabs = el("div");
    tabs.className = "nhdw-site-ui-tabs";
    tabs.setAttribute("role", "tablist");
    const tabDefs: Array<{ id: DrawerTab; label: string; title: string }> = [
        { id: "page", label: "This page", title: "Download or bookmark what you are looking at" },
        { id: "queue", label: "Queue", title: "The persistent bookmark queue" },
        { id: "settings", label: "Settings", title: "API key, file names, list mode, interface" }
    ];
    for (const def of tabDefs) {
        const tab = el("button");
        tab.type = "button";
        tab.className = "nhdw-site-ui-tab";
        tab.id = "nhdwSiteUiTab-" + def.id;
        tab.textContent = def.label;
        tab.title = def.title;
        tab.setAttribute("role", "tab");
        if (def.id === "queue") {
            const badge = el("span");
            badge.id = QUEUE_BADGE_ID;
            badge.className = "nhdw-site-ui-tab-badge";
            tab.appendChild(document.createTextNode(" "));
            tab.appendChild(badge);
        }
        tab.addEventListener("click", () => showTab(def.id));
        tabs.appendChild(tab);
    }
    panel.appendChild(tabs);

    const notice = el("div");
    notice.id = NOTICE_ID;
    notice.className = "nhdw-site-ui-notice";
    notice.hidden = true;
    panel.appendChild(notice);

    for (const paneId of [PAGE_PANE_ID, QUEUE_PANE_ID, SETTINGS_PANE_ID]) {
        const pane = el("div");
        pane.id = paneId;
        pane.className = "nhdw-site-ui-pane";
        pane.hidden = paneId !== PAGE_PANE_ID;
        panel.appendChild(pane);
    }

    return root;
}

function ensureDrawer(): HTMLElement {
    if (drawer === null) {
        drawer = buildDrawer();
    }
    // A site re-render can detach the root just as it can replace the navbar.
    // Reattach the original node: bookmarkPanel's module-level built flag and
    // the user's half-typed paste belong to this DOM, not a fresh empty pane.
    if (byId(ROOT_ID) !== drawer) {
        const host: any = document.body || document.documentElement;
        if (host && typeof host.appendChild === "function") {
            host.appendChild(drawer);
        }
    }
    return drawer;
}

function showTab(which: DrawerTab): void {
    activeTab = which;
    const pagePane = byId(PAGE_PANE_ID);
    const queuePane = byId(QUEUE_PANE_ID);
    const settingsPane = byId(SETTINGS_PANE_ID);
    if (pagePane !== null) {
        pagePane.hidden = which !== "page";
    }
    if (queuePane !== null) {
        queuePane.hidden = which !== "queue";
    }
    if (settingsPane !== null) {
        settingsPane.hidden = which !== "settings";
    }
    for (const id of ["page", "queue", "settings"]) {
        const tab = byId("nhdwSiteUiTab-" + id);
        if (tab !== null) {
            tab.classList.toggle("active", id === which);
            tab.setAttribute("aria-selected", id === which ? "true" : "false");
        }
    }
    if (which === "page") {
        renderPagePane();
    }
    if (which === "queue" && queuePane !== null) {
        // The list is storage-backed and re-read on every open: a card bookmark,
        // another tab or a settled download may have changed it meanwhile. The
        // static chrome is built once inside renderBookmarks, so what the user
        // typed in the paste box survives a refresh.
        renderBookmarks(queuePane);
        queueBuilt = true;
    }
    if (which === "settings" && settingsPane !== null) {
        // Re-rendered on every open, exactly like the popup's Settings tab, so
        // the saved key state and template are always accurate.
        renderSettings(settingsPane);
    }
}

function openDrawer(which?: DrawerTab): void {
    if (!enabled || resolveInvokerAnchor(document) === null) {
        return;
    }
    ensureDrawer();
    positionDrawer();
    if (drawer !== null) {
        drawer.hidden = false;
    }
    drawerOpen = true;
    showTab(which || activeTab);
    paintBadges();
}

function closeDrawer(): void {
    drawerOpen = false;
    if (drawer !== null) {
        drawer.hidden = true;
    }
    paintBadges();
}

function toggleDrawer(forceOpen?: boolean): void {
    const open = typeof forceOpen === "boolean" ? forceOpen : !drawerOpen;
    if (open) {
        openDrawer();
    } else {
        closeDrawer();
    }
}

// ---- "This page" pane ----------------------------------------------------

function buildActionRow(): HTMLElement {
    const row = el("div");
    row.className = "nhdw-site-ui-actions";
    return row;
}

function button(label: string, title: string, primary: boolean, onClick: () => void): HTMLElement {
    const node = el("button");
    node.type = "button";
    node.className = primary ? "nhdw-site-ui-btn nhdw-site-ui-primary" : "nhdw-site-ui-btn";
    node.textContent = label;
    node.title = title;
    node.addEventListener("click", onClick);
    return node;
}

function renderGalleryPane(pane: HTMLElement, context: PageContext): void {
    const id = String(context.galleryId);
    const card = el("div");
    card.className = "nhdw-site-ui-card";

    const thumbBox = el("div");
    thumbBox.className = "nhdw-site-ui-thumb";
    if (context.thumbnail !== "") {
        const img = el("img");
        img.src = context.thumbnail;
        img.setAttribute("loading", "lazy");
        img.alt = "";
        img.addEventListener("error", () => {
            try { img.remove(); } catch (_) { /* already gone */ }
            thumbBox.textContent = "#";
        });
        thumbBox.appendChild(img);
    } else {
        thumbBox.textContent = "#";
    }
    card.appendChild(thumbBox);

    const info = el("div");
    info.className = "nhdw-site-ui-card-info";

    const title = el("div");
    title.className = "nhdw-site-ui-card-title";
    title.textContent = context.title !== "" ? context.title : "(untitled) " + id;
    title.title = title.textContent;
    info.appendChild(title);

    const recorded = history[toGalleryKey(id)];
    const metaBits: string[] = ["#" + id];
    if (context.pages > 0) {
        metaBits.push(context.pages + (context.pages === 1 ? " page" : " pages"));
    }
    metaBits.push(recorded ? "downloaded as " + recorded.filename : "not downloaded yet");
    const meta = el("div");
    meta.className = "nhdw-site-ui-card-meta";
    meta.textContent = metaBits.join(" \u00b7 ");
    info.appendChild(meta);

    const actions = buildActionRow();

    const bookmarked = isPageBookmarked(id);
    actions.appendChild(button(
        bookmarked ? "Bookmarked" : "Bookmark",
        bookmarked
            ? "Take this title off the bookmark queue"
            : "Add this title to the bookmark queue (it survives a browser restart)",
        false,
        () => {
            if (isPageBookmarked(id)) {
                send({ action: "bookmarkRemove", ids: [id] });
            } else {
                send({
                    action: "bookmarkAdd",
                    items: [{
                        id: id,
                        title: context.title || id,
                        thumbnail: context.thumbnail,
                        pages: context.pages,
                        // "page" is the worker's own source label for a bookmark
                        // made from a single-gallery page.
                        source: "page",
                        sourceUrl: typeof location !== "undefined" ? location.href : ""
                    }]
                });
            }
            // The storage event confirms it a few ms later; re-render now so the
            // click feels instant.
            readBookmarkState().then(() => {
                renderPagePane();
            });
        }
    ));

    actions.appendChild(button(
        recorded ? "Download again" : "Download this title",
        recorded
            ? "Already downloaded as " + recorded.filename + " - asks before fetching it again"
            : "Download this gallery with the list-mode settings (one file)",
        true,
        () => { void downloadThisTitle(id, context.title); }
    ));

    info.appendChild(actions);

    const hint = el("small");
    hint.className = "nhdw-site-ui-hint";
    hint.textContent = "Format, master folder and file name come from Settings \u2192 List mode, the same settings the in-page card buttons use.";
    info.appendChild(hint);

    card.appendChild(info);
    pane.appendChild(card);
}

function selectionText(): string {
    const count = byId(BAR_COUNT_ID);
    return count && count.textContent ? count.textContent : "Nothing selected yet - tick the cards you want.";
}

function refreshSelectionLine(): void {
    if (!drawerOpen || activeTab !== "page") {
        return;
    }
    const line = byId("nhdwSiteUiSelectionLine");
    if (line !== null) {
        setTextIfChanged(line, selectionText());
    }
}

function renderListingPane(pane: HTMLElement): void {
    const barDownload = byId(BAR_DOWNLOAD_ID);
    const barClear = byId(BAR_CLEAR_ID);

    if (barDownload === null) {
        // The floating bar is the listing surface; when the user turned the
        // card controls off there is nothing to delegate to, so say so and
        // offer the one-click way back instead of half-working.
        const note = el("div");
        note.className = "nhdw-site-ui-note";
        note.textContent = "Listing controls are off, so this page has no per-card buttons to drive.";
        pane.appendChild(note);
        const actions = buildActionRow();
        actions.appendChild(button(
            "Turn on card controls",
            "Enable the per-card Download / bookmark / Select buttons and reload the page",
            true,
            () => {
                try {
                    chrome.storage.sync.set({ inPageControls: true });
                    showNotice("Card controls enabled - reloading\u2026");
                    setTimeout(() => {
                        try { window.location.reload(); } catch (_) { /* nothing else to do */ }
                    }, 400);
                } catch (_) {
                    showNotice("Could not change that setting from this page.", true);
                }
            }
        ));
        pane.appendChild(actions);
        const pasteHint = el("small");
        pasteHint.className = "nhdw-site-ui-hint";
        pasteHint.textContent = "The Queue tab takes pasted ids and links, so a batch can still be started from here.";
        pane.appendChild(pasteHint);
        return;
    }

    const line = el("div");
    line.className = "nhdw-site-ui-note";
    line.id = "nhdwSiteUiSelectionLine";
    line.textContent = selectionText();
    pane.appendChild(line);

    const actions = buildActionRow();
    // Delegation, not duplication: clicking the bar's own buttons runs the
    // bar's own pipeline (history skip, PDF-merge warning, forced
    // re-downloads), so the drawer and the bar can never disagree.
    actions.appendChild(button(
        "Download selected",
        "Start the selection through the in-page bar (same format, folder and naming)",
        true,
        () => {
            clickNode(barDownload);
            showNotice("Handed the selection to the in-page bar.");
        }
    ));
    if (barClear !== null) {
        actions.appendChild(button(
            "Clear selection",
            "Untick every card on this page",
            false,
            () => {
                clickNode(barClear);
                showNotice("Selection cleared.");
            }
        ));
    }
    pane.appendChild(actions);

    const hint = el("small");
    hint.className = "nhdw-site-ui-hint";
    hint.textContent = "The per-card bookmark icon adds a title to the Queue tab; the bar at the bottom of the page keeps its own format and merge controls.";
    pane.appendChild(hint);
}

function clickNode(node: HTMLElement | null): void {
    if (node === null) {
        return;
    }
    try {
        if (typeof (node as any).click === "function") {
            (node as any).click();
            return;
        }
    } catch (_) { /* fall through to the event path */ }
    try {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } catch (_) { /* the node refused a synthetic click: nothing else to do */ }
}

function renderOtherPane(pane: HTMLElement): void {
    const note = el("div");
    note.className = "nhdw-site-ui-note";
    note.textContent = "This page is neither a gallery nor a listing, so there is nothing here to download yet.";
    pane.appendChild(note);
    const hint = el("small");
    hint.className = "nhdw-site-ui-hint";
    hint.textContent = "The Queue tab takes pasted gallery ids or links and downloads them without leaving this page.";
    pane.appendChild(hint);
}

function renderPagePane(): void {
    const pane = byId(PAGE_PANE_ID);
    if (pane === null) {
        return;
    }
    pane.textContent = "";
    const context = pageContext();
    if (context.galleryId !== null) {
        renderGalleryPane(pane, context);
    } else if (context.isListing) {
        renderListingPane(pane);
    } else {
        renderOtherPane(pane);
    }
}

// ---- downloads -----------------------------------------------------------

async function downloadThisTitle(id: string, title: string): Promise<void> {
    let settings: ListModeSettings;
    try {
        settings = await readListSettings();
    } catch (_) {
        showNotice("Could not read the list-mode settings.", true);
        return;
    }
    const recorded = history[toGalleryKey(id)];
    const redownloadIds: string[] = [];
    if (recorded) {
        // Same contract as the per-card button: an already-downloaded gallery
        // asks instead of silently re-fetching.
        const again = window.confirm(
            "Already downloaded as:\n" + recorded.filename + "\n\nDownload it again?");
        if (!again) {
            showNotice("Already downloaded - cancel again to re-download");
            return;
        }
        redownloadIds.push(id);
    }
    const titles: Record<string, string> = {};
    titles[id] = title !== "" ? title : id;
    // No tabId on purpose: the worker's resolveTabId() falls back to the sender
    // tab, which IS this nhentai tab, so metadata resolves through the page's
    // own session exactly as it does for the card buttons.
    send({
        action: "downloadAllDoujinshis",
        allDoujinshis: titles,
        galleryMetadata: {},
        finalName: (title !== "" ? title : "nhentai").replace(/[\\/:*?"<>|]/g, "").trim(),
        formatOverride: settings.format,
        separate: true,
        masterFolder: resolveMasterFolder(settings),
        nameTemplate: settings.template,
        redownloadIds: redownloadIds
    }, (response: any) => {
        if (response === null) {
            showNotice("The extension worker did not answer. Try again in a moment.", true);
            return;
        }
        if (response.result === "queued") {
            showNotice("Queued behind the download already running.");
            return;
        }
        showNotice("Sent 1 gallery to the downloader (" + settings.format + "). Progress lives in the full panel.");
    });
}

// ---- lifecycle -----------------------------------------------------------

function teardown(): void {
    closeDrawer();
    // Keep the drawer node. bookmarkPanel.ts builds its chrome once per bundle
    // lifetime (`built`); removing the node would make the next Queue open skip
    // rebuild and render into missing ids. Hidden is enough: the invoker is
    // gone, the panel cannot be opened, and a re-enable reuses the chrome.
    if (drawer !== null) {
        drawer.hidden = true;
    }
    removeInvoker();
}

function applyEnabled(next: boolean): void {
    if (next === enabled) {
        return;
    }
    enabled = next;
    if (enabled) {
        // History/bookmarks may never have been read if we booted disabled.
        Promise.all([readHistoryState(), readBookmarkState()]).then(() => {
            start();
        });
    } else {
        // Live: turning the embedded UI off from inside its own drawer hides
        // it without a reload (the card controls still ask for one, because
        // they are read once at load).
        teardown();
    }
}

function installObservers(): void {
    if (typeof MutationObserver === "undefined") {
        return;
    }
    // One debounced, idempotent pass for the invoker and the open listing
    // count. Anchoring stays on `.navbar`; the observation is document-wide
    // because a site that replaces its header detaches a header-only observer.
    // listControls owns the count; copying its text avoids a second selection
    // model and also reflects Clear selection without closing/reopening.
    const observer = new MutationObserver(() => {
        if (invokerObserverPending !== null || !enabled) {
            return;
        }
        invokerObserverPending = setTimeout(() => {
            invokerObserverPending = null;
            ensureInvoker();
            refreshSelectionLine();
        }, 200);
    });
    const target: any = document.documentElement || document.body;
    if (target && typeof observer.observe === "function") {
        observer.observe(target, { childList: true, subtree: true });
    }
}

function installRuntimeMessages(): void {
    try {
        (chrome.runtime.onMessage as any).addListener((request: any, _sender: any, sendResponse: (response: any) => void) => {
            if (request && request.action === SITE_UI_TOGGLE_ACTION) {
                // Answering ok:false while disabled is deliberate: it is what
                // lets the worker's toolbar click fall back to the popup
                // document instead of silently doing nothing.
                if (!enabled) {
                    sendResponse({ ok: false, reason: "disabled" });
                    return;
                }
                if (resolveInvokerAnchor(document) === null) {
                    sendResponse({ ok: false, reason: "no-navbar" });
                    return;
                }
                toggleDrawer(typeof request.open === "boolean" ? request.open : undefined);
                sendResponse({ ok: true, open: drawerOpen });
                return;
            }
        });
    } catch (_) { /* no runtime: the invoker still works */ }
}

function installStorageWatchers(): void {
    try {
        // storage.onChanged supplies (changes, area). StorageArea.onChanged
        // supplies only changes; filtering its nonexistent area silently drops
        // every live enable/disable event in Firefox.
        chrome.storage.onChanged.addListener((changes: any, area: string) => {
            if (area === "sync" && changes && changes[EMBEDDED_UI_KEY]) {
                applyEnabled(normalizeEmbeddedUi(changes[EMBEDDED_UI_KEY].newValue));
            }
            if (area !== "local" || !changes) {
                return;
            }
            if (changes[BOOKMARK_QUEUE_KEY]) {
                // A bookmark on a card, a paste in the drawer, another tab or a
                // settled download: re-read, repaint the badges and refresh the
                // queue pane if it was already built.
                readBookmarkState().then(() => {
                    paintBadges();
                    if (queueBuilt && activeTab === "queue") {
                        const queuePane = byId(QUEUE_PANE_ID);
                        if (queuePane !== null) {
                            renderBookmarks(queuePane);
                        }
                    }
                    if (activeTab === "page" && drawerOpen) {
                        renderPagePane();
                    }
                });
            }
            if (changes[DOWNLOAD_HISTORY_KEY]) {
                readHistoryState().then(() => {
                    if (drawerOpen && activeTab === "page") {
                        renderPagePane();
                    }
                });
            }
        });
    } catch (_) { /* not fatal */ }
}

function installKeyboardAndResize(): void {
    try {
        document.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Escape" && drawerOpen) {
                closeDrawer();
            }
        });
    } catch (_) { /* not fatal */ }
    try {
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("resize", () => {
                if (drawerOpen) {
                    positionDrawer();
                }
            });
            // Rotation / window resizing can move the device across the mobile
            // gate: republish the fact the worker's toolbar decision reads.
            if (typeof window.matchMedia === "function") {
                const query: any = window.matchMedia(MOBILE_LAYOUT_MEDIA);
                if (query && typeof query.addEventListener === "function") {
                    query.addEventListener("change", publishDeviceFlag);
                } else if (query && typeof query.addListener === "function") {
                    query.addListener(publishDeviceFlag);
                }
            }
        }
    } catch (_) { /* not fatal */ }
}

function start(): void {
    publishDeviceFlag();
    ensureInvoker();
    if (started) {
        return;
    }
    started = true;
    installObservers();
    installKeyboardAndResize();
}

function bootstrap(): void {
    installRuntimeMessages();
    installStorageWatchers();
    readEnabled().then((isEnabled) => {
        enabled = isEnabled;
        if (!enabled) {
            // Still listening: the toolbar click must be answerable with ok:false
            // so the worker can fall back to the popup document.
            publishDeviceFlag();
            return;
        }
        Promise.all([readHistoryState(), readBookmarkState()]).then(() => {
            if (typeof document !== "undefined" && document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", start);
            } else {
                start();
            }
        });
    });
}

// Double-injection guard: the worker injects this bundle on demand when the
// toolbar is clicked on a page that predates the install, so the file can run
// twice in the same isolated world. Without this the listeners would stack and
// a single toolbar click would toggle the drawer open and shut again.
const GUARD_PROPERTY = "__nhdwSiteUiLoaded";
(function runOnce() {
    if (typeof document === "undefined") {
        return;
    }
    const scope: any = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null);
    if (scope !== null && scope[GUARD_PROPERTY] === true) {
        return;
    }
    if (scope !== null) {
        try {
            scope[GUARD_PROPERTY] = true;
        } catch (_) { /* a frozen scope just means no guard */ }
    }
    bootstrap();
})();
