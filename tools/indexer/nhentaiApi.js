'use strict';
// nhentai API v2 client for the offline indexer (INDEXER_PLAN.md §3, Route A).
//
// Everything here follows the project's own API reference:
// "old deprecated source code/NHENTAI_API_V2.md" (spec: nhentai.net/api/v2).
//   * Auth is `Authorization: Key <key>` — the only third-party method the
//     docs allow. No key = public endpoints at the lower anon rate limits.
//   * A descriptive User-Agent is requested by the API guidelines.
//   * Rate limits are DOCUMENTED per endpoint (galleries: 15/min anon,
//     30/min keyed). The client spaces requests accordingly and refuses to
//     go faster; a 429 stops the run (house rule: throttling is never
//     retried or bypassed) and the caller saves state for a clean resume.
//   * A Cloudflare challenge body stops the run with words, never a retry.
//
// Pure Node (>=20.19): global fetch, no dependencies. fetchImpl is injectable
// so test-crawl.js exercises every behaviour offline.

const USER_AGENT = 'NHentaiDownloader-Indexer/1.0 (https://github.com/freeforall1932-design/nh-dw-2.0)';

const DEFAULT_BASE_URL = 'https://nhentai.net';

/** Documented listing limits: per minute, anon vs keyed (API_V2.md). */
const LISTING_PER_MIN = { anon: 15, keyed: 30 };

/** Default spacing between listing requests, ms, with headroom. */
function defaultIntervalMs(hasKey) {
    const perMinute = hasKey ? LISTING_PER_MIN.keyed : LISTING_PER_MIN.anon;
    return Math.ceil(60000 / perMinute) + 200;
}

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}
class RateLimitedError extends Error {
    constructor(retryAfterSeconds) {
        super('the API answered 429 (rate limited)' +
            (retryAfterSeconds ? ' — Retry-After ' + retryAfterSeconds + 's' : '') +
            '; the run stopped so the site is never pressured — rerun the same command to resume');
        this.name = 'RateLimitedError';
        this.retryAfterSeconds = retryAfterSeconds || null;
    }
}
class ChallengeError extends Error {
    constructor(message) {
        super(message || 'a Cloudflare challenge page came back instead of JSON; the indexer will not bypass it — try again later or from a network where the site loads normally');
        this.name = 'ChallengeError';
    }
}
class NotFoundError extends Error {
    constructor(message) {
        super(message || 'the API answered 404 for this page');
        this.name = 'NotFoundError';
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeChallenge(status, contentType, bodyText) {
    if (typeof bodyText !== 'string') return false;
    const html = (contentType || '').includes('text/html') || /^\s*<!DOCTYPE/i.test(bodyText) || /^\s*<html/i.test(bodyText);
    if (!html) return false;
    return /Just a moment|challenge-platform|cf-chl|Attention Required/i.test(bodyText) || status === 403 || status === 503;
}

function extractRetryAfter(headers) {
    const raw = headers && headers.get ? headers.get('retry-after') : null;
    if (!raw) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Create the API client. Options:
 *   baseUrl, apiKey, minIntervalMs, perPage, fetchImpl, now, log.
 * The interval defaults to the DOCUMENTED per-endpoint limit for the current
 * key state, with headroom; it is a floor, never a target to squeeze.
 */
function createClient(options) {
    const opts = options || {};
    const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const apiKey = opts.apiKey || '';
    const minIntervalMs = typeof opts.minIntervalMs === 'number' && opts.minIntervalMs >= 0
        ? opts.minIntervalMs
        : defaultIntervalMs(!!apiKey);
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const now = opts.now || (() => Date.now());
    const log = opts.log || (() => {});
    if (typeof fetchImpl !== 'function') {
        throw new Error('This Node has no global fetch(); the indexer needs Node >= 18.');
    }

    let lastRequestAt = 0;

    async function throttle() {
        const gap = now() - lastRequestAt;
        const jitter = Math.round(minIntervalMs * (Math.random() * 0.3 - 0.15)); // ±15%
        const wait = minIntervalMs + jitter - gap;
        if (wait > 0) await sleep(wait);
        lastRequestAt = now();
    }

    /**
     * One GET against /api/v2. Retries a network hiccup once; a 429, a
     * challenge page, or a second failure stops the run with a named error.
     */
    async function requestJson(path, query) {
        const url = new URL(baseUrl + '/api/v2' + path);
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        }
        const headers = { 'Accept': 'application/json', 'User-Agent': USER_AGENT };
        if (apiKey) headers['Authorization'] = 'Key ' + apiKey;

        for (let attempt = 1; attempt <= 2; attempt++) {
            await throttle();
            let response;
            try {
                response = await fetchImpl(url, { headers });
            } catch (networkError) {
                if (attempt === 1) {
                    log('network hiccup (' + networkError.message + '), retrying once');
                    await sleep(2000);
                    continue;
                }
                throw new ApiError('network failure after one retry: ' + networkError.message);
            }
            const contentType = response.headers.get('content-type') || '';
            if (response.status === 429) {
                throw new RateLimitedError(extractRetryAfter(response.headers));
            }
            if (looksLikeChallenge(response.status, contentType, '')) {
                throw new ChallengeError();
            }
            if (response.status === 404) {
                throw new NotFoundError();
            }
            // Deliberate status-range check rather than response.ok: robust
            // against non-standard Response shapes (and test doubles).
            if (response.status < 200 || response.status >= 300) {
                if (response.status >= 500 && attempt === 1) {
                    log('server error ' + response.status + ', retrying once');
                    await sleep(5000);
                    continue;
                }
                throw new ApiError('the API answered ' + response.status + ' for ' + url.pathname, response.status);
            }
            const bodyText = await response.text();
            if (looksLikeChallenge(response.status, contentType, bodyText)) {
                throw new ChallengeError();
            }
            let json;
            try {
                json = JSON.parse(bodyText);
            } catch (_) {
                throw new ApiError('the API returned non-JSON where JSON was expected (' + url.pathname + ')');
            }
            return json;
        }
        throw new ApiError('unreachable'); // the loop always returns or throws
    }

    /** GET /galleries — newest-first full catalog feed. */
    async function getGalleriesPage(page, perPage) {
        return requestJson('/galleries', { page, per_page: perPage });
    }

    /** GET /galleries/tagged?sort=date — newest-first per-tag walk (§6 pin). */
    async function getTaggedPage(tagId, page, perPage, sort) {
        return requestJson('/galleries/tagged', { tag_id: tagId, page, per_page: perPage, sort: sort || 'date' });
    }

    /** GET /search — free query walk (supports the site's query syntax). */
    async function getSearchPage(query, page, perPage) {
        return requestJson('/search', { q: query, page, per_page: perPage });
    }

    /**
     * GET /tags/{type} — every tag of one type, for the tier-1 dictionary.
     * The docs call it a large response and say to cache locally; tolerate
     * both a bare array and a paginated {result:[...]} envelope.
     */
    async function getTagsOfType(type) {
        const json = await requestJson('/tags/' + encodeURIComponent(type), {});
        if (Array.isArray(json)) return json;
        if (json && Array.isArray(json.result)) return json.result;
        throw new ApiError('unexpected tag dictionary shape for ' + type);
    }

    /** GET /user — the one third-party-safe key check (API_V2.md). */
    async function verifyKey() {
        const json = await requestJson('/user', {});
        if (!json || typeof json.username !== 'string') {
            throw new ApiError('the key check did not return a profile — is the key valid?');
        }
        return json;
    }

    return {
        baseUrl,
        apiKeyPresent: !!apiKey,
        minIntervalMs,
        getGalleriesPage,
        getTaggedPage,
        getSearchPage,
        getTagsOfType,
        verifyKey,
    };
}

/** Pull the card list out of a listing response envelope. */
function resultOf(listing) {
    if (listing && Array.isArray(listing.result)) return listing.result;
    if (Array.isArray(listing)) return listing;
    throw new ApiError('the listing response carried no result[] array');
}

/** Total pages when the envelope states one; null when it does not. */
function numPagesOf(listing, perPage) {
    if (listing && Number.isFinite(listing.num_pages) && listing.num_pages > 0) return listing.num_pages;
    if (listing && Number.isFinite(listing.total) && listing.total > 0 && perPage > 0) {
        return Math.ceil(listing.total / perPage);
    }
    return null;
}

module.exports = {
    USER_AGENT,
    DEFAULT_BASE_URL,
    defaultIntervalMs,
    ApiError,
    RateLimitedError,
    ChallengeError,
    NotFoundError,
    createClient,
    resultOf,
    numPagesOf,
};
