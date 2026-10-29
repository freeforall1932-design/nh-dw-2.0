/*
 * Generic, opt-in chapter discovery for an already-open HTTPS site.
 * These functions never guess server or series membership and do not bypass
 * authentication, challenges, CORS or a site's access restrictions.
 */

import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";

// Capture the URL constructor once: other modules in this codebase (and some
// tests) temporarily replace or remove the global one, which must not turn an
// otherwise valid page into "not allowed". A browser always has this.
const NativeURL: any = typeof URL === "function" ? URL : null;

export const UNIVERSAL_MAX_CHAPTERS = 200;
export const UNIVERSAL_MAX_PAGES = 500;
export const UNIVERSAL_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const UNIVERSAL_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const UNIVERSAL_MAX_CHAPTER_BYTES = 128 * 1024 * 1024;

export async function pauseBetweenChapterRequests(signal?: AbortSignal, delayMs: number = 250): Promise<void> {
    if (signal && signal.aborted) throw new UniversalChapterError("cancelled", "Cancelled.");
    await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => { if (signal) signal.removeEventListener("abort", cancel); resolve(); };
        const cancel = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", cancel); reject(new UniversalChapterError("cancelled", "Cancelled.")); };
        timer = setTimeout(done, delayMs);
        if (signal) {
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
        }
    });
}

export type ImageAttribute = "auto" | "src" | "data-src" | "data-lazy-src" | "data-original";
export interface UniversalChapterCandidate { id: string; label: string; url: string; }
export interface UniversalPageReference { url: string; host: string; }

export class UniversalChapterError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "UniversalChapterError";
        this.code = code;
    }
}

// Exact HTTPS host boundaries. IP literals and local names are intentionally
// unsupported, even for an explicitly chosen page; no network probing occurs.
export function publicHttpsUrl(value: string, base?: string): URL | null {
    try {
        const Ctor = NativeURL || (typeof URL === "function" ? URL : null);
        if (!Ctor) return null;
        const url = base ? new Ctor(value, base) : new Ctor(value);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
            !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(host) ||
            /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith("[") ||
            !/^[a-z0-9.-]+$/.test(host)) return null;
        return url;
    } catch (_) { return null; }
}

function requireSelector(selector: string): string {
    const value = String(selector || "").trim();
    if (!value || value.length > 500) throw new UniversalChapterError("selector", "Enter a valid CSS selector.");
    return value;
}

function query(root: ParentNode, selector: string): Element[] {
    try { return Array.from(root.querySelectorAll(requireSelector(selector))); }
    catch (error) {
        if (error instanceof UniversalChapterError) throw error;
        throw new UniversalChapterError("selector", "The CSS selector is invalid.");
    }
}

function compactLabel(value: string): string {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

/** Discover link candidates in document order; selection remains the user's. */
export function discoverChapters(
    doc: Document,
    sourceUrl: string,
    selector: string,
    options: { includeOutsideTitlePath?: boolean; filterChapterLabels?: boolean } = {}
): { chapters: UniversalChapterCandidate[]; truncated: boolean } {
    const source = publicHttpsUrl(sourceUrl);
    if (!source) throw new UniversalChapterError("url", "Open a public HTTPS title page first.");
    const root = source.pathname.endsWith("/") ? source.pathname : source.pathname + "/";
    const found: UniversalChapterCandidate[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const node of query(doc, selector)) {
        if (node.tagName.toLowerCase() !== "a") continue;
        const href = node.getAttribute("href");
        if (!href || /^\s*#/.test(href)) continue;
        const url = publicHttpsUrl(href, source.href);
        if (!url || url.origin !== source.origin || url.href === source.href) continue;
        if (!options.includeOutsideTitlePath && !url.pathname.startsWith(root)) continue;
        const label = compactLabel(node.textContent || node.getAttribute("aria-label") || "");
        if (!label) continue;
        if (options.filterChapterLabels !== false && !/(?:chapter|chapitre|cap[ií]tulo|episode|episode|ch\.|ep\.)\s*\d/i.test(label) &&
            !/(?:chapter|episode|chapitre|capitulo)[-_\/]?\d/i.test(url.pathname)) continue;
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        if (found.length >= UNIVERSAL_MAX_CHAPTERS) { truncated = true; break; }
        found.push({ id: "chapter-" + found.length, label: label, url: url.href });
    }
    return { chapters: found, truncated: truncated };
}

interface ImageNode { tagName: string; getAttribute(name: string): string | null; }

function collectImageNodes(nodes: ImageNode[], baseUrl: string, attribute: ImageAttribute): UniversalPageReference[] {
    if (["auto", "src", "data-src", "data-lazy-src", "data-original"].indexOf(attribute) === -1) {
        throw new UniversalChapterError("attribute", "Choose a supported image attribute.");
    }
    if (!publicHttpsUrl(baseUrl)) throw new UniversalChapterError("url", "Chapter page URL is not allowed.");
    if (nodes.length === 0) throw new UniversalChapterError("empty", "No page images matched the selector.");
    if (nodes.length > UNIVERSAL_MAX_PAGES) throw new UniversalChapterError("limit", "Too many images matched the selector.");
    const pages: UniversalPageReference[] = [];
    const attributes = attribute === "auto" ? ["data-src", "data-lazy-src", "data-original", "src"] : [attribute];
    for (const node of nodes) {
        if (node.tagName.toLowerCase() !== "img") {
            throw new UniversalChapterError("selector", "The image selector must match image elements only.");
        }
        const urls: string[] = [];
        for (const name of attributes) {
            const raw = node.getAttribute(name);
            if (!raw || /^\s*(?:data|blob):/i.test(raw)) continue;
            const candidate = publicHttpsUrl(raw, baseUrl);
            if (!candidate) throw new UniversalChapterError("url", "An image URL is not an allowed public HTTPS URL.");
            if (urls.indexOf(candidate.href) === -1) urls.push(candidate.href);
        }
        if (urls.length === 0) throw new UniversalChapterError("empty", "An image has no usable URL in that attribute.");
        if (urls.length > 1) throw new UniversalChapterError("ambiguous", "An image has different source attributes; choose one explicitly.");
        const url = publicHttpsUrl(urls[0])!;
        pages.push({ url: url.href, host: url.hostname });
    }
    return pages;
}

/** Extract exactly the selected rendered image elements; never silently drop one. */
export function collectChapterImages(root: ParentNode, baseUrl: string, selector: string, attribute: ImageAttribute): UniversalPageReference[] {
    return collectImageNodes(query(root, selector), baseUrl, attribute);
}

/** Parse fetched HTML as data, never through a browser DOM or script engine.
 * Unlike DOMParser or detached img elements, this cannot initiate subresource
 * requests before the user approves image hosts. CSS support can differ from
 * querySelectorAll, so an unsupported selector is reported instead of guessed. */
export function collectStaticChapterImages(html: string, chapterUrl: string, selector: string, attribute: ImageAttribute): UniversalPageReference[] {
    if (!publicHttpsUrl(chapterUrl)) throw new UniversalChapterError("url", "Chapter page URL is not allowed.");
    const tree = parseDocument(html, { decodeEntities: true });
    let nodes: any[];
    try { nodes = selectAll(requireSelector(selector), tree); }
    catch (error) {
        if (error instanceof UniversalChapterError) throw error;
        throw new UniversalChapterError("selector", "The CSS selector is invalid or unsupported for static HTML.");
    }
    const baseNode: any = selectOne("base[href]", tree);
    let base = chapterUrl;
    if (baseNode) {
        const parsed = publicHttpsUrl(baseNode.attribs.href, chapterUrl);
        if (!parsed) throw new UniversalChapterError("url", "The chapter HTML has an unsupported base URL.");
        base = parsed.href;
    }
    return collectImageNodes(nodes.map((node: any) => ({
        tagName: String(node.name || ""),
        getAttribute: (name: string) => Object.prototype.hasOwnProperty.call(node.attribs || {}, name) ? node.attribs[name] : null
    })), base, attribute);
}

export function identifyImage(bytes: Uint8Array): string | null {
    const ascii = (a: number, b: number) => String.fromCharCode.apply(null, Array.from(bytes.slice(a, b)));
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return "png";
    if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
    if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
    if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, Math.min(64, bytes.length)))) return "avif";
    return null;
}

/** Read bounded bytes; Content-Length alone is never trusted. */
export async function readBoundedResponse(resp: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const header = resp.headers && resp.headers.get("Content-Length");
    if (header && /^\d+$/.test(header) && Number(header) > maxBytes) {
        if (resp.body) try { await resp.body.cancel(); } catch (_) { /* best effort */ }
        throw new UniversalChapterError("limit", "A response exceeds the size limit.");
    }
    if (!resp.body || typeof resp.body.getReader !== "function") throw new UniversalChapterError("transfer", "The response cannot be read safely.");
    const reader = resp.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            if (signal && signal.aborted) throw new UniversalChapterError("cancelled", "Cancelled.");
            const item = await reader.read();
            if (item.done) break;
            if (!item.value || typeof item.value.byteLength !== "number") throw new UniversalChapterError("transfer", "Invalid response data.");
            total += item.value.byteLength;
            if (total > maxBytes) throw new UniversalChapterError("limit", "A response exceeds the size limit.");
            parts.push(item.value);
        }
    } catch (error) {
        try { await reader.cancel(); } catch (_) { /* best effort */ }
        if (signal && signal.aborted) throw new UniversalChapterError("cancelled", "Cancelled.");
        if (error instanceof UniversalChapterError) throw error;
        throw new UniversalChapterError("transfer", "The response could not be read.");
    } finally { try { reader.releaseLock(); } catch (_) { /* best effort */ } }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}

export function checkResponse(resp: Response): void {
    if (resp.redirected) throw new UniversalChapterError("redirect", "Redirects are not followed.");
    if (resp.status === 429) throw new UniversalChapterError("rate-limit", "The site rate-limited the request. Stop and wait before retrying.");
    if (resp.status === 401 || resp.status === 403) throw new UniversalChapterError("blocked", "The site denied access. No bypass was attempted.");
    if (!resp.ok) throw new UniversalChapterError("http", "The request failed (HTTP " + resp.status + ").");
}
