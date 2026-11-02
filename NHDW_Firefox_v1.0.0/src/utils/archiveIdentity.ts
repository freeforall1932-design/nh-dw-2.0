// Provenance for the optional nhentai.net server archive. Unlike history's
// legacy site normalization, a missing site is NOT evidence that a gallery
// belongs to nhentai. These helpers derive a site and id independently of the
// gallery metadata being downloaded, and fail closed on ambiguity.

export interface ArchiveIdentity {
    site: "nhentai";
    id: string;
}

export function archiveGalleryId(value: any): string | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const id = String(value);
    if (!/^[1-9][0-9]*$/.test(id)) return null;
    const number = Number(id);
    return Number.isSafeInteger(number) && String(number) === id ? id : null;
}

// A single-title preview is built from this URL, not from the gallery JSON.
export function archiveIdentityFromGalleryUrl(url: any): ArchiveIdentity | null {
    if (typeof url !== "string") return null;
    try {
        const parsed = new URL(url);
        if (parsed.origin !== "https://nhentai.net" || parsed.username || parsed.password) return null;
        const match = /^\/g\/([1-9][0-9]*)(?:\/|$)/.exec(parsed.pathname);
        const id = match ? archiveGalleryId(match[1]) : null;
        return id === null ? null : { site: "nhentai", id: id };
    } catch (_) {
        return null;
    }
}

// Batch jobs carry one explicitly selected site, or a site-qualified key.
// A bare legacy key plus an absent job site stays ambiguous and is rejected.
export function archiveIdentityFromBatchKey(key: string | number, jobSite?: string | null): ArchiveIdentity | null {
    if (jobSite !== undefined && jobSite !== null && jobSite !== "" && jobSite !== "nhentai") return null;
    const raw = String(key);
    const colon = raw.indexOf(":");
    let value = raw;
    if (colon !== -1) {
        if (raw.slice(0, colon) !== "nhentai") return null;
        value = raw.slice(colon + 1);
    } else if (jobSite !== "nhentai") {
        return null;
    }
    const id = archiveGalleryId(value);
    return id === null ? null : { site: "nhentai", id: id };
}
