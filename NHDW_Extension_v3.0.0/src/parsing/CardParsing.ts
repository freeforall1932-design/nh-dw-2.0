// Pure HTML parsing of nhentai listing pages. Gallery cards are extracted
// anchor-by-anchor so a gallery ID can never be paired with the wrong caption,
// even when titles contain quotes, entities, extra markup, or newlines.
// Used by the service-worker / offscreen paths that fetch listing pages over
// the network (no DOM available there); the popup uses DOM extraction
// (js/getGalleries.js) which produces the same GalleryCard shape.

export interface GalleryCard { id: string; title: string; }

// One gallery cover link: captures the gallery id and the link's inner HTML.
// Allows a trailing path segment (e.g. /g/123/1/) and single or double quotes.
const GALLERY_ANCHOR_RE = /<a\b[^>]*href=["']\/g\/([0-9]+)\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/g;

// The caption div inside a gallery card.
const CAPTION_RE = /<div\b[^>]*class=["'][^"']*\bcaption\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;

// Extract the plain first line of a caption's HTML: the title. Removes injected
// checkboxes, splits on <br> (nhentai appends extra info after the title),
// strips remaining tags, and decodes the common HTML entities.
export function extractFirstLine(raw: string): string {
    let text = raw.replace(/<input\b[^>]*>/gi, "");
    text = text.split(/<br\s*\/?>/i)[0];
    text = text.replace(/<[^>]*>/g, "");
    text = text.replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(parseInt(n, 10)));
    return text.trim();
}

// Parse all gallery cards out of a fetched listing page's HTML.
// Duplicate ids (the same gallery can appear on several cards) are skipped.
export function parseGalleryCardsFromHtml(html: string): GalleryCard[] {
    const cards: GalleryCard[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    GALLERY_ANCHOR_RE.lastIndex = 0;
    while ((match = GALLERY_ANCHOR_RE.exec(html)) !== null) {
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const caption = CAPTION_RE.exec(match[2]);
        cards.push({ id, title: caption === null ? "" : extractFirstLine(caption[1]) });
    }
    return cards;
}
