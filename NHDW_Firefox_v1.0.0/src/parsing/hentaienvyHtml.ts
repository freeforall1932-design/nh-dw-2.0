// Pure HTML parsing for hentaienvy gallery + reader pages (multi-site v4).
//
// Chrome-free and fetch-free: runs in the service worker, the offscreen
// document, and the plain-Node VM test sandboxes.
//
// Source of truth for the shapes parsed here is the user-captured material:
// the gallery page's <h1 id="gallery-title">, #js-thumbs-grid (data-gallery-id,
// data-total-pages, thumbnail image src /033/<token>/1t.jpg), and the reader
// page's <script type="application/json" id="readerPagesJson"> and <img id="readerImg" src="...">.

function extensionToTypeCode(ext: string): string {
    const clean = String(ext || "").trim().toLowerCase().replace(/^\./, "");
    switch (clean) {
        case "jpg":
        case "jpeg":
            return "j";
        case "png":
            return "p";
        case "gif":
            return "g";
        case "webp":
            return "w";
        case "bmp":
            return "b";
        case "avif":
            return "a";
        default:
            return "w";
    }
}

const READER_IMG_RE = /<img\b[^>]*id=["'](?:readerImg|gimg)["'][^>]*>/i;
const SRC_ATTR_RE = /src=["']([^"']+)["']/i;

/**
 * Extract the full image URL from a HentaiEnvy reader page (<img id="readerImg" src=...>).
 */
export function extractHentaienvyReaderImage(html: string): string | null {
    if (!html || typeof html !== "string") return null;
    const img = READER_IMG_RE.exec(html);
    if (!img) return null;
    const src = SRC_ATTR_RE.exec(img[0]);
    return src ? src[1] : null;
}

/**
 * Convert a HentaiEnvy gallery or reader page HTML into the normalized gallery object.
 */
export function extractHentaienvyGallery(html: string): any | null {
    if (!html || typeof html !== "string") return null;

    // Gallery ID from data-gallery-id, input, or canonical link/URL
    const idMatch = /data-gallery-id=["']([0-9]+)["']/i.exec(html) ||
                    /<input[^>]+id=["']gallery_id["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                    /\/gallery\/([0-9]+)/i.exec(html) ||
                    /\/g\/([0-9]+)/i.exec(html) ||
                    /href=["'][^"']*\/g\/([0-9]+)/i.exec(html);

    // Media token from thumbnail URL or reader image URL (/033/<token>/)
    const tokenMatch = /\/033\/([a-z0-9]+)\//i.exec(html);
    const id = idMatch ? idMatch[1] : (tokenMatch ? tokenMatch[1] : null);
    if (!id) return null;
    const mediaId = tokenMatch ? tokenMatch[1] : id;

    // Title from <h1 id="gallery-title"> or <h1> or og:title
    const titleMatch = /<h1[^>]*id=["']gallery-title["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html) ||
                       /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ||
                       /data-title=["']([^"']+)["']/i.exec(html);
    const titleText = titleMatch ? titleMatch[1].trim() : "Gallery " + id;

    // Total pages from readerPagesJson, data-total-pages, or text
    let numPages = 0;
    let pages: any[] = [];

    const jsonScriptMatch = /<script[^>]+id=["']readerPagesJson["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (jsonScriptMatch) {
        try {
            const parsed = JSON.parse(jsonScriptMatch[1].trim());
            if (Array.isArray(parsed) && parsed.length > 0) {
                numPages = parsed.length;
                pages = parsed.map((item) => ({
                    t: extensionToTypeCode(item.ext),
                    w: Number(item.width) || 0,
                    h: Number(item.height) || 0
                }));
            }
        } catch (_) {}
    }

    if (pages.length === 0) {
        const totalPagesMatch = /data-total-pages=["']([0-9]+)["']/i.exec(html) ||
                                /<div[^>]*class=["'][^"']*hnv-gallery-pages[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([0-9]+)<\/span>/i.exec(html) ||
                                /Pages:\s*<span[^>]*>([0-9]+)<\/span>/i.exec(html);
        if (totalPagesMatch) {
            numPages = parseInt(totalPagesMatch[1], 10) || 0;
        }
        if (numPages > 0) {
            for (let i = 0; i < numPages; i++) {
                pages.push({ t: "w", w: 0, h: 0 });
            }
        }
    }

    if (pages.length === 0) {
        return null;
    }

    return {
        id: id,
        media_id: mediaId,
        title: {
            pretty: titleText,
            english: titleText,
            japanese: titleText
        },
        images: {
            pages: pages,
            cover: { t: "j", w: 0, h: 0 },
            thumbnail: { t: "j", w: 0, h: 0 }
        },
        scanlator: "",
        tags: [],
        num_pages: numPages
    };
}
