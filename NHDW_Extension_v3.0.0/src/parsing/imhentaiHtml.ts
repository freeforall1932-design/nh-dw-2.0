// Pure HTML parsing for imhentai gallery + reader pages (multi-site v4).
//
// Chrome-free and fetch-free: runs in the service worker, the offscreen
// document, and the plain-Node VM test sandboxes.
//
// Source of truth for the shapes parsed here is the user-captured material:
// the gallery page's hidden inputs (#gallery_id, #load_id, #load_pages, #gallery_title),
// the inline g_th JSON map (per-page type code and dimensions), and the reader
// page's <img id="gimg" src="https://m11.imhentai.xxx/033/<token>/<N>.<ext>">.

function extensionToTypeCode(path: string): string {
    const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(path || "").trim());
    if (!match) return "w";
    switch (match[1].toLowerCase()) {
        case "jpg":
        case "jpeg":
            return "j";
        case "png":
            return "p";
        case "gif":
            return "g";
        case "webp":
            return "w";
        default:
            return "w";
    }
}

const GIMG_RE = /<img\b[^>]*id=["']gimg["'][^>]*>/i;
const SRC_ATTR_RE = /src=["']([^"']+)["']/i;

/**
 * Extract the full image URL from an ImHentai reader page (<img id="gimg" src=...>).
 */
export function extractImhentaiReaderImage(html: string): string | null {
    if (!html || typeof html !== "string") return null;
    const img = GIMG_RE.exec(html);
    if (img === null) {
        return null;
    }
    const src = SRC_ATTR_RE.exec(img[0]);
    return src ? src[1] : null;
}

/**
 * Convert an ImHentai gallery page HTML into the normalized gallery object.
 */
export function extractImhentaiGallery(html: string): any | null {
    if (!html || typeof html !== "string") return null;

    const idMatch = /<input[^>]+id=["']gallery_id["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                    /\/gallery\/([0-9]+)/i.exec(html);
    const id = idMatch ? idMatch[1] : null;
    if (!id) return null;

    const tokenMatch = /<input[^>]+id=["']load_id["'][^>]+value=["']([a-z0-9]+)["']/i.exec(html) ||
                       /\/033\/([a-z0-9]+)\//i.exec(html);
    const mediaId = tokenMatch ? tokenMatch[1] : id;

    const titleMatch = /<input[^>]+id=["']gallery_title["'][^>]+value=["']([\s\S]*?)["']/i.exec(html) ||
                       /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const titleText = titleMatch ? titleMatch[1].trim() : "Gallery " + id;

    const pagesMatch = /<input[^>]+id=["']load_pages["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                       /Pages:\s*<span[^>]*>([0-9]+)<\/span>/i.exec(html) ||
                       /Pages:\s*([0-9]+)/i.exec(html);
    let numPages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

    let pages: any[] = [];
    const gthMatch = /var\s+g_th\s*=\s*\$\.parseJSON\(\s*['"]([\s\S]*?)['"]\s*\)/i.exec(html) ||
                     /var\s+g_th\s*=\s*JSON\.parse\(\s*['"]([\s\S]*?)['"]\s*\)/i.exec(html);
    if (gthMatch) {
        try {
            const rawJson = gthMatch[1].replace(/\\"/g, '"');
            const parsed = JSON.parse(rawJson);
            const keys = Object.keys(parsed).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
            if (keys.length > 0) {
                numPages = keys.length;
                pages = keys.map((k) => {
                    const [tCode, w, h] = String(parsed[k]).split(",");
                    return {
                        t: tCode || "w",
                        w: parseInt(w, 10) || 0,
                        h: parseInt(h, 10) || 0
                    };
                });
            }
        } catch (_) {}
    }

    if (pages.length === 0 && numPages > 0) {
        for (let i = 0; i < numPages; i++) {
            pages.push({ t: "w", w: 0, h: 0 });
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
