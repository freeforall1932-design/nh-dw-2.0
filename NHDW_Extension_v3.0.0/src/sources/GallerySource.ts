import { buildImageUrl, getImageServers } from "./cdnConfig";

export interface SiteAdapter {
    readonly site: string;
    readonly defaultFormat?: "zip" | "cbz" | "pdf" | "raw";
    matchesUrl(url: string): boolean;
    getGalleryId(url: string): string | null;
    getGalleryUrl(id: string): string;
    getGalleryPageUrl?(id: string, page?: number): string;
    getReaderPageUrl?(id: string, page: number): string;
    getApiUrl?(id: string): string;
    extractGallery?(htmlOrJson: string, url?: string): any | null;
    extractReaderImage?(html: string): string | null;
    getImageUrls(mediaId: string, filename: string, extra?: any): string[];
    getImageHosts?(): string[];
    getAllowedPathRegex?(): RegExp;
    needsTabFetch?(): boolean;
}

export type GallerySource = SiteAdapter;

/** The currently supported clearnet NHentai source. */
export const clearnetSource: SiteAdapter = {
    site: "nhentai",
    defaultFormat: "zip",

    matchesUrl(url: string): boolean {
        return /^https:\/\/nhentai\.net(?:\/|$)/i.test(url);
    },

    getGalleryId(url: string): string | null {
        const match = /^https:\/\/nhentai\.net\/g\/([0-9]+)(?:\/|$)/i.exec(url);
        return match ? match[1] : null;
    },

    getGalleryUrl(id: string): string {
        return "https://nhentai.net/g/" + encodeURIComponent(id) + "/";
    },

    getGalleryPageUrl(id: string, page: number = 1): string {
        return "https://nhentai.net/g/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getReaderPageUrl(id: string, page: number): string {
        return "https://nhentai.net/g/" + encodeURIComponent(id) + "/" + page + "/";
    },

    getApiUrl(id: string): string {
        return "https://nhentai.net/api/v2/galleries/" + encodeURIComponent(id);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        // Server order comes from the shared CDN configuration (see
        // cdnConfig.ts): the validated /api/v2/cdn list first when the worker
        // resolved one, then the cached fallback mirrors. Hosts are HTTPS
        // nhentai-owned origins only — never hardcoded i.nhentai.net alone.
        return getImageServers().map((server) => buildImageUrl(server, mediaId, filename));
    },

    getImageHosts(): string[] {
        return ["i.nhentai.net", "i1.nhentai.net", "i2.nhentai.net", "i3.nhentai.net", "i4.nhentai.net"];
    },

    getAllowedPathRegex(): RegExp {
        return /^\/galleries\/[0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;
    },

    needsTabFetch(): boolean {
        return true;
    }
};
