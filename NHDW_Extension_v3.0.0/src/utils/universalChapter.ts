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

interface ImageNode {
    tagName: string;
    getAttribute(name: string): string | null;
    /** Nearest enclosing link and caption text, used only for page ordering. */
    context(): { linkHref: string | null; altText: string };
}

export type PageOrderStrategy = "reader" | "link-index" | "name-natural";

export interface ChapterPageCollection {
    pages: UniversalPageReference[];
    order: PageOrderStrategy;
    /** True when the chosen ordering moved at least one page. */
    readerOrderDiffers: boolean;
    /** Short, human-checkable prefix of the resolved order. */
    preview: string[];
}

interface RawPage { url: string; host: string; dataPage: string | null; linkHref: string | null; altText: string; }

function pageNumberToken(value: string | null): number | null {
    if (value === null) return null;
    const match = /^\s*(\d{1,5})\s*$/.exec(value);
    return match ? Number(match[1]) : null;
}

/** A single, comparable page index; sources are tried most explicit first. */
function pageHint(raw: RawPage): number | null {
    const fromAttribute = pageNumberToken(raw.dataPage);
    if (fromAttribute !== null) return fromAttribute;
    if (raw.linkHref) {
        const link = publicHttpsUrl(raw.linkHref);
        if (link) {
            for (const key of ["page", "p", "pg"]) {
                const fromQuery = pageNumberToken(link.searchParams.get(key));
                if (fromQuery !== null) return fromQuery;
            }
            const fromPath = /\/(?:page|pages)[-_/]?(\d{1,5})\/?$/i.exec(link.pathname);
            if (fromPath) return Number(fromPath[1]);
        }
    }
    const fromText = /(?:^|\b)pages?\s*#?(\d{1,5})\b/i.exec(raw.altText || "");
    return fromText ? Number(fromText[1]) : null;
}

/** Numeric groups of the final path segment: "010.jpg" -> [10]. */
function nameSignature(url: string): number[] | null {
    let segment = "";
    try { segment = new NativeURL(url).pathname.split("/").pop() || ""; } catch (_) { return null; }
    try { segment = decodeURIComponent(segment); } catch (_) { /* keep raw */ }
    const tokens = segment.match(/\d+/g);
    return tokens ? tokens.map(Number) : null;
}

function compareSignatures(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

function pagePreview(pages: UniversalPageReference[], strategy: PageOrderStrategy): string[] {
    return pages.slice(0, 4).map((page, index) => {
        let tail = "";
        try {
            tail = decodeURIComponent(new NativeURL(page.url).pathname.split("/").pop() || "");
        } catch (_) { tail = ""; }
        if (tail.length > 28) tail = "…" + tail.slice(-27);
        return "#" + (index + 1) + " " + page.host + "/" + tail;
    });
}

/**
 * Apply one explicit ordering strategy. "reader" is the site's own order and is
 * the only safe default; the other strategies need a usable, unique signal for
 * EVERY page, otherwise they refuse instead of inventing an order.
 */
export function orderChapterPages(raws: RawPage[], strategy: PageOrderStrategy): ChapterPageCollection {
    if (["reader", "link-index", "name-natural"].indexOf(strategy) === -1) {
        throw new UniversalChapterError("order", "Choose a supported page-order strategy.");
    }
    const stripped: UniversalPageReference[] = raws.map(raw => ({ url: raw.url, host: raw.host }));
    if (strategy === "reader") {
        return { pages: stripped, order: strategy, readerOrderDiffers: false, preview: pagePreview(stripped, strategy) };
    }
    let keys: (number[])[];
    if (strategy === "link-index") {
        const hints = raws.map(pageHint);
        if (hints.some(hint => hint === null)) {
            throw new UniversalChapterError("order",
                "Some pages have no page number in their link or caption. Use the reader order, or add a selector whose links carry ?page=N.");
        }
        keys = hints.map(hint => [hint as number]);
    } else {
        const signatures = raws.map(raw => nameSignature(raw.url));
        if (signatures.some(signature => signature === null)) {
            throw new UniversalChapterError("order",
                "Some image names contain no numbers (hashed or word-only names). Use the reader order or the page-number links instead.");
        }
        keys = signatures as number[][];
    }
    const seen = new Set<string>();
    for (const key of keys) {
        const id = key.join(",");
        if (seen.has(id)) {
            throw new UniversalChapterError("order",
                "Two pages resolve to the same " + (strategy === "link-index" ? "page number" : "number pattern") + "; the order would be ambiguous.");
        }
        seen.add(id);
    }
    const indices = raws.map((_raw, index) => index)
        .sort((a, b) => compareSignatures(keys[a], keys[b]) || a - b);
    const pages = indices.map(index => stripped[index]);
    return {
        pages: pages,
        order: strategy,
        readerOrderDiffers: indices.some((value, position) => value !== position),
        preview: pagePreview(pages, strategy)
    };
}

function collectImageNodes(nodes: ImageNode[], baseUrl: string, attribute: ImageAttribute, order: PageOrderStrategy = "reader"): ChapterPageCollection {
    if (["auto", "src", "data-src", "data-lazy-src", "data-original"].indexOf(attribute) === -1) {
        throw new UniversalChapterError("attribute", "Choose a supported image attribute.");
    }
    if (!publicHttpsUrl(baseUrl)) throw new UniversalChapterError("url", "Chapter page URL is not allowed.");
    if (nodes.length === 0) throw new UniversalChapterError("empty", "No page images matched the selector.");
    if (nodes.length > UNIVERSAL_MAX_PAGES) throw new UniversalChapterError("limit", "Too many images matched the selector.");
    const raws: RawPage[] = [];
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
        const context = node.context();
        const link = context.linkHref ? publicHttpsUrl(context.linkHref, baseUrl) : null;
        raws.push({
            url: url.href,
            host: url.hostname,
            dataPage: node.getAttribute("data-page") || node.getAttribute("data-index") || node.getAttribute("data-number"),
            linkHref: link ? link.href : null,
            altText: (node.getAttribute("alt") || "") + " " + (node.getAttribute("title") || "")
        });
    }
    return orderChapterPages(raws, order);
}

/** Extract exactly the selected rendered image elements; never silently drop one. */
export function collectChapterPages(
    root: ParentNode, baseUrl: string, selector: string, attribute: ImageAttribute, order: PageOrderStrategy = "reader"
): ChapterPageCollection {
    const nodes: ImageNode[] = query(root, selector).map((element: any) => ({
        tagName: String(element.tagName || ""),
        getAttribute: (name: string) => element.getAttribute(name),
        context: () => {
            let anchor: any = null;
            try { anchor = typeof element.closest === "function" ? element.closest("a") : null; } catch (_) { anchor = null; }
            return { linkHref: anchor ? anchor.getAttribute("href") : null, altText: "" };
        }
    }));
    return collectImageNodes(nodes, baseUrl, attribute, order);
}

export function collectChapterImages(root: ParentNode, baseUrl: string, selector: string, attribute: ImageAttribute): UniversalPageReference[] {
    return collectChapterPages(root, baseUrl, selector, attribute).pages;
}

/** Parse fetched HTML as data, never through a browser DOM or script engine.
 * Unlike DOMParser or detached img elements, this cannot initiate subresource
 * requests before the user approves image hosts. CSS support can differ from
 * querySelectorAll, so an unsupported selector is reported instead of guessed. */
export function collectStaticChapterPages(
    html: string, chapterUrl: string, selector: string, attribute: ImageAttribute, order: PageOrderStrategy = "reader"
): ChapterPageCollection {
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
    const imageNodes: ImageNode[] = nodes.map((node: any) => ({
        tagName: String(node.name || ""),
        getAttribute: (name: string) => Object.prototype.hasOwnProperty.call(node.attribs || {}, name) ? node.attribs[name] : null,
        context: () => {
            let parent = node.parent;
            while (parent) {
                if (String(parent.name || "").toLowerCase() === "a" && parent.attribs && typeof parent.attribs.href === "string") {
                    return { linkHref: parent.attribs.href, altText: "" };
                }
                parent = parent.parent;
            }
            return { linkHref: null, altText: "" };
        }
    }));
    return collectImageNodes(imageNodes, base, attribute, order);
}

export function collectStaticChapterImages(html: string, chapterUrl: string, selector: string, attribute: ImageAttribute): UniversalPageReference[] {
    return collectStaticChapterPages(html, chapterUrl, selector, attribute).pages;
}

/*
 * Reader scripts that carry the page list inside the HTML.
 *
 * MangaThemesia-family sites (the base library behind ~120 extensions in the
 * Keiyoushi extension set, including sasangeyou) do not always put <img>
 * elements in the served HTML. Instead the chapter page ships
 *
 *     <script src="data:text/javascript;base64,dHNfcmVhZGVyLnJ1bih7…"></script>
 *
 * whose decoded payload is `ts_reader.run({"images":["https://…", …]})`. The
 * reference implementation reads `div#readerarea img` first and only falls back
 * to this payload when no usable images were found, which is the same order used
 * here: an ordinary reader is never second-guessed.
 *
 * Nothing is executed. The payload is base64-decoded as text, the JSON array is
 * parsed, and every URL still has to pass publicHttpsUrl (https only, public
 * host, no credentials/port). Anything else is dropped rather than guessed.
 */
const READER_SCRIPT_PATTERN = /(?:src|value)\s*=\s*["']data:text\/javascript;base64,([A-Za-z0-9+/=\s]+)["']/gi;
const IMAGE_LIST_PATTERN = /["']?(?:images|imageUrls)["']?\s*[:=]\s*(\[[^\]]*\])/;

function decodeBase64Text(value: string): string | null {
    const compact = value.replace(/\s+/g, "");
    if (!compact || compact.length % 4 === 1) return null;
    try {
        const scope: any = globalThis as any;
        if (typeof scope.atob === "function") {
            const binary = scope.atob(compact);
            if (typeof scope.TextDecoder === "function") {
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return new scope.TextDecoder("utf-8").decode(bytes);
            }
            return binary;
        }
        if (scope.Buffer && typeof scope.Buffer.from === "function") {
            return scope.Buffer.from(compact, "base64").toString("utf-8");
        }
    } catch (_) { return null; }
    return null;
}

/** Every candidate payload in this HTML, decoded as text. Invalid ones are skipped. */
export function readerScriptPayloads(html: string): string[] {
    const found: string[] = [];
    const text = String(html || "");
    if (text.length === 0) return found;
    READER_SCRIPT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = READER_SCRIPT_PATTERN.exec(text)) !== null && found.length < 8) {
        const decoded = decodeBase64Text(match[1]);
        if (decoded && decoded.length <= UNIVERSAL_MAX_HTML_BYTES) found.push(decoded);
    }
    return found;
}

/** Raw image URLs from a decoded `ts_reader.run({…})` payload, in the site's own order. */
export function readerScriptImageUrls(payload: string): string[] {
    const match = IMAGE_LIST_PATTERN.exec(String(payload || ""));
    if (!match) return [];
    let parsed: any;
    try { parsed = JSON.parse(match[1]); } catch (_) { return []; }
    if (!Array.isArray(parsed)) return [];
    const urls: string[] = [];
    for (const entry of parsed) {
        // A URL never contains literal whitespace; such an entry is prose, not a page.
        if (typeof entry === "string" && entry.trim() !== "" && !/\s/.test(entry.trim()) &&
            urls.length < UNIVERSAL_MAX_PAGES) urls.push(entry.trim());
    }
    return urls;
}

/**
 * Page references from a reader script. Order is the site's own list order
 * (page 1 first), so no numbering strategy is applied or guessed.
 */
export function collectReaderScriptPages(html: string, chapterUrl: string): UniversalPageReference[] {
    if (!publicHttpsUrl(chapterUrl)) throw new UniversalChapterError("url", "Chapter page URL is not allowed.");
    const pages: UniversalPageReference[] = [];
    for (const payload of readerScriptPayloads(html)) {
        for (const raw of readerScriptImageUrls(payload)) {
            const url = publicHttpsUrl(raw, chapterUrl);
            if (!url || url.hash) continue;
            pages.push({ url: url.href, host: url.hostname.toLowerCase() });
            if (pages.length >= UNIVERSAL_MAX_PAGES) return pages;
        }
        if (pages.length) return pages;
    }
    return pages;
}

/** True when this HTML carries a reader script at all (used only for messaging). */
export function hasReaderScript(html: string): boolean {
    return readerScriptPayloads(html).length > 0;
}

const PAGE_COUNT_ATTRIBUTES = ["data-total-pages", "data-page-count", "data-pages", "data-totalpage", "data-num-pages"];
const COUNTER_SELECTOR = '[class*="page" i], [id*="page" i], [class*="counter" i], [id*="counter" i]';

/** Shared decision: one unambiguous total, or nothing. */
function countFromSignals(attributeValues: string[], counterTexts: string[]): number | null {
    const found = new Set<number>();
    const accept = (value: unknown): void => {
        const parsed = typeof value === "string" ? Number(value.trim()) : NaN;
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= UNIVERSAL_MAX_PAGES) found.add(parsed);
    };
    for (const value of attributeValues) accept(value);
    for (const raw of counterTexts) {
        const text = String(raw || "").replace(/\s+/g, " ").trim();
        if (text === "" || text.length > 120) continue;
        // "3 / 57", "Page 3 of 57": the TOTAL is the second number.
        const ofTotal = /(?:^|\b)(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})(?:\b|$)/i.exec(text);
        if (ofTotal) { accept(ofTotal[2]); continue; }
        // "Total: 57 pages", "57 pages".
        const pages = /(?:\b(\d{1,4})\s*pages?\b)/i.exec(text);
        if (pages) accept(pages[1]);
    }
    return found.size === 1 ? Array.from(found)[0] : null;
}

/**
 * Total page count the reader itself advertises, if it states one.
 *
 * Top-down ("scroll mode") readers list every page as an image in document
 * order, so that order IS the page order even when the file names are random
 * hashes. The count is what tells us whether the whole list is really present:
 * lazy-loaded readers only fill images near the viewport, and a short list would
 * otherwise look complete.
 */
export function detectAdvertisedPageCount(doc: Document): number | null {
    try {
        const attributes: string[] = [];
        for (const name of PAGE_COUNT_ATTRIBUTES) {
            for (const node of Array.from(doc.querySelectorAll("[" + name + "]"))) {
                const value = node.getAttribute(name);
                if (value !== null) attributes.push(value);
            }
        }
        const texts = Array.from(doc.querySelectorAll(COUNTER_SELECTOR)).slice(0, 200)
            .map(node => String(node.textContent || ""));
        return countFromSignals(attributes, texts);
    } catch (_) { return null; }
}

function staticNodeText(node: any): string {
    if (!node) return "";
    if (node.type === "text") return String(node.data || "");
    if (!Array.isArray(node.children)) return "";
    let text = "";
    for (const child of node.children) text += " " + staticNodeText(child);
    return text;
}

/** The same count, read from fetched chapter HTML instead of a live DOM. */
export function detectStaticPageCount(html: string): number | null {
    try {
        const tree = parseDocument(String(html || ""), { decodeEntities: true });
        const attributes: string[] = [];
        for (const name of PAGE_COUNT_ATTRIBUTES) {
            for (const node of selectAll("[" + name + "]", tree) as any[]) {
                const value = node.attribs ? node.attribs[name] : undefined;
                if (typeof value === "string") attributes.push(value);
            }
        }
        const texts = (selectAll(COUNTER_SELECTOR, tree) as any[]).slice(0, 200).map(staticNodeText);
        return countFromSignals(attributes, texts);
    } catch (_) { return null; }
}

/** An even spread of scroll offsets that reaches the bottom, bounded. */
export function planScrollSteps(totalHeight: number, viewportHeight: number, maxSteps: number = 80): number[] {
    if (!Number.isFinite(totalHeight) || !Number.isFinite(viewportHeight) || totalHeight <= 0 || viewportHeight <= 0 || maxSteps < 1) {
        return [];
    }
    const last = Math.max(0, Math.round(totalHeight - viewportHeight));
    if (last === 0) return [0];
    const natural = Math.max(1, Math.floor(viewportHeight * 0.8));
    const limit = Math.max(1, Math.floor(maxSteps));
    const count = Math.min(limit, Math.floor(last / natural) + 1);
    if (count === 1) return [0, last];
    const stride = Math.max(natural, Math.ceil(last / (count - 1)));
    const steps: number[] = [];
    for (let i = 0; i < count; i++) steps.push(Math.min(last, i * stride));
    if (steps[steps.length - 1] !== last) steps[steps.length - 1] = last;
    return steps;
}

export interface ScrollCandidate {
    /** "window" or a stable label such as "div#reader" for the log. */
    name: string;
    scrollHeight: number;
    clientHeight: number;
    /** Border-box width; a 1px-wide scroller is a layout artefact. */
    clientWidth?: number;
}

/**
 * Pick the element that actually scrolls the reader. A window-only sweep does
 * nothing when the site scrolls an inner <div>, which is common for "infinite"
 * readers. The largest scrollable area wins; ties keep document order, and a
 * candidate must be genuinely scrollable (more than 200px of hidden content and
 * a visible height) so a tiny overflow box is never mistaken for the reader.
 */
export function pickScrollTarget(candidates: ScrollCandidate[]): ScrollCandidate | null {
    let best: ScrollCandidate | null = null;
    let bestOverflow = 0;
    for (const candidate of candidates) {
        if (!candidate) continue;
        const overflow = Number(candidate.scrollHeight) - Number(candidate.clientHeight);
        if (!Number.isFinite(overflow) || overflow <= 200) continue;
        if (!Number.isFinite(Number(candidate.clientHeight)) || Number(candidate.clientHeight) < 200) continue;
        if (candidate.clientWidth !== undefined && Number(candidate.clientWidth) < 200) continue;
        if (overflow > bestOverflow) { best = candidate; bestOverflow = overflow; }
    }
    return best;
}

export interface ScrollSweepHost {
    scrollTo(y: number): void;
    scrollY(): number;
    scrollHeight(): number;
    viewportHeight(): number;
    wait(ms: number): Promise<void>;
    isCancelled(): boolean;
}

/**
 * Walk a lazily loaded top-down reader from top to bottom so every page element
 * materializes, then leave the scroll position to the caller. Bounded by steps,
 * stops when the height stops growing, and never scrolls while cancelled.
 */
export async function sweepScroll(host: ScrollSweepHost, maxSteps: number = 80): Promise<{ steps: number; reachedBottom: boolean }> {
    let steps = 0;
    let stalls = 0;
    let lastY = -1;
    let lastHeight = -1;
    while (steps < maxSteps) {
        if (host.isCancelled()) return { steps: steps, reachedBottom: false };
        const viewport = host.viewportHeight();
        const height = host.scrollHeight();
        const bottom = Math.max(0, height - viewport);
        const y = host.scrollY();
        if (y >= bottom) {
            // At the bottom: one extra wait so a last lazy image can settle.
            if (height === lastHeight) return { steps: steps, reachedBottom: true };
            lastHeight = height;
        }
        const next = Math.min(bottom, Math.round(y + Math.max(1, Math.floor(viewport * 0.8))));
        host.scrollTo(next);
        await host.wait(120);
        steps++;
        const after = host.scrollY();
        if (after <= lastY && height === lastHeight) {
            stalls++;
            if (stalls >= 2) return { steps: steps, reachedBottom: after >= bottom };
        } else {
            stalls = 0;
        }
        lastY = after;
        lastHeight = height;
    }
    return { steps: steps, reachedBottom: false };
}

/**
 * Which failures are worth one more attempt, and how long to wait.
 *
 * Retrying is bounded and only for transient transport problems. Throttling
 * (429), refusal (401/403), cancellation, a changed tab, an unapproved host and
 * a stale inspection are NOT retried: repeating them either hammers a site that
 * asked us to stop or cannot succeed.
 */
export const RETRYABLE_CODES = ["transfer", "timeout", "http", "network"];
export const RETRY_DELAYS_MS = [400, 1200];

export function retryDelay(code: string, attempt: number, maxAttempts: number = 3): number | null {
    if (attempt < 1 || attempt >= maxAttempts) return null;
    if (RETRYABLE_CODES.indexOf(String(code || "")) === -1) return null;
    const index = Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1);
    return RETRY_DELAYS_MS[index];
}

/**
 * Smallest believable comic page side, in pixels. Below this an "image" is a
 * spacer, tracker, lazy-load placeholder or thumbnail rather than a page, and
 * saving it would silently shrink the archive.
 */
export const MIN_PAGE_DIMENSION = 128;

export interface ImageSize { format: string; width: number; height: number; }

function u16be(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 8) | bytes[offset + 1];
}
function u16le(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}
function u24le(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
function u32le(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Read the real pixel dimensions from the file header. Only formats the probe
 * already accepts are parsed; anything unparsable returns null and is treated
 * as suspicious rather than saved blind.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
    const format = identifyImage(bytes);
    if (!format) return null;
    try {
        if (format === "png" && bytes.length >= 24) {
            const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
            const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
            return width && height ? { format, width, height } : null;
        }
        if (format === "gif" && bytes.length >= 10) {
            const width = u16le(bytes, 6), height = u16le(bytes, 8);
            return width && height ? { format, width, height } : null;
        }
        if (format === "webp" && bytes.length >= 30) {
            const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
            if (chunk === "VP8X") {
                return { format, width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
            }
            if (chunk === "VP8 ") {
                return { format, width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
            }
            if (chunk === "VP8L" && bytes.length >= 25) {
                const bits = u32le(bytes, 21);
                return { format, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
            }
            return null;
        }
        if (format === "jpg") {
            // Walk the segment chain to the first Start-Of-Frame marker.
            let offset = 2;
            while (offset + 9 < bytes.length) {
                if (bytes[offset] !== 0xff) { offset++; continue; }
                const marker = bytes[offset + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
                const length = u16be(bytes, offset + 2);
                if (length < 2) return null;
                const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
                if (isSof) {
                    const height = u16be(bytes, offset + 5), width = u16be(bytes, offset + 7);
                    return width && height ? { format, width, height } : null;
                }
                offset += 2 + length;
            }
            return null;
        }
    } catch (_) { return null; }
    // AVIF dimensions live in an ISO-BMFF box tree; treat as unknown (accepted,
    // never rejected for size) rather than guessing from partial headers.
    return format === "avif" ? { format, width: NaN, height: NaN } : null;
}

/** Reject spacer/tracker/placeholder images before they reach an archive. */
export function assertUsablePage(bytes: Uint8Array, minDimension: number = MIN_PAGE_DIMENSION): ImageSize {
    const size = readImageSize(bytes);
    if (!size) throw new UniversalChapterError("format", "The page image has no readable dimensions.");
    if (Number.isFinite(size.width) && Number.isFinite(size.height) &&
        (size.width < minDimension || size.height < minDimension)) {
        throw new UniversalChapterError("too-small",
            "The page image is too small to be a page (" + size.width + "×" + size.height + ").");
    }
    return size;
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
