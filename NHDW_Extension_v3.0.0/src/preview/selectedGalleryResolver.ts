import { clearnetSource } from "../sources/GallerySource";
import { looksLikeGallery } from "../parsing/GalleryEmbed";
import { readGalleryFromTab, fetchGalleryViaTab } from "./activeTabGallery";

// Resolve selected galleries through the user's existing tab session first
// (reuses Cloudflare clearance, no extra tabs), then falls back to short-lived
// browser tabs. Resolution is deliberately sequential: at most one temporary
// tab exists at a time.

function waitForTabLoad(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error("Timed out waiting for gallery tab"));
        }, 25000);
        const listener = (updatedTabId: number, changeInfo: any) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                return;
            }
            if (tab && tab.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function resolveOneViaNewTab(id: string): Promise<any | null> {
    let tab: chrome.tabs.Tab | undefined;
    try {
        tab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
            chrome.tabs.create({ url: clearnetSource.getGalleryUrl(id), active: false }, (created) => {
                if (chrome.runtime.lastError || !created || created.id === undefined) {
                    reject(new Error(chrome.runtime.lastError?.message || "Unable to open gallery tab"));
                } else {
                    resolve(created);
                }
            });
        });
        await waitForTabLoad(tab.id!);
        // The page's JS may set _gallery a moment after `complete`; poll a few times.
        for (let attempt = 0; attempt < 5; attempt++) {
            const gallery = await readGalleryFromTab(tab.id!, id);
            if (looksLikeGallery(gallery)) return gallery;
            if (attempt < 4) await sleep(500 + attempt * 300);
        }
        return null;
    } catch (_) {
        return null;
    } finally {
        if (tab && tab.id !== undefined) {
            chrome.tabs.remove(tab.id, () => { /* best effort cleanup */ });
        }
    }
}

export async function resolveSelectedGalleries(ids: string[], sourceTabId?: number): Promise<Record<string, any>> {
    const resolved: Record<string, any> = {};
    for (const id of ids) {
        // First try to reuse the existing homepage / gallery tab's session.
        // This avoids opening 30 temporary tabs and reuses an already-cleared
        // Cloudflare clearance.
        if (typeof sourceTabId === "number") {
            try {
                const viaSource = await fetchGalleryViaTab(sourceTabId, id);
                if (looksLikeGallery(viaSource)) {
                    resolved[id] = viaSource;
                    continue;
                }
            } catch (_) {
                // fall through to new-tab path
            }
        }
        const gallery = await resolveOneViaNewTab(id);
        if (gallery !== null) {
            resolved[id] = gallery;
        }
    }
    return resolved;
}
