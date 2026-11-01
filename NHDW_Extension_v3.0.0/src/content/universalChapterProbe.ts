/* Explicitly injected into the user's chosen tab via activeTab. No listener
 * is installed on arbitrary sites until the user opens and scans a page. */
import {
    UNIVERSAL_MAX_HTML_BYTES, UNIVERSAL_MAX_IMAGE_BYTES,
    UniversalChapterError, ImageAttribute, UniversalPageReference,
    publicHttpsUrl, discoverChapters, collectChapterPages, collectStaticChapterPages, PageOrderStrategy,
    detectAdvertisedPageCount, detectStaticPageCount, sweepScroll, pickScrollTarget,
    collectReaderScriptPages, hasReaderScript, applyFullSizeSuffix,
    assertUsablePage, ScrollCandidate, MIN_PAGE_DIMENSION,
    readBoundedResponse, checkResponse, identifyImage
} from "../utils/universalChapter";

const scope: any = globalThis as any;
if (!scope.__nhdwChapterProbe) {
    scope.__nhdwChapterProbe = true;
    const inspected = new Map<string, { url: string; pages: UniversalPageReference[] }>();
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
    async function boundedFetch(url: string, kind: "html" | "image"): Promise<Uint8Array> {
        const controller = new AbortController();
        currentController = controller;
        cancelled = false;
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const resp = await fetch(url, {
                method: "GET", mode: "cors", credentials: "same-origin", redirect: "error",
                referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal
            });
            checkResponse(resp);
            const mime = (resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
            if (kind === "html" && mime && mime !== "text/html" && mime !== "application/xhtml+xml") {
                throw new UniversalChapterError("format", "The chapter response is not HTML.");
            }
            if (kind === "image" && mime && !mime.startsWith("image/") && mime !== "application/octet-stream") {
                throw new UniversalChapterError("format", "The page response is not an image.");
            }
            return await readBoundedResponse(resp, kind === "html" ? UNIVERSAL_MAX_HTML_BYTES : UNIVERSAL_MAX_IMAGE_BYTES, controller.signal);
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

    async function handle(message: any): Promise<any> {
        if (message.op === "cancel") {
            cancelled = true;
            if (currentController) currentController.abort();
            return { ok: true };
        }
        if (message.op === "scan") {
            const source = currentPage();
            const title = String(document.title || "Untitled").replace(/\s+/g, " ").trim().slice(0, 180);
            if (message.mode === "current") {
                return { ok: true, origin: source.origin, sourcePath: source.pathname,
                    title: title, chapters: [{ id: "current", label: title, url: source.href, current: true }], truncated: false };
            }
            const result = discoverChapters(document, source.href, String(message.selector || ""), {
                includeOutsideTitlePath: message.includeOutsideTitlePath === true,
                filterChapterLabels: message.filterChapterLabels !== false
            });
            return { ok: true, origin: source.origin, sourcePath: source.pathname,
                title: title, chapters: result.chapters, truncated: result.truncated };
        }
        if (message.op === "inspect") {
            const current = assertOrigin(String(message.origin || ""));
            const chapter = publicHttpsUrl(String(message.chapterUrl || ""));
            const id = String(message.id || "");
            if (!chapter || chapter.origin !== current.origin || !/^[a-z0-9-]{1,64}$/.test(id)) {
                throw new UniversalChapterError("url", "The selected chapter is not on the source site.");
            }
            const selector = String(message.selector || "");
            const attribute = String(message.attribute || "auto") as ImageAttribute;
            const order = String(message.order || "reader") as PageOrderStrategy;
            let collection;
            let advertised: number | null = null;
            // Where the page list came from, so the review can say so instead of
            // presenting a translated list as if it were the reader's own.
            let source: "dom" | "static" | "reader-script" = "dom";
            if (message.current === true) {
                if (chapter.href !== current.href) throw new UniversalChapterError("tab-changed", "Return to the selected chapter and scan again.");
                try {
                    collection = collectChapterPages(document, document.baseURI, selector, attribute, order);
                } catch (error) {
                    // MangaThemesia-style readers may hold the page list in a
                    // base64 script rather than in <img> elements.
                    const scripted = collectReaderScriptPages(readerScriptSource(), current.href);
                    if (!scripted.length) throw error;
                    collection = { pages: scripted, order: "reader", readerOrderDiffers: false,
                        preview: scripted.slice(0, 3).map(page => page.host) };
                    source = "reader-script";
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
                    if (!scripted.length) throw error;
                    collection = { pages: scripted, order: "reader", readerOrderDiffers: false,
                        preview: scripted.slice(0, 3).map(page => page.host) };
                    source = "reader-script";
                }
            }
            // An explicit thumbnail rule may rewrite every page URL; it is all or
            // nothing, and it happens before hosts are reported for approval.
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
                advertised: message.current === true ? detectAdvertisedPageCount(document) : advertised };
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
            const bytes = await boundedFetch(page.url, "image");
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
