// Shared parser for the gallery JSON nhentai embeds in the page.
// The popup and resolver must read this from the already-rendered tab instead
// of relying on the JSON API, which Cloudflare often 403s for extension
// origins.
//
// Two page generations are supported:
//   * Legacy: an inline `window._gallery = JSON.parse("...")` script.
//   * Current (SvelteKit): `<script type="application/json"
//     data-sveltekit-fetched data-url="/api/v2/galleries/<id>...">` whose
//     payload has a `body` string holding the API v2 JSON.
//
// Everything downstream (Downloader, popup) consumes the legacy shape, so v2
// payloads are normalized into that shape here rather than changing every
// consumer.

/** Legacy-shaped gallery: { media_id, title, images: { pages: [{t,w,h}] } }. */
export function looksLikeGallery(value: any): boolean {
    return value !== null
        && typeof value === "object"
        && value.title !== undefined
        && value.images !== undefined
        && value.images !== null
        && Array.isArray(value.images.pages)
        && value.media_id !== undefined && value.media_id !== null;
}

/** True when the value looks like an API v2 gallery record. */
function looksLikeGalleryV2(value: any): boolean {
    return value !== null
        && typeof value === "object"
        && value.media_id !== undefined && value.media_id !== null
        && value.title !== undefined && value.title !== null
        && Array.isArray(value.pages)
        && value.pages.length > 0;
}

// Map an image file extension to the single-letter type code the legacy
// schema (and Downloader) uses.
function extensionToTypeCode(path: string): string | null {
    const match = /\.([a-z0-9]+)$/i.exec(String(path || "").trim());
    if (!match) {
        return null;
    }
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
            return null;
    }
}

function toLegacyImage(entry: any): any {
    if (entry === null || typeof entry !== "object") {
        return { t: "0", w: 0, h: 0 };
    }
    // v2 exposes a full CDN-relative path such as "galleries/4128713/1.webp".
    const code = extensionToTypeCode(entry.path || entry.url || "");
    return {
        // "0" marks an unusable page, which Downloader already skips.
        t: code || "0",
        w: typeof entry.width === "number" ? entry.width : 0,
        h: typeof entry.height === "number" ? entry.height : 0
    };
}

/**
 * Convert an API v2 gallery record into the legacy shape the rest of the
 * extension expects. Returns null when the input is not a v2 gallery.
 */
export function normalizeGalleryV2(value: any): any | null {
    if (!looksLikeGalleryV2(value)) {
        return null;
    }

    const pages = value.pages.map(toLegacyImage);
    // A gallery whose pages all failed to map is not usable metadata.
    if (!pages.some((page: any) => page.t !== "0")) {
        return null;
    }

    const title = typeof value.title === "string"
        ? { english: value.title, japanese: "", pretty: value.title }
        : {
            english: value.title.english || value.title.pretty || "",
            japanese: value.title.japanese || "",
            pretty: value.title.pretty || value.title.english || ""
        };

    return {
        id: value.id,
        media_id: value.media_id,
        title: title,
        images: {
            pages: pages,
            cover: value.cover ? toLegacyImage(value.cover) : undefined,
            thumbnail: value.thumbnail ? toLegacyImage(value.thumbnail) : undefined
        },
        scanlator: value.scanlator || "",
        upload_date: value.upload_date,
        tags: Array.isArray(value.tags) ? value.tags : [],
        num_pages: typeof value.num_pages === "number" ? value.num_pages : pages.length,
        num_favorites: value.num_favorites
    };
}

/**
 * Accept either schema and always return the legacy shape (or null).
 */
export function coerceGallery(value: any): any | null {
    if (looksLikeGallery(value)) {
        return value;
    }
    return normalizeGalleryV2(value);
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

/**
 * Pull gallery metadata out of a SvelteKit `data-sveltekit-fetched` payload.
 * These carry the API v2 response verbatim in a `body` string.
 */
export function extractGalleryFromSvelteKit(html: string): any | null {
    if (!html) {
        return null;
    }

    const scriptPattern = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptPattern.exec(html)) !== null) {
        const tag = match[0];
        const contents = match[1];
        // Only consider gallery endpoints; the page also embeds ad zones and
        // listing responses that can never yield single-gallery metadata.
        if (tag.indexOf("/api/v2/galleries") === -1) {
            continue;
        }

        let envelope: any;
        try {
            envelope = JSON.parse(contents);
        } catch (_) {
            continue;
        }

        // The useful payload is a JSON string under `body`, but tolerate a
        // pre-parsed object too.
        let payload: any = envelope && envelope.body !== undefined ? envelope.body : envelope;
        if (typeof payload === "string") {
            try {
                payload = JSON.parse(payload);
            } catch (_) {
                continue;
            }
        }

        const normalized = coerceGallery(payload);
        if (normalized) {
            return normalized;
        }
    }

    return null;
}

export function extractGalleryFromHtml(html: string): any | null {
    if (!html) {
        return null;
    }

    // Current SvelteKit site.
    const fromSvelteKit = extractGalleryFromSvelteKit(html);
    if (fromSvelteKit) {
        return fromSvelteKit;
    }

    // Legacy embed: window._gallery = JSON.parse("{\u0022id\u0022: ...}");
    const jsonParseDouble = /window\._gallery\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\s*\)\s*;?/.exec(html);
    if (jsonParseDouble) {
        const parsed = coerceGallery(parseEscapedGalleryJson(jsonParseDouble[1]));
        if (parsed) {
            return parsed;
        }
    }

    const jsonParseSingle = /window\._gallery\s*=\s*JSON\.parse\('((?:\\.|[^'\\])*)'\s*\)\s*;?/.exec(html);
    if (jsonParseSingle) {
        const parsed = coerceGallery(parseEscapedGalleryJson(jsonParseSingle[1]));
        if (parsed) {
            return parsed;
        }
    }

    return null;
}
