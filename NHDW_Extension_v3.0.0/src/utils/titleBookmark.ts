// Title-page Bookmark button — where it goes on a gallery page, and how the
// row's title / thumbnail / page count are read from that page.
//
// Why a pure table instead of six per-site branches in the content script:
// every supported site shows its own Favorite and Download buttons under a
// different id, class and container, and the button we add has to sit next to
// them and inherit their sizing. Keeping that DOM knowledge in one declarative
// row per site means
//   * the content script only implements "find, insert, toggle, repaint";
//   * the table is unit-testable in Node with no browser and no DOM;
//   * adding a seventh site is a data change, not a seventh branch.
//
// Sources for the selectors (checked in, not guessed):
//   * nhentai      — `div.buttons` with `#favorite` (older markup) and
//                    `#download` (stable in both the 2021 and the current
//                    logged-out markup), plus `#info h1.title`, the
//                    `og:image` cover and the `Pages:` tag row. Re-confirmed
//                    against a current extension that appends its own
//                    `btn btn-secondary` control into `document
//                    .getElementsByClassName('buttons')[0]` and reads `#info`.
//   * hentaiera.to — `div.others` with `#add_fav_btn` / `#download_btn`
//                    (captures/view-source era to gallery 694133 .txt, and the
//                    hentaiera.to HAR gallery 694132).
//   * imhentai.xxx — `.g_buttons` with `#add_fav_btn` / `#dl_new`
//                    (imhentai.xxx HAR gallery 1738518, re-confirmed against a
//                    saved gallery page: `<button class="tag btn btn-primary
//                    dl_btn" id="dl_new">Download (2996)</button>`), `li.pages`
//                    for the page count, `.left_cover img` for the cover.
//   * hentaienvy   — `.hnv-gallery-actions__right` with
//                    `button[data-action$="/download/start"]` /
//                    `.../favorite/toggle` (envy com HAR gallery 1606086),
//                    `.hnv-gallery-pages` for the page count.
//   * hentaifox    — `#download_btn` / `#add_fav_btn` / `#thumbs_up` /
//                    `#thumbs_down` are the ids the site's gallery page has
//                    (HentaiFoxData's Qt browser hides exactly those four on
//                    `hentaifox.com/gallery/*`, so they must exist);
//                    `ul.g_buttons`, `div.cover img` and `div.info h1` come
//                    from three independent gallery scrapers, and `#dl_new` /
//                    `#add_fav_btn` from the site's own main.min.js handlers
//                    (captures/fox-173098.har). The gallery page itself has
//                    never been captured, so this row leans on the fallbacks
//                    and on copying the anchor's own classes.
//   * hitomi.la    — `#read-online-button` / `#dl-button` in the hero, with
//                    `#gallery-brand` and `#bigtn_img` (captures/hitomi-id-
//                    rendered.html). Hitomi has no favorites affordance, so the
//                    button lands next to Read Online / Download.
//
// This module is chrome-free and DOM-free at import time (same contract as
// siteKeys.ts), so the content-script bundle and the Node test sandboxes can
// both load it.

import { getSourceForUrl } from "../sources/index";
import { toGalleryKey } from "./siteKeys";

/** Material-style bookmark glyph, 24x24 viewBox. */
export const BOOKMARK_ICON_VIEWBOX = "0 0 24 24";
/** Filled bookmark — drawn while the title IS bookmarked. */
export const BOOKMARK_ICON_PATH =
    "M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z";
/** Outline bookmark — drawn while the title is NOT bookmarked. */
export const BOOKMARK_ICON_OUTLINE_PATH =
    "M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm0 13.9-5-2.14-5 2.14V5h10v11.9z";

export const TITLE_BOOKMARK_CLASS = "nhdw-title-bookmark";
export const TITLE_BOOKMARK_ON_CLASS = "nhdw-title-bookmark-on";
export const TITLE_BOOKMARK_ICON_CLASS = "nhdw-title-bookmark-icon";
export const TITLE_BOOKMARK_LABEL_CLASS = "nhdw-title-bookmark-label";

export const TITLE_BOOKMARK_LABEL = "Bookmark";
export const TITLE_BOOKMARK_LABEL_ON = "Bookmarked";
export const TITLE_BOOKMARK_TITLE_OFF =
    "Add this gallery to the persistent bookmark queue (Queue tab). It survives a browser restart.";
export const TITLE_BOOKMARK_TITLE_ON =
    "On the bookmark list — click to take it off again (nothing is un-downloaded).";

/**
 * Classes worth copying from the site's own Download/Favorite button onto ours.
 *
 * This is what makes the third button match the row it joins — including on a
 * site whose gallery markup we have never captured (hentaifox): whatever the
 * real button wears is copied, at injection time, so the button inherits the
 * site's sizing/radius/font even if the table's `buttonClasses` guess is stale.
 *
 * Deliberately drops:
 *   * behavior hooks (`_btn`, `js-`, `jsx-`, `-trigger`) — those are how these
 *     sites bind click handlers, and copying one would enlist our button in
 *     the site's own AJAX (e.g. imhentai's `dl_btn` / `fav_btn`);
 *   * state flags (`active`, `selected`, `hidden`, …) that must not be frozen
 *     onto a brand-new control;
 *   * our own `nhdw-*` namespace, which the table already adds;
 *   * anything that looks like a template/utility artifact.
 */
export function presentationalButtonClasses(className: string | null | undefined): string[] {
    const raw = String(className === undefined || className === null ? "" : className);
    const out: string[] = [];
    const seen: Record<string, boolean> = {};
    for (const token of raw.split(/\s+/)) {
        const name = token.trim();
        if (name === "" || seen[name] === true) {
            continue;
        }
        seen[name] = true;
        if (name.length > 40) {
            continue;
        }
        if (/^(?:nhdw-|js[-_]|jsx-)/i.test(name)) {
            continue;
        }
        if (/_btn$/i.test(name) || /-btn$|_trigger$|-trigger$/i.test(name)) {
            continue;
        }
        if (/^(?:active|selected|checked|hidden|disabled|open|opened|closed|hover|focus|current|loading|on|off)$/i.test(name)) {
            continue;
        }
        out.push(name);
    }
    return out;
}

export interface TitleBookmarkTarget {
    site: string;
    /** Only these URLs ARE a single-gallery page; a reader page is not. */
    pagePattern: RegExp;
    /**
     * In order. A gallery row reads Favorite then Download, so the download
     * anchor is listed first and the new button lands after it — the row ends
     * up "Favorite / Download / Bookmark".
     */
    anchorSelectors: string[];
    /** Last resort when no anchor matched: append the button here. */
    containerSelectors: string[];
    /**
     * Presentational classes copied from the site's own buttons so the new
     * button inherits the site's sizing, radius and font. Only ever classes
     * that are known to be styling — never the site's behavior hooks
     * (`js-*`, `*_btn`), which would enlist our button in their handlers.
     */
    buttonClasses: string[];
    titleSelectors: string[];
    thumbnailSelectors: string[];
    /** Elements whose text holds "Pages: N" (or "N pages"). */
    pageCountSelectors: string[];
}

const TITLE_BOOKMARK_TARGETS: Record<string, TitleBookmarkTarget> = {
    nhentai: {
        site: "nhentai",
        pagePattern: /^https:\/\/nhentai\.net\/g\/[0-9]+\/?(?:[?#]|$)/i,
        anchorSelectors: ["#download", "#favorite", "div.buttons .btn"],
        containerSelectors: ["div.buttons"],
        buttonClasses: ["btn", "btn-secondary"],
        titleSelectors: ["#info h1.title", "h1.title", "#info h1"],
        thumbnailSelectors: ["#cover img", 'meta[property="og:image"]', 'meta[itemprop="image"]'],
        pageCountSelectors: ["#tags .tag-container.field-name", "#tags"]
    },
    hentaiera: {
        site: "hentaiera",
        pagePattern: /^https:\/\/[a-z0-9-]*\.?hentaiera\.(?:com|to|site)\/gallery\/[0-9]+\/?(?:[?#]|$)/i,
        anchorSelectors: ["#download_btn", "#add_fav_btn", ".others .btn"],
        containerSelectors: [".others"],
        buttonClasses: ["btn", "btn_colored"],
        titleSelectors: ["div.gallery_first h1", "h1"],
        thumbnailSelectors: [".left_cover img", 'img[alt$="cover"]', 'meta[property="og:image"]'],
        pageCountSelectors: [".galleries_info", ".right_details"]
    },
    imhentai: {
        site: "imhentai",
        pagePattern: /^https:\/\/[a-z0-9-]*\.?imhentai\.(?:xxx|org|net)\/gallery\/[0-9]+\/?(?:[?#]|$)/i,
        anchorSelectors: ["#dl_new", "#add_fav_btn", ".g_buttons .btn"],
        containerSelectors: [".g_buttons"],
        buttonClasses: ["tag", "btn", "btn-primary"],
        titleSelectors: ["h1", "#gallery_title"],
        thumbnailSelectors: [".left_cover img", ".cover_photo img", 'meta[property="og:image"]'],
        pageCountSelectors: ["li.pages", "ul.galleries_info"]
    },
    hentaienvy: {
        site: "hentaienvy",
        pagePattern: /^https:\/\/[a-z0-9-]*\.?hentaienvy\.com\/gallery\/[0-9]+\/?(?:[?#]|$)/i,
        anchorSelectors: [
            'button[data-action$="/download/start"]',
            'button[data-action$="/favorite/toggle"]',
            ".hnv-gallery-actions__right .hnv-gallery-action"
        ],
        containerSelectors: [".hnv-gallery-actions__right", ".hnv-gallery-actions"],
        buttonClasses: ["hnv-gallery-action"],
        titleSelectors: ["#gallery-title", "h1"],
        thumbnailSelectors: [".hnv-gallery-cover-column img", 'meta[property="og:image"]'],
        pageCountSelectors: [".hnv-gallery-pages", ".hnv-gallery-metadata"]
    },
    hentaifox: {
        site: "hentaifox",
        pagePattern: /^https:\/\/[a-z0-9-]*\.?hentaifox\.com\/gallery\/[0-9]+\/?(?:[?#]|$)/i,
        anchorSelectors: ["#download_btn", "#dl_new", "#add_fav_btn"],
        // `ul.g_buttons` is the row's own container (the site is the same
        // lineage as imhentai: `g_th`, `gallery_thumb`, `g_buttons`).
        containerSelectors: [".g_buttons", ".info"],
        // Fallback only: the real classes are copied off the anchor at
        // injection time (see presentationalButtonClasses), which is what makes
        // this row survive not having the page's HTML captured.
        buttonClasses: ["tag", "btn", "btn-primary"],
        titleSelectors: ["div.info h1", "#gallery_title", "h1"],
        thumbnailSelectors: ["div.cover img", "img.cover", ".left_cover img", 'meta[property="og:image"]'],
        pageCountSelectors: [".i_text.pages", ".info", ".galleries_info", ".right_details"]
    },
    hitomi: {
        site: "hitomi",
        pagePattern: /^https:\/\/[a-z0-9-]*\.?hitomi\.la\/(?:galleries|doujinshi|manga|gamecg|cg|anime)\/(?:.*-)?[0-9]+\.html(?:[?#]|$)/i,
        anchorSelectors: ["#dl-button", "#read-online-button"],
        containerSelectors: [],
        // Hitomi's button row is unstyled anchors around an <h1>; our own CSS
        // supplies the geometry there.
        buttonClasses: [],
        titleSelectors: ["#gallery-brand", "h1"],
        thumbnailSelectors: ["#bigtn_img", "#bigtn_source", 'meta[property="og:image"]'],
        pageCountSelectors: [".gallery-info"]
    }
};

export interface ResolvedTitleBookmarkPage {
    site: string;
    id: string;
    /** Composite "site:id" — the identity the bookmark list stores and removes by. */
    galleryKey: string;
    target: TitleBookmarkTarget;
}

/** The declarative row for a site slug, or null when the site has none yet. */
export function targetForSite(site: string | null | undefined): TitleBookmarkTarget | null {
    const key = String(site === undefined || site === null ? "" : site).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TITLE_BOOKMARK_TARGETS, key)
        ? TITLE_BOOKMARK_TARGETS[key]
        : null;
}

export function titleBookmarkSites(): string[] {
    return Object.keys(TITLE_BOOKMARK_TARGETS);
}

/**
 * Is this URL a single-gallery page we can bookmark?
 *
 * Two gates, both required: a registered adapter must own the URL (no adapter,
 * no gallery id), AND the site's own `pagePattern` must match — which is what
 * keeps this off listing pages and off reader pages (`/g/123/4/`), where the
 * Favorite/Download row does not exist.
 */
export function resolveTitleBookmarkPage(url: string): ResolvedTitleBookmarkPage | null {
    const href = String(url === undefined || url === null ? "" : url);
    const source = getSourceForUrl(href);
    if (source === null) {
        return null;
    }
    const target = targetForSite(source.site);
    if (target === null || !target.pagePattern.test(href)) {
        return null;
    }
    let id: string | null = null;
    try {
        id = source.getGalleryId(href);
    } catch (_) {
        id = null;
    }
    if (!id) {
        return null;
    }
    return { site: target.site, id: id, galleryKey: toGalleryKey(id, target.site), target: target };
}

/**
 * Page count from a label such as "Pages: 49", "49 pages" or "Pages 49".
 * 0 means "unknown", which the Queue row renders by leaving the count out.
 */
export function parsePageCount(text: string): number {
    const value = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ");
    const labelled = /pages?\s*:?\s*([0-9]{1,5})\b/i.exec(value) || /\b([0-9]{1,5})\s*pages?\b/i.exec(value);
    if (labelled === null) {
        return 0;
    }
    const count = parseInt(labelled[1], 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Gallery title as the row should show it.
 *
 * The page's own <h1> on an *gallery* page is the title; on a reader page the
 * same heading carries a "– Page 3" suffix, and some sites append their own
 * name to <title>. Both are stripped so a re-read never renames the row after
 * a reader page was opened in the same tab.
 */
export function cleanGalleryTitle(raw: string, fallback: string): string {
    let value = String(raw === undefined || raw === null ? "" : raw).replace(/\s+/g, " ").trim();
    // " - Page 3" / "– Page 3" / "| Page 3" suffixes.
    value = value.replace(/\s*[-–—|]\s*page\s*[0-9]+\s*$/i, "").trim();
    // A site-name suffix such as " - HentaiEra" or " » nhentai".
    value = value.replace(/\s*[|\-–—»]\s*(?:nhentai|hentaiera|imhentai|hentaienvy|hentaifox|hitomi)\s*$/i, "").trim();
    return value !== "" ? value : String(fallback === undefined || fallback === null ? "" : fallback);
}
