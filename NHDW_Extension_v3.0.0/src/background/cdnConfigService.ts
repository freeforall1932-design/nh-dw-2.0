// Service-worker side of the CDN configuration: resolve, cache, and
// permission-filter the nhentai image server list.
//
// Why the worker owns this:
//   - The offscreen document has no chrome.storage and must not grow any
//     extension APIs beyond chrome.runtime, so the worker relays the resolved
//     list to it with each job's options (see offscreen.ts applyCdnServers).
//   - chrome.permissions (used to detect hosts that need the optional
//     https://*.nhentai.net grant) is a worker/popup API; permission requests
//     need a user gesture and are made from the popup.
//
// Resolution strategy (per GET /api/v2/cdn docs: "call at startup, cache the
// result for the session"):
//   1. fresh in-memory cache (MV3 workers are ephemeral; this covers bursts)
//   2. fresh chrome.storage.session cache (covers worker restarts)
//   3. fetch: through the source gallery tab's session first (Cloudflare
//      clearance, same as metadata fetches), then extension-origin fetch;
//      both bounded by a short timeout so an unreachable API never stalls a
//      job for more than a few seconds
//   4. any failure keeps the stale cache or the hardcoded fallback list
//
// The returned list is filtered to hosts the extension actually has permission
// to fetch: statically granted hosts (manifest host_permissions) plus anything
// the user granted through optional_host_permissions. Hosts the API reported
// but that lack permission are surfaced to the popup via getCdnStatus so the
// user can grant them with one click; until then jobs simply use the permitted
// hosts (downloads keep working instead of hammering CORS-blocked mirrors).

import { fetchUrlFromTab } from "./tabImageFetch";
import {
    CDN_CACHE_KEY,
    CDN_CACHE_TTL_MS,
    CDN_CONFIG_URL,
    DEFAULT_IMAGE_SERVERS,
    imageServerOrigins,
    mergeImageServers,
    parseCdnConfigBody,
    sanitizeImageServers
} from "../sources/cdnConfig";

const CDN_FETCH_TIMEOUT_MS = 6000;

type CdnCacheEntry = {
    servers: string[];
    fetchedAt: number;
};

let memoryCache: CdnCacheEntry | null = null;
let inflight: Promise<string[]> | null = null;

function retryWarn(message: string) {
    // Production keeps its warnings; the window-less e2e sandboxes silence
    // expected-failure logs (same convention as the Downloader retry logs).
    if (!(globalThis as any).__NHDW_SILENT_RETRY_LOGS__) {
        console.warn(message);
    }
}

function isFresh(entry: CdnCacheEntry | null): boolean {
    return !!entry
        && typeof entry.fetchedAt === "number"
        && Array.isArray(entry.servers)
        && entry.servers.length > 0
        && Date.now() - entry.fetchedAt < CDN_CACHE_TTL_MS;
}

function readSessionCache(): Promise<CdnCacheEntry | null> {
    return new Promise((resolve) => {
        try {
            if (typeof chrome === "undefined" || !(chrome.storage as any) || !(chrome.storage as any).session) {
                resolve(null);
                return;
            }
            const result: any = (chrome.storage as any).session.get(CDN_CACHE_KEY, (items: any) => {
                const entry = items && items[CDN_CACHE_KEY];
                resolve(entry && typeof entry === "object" ? entry : null);
            });
            if (result && typeof result.then === "function") {
                result.then((items: any) => {
                    const entry = items && items[CDN_CACHE_KEY];
                    resolve(entry && typeof entry === "object" ? entry : null);
                }).catch(() => resolve(null));
            }
        } catch (_) {
            resolve(null);
        }
    });
}

function writeSessionCache(entry: CdnCacheEntry): void {
    try {
        (chrome.storage as any).session.set({ [CDN_CACHE_KEY]: entry });
    } catch (_) { /* best effort: the in-memory cache still covers this session */ }
}

function withTimeout<T>(value: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const finish = (result: T) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => finish(fallback), ms);
        value.then((result: T) => finish(result)).catch(() => finish(fallback));
    });
}

async function fetchCdnConfigText(tabId: number | null): Promise<string | null> {
    // Source tab first: the gallery tab's session is Cloudflare-cleared and
    // same-origin to nhentai.net, which extension-origin fetches often are not.
    if (tabId !== null) {
        try {
            const viaTab = await withTimeout(fetchUrlFromTab(tabId, CDN_CONFIG_URL), CDN_FETCH_TIMEOUT_MS, null);
            if (viaTab && viaTab.ok && typeof viaTab.text === "string" && viaTab.text) {
                return viaTab.text;
            }
        } catch (_) { /* fall through to the extension-origin fetch */ }
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CDN_FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(CDN_CONFIG_URL, {
                credentials: "include",
                cache: "no-store",
                signal: controller.signal
            });
            if (resp.ok) {
                return await resp.text();
            }
        } finally {
            clearTimeout(timer);
        }
    } catch (_) { /* Cloudflare / network failure: keep the cache or defaults */ }
    return null;
}

function permissionsApi(): any | null {
    if (typeof chrome === "undefined") {
        return null;
    }
    const api = (chrome as any).permissions;
    return api && typeof api.contains === "function" ? api : null;
}

function containsPermission(origin: string): Promise<boolean> {
    return new Promise((resolve) => {
        const api = permissionsApi();
        if (api === null) {
            // No permissions API (older Chrome, window-less test realms):
            // assume granted rather than disabling perfectly good mirrors.
            resolve(true);
            return;
        }
        try {
            const result: any = api.contains({ origins: [origin] }, (granted: boolean) => resolve(!!granted));
            if (result && typeof result.then === "function") {
                result.then((granted: boolean) => resolve(!!granted)).catch(() => resolve(false));
            }
        } catch (_) {
            resolve(false);
        }
    });
}

function originForServer(server: string): string | null {
    const origins = imageServerOrigins([server]);
    return origins.length > 0 ? origins[0] : null;
}

// Filter to hosts the extension may actually fetch. The fallback list is
// statically granted by host_permissions, so this never empties the result.
export async function permittedImageServers(servers: string[]): Promise<string[]> {
    const valid = sanitizeImageServers(servers);
    if (valid.length === 0) {
        return DEFAULT_IMAGE_SERVERS.slice();
    }
    const checks = await Promise.all(valid.map(async (server) => {
        const origin = originForServer(server);
        return { server: server, granted: origin === null ? false : await containsPermission(origin) };
    }));
    const permitted = checks.filter((check) => check.granted).map((check) => check.server);
    return permitted.length > 0 ? permitted : DEFAULT_IMAGE_SERVERS.slice();
}

export async function missingImageServerOrigins(servers: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const origin of imageServerOrigins(sanitizeImageServers(servers))) {
        if (!(await containsPermission(origin))) {
            missing.push(origin);
        }
    }
    return missing;
}

// Resolve the image server list for the next job. Never rejects: every failure
// path degrades to the stale cache or the hardcoded fallback list.
export function ensureImageServers(tabId?: number | null): Promise<string[]> {
    if (isFresh(memoryCache)) {
        return permittedImageServers(memoryCache!.servers);
    }
    if (inflight !== null) {
        return inflight;
    }
    inflight = (async () => {
        try {
            if (!isFresh(memoryCache)) {
                const stored = await readSessionCache();
                if (isFresh(stored)) {
                    memoryCache = stored;
                }
            }
            if (!isFresh(memoryCache)) {
                const text = await fetchCdnConfigText(typeof tabId === "number" ? tabId : null);
                const preferred = text !== null ? parseCdnConfigBody(text) : null;
                if (preferred !== null) {
                    memoryCache = {
                        servers: mergeImageServers(preferred, DEFAULT_IMAGE_SERVERS),
                        fetchedAt: Date.now()
                    };
                    writeSessionCache(memoryCache);
                } else if (memoryCache !== null) {
                    retryWarn("NHentai CDN config could not be refreshed; using the stale cached image server list.");
                } else {
                    retryWarn("NHentai CDN config could not be fetched; using the built-in fallback image server list.");
                }
            }
        } catch (_) {
            retryWarn("NHentai CDN config resolution failed; using the fallback image server list.");
        } finally {
            inflight = null;
        }
        return permittedImageServers(memoryCache !== null ? memoryCache.servers : DEFAULT_IMAGE_SERVERS);
    })();
    return inflight;
}

// Status for the popup: the resolved server list and the origins that still
// need the optional nhentai host grant (shown with a Grant access button —
// permission requests require a user gesture, which only the popup has).
export async function getCdnStatus(): Promise<{ imageServers: string[]; missingOrigins: string[] }> {
    const servers = memoryCache !== null ? memoryCache.servers.slice() : DEFAULT_IMAGE_SERVERS.slice();
    return {
        imageServers: servers,
        missingOrigins: await missingImageServerOrigins(servers)
    };
}
