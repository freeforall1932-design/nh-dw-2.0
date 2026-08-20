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

// Read gallery metadata from an already-open nhentai tab.
// 1. window._gallery / window.gallery (no network)
// 2. parse script tags already in the document (no network)
// 3. same-origin /api/gallery/<id> only if the page did not already contain JSON
export async function readGalleryFromTab(tabId: number, galleryId?: string): Promise<any | null> {
    const page = await executeInTab(tabId, () => {
        const gallery = (window as any)._gallery || (window as any).gallery || null;
        const scripts: string[] = [];
        const nodes = document.getElementsByTagName("script");
        for (let i = 0; i < nodes.length; i++) {
            const text = nodes[i].textContent || "";
            if (text.indexOf("_gallery") !== -1) {
                scripts.push(text);
            }
        }
        return { gallery: gallery, scripts: scripts };
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
    }

    if (!galleryId) {
        return null;
    }

    const apiGallery = await executeInTab(tabId, async (id: string) => {
        try {
            const resp = await fetch("/api/gallery/" + id, { credentials: "include", cache: "no-store" });
            if (!resp.ok) {
                return null;
            }
            return await resp.json();
        } catch (_) {
            return null;
        }
    }, [galleryId]);

    return looksLikeGallery(apiGallery) ? apiGallery : null;
}
