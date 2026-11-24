import { SiteAdapter } from "./GallerySource";
import { extractHitomiGallery, extractHitomiReaderImage } from "../parsing/hitomiHtml";
import { buildHitomiImageUrls, ensureHitomiGg, getHitomiGg, GgFetch, HitomiImageFile, HITOMI_CONTENT_DOMAIN } from "./hitomiResolver";

export const HITOMI_PAGE_HOST = "https://hitomi.la";
export const HITOMI_LTN_HOST = "https://ltn." + HITOMI_CONTENT_DOMAIN;

/** Full-size page servers: a1/a2 (avif) and w1/w2 (webp), plus one spare each. */
const HITOMI_PAGE_HOSTS = ["a1", "a2", "a3", "w1", "w2", "w3"].map((sub) => sub + "." + HITOMI_CONTENT_DOMAIN);

export const hitomiSource: SiteAdapter = {
    site: "hitomi",
    defaultFormat: "zip",

    matchesUrl(url: string): boolean {
        return /^https:\/\/(?:[a-z0-9-]+\.)?hitomi\.la(?:[/?#]|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        const match = /\/(?:galleries|doujinshi|manga|gamecg|cg|anime|reader)\/(?:.*-)?([0-9]+)(?:\.html)?(?:[#/?]|$)/i.exec(url);
        return match ? match[1] : null;
    },

    getGalleryUrl(id: string): string {
        return HITOMI_PAGE_HOST + "/galleries/" + encodeURIComponent(id) + ".html";
    },

    getGalleryPageUrl(id: string, page: number = 1): string {
        return HITOMI_PAGE_HOST + "/reader/" + encodeURIComponent(id) + ".html#" + page;
    },

    getReaderPageUrl(id: string, page: number): string {
        return HITOMI_PAGE_HOST + "/reader/" + encodeURIComponent(id) + ".html#" + page;
    },

    getApiUrl(id: string): string {
        return HITOMI_LTN_HOST + "/galleries/" + encodeURIComponent(id) + ".js";
    },

    // The rendered gallery page does not contain the page list (it is loaded
    // from galleries/{id}.js as an external script), so metadata is read from
    // that file directly. Served with CORS "*", covered by host permissions.
    getMetadataUrl(id: string): string {
        return HITOMI_LTN_HOST + "/galleries/" + encodeURIComponent(id) + ".js";
    },

    extractGallery(html: string): any | null {
        return extractHitomiGallery(html);
    },

    extractReaderImage(html: string): string | null {
        return extractHitomiReaderImage(html);
    },

    // Load (or refresh) gg.js before page URLs are built; cached ~10 minutes.
    async prepareDownload(fetchImpl: GgFetch, signal?: AbortSignal | null): Promise<void> {
        await ensureHitomiGg(fetchImpl, Date.now(), signal);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        // filename is "<64-hex hash>.<avif|webp>" (see Downloader filenameParsing).
        const match = /^([0-9a-f]{64})\.(avif|webp)$/i.exec(String(filename || ""));
        if (!match) return [];
        const file: HitomiImageFile = {
            hash: match[1],
            hasavif: match[2].toLowerCase() === "avif" ? 1 : 0,
            haswebp: 1,
            name: filename
        };
        return buildHitomiImageUrls(file, getHitomiGg(), true);
    },

    getImageHosts(): string[] {
        return HITOMI_PAGE_HOSTS.slice();
    },

    getAllowedPathRegex(): RegExp {
        // /{rotating prefix}/{gg.s(hash)}/{hash}.{avif|webp}
        return /^\/[0-9]{1,16}\/[0-9]{1,4}\/[0-9a-f]{64}\.(?:avif|webp)$/;
    },

    // Fetch pages through the open Hitomi tab first, like nhentai: the
    // browser then sends the real hitomi.la referrer by itself.
    fetchImagesThroughTab(): boolean {
        return true;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
