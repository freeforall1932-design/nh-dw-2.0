// Tailspace gallery ids (https://tailspace.com).
//
// Tailspace addresses a comic by its slug (`/c/<slug>`, e.g. "Scale Train"),
// never by a number: its page data route, its reader URL and its series links
// all use the slug, and the numeric comic id only appears inside the data.
// The extension's gallery id for Tailspace is therefore the slug as ONE
// encoded URL path segment (encodeURIComponent), e.g. "Scale%20Train":
//   * it never contains ":" (encoded as %3A), so the composite-key contract in
//     siteKeys.ts holds ("tailspace:Scale%20Train" splits at the first colon);
//   * it never contains whitespace, "," ";" or "|", so the paste box's token
//     split cannot cut it in half;
//   * it is canonical: one slug has exactly one id, so history and bookmark
//     keys stay stable however the URL was typed.
//
// Pure module (no imports, no chrome.*): siteKeys/bookmarkQueue load it in the
// popup, worker, offscreen document and the plain-Node test sandboxes.

export const TAILSPACE_SITE = "tailspace";
export const TAILSPACE_ORIGIN = "https://tailspace.com";
export const TAILSPACE_PICS_HOST = "pics.tailspace.com";

const MAX_SLUG_LENGTH = 300;
const ID_SHAPE = /^[A-Za-z0-9\-_.!~*'()%]{1,1200}$/;

function safeDecode(segment: string): string | null {
    try {
        return decodeURIComponent(segment);
    } catch (_) {
        return null;
    }
}

/** A slug as the site's data states it: non-empty, bounded, no path/query/control characters. */
export function tailspacePlainSlug(value: any): string | null {
    if (typeof value !== "string") return null;
    const slug = value.trim();
    return slug && slug.length <= MAX_SLUG_LENGTH && !/[\/\\?#\u0000-\u001f\u007f]/.test(slug) ? slug : null;
}

/** Gallery id for a slug, or null when the slug is not usable. */
export function tailspaceIdFromSlug(slug: any): string | null {
    const plain = tailspacePlainSlug(slug);
    return plain === null ? null : encodeURIComponent(plain);
}

/** The slug behind a gallery id, or null unless the id is in canonical form. */
export function tailspaceSlugFromId(id: any): string | null {
    const value = String(id === undefined || id === null ? "" : id).trim();
    if (!ID_SHAPE.test(value)) return null;
    const decoded = safeDecode(value);
    const plain = tailspacePlainSlug(decoded);
    return plain !== null && encodeURIComponent(plain) === value ? plain : null;
}

export function isTailspaceId(id: any): boolean {
    return tailspaceSlugFromId(id) !== null;
}

const COMIC_PATH = /^\/c\/([^\/?#]+)\/?$/;

/**
 * Gallery id from a Tailspace comic URL (`https://tailspace.com/c/<slug>`,
 * with or without `?page=N` - that is only the reader position), else null.
 */
export function tailspaceIdFromUrl(url: any): string | null {
    let parsed: URL;
    try {
        parsed = new URL(String(url));
    } catch (_) {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== "tailspace.com" && host !== "www.tailspace.com") return null;
    const match = COMIC_PATH.exec(parsed.pathname);
    if (!match) return null;
    const decoded = safeDecode(match[1]);
    return decoded === null ? null : tailspaceIdFromSlug(decoded);
}

/** Comic page URL for a gallery id (the id is already one encoded segment). */
export function tailspaceComicUrl(id: string): string {
    return TAILSPACE_ORIGIN + "/c/" + id;
}
