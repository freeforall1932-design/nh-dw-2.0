import { extractGalleryFromHtml, looksLikeGallery } from "../parsing/GalleryEmbed";

// Run a function in the tab's MAIN world and return its result. Supports both
// the Promise and callback forms of chrome.scripting.executeScript.
export function executeInTab<T>(tabId: number, func: (...args: any[]) => T, args: any[] = [], world: "MAIN" | "ISOLATED" = "MAIN"): Promise<T | null> {
    return new Promise((resolve) => {
        if (typeof chrome === "undefined" || !(chrome as any).scripting || typeof (chrome as any).scripting.executeScript !== "function") {
            resolve(null);
            return;
        }
        let settled = false;
        const finish = (value: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        const details: any = {
            target: { tabId: tabId },
            world: world,
            func: func,
            args: args
        };
        try {
            const result: any = (chrome as any).scripting.executeScript(details, (results: any[]) => {
                if (chrome.runtime.lastError || !results || !results[0]) {
                    finish(null);
                } else {
                    finish((results[0].result as T) ?? null);
                }
            });
            if (result && typeof result.then === "function") {
                result.then((results: any[]) => {
                    if (!results || !results[0]) {
                        finish(null);
                    } else {
                        finish((results[0].result as T) ?? null);
                    }
                }).catch(() => finish(null));
            }
        } catch (_) {
            finish(null);
        }
    });
}

export async function getActiveTabId(): Promise<number | undefined> {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs && tabs[0] ? tabs[0].id : undefined);
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function tryParseGalleryText(text: string): any | null {
    if (!text) return null;
    const trimmed = text.trim();
    // Try JSON first (API response)
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (looksLikeGallery(parsed)) return parsed;
        } catch (_) {
            // fall through to HTML parsing
        }
    }
    const fromHtml = extractGalleryFromHtml(text);
    if (looksLikeGallery(fromHtml)) return fromHtml;
    return null;
}

async function fetchTextInTab(tabId: number, url: string): Promise<string | null> {
    const result = await executeInTab(tabId, (u: string) => {
        return (fetch as any)(u, { credentials: "include", cache: "no-store" })
            .then(function (r: any) {
                if (!r.ok) return null;
                return r.text();
            })
            .catch(function () {
                return null;
            });
    }, [url], "MAIN");
    return typeof result === "string" ? result : null;
}

async function fetchJsonInTab(tabId: number, url: string): Promise<any | null> {
    const result = await executeInTab(tabId, async (u: string) => {
        try {
            const resp = await fetch(u, { credentials: "include", cache: "no-store" });
            if (!resp.ok) return null;
            // API should be JSON but be tolerant
            const txt = await resp.text();
            try {
                return JSON.parse(txt);
            } catch (_) {
                return null;
            }
        } catch (_) {
            return null;
        }
    }, [url], "MAIN");
    return result;
}

// Read gallery metadata from an already-open nhentai tab.
// 1. window._gallery / window.gallery (no network)
// 2. parse script tags already in the document (no network)
// 3. same-origin /api/gallery/<id> via tab fetch
// 4. same-origin gallery pages /g/<id>/ and /g/<id>/1/ via tab fetch + HTML parsing
// Steps 1-2 are retried a few times to cover late-setting JS and challenge pages.
export async function readGalleryFromTab(tabId: number, galleryId?: string): Promise<any | null> {
    // Poll the DOM a few times — window._gallery is set by an inline script that
    // may run after the tab's `complete` event (or after a Cloudflare interstitial).
    for (let attempt = 0; attempt < 5; attempt++) {
        const page = await executeInTab(tabId, () => {
            const gallery = (window as any)._gallery || (window as any).gallery || null;
            const scripts: string[] = [];
            try {
                const nodes = document.getElementsByTagName("script");
                for (let i = 0; i < nodes.length; i++) {
                    const text = nodes[i].textContent || "";
                    if (text.indexOf("_gallery") !== -1) {
                        scripts.push(text);
                    }
                }
                // Also capture full HTML for fallback parsing if needed
                // (truncated to first 200k chars to avoid huge transfer).
            } catch (_) {}
            return { gallery: gallery, scripts: scripts, html: document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : "" };
        });

        // Mocks and older injectors may return the gallery object directly.
        if (looksLikeGallery(page)) {
            return page;
        }
        if (page && looksLikeGallery((page as any).gallery)) {
            return (page as any).gallery;
        }
        if (page && Array.isArray((page as any).scripts)) {
            const scripts: string[] = (page as any).scripts;
            for (let i = 0; i < scripts.length; i++) {
                const parsed = extractGalleryFromHtml(scripts[i]);
                if (looksLikeGallery(parsed)) {
                    return parsed;
                }
            }
            // As a last resort for this attempt, try parsing the outerHTML
            const html = (page as any).html as string;
            if (html) {
                const parsed = extractGalleryFromHtml(html);
                if (looksLikeGallery(parsed)) return parsed;
            }
        }
        if (attempt < 4) {
            await sleep(400 + attempt * 200);
        }
    }

    if (!galleryId) {
        return null;
    }

    // Same-origin /api/gallery fetch via the tab (reuses Cloudflare clearance).
    const apiGallery = await fetchJsonInTab(tabId, "/api/gallery/" + galleryId);
    if (looksLikeGallery(apiGallery)) {
        return apiGallery;
    }

    // Fallback: fetch gallery pages via the tab and parse embedded JSON.
    // Both /g/<id>/ and /g/<id>/1/ are tried because historic code used /1/
    // and some mirrors may only contain the embed on one of them.
    const galleryUrls = [
        "https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/",
        "https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/1/"
    ];
    for (const url of galleryUrls) {
        const text = await fetchTextInTab(tabId, url);
        if (!text) continue;
        const parsed = tryParseGalleryText(text);
        if (looksLikeGallery(parsed)) return parsed;
    }

    return null;
}

// Public helper used by the selected-gallery resolver to fetch metadata
// through an already-open tab (e.g. the homepage) without opening a new one.
export async function fetchGalleryViaTab(tabId: number, galleryId: string): Promise<any | null> {
    const apiGallery = await fetchJsonInTab(tabId, "https://nhentai.net/api/gallery/" + encodeURIComponent(galleryId));
    if (looksLikeGallery(apiGallery)) return apiGallery;

    const urls = [
        "https://nhentai.net/api/gallery/" + encodeURIComponent(galleryId),
        "https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/",
        "https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/1/"
    ];
    for (const u of urls) {
        const text = await fetchTextInTab(tabId, u);
        if (!text) continue;
        const parsed = tryParseGalleryText(text);
        if (looksLikeGallery(parsed)) return parsed;
    }
    return null;
}
