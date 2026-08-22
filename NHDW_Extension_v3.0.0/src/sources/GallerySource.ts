import { buildImageUrl, getImageServers } from "./cdnConfig";

export interface GallerySource {
    matchesUrl(url: string): boolean;
    getGalleryId(url: string): string | null;
    getGalleryUrl(id: string): string;
    getGalleryPageUrl?(id: string): string;
    getApiUrl(id: string): string;
    getImageUrls(mediaId: string, filename: string): string[];
}

/** The currently supported clearnet NHentai source. */
export const clearnetSource: GallerySource = {
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

    getGalleryPageUrl(id: string): string {
        return "https://nhentai.net/g/" + encodeURIComponent(id) + "/1/";
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
    }
};
