import { SiteAdapter } from "./GallerySource";
import { extractHentaienvyGallery, extractHentaienvyReaderImage } from "../parsing/hentaienvyHtml";

export const HENTAIENVY_PAGE_HOST = "https://hentaienvy.com";
export const HENTAIENVY_IMAGE_SERVERS: string[] = [
    "https://m11.hentaienvy.com",
    "https://m1.hentaienvy.com",
    "https://m2.hentaienvy.com",
    "https://m3.hentaienvy.com",
    "https://m4.hentaienvy.com",
    "https://m5.hentaienvy.com"
];

export const hentaienvySource: SiteAdapter = {
    site: "hentaienvy",
    defaultFormat: "zip",

    matchesUrl(url: string): boolean {
        return /^https:\/\/(?:[a-z0-9-]+\.)?hentaienvy\.com(?:[/?#]|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        const match = /\/(?:gallery|g)\/([0-9]+)(?:[/?#]|$)/i.exec(url);
        return match ? match[1] : null;
    },

    getGalleryUrl(id: string): string {
        return HENTAIENVY_PAGE_HOST + "/gallery/" + encodeURIComponent(id) + "/";
    },

    getGalleryPageUrl(id: string, page: number = 1): string {
        return HENTAIENVY_PAGE_HOST + "/g/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getReaderPageUrl(id: string, page: number): string {
        return HENTAIENVY_PAGE_HOST + "/g/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getApiUrl(id: string): string {
        return this.getGalleryUrl(id);
    },

    extractGallery(html: string): any | null {
        return extractHentaienvyGallery(html);
    },

    extractReaderImage(html: string): string | null {
        return extractHentaienvyReaderImage(html);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        return HENTAIENVY_IMAGE_SERVERS.map(
            (server) => server + "/033/" + encodeURIComponent(mediaId) + "/" + filename
        );
    },

    getImageHosts(): string[] {
        return [
            "m11.hentaienvy.com",
            "m1.hentaienvy.com",
            "m2.hentaienvy.com",
            "m3.hentaienvy.com",
            "m4.hentaienvy.com",
            "m5.hentaienvy.com"
        ];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/033\/[a-z0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
