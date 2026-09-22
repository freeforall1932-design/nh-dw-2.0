import { SiteAdapter } from "./GallerySource";
import { extractHitomiGallery, extractHitomiReaderImage } from "../parsing/hitomiHtml";
import { buildHitomiImageUrls, fullPathFromHash, HitomiImageFile } from "./hitomiResolver";

export const HITOMI_PAGE_HOST = "https://hitomi.la";
export const HITOMI_LTN_HOST = "https://ltn.gold-usergeneratedcontent.net";

export const hitomiSource: SiteAdapter = {
    site: "hitomi",
    defaultFormat: "raw",

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

    extractGallery(html: string): any | null {
        return extractHitomiGallery(html);
    },

    extractReaderImage(html: string): string | null {
        return extractHitomiReaderImage(html);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        // Strip extension if filename has one: e.g. "abc...e12.webp" -> "abc...e12"
        const cleanName = filename.replace(/\.(?:webp|avif|jpg|jpeg|png|gif)$/i, "");
        const hash = cleanName.length >= 32 ? cleanName : (mediaId.length >= 32 ? mediaId : cleanName);
        const file: HitomiImageFile = {
            hash: hash,
            haswebp: 1,
            hasavif: filename.endsWith(".avif") ? 1 : 0,
            name: filename
        };
        return buildHitomiImageUrls(file, filename.endsWith(".avif"));
    },

    getImageHosts(): string[] {
        return [
            "gold-usergeneratedcontent.net",
            "a.gold-usergeneratedcontent.net",
            "b.gold-usergeneratedcontent.net",
            "aa.gold-usergeneratedcontent.net",
            "ba.gold-usergeneratedcontent.net",
            "bb.gold-usergeneratedcontent.net",
            "ltn.gold-usergeneratedcontent.net",
            "hitomi.la",
            "ltn.hitomi.la"
        ];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/(?:webp|avif|images|galleries)\/[0-9a-z\/_.-]+\.(jpg|jpeg|png|gif|webp|avif|js)$/i;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
