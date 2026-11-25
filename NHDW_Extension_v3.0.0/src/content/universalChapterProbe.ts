/* Explicitly injected into the user's chosen tab via activeTab. No listener
 * is installed on arbitrary sites until the user opens and scans a page. */
import {
    UNIVERSAL_MAX_HTML_BYTES, UNIVERSAL_MAX_IMAGE_BYTES,
    UniversalChapterError, ImageAttribute, UniversalPageReference,
    publicHttpsUrl, discoverChapters, collectChapterPages, collectStaticChapterPages, PageOrderStrategy,
    detectAdvertisedPageCount, detectStaticPageCount, sweepScroll, pickScrollTarget,
    collectReaderScriptPages, hasReaderScript, applyFullSizeSuffix,
    collectNextDataPages, collectNextDataPagesFromText,
    assertUsablePage, ScrollCandidate, MIN_PAGE_DIMENSION,
    readBoundedResponse, checkResponse, identifyImage, UNIVERSAL_MAX_CHAPTERS, pauseBetweenChapterRequests, ChapterPageCollection
} from "../utils/universalChapter";
import {
    decodeTurboStream, routeLoaderData, singleFetchDataUrl, hasRouterContext,
    routeDataImageUrls, routeDataPageRefs, routeDataRecipeFor, walkSeries, RouteDataRecipe, SeriesPart
} from "../utils/routeData";

const scope: any = globalThis as any;
if (!scope.__nhdwChapterProbe) {
    scope.__nhdwChapterProbe = true;
    const inspected = new Map<string, { url: string; pages: UniversalPageReference[] }>();
    // Decoded route data per data URL, so a series scan followed by inspection
    // does not request the same chapter data twice. Cleared on every scan.
    const routeCache = new Map<string, Record<string, any>>();
    let currentController: AbortController | null = null;
    let cancelled = false;

    function currentPage(): URL {
        const raw = new URL(location.href);
        raw.hash = "";
        const url = publicHttpsUrl(raw.href);
        if (!url) throw new UniversalChapterError("url", "Open a public HTTPS page first.");
        return url;
    }
    function assertOrigin(origin: string): URL {
        const current = currentPage();
        if (!origin || current.origin !== origin) {
            throw new UniversalChapterError("tab-changed", "The source tab changed sites. Return to the original site and scan again.");
        }
        return current;
    }
    /**
     * `sendReferrer` is the user's explicit, per-site opt-in. It switches the
     * browser's own referrer policy to "strict-origin", so Chrome itself sends
     * the source site's origin (e.g. https://site.example/) — the truthful value
     * for a request made from that tab. No header is set or forged by this code.
     */
    async function boundedFetch(url: string, kind: "html" | "image" | "data", sendReferrer: boolean = false): Promise<Uint8Array> {
        const controller = new AbortController();
        currentController = controller;
        cancelled = false;
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const resp = await fetch(url, {
                method: "GET", mode: "cors", credentials: "same-origin", redirect: "error",
                referrerPolicy: sendReferrer ? "strict-origin" : "no-referrer", cache: "no-store", signal: controller.signal
            });
            checkResponse(resp);
            const mime = (resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
            if (kind === "html" && mime && mime !== "text/html" && mime !== "application/xhtml+xml") {
                throw new UniversalChapterError("format", "The chapter response is not HTML.");
            }
            if (kind === "image" && mime && !mime.startsWith("image/") && mime !== "application/octet-stream") {
                throw new UniversalChapterError("format", "The page response is not an image.");
            }
            // React Router serves page data as text/x-script; an HTML answer means
            // the site does not serve ".data" for this path.
            if (kind === "data" && mime && ["text/x-script", "text/plain", "application/json", "application/octet-stream"].indexOf(mime) === -1) {
                throw new UniversalChapterError("format", "The site did not answer with page data.");
            }
            return await readBoundedResponse(resp, kind === "image" ? UNIVERSAL_MAX_IMAGE_BYTES : UNIVERSAL_MAX_HTML_BYTES, controller.signal);
        } catch (error) {
            if (cancelled) throw new UniversalChapterError("cancelled", "Cancelled.");
            if (controller.signal.aborted) throw new UniversalChapterError("timeout", "The request timed out.");
            if (error instanceof UniversalChapterError) throw error;
            throw new UniversalChapterError("transfer", "The request failed or was blocked by the browser/site. No bypass was attempted.");
        } finally {
            clearTimeout(timeout);
            if (currentController === controller) currentController = null;
        }
    }
    function base64(bytes: Uint8Array): string {
        let result = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            result += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
        }
        return btoa(result);
    }
    /**
     * Which element scrolls this reader? A window-only sweep does nothing on an
     * "infinite" reader that scrolls an inner div, so the inner container is
     * detected and named (never guessed from CSS class names).
     */
    function findScrollElement(): { element: Element; name: string } | "window" {
        const candidates: { candidate: ScrollCandidate; element: Element | null }[] = [
            { candidate: { name: "window", scrollHeight: Math.max(document.documentElement.scrollHeight || 0, (document.body && document.body.scrollHeight) || 0), clientHeight: window.innerHeight || 0, clientWidth: window.innerWidth || 0 }, element: null }
        ];
        const nodes = Array.from(document.querySelectorAll("body *")).slice(0, 4000);
        for (const node of nodes) {
            const el = node as HTMLElement;
            try {
                if (!el.clientHeight || el.clientHeight >= (window.innerHeight || 0) * 1.5) continue;
                const overflow = window.getComputedStyle ? window.getComputedStyle(el).overflowY : "";
                if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") continue;
                candidates.push({
                    candidate: { name: el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, clientWidth: el.clientWidth },
                    element: el
                });
            } catch (_) { /* detached or restricted node */ }
        }
        const best = pickScrollTarget(candidates.map(entry => entry.candidate));
        if (!best) return "window";
        if (best.name === "window") return "window";
        const match = candidates.find(entry => entry.element !== null && entry.candidate.name === best.name);
        return match && match.element ? { element: match.element, name: best.name } : "window";
    }

    /**
     * The page's own base64 reader scripts, re-serialised so the shared parser
     * (which works on HTML text) can be reused unchanged. Only the src/value
     * attributes are needed; no script is executed.
     */
    function readerScriptSource(): string {
        const parts: string[] = [];
        const nodes = document.querySelectorAll("script");
        for (let i = 0; i < nodes.length && i < 200; i++) {
            const value = nodes[i].getAttribute("src") || "";
            if (value.indexOf("data:text/javascript;base64,") === 0) parts.push('<script src="' + value + '"></script>');
        }
        return parts.join("");
    }

    /** Loader data for a page, from the site's own ".data" endpoint (cached). */
    async function readRouteData(pageUrl: string, recipe: RouteDataRecipe | null): Promise<Record<string, any>> {
        const dataUrl = singleFetchDataUrl(pageUrl, recipe ? [recipe.chapterRoute] : null, !recipe);
        if (!dataUrl) throw new UniversalChapterError("url", "Chapter page URL is not allowed.");
        const cached = routeCache.get(dataUrl.href);
        if (cached) return cached;
        if (cancelled) throw new UniversalChapterError("cancelled", "Cancelled.");
        const bytes = await boundedFetch(dataUrl.href, "data");
        const loaders = routeLoaderData(decodeTurboStream(new TextDecoder("utf-8").decode(bytes)));
        if (routeCache.size >= UNIVERSAL_MAX_CHAPTERS + 10) routeCache.clear();
        routeCache.set(dataUrl.href, loaders);
        return loaders;
    }
    /** Pages (and the site's stated total) from a known-site recipe; none when this URL is not one of its chapters. */
    async function recipePages(recipe: RouteDataRecipe, chapterUrl: URL): Promise<{ pages: UniversalPageReference[]; advertised: number | null }> {
        if (recipe.chapterSlug(chapterUrl.pathname) === null) return { pages: [], advertised: null };
        const data = (await readRouteData(chapterUrl.href, recipe))[recipe.chapterRoute];
        return { pages: routeDataPageRefs(recipe.pages(data), chapterUrl.href), advertised: recipe.advertised(data) };
    }
    /** Unknown React Router site: one unambiguous URL list in its page data, else []. */
    async function genericRoutePages(chapterUrl: URL): Promise<UniversalPageReference[]> {
        try {
            return routeDataPageRefs(routeDataImageUrls(await readRouteData(chapterUrl.href, null)), chapterUrl.href);
        } catch (error) {
            if (cancelled) throw new UniversalChapterError("cancelled", "Cancelled.");
            return [];
        }
    }
    function liveRouterContext(): boolean {
        const nodes = document.querySelectorAll("script:not([src])");
        for (let i = 0; i < nodes.length && i < 200; i++) {
            if (hasRouterContext(String(nodes[i].textContent || "").slice(0, 4096))) return true;
        }
        return false;
    }
    function listCollection(pages: UniversalPageReference[]): ChapterPageCollection {
        return { pages: pages, order: "reader", readerOrderDiffers: false, preview: pages.slice(0, 3).map(page => page.host) };
    }
    /** Every linked part of the series this chapter belongs to, oldest first. */
    async function scanSeries(recipe: RouteDataRecipe, source: URL): Promise<{ chapters: any[]; truncated: boolean; broken: boolean } | null> {
        const slug = recipe.chapterSlug(source.pathname);
        if (slug === null) return null;
        const partOf = async (pageUrl: string): Promise<SeriesPart | null> =>
            recipe.part((await readRouteData(pageUrl, recipe))[recipe.chapterRoute]);
        const start = await partOf(source.href);
        if (!start) return null;
        cancelled = false;
        const walk = await walkSeries(start, async (next: string) => {
            if (cancelled) throw new UniversalChapterError("cancelled", "Cancelled.");
            await pauseBetweenChapterRequests();
            try { return await partOf(recipe.chapterUrl(source.origin, next)); } catch (error) {
                if (cancelled) throw new UniversalChapterError("cancelled", "Cancelled.");
                return null;
            }
        });
        return {
            chapters: walk.parts.map((part, i) => ({ id: "part-" + i, label: part.name, url: recipe.chapterUrl(source.origin, part.slug) })),
            truncated: walk.truncated, broken: walk.broken
        };
    }

    async function handle(message: any): Promise<any> {
        if (message.op === "cancel") {
            cancelled = true;
            if (currentController) currentController.abort();
            return { ok: true };
        }
        if (message.op === "scan") {
            const source = currentPage();
            routeCache.clear();
            cancelled = false;
            const title = String(document.title || "Untitled").replace(/\s+/g, " ").trim().slice(0, 180);
            if (message.mode === "current") {
                return { ok: true, origin: source.origin, sourcePath: source.pathname,
                    title: title, chapters: [{ id: "current", label: title, url: source.href, current: true }], truncated: false };
            }
            // A known site with a linked series: read every part from the site's
            // own page data instead of guessing from links on this page.
            const recipe = routeDataRecipeFor(source.origin);
            if (recipe) {
                let series = null;
                try { series = await scanSeries(recipe, source); } catch (error) {
                    if (error instanceof UniversalChapterError && error.code === "cancelled") throw error;
                    series = null;
                }
                if (series && series.chapters.length) {
                    return { ok: true, origin: source.origin, sourcePath: source.pathname, title: title,
                        chapters: series.chapters, truncated: series.truncated, source: "route-data",
                        seriesBroken: series.broken, ordered: "oldest", referrerHint: recipe.imagesExpectReferrer };
                }
            }
            const result = discoverChapters(document, source.href, String(message.selector || ""), {
                includeOutsideTitlePath: message.includeOutsideTitlePath === true,
                filterChapterLabels: message.filterChapterLabels !== false
            });
            return { ok: true, origin: source.origin, sourcePath: source.pathname,
                title: title, chapters: result.chapters, truncated: result.truncated };
        }
        if (message.op === "inspect") {
            cancelled = false;
            const current = assertOrigin(String(message.origin || ""));
            const chapter = publicHttpsUrl(String(message.chapterUrl || ""));
            const id = String(message.id || "");
            if (!chapter || chapter.origin !== current.origin || !/^[a-z0-9-]{1,64}$/.test(id)) {
                throw new UniversalChapterError("url", "The selected chapter is not on the source site.");
            }
            const selector = String(message.selector || "");
            const attribute = String(message.attribute || "auto") as ImageAttribute;
            const order = String(message.order || "reader") as PageOrderStrategy;
            let collection: ChapterPageCollection | null = null;
            let advertised: number | null = null;
            // Where the page list came from, so the review can say so instead of
            // presenting a translated list as if it were the reader's own.
            let source: "dom" | "static" | "reader-script" | "next-data" | "route-data" = "dom";
            if (message.current === true && chapter.href !== current.href) {
                throw new UniversalChapterError("tab-changed", "Return to the selected chapter and scan again.");
            }
            // A known site's own page data first: complete, ordered, full size.
            // On any failure the reader's images are still tried below.
            const recipe = routeDataRecipeFor(current.origin);
            if (recipe) {
                try {
                    const read = await recipePages(recipe, chapter);
                    if (read.pages.length) { collection = listCollection(read.pages); source = "route-data"; advertised = read.advertised; }
                } catch (error) {
                    if (error instanceof UniversalChapterError && error.code === "cancelled") throw error;
                }
            }
            if (collection) {
                // already read from page data
            } else if (message.current === true) {
                if (chapter.href !== current.href) throw new UniversalChapterError("tab-changed", "Return to the selected chapter and scan again.");
                try {
                    collection = collectChapterPages(document, document.baseURI, selector, attribute, order);
                } catch (error) {
                    // MangaThemesia-style readers may hold the page list in a
                    // base64 script rather than in <img> elements.
                    const scripted = collectReaderScriptPages(readerScriptSource(), current.href);
                    if (scripted.length) {
                        collection = { pages: scripted, order: "reader", readerOrderDiffers: false,
                            preview: scripted.slice(0, 3).map(page => page.host) };
                        source = "reader-script";
                    } else {
                        // Next.js sites ship the ordered list as page data.
                        const node = document.getElementById("__NEXT_DATA__");
                        const text = node && node.tagName.toLowerCase() === "script" ? String(node.textContent || "") : null;
                        const next = collectNextDataPagesFromText(text, current.href, current.href);
                        if (next.stale) {
                            throw new UniversalChapterError("stale-page-data",
                                "This tab's embedded page data belongs to a page opened earlier (the site switched pages without reloading). Reload the chapter tab, then try again.");
                        }
                        if (next.pages.length) {
                            collection = listCollection(next.pages);
                            source = "next-data";
                        } else {
                            // React Router / Remix sites: the page's own ".data".
                            const routed = liveRouterContext() ? await genericRoutePages(chapter) : [];
                            if (!routed.length) throw error;
                            collection = listCollection(routed);
                            source = "route-data";
                        }
                    }
                }
            } else {
                const data = await boundedFetch(chapter.href, "html");
                const html = new TextDecoder("utf-8").decode(data);
                advertised = detectStaticPageCount(html);
                try {
                    collection = collectStaticChapterPages(html, chapter.href, selector, attribute, order);
                    source = "static";
                } catch (error) {
                    const scripted = collectReaderScriptPages(html, chapter.href);
                    const next = scripted.length ? [] : collectNextDataPages(html, chapter.href);
                    const fallback = scripted.length ? scripted : next;
                    if (fallback.length) {
                        collection = listCollection(fallback);
                        source = scripted.length ? "reader-script" : "next-data";
                    } else {
                        const routed = hasRouterContext(html) ? await genericRoutePages(chapter) : [];
                        if (!routed.length) throw error;
                        collection = listCollection(routed);
                        source = "route-data";
                    }
                }
            }
            // An explicit thumbnail rule may rewrite every page URL; it is all or
            // nothing, and it happens before hosts are reported for approval.
            if (!collection) throw new UniversalChapterError("format", "No page list was found.");
            let pages = collection.pages;
            let suffixChanged = 0;
            const suffix = typeof message.fullSizeSuffix === "string" ? message.fullSizeSuffix : "";
            if (suffix !== "") {
                const applied = applyFullSizeSuffix(pages, suffix);
                pages = applied.pages;
                suffixChanged = applied.changed;
            }
            inspected.set(id, { url: chapter.href, pages: pages });
            // pageHosts lets the panel (and the benchmark) pick a page on a host
            // the user has already approved, instead of trial and error.
            return { ok: true, count: pages.length, source: source, suffixChanged: suffixChanged,
                hosts: Array.from(new Set(pages.map(page => page.host))),
                pageHosts: pages.slice(0, 400).map(page => page.host),
                order: collection.order, readerOrderDiffers: collection.readerOrderDiffers, preview: collection.preview,
                advertised: message.current === true && source !== "route-data" ? detectAdvertisedPageCount(document) : advertised };
        }
        if (message.op === "loadall") {
            const current = assertOrigin(String(message.origin || ""));
            const chapter = publicHttpsUrl(String(message.chapterUrl || ""));
            if (!chapter || chapter.href !== current.href) {
                throw new UniversalChapterError("tab-changed", "Open the chapter itself in the source tab before loading all pages.");
            }
            cancelled = false;
            const target = findScrollElement();
            const element: any = target === "window" ? null : target.element;
            const originalWindow = window.scrollY || document.documentElement.scrollTop || 0;
            const originalElement = element ? element.scrollTop : 0;
            const result = await sweepScroll({
                scrollTo: (y: number) => {
                    try {
                        if (element) element.scrollTop = y;
                        else window.scrollTo(0, y);
                    } catch (_) { /* jsdom/odd contexts */ }
                },
                scrollY: () => element ? element.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0),
                scrollHeight: () => element ? element.scrollHeight : Math.max(document.documentElement.scrollHeight || 0, (document.body && document.body.scrollHeight) || 0),
                viewportHeight: () => element ? element.clientHeight : (window.innerHeight || 800),
                wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
                isCancelled: () => cancelled
            }, Number.isInteger(message.maxSteps) ? message.maxSteps : 80);
            try {
                if (element) element.scrollTop = originalElement;
                else window.scrollTo(0, originalWindow);
            } catch (_) { /* cosmetic */ }
            return { ok: true, steps: result.steps, reachedBottom: result.reachedBottom, scrolledElement: target === "window" ? "window" : target.name,
                iframes: document.querySelectorAll("iframe").length,
                images: document.querySelectorAll("img").length, advertised: detectAdvertisedPageCount(document) };
        }
        if (message.op === "page") {
            assertOrigin(String(message.origin || ""));
            const id = String(message.id || "");
            const snapshot = inspected.get(id);
            const index = message.index;
            if (!snapshot || !Number.isInteger(index) || index < 0 || index >= snapshot.pages.length) {
                throw new UniversalChapterError("stale", "Chapter inspection expired; inspect the selection again.");
            }
            const page = snapshot.pages[index];
            if (!Array.isArray(message.approvedHosts) || message.approvedHosts.indexOf(page.host) === -1) {
                throw new UniversalChapterError("approval", "The image host was not approved.");
            }
            const bytes = await boundedFetch(page.url, "image", message.sendReferrer === true);
            const ext = identifyImage(bytes);
            if (!ext) throw new UniversalChapterError("format", "The page bytes do not have a supported image signature.");
            // Spacers, lazy-load placeholders and 1x1 trackers are not pages.
            const dimensions = assertUsablePage(bytes, MIN_PAGE_DIMENSION);
            return { ok: true, base64: base64(bytes), extension: ext, size: bytes.length,
                width: dimensions.width, height: dimensions.height, pageHost: page.host };
        }
        throw new UniversalChapterError("command", "Unknown chapter command.");
    }

    chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: (result: any) => void) => {
        if (!message || message.action !== "nhdwUniversalChapter" || !sender || sender.id !== chrome.runtime.id) return false;
        handle(message).then(sendResponse, (error: any) => {
            const known = error instanceof UniversalChapterError;
            sendResponse({ ok: false, code: known ? error.code : "error", error: known ? error.message : "Unable to inspect or download this chapter." });
        });
        return true;
    });
}
