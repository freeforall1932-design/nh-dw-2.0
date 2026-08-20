import { executeInTab } from "../preview/activeTabGallery";

// Fetch one original image through an already-open nhentai tab so the request
// uses the page's origin, referrer, and cookies. This is not a Cloudflare
// bypass: a challenge interstitial still cannot read image bytes, and CORS
// on the CDN can still fail (in which case the caller falls back to an
// extension-origin fetch).

export type TabImageResult = {
    ok: boolean;
    status: number;
    statusText: string;
    contentType: string | null;
    b64: string | null;
    error: string | null;
};

const IMAGE_HOST = /^https:\/\/i[1-4]?\.nhentai\.net\/galleries\/[0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;

export function isAllowedImageUrl(url: string): boolean {
    return IMAGE_HOST.test(url);
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
function fetchImageInPage(imageUrl: string): Promise<TabImageResult> {
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

export async function fetchImageFromTab(tabId: number, url: string): Promise<TabImageResult | null> {
    if (!isAllowedImageUrl(url)) {
        return null;
    }
    return executeInTab(tabId, fetchImageInPage, [url]);
}
