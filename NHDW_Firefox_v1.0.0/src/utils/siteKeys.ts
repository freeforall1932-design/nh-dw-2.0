// Composite gallery keys: "<site>:<gallery id>" (e.g. "nhentai:366224").
//
// Why (multi-site v4, backlog item 47): every persistent store — download
// history, bookmark queue, failed galleries — used to be keyed by the bare
// numeric gallery id. That collides the moment a second site arrives:
// nhentai #366224 and another site's #366224 are different galleries but the
// same key, so one would silently shadow the other in the history skip logic.
// Keys are therefore namespaced per site.
//
// Migration: legacy bare keys ("366224") are treated as the default site and
// become "nhentai:366224" the next time the record is read through
// normalizeHistory / the bookmark normalizers — no dedicated migration pass,
// no version bump of the stored shapes.
//
// Contract (documented so adapters cannot break it later):
//  * Site slugs are lowercase, dot-free, colon-free identifiers owned by the
//    adapter registry ("nhentai" today; "hitomi" etc. later).
//  * Gallery ids must not contain ":". Every planned site uses numeric ids,
//    and an id carrying the separator could not be told apart from a
//    composite key.
//  * toGalleryKey() passes through anything that already contains ":" so the
//    same helper is safe on both sides of every comparison (candidate side
//    and stored side) without callers tracking which space they are in.
//
// IMPORTANT CONTEXT RULE (same as bookmarkQueue.ts): this module is pure —
// no chrome.* at module scope — so the offscreen document and the VM test
// sandboxes can import it freely.

export const GALLERY_KEY_SEPARATOR = ":";

/** The only site until adapters exist (multi-site v4, item 48). */
export const DEFAULT_SITE = "nhentai";

export interface GalleryKeyParts {
    site: string;
    id: string;
}

/** Normalize a site slug; anything empty becomes the default site. */
export function normalizeSite(site: string | null | undefined): string {
    const value = String(site === undefined || site === null ? "" : site).trim().toLowerCase();
    if (value === "" || value.includes(GALLERY_KEY_SEPARATOR)) {
        return DEFAULT_SITE;
    }
    return value;
}

/** Build "<site>:<id>". An empty id yields "" so callers can skip it. */
export function composeGalleryKey(site: string | null | undefined, id: string | number): string {
    const galleryId = String(id === undefined || id === null ? "" : id).trim();
    if (galleryId === "") {
        return "";
    }
    return normalizeSite(site) + GALLERY_KEY_SEPARATOR + galleryId;
}

/**
 * Normalize any gallery reference into a composite key:
 *   "366224"            -> "nhentai:366224"   (legacy / default site)
 *   "nhentai:366224"    -> unchanged          (already composite)
 *   "hitomi:1234"       -> unchanged          (already composite)
 * Applying this on BOTH sides of a comparison keeps bare-id callers (the
 * whole 3.7.0 pipeline) and composite-key stores consistent in one move.
 */
export function toGalleryKey(id: string | number, site?: string | null): string {
    const raw = String(id === undefined || id === null ? "" : id).trim();
    if (raw === "") {
        return "";
    }
    if (raw.includes(GALLERY_KEY_SEPARATOR)) {
        return raw;
    }
    return composeGalleryKey(site, raw);
}

/*
 * Split a composite key back into its parts. Tolerant: a bare id is answered
 * as the default site, so old persisted rows never break the split.
 *
 * No production caller yet in 3.8.0 — kept deliberately: item 48's per-site
 * UI reads the site back out of stored keys with this, and the tolerant
 * legacy behaviour is pinned by tests. Do not delete it, and do not build a
 * second parser beside it.
 */
export function splitGalleryKey(key: string | number): GalleryKeyParts {
    const raw = String(key === undefined || key === null ? "" : key).trim();
    if (raw === "") {
        return { site: DEFAULT_SITE, id: "" };
    }
    const at = raw.indexOf(GALLERY_KEY_SEPARATOR);
    if (at === -1) {
        return { site: DEFAULT_SITE, id: raw };
    }
    return {
        site: raw.slice(0, at) === "" ? DEFAULT_SITE : raw.slice(0, at),
        id: raw.slice(at + GALLERY_KEY_SEPARATOR.length)
    };
}
