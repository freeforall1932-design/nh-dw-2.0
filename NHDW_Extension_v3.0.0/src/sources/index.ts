import { GallerySource, clearnetSource } from "./GallerySource";

const sources: GallerySource[] = [clearnetSource];

export function getSourceForUrl(url: string): GallerySource | null {
    return sources.find((source) => source.matchesUrl(url)) || null;
}

export function getConfiguredSources(): GallerySource[] {
    return sources.slice();
}
