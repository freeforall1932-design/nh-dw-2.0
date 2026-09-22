// Shared CDN image-server configuration.
//
// The nhentai API docs (GET /api/v2/cdn) are explicit: "Don't hardcode
// specific subdomains; the list can change." This module is the single source
// of truth for every place the extension used to hardcode i.nhentai.net…
// i4.nhentai.net:
//
//   - URL generation: GallerySource.getImageUrls builds page URLs from the
//     currently configured server list (API-reported servers first, cached
//     fallback mirrors after).
//   - Allowed-image validation: tabImageFetch.isAllowedImageUrl accepts only
//     image URLs on the configured servers, so URL generation and tab-fetch
//     validation can never disagree.
//
// Security model: a server entry is only accepted when it is an HTTPS origin
// (no port, credentials, path, query, or fragment) whose hostname is a
// subdomain of nhentai.net. The list is fetched from nhentai's own API (or
// through the user's nhentai tab session), so anything outside nhentai's
// DNS namespace is rejected here before it can reach URL generation or the
// dynamic-permission flow. No <all_urls> permission is ever used.
//
// Multi-site v4 support: allows registered site adapters to declare additional
// allowed image hosts and path shapes without compromising nhentai origin checks.
//
// This module is deliberately chrome-free and fetch-free so it can run in the
// service worker, the offscreen document, and plain Node test builds. The
// service worker owns refreshing the list (src/background/cdnConfigService.ts)
// and relays it to the offscreen document with each job's options.

// The known image CDN mirrors. These stay in host_permissions and act as the
// cached fallback list when /api/v2/cdn cannot be reached.
export const DEFAULT_IMAGE_SERVERS: string[] = [
    "https://i.nhentai.net",
    "https://i1.nhentai.net",
    "https://i2.nhentai.net",
    "https://i3.nhentai.net",
    "https://i4.nhentai.net"
];

// Public, no-rate-limit-documented CDN configuration endpoint.
export const CDN_CONFIG_URL = "https://nhentai.net/api/v2/cdn";

// chrome.storage.session key and TTL for the resolved config. The API docs
// recommend caching "for the session"; a stale entry still beats the hardcoded
// fallback list, so failures keep whatever cache exists.
export const CDN_CACHE_KEY = "cdnConfig";
export const CDN_CACHE_TTL_MS = 60 * 60 * 1000;

// Any subdomain of nhentai.net (multi-label included). Subdomains live in
// nhentai's own DNS namespace, so anything matching this is nhentai-owned.
const IMAGE_SERVER_HOST = /^([a-z0-9-]+\.)+nhentai\.net$/i;

// https://host/galleries/<media id>/<page number>.<extension>
const ALLOWED_IMAGE_PATH = /^\/galleries\/[0-9]+\/[0-9]+\.(jpg|jpeg|png|gif|webp)$/i;

// Decompose an HTTPS URL without the URL class: this module also runs inside
// the window-less VM sandboxes of the e2e scripts, where realm globals like
// URL are not available. Group layout: 1 = authority, 2 = path, 3 = query,
// 4 = fragment.
const HTTPS_URL_PARTS = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?.*)?(#.*)?$/i;

export interface ImageSourceRules {
    hosts?: string[];
    hostRegex?: RegExp;
    pathRegex?: RegExp;
}

const additionalImageRules: ImageSourceRules[] = [];

export function registerImageSourceRules(rules: ImageSourceRules): void {
    additionalImageRules.push(rules);
}

export function resetAdditionalImageRules(): void {
    additionalImageRules.length = 0;
}

// Currently configured servers (already merged with the fallback list) or null
// while only the defaults apply. Never exposed by reference.
let configuredImageServers: string[] | null = null;
// Lowercased hostnames of configuredImageServers, kept in sync for the
// membership check in isAllowedImageUrl.
let configuredImageHosts: string[] = [];

function hostOfServer(server: string): string | null {
    const match = HTTPS_URL_PARTS.exec(server.trim());
    if (match === null || match[3] !== undefined || match[4] !== undefined) {
        return null;
    }
    const authority = match[1];
    if (authority.includes(":") || authority.includes("@")) {
        return null; // no ports, no credentials
    }
    return authority.toLowerCase();
}

// A usable image server entry: a bare HTTPS origin on a subdomain of
// nhentai.net. Accepts an optional trailing slash; everything else (scheme,
// port, userinfo, path, query, fragment, foreign hosts) is rejected.
export function isValidImageServerUrl(server: string): boolean {
    if (typeof server !== "string") {
        return false;
    }
    const trimmed = server.trim();
    const match = HTTPS_URL_PARTS.exec(trimmed);
    if (match === null) {
        return false;
    }
    if (match[3] !== undefined || match[4] !== undefined) {
        return false; // no query strings or fragments
    }
    const path = match[2] !== undefined ? match[2] : "";
    if (path !== "" && path !== "/") {
        return false; // server entries are origins, not paths
    }
    const host = hostOfServer(trimmed);
    if (host === null) {
        return false;
    }
    return IMAGE_SERVER_HOST.test(host);
}

// Validate an unknown JSON value (as relayed from /api/v2/cdn or through job
// options) into a de-duplicated list of bare origins. Invalid entries are
// dropped, not fatal: one poisoned entry must not disable the valid servers.
export function sanitizeImageServers(candidates: any): string[] {
    if (!candidates || !Array.isArray(candidates)) {
        return [];
    }
    const seen = new Set<string>();
    const servers: string[] = [];
    for (const candidate of candidates) {
        if (typeof candidate !== "string") {
            continue;
        }
        const trimmed = candidate.trim();
        if (!isValidImageServerUrl(trimmed)) {
            continue;
        }
        const normalized = trimmed.replace(/\/+$/, "");
        if (!seen.has(normalized)) {
            seen.add(normalized);
            servers.push(normalized);
        }
    }
    return servers;
}

// Parse a /api/v2/cdn (or the /api/v2/config superset) response body into the
// validated image server list. Returns null for anything unusable — HTML
// challenge pages, malformed JSON, missing or empty image_servers — so callers
// keep their cache/defaults instead of adopting garbage.
export function parseCdnConfigBody(text: string): string[] | null {
    if (typeof text !== "string" || !text.trim()) {
        return null;
    }
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        return null;
    }
    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const servers = sanitizeImageServers(parsed.image_servers);
    return servers.length > 0 ? servers : null;
}

// API order first, then any fallback servers not already present. The fallback
// tail keeps mirror diversity when the API reports a single server, which is
// what the per-mirror retry in the Downloader depends on.
export function mergeImageServers(preferred: string[] | null | undefined, fallback: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    const sanitizedFallback = sanitizeImageServers(fallback);
    const sanitizedPreferred = sanitizeImageServers(preferred);
    for (const server of sanitizedPreferred.concat(sanitizedFallback)) {
        if (!seen.has(server)) {
            seen.add(server);
            merged.push(server);
        }
    }
    if (merged.length === 0 && Array.isArray(fallback) && fallback.length > 0) {
        // Defensive: fallback lists used internally are always valid, but a
        // caller-supplied one that sanitizes to empty must not empty the list.
        return sanitizeImageServers(DEFAULT_IMAGE_SERVERS);
    }
    return merged;
}

function applyServers(servers: string[] | null): void {
    if (servers === null || servers.length === 0) {
        configuredImageServers = null;
        configuredImageHosts = [];
        return;
    }
    configuredImageServers = servers.slice();
    configuredImageHosts = servers
        .map((server) => hostOfServer(server))
        .filter((host): host is string => host !== null);
}

// Set the active server list (sanitized and merged with the cached fallback
// mirrors). The service worker calls this with the list it resolved and
// permission-filtered; the offscreen document calls this with the list relayed
// in the job options. Passing null/empty resets to the defaults.
export function setImageServers(preferred: string[] | null | undefined): void {
    applyServers(mergeImageServers(preferred, DEFAULT_IMAGE_SERVERS));
}

export function resetImageServers(): void {
    applyServers(null);
    resetAdditionalImageRules();
}

export function getImageServers(): string[] {
    return configuredImageServers === null
        ? DEFAULT_IMAGE_SERVERS.slice()
        : configuredImageServers.slice();
}

// Manifest-style origins (https://host/*) for the optional-permission checks
// and requests. Only validated nhentai-owned servers produce origins: this
// feeds chrome.permissions.request, so a hostile/buggy list must never turn
// into a grant prompt for a foreign host. Invalid entries are skipped rather
// than fatal.
export function imageServerOrigins(servers: string[]): string[] {
    const origins: string[] = [];
    const seen = new Set<string>();
    for (const server of servers) {
        if (typeof server !== "string" || !isValidImageServerUrl(server)) {
            continue;
        }
        const host = hostOfServer(server);
        if (host === null) {
            continue;
        }
        const origin = "https://" + host + "/*";
        if (!seen.has(origin)) {
            seen.add(origin);
            origins.push(origin);
        }
    }
    return origins;
}

export function buildImageUrl(server: string, mediaId: string, filename: string): string {
    return server.replace(/\/+$/, "") + "/galleries/" + encodeURIComponent(mediaId) + "/" + filename;
}

// True when url is an original-image URL on one of the configured servers or
// on a recognized multi-site image host. Same strictness as the old hardcoded
// regex (exact path shape, no query string, bare HTTPS origins).
export function isAllowedImageUrl(
    url: string,
    sourceRules?: ImageSourceRules | { getImageHosts?(): string[]; getAllowedPathRegex?(): RegExp }
): boolean {
    if (typeof url !== "string") {
        return false;
    }
    const match = HTTPS_URL_PARTS.exec(url);
    if (match === null) {
        return false;
    }
    if (match[3] !== undefined || match[4] !== undefined) {
        return false; // query strings and fragments are never expected
    }
    const authority = match[1];
    if (authority.includes(":") || authority.includes("@")) {
        return false;
    }
    const host = authority.toLowerCase();
    const path = match[2] !== undefined ? match[2] : "";

    // 1. If explicit rules are passed (e.g. from an active adapter):
    if (sourceRules) {
        let hosts: string[] = [];
        let hostRegex: RegExp | undefined;
        let pathRegex: RegExp = ALLOWED_IMAGE_PATH;

        if ("getImageHosts" in sourceRules && typeof sourceRules.getImageHosts === "function") {
            hosts = (sourceRules.getImageHosts() || []).map((h) => h.toLowerCase());
        } else if ("hosts" in sourceRules && Array.isArray(sourceRules.hosts)) {
            hosts = sourceRules.hosts.map((h) => h.toLowerCase());
        }

        if ("hostRegex" in sourceRules && sourceRules.hostRegex instanceof RegExp) {
            hostRegex = sourceRules.hostRegex;
        }

        if ("getAllowedPathRegex" in sourceRules && typeof sourceRules.getAllowedPathRegex === "function") {
            const r = sourceRules.getAllowedPathRegex();
            if (r instanceof RegExp) pathRegex = r;
        } else if ("pathRegex" in sourceRules && sourceRules.pathRegex instanceof RegExp) {
            pathRegex = sourceRules.pathRegex;
        }

        const hostMatches = hosts.includes(host) || (hostRegex ? hostRegex.test(host) : false);
        if (hostMatches) {
            return pathRegex.test(path);
        }
        return false;
    }

    // 2. Default nhentai configuration:
    const hosts = configuredImageServers === null ? [] : configuredImageHosts;
    const isDefaultHost = DEFAULT_IMAGE_SERVERS.some((server) => hostOfServer(server) === host);
    if (isDefaultHost || hosts.includes(host)) {
        if (ALLOWED_IMAGE_PATH.test(path)) {
            return true;
        }
    }

    // 3. Registered multi-site additional rules:
    for (const rule of additionalImageRules) {
        let hostMatches = false;
        if (rule.hosts && rule.hosts.map((h) => h.toLowerCase()).includes(host)) {
            hostMatches = true;
        } else if (rule.hostRegex && rule.hostRegex.test(host)) {
            hostMatches = true;
        }
        if (hostMatches) {
            const pathRegex = rule.pathRegex || ALLOWED_IMAGE_PATH;
            if (pathRegex.test(path)) {
                return true;
            }
        }
    }

    return false;
}
