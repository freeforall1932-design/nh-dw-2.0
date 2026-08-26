// One-shot server archive downloads ("archive mode").
//
// nhentai's API v2 provides a dedicated endpoint for full-gallery archives:
//   POST https://nhentai.net/api/v2/galleries/<id>/download?format=zip|cbz
// It requires an API key (or user token) and returns DownloadResponse:
//   { "url": "https://...", "expires_at": <unix timestamp> }
// The url is short-lived; fetch it before expires_at.
//
// Archive mode is OPTIONAL and always opportunistic: it only runs when the
// user stored an API key AND enabled the option, only for zip/cbz output,
// and any failure (missing endpoint, 401, 503 feature flag off, 429
// exhaustion, network error, malformed response) silently falls back to the
// page-by-page pipeline. Nothing here may ever hard-fail a download that the
// page-by-page route could still complete.

import { fetchNhentaiApi, descriptiveUserAgentHeaders } from "../utils/apiAuth";

export interface ArchiveUrlResult {
    url: string;
    expiresAt: number;
}

export interface ArchiveRequestDeps {
    fetchImpl?: (url: string, init?: any) => Promise<Response>;
    sleepImpl?: (ms: number) => Promise<void>;
    signal?: any;
    maxRetries?: number;
}

export function getArchiveRequestUrl(galleryId: string | number, format: "zip" | "cbz"): string {
    return "https://nhentai.net/api/v2/galleries/" + encodeURIComponent(String(galleryId)) + "/download?format=" + format;
}

// Ask for a short-lived archive URL. Returns null whenever the endpoint is
// unusable for this caller — the caller must then fall back to page-by-page.
export async function requestArchiveDownloadUrl(
    galleryId: string | number,
    format: "zip" | "cbz",
    apiKey: string | null,
    deps: ArchiveRequestDeps = {}
): Promise<ArchiveUrlResult | null> {
    if (apiKey === null || String(apiKey).trim().length === 0) {
        return null; // The endpoint requires auth; keyless mode cannot use it.
    }

    let resp: Response;
    try {
        resp = await fetchNhentaiApi(
            getArchiveRequestUrl(galleryId, format),
            { method: "POST", cache: "no-store", signal: deps.signal },
            apiKey,
            deps
        );
    } catch (_) {
        return null;
    }
    if (!resp.ok) {
        return null; // 401 bad key, 503 feature flag off, lingering 429, ...
    }

    let body: any;
    try {
        body = await resp.json();
    } catch (_) {
        return null;
    }

    const url = body && typeof body.url === "string" && /^https?:\/\//i.test(body.url) ? body.url : null;
    if (url === null) {
        return null;
    }
    const expiresAt = typeof body.expires_at === "number" && isFinite(body.expires_at)
        ? body.expires_at
        : Number.MAX_SAFE_INTEGER;
    return { url: url, expiresAt: expiresAt };
}

// Fetch the archive bytes from the short-lived URL. The API key is NOT
// attached here: the signed URL is the credential, and it may point at a
// non-nhentai host that must never receive it.
export async function fetchArchiveBytes(
    url: string,
    deps: { fetchImpl?: (url: string, init?: any) => Promise<Response>; signal?: any } = {}
): Promise<Blob> {
    const fetchImpl = deps.fetchImpl || fetch;
    const headers: Record<string, string> = Object.assign({}, descriptiveUserAgentHeaders());
    const resp = await fetchImpl(url, { cache: "no-store", signal: deps.signal, headers: headers });
    if (!resp.ok) {
        throw new Error("Failed to fetch server archive (HTTP " + resp.status + ").");
    }
    return await resp.blob();
}
