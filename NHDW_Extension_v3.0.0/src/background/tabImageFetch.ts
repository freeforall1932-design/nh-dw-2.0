import { executeInTab } from "../preview/activeTabGallery";
import { isAllowedImageUrl as isAllowedCdnImageUrl } from "../sources/cdnConfig";

// Fetch one original image through an already-open nhentai tab so the request
// uses the tab's cookies and network stack. Isolated-world fetch is tried
// first (MV3 host_permissions, not subject to page CORS). MAIN world is the
// fallback when isolation cannot run. This is not a Cloudflare bypass: a
// challenge interstitial still cannot read image bytes.

export type TabImageResult = {
    ok: boolean;
    status: number;
    statusText: string;
    contentType: string | null;
    b64: string | null;
    error: string | null;
};

// Allowed-image validation is shared with URL generation through the CDN
// configuration (cdnConfig.ts): both accept exactly the same validated,
// nhentai-owned HTTPS image hosts — the hardcoded i/i1-i4 set plus any
// API-reported server the service worker activated. This function is injected
// into the user's tab, so it stays as strict as the old hardcoded regex:
// exact /galleries/<id>/<page>.<ext> path, no query string, no fragments.
export function isAllowedImageUrl(url: string): boolean {
    return isAllowedCdnImageUrl(url);
}

export function decodeTabImageBytes(b64: string): Uint8Array {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
        return new Uint8Array(Buffer.from(b64, "base64"));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Self-contained Promise chain: Chrome serializes this function into the tab.
// Do not use async/await (tsconfig target es6 rewrites that to helpers that
// do not exist in the page) and do not close over module state.
export function fetchImageInPage(imageUrl: string): Promise<TabImageResult> {
    return fetch(imageUrl, { credentials: "include", cache: "no-store" }).then(function(resp): Promise<TabImageResult> | TabImageResult {
        const contentType = resp.headers.get("content-type");
        if (!resp.ok) {
            return {
                ok: false,
                status: resp.status,
                statusText: resp.statusText,
                contentType: contentType,
                b64: null,
                error: null
            };
        }
        return resp.arrayBuffer().then(function(buf): TabImageResult {
            const bytes = new Uint8Array(buf);
            let binary = "";
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + chunkSize, bytes.length))));
            }
            return {
                ok: true,
                status: resp.status,
                statusText: resp.statusText,
                contentType: contentType,
                b64: btoa(binary),
                error: null
            };
        });
    }).catch(function(e): TabImageResult {
        return {
            ok: false,
            status: 0,
            statusText: "",
            contentType: null,
            b64: null,
            error: String(e && e.message ? e.message : e)
        };
    });
}

function usableTabResult(result: TabImageResult | null): boolean {
    return !!(result && (result.ok || result.status > 0));
}

export type TabUrlResult = {
    ok: boolean;
    status: number;
    statusText: string;
    contentType: string | null;
    text: string | null;
    error: string | null;
};

// Self-contained Promise chain, same rules as fetchImageInPage (serialized
// into the tab; no async/await, no module closures). Fetches a page's text
// through the tab's session — used for gallery API calls and listing pages,
// which are subject to the same Cloudflare 403s as extension-origin fetches.
export function fetchUrlInPage(url: string): Promise<TabUrlResult> {
    return fetch(url, { credentials: "include", cache: "no-store" }).then(function (resp): Promise<TabUrlResult> | TabUrlResult {
        const contentType = resp.headers.get("content-type");
        if (!resp.ok) {
            return {
                ok: false,
                status: resp.status,
                statusText: resp.statusText,
                contentType: contentType,
                text: null,
                error: null
            };
        }
        return resp.text().then(function (text): TabUrlResult {
            return {
                ok: true,
                status: resp.status,
                statusText: resp.statusText,
                contentType: contentType,
                text: text,
                error: null
            };
        });
    }).catch(function (e): TabUrlResult {
        return {
            ok: false,
            status: 0,
            statusText: "",
            contentType: null,
            text: null,
            error: String(e && e.message ? e.message : e)
        };
    });
}

// ---- service worker relay --------------------------------------------------
// Offscreen documents only expose chrome.runtime among extension APIs (Chrome
// docs: "The runtime API is the only extensions API supported by offscreen
// documents"). So when this module runs in the offscreen document,
// chrome.scripting is undefined and tab injections must be performed by the
// service worker, which has the full API surface. The relay uses the same
// message shape the service worker's listener understands.
function scriptingAvailable(): boolean {
    return typeof chrome !== "undefined"
        && !!(chrome as any).scripting
        && typeof (chrome as any).scripting.executeScript === "function";
}

function relayToServiceWorker<T>(message: any): Promise<T | null> {
    return new Promise((resolve) => {
        if (typeof chrome === "undefined" || typeof (chrome as any).runtime.sendMessage !== "function") {
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
        try {
            const result: any = (chrome as any).runtime.sendMessage(message, (response: any) => {
                // No response: the worker was unreachable or the port closed.
                if ((chrome as any).runtime.lastError || response === undefined) {
                    finish(null);
                    return;
                }
                finish(response);
            });
            if (result && typeof result.then === "function") {
                result.then((response: any) => finish(response === undefined ? null : response)).catch(() => finish(null));
            }
        } catch (_) {
            finish(null);
        }
    });
}

export async function fetchImageFromTab(tabId: number, url: string): Promise<TabImageResult | null> {
    if (!isAllowedImageUrl(url)) {
        return null;
    }
    if (scriptingAvailable()) {
        // Service worker / popup context: inject directly. Isolated world
        // first: MV3 host_permissions let content-script fetches skip page
        // CORS. MAIN world is the fallback when isolation cannot run.
        const isolated = await executeInTab(tabId, fetchImageInPage, [url], "ISOLATED");
        if (usableTabResult(isolated)) {
            return isolated;
        }
        const main = await executeInTab(tabId, fetchImageInPage, [url], "MAIN");
        if (usableTabResult(main)) {
            return main;
        }
        return isolated || main;
    }
    // Offscreen document context: ask the service worker to inject.
    const isolated = await relayToServiceWorker<TabImageResult>({
        from: "offscreen",
        action: "fetchInTab",
        tabId: tabId,
        url: url,
        world: "ISOLATED"
    });
    if (usableTabResult(isolated)) {
        return isolated;
    }
    const main = await relayToServiceWorker<TabImageResult>({
        from: "offscreen",
        action: "fetchInTab",
        tabId: tabId,
        url: url,
        world: "MAIN"
    });
    if (usableTabResult(main)) {
        return main;
    }
    return isolated || main;
}

// Fetch a page's text through an already-open tab (its cookies and session,
// including any completed Cloudflare clearance). Only nhentai.net URLs are
// allowed — this runs code in the user's tab. Returns null when the tab
// cannot be used (missing tabId, foreign URL, or the worker relay failed).
export async function fetchUrlFromTab(tabId: number, url: string): Promise<TabUrlResult | null> {
    if (typeof tabId !== "number" || !/^https:\/\/nhentai\.net(?:\/|$)/i.test(url)) {
        return null;
    }
    if (scriptingAvailable()) {
        return await executeInTab(tabId, fetchUrlInPage, [url], "MAIN");
    }
    return await relayToServiceWorker<TabUrlResult>({
        from: "offscreen",
        action: "fetchUrlInTab",
        tabId: tabId,
        url: url
    });
}
