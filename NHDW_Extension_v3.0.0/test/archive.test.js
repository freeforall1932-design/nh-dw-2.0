// Offline-only tests for the experimental, authenticated API archive route.
// Synthetic payloads do not establish the real delivery hosts, full image
// decodability, completeness, native button behavior, or live completion.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { URL: NodeURL } = require('node:url');
const archive = require('../build/test/background/ArchiveDownload.js');

describe('Chromium experimental archive', () => {
// Other suites deliberately remove global URL. Supply the parser without
// supplying object-URL methods, independent of test order.
let previousGlobalUrl;
beforeEach(() => {
    previousGlobalUrl = globalThis.URL;
    globalThis.URL = function ParseOnlyURL(input, base) { return new NodeURL(input, base); };
});
afterEach(() => {
    if (previousGlobalUrl === undefined) delete globalThis.URL;
    else globalThis.URL = previousGlobalUrl;
});

const signedUrl = 'https://cdn.nhentai.net/synthetic/archive.zip?signature=fixture-secret';
const future = () => Math.floor(Date.now() / 1000) + 600;
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
async function makeZip(entries = [['001.jpg', jpg]]) {
    const zip = new JSZip();
    for (const [name, bytes, options] of entries) zip.file(name, bytes, options || {});
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' });
}
function jsonResponse(status, body, headers) {
    const map = Object.assign({}, headers || {});
    return {
        status, ok: status >= 200 && status < 300,
        headers: { get: (name) => map[String(name).toLowerCase()] || null },
        json: () => body === '__invalid__' ? Promise.reject(new Error('bad json')) : Promise.resolve(body)
    };
}

describe('server archive user-facing safety notes', () => {
    it('warns to leave the unverified API route off and reports eligible-job failures', () => {
        const html = fs.readFileSync(path.join(__dirname, '../options.html'), 'utf8');
        assert.match(html, /Experimental — leave this off/);
        assert.match(html, /not live-verified/);
        assert.match(html, /failures are reported rather than silently falling back/);
        assert.match(html, /website's\s+own Download button is separate/);
        assert.doesNotMatch(html, /usually\s+faster|so nothing breaks/i);
    });
    it('does not claim every site button is a lower-quality copy', () => {
        const settings = fs.readFileSync(path.join(__dirname, '../src/preview/popupSettings.ts'), 'utf8');
        assert.match(settings, /Page-by-page downloads use the images supplied to the reader/);
        assert.match(settings, /site's own Download button is a separate control/);
        assert.doesNotMatch(settings, /lite, lower-resolution copy/);
    });
});

describe('server archive endpoint client', () => {
    it('builds the documented request URL with the format query parameter', () => {
        assert.strictEqual(archive.getArchiveRequestUrl(674496, 'zip'), 'https://nhentai.net/api/v2/galleries/674496/download?format=zip');
        assert.strictEqual(archive.getArchiveRequestUrl('674496', 'cbz'), 'https://nhentai.net/api/v2/galleries/674496/download?format=cbz');
    });
    it('requires an API key and never calls the endpoint keyless', async () => {
        let calls = 0;
        const result = await archive.requestArchiveDownloadUrl(674496, 'zip', null, {
            fetchImpl: () => { calls++; return Promise.resolve(jsonResponse(200, {})); }
        });
        assert.strictEqual(result, null);
        assert.strictEqual(calls, 0);
    });
    it('POSTs with the key, does not follow redirects, and parses the documented response', async () => {
        const calls = [];
        const expiry = future();
        const result = await archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
            fetchImpl: (url, init) => { calls.push({ url, init }); return Promise.resolve(jsonResponse(200, { url: signedUrl, expires_at: expiry })); }
        });
        assert.deepStrictEqual(result, { url: signedUrl, expiresAt: expiry });
        assert.strictEqual(calls[0].init.method, 'POST');
        assert.strictEqual(calls[0].init.redirect, 'error');
        assert.strictEqual(calls[0].init.headers.Authorization, 'Key abc');
    });
    it('reports auth, disabled feature and rate limit errors instead of returning a fallback', async () => {
        for (const status of [401, 403, 503, 429]) {
            await assert.rejects(archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
                fetchImpl: () => Promise.resolve(jsonResponse(status, {}, { 'retry-after': '120' })), maxRetries: 0
            }), status === 429 ? /rate limited.*120 seconds/ : /rejected or unavailable/);
        }
    });
    it('rejects malformed JSON and unsafe or unrecognized delivery URLs', async () => {
        const values = ['', 'http://nhentai.net/a', 'https://nhentai.net.evil.test/a',
            'https://nhentai.net@evil.test/a', 'https://user@nhentai.net/a', 'https://nhentai.net:8443/a',
            'https://127.0.0.1/a', 'https://cdn.nhentai.net/a#secret', 'https://unknown.example/a', 'javascript:alert(1)'];
        for (const value of values) {
            assert.strictEqual(archive.isAllowedArchiveDeliveryUrl(value), false, value);
            await assert.rejects(archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
                fetchImpl: () => Promise.resolve(jsonResponse(200, { url: value, expires_at: future() }))
            }), /delivery URL/);
        }
        assert.strictEqual(archive.isAllowedArchiveDeliveryUrl(signedUrl), true);
        assert.strictEqual(archive.isAllowedArchiveDeliveryUrl('https://nhentai.net/a'), true);
        await assert.rejects(archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
            fetchImpl: () => Promise.resolve(jsonResponse(200, '__invalid__'))
        }), /not valid JSON/);
    });
    it('requires a present, future, plausible Unix-seconds expiry', async () => {
        for (const expires_at of [undefined, null, '123', 0, future() - 10000, Date.now(), Number.MAX_SAFE_INTEGER]) {
            await assert.rejects(archive.requestArchiveDownloadUrl(674496, 'zip', 'abc', {
                fetchImpl: () => Promise.resolve(jsonResponse(200, { url: signedUrl, expires_at }))
            }), /expiry/);
        }
    });
    it('sanitizes request errors rather than exposing credentials or signed URLs', async () => {
        const error = await archive.requestArchiveDownloadUrl(674496, 'zip', 'fixture-key', {
            fetchImpl: () => Promise.reject(new Error('fixture-key ' + signedUrl))
        }).catch(err => err);
        assert.match(error.message, /network error/);
        assert.doesNotMatch(error.message, /fixture-key|fixture-secret|signature=/);
    });
});

describe('server archive delivery validation', () => {
    it('preserves valid ZIP bytes without credentials, redirects, cookies or referrers', async () => {
        const input = await makeZip([['001.jpg', jpg], ['ComicInfo.xml', '<ComicInfo/>']]);
        const calls = [];
        const blob = await archive.fetchArchiveBytes(signedUrl, {
            fetchImpl: (url, init) => { calls.push({ url, init }); return Promise.resolve(new Response(input, { status: 200, headers: { 'content-type': 'application/zip' } })); }
        });
        assert.deepStrictEqual(Buffer.from(await blob.arrayBuffer()), input);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].init.headers.Authorization, undefined);
        assert.strictEqual(calls[0].init.credentials, 'omit');
        assert.strictEqual(calls[0].init.redirect, 'error');
        assert.strictEqual(calls[0].init.referrerPolicy, 'no-referrer');
    });
    it('rejects unsafe URL before any fetch, and sanitizes transfer errors', async () => {
        let calls = 0;
        await assert.rejects(archive.fetchArchiveBytes('https://evil.test/a?signature=fixture-secret', {
            fetchImpl: () => { calls++; }
        }), /allowed HTTPS hosts/);
        assert.strictEqual(calls, 0);
        const error = await archive.fetchArchiveBytes(signedUrl, {
            fetchImpl: () => Promise.reject(new Error('redirect ' + signedUrl))
        }).catch(err => err);
        assert.match(error.message, /blocked redirect/);
        assert.doesNotMatch(error.message, /fixture-secret|signature=/);
    });
    it('propagates a delivery 429 as a rate limit without retrying or leaking the URL', async () => {
        let calls = 0;
        const error = await archive.fetchArchiveBytes(signedUrl, { fetchImpl: () => {
            calls++;
            return Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
        } }).catch(err => err);
        assert.strictEqual(error.name, 'NhentaiRateLimitError');
        assert.strictEqual(error.waitMs, 120000);
        assert.doesNotMatch(error.message, /fixture-secret|signature=/);
        assert.strictEqual(calls, 1);
    });
    it('rejects HTTP errors, redirects, HTML, fake PK bytes, truncation and mislabeled image contents', async () => {
        const input = await makeZip();
        const cases = [
            new Response('denied', { status: 403 }),
            Object.assign(jsonResponse(200, {}), { redirected: true }),
            new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
            new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'application/zip' } }),
            new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200 }),
            new Response(input.subarray(0, input.length - 10), { status: 200 }),
            new Response(await makeZip([['001.jpg', '<html>not an image</html>']]), { status: 200 })
        ];
        for (const response of cases) {
            await assert.rejects(archive.fetchArchiveBytes(signedUrl, { fetchImpl: () => Promise.resolve(response) }), /archive/i);
        }
    });
    it('rejects corrupt CRCs, missing images, traversal, duplicate names and unsupported entries', async () => {
        const bytes = await makeZip();
        const corrupt = Buffer.from(bytes);
        const imageOffset = corrupt.indexOf(Buffer.from(jpg));
        assert.ok(imageOffset >= 0);
        corrupt[imageOffset + 4] ^= 1;
        const duplicate = await makeZip([['001.jpg', jpg], ['002.jpg', jpg]]);
        for (let i = duplicate.indexOf('002.jpg'); i >= 0; i = duplicate.indexOf('002.jpg', i + 7)) duplicate.write('001.jpg', i);
        const cases = [corrupt, await makeZip([['info.xml', '<Info/>']]),
            await makeZip([['../001.jpg', jpg]]), duplicate,
            await makeZip([['001.jpg', jpg], ['payload.exe', 'bad']]),
            await makeZip([['001.jpg', jpg, { unixPermissions: 0o120777 }]])];
        for (const input of cases) {
            await assert.rejects(archive.fetchArchiveBytes(signedUrl, { fetchImpl: () => Promise.resolve(new Response(input, { status: 200 })) }), /invalid|corrupt|unsupported/);
        }
    });
    it('requires the expected image count when gallery metadata provides one', async () => {
        const input = await makeZip([['001.jpg', jpg], ['ComicInfo.xml', '<ComicInfo/>']]);
        const fetchImpl = () => Promise.resolve(new Response(input, { status: 200 }));
        assert.ok(await archive.fetchArchiveBytes(signedUrl, { fetchImpl, expectedImageCount: 1 }));
        await assert.rejects(archive.fetchArchiveBytes(signedUrl, { fetchImpl, expectedImageCount: 2 }), /invalid|corrupt/);
        await assert.rejects(archive.fetchArchiveBytes(signedUrl, { fetchImpl, expectedImageCount: 0 }), /page count/);
    });
    it('enforces transfer, expansion, entry and entry-count bounds', async () => {
        const input = await makeZip([['001.jpg', jpg], ['metadata.txt', 'x'.repeat(200)]]);
        for (const limits of [{ maxBytes: input.length - 1 }, { maxExpandedBytes: 50 }, { maxEntryBytes: 50 }, { maxEntries: 1 }]) {
            await assert.rejects(archive.fetchArchiveBytes(signedUrl, {
                fetchImpl: () => Promise.resolve(new Response(input, { status: 200 })), limits
            }), /archive/i);
        }
        await assert.rejects(archive.fetchArchiveBytes(signedUrl, {
            fetchImpl: () => Promise.resolve(new Response(input, { status: 200, headers: { 'content-length': '999999' } })), limits: { maxBytes: 1000 }
        }), /transfer size limit/);
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

    beforeEach(async () => {
        oldFetch = globalThis.fetch;
        oldChrome = globalThis.chrome;
        oldFileReader = globalThis.FileReader;
        const validZip = await makeZip();
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
                    url: 'https://cdn.nhentai.net/archive.zip?signature=synthetic',
                    expires_at: Math.floor(Date.now() / 1000) + 600
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (String(url).startsWith('https://cdn.nhentai.net/archive.zip')) {
                return new Response(validZip, { status: 200 });
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
        d.saveUrl = async (url, filename, requireCompletion) => { saved.push({ url, filename, requireCompletion }); };
        await d.startAsync();
    }

    it('uses the archive only for an independently identified nhentai gallery', async () => {
        await run(gallery('nhentai'), clearnetSource);
        assert.strictEqual(apiCalls().length, 1);
        assert.strictEqual(apiCalls()[0].init.headers.Authorization, 'Key synthetic-test-key');
        assert.strictEqual(saved[0].filename, 'Fixture.zip');
        assert.strictEqual(saved[0].requireCompletion, true);
    });

    it('surfaces rate limits and invalid archives without a silent page fallback', async () => {
        for (const failure of ['rate-limit', 'invalid-archive', 'missing-key']) {
            calls.length = 0;
            saved.length = 0;
            globalThis.fetch = async (url, init) => {
                calls.push({ url: String(url), init: init || {} });
                if (String(url).includes('/api/v2/galleries/42/download')) {
                    if (failure === 'rate-limit') return new Response('', { status: 429, headers: { 'retry-after': '120' } });
                    return new Response(JSON.stringify({ url: signedUrl, expires_at: future() }), { status: 200 });
                }
                if (String(url) === signedUrl) return new Response('<html>challenge</html>', { status: 200 });
                throw new Error('unexpected page fetch');
            };
            await assert.rejects(run(gallery('nhentai'), clearnetSource, failure === 'missing-key' ? { apiKey: null } : {}),
                failure === 'rate-limit' ? /rate limited.*120 seconds/ : (failure === 'missing-key' ? /needs an API key/ : /invalid|corrupt|unexpected content type/));
            assert.strictEqual(apiCalls().length, failure === 'missing-key' ? 0 : 1);
            assert.ok(!calls.some(call => call.url.includes('/galleries/987/')), 'no page fallback');
            assert.strictEqual(saved.length, 0, 'invalid archive must not be saved');
        }
    });

    it('requires valid page metadata before requesting a server archive', async () => {
        for (const pages of [[], [{ t: '0' }]]) {
            calls.length = 0;
            await assert.rejects(run({ ...gallery('nhentai'), images: { pages } }, clearnetSource), /page (count|metadata)/);
            assert.strictEqual(apiCalls().length, 0);
        }
    });

    it('does not retry an immediately-expiring archive URL', async () => {
        calls.length = 0;
        globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), init: init || {} });
            return new Response(JSON.stringify({ url: signedUrl, expires_at: Math.floor(Date.now() / 1000) + 5 }), { status: 200 });
        };
        await assert.rejects(run(gallery('nhentai'), clearnetSource), /expires too soon/);
        assert.strictEqual(calls.length, 1);
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

}); // Chromium experimental archive
