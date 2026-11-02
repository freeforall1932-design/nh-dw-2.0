// Unit tests for the one-shot server archive client (ArchiveDownload.ts).
// Contract source: nhentai API v2 OpenAPI spec — POST
// /api/v2/galleries/{id}/download requires an API key, takes format=zip|cbz,
// and returns DownloadResponse { url: string, expires_at: number }.
// The endpoint is opportunistic: every failure mode must yield null so the
// caller falls back to page-by-page downloading.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const archive = require('../build/test/background/ArchiveDownload.js');

describe('server archive user-facing safety notes', () => {
    it('warns that the experimental archive can be invalid and silently falls back', () => {
        const html = fs.readFileSync(path.join(__dirname, '../options.html'), 'utf8');
        assert.match(html, /Experimental — leave this off/);
        assert.match(html, /may save an invalid file/);
        assert.match(html, /falls back to pages without notifying you/);
        assert.doesNotMatch(html, /usually\s+faster|so nothing breaks/i);
    });

    it('does not claim every site button is a lower-quality copy', () => {
        const settings = fs.readFileSync(path.join(__dirname, '../src/preview/popupSettings.ts'), 'utf8');
        assert.match(settings, /Page-by-page downloads use the images supplied to the reader/);
        assert.match(settings, /site's own Download button is a separate control/);
        assert.doesNotMatch(settings, /lite, lower-resolution copy/);
    });
});

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

// Archive routing must never infer a privileged nhentai request from a bare
// legacy id or from another site's metadata. These fixtures are entirely
// synthetic; fetch is stubbed and no real account or archive is accessed.
describe('server archive source isolation', () => {
    const JSZip = require('jszip');
    const Downloader = require('../build/test/background/Downloader.js').default;
    const { clearnetSource } = require('../build/test/sources/GallerySource.js');
    const { StreamingZipWriter } = require('../build/test/utils/streamingZip.js');
    let oldFetch;
    let oldChrome;
    let oldFileReader;
    let calls;
    let saved;

    beforeEach(() => {
        oldFetch = globalThis.fetch;
        oldChrome = globalThis.chrome;
        oldFileReader = globalThis.FileReader;
        globalThis.FileReader = class {
            readAsArrayBuffer(blob) {
                blob.arrayBuffer().then(
                    (result) => { this.result = result; if (this.onload) this.onload(); },
                    (error) => { this.error = error; if (this.onerror) this.onerror(error); }
                );
            }
        };
        calls = [];
        saved = [];
        globalThis.chrome = { runtime: { getManifest: () => ({ version: 'test' }) } };
        globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), init: init || {} });
            if (String(url).includes('/api/v2/galleries/42/download')) {
                return new Response(JSON.stringify({
                    url: 'https://delivery.example/archive.zip',
                    expires_at: Math.floor(Date.now() / 1000) + 600
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (String(url).startsWith('https://delivery.example/')) {
                return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200 });
            }
            const page = new Uint8Array(2048);
            page.set([0xff, 0xd8, 0xff, 0xe0]);
            return new Response(page, { status: 200, headers: { 'content-type': 'image/jpeg' } });
        };
    });

    afterEach(() => {
        globalThis.fetch = oldFetch;
        if (oldChrome === undefined) delete globalThis.chrome;
        else globalThis.chrome = oldChrome;
        if (oldFileReader === undefined) delete globalThis.FileReader;
        else globalThis.FileReader = oldFileReader;
    });

    const gallery = (site, id = 42) => ({
        id, media_id: '987', site,
        title: { english: 'Fixture', japanese: '', pretty: 'Fixture' },
        images: { pages: [{ t: 'j' }] }, tags: []
    });
    const otherSource = (site) => Object.assign({}, clearnetSource, {
        site, getImageUrls: (_mediaId, file) => ['https://images.example/' + file]
    });
    const apiCalls = () => calls.filter((c) => c.url.includes('/api/v2/galleries/42/download'));

    async function run(galleryJson, source, extra = {}, zip = new JSZip()) {
        const settings = Object.assign({
            useZip: 'zip', maxConcurrentDownloads: 1, archiveLayout: 'flat',
            useServerArchive: true, apiKey: 'synthetic-test-key',
            archiveIdentity: { site: 'nhentai', id: '42' }
        }, extra);
        const d = new Downloader(galleryJson, 'Fixture', () => {}, () => {}, 'Fixture', zip, 'Fixture', null, source, settings);
        d.retryBackoffMs = 0;
        d.revokeObjectUrlDelayMs = 0;
        d.saveUrl = async (url, filename) => { saved.push({ url, filename }); };
        await d.startAsync();
    }

    it('uses the archive only for an independently identified nhentai gallery', async () => {
        await run(gallery('nhentai'), clearnetSource);
        assert.strictEqual(apiCalls().length, 1);
        assert.strictEqual(apiCalls()[0].init.headers.Authorization, 'Key synthetic-test-key');
        assert.strictEqual(saved[0].filename, 'Fixture.zip');
    });

    it('never sends another supported site with a colliding numeric id to nhentai', async () => {
        for (const site of ['hitomi', 'hentaiera', 'imhentai', 'hentaienvy', 'hentaifox']) {
            calls.length = 0;
            await run(gallery(site), otherSource(site));
            assert.strictEqual(apiCalls().length, 0, site + ' must not request an nhentai archive');
        }
    });

    it('rejects missing, unknown, conflicting, or untrusted source identity', async () => {
        const cases = [
            { json: gallery(undefined), source: clearnetSource, settings: {} },
            { json: gallery('unknown'), source: clearnetSource, settings: {} },
            { json: gallery('nhentai'), source: otherSource('hitomi'), settings: {} },
            { json: gallery('nhentai'), source: clearnetSource, settings: { archiveIdentity: null } },
            { json: gallery('nhentai'), source: clearnetSource, settings: { archiveIdentity: { site: 'hitomi', id: '42' } } },
            { json: gallery('nhentai'), source: clearnetSource, settings: { archiveIdentity: { site: 'nhentai', id: '99' } } }
        ];
        for (const item of cases) {
            calls.length = 0;
            await run(item.json, item.source, item.settings);
            assert.strictEqual(apiCalls().length, 0, 'ambiguous or conflicting identity must fail closed');
        }
    });

    it('does not substitute a server archive for a merged/nested output', async () => {
        await run(gallery('nhentai'), clearnetSource, { archiveLayout: 'nested' }, new StreamingZipWriter());
        assert.strictEqual(apiCalls().length, 0);
        assert.ok(calls.some((call) => call.url.includes('/galleries/987/1.jpg')));
    });

    it('fails closed when the archive writer cannot be inspected', async () => {
        const inner = new JSZip();
        const zip = {
            get files() { throw new Error('cannot inspect'); },
            file: inner.file.bind(inner),
            folder: inner.folder.bind(inner),
            generateAsync: inner.generateAsync.bind(inner)
        };
        await run(gallery('nhentai'), clearnetSource, {}, zip);
        assert.strictEqual(apiCalls().length, 0);
    });
});

describe('server archive job provenance', () => {
    const identity = require('../build/test/utils/archiveIdentity.js');
    let previousUrl;
    beforeEach(() => {
        // Other Downloader tests intentionally remove the global object-URL
        // API; provide the real URL parser independently of suite order.
        previousUrl = globalThis.URL;
        globalThis.URL = require('url').URL;
    });
    afterEach(() => {
        if (previousUrl === undefined) delete globalThis.URL;
        else globalThis.URL = previousUrl;
    });

    it('only accepts canonical positive safe integer gallery ids', () => {
        for (const id of [0, -1, 1.5, '01', '', '42/7', 'nhentai:42', '9007199254740992', {}, null, undefined]) {
            assert.strictEqual(identity.archiveGalleryId(id), null, 'reject ' + String(id));
        }
        assert.strictEqual(identity.archiveGalleryId(42), '42');
        assert.strictEqual(identity.archiveGalleryId('42'), '42');
    });

    it('derives single-title identity only from a canonical HTTPS gallery URL', () => {
        assert.deepStrictEqual(identity.archiveIdentityFromGalleryUrl('https://nhentai.net/g/42/1/?x=1'), { site: 'nhentai', id: '42' });
        for (const url of [
            '', 'http://nhentai.net/g/42/', 'https://nhentai.net.evil.example/g/42/',
            'https://nhentai.net@evil.example/g/42/', 'https://user@nhentai.net/g/42/',
            'https://nhentai.net:8443/g/42/', 'https://other.example/g/42/',
            'https://nhentai.net/g/042/', 'https://nhentai.net/g/abc/', 'https://nhentai.net/search/'
        ]) {
            assert.strictEqual(identity.archiveIdentityFromGalleryUrl(url), null, 'reject ' + url);
        }
    });

    it('accepts an explicit site or site-qualified key, never a bare legacy id', () => {
        const expected = { site: 'nhentai', id: '42' };
        assert.deepStrictEqual(identity.archiveIdentityFromBatchKey('42', 'nhentai'), expected);
        assert.deepStrictEqual(identity.archiveIdentityFromBatchKey('nhentai:42'), expected);
        for (const [key, site] of [
            ['42', undefined], ['42', 'hitomi'], ['hitomi:42', undefined],
            ['hitomi:42', 'nhentai'], ['nhentai:42', 'hitomi'], ['nhentai:042', 'nhentai'],
            ['nhentai:42:other', 'nhentai'], ['42', 'other:nhentai']
        ]) {
            assert.strictEqual(identity.archiveIdentityFromBatchKey(key, site), null, key + '/' + site);
        }
    });

    it('refuses invalid ids before making an authenticated request', async () => {
        let calls = 0;
        for (const id of ['42/other', 'nhentai:42', 0, '042', 1.5]) {
            const result = await archive.requestArchiveDownloadUrl(id, 'zip', 'synthetic-key', {
                fetchImpl: () => { calls++; throw new Error('must not call'); }
            });
            assert.strictEqual(result, null);
        }
        assert.strictEqual(calls, 0);
    });
});
