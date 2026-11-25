import { SiteAdapter } from "./GallerySource";
import { extractTailspaceGallery, explainTailspaceFailure, tailspaceMetadataUrl, TAILSPACE_TOKEN } from "../parsing/tailspaceData";
import { TAILSPACE_SITE, TAILSPACE_ORIGIN, TAILSPACE_PICS_HOST, isTailspaceId, tailspaceIdFromUrl, tailspaceComicUrl } from "../utils/tailspaceIds";

// Tailspace (https://tailspace.com) as a built-in site, like nhentai/hitomi:
// open a comic, the panel shows Download; batch, bookmarks, history and the
// paste box all work with it. Comics are addressed by slug (tailspaceIds.ts),
// page lists come from the site's own React Router page data
// (parsing/tailspaceData.ts, facts credited there and in THIRD_PARTY_NOTICES).
//
// Image requests: the extension holds host permission for pics.tailspace.com,
// so its own fetch does not depend on the image server's CORS headers. Both
// reference projects send `Referer: https://tailspace.com/` for images, which
// is what the site's own reader sends; the service worker adds exactly that
// header to THIS extension's requests to pics.tailspace.com only (session rule,
// siteHeaderRules.ts). No Origin header is added (the references send none),
// and the user's own browsing is never touched.

const FILE_NAME = /^([A-Za-z0-9_-][A-Za-z0-9._-]{0,199}?)(\.jpeg)?\.(jpg|png|gif|webp|avif)$/;

export const tailspaceSource: SiteAdapter = {
    site: TAILSPACE_SITE,
    defaultFormat: "cbz",

    matchesUrl(url: string): boolean {
        return /^https:\/\/(?:www\.)?tailspace\.com(?:[/?#]|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        return tailspaceIdFromUrl(url);
    },

    getGalleryUrl(id: string): string {
        return tailspaceComicUrl(isTailspaceId(id) ? id : encodeURIComponent(String(id)));
    },

    getGalleryPageUrl(id: string): string {
        return this.getGalleryUrl(id);
    },

    getReaderPageUrl(id: string): string {
        return this.getGalleryUrl(id);
    },

    // The comic's loader data: complete, ordered page list in one request.
    getMetadataUrl(id: string): string {
        return tailspaceMetadataUrl(isTailspaceId(id) ? id : encodeURIComponent(String(id)));
    },

    // Reads the `.data` answer and, as a fallback, the comic page's HTML (the
    // same data is streamed into it).
    extractGallery(text: string): any | null {
        return extractTailspaceGallery(text);
    },

    explainExtractFailure(text: string): string {
        return explainTailspaceFailure(text);
    },

    // mediaId = numeric comic id; filename = "<token>[.jpeg].<ext>" as built
    // by the downloader from the gallery record's page hash and type.
    getImageUrls(mediaId: string, filename: string): string[] {
        if (!/^[1-9][0-9]{0,15}$/.test(String(mediaId || ""))) return [];
        const match = FILE_NAME.exec(String(filename || ""));
        if (!match || !TAILSPACE_TOKEN.test(match[1])) return [];
        const type = match[2] ? "jpeg" : match[3];
        return ["https://" + TAILSPACE_PICS_HOST + "/comics/" + mediaId + "/" + match[1] + "." + type];
    },

    getImageHosts(): string[] {
        return [TAILSPACE_PICS_HOST];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/comics\/[1-9][0-9]{0,15}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp|avif)$/;
    },

    // Like hitomi: in an open tailspace.com tab the page is read through the
    // tab first (the browser sends the site's own referrer); anywhere else, or
    // when the tab read is refused, the extension's own fetch runs with the
    // header rule below. Raw-image mode goes through the same checked fetch.
    fetchImagesThroughTab(): boolean {
        return true;
    },

    getTabSiteHost(): string {
        return "tailspace.com";
    },

    getImageRequestContext(): { domains: string[]; referer: string; origin: string } {
        return { domains: [TAILSPACE_PICS_HOST], referer: TAILSPACE_ORIGIN + "/", origin: "" };
    },

    needsTabFetch(): boolean {
        return false;
    }
};
