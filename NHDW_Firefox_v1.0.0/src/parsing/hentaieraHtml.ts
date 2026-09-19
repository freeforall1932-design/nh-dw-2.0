// Pure HTML parsing for hentaiera gallery + reader pages (multi-site v4, item 53).
//
// Chrome-free and fetch-free: runs in the service worker, the offscreen
// document, and the plain-Node VM test sandboxes.
//
// Source of truth for the shapes parsed here is the user-captured material
// (2026-09-15): the gallery page's application/ld+json ImageGallery block, the
// thumbnail strip (<img data-src="…/galleries/<media>/<N>t.<ext>">), and the
// reader page's single <img id="reader_img" src="…/galleries/<media>/<N>.<ext>">.

// Map a file extension to the single-letter type code the legacy gallery shape
// (and Downloader) consumes. Mirrors the nhentai codes; unknown -> null.
function extensionToTypeCode(path: string): string | null {
    const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(path || "").trim());
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

const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const IMAGE_GALLERY_MEDIA_RE = /galleries\/([0-9]+)\/cover\./i;
const THUMB_EXT_RE = (mediaId: string) =>
    new RegExp("galleries/" + mediaId + "/[0-9]+t\\.([a-z0-9]+)", "i");
const COVER_EXT_RE = (mediaId: string) =>
    new RegExp("galleries/" + mediaId + "/cover\\.([a-z0-9]+)", "i");
const READER_IMG_RE = /<img\b[^>]*id=["']reader_img["'][^>]*>/i;
const SRC_ATTR_RE = /src=["']([^"']+)["']/i;

function parseLdImageGallery(html: string): any | null {
    LD_JSON_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LD_JSON_RE.exec(html)) !== null) {
        let value: any;
        try {
            value = JSON.parse(match[1]);
        } catch (_) {
            continue;
        }
        if (value && typeof value === "object" && value["@type"] === "ImageGallery") {
            return value;
        }
    }
    return null;
}

/**
 * The reader page's full-page image URL, read off `<img id="reader_img" src=…>`.
 * Returns null when the page is not a hentaiera reader page. This is the
 * per-page ground truth — it carries the exact extension for that page.
 */
export function extractHentaieraReaderImage(html: string): string | null {
    const img = READER_IMG_RE.exec(html);
    if (img === null) {
        return null;
    }
    const src = SRC_ATTR_RE.exec(img[0]);
    return src ? src[1] : null;
}

/**
 * Convert a hentaiera gallery page into the legacy gallery shape the rest of
 * the extension consumes. Returns null when the page is not a hentaiera
 * gallery page.
 *
 * The per-gallery extension is read from the thumbnail strip (or the cover),
 * never assumed — different galleries legitimately use jpg and webp.
 */
export function extractHentaieraGallery(html: string): any | null {
    const ld = parseLdImageGallery(html);
    if (ld === null) {
        return null;
    }

    const mediaMatch = IMAGE_GALLERY_MEDIA_RE.exec(String(ld.image || ld.thumbnailUrl || ""));
    if (mediaMatch === null) {
        return null;
    }
    const mediaId = mediaMatch[1];

    const numPages = typeof ld.numberOfItems === "number"
        ? ld.numberOfItems
        : 0;
    if (numPages <= 0) {
        return null;
    }

    const extMatch = THUMB_EXT_RE(mediaId).exec(html) || COVER_EXT_RE(mediaId).exec(html);
    const code = extMatch ? extensionToTypeCode("." + extMatch[1]) : null;
    if (code === null) {
        return null;
    }

    const pages: any[] = [];
    for (let i = 0; i < numPages; i++) {
        pages.push({ t: code, w: 0, h: 0 });
    }

    const name = typeof ld.name === "string" ? ld.name : "";

    return {
        id: undefined, // filled by the caller from the URL via getGalleryId
        media_id: mediaId,
        title: { english: name, japanese: "", pretty: name },
        images: { pages: pages },
        scanlator: "",
        tags: [],
        num_pages: numPages
    };
}
