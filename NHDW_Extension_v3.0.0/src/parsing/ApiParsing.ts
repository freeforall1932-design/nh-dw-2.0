import AParsing from "./AParsing";
import { GallerySource, clearnetSource } from "../sources/GallerySource";
import { coerceGallery } from "./GalleryEmbed";

const CLOUDFLARE_BODY_MARKERS = [
    "cf-challenge",
    "cf_chl_",
    "just a moment...",
    "checking your browser",
    "attention required",
    "enable javascript and cookies"
];

// Returns true when a response body contains a common Cloudflare challenge
// marker. This is separate from isCloudflareResponse because reading a body is
// asynchronous and consumes the Response stream.
export function isCloudflareBody(body: string): boolean {
    const normalized = body.toLowerCase();
    return CLOUDFLARE_BODY_MARKERS.some((marker) => normalized.includes(marker));
}

// Returns true when a Response looks like a Cloudflare challenge/block page
// rather than the expected content. This checks only metadata; callers that
// can consume the body should also use isCloudflareBody().
export function isCloudflareResponse(resp: Response): boolean {
    // 503 is Cloudflare's "just a moment" challenge; 403 is their block page.
    if (resp.status === 503 || resp.status === 403) {
        return true;
    }
    // Even a 200 can be a Cloudflare HTML page masquerading as success.
    const ct = resp.headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("json") && ct.toLowerCase().includes("html")) {
        return true;
    }
    return false;
}

export default class ApiParsing implements AParsing
{
    private readonly source: GallerySource;

    constructor(source: GallerySource = clearnetSource) {
        this.source = source;
    }

    GetUrl(id: string): string {
        return this.source.getApiUrl(id);
    }

    async GetJsonAsync(response: Response): Promise<any> {
        // Read the body once so a 200 response with a challenge page can be
        // identified even when it has an incorrect or missing content type.
        const body = await response.text();
        const status = response.status;
        if (status === 403 || status === 503 || isCloudflareBody(body)) {
            throw new Error("Cloudflare blocked the API request (HTTP " + status + "). Try opening the gallery in a tab, completing any challenge, and retrying.");
        }

        const ct = (response.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("html")) {
            throw new Error("Unexpected response type \"text/html\" (HTTP " + status + ").");
        }

        let parsed: any;
        try {
            parsed = JSON.parse(body);
        } catch (error) {
            throw new Error("Invalid JSON response from the API (HTTP " + status + ").");
        }

        // nhentai's API v2 uses a different gallery shape than the rest of the
        // extension consumes, so normalise it here.
        return coerceGallery(parsed) || parsed;
    }
}