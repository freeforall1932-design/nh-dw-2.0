/*
 * Remembered reader settings, per site.
 *
 * Why: every site needs a different page-image selector, attribute and order, and
 * the owner should not have to remember (or re-type) them for each run. A profile
 * is the small set of choices that made a site work, stored against its exact
 * HTTPS origin and revocable.
 *
 * What a profile is deliberately NOT:
 *   * not a scraper/recipe language — five known fields only, each one already a
 *     control in the panel, so nothing can be executed from storage;
 *   * not a network permission — a profile never widens host access, never
 *     auto-approves an image host and never injects anything by itself;
 *   * not a place for URLs — values are validated and length-capped, so a stored
 *     value cannot smuggle a site list in.
 */

export interface ReaderProfile {
    selector: string;
    /** "auto" | "src" | "data-src" | "data-lazy-src" | "data-original" */
    attribute: string;
    /** "reader" | "link-index" | "name-natural" */
    order: string;
    /**
     * Explicit thumbnail suffix to remove from page URLs (e.g. "-mini").
     * Empty means "use the URL as the page gives it" — the default, because
     * deriving a URL is a guess unless the user states the rule.
     */
    fullSizeSuffix: string;
    savedAt: number;
}

export type ReaderProfileMap = Record<string, ReaderProfile>;

export const PROFILE_STORAGE_KEY = "nhdwSiteProfiles";
export const MAX_PROFILES = 50;
export const MAX_SELECTOR_LENGTH = 500;
export const MAX_SUFFIX_LENGTH = 16;
const ATTRIBUTES = ["auto", "src", "data-src", "data-lazy-src", "data-original"];
const ORDERS = ["reader", "link-index", "name-natural"];
/** A suffix is a literal tail such as "-mini" or "_thumb"; never a pattern. */
const SUFFIX_PATTERN = /^[-_][A-Za-z0-9]{1,15}$/;

/** Exact HTTPS origin, or null when the value is not one. */
export function profileOrigin(origin: string): string | null {
    const value = String(origin || "").trim();
    if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) return null;
    return value.toLowerCase();
}

export interface ProfileCheck { ok: boolean; reason?: string; }

/** Validate what the panel would save. Never silently repairs a value. */
export function checkProfile(profile: Partial<ReaderProfile> | null | undefined): ProfileCheck {
    if (!profile || typeof profile !== "object") return { ok: false, reason: "No settings to save." };
    const selector = String(profile.selector === undefined ? "" : profile.selector).trim();
    if (!selector) return { ok: false, reason: "Enter the page-image selector first." };
    if (selector.length > MAX_SELECTOR_LENGTH) return { ok: false, reason: "The selector is too long." };
    if (ATTRIBUTES.indexOf(String(profile.attribute)) === -1) return { ok: false, reason: "Choose a supported image attribute." };
    if (ORDERS.indexOf(String(profile.order)) === -1) return { ok: false, reason: "Choose a supported page order." };
    const suffix = String(profile.fullSizeSuffix === undefined ? "" : profile.fullSizeSuffix).trim();
    if (suffix !== "" && (!SUFFIX_PATTERN.test(suffix) || suffix.length > MAX_SUFFIX_LENGTH)) {
        return { ok: false, reason: "The thumbnail suffix must look like \"-mini\" (a dash or underscore, then letters or digits)." };
    }
    return { ok: true };
}

/** The stored profile for one origin, or null when there is none/ it is unusable. */
export function profileFor(map: ReaderProfileMap | null | undefined, origin: string): ReaderProfile | null {
    const key = profileOrigin(origin);
    if (!key || !map || typeof map !== "object") return null;
    const stored = map[key];
    if (!stored || typeof stored !== "object") return null;
    // Re-validate on read: storage can be edited by hand or by an older build.
    if (!checkProfile(stored).ok) return null;
    return {
        selector: String(stored.selector).trim(),
        attribute: String(stored.attribute),
        order: String(stored.order),
        fullSizeSuffix: String(stored.fullSizeSuffix || "").trim(),
        savedAt: Number.isFinite(stored.savedAt) ? Number(stored.savedAt) : 0
    };
}

/** Return a new map with this origin's settings replaced. Oldest entries evict first. */
export function saveProfile(
    map: ReaderProfileMap | null | undefined, origin: string, profile: Partial<ReaderProfile>, now: number = Date.now()
): ReaderProfileMap {
    const next: ReaderProfileMap = {};
    if (map && typeof map === "object") {
        for (const key of Object.keys(map)) {
            const clean = profileFor(map, key);
            if (clean) next[key] = clean;
        }
    }
    const key = profileOrigin(origin);
    if (!key || !checkProfile(profile).ok) return next;
    next[key] = {
        selector: String(profile.selector).trim(),
        attribute: String(profile.attribute),
        order: String(profile.order),
        fullSizeSuffix: String(profile.fullSizeSuffix || "").trim(),
        savedAt: now
    };
    const keys = Object.keys(next);
    if (keys.length > MAX_PROFILES) {
        keys.sort((a, b) => next[a].savedAt - next[b].savedAt);
        for (const stale of keys.slice(0, keys.length - MAX_PROFILES)) delete next[stale];
    }
    return next;
}

/** Return a new map without this origin's settings. */
export function forgetProfile(map: ReaderProfileMap | null | undefined, origin: string): ReaderProfileMap {
    const next: ReaderProfileMap = {};
    if (!map || typeof map !== "object") return next;
    const key = profileOrigin(origin);
    for (const stored of Object.keys(map)) {
        if (key && stored === key) continue;
        const clean = profileFor(map, stored);
        if (clean) next[stored] = clean;
    }
    return next;
}
