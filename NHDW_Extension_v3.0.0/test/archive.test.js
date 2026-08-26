// Unit tests for the one-shot server archive client (ArchiveDownload.ts).
// Contract source: nhentai API v2 OpenAPI spec — POST
// /api/v2/galleries/{id}/download requires an API key, takes format=zip|cbz,
// and returns DownloadResponse { url: string, expires_at: number }.
// The endpoint is opportunistic: every failure mode must yield null so the
// caller falls back to page-by-page downloading.

const assert = require('assert');
const archive = require('../build/test/background/ArchiveDownload.js');

function jsonResponse(status, body, headers) {
    const map = Object.assign({}, headers || {});
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => map[String(name).toLowerCase()] || null },
        json: () => {
            if (body === '__invalid__') return Promise.reject(new Error('bad json'));
            return Promise.resolve(body);
        },
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]))
    };
}

describe('server archive endpoint client', () => {
    it('builds the documented request URL with the format query parameter', () => {
        assert.strictEqual(
            archive.getArchiveRequestUrl(674496, 'zip'),
            'https://nhentai.net/api/v2/galleries/674496/download?format=zip'
        );
        assert.strictEqual(
            archive.getArchiveRequestUrl('674496', 'cbz'),
            'https://nhentai.net/api/v2/galleries/674496/download?format=cbz'
        );
    });

    it('requires an API key and never calls the endpoint keyless', async () => {
        const calls = [];
        const result = await archive.requestArchiveDownloadUrl(674496, 'zip', null, {
            fetchImpl: (url, init) => { calls.push({ url, init }); return Promise.resolve(jsonResponse(200, {})); }
        });
        assert.strictEqual(result, null);
        assert.strictEqual(calls.length, 0, 'keyless mode must not touch the authenticated endpoint');
    });

    it('POSTs with the keyed Authorization header and parses DownloadResponse', async () => {
        const calls = [];
        const result = await archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
            fetchImpl: (url, init) => {
                calls.push({ url, init });
                return Promise.resolve(jsonResponse(200, {
                    url: 'https://cdn.nhentai.net/dl/xyz.zip?sig=1',
                    expires_at: 1787300000
                }));
            }
        });
        assert.deepStrictEqual(result, { url: 'https://cdn.nhentai.net/dl/xyz.zip?sig=1', expiresAt: 1787300000 });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].init.method, 'POST');
        assert.strictEqual(calls[0].init.headers['Authorization'], 'Key abc');
    });

    it('returns null for auth failures, disabled feature flags and exhausted 429s', async () => {
        for (const status of [401, 403, 503, 429]) {
            const result = await archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
                fetchImpl: () => Promise.resolve(jsonResponse(status, {})),
                sleepImpl: () => Promise.resolve(),
                maxRetries: 0
            });
            assert.strictEqual(result, null, 'status ' + status + ' must fall back to page-by-page');
        }
    });

    it('returns null for malformed or unusable bodies', async () => {
        const cases = [
            '__invalid__',                                   // not JSON
            {},                                               // missing url
            { url: 'not-a-url', expires_at: 1 },              // relative url
            { url: 'javascript:alert(1)', expires_at: 1 }     // non-http scheme
        ];
        for (const body of cases) {
            const result = await archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
                fetchImpl: () => Promise.resolve(jsonResponse(200, body)),
                sleepImpl: () => Promise.resolve(),
                maxRetries: 0
            });
            assert.strictEqual(result, null, 'body ' + JSON.stringify(body) + ' must not be usable');
        }
    });

    it('defaults expires_at when the server omits it', async () => {
        const result = await archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
            fetchImpl: () => Promise.resolve(jsonResponse(200, { url: 'https://example.org/a.zip' }))
        });
        assert.strictEqual(result.url, 'https://example.org/a.zip');
        assert.strictEqual(result.expiresAt, Number.MAX_SAFE_INTEGER);
    });

    it('fetches archive bytes WITHOUT the API key (signed URL is the credential)', async () => {
        const calls = [];
        const blob = await archive.fetchArchiveBytes('https://cdn.nhentai.net/dl/xyz.zip?sig=1', {
            fetchImpl: (url, init) => {
                calls.push({ url, init });
                return Promise.resolve(jsonResponse(200, {}));
            }
        });
        assert.ok(blob instanceof Blob);
        assert.strictEqual(calls.length, 1);
        const headers = calls[0].init.headers || {};
        assert.strictEqual(headers['Authorization'], undefined,
            'the API key must never be sent to the archive delivery URL');
    });

    it('throws on a failing archive delivery so the caller falls back', async () => {
        await assert.rejects(
            archive.fetchArchiveBytes('https://cdn.nhentai.net/dl/expired.zip', {
                fetchImpl: () => Promise.resolve(jsonResponse(403, {}))
            }),
            /Failed to fetch server archive/
        );
    });
});
