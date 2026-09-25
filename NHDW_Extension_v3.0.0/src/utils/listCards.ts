// Declarative listing-card selectors for the supported site adapters.
//
// Listing pages are not gallery pages: each site uses a different card
// boundary and puts its title either inside the cover link, beside it, or in a
// JS-rendered heading block. Keeping those facts here prevents the content
// script from growing six brittle DOM branches and makes the URL/id contract
// testable without a browser.

import { getSourceForUrl } from "../sources/index";

export type ListCardMode = "link" | "card" | "content";

export interface ListCardTarget {
    site: string;
    mode: ListCardMode;
    /** Cover/title link(s) from which the gallery id is obtained. */
    linkSelector: string;
    /** Adapter-owned gallery URL shape. */
    linkPattern: RegExp;
    /** Card boundary for card-mode sites. */
    containerSelector?: string;
    /** Title node relative to the card/link. */
    titleSelector?: string;
    /** Caption node inside a link-mode card. */
    captionSelector?: string;
    /** The grid ancestor used by hitomi's heading blocks. */
    containerAncestorClass?: string;
}

const numericGalleryPath = (segment: string): RegExp =>
    new RegExp("\\/" + segment + "\\/([0-9]+)(?:[\\/?#]|$)", "i");

export const LIST_CARD_TARGETS: Record<string, ListCardTarget> = {
    nhentai: {
        site: "nhentai",
        mode: "link",
        linkSelector: 'a[href*="/g/"]',
        linkPattern: numericGalleryPath("g"),
        captionSelector: ".caption"
    },
    hentaifox: {
        site: "hentaifox",
        mode: "card",
        linkSelector: 'a[href*="/gallery/"]',
        linkPattern: numericGalleryPath("gallery"),
        containerSelector: ".thumb",
        titleSelector: ".caption"
    },
    imhentai: {
        site: "imhentai",
        mode: "card",
        linkSelector: 'a[href*="/gallery/"]',
        linkPattern: numericGalleryPath("gallery"),
        containerSelector: ".thumb",
        titleSelector: ".caption"
    },
    hentaiera: {
        site: "hentaiera",
        mode: "card",
        // The captured cover is an <a class="inner_thumb img_box">. Do not
        // use a global .thumb selector: the title link is a separate element.
        linkSelector: "a.inner_thumb.img_box",
        linkPattern: numericGalleryPath("gallery"),
        containerSelector: ".thumb",
        titleSelector: ".gallery_title"
    },
    hentaienvy: {
        site: "hentaienvy",
        mode: "card",
        linkSelector: ".hnv-gallery-card__cover",
        linkPattern: numericGalleryPath("gallery"),
        containerSelector: "article.hnv-gallery-card",
        titleSelector: ".hnv-gallery-card__title"
    },
    hitomi: {
        site: "hitomi",
        mode: "content",
        // Live search.html + galleryblock.js put the pretty gallery URL on the
        // h1 link and the cover image in the same direct-child block.
        linkSelector: ".gallery-content h1 a",
        linkPattern: /\/(?:galleries|doujinshi|manga|gamecg|cg|anime)\/(?:.*-)?([0-9]+)\.html(?:[?#]|$)/i,
        titleSelector: "h1",
        containerAncestorClass: "gallery-content"
    }
};

export function listCardTargetForSite(site?: string): ListCardTarget | null {
    const key = String(site === undefined || site === null ? "" : site).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LIST_CARD_TARGETS, key)
        ? LIST_CARD_TARGETS[key]
        : null;
}

/**
 * Resolve only listing URLs. An adapter may own both a listing and a gallery
 * URL, so getGalleryId is the authoritative negative check: if it extracts a
 * gallery id, this is a title/reader page and must not receive card controls.
 */
export function resolveListCardPage(url: string): { site: string; target: ListCardTarget } | null {
    const href = String(url === undefined || url === null ? "" : url).trim();
    if (href === "") {
        return null;
    }
    const source = getSourceForUrl(href);
    if (source === null) {
        return null;
    }
    const target = listCardTargetForSite(source.site);
    if (target === null) {
        return null;
    }
    try {
        if (source.getGalleryId(href) !== null) {
            return null;
        }
    } catch (_) {
        return null;
    }
    return { site: source.site, target: target };
}

/** Extract a bare numeric id from one row's own gallery href. */
export function cardIdFromHref(row: ListCardTarget | null | undefined, href: string): string | null {
    if (row === null || row === undefined || !(row.linkPattern instanceof RegExp)) {
        return null;
    }
    const value = String(href === undefined || href === null ? "" : href).trim();
    if (value === "") {
        return null;
    }
    row.linkPattern.lastIndex = 0;
    const match = row.linkPattern.exec(value);
    row.linkPattern.lastIndex = 0;
    return match && match[1] ? String(match[1]) : null;
}
