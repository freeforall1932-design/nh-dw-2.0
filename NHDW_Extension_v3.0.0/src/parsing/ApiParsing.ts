import AParsing from "./AParsing";

// Returns true when a Response looks like a Cloudflare challenge/block page
// rather than the expected content. Checks status code and content-type header
// without consuming the body, so the caller can still parse it afterwards
// (the parse will fail with a clear error).
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
    GetUrl(id: string): string {
        return 'https://nhentai.net/api/gallery/' + id;
    }

    async GetJsonAsync(response: Response): Promise<any> {
        // If the response content-type is HTML, it is almost certainly a
        // Cloudflare challenge page or error page. Give a clear error before
        // JSON.parse fails with an indecipherable SyntaxError.
        const ct = (response.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("html")) {
            const status = response.status;
            const detail = status === 403 || status === 503
                ? "Cloudflare blocked the API request (HTTP " + status + "). Try opening the gallery in a tab, completing any challenge, and retrying."
                : "Unexpected response type \"text/html\" (HTTP " + status + ").";
            throw new Error(detail);
        }
        return response.json();
    }
}