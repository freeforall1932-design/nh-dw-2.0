// Unit tests for the two-mode API access layer (apiAuth.ts):
//   * API key mode: Authorization: Key ..., API-URL-only attachment, 429 backoff
//   * Open-tab (keyless) mode: no Authorization header is ever produced
// No network access: fetch and sleep are injected.

const assert = require('assert');
const apiAuth = require('../build/test/utils/apiAuth.js');

function makeLocalStore(initial) {
    const store = Object.assign({}, initial);
    return {
        store,
        get(defaults, cb) { cb(Object.assign({}, defaults, store)); },
        set(items, cb) { Object.assign(store, items); if (cb) cb(); },
        remove(keys, cb) {
            (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]);
            if (cb) cb();
        }
    };
}

function jsonResponse(status, body, headers) {
    const map = Object.assign({}, headers || {});
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => map[String(name).toLowerCase()] || null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body))
    };
}

describe('API access layer (apiAuth)', () => {
    let local;

    beforeEach(() => {
        local = makeLocalStore({});
        global.chrome = { storage: { local } };
    });

    afterEach(() => {
        delete global.chrome;
    });

    describe('header construction', () => {
        it('builds "Key <key>" Authorization headers and rejects empty keys', () => {
            assert.strictEqual(apiAuth.buildAuthHeader('abc'), 'Key abc');
            assert.strictEqual(apiAuth.buildAuthHeader('  padded  '), 'Key padded');
            assert.strictEqual(apiAuth.buildAuthHeader(''), null);
            assert.strictEqual(apiAuth.buildAuthHeader(null), null);
            assert.strictEqual(apiAuth.buildAuthHeader(undefined), null);
        });

        it('recognizes nhentai API URLs only', () => {
            assert.strictEqual(apiAuth.isNhentaiApiUrl('https://nhentai.net/api/v2/galleries/674496'), true);
            assert.strictEqual(apiAuth.isNhentaiApiUrl('https://nhentai.net/api/gallery/674496'), true);
            assert.strictEqual(apiAuth.isNhentaiApiUrl('https://nhentai.net/g/674496/'), false);
            assert.strictEqual(apiAuth.isNhentaiApiUrl('https://i.nhentai.net/galleries/4128713/1.webp'), false);
            assert.strictEqual(apiAuth.isNhentaiApiUrl('http://nhentai.net/api/v2/galleries/1'), false);
        });

        it('attaches Authorization only to nhentai API URLs in keyed mode', () => {
            const apiHeaders = apiAuth.getApiHeadersForUrl('https://nhentai.net/api/v2/galleries/674496', 'secret');
            assert.strictEqual(apiHeaders['Authorization'], 'Key secret');

            const cdnHeaders = apiAuth.getApiHeadersForUrl('https://i.nhentai.net/galleries/4128713/1.webp', 'secret');
            assert.strictEqual(cdnHeaders['Authorization'], undefined,
                'the API key must never be attached to CDN media URLs');

            const keylessHeaders = apiAuth.getApiHeadersForUrl('https://nhentai.net/api/v2/galleries/674496', null);
            assert.strictEqual(keylessHeaders['Authorization'], undefined,
                'keyless mode must never produce an Authorization header');
        });
    });

    describe('mode state and gate decision', () => {
        it('starts in keyless mode with the gate pending', async () => {
            const state = await apiAuth.getApiModeState();
            assert.strictEqual(state.mode, 'keyless');
            assert.strictEqual(state.apiKey, null);
            assert.strictEqual(state.gateSkipped, false);
            assert.strictEqual(state.useServerArchive, false);
            assert.strictEqual(apiAuth.decideGate(state), 'gate');
        });

        it('entering a key switches to keyed mode and withdraws a previous skip', async () => {
            await apiAuth.skipApiKeyGate();
            await apiAuth.saveApiKey('abc');
            const state = await apiAuth.getApiModeState();
            assert.strictEqual(state.mode, 'keyed');
            assert.strictEqual(state.apiKey, 'abc');
            assert.strictEqual(state.gateSkipped, false);
            assert.strictEqual(apiAuth.decideGate(state), 'keyed');
        });

        it('skipping the gate is remembered until a key is saved or cleared', async () => {
            await apiAuth.skipApiKeyGate();
            let state = await apiAuth.getApiModeState();
            assert.strictEqual(apiAuth.decideGate(state), 'keyless');

            await apiAuth.saveApiKey('abc');
            await apiAuth.clearApiKey();
            state = await apiAuth.getApiModeState();
            assert.strictEqual(state.mode, 'keyless');
            assert.strictEqual(state.gateSkipped, false, 'clearing the key must re-arm the gate');
            assert.strictEqual(apiAuth.decideGate(state), 'gate');
        });

        it('saveApiKey with an empty value clears instead of storing blanks', async () => {
            await apiAuth.saveApiKey('   ');
            const state = await apiAuth.getApiModeState();
            assert.strictEqual(state.apiKey, null);
        });
    });

    describe('429 backoff parsing', () => {
        it('parses numeric Retry-After seconds', () => {
            assert.strictEqual(apiAuth.parseRetryAfterMs('3', 0), 3000);
        });

        it('clamps the backoff to [250ms, 15s]', () => {
            assert.strictEqual(apiAuth.parseRetryAfterMs('0', 0), 250);
            assert.strictEqual(apiAuth.parseRetryAfterMs('999', 0), 15000);
        });

        it('parses HTTP dates relative to now', () => {
            const now = Date.parse('2026-08-26T12:00:00Z');
            const value = new Date(now + 4000).toUTCString();
            assert.strictEqual(apiAuth.parseRetryAfterMs(value, now), 4000);
        });

        it('defaults to 2s on missing or malformed values', () => {
            assert.strictEqual(apiAuth.parseRetryAfterMs(null, 0), 2000);
            assert.strictEqual(apiAuth.parseRetryAfterMs('not-a-date', 0), 2000);
        });
    });

    describe('fetchNhentaiApi', () => {
        it('sends Authorization on a keyed API request and returns a 200', async () => {
            const calls = [];
            const fetchImpl = (url, init) => {
                calls.push({ url, init });
                return Promise.resolve(jsonResponse(200, { ok: true }));
            };
            const resp = await apiAuth.fetchNhentaiApi('https://nhentai.net/api/v2/galleries/674496', {}, 'abc', { fetchImpl });
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].init.headers['Authorization'], 'Key abc');
        });

        it('sends no Authorization when keyless (open-tab mode unchanged)', async () => {
            const calls = [];
            const fetchImpl = (url, init) => {
                calls.push({ url, init });
                return Promise.resolve(jsonResponse(200, { ok: true }));
            };
            await apiAuth.fetchNhentaiApi('https://nhentai.net/api/v2/galleries/674496', {}, null, { fetchImpl });
            assert.strictEqual(calls[0].init.headers['Authorization'], undefined);
        });

        it('retries a 429 after the Retry-After delay', async () => {
            const calls = [];
            const sleeps = [];
            const fetchImpl = (url, init) => {
                calls.push({ url, init });
                if (calls.length === 1) {
                    return Promise.resolve(jsonResponse(429, {}, { 'retry-after': '3' }));
                }
                return Promise.resolve(jsonResponse(200, { ok: true }));
            };
            const resp = await apiAuth.fetchNhentaiApi('https://nhentai.net/api/v2/galleries/674496', {}, 'abc', {
                fetchImpl,
                sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }
            });
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(calls.length, 2);
            assert.deepStrictEqual(sleeps, [3000]);
        });

        it('gives up after maxRetries and returns the lingering 429', async () => {
            const calls = [];
            const fetchImpl = () => {
                calls.push(1);
                return Promise.resolve(jsonResponse(429, {}, { 'retry-after': '1' }));
            };
            const resp = await apiAuth.fetchNhentaiApi('https://nhentai.net/api/v2/galleries/674496', {}, 'abc', {
                fetchImpl,
                sleepImpl: () => Promise.resolve(),
                maxRetries: 1
            });
            assert.strictEqual(resp.status, 429);
            assert.strictEqual(calls.length, 2, '1 initial attempt + 1 retry');
        });

        it('stops retrying once the abort signal fires', async () => {
            const controller = new AbortController();
            const fetchImpl = () => Promise.resolve(jsonResponse(429, {}, { 'retry-after': '1' }));
            controller.abort();
            await assert.rejects(
                apiAuth.fetchNhentaiApi('https://nhentai.net/api/v2/galleries/674496', { signal: controller.signal }, 'abc', {
                    fetchImpl,
                    sleepImpl: () => Promise.resolve()
                }),
                /abort/i
            );
        });
    });
});
