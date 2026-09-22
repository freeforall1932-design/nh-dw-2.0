// Pure HTML parsing for hentaifox gallery + reader pages (multi-site v4).
//
// Chrome-free and fetch-free: runs in the service worker, the offscreen
// document, and the plain-Node VM test sandboxes.
//
// Source of truth for the shapes parsed here is the user-captured material:
// the gallery page's <h1>, #load_id / #load_dir hidden inputs, inline g_th JSON map,
// and the reader page's <img id="gimg" src="https://i3.hentaifox.com/005/<media_id>/<page>.<ext>">.

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
            return "j";
    }
}

const GIMG_RE = /<img\b[^>]*id=["']gimg["'][^>]*>/i;
const SRC_OR_DATA_SRC_RE = /(?:data-src|src)=["']([^"']+)["']/i;

/**
 * Extract the full image URL from a HentaiFox reader page (<img id="gimg" src=...>).
 */
export function extractHentaifoxReaderImage(html: string): string | null {
    if (!html || typeof html !== "string") return null;
    const img = GIMG_RE.exec(html);
    if (!img) return null;
    const src = SRC_OR_DATA_SRC_RE.exec(img[0]);
    return src ? src[1] : null;
}

/**
 * Convert a HentaiFox gallery or reader page HTML into the normalized gallery object.
 */
export function extractHentaifoxGallery(html: string): any | null {
    if (!html || typeof html !== "string") return null;

    // Gallery ID from input or URL
    const idMatch = /<input[^>]+id=["']gallery_id["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                    /\/gallery\/([0-9]+)/i.exec(html) ||
                    /\/g\/([0-9]+)/i.exec(html);
    const id = idMatch ? idMatch[1] : null;
    if (!id) return null;

    // Media ID and Dir: e.g. /005/4190711/
    const dirMatch = /<input[^>]+id=["']load_dir["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                     /\/(00[0-9])\/([0-9]+)\//i.exec(html);
    const dir = dirMatch ? dirMatch[1] : "005";

    const loadIdMatch = /<input[^>]+id=["']load_id["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                        /\/(?:00[0-9])\/([0-9]+)\//i.exec(html);
    const rawMediaId = loadIdMatch ? loadIdMatch[1] : id;
    const mediaId = dir + "/" + rawMediaId;

    // Title from <h1> or .g_title or #gallery_title
    const titleMatch = /<input[^>]+id=["']gallery_title["'][^>]+value=["']([\s\S]*?)["']/i.exec(html) ||
                       /<h1[^>]*class=["'][^"']*g_title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html) ||
                       /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const titleText = titleMatch ? titleMatch[1].trim() : "Gallery " + id;

    // Pages from g_th JSON map or #load_pages or text
    let numPages = 0;
    let pages: any[] = [];

    const gthMatch = /var\s+g_th\s*=\s*\$\.parseJSON\(\s*['"]([\s\S]*?)['"]\s*\)/i.exec(html) ||
                     /var\s+g_th\s*=\s*JSON\.parse\(\s*['"]([\s\S]*?)['"]\s*\)/i.exec(html) ||
                     /var\s+g_th\s*=\s*(\{[\s\S]*?\});/i.exec(html);
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
                        t: tCode || "j",
                        w: parseInt(w, 10) || 0,
                        h: parseInt(h, 10) || 0
                    };
                });
            }
        } catch (_) {}
    }

    if (pages.length === 0) {
        const pagesMatch = /<input[^>]+id=["']load_pages["'][^>]+value=["']([0-9]+)["']/i.exec(html) ||
                           /Pages:\s*<span[^>]*>([0-9]+)<\/span>/i.exec(html) ||
                           /Pages:\s*([0-9]+)/i.exec(html);
        if (pagesMatch) {
            numPages = parseInt(pagesMatch[1], 10) || 0;
        }
        if (numPages > 0) {
            for (let i = 0; i < numPages; i++) {
                pages.push({ t: "j", w: 0, h: 0 });
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
