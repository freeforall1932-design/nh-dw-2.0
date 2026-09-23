import { SiteAdapter, GallerySource, clearnetSource } from "./GallerySource";
import { hentaieraSource } from "./hentaieraSource";
import { imhentaiSource } from "./imhentaiSource";
import { hentaienvySource } from "./hentaienvySource";
import { hentaifoxSource } from "./hentaifoxSource";
import { hitomiSource } from "./hitomiSource";

const sources: SiteAdapter[] = [
    clearnetSource,
    hentaieraSource,
    imhentaiSource,
    hentaienvySource,
    hentaifoxSource,
    hitomiSource
];

export function registerSource(source: SiteAdapter): void {
    const existingIndex = sources.findIndex((s) => s.site === source.site);
    if (existingIndex >= 0) {
        sources[existingIndex] = source;
    } else {
        sources.push(source);
    }
}

export function getSourceForUrl(url: string): SiteAdapter | null {
    return sources.find((source) => source.matchesUrl(url)) || null;
}

export function getAdapterForUrl(url: string): SiteAdapter | null {
    return getSourceForUrl(url);
}

export function getSourceForSite(site: string): SiteAdapter | null {
    return sources.find((source) => source.site === site) || null;
}

export function getAdapterForSite(site: string): SiteAdapter | null {
    return getSourceForSite(site);
}

export function getConfiguredSources(): SiteAdapter[] {
    return sources.slice();
}

export function getAllAllowedImageHosts(): string[] {
    const hosts: string[] = [];
    for (const source of sources) {
        if (source.getImageHosts) {
            for (const host of source.getImageHosts()) {
                const lower = host.toLowerCase();
                if (!hosts.includes(lower)) {
                    hosts.push(lower);
                }
            }
        }
    }
    return hosts;
}

export {
    SiteAdapter,
    GallerySource,
    clearnetSource,
    hentaieraSource,
    imhentaiSource,
    hentaienvySource,
    hentaifoxSource,
    hitomiSource
};
