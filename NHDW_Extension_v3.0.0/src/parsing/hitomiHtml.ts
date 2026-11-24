// Pure HTML and JS parsing for hitomi.la galleries (multi-site v4).
//
// Chrome-free and fetch-free: runs in the service worker, the offscreen
// document, and the plain-Node VM test sandboxes.
//
// Source of truth for Hitomi gallery data is the gallery JS
// (ltn.gold-usergeneratedcontent.net/galleries/{id}.js: var galleryinfo = {...}).

export function extractHitomiReaderImage(html: string): string | null {
    if (!html || typeof html !== "string") return null;
    const match = /<img[^>]+(?:id=["']comicImages["']|class=["'][^"']*comic[^"']*["'])[^>]+src=["']([^"']+)["']/i.exec(html) ||
                  /<img[^>]+src=["']([^"']+\.gold-usergeneratedcontent\.net\/[^"']+)["']/i.exec(html);
    return match ? match[1] : null;
}

export function extractHitomiGallery(htmlOrJs: string): any | null {
    if (!htmlOrJs || typeof htmlOrJs !== "string") return null;

    let rawInfo: any = null;

    // galleries/{id}.js is exactly `var galleryinfo = {JSON}` — parse it whole,
    // so braces inside titles cannot confuse the brace scan below.
    const assignment = /^\s*var\s+galleryinfo\s*=\s*([\s\S]*?);?\s*$/.exec(htmlOrJs);
    if (assignment) {
        try { rawInfo = JSON.parse(assignment[1]); } catch (_) { rawInfo = null; }
    }

    // Find the first { and parse balanced braces
    const firstBrace = rawInfo ? -1 : htmlOrJs.indexOf("{");
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

    // No page list: the rendered gallery page does not carry one (it loads
    // galleries/{id}.js as an external script). An earlier fallback built a
    // record from the page HTML anyway, which picked up an unrelated number as
    // the id and reported 0 pages; returning null lets the caller read the
    // real metadata (hitomiSource.getMetadataUrl) instead.
    return null;
}
