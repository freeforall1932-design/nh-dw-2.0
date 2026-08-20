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
        return "https://nhentai.net/api/gallery/" + encodeURIComponent(id);
    },

    getImageUrls(mediaId: string, filename: string): string[] {
        return [
            "https://i.nhentai.net/galleries/" + encodeURIComponent(mediaId) + "/" + filename,
            ...[1, 2, 3, 4].map((server) =>
                "https://i" + server + ".nhentai.net/galleries/" + encodeURIComponent(mediaId) + "/" + filename)
        ];
    }
};
