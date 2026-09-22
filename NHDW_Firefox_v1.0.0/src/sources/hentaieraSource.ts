import { SiteAdapter } from "./GallerySource";
import { extractHentaieraGallery, extractHentaieraReaderImage } from "../parsing/hentaieraHtml";

// Hentaiera adapter (multi-site v4, item 53 — first non-nhentai site).
//
// Facts pinned from user-captured material on 2026-09-15 (see repo docs
// SITE_CAPTURE_AUDIT.md / WORKLIST.md item 53 / CAPTURE_GUIDE.md):
//
//   * Pages live on https://hentaiera.to/gallery/<id>/ and the reader page for
//     page N is /gallery/<id>/N/ — full document navigations, not an SPA.
//   * Images live on a DIFFERENT host, https://hentaiera.site, under
//     /galleries/<media_id>/<page>.<ext> (thumb is <page>t.<ext>). This path
//     shape already passes the nhentai ALLOWED_IMAGE_PATH regex in cdnConfig.
//   * media_id and num_pages come from the application/ld+json ImageGallery
//     block; the per-gallery extension is read from the thumbnail strip and is
//     NOT constant across galleries (jpg and webp both observed) — so it must
//     be read, never assumed.
//
// Chrome-free and fetch-free on purpose: this module is imported by the
// service worker, the offscreen document, and the plain-Node VM test
// sandboxes, none of which may touch chrome.* or the network at import time.

/** Host that serves the page images and thumbnails. */
export const HENTAIERA_PAGE_HOST = "https://hentaiera.to";
/** Host that serves the page images and thumbnails. */
export const HENTAIERA_IMAGE_HOST = "https://hentaiera.site";

export const hentaieraSource: SiteAdapter = {
    site: "hentaiera",
    defaultFormat: "zip",

    matchesUrl(url: string): boolean {
        return /^https:\/\/hentaiera\.to(?:[/?#]|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        const match = /\/gallery\/([0-9]+)(?:[/?#]|$)/i.exec(url);
        return match ? match[1] : null;
    },

    getGalleryUrl(id: string): string {
        return HENTAIERA_PAGE_HOST + "/gallery/" + encodeURIComponent(id) + "/";
    },

    getGalleryPageUrl(id: string, page: number = 1): string {
        return HENTAIERA_PAGE_HOST + "/gallery/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getReaderPageUrl(id: string, page: number): string {
        return HENTAIERA_PAGE_HOST + "/gallery/" + encodeURIComponent(id) + "/" + page + "/";
    },

    // Hentaiera has no JSON API; the gallery page's HTML (parsed by
    // HentaieraHtmlParsing / extractHentaieraGallery) is the only metadata
    // source. Callers that would otherwise hit getApiUrl must use the HTML
    // parsing path for this source.
    getApiUrl(id: string): string {
        return this.getGalleryUrl(id);
    },

    extractGallery(html: string): any | null {
        return extractHentaieraGallery(html);
    },

    extractReaderImage(html: string): string | null {
        return extractHentaieraReaderImage(html);
    },

    // Reconstruct a full-page image URL. `filename` is what the Downloader
    // builds from the per-page type code, e.g. "1.webp" — unpadded. The
    // extension inside it was already resolved per-gallery upstream.
    getImageUrls(mediaId: string, filename: string): string[] {
        return [HENTAIERA_IMAGE_HOST + "/galleries/" + encodeURIComponent(mediaId) + "/" + filename];
    },

    getImageHosts(): string[] {
        return ["hentaiera.site"];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/galleries\/[0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
