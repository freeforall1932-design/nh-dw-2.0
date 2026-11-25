// Tailspace (https://tailspace.com, formerly yiffer.xyz) comic data -> the
// extension's gallery record. Pure: no chrome.*, no fetch of its own (series
// walks take an injected loader), so it runs in the popup, the service worker,
// the offscreen document and the plain-Node test sandboxes.
//
// Facts from keiyoushi/extensions-source `src/en/tailspace` (Apache-2.0, merged
// 2026-11-01), confirmed independently by cofob/memesave-bot
// `scraper/src_tailspace.go` (no licence stated: facts only). Re-implemented
// here; no code copied.
//   * The site is React Router 7. A comic's data is the loader
//     "routes/pages/comic/ComicPage" at `/c/<slug>.data?_routes=<route>`; the
//     same data is streamed into the comic page's HTML
//     (`streamController.enqueue("...")`), so either text can be read.
//   * `comic` = {id, name, slug, pages[{token, pageNumber, fileType?}],
//     numberOfPages, artist{name}, additionalArtists, tags[{name, category}],
//     previousComic{slug}, nextComic{slug}, ...}. Old comics have no fileType
//     and are jpg.
//   * Full-size page: https://pics.tailspace.com/comics/<id>/<token>.<type>;
//     cover: https://pics.tailspace.com/comics/<id>/thumbnail-2x.webp.
//   * A series is a chain of comics linked by previousComic/nextComic.

import { decodeTurboStream, routeLoaderData, routerStreamFromHtml, TurboStreamError } from "../utils/turboStream";
import { TAILSPACE_SITE, TAILSPACE_PICS_HOST, tailspacePlainSlug, tailspaceIdFromSlug, tailspaceComicUrl } from "../utils/tailspaceIds";

export const TAILSPACE_COMIC_ROUTE = "routes/pages/comic/ComicPage";
/** Same per-chapter cap as the chapter tool (UNIVERSAL_MAX_PAGES). */
export const TAILSPACE_MAX_PAGES = 500;
/** Same cap as the chapter tool's series walk (UNIVERSAL_MAX_CHAPTERS). */
export const TAILSPACE_MAX_SERIES_PARTS = 200;
export const TAILSPACE_TOKEN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

/** fileType -> the downloader's legacy page type code. */
const TYPE_CODES: Record<string, string> = { jpg: "j", jpeg: "j", png: "p", gif: "g", webp: "w", avif: "a" };

export interface TailspacePage {
    token: string;
    /** The file extension the server uses ("jpg" when the data names none). */
    type: string;
    pageNumber: number;
}

/**
 * The comic's pages in the site's own order (pageNumber, stable), validated as
 * a whole: one malformed entry rejects the list instead of leaving a gap.
 */
export function tailspacePageList(comic: any): TailspacePage[] | null {
    if (!comic || typeof comic !== "object") return null;
    const list = comic.pages;
    if (!Array.isArray(list) || !list.length || list.length > TAILSPACE_MAX_PAGES) return null;
    const entries: TailspacePage[] = [];
    for (const page of list) {
        if (!page || typeof page !== "object" || typeof page.token !== "string" || !TAILSPACE_TOKEN.test(page.token)) return null;
        if (!Number.isFinite(page.pageNumber)) return null;
        const type = page.fileType === undefined || page.fileType === null ? "jpg" : String(page.fileType).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(TYPE_CODES, type)) return null;
        entries.push({ token: page.token, type: type, pageNumber: Number(page.pageNumber) });
    }
    return entries.map((entry, i) => ({ entry, i }))
        .sort((a, b) => a.entry.pageNumber - b.entry.pageNumber || a.i - b.i)
        .map((item) => item.entry);
}

/** Full-size page URL. */
export function tailspacePageUrl(comicId: string | number, page: { token: string; type: string }): string {
    return "https://" + TAILSPACE_PICS_HOST + "/comics/" + comicId + "/" + page.token + "." + page.type;
}

/** The comic's page data URL for a gallery id (one request, this route only). */
export function tailspaceMetadataUrl(id: string): string {
    return tailspaceComicUrl(id) + ".data?_routes=" + encodeURIComponent(TAILSPACE_COMIC_ROUTE);
}

export type TailspaceRead = { gallery: any; error: null } | { gallery: null; error: string };

function failure(error: string): TailspaceRead {
    return { gallery: null, error: error };
}

/** The `comic` object from `.data` text or from a comic page's HTML. */
function comicFromText(text: string): { comic: any } | { error: string } {
    const body = String(text === undefined || text === null ? "" : text);
    const trimmed = body.replace(/^\uFEFF/, "").trimStart();
    let stream: string | null;
    if (/^[\[0-9]/.test(trimmed)) {
        stream = trimmed;
    } else {
        stream = routerStreamFromHtml(body);
        if (stream === null) {
            return { error: /<html|<!doctype/i.test(trimmed.slice(0, 512))
                ? "the site answered with a web page that carries no comic data (a login, error or challenge page?)"
                : "the answer was not Tailspace page data" };
        }
    }
    let decoded: any;
    try {
        decoded = decodeTurboStream(stream);
    } catch (error) {
        return { error: error instanceof TurboStreamError ? error.message.replace(/^The site's page data could not be read \((.*)\)\.$/, "the page data could not be decoded ($1)") : "the page data could not be decoded" };
    }
    const loaders = routeLoaderData(decoded);
    const primary = loaders[TAILSPACE_COMIC_ROUTE];
    if (primary && typeof primary === "object" && primary.comic && typeof primary.comic === "object") {
        return { comic: primary.comic };
    }
    // A full page render carries every route's data; accept another route's
    // comic only when exactly one route has one.
    const others = Object.keys(loaders)
        .map((key) => loaders[key])
        .filter((data) => data && typeof data === "object" && data.comic && typeof data.comic === "object" && Array.isArray(data.comic.pages));
    if (others.length === 1) {
        return { comic: others[0].comic };
    }
    return { error: primary && typeof primary === "object" && "comic" in primary
        ? "the site says this comic does not exist"
        : "the page data has no comic in it (the site may have changed)" };
}

function cleanText(value: any, max: number): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function tagsOf(comic: any): Array<{ type: string; name: string }> {
    const tags: Array<{ type: string; name: string }> = [];
    const artists = ([] as any[]).concat(comic.artist ? [comic.artist] : [], Array.isArray(comic.additionalArtists) ? comic.additionalArtists : []);
    for (const artist of artists) {
        const name = cleanText(artist && artist.name, 120);
        if (name && !tags.some((tag) => tag.type === "artist" && tag.name === name)) tags.push({ type: "artist", name: name });
    }
    for (const tag of Array.isArray(comic.tags) ? comic.tags.slice(0, 200) : []) {
        const name = cleanText(tag && tag.name, 120);
        if (!name) continue;
        const category = cleanText(tag.category, 40).toLowerCase();
        tags.push({ type: category === "character" ? "character" : "tag", name: name });
    }
    return tags;
}

/**
 * Read one comic as a gallery record, or say why not. The record follows the
 * legacy gallery shape the downloader uses: each page's `hash` is its token
 * (plus ".jpeg" when the server's extension is "jpeg" rather than "jpg", so
 * getImageUrls can rebuild the exact address), `media_id` is the numeric comic
 * id, `id` the canonical slug id.
 */
export function readTailspaceGallery(text: string): TailspaceRead {
    const found = comicFromText(text);
    if ("error" in found) return failure(found.error);
    const comic = found.comic;
    const slug = tailspacePlainSlug(comic.slug);
    const id = slug === null ? null : tailspaceIdFromSlug(slug);
    if (id === null) return failure("the comic in the page data has no usable name");
    if (!Number.isSafeInteger(comic.id) || comic.id <= 0) return failure("the comic in the page data has no usable id");
    const pages = tailspacePageList(comic);
    if (pages === null) {
        return failure(Array.isArray(comic.pages) && comic.pages.length === 0
            ? "the site lists no pages for this comic"
            : Array.isArray(comic.pages) && comic.pages.length > TAILSPACE_MAX_PAGES
                ? "the comic lists more than " + TAILSPACE_MAX_PAGES + " pages"
                : "a page entry in the page data was not in the expected form (the site may have changed)");
    }
    const name = cleanText(comic.name, 240) || slug;
    const stated = comic.numberOfPages;
    const link = (value: any): string | null => value && typeof value === "object" ? tailspaceIdFromSlug(value.slug) : null;
    const gallery = {
        id: id,
        media_id: String(comic.id),
        site: TAILSPACE_SITE,
        title: { pretty: name, english: name, japanese: name },
        images: {
            pages: pages.map((page) => ({
                t: TYPE_CODES[page.type],
                w: 0,
                h: 0,
                hash: page.type === "jpeg" ? page.token + ".jpeg" : page.token
            })),
            cover: { t: "w", w: 0, h: 0 },
            thumbnail: { t: "w", w: 0, h: 0 }
        },
        scanlator: "",
        tags: tagsOf(comic),
        num_pages: pages.length,
        tailspace: {
            slug: slug,
            previous: link(comic.previousComic),
            next: link(comic.nextComic),
            statedPages: Number.isSafeInteger(stated) && stated > 0 ? stated : null
        }
    };
    return { gallery: gallery, error: null };
}

export function extractTailspaceGallery(text: string): any | null {
    return readTailspaceGallery(text).gallery;
}

/** Human-readable reason a text yielded no gallery ("" when it did). */
export function explainTailspaceFailure(text: string): string {
    const read = readTailspaceGallery(text);
    return read.error === null ? "" : read.error;
}

/**
 * A comic whose listed pages disagree with the total the site states, as a
 * sentence for the user, or "" when they agree (or no total is stated).
 */
export function tailspacePageCountNote(gallery: any): string {
    const stated = gallery && gallery.tailspace ? gallery.tailspace.statedPages : null;
    const listed = gallery && gallery.images && Array.isArray(gallery.images.pages) ? gallery.images.pages.length : 0;
    if (!Number.isSafeInteger(stated) || stated === listed) return "";
    return "The site says this comic has " + stated + " pages but its page data lists " + listed + ". The download will contain the " + listed + " listed pages.";
}

export interface TailspaceSeries {
    /** Oldest part first; includes the starting comic. */
    parts: any[];
    /** Stopped at the part cap. */
    truncated: boolean;
    /** A linked part could not be read: the series may be incomplete. */
    broken: boolean;
    /** Why the first unreadable part failed ("" when none). */
    brokenReason: string;
}

/**
 * Walk a comic's linked series in both directions. `load(id)` reads one part
 * (a gallery record, or an Error / string describing why not). Loop-safe and
 * capped; a part that cannot be read ends that direction and is reported.
 */
export async function walkTailspaceSeries(
    start: any,
    load: (id: string) => Promise<any>,
    onProgress?: (found: number) => void,
    max: number = TAILSPACE_MAX_SERIES_PARTS
): Promise<TailspaceSeries> {
    const parts: any[] = [start];
    const seen = new Set<string>([String(start.id)]);
    let truncated = false;
    let broken = false;
    let brokenReason = "";
    for (const direction of ["previous", "next"] as const) {
        let nextId: string | null = start.tailspace ? start.tailspace[direction] : null;
        while (nextId) {
            if (parts.length >= max) { truncated = true; break; }
            if (seen.has(nextId)) break;
            let part: any = null;
            try {
                part = await load(nextId);
            } catch (error) {
                part = error;
            }
            if (!part || typeof part !== "object" || !part.tailspace || part instanceof Error) {
                broken = true;
                if (!brokenReason) {
                    const detail = part instanceof Error ? part.message : (typeof part === "string" ? part : "");
                    brokenReason = "The linked part \"" + decodeURIComponentSafe(nextId) + "\" could not be read" + (detail ? " (" + detail + ")" : "") + ".";
                }
                break;
            }
            if (part.id !== nextId && seen.has(String(part.id))) break;
            seen.add(nextId);
            seen.add(String(part.id));
            if (direction === "previous") parts.unshift(part); else parts.push(part);
            if (onProgress) onProgress(parts.length);
            nextId = part.tailspace[direction];
        }
    }
    return { parts, truncated, broken, brokenReason };
}

function decodeURIComponentSafe(value: string): string {
    try { return decodeURIComponent(value); } catch (_) { return value; }
}
