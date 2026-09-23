// Hitomi image URL and hash path resolver (pure functions).
//
// Source of truth: Hitomi reader script and gg.js.
// Converts 64-char image hashes into CDN subdomains and path components.

export interface HitomiImageFile {
    hash: string;
    haswebp?: number | boolean;
    hasavif?: number | boolean;
    name: string;
    width?: number;
    height?: number;
    single?: number;
}

export interface GgConfig {
    m?: (g: number) => number;
    b?: string;
    s?: (h: string) => string;
}

let activeGgConfig: GgConfig = {
    m: (g: number) => (g % 2 === 0 ? 0 : 1),
    b: "16",
    s: (h: string) => h
};

export function setGgConfig(config: GgConfig): void {
    activeGgConfig = Object.assign({}, activeGgConfig, config);
}

/**
 * Converts a SHA-256 hash into the directory path structure:
 * e.g. "abc...e12" -> "2/e1/abc...e12"
 */
export function fullPathFromHash(hash: string): string {
    if (!hash || typeof hash !== "string" || hash.length < 3) {
        return hash || "";
    }
    const clean = hash.trim().toLowerCase();
    const last1 = clean.slice(-1);
    const last3to2 = clean.slice(-3, -1);
    return `${last1}/${last3to2}/${clean}`;
}

/**
 * Determines the frontend subdomain prefix ('a', 'b', 'ba', etc.) for a hash.
 */
export function subdomainFromHash(hash: string, dir: string = "webp"): string {
    if (!hash || typeof hash !== "string" || hash.length < 3) {
        return "a";
    }
    const clean = hash.trim().toLowerCase();
    // Match the 2nd and 3rd hex digits from the end
    const last3 = clean.slice(-3);
    const g = parseInt(last3.slice(0, 1) + last3.slice(1, 3), 16);
    let offset = 0;
    if (activeGgConfig.m) {
        try {
            offset = activeGgConfig.m(g);
        } catch (_) {
            offset = g % 3;
        }
    } else {
        offset = g % 3;
    }
    const prefix = String.fromCharCode(97 + (isNaN(offset) ? 0 : offset));
    return prefix + (dir === "avif" ? "a" : "a");
}

/**
 * Builds all CDN mirror URLs for a given Hitomi image file.
 */
export function buildHitomiImageUrls(file: HitomiImageFile, preferAvif: boolean = false): string[] {
    if (!file || !file.hash) {
        return [];
    }
    const ext = preferAvif && file.hasavif ? "avif" : (file.haswebp || file.haswebp === undefined ? "webp" : "jpg");
    const dir = ext === "avif" ? "avif" : "webp";
    const path = fullPathFromHash(file.hash);
    const fullFilename = `${path}.${ext}`;

    const primarySub = subdomainFromHash(file.hash, dir);
    const mirrors = [
        `https://${primarySub}.gold-usergeneratedcontent.net/${dir}/${fullFilename}`,
        `https://a.gold-usergeneratedcontent.net/${dir}/${fullFilename}`,
        `https://b.gold-usergeneratedcontent.net/${dir}/${fullFilename}`,
        `https://aa.gold-usergeneratedcontent.net/${dir}/${fullFilename}`,
        `https://ba.gold-usergeneratedcontent.net/${dir}/${fullFilename}`,
        `https://bb.gold-usergeneratedcontent.net/${dir}/${fullFilename}`
    ];

    // Remove duplicates while preserving order
    return mirrors.filter((val, idx, self) => self.indexOf(val) === idx);
}
