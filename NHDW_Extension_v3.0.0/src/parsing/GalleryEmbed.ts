// Shared parser for the gallery JSON nhentai embeds in the page.
// The popup and resolver must read this from the already-rendered tab instead
// of relying on /api/gallery/<id>, which Cloudflare often 403s for extension
// origins.

export function looksLikeGallery(value: any): boolean {
    return value !== null
        && typeof value === "object"
        && value.title !== undefined
        && value.images !== undefined
        && value.images !== null
        && Array.isArray(value.images.pages)
        && value.media_id !== undefined && value.media_id !== null;
}

function unescapeGalleryJson(escaped: string): string {
    return escaped.replace(/\\u[\dA-F]{4}/gi, function (match) {
        return String.fromCharCode(parseInt(match.replace(/\\u/g, ""), 16));
    });
}

function parseEscapedGalleryJson(escaped: string): any | null {
    try {
        return JSON.parse(unescapeGalleryJson(escaped));
    } catch (_) {
        try {
            return JSON.parse(escaped);
        } catch (__) {
            return null;
        }
    }
}

export function extractGalleryFromHtml(html: string): any | null {
    if (!html) {
        return null;
    }

    // Real nhentai embed: window._gallery = JSON.parse("{\u0022id\u0022: ...}");
    const jsonParseDouble = /window\._gallery\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\s*\)\s*;?/.exec(html);
    if (jsonParseDouble) {
        const parsed = parseEscapedGalleryJson(jsonParseDouble[1]);
        if (looksLikeGallery(parsed)) {
            return parsed;
        }
    }

    const jsonParseSingle = /window\._gallery\s*=\s*JSON\.parse\('((?:\\.|[^'\\])*)'\s*\)\s*;?/.exec(html);
    if (jsonParseSingle) {
        const parsed = parseEscapedGalleryJson(jsonParseSingle[1]);
        if (looksLikeGallery(parsed)) {
            return parsed;
        }
    }

    return null;
}
