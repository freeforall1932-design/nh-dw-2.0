/*
 * React Router 7 / Remix "single fetch" page data as a chapter source.
 *
 * Sites built on React Router's framework mode serve every page's loader data
 * at the same path plus ".data" (the root path uses "/_root.data"), encoded as
 * turbo-stream v2 text (`Content-Type: text/x-script`). The visible reader is
 * rendered from that data, so it is the site's own, complete, ordered list -
 * no selector, no lazy-load sweep, no thumbnail guessing.
 *
 * Format (from react-router 7's bundled turbo-stream, MIT):
 *   line 1      JSON array of flattened values (or a bare number for a
 *               primitive root); index 0 is the root
 *   P<id>:<v>   deferred value <id> resolved; <v> is an index or an array of
 *               new values appended to the same index space
 *   E<id>:<v>   deferred value <id> rejected (read here as null)
 *   objects     {"_<keyIndex>": valueIndex, ...}
 *   arrays      [valueIndex, ...] (-1 = hole)
 *   negatives   -2 NaN, -3 -Infinity, -4 -0, -5 null, -6 Infinity, -7 undefined
 *   tags        ["D",ms] date, ["U",s] url, ["B",s] bigint, ["R",src,flags],
 *               ["Y",s] symbol, ["S",...] set, ["M",k,v,...] map,
 *               ["N",{...}] null-prototype object, ["P",id] promise,
 *               ["Z",index] previously resolved, ["E",msg,type] error, and
 *               react-router's plugin types (SingleFetchClassInstance, ...).
 *
 * Rules shared with the other page-list sources: text is parsed, never
 * executed; size and reference counts are bounded; every resulting URL must pass
 * publicHttpsUrl; anything ambiguous yields nothing rather than a guess.
 *
 * Known-site recipes (bottom of the file) are code, reviewed with the source
 * they came from. They cannot be added or changed from storage, they never
 * grant or approve a host, and the probe is still injected only on the user's
 * click. They only say where in a site's own page data the page list lives.
 */
import { UNIVERSAL_MAX_HTML_BYTES, UNIVERSAL_MAX_PAGES, UNIVERSAL_MAX_CHAPTERS,
    UniversalChapterError, UniversalPageReference, publicHttpsUrl, nextUrlList } from "./universalChapter";

export const ROUTE_DATA_MAX_VALUES = 250000;
const ROUTE_DATA_MAX_DEPTH = 256;
const HOLE = -1, NAN = -2, NEGATIVE_INFINITY = -3, NEGATIVE_ZERO = -4, NULL = -5, POSITIVE_INFINITY = -6, UNDEFINED = -7;

function formatError(detail: string): UniversalChapterError {
    return new UniversalChapterError("format", "The site's page data could not be read (" + detail + ").");
}

/**
 * Decode a complete turbo-stream v2 body into plain values. Dates become epoch
 * milliseconds, URLs/bigints/symbols/regexps strings, sets arrays, maps and
 * null-prototype objects plain (prototype-free) objects, errors null, and
 * deferred values whatever their resolution line carried (undefined if none).
 */
export function decodeTurboStream(text: string): any {
    const body = String(text === undefined || text === null ? "" : text);
    if (!body.trim()) throw formatError("empty response");
    if (body.length > UNIVERSAL_MAX_HTML_BYTES) throw formatError("too large");
    const lines = body.split("\n");
    const values: any[] = [];
    let first: any;
    try { first = JSON.parse(lines[0]); } catch (_) { throw formatError("not turbo-stream text"); }
    let rootIndex: number;
    if (typeof first === "number") rootIndex = first;
    else if (Array.isArray(first) && first.length) {
        for (const value of first) values.push(value);
        rootIndex = 0;
    } else throw formatError("not turbo-stream text");

    const deferred = new Map<number, number>();
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (!line) continue;
        const kind = line.charAt(0);
        const colon = line.indexOf(":");
        if ((kind !== "P" && kind !== "E") || colon < 2) throw formatError("unexpected stream line");
        const id = Number(line.slice(1, colon));
        if (!Number.isSafeInteger(id) || id < 0) throw formatError("bad deferred id");
        let parsed: any;
        try { parsed = JSON.parse(line.slice(colon + 1)); } catch (_) { throw formatError("bad deferred value"); }
        let index: number;
        if (typeof parsed === "number") index = parsed;
        else if (Array.isArray(parsed) && parsed.length) {
            index = values.length;
            for (const value of parsed) values.push(value);
        } else throw formatError("bad deferred value");
        if (values.length > ROUTE_DATA_MAX_VALUES) throw formatError("too many values");
        deferred.set(id, kind === "P" ? index : NULL);
    }
    if (values.length > ROUTE_DATA_MAX_VALUES) throw formatError("too many values");

    const hydrated = new Map<number, any>();
    const hydrate = (index: any, depth: number): any => {
        switch (index) {
            case UNDEFINED: return undefined;
            case NULL: return null;
            case NAN: return NaN;
            case POSITIVE_INFINITY: return Infinity;
            case NEGATIVE_INFINITY: return -Infinity;
            case NEGATIVE_ZERO: return -0;
        }
        if (!Number.isInteger(index) || index < 0 || index >= values.length) throw formatError("reference out of range");
        if (hydrated.has(index)) return hydrated.get(index);
        if (depth > ROUTE_DATA_MAX_DEPTH) throw formatError("nested too deeply");
        const value = values[index];
        if (value === null || typeof value !== "object") {
            hydrated.set(index, value);
            return value;
        }
        const objectFrom = (entries: any): any => {
            const out: any = Object.create(null);
            hydrated.set(index, out);
            if (!entries || typeof entries !== "object" || Array.isArray(entries)) return out;
            for (const key of Object.keys(entries)) {
                if (!/^_\d+$/.test(key)) throw formatError("bad object key");
                out[String(hydrate(Number(key.slice(1)), depth + 1))] = hydrate(entries[key], depth + 1);
            }
            return out;
        };
        if (!Array.isArray(value)) return objectFrom(value);
        if (typeof value[0] !== "string") {
            const out: any[] = [];
            hydrated.set(index, out);
            for (let i = 0; i < value.length; i++) {
                if (value[i] !== HOLE) out[i] = hydrate(value[i], depth + 1);
            }
            return out;
        }
        let result: any;
        switch (value[0]) {
            case "D": result = Number(value[1]); break;
            case "U": case "B": case "Y": result = String(value[1]); break;
            case "R": result = String(value[1]); break;
            case "E": result = null; break;
            case "Z": result = hydrate(value[1], depth + 1); break;
            case "P": result = deferred.has(value[1]) ? hydrate(deferred.get(value[1]), depth + 1) : undefined; break;
            case "N": return objectFrom(value[1]);
            case "S": {
                const out: any[] = [];
                hydrated.set(index, out);
                for (let i = 1; i < value.length; i++) out.push(hydrate(value[i], depth + 1));
                return out;
            }
            case "M": {
                const out: any = Object.create(null);
                hydrated.set(index, out);
                for (let i = 1; i + 1 < value.length; i += 2) {
                    out[String(hydrate(value[i], depth + 1))] = hydrate(value[i + 1], depth + 1);
                }
                return out;
            }
            // react-router's turbo-stream plugins (single-fetch.ts).
            case "SingleFetchClassInstance": result = hydrate(value[1], depth + 1); break;
            case "SingleFetchRedirect": result = { redirect: hydrate(value[1], depth + 1) }; break;
            case "SingleFetchFallback": result = undefined; break;
            case "SanitizedError": case "ErrorResponse": result = null; break;
            default: result = null; // unknown extension type: no data, never a guess
        }
        hydrated.set(index, result);
        return result;
    };
    return hydrate(rootIndex, 0);
}

/** `{ routeId: loaderData }` for every route that returned data. */
export function routeLoaderData(decoded: any): Record<string, any> {
    const out: Record<string, any> = Object.create(null);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return out;
    for (const key of Object.keys(decoded)) {
        const entry = decoded[key];
        if (entry && typeof entry === "object" && !Array.isArray(entry) && "data" in entry) out[key] = entry.data;
    }
    return out;
}

/**
 * The single-fetch data URL for a page, exactly as react-router builds it
 * (`singleFetchUrl`): "/" -> "/_root.data", otherwise path minus trailing slash
 * plus ".data". `routes` limits the answer to those route ids (`_routes`).
 * Recipes for sites whose chapter loader ignores the query drop it, so a reader
 * position such as `?page=3` cannot change what is read.
 */
export function singleFetchDataUrl(pageUrl: string, routes: string[] | null, keepQuery: boolean): URL | null {
    // A reader position in the fragment is not part of the page's identity.
    const url = publicHttpsUrl(String(pageUrl || "").split("#")[0]);
    if (!url) return null;
    url.pathname = url.pathname === "/" ? "/_root.data" : url.pathname.replace(/\/$/, "") + ".data";
    if (!keepQuery) url.search = "";
    url.searchParams.delete("_routes");
    if (routes && routes.length) url.searchParams.set("_routes", routes.join(","));
    return url;
}

const ROUTER_CONTEXT_PATTERN = /window\.__(?:reactRouterContext|remixContext)\b/;
/** Does this HTML (or inline script text) come from a React Router / Remix server render? */
export function hasRouterContext(text: string): boolean {
    return ROUTER_CONTEXT_PATTERN.test(String(text || "").slice(0, UNIVERSAL_MAX_HTML_BYTES));
}

const ROUTE_IMAGE_KEYS = ["images", "imageUrls", "pageImages", "pages"];
const ROUTE_GENERIC_DEPTH = 5;
/**
 * Unknown React Router site: accept a page list only when the loader data holds
 * exactly one distinct URL list under a page-ish key. Lists of cards are not
 * walked into, so related-title thumbnails cannot be mistaken for pages.
 */
export function routeDataImageUrls(loaders: Record<string, any>): string[] {
    const found = new Map<string, string[]>();
    const seen = new Set<any>();
    const walk = (node: any, depth: number): void => {
        if (!node || typeof node !== "object" || Array.isArray(node) || depth > ROUTE_GENERIC_DEPTH || found.size > 1 || seen.has(node)) return;
        seen.add(node);
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (ROUTE_IMAGE_KEYS.indexOf(key) !== -1) {
                const list = nextUrlList(value);
                if (list) { found.set(list.join("\n"), list); continue; }
            }
            walk(value, depth + 1);
        }
    };
    for (const key of Object.keys(loaders || {})) walk(loaders[key], 0);
    return found.size === 1 ? Array.from(found.values())[0] : [];
}

/** Page references from raw URLs; all or nothing, like the other sources. */
export function routeDataPageRefs(raw: string[] | null, chapterUrl: string): UniversalPageReference[] {
    if (!publicHttpsUrl(chapterUrl)) throw new UniversalChapterError("url", "Chapter page URL is not allowed.");
    if (!raw || !raw.length || raw.length > UNIVERSAL_MAX_PAGES) return [];
    const pages: UniversalPageReference[] = [];
    for (const entry of raw) {
        const url = publicHttpsUrl(entry, chapterUrl);
        if (!url || url.hash) return [];
        pages.push({ url: url.href, host: url.hostname.toLowerCase() });
    }
    return pages;
}

// ---- known-site recipes ----------------------------------------------------

export interface SeriesPart { slug: string; name: string; previous: string | null; next: string | null; }

export interface RouteDataRecipe {
    /** Exact HTTPS origins the recipe answers for. */
    origins: string[];
    /** Route id whose loader holds one chapter (sent as `_routes`). */
    chapterRoute: string;
    /** The chapter identifier in a URL path, or null when the path is not a chapter. */
    chapterSlug(pathname: string): string | null;
    /** Absolute chapter URL for a slug. */
    chapterUrl(origin: string, slug: string): string;
    /** Ordered raw page URLs from the chapter loader data, or null. */
    pages(data: any): string[] | null;
    /** This chapter's place in a linked series, or null. */
    part(data: any): SeriesPart | null;
    /** The page total the site itself states, or null (cross-checks `pages`). */
    advertised(data: any): number | null;
    /**
     * Other downloaders for this site send its origin as the referrer for page
     * images. Only used to point the user at the existing opt-in; never sets it.
     */
    imagesExpectReferrer: boolean;
}

function safeDecode(segment: string): string {
    try { return decodeURIComponent(segment); } catch (_) { return segment; }
}
function plainSlug(value: any): string | null {
    if (typeof value !== "string") return null;
    const slug = value.trim();
    return slug && slug.length <= 300 && !/[\/\\?#\u0000-\u001f]/.test(slug) ? slug : null;
}
const TAILSPACE_TOKEN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const TAILSPACE_TYPES = ["jpg", "jpeg", "png", "webp", "gif", "avif"];

/*
 * Tailspace (https://tailspace.com, formerly yiffer.xyz) - facts from
 * keiyoushi/extensions-source `src/en/tailspace` (Apache-2.0, added 2026-11-01)
 * and independently confirmed by cofob/memesave-bot `scraper/src_tailspace.go`
 * (no licence stated: facts only). Re-implemented here; no code copied.
 *   - comic page loader "routes/pages/comic/ComicPage" at `/c/<slug>.data`;
 *   - `comic.pages[]` = {token, pageNumber, fileType}; old comics carry no
 *     fileType and are jpg; `comic.numberOfPages` states the total;
 *   - full-size file `https://pics.tailspace.com/comics/<id>/<token>.<type>`;
 *   - a series is a chain of comics linked by previousComic/nextComic;
 *   - both projects send `Referer: https://tailspace.com/` for images.
 */
const TAILSPACE: RouteDataRecipe = {
    origins: ["https://tailspace.com"],
    chapterRoute: "routes/pages/comic/ComicPage",
    chapterSlug(pathname: string): string | null {
        const match = /^\/c\/([^\/]+)\/?$/.exec(String(pathname || ""));
        return match ? plainSlug(safeDecode(match[1])) : null;
    },
    chapterUrl(origin: string, slug: string): string {
        return origin + "/c/" + encodeURIComponent(slug);
    },
    pages(data: any): string[] | null {
        const comic = data && data.comic;
        if (!comic || typeof comic !== "object") return null;
        const id = comic.id;
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        const list = comic.pages;
        if (!Array.isArray(list) || !list.length || list.length > UNIVERSAL_MAX_PAGES) return null;
        const entries: { n: number; url: string }[] = [];
        for (const page of list) {
            if (!page || typeof page !== "object" || typeof page.token !== "string" || !TAILSPACE_TOKEN.test(page.token)) return null;
            if (!Number.isFinite(page.pageNumber)) return null;
            const type = page.fileType === undefined || page.fileType === null ? "jpg" : String(page.fileType).toLowerCase();
            if (TAILSPACE_TYPES.indexOf(type) === -1) return null;
            entries.push({ n: Number(page.pageNumber), url: "https://pics.tailspace.com/comics/" + id + "/" + page.token + "." + type });
        }
        // Stable sort by the site's page number (the loader is not guaranteed sorted).
        return entries.map((entry, i) => ({ entry, i }))
            .sort((a, b) => a.entry.n - b.entry.n || a.i - b.i)
            .map(item => item.entry.url);
    },
    part(data: any): SeriesPart | null {
        const comic = data && data.comic;
        if (!comic || typeof comic !== "object") return null;
        const slug = plainSlug(comic.slug);
        if (!slug) return null;
        const name = typeof comic.name === "string" && comic.name.trim() ? comic.name.replace(/\s+/g, " ").trim().slice(0, 180) : slug;
        const link = (value: any): string | null => value && typeof value === "object" ? plainSlug(value.slug) : null;
        return { slug, name, previous: link(comic.previousComic), next: link(comic.nextComic) };
    },
    advertised(data: any): number | null {
        const total = data && data.comic && data.comic.numberOfPages;
        return Number.isSafeInteger(total) && total > 0 && total <= UNIVERSAL_MAX_PAGES ? total : null;
    },
    imagesExpectReferrer: true
};

const RECIPES: RouteDataRecipe[] = [TAILSPACE];

/** The built-in recipe for this exact origin, or null. */
export function routeDataRecipeFor(origin: string): RouteDataRecipe | null {
    const key = String(origin || "").toLowerCase();
    return RECIPES.find(recipe => recipe.origins.indexOf(key) !== -1) || null;
}

/**
 * Walk a linked series from one part. `load(slug)` fetches a part (null when it
 * cannot be read); the walk stops at a missing part, a loop or the chapter cap,
 * and reports which of those happened. Oldest part first.
 */
export async function walkSeries(
    start: SeriesPart, load: (slug: string) => Promise<SeriesPart | null>, max: number = UNIVERSAL_MAX_CHAPTERS
): Promise<{ parts: SeriesPart[]; truncated: boolean; broken: boolean }> {
    const parts: SeriesPart[] = [start];
    const seen = new Set<string>([start.slug]);
    let truncated = false, broken = false;
    for (const direction of ["previous", "next"] as const) {
        let slug = start[direction];
        while (slug) {
            if (parts.length >= max) { truncated = true; break; }
            if (seen.has(slug)) break;
            const part = await load(slug);
            if (!part) { broken = true; break; }
            // A site may canonicalise the slug; both spellings count as seen.
            if (part.slug !== slug && seen.has(part.slug)) break;
            seen.add(slug); seen.add(part.slug);
            if (direction === "previous") parts.unshift(part); else parts.push(part);
            slug = part[direction];
        }
    }
    return { parts, truncated, broken };
}
