// The website-embedded UI contract (item 56): settings keys, the capability
// probe, the header-anchor resolution and the toolbar-click decision — all of
// it pure, so every rule here is unit-testable without a browser.
//
// Why the embedded UI exists: the owner direction for the Firefox track is
// that the in-page UI is the PRIMARY surface on nhentai and the toolbar popup
// is demoted to a settings / API-key fallback. `src/content/siteUi.ts` injects
// an invoker into the site header plus a slide-down drawer that reuses the
// existing renderers (`renderSettings`, `renderBookmarks`) instead of
// duplicating settings logic; this module is the shared contract between that
// content script, the worker's toolbar handling and the settings pane.
//
// Rules that matter:
//   * nhentai-only scope. Multi-site stays parked, so nothing here may widen
//     the site match — the caller passes `getSourceForUrl`-derived decisions.
//   * Anchor ONLY on `.navbar`. The page body changes constantly (infinite
//     scroll, re-renders); the header is the one layout-stable region.
//   * Mobile behaviour is decided at runtime by
//     `(max-width:640px) and (pointer:coarse)` (parity plan rule R1) and is
//     measured in the CONTENT SCRIPT, which is the only place with a viewport.
//     The worker never guesses a device: it reads what the page published.
//   * Capability is read from the manifest, so this same file can be synced to
//     the Chrome tree unchanged: with no `js/siteUi.js` content script the
//     settings toggles stay hidden and the toolbar logic stays inert.

/** storage.sync: render the invoker + drawer on nhentai pages at all. */
export const EMBEDDED_UI_KEY = "embeddedUi";
/** On by default: the embedded UI is the primary surface, not an experiment. */
export const EMBEDDED_UI_DEFAULT = true;

/**
 * storage.sync: what the toolbar button does on nhentai pages. Tri-state on
 * purpose — `undefined` (never touched) means "follow the device", which is
 * the mobile-first default the owner asked for; an explicit true/false always
 * wins, so a desktop user who wants the popup back can keep it and a phone
 * user who wants the popup can have it too.
 */
export const TOOLBAR_EMBEDDED_KEY = "toolbarOpensEmbedded";

/**
 * storage.local (NOT sync: a device fact must never travel to another device):
 * the last measured `(max-width:640px) and (pointer:coarse)` result, published
 * by the content script on every nhentai page load.
 */
export const MOBILE_DEVICE_KEY = "nhdwMobileDevice";

/** The layout gate. Keep ONE definition: preview.ts imports this constant. */
export const MOBILE_LAYOUT_MEDIA = "(max-width: 640px) and (pointer: coarse)";

/** Content-script bundle the invoker lives in (manifest content_scripts). */
export const SITE_UI_BUNDLE = "js/siteUi.js";
/** The same styles are required for both manifest and on-demand injection. */
export const SITE_UI_STYLES = ["css/content.css", "css/panelRenderers.css"];
/** The demoted fallback surface: the toolbar popup document. */
export const PANEL_PAGE = "index.html";
/** A full-panel tab stays bound to the page that opened it. */
export const PANEL_SOURCE_TAB_KEY = "sourceTabId";

/** worker -> content script: open/close the drawer (toolbar click). */
export const SITE_UI_TOGGLE_ACTION = "siteUiToggle";
/** content script -> worker: open the full panel document in a tab. */
export const SITE_UI_OPEN_PANEL_ACTION = "siteUiOpenPanel";

/** Header element every nhentai layout generation (and its clones) shares. */
export const NAVBAR_SELECTOR = ".navbar";

/**
 * The hamburger, in the order the layouts expose it. nhentai ships Bootstrap's
 * `button.navbar-toggle`; the mirror generation the repo captured uses
 * `#nav_btn`. Both are matched, because the invoker belongs next to whichever
 * one the current layout has.
 */
export const HAMBURGER_SELECTORS: ReadonlyArray<string> = [
    "#nav_btn",
    "button.navbar-toggle",
    ".navbar-toggle"
];

/**
 * Ranked invoker containers, searched INSIDE `.navbar` only.
 *
 * The ranking is about phone visibility, not aesthetics: on a Bootstrap layout
 * the right-hand link list (`.navbar-right`) lives inside the collapsible
 * `#navbar.navbar-collapse`, which is `display:none` at phone width — an
 * invoker there would be unreachable on exactly the device this build targets.
 * The header block and the left block are always visible, and the hamburger's
 * own parent is visible by definition (it is the button you tap), so those are
 * the only acceptable slots. Right-side containers are deliberately absent.
 */
export const INVOKER_ANCHORS: ReadonlyArray<{ selector: string; kind: string }> = [
    // nhentai today (`<nav class="navbar navbar-inverse navbar-fixed-top">` ->
    // `.navbar-header` holding the toggle + logo).
    { selector: ".navbar-header", kind: "bootstrap-header" },
    // The mirror generation captured in-repo (`<div class="navbar">` ->
    // `.navbar_left` holding the logo, #drop_btn and #nav_btn).
    { selector: ".navbar_left", kind: "clone-left" }
];

export interface ScopedFinder {
    querySelector(selector: string): any | null;
}

export interface InvokerAnchor {
    /** The `.navbar` node itself (the drawer is positioned against it). */
    navbar: any;
    /** Where the invoker element goes. */
    container: any;
    /** Which rule matched — asserted by the unit tests, useful in diagnostics. */
    kind: "bootstrap-header" | "clone-left" | "hamburger-parent" | "navbar-root" | string;
    /**
     * Insert the invoker AFTER this node when non-null (so it lands next to the
     * hamburger); append to the container when null.
     */
    reference: any | null;
    /** True when the container is a list, so the invoker needs an `<li>` wrap. */
    asListItem: boolean;
}

function queryIn(node: any, selector: string): any | null {
    if (!node || typeof node.querySelector !== "function") {
        return null;
    }
    try {
        return node.querySelector(selector);
    } catch (_) {
        return null; // a selector this engine rejects must not kill injection
    }
}

function tagNameOf(node: any): string {
    if (!node) {
        return "";
    }
    const name = node.tagName || node.tag || "";
    return String(name).toUpperCase();
}

/** The hamburger button inside the navbar, or null. */
export function findHamburger(navbar: any): any | null {
    for (const selector of HAMBURGER_SELECTORS) {
        const found = queryIn(navbar, selector);
        if (found) {
            return found;
        }
    }
    return null;
}

/**
 * Where the invoker goes on THIS page, or null when the page has no `.navbar`.
 *
 * null is a deliberate answer, not a failure: with no header to anchor to, the
 * embedded UI stays out of the page entirely rather than floating a widget over
 * site content it cannot be laid out against. The toolbar click then falls back
 * to the popup document (`handleToolbarClick`).
 */
export function resolveInvokerAnchor(doc: ScopedFinder | null): InvokerAnchor | null {
    if (!doc) {
        return null;
    }
    const navbar = queryIn(doc, NAVBAR_SELECTOR);
    if (!navbar) {
        return null;
    }
    const hamburger = findHamburger(navbar);

    for (const candidate of INVOKER_ANCHORS) {
        const container = queryIn(navbar, candidate.selector);
        if (container) {
            return {
                navbar: navbar,
                container: container,
                kind: candidate.kind,
                // Only "next to the hamburger" when it is a direct child of the
                // chosen container; otherwise appending is the honest answer.
                reference: hamburger && hamburger.parentElement === container ? hamburger : null,
                asListItem: tagNameOf(container) === "UL"
            };
        }
    }

    if (hamburger && hamburger.parentElement) {
        return {
            navbar: navbar,
            container: hamburger.parentElement,
            kind: "hamburger-parent",
            reference: hamburger,
            asListItem: tagNameOf(hamburger.parentElement) === "UL"
        };
    }

    return {
        navbar: navbar,
        container: navbar,
        kind: "navbar-root",
        reference: null,
        asListItem: tagNameOf(navbar) === "UL"
    };
}

/**
 * The gallery id of a page URL, or null on anything that is not a gallery page.
 * Mirrors the shape `listControls.ts` matches on cards (`/g/<id>/`), tolerating
 * a missing trailing slash and a query string.
 */
export function galleryIdFromUrl(url: string | null | undefined): string | null {
    if (typeof url !== "string" || url === "") {
        return null;
    }
    const match = /\/g\/([0-9]+)(?:[/?#]|$)/.exec(url);
    return match ? match[1] : null;
}

export function normalizeEmbeddedUi(value: any): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const lowered = value.trim().toLowerCase();
        if (lowered === "false" || lowered === "0" || lowered === "off") {
            return false;
        }
        if (lowered === "true" || lowered === "1" || lowered === "on") {
            return true;
        }
    }
    // Unset means the default, which is ON: the embedded UI is the primary
    // surface, exactly like `inPageControls` defaults to on.
    return value === undefined || value === null ? EMBEDDED_UI_DEFAULT : !!value;
}

/**
 * Preserve the saved tri-state for both Settings and the worker: undefined
 * means "follow device", not an explicit request for either surface.
 */
export function normalizeToolbarEmbedded(storedValue: any): boolean | undefined {
    if (typeof storedValue === "boolean") {
        return storedValue;
    }
    if (typeof storedValue === "string") {
        const lowered = storedValue.trim().toLowerCase();
        if (lowered === "true" || lowered === "1" || lowered === "on") {
            return true;
        }
        if (lowered === "false" || lowered === "0" || lowered === "off") {
            return false;
        }
    }
    return undefined;
}

/** An explicit preference wins; unset follows the content script's device gate. */
export function resolveToolbarEmbedded(storedValue: any, mobileDevice: boolean): boolean {
    const preference = normalizeToolbarEmbedded(storedValue);
    return preference === undefined ? !!mobileDevice : preference;
}

/**
 * Does THIS build ship the embedded UI? Read from the manifest rather than a
 * build-time constant so the same source file is correct in both trees: the
 * Chrome manifest has no `js/siteUi.js` content script, so the settings toggles
 * stay hidden and the toolbar stays exactly as it is today.
 */
export function shipsSiteUi(manifest?: any): boolean {
    let resolved: any = manifest;
    if (resolved === undefined) {
        try {
            const runtime: any = typeof chrome !== "undefined" ? (chrome as any).runtime : undefined;
            resolved = runtime && typeof runtime.getManifest === "function" ? runtime.getManifest() : null;
        } catch (_) {
            resolved = null;
        }
    }
    if (!resolved || !Array.isArray(resolved.content_scripts)) {
        return false;
    }
    for (const entry of resolved.content_scripts) {
        const scripts = entry && Array.isArray(entry.js) ? entry.js : [];
        for (const script of scripts) {
            if (String(script) === SITE_UI_BUNDLE) {
                return true;
            }
        }
    }
    return false;
}

/**
 * The device gate itself, measured where a viewport exists (a content script or
 * an extension page). Both the embedded UI and the settings pane use this one
 * definition, so "is this a phone" can never mean two different things.
 */
export function matchesMobileLayoutMedia(): boolean {
    try {
        return typeof window !== "undefined" && typeof window.matchMedia === "function"
            && window.matchMedia(MOBILE_LAYOUT_MEDIA).matches;
    } catch (_) {
        return false;
    }
}

/**
 * The popup the toolbar should carry for a tab: "" (no popup, so `onClicked`
 * fires and the drawer opens in the page) on nhentai while the embedded
 * toolbar mode is on, and the panel document everywhere else.
 */
export function popupForTab(
    embeddedToolbar: boolean,
    url: string | undefined | null,
    isSiteUrl: (url: string) => boolean,
    panelPage: string = PANEL_PAGE
): string {
    if (!embeddedToolbar || typeof url !== "string" || url === "") {
        return panelPage;
    }
    let onSite = false;
    try {
        onSite = !!isSiteUrl(url);
    } catch (_) {
        onSite = false;
    }
    return onSite ? "" : panelPage;
}

export interface ToolbarHost {
    /** Message the tab's content script. Resolves false when nobody answered. */
    sendToTab(tabId: number, message: any): Promise<boolean>;
    /** Inject the site-UI bundle into the tab (page loaded before install). */
    injectSiteUi(tabId: number): Promise<boolean>;
    /** Last resort: open the demoted popup document in a tab of its own. */
    openPanelPage(sourceTabId?: number): void | Promise<boolean>;
}

export type ToolbarClickOutcome = "toggled" | "injected" | "panel" | "ignored";

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Toolbar click while the embedded toolbar mode is on.
 *
 * The content script may not be there yet (the page was open before the add-on
 * was installed, or the event page woke before injection finished), so the
 * toggle is retried around one on-demand injection before the click degrades to
 * the popup document. A toolbar click must never do nothing.
 */
export async function handleToolbarClick(
    host: ToolbarHost,
    tab: { id?: number; url?: string } | undefined | null,
    opts: {
        embeddedToolbar: boolean;
        isSiteUrl: (url: string) => boolean;
        toggleAction?: string;
        sleep?: (ms: number) => Promise<void>;
        retries?: number;
        retryDelayMs?: number;
    }
): Promise<ToolbarClickOutcome> {
    if (!opts || !opts.embeddedToolbar) {
        return "ignored"; // the popup is set for this tab: the browser opens it
    }
    const toggleAction = opts.toggleAction || SITE_UI_TOGGLE_ACTION;
    const sleep = opts.sleep || defaultSleep;
    const retries = typeof opts.retries === "number" && opts.retries >= 0 ? opts.retries : 3;
    const delay = typeof opts.retryDelayMs === "number" && opts.retryDelayMs >= 0 ? opts.retryDelayMs : 120;
    const tabId = tab && typeof tab.id === "number" ? tab.id : undefined;
    const url = tab && typeof tab.url === "string" ? tab.url : "";

    if (tabId === undefined || url === "" || !opts.isSiteUrl(url)) {
        // Not a page the drawer can live in (about:blank, a foreign site, a
        // privileged page): fall back to the demoted panel document.
        await host.openPanelPage();
        return "panel";
    }

    if (await host.sendToTab(tabId, { action: toggleAction })) {
        return "toggled";
    }

    if (await host.injectSiteUi(tabId)) {
        for (let attempt = 0; attempt < retries; attempt++) {
            await sleep(delay * (attempt + 1));
            // `open: true` because the click was an explicit "show me the
            // panel": toggling a freshly injected (closed) drawer is the same
            // thing, but saying it outright survives a race with a drawer the
            // injection itself already opened.
            if (await host.sendToTab(tabId, { action: toggleAction, open: true })) {
                return "injected";
            }
        }
    }

    await host.openPanelPage(tabId);
    return "panel";
}
