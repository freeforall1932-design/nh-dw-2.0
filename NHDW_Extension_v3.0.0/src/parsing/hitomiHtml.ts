// Pure HTML and JS parsing for hitomi.la galleries (multi-site v4).
//
// Chrome-free and fetch-free: runs in the service worker, the offscreen
// document, and the plain-Node VM test sandboxes.
//
// Source of truth for Hitomi gallery data is either the rendered page DOM,
// the embedded gallery JS (var galleryinfo = {...}), or the gallery HTML.

export function extractHitomiReaderImage(html: string): string | null {
    if (!html || typeof html !== "string") return null;
    const match = /<img[^>]+(?:id=["']comicImages["']|class=["'][^"']*comic[^"']*["'])[^>]+src=["']([^"']+)["']/i.exec(html) ||
                  /<img[^>]+src=["']([^"']+\.gold-usergeneratedcontent\.net\/[^"']+)["']/i.exec(html);
    return match ? match[1] : null;
}

export function extractHitomiGallery(htmlOrJs: string): any | null {
    if (!htmlOrJs || typeof htmlOrJs !== "string") return null;

    let rawInfo: any = null;

    // Find the first { and parse balanced braces
    const firstBrace = htmlOrJs.indexOf("{");
    if (firstBrace !== -1) {
        let depth = 0;
        let endBrace = -1;
        for (let i = firstBrace; i < htmlOrJs.length; i++) {
            if (htmlOrJs[i] === "{") depth++;
            else if (htmlOrJs[i] === "}") {
                depth--;
                if (depth === 0) {
                    endBrace = i;
                    break;
                }
            }
        }
        if (endBrace !== -1) {
            try {
                rawInfo = JSON.parse(htmlOrJs.slice(firstBrace, endBrace + 1));
            } catch (_) {}
        }
    }

    if (rawInfo && Array.isArray(rawInfo.files) && rawInfo.files.length > 0) {
        const id = String(rawInfo.id || "");
        const title = String(rawInfo.title || "Gallery " + id).trim();
        const pages = rawInfo.files.map((f: any) => {
            const extCode = f.hasavif ? "a" : (f.haswebp || f.haswebp === undefined ? "w" : "j");
            return {
                t: extCode,
                w: Number(f.width) || 0,
                h: Number(f.height) || 0,
                hash: f.hash || "",
                name: f.name || ""
            };
        });

        return {
            id: id,
            media_id: id,
            site: "hitomi",
            title: {
                pretty: title,
                english: title,
                japanese: String(rawInfo.japanese_title || title)
            },
            images: {
                pages: pages,
                cover: { t: "j", w: 0, h: 0 },
                thumbnail: { t: "j", w: 0, h: 0 }
            },
            scanlator: "",
            tags: Array.isArray(rawInfo.tags) ? rawInfo.tags : [],
            num_pages: pages.length
        };
    }

    // Fallback: extract basic metadata from HTML if JS is unavailable
    const idMatch = /\/(?:galleries|doujinshi|manga|gamecg|cg|anime|reader)\/(?:.*-)?([0-9]+)(?:\.html)?(?:[#/?]|$)/i.exec(htmlOrJs);
    const id = idMatch ? idMatch[1] : null;
    if (!id) return null;

    const titleMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(htmlOrJs) ||
                       /<title>([\s\S]*?)(?:\||\-)?\s*Hitomi\.la<\/title>/i.exec(htmlOrJs);
    const title = titleMatch ? titleMatch[1].trim() : "Gallery " + id;

    return {
        id: id,
        media_id: id,
        site: "hitomi",
        title: {
            pretty: title,
            english: title,
            japanese: title
        },
        images: {
            pages: [],
            cover: { t: "j", w: 0, h: 0 },
            thumbnail: { t: "j", w: 0, h: 0 }
        },
        scanlator: "",
        tags: [],
        num_pages: 0
    };
}
