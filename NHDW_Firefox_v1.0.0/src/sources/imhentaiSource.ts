import { SiteAdapter } from "./GallerySource";
import { extractImhentaiGallery, extractImhentaiReaderImage } from "../parsing/imhentaiHtml";

export const IMHENTAI_PAGE_HOST = "https://imhentai.xxx";
export const IMHENTAI_IMAGE_SERVERS: string[] = [
    "https://m11.imhentai.xxx",
    "https://m1.imhentai.xxx",
    "https://m2.imhentai.xxx",
    "https://m3.imhentai.xxx",
    "https://m4.imhentai.xxx",
    "https://m5.imhentai.xxx"
];

export const imhentaiSource: SiteAdapter = {
    site: "imhentai",
    defaultFormat: "zip",

    matchesUrl(url: string): boolean {
        return /^https:\/\/(?:[a-z0-9-]+\.)?imhentai\.(?:xxx|org|net)(?:[/?#]|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        const match = /\/(?:gallery|view)\/([0-9]+)(?:[/?#]|$)/i.exec(url);
        return match ? match[1] : null;
    },

    getGalleryUrl(id: string): string {
        return IMHENTAI_PAGE_HOST + "/gallery/" + encodeURIComponent(id) + "/";
    },

    getGalleryPageUrl(id: string, page: number = 1): string {
        return IMHENTAI_PAGE_HOST + "/view/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getReaderPageUrl(id: string, page: number): string {
        return IMHENTAI_PAGE_HOST + "/view/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getApiUrl(id: string): string {
        return this.getGalleryUrl(id);
    },

    extractGallery(html: string): any | null {
        return extractImhentaiGallery(html);
    },

    extractReaderImage(html: string): string | null {
        return extractImhentaiReaderImage(html);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        return IMHENTAI_IMAGE_SERVERS.map(
            (server) => server + "/033/" + encodeURIComponent(mediaId) + "/" + filename
        );
    },

    getImageHosts(): string[] {
        return [
            "m11.imhentai.xxx",
            "m1.imhentai.xxx",
            "m2.imhentai.xxx",
            "m3.imhentai.xxx",
            "m4.imhentai.xxx",
            "m5.imhentai.xxx"
        ];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/[0-9]{3}\/[a-z0-9_-]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
