// Optional nhentai API key support ("API key mode") and its keyless
// counterpart ("open tab mode").
//
// nhentai's official API v2 documents API keys as the authentication method
// for third-party clients: generate a key in the account settings and send it
// as `Authorization: Key YOUR_API_KEY` (see https://nhentai.net/api/v2/docs).
// Keys raise the gallery-metadata rate limit (45/min instead of 20/min per
// IP) and make batch metadata resolution independent of whatever session the
// open tab happens to have.
//
// Mode boundaries (kept deliberately explicit):
//   * KEYED mode (a key is stored):
//       - direct /api/v2/galleries/<id> fetches carry the Authorization
//         header (and a best-effort descriptive User-Agent),
//       - 429 responses are honoured with Retry-After backoff,
//       - the one-shot server archive endpoint may be used (Downloader),
//       - when the keyed request fails, every keyless route still applies as
//         a fallback.
//   * KEYLESS mode (no key stored):
//       - behaviour is byte-for-byte identical to the pre-key extension:
//         metadata resolves through the user's open NHentai tab, then a
//         plain extension-origin fetch. No Authorization header is ever
//         created.
//
// The key itself lives ONLY in chrome.storage.local: it must never sync to
// other devices, never reach content scripts, and never be attached to
// non-API URLs (CDN media servers in particular).

export const API_KEY_STORAGE = "apiKey";
// "skipped" once the user chose "continue without API key" in the popup gate;
// cleared again whenever a key is saved or removed.
export const API_GATE_STORAGE = "apiKeyGate";
export const ARCHIVE_MODE_STORAGE = "useServerArchive";

export const API_KEY_SETTINGS_URL = "https://nhentai.net/user/settings#apikeys";

// The API docs ask clients for a descriptive `User-Agent: AppName/version
// (contact or project URL)`. Best effort only: User-Agent is a forbidden
// fetch() header in some contexts and the request must never fail because
// of it.
const FALLBACK_USER_AGENT = "NHentaiDownloader/3.x (https://github.com/freeforall1932-design/nh-dw-2.0)";

export function descriptiveUserAgent(): string {
    try {
        const manifest = chrome.runtime.getManifest();
        if (manifest && manifest.version) {
            return "NHentaiDownloader/" + manifest.version + " (https://github.com/freeforall1932-design/nh-dw-2.0)";
        }
    } catch (_) { /* no manifest in this context */ }
    return FALLBACK_USER_AGENT;
}

// Returns the User-Agent header when the current context allows setting it,
// otherwise an empty object. Probe via the Headers constructor: forbidden
// header names throw there, not at send time.
export function descriptiveUserAgentHeaders(): Record<string, string> {
    try {
        if (typeof Headers === "undefined") {
            return {};
        }
        new Headers({ "User-Agent": descriptiveUserAgent() });
        return { "User-Agent": descriptiveUserAgent() };
    } catch (_) {
        return {};
    }
}

export interface ApiModeState {
    mode: "keyed" | "keyless";
    apiKey: string | null;
    useServerArchive: boolean;
    gateSkipped: boolean;
}

function storageLocal(): any | null {
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            return chrome.storage.local;
        }
    } catch (_) { /* unavailable */ }
    return null;
}

function storageGet(keys: Record<string, any>): Promise<Record<string, any>> {
    return new Promise((resolve) => {
        const store = storageLocal();
        if (store === null) {
            resolve(Object.assign({}, keys));
            return;
        }
        try {
            store.get(keys, (elems: Record<string, any>) => {
                resolve(Object.assign({}, keys, elems || {}));
            });
        } catch (_) {
            resolve(Object.assign({}, keys));
        }
    });
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((resolve) => {
        const store = storageLocal();
        if (store === null) {
            resolve();
            return;
        }
        try {
            store.set(items, () => resolve());
        } catch (_) {
            resolve();
        }
    });
}

function storageRemove(keys: string | Array<string>): Promise<void> {
    return new Promise((resolve) => {
        const store = storageLocal();
        if (store === null) {
            resolve();
            return;
        }
        try {
            store.remove(keys, () => resolve());
        } catch (_) {
            resolve();
        }
    });
}

function normalizeKey(raw: any): string | null {
    const key = String(raw === undefined || raw === null ? "" : raw).trim();
    return key.length > 0 ? key : null;
}

export async function getApiModeState(): Promise<ApiModeState> {
    const elems = await storageGet({
        [API_KEY_STORAGE]: "",
        [API_GATE_STORAGE]: "",
        [ARCHIVE_MODE_STORAGE]: false
    });
    const apiKey = normalizeKey(elems[API_KEY_STORAGE]);
    return {
        mode: apiKey !== null ? "keyed" : "keyless",
        apiKey: apiKey,
        useServerArchive: elems[ARCHIVE_MODE_STORAGE] === true,
        gateSkipped: elems[API_GATE_STORAGE] === "skipped"
    };
}

// Saving a key enters keyed mode and withdraws any previous "continue without
// API key" decision so the popup gate does not reappear.
export async function saveApiKey(raw: string): Promise<void> {
    const key = normalizeKey(raw);
    if (key === null) {
        await clearApiKey();
        return;
    }
    await storageSet({ [API_KEY_STORAGE]: key });
    await storageRemove(API_GATE_STORAGE);
}

// Removing the key returns to keyless mode and re-arms the popup gate so the
// user is asked again next time.
export async function clearApiKey(): Promise<void> {
    await storageRemove([API_KEY_STORAGE, API_GATE_STORAGE]);
}

// "Continue without API key" in the popup gate: remember the decision so the
// gate does not ask on every popup open.
export async function skipApiKeyGate(): Promise<void> {
    await storageSet({ [API_GATE_STORAGE]: "skipped" });
}

// Pure gate decision, kept separate from storage for unit testing:
//   "gate"    -> show the key box with Submit / Continue-without buttons
//   "keyed"   -> proceed, API key mode is active
//   "keyless" -> proceed with the open-tab behaviour (user already declined)
export function decideGate(state: { apiKey: string | null; gateSkipped: boolean }): "gate" | "keyed" | "keyless" {
    if (state.apiKey !== null && String(state.apiKey).trim().length > 0) {
        return "keyed";
    }
    if (state.gateSkipped) {
        return "keyless";
    }
    return "gate";
}

// The Authorization header must only ever be attached to nhentai's own API
// routes — never to CDN media URLs or anything else.
export function isNhentaiApiUrl(url: string): boolean {
    return /^https:\/\/nhentai\.net\/api\//i.test(String(url || ""));
}

export function buildAuthHeader(apiKey: string | null): string | null {
    const key = normalizeKey(apiKey);
    return key === null ? null : "Key " + key;
}

// Headers for one API request: Authorization (keyed mode only, API URLs only)
// plus the best-effort descriptive User-Agent the API docs ask for.
export function getApiHeadersForUrl(url: string, apiKey: string | null): Record<string, string> {
    const headers: Record<string, string> = Object.assign({}, descriptiveUserAgentHeaders());
    if (isNhentaiApiUrl(url)) {
        const auth = buildAuthHeader(apiKey);
        if (auth !== null) {
            headers["Authorization"] = auth;
        }
    }
    return headers;
}

// 429 handling ---------------------------------------------------------------
// The API documents 429 with Retry-After ("Treat 429 as a backoff signal").
export class NhentaiRateLimitError extends Error {
    readonly waitMs: number;
    constructor(context: string, waitMs: number) {
        const wait = Number.isFinite(waitMs)
            ? " Wait at least " + Math.ceil(waitMs / 1000) + " seconds before retrying."
            : " Follow the server's retry delay before retrying.";
        super(context + " was rate limited." + wait);
        this.name = "NhentaiRateLimitError";
        this.waitMs = waitMs;
    }
}

export function parseRetryAfterMs(value: string | null, now?: number): number {
    const current = now !== undefined ? now : Date.now();
    if (!value) {
        return 2000;
    }
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const seconds = Number(trimmed);
        // Never overflow into a short retry for an enormous server delay.
        if (!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1000) return Infinity;
        return Math.max(250, Math.ceil(seconds * 1000));
    }
    const dateMs = Date.parse(trimmed);
    if (!isNaN(dateMs)) {
        return Math.max(250, dateMs - current);
    }
    return 2000;
}

// Keep one request from tying up the worker indefinitely. A longer server
// delay is returned to the caller as 429, never shortened into an early retry.
const MAX_INLINE_RETRY_MS = 15000;

async function waitBeforeRetry(ms: number, signal: AbortSignal | undefined, sleepImpl?: (ms: number) => Promise<void>): Promise<void> {
    if (signal && signal.aborted) throw new Error("Aborted");
    if (!signal) {
        await (sleepImpl ? sleepImpl(ms) : new Promise<void>(resolve => setTimeout(resolve, ms)));
        return;
    }
    await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let finished = false;
        const finish = (error?: Error) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", abort);
            if (timer !== null) clearTimeout(timer);
            if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error("Aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        if (sleepImpl) {
            Promise.resolve().then(() => sleepImpl(ms)).then(() => finish(), () => finish(new Error("Retry wait failed")));
        } else {
            timer = setTimeout(() => finish(), ms);
        }
    });
}

export interface ApiFetchDeps {
    fetchImpl?: (url: string, init?: any) => Promise<Response>;
    sleepImpl?: (ms: number) => Promise<void>;
    // Retries after a 429 (default 2). The final response is always returned,
    // so callers decide how to react to a lingering 429.
    maxRetries?: number;
}

// fetch() for nhentai API routes with (optional) key auth and 429 backoff.
// Keyless callers pass apiKey=null and send no Authorization header.
export async function fetchNhentaiApi(
    url: string,
    init: any,
    apiKey: string | null,
    deps: ApiFetchDeps = {}
): Promise<Response> {
    const fetchImpl = deps.fetchImpl || fetch;
    const maxRetries = deps.maxRetries !== undefined ? deps.maxRetries : 2;

    const extraHeaders = getApiHeadersForUrl(url, apiKey);
    const merged: any = Object.assign({}, init || {});
    merged.headers = Object.assign({}, extraHeaders, (init && init.headers) || {});
    // Never follow a redirect while carrying the API key. A different host
    // must not receive credentials, even if an endpoint starts redirecting.
    if (extraHeaders.Authorization) merged.redirect = "error";

    for (let attempt = 0; ; attempt++) {
        if (merged.signal && merged.signal.aborted) throw new Error("Aborted");
        const resp = await fetchImpl(url, merged);
        if (resp.status !== 429 || attempt >= maxRetries) {
            return resp;
        }
        const retryAfter = resp.headers && typeof resp.headers.get === "function"
            ? resp.headers.get("Retry-After")
            : null;
        const delay = parseRetryAfterMs(retryAfter);
        if (delay > MAX_INLINE_RETRY_MS) return resp;
        // Cancel the previous body before retrying; it contains no information
        // used by this helper. Mock responses may not expose a stream.
        if (resp.body && typeof resp.body.cancel === "function") {
            try { await resp.body.cancel(); } catch (_) { /* best effort */ }
        }
        await waitBeforeRetry(delay, merged.signal, deps.sleepImpl);
    }
}
