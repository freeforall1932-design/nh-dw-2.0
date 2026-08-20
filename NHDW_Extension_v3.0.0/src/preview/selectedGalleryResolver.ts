import { clearnetSource } from "../sources/GallerySource";

// Resolve selected galleries through short-lived browser tabs so metadata can
// be read with the user's normal page session. Resolution is deliberately
// sequential: at most one temporary tab exists at a time.

function looksLikeGallery(value: any): boolean {
    return value !== null && typeof value === "object"
        && value.title !== undefined && value.images !== undefined
        && Array.isArray(value.images.pages);
}

function waitForTabLoad(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error("Timed out waiting for gallery tab"));
        }, 15000);
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

async function resolveOne(id: string): Promise<any | null> {
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
        const results: any[] = await new Promise((resolve) => {
            // @ts-ignore Older @types/chrome do not include scripting/world.
            chrome.scripting.executeScript(<any>{
                target: { tabId: tab!.id! },
                world: "MAIN",
                func: () => (window as any)._gallery || null
            }, (value: any[]) => resolve(value || []));
        });
        const gallery = results[0] && results[0].result;
        return looksLikeGallery(gallery) ? gallery : null;
    } catch (_) {
        return null;
    } finally {
        if (tab && tab.id !== undefined) {
            chrome.tabs.remove(tab.id, () => { /* best effort cleanup */ });
        }
    }
}

export async function resolveSelectedGalleries(ids: string[]): Promise<Record<string, any>> {
    const resolved: Record<string, any> = {};
    for (const id of ids) {
        const gallery = await resolveOne(id);
        if (gallery !== null) {
            resolved[id] = gallery;
        }
    }
    return resolved;
}
