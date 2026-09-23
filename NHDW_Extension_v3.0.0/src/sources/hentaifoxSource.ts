import { SiteAdapter } from "./GallerySource";
import { extractHentaifoxGallery, extractHentaifoxReaderImage } from "../parsing/hentaifoxHtml";

export const HENTAIFOX_PAGE_HOST = "https://hentaifox.com";
export const HENTAIFOX_IMAGE_SERVERS: string[] = [
    "https://i.hentaifox.com",
    "https://i1.hentaifox.com",
    "https://i2.hentaifox.com",
    "https://i3.hentaifox.com",
    "https://i4.hentaifox.com"
];

export const hentaifoxSource: SiteAdapter = {
    site: "hentaifox",
    defaultFormat: "zip",

    matchesUrl(url: string): boolean {
        return /^https:\/\/(?:[a-z0-9-]+\.)?hentaifox\.com(?:[/?#]|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        const match = /\/(?:gallery|g)\/([0-9]+)(?:[/?#]|$)/i.exec(url);
        return match ? match[1] : null;
    },

    getGalleryUrl(id: string): string {
        return HENTAIFOX_PAGE_HOST + "/gallery/" + encodeURIComponent(id) + "/";
    },

    getGalleryPageUrl(id: string, page: number = 1): string {
        return HENTAIFOX_PAGE_HOST + "/g/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getReaderPageUrl(id: string, page: number): string {
        return HENTAIFOX_PAGE_HOST + "/g/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getApiUrl(id: string): string {
        return this.getGalleryUrl(id);
    },

    extractGallery(html: string): any | null {
        return extractHentaifoxGallery(html);
    },

    extractReaderImage(html: string): string | null {
        return extractHentaifoxReaderImage(html);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        const relPath = mediaId.includes("/")
            ? mediaId + "/" + filename
            : "005/" + encodeURIComponent(mediaId) + "/" + filename;
        return HENTAIFOX_IMAGE_SERVERS.map((server) => server + "/" + relPath);
    },

    getImageHosts(): string[] {
        return [
            "i.hentaifox.com",
            "i1.hentaifox.com",
            "i2.hentaifox.com",
            "i3.hentaifox.com",
            "i4.hentaifox.com"
        ];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/[0-9]{3}\/[0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
