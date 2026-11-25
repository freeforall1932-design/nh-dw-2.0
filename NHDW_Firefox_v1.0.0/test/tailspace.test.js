// Tailspace as a built-in site: slug ids, page data -> gallery record (from
// `.data` and from the server-rendered HTML), the adapter's URLs, the series
// walk, paste/bookmark acceptance, and the real download path (batch pipeline
// + Downloader) on fixtures made by the official turbo-stream encoder
// (test/fixtures/tailspace/generate.js; synthetic data). No network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const ids = require('../build/test/utils/tailspaceIds.js');
const data = require('../build/test/parsing/tailspaceData.js');
const { tailspaceSource } = require('../build/test/sources/tailspaceSource.js');
const { getSourceForUrl, getSourceForSite } = require('../build/test/sources/index.js');
const { isGalleryIdForSite, toGalleryKey, splitGalleryKey } = require('../build/test/utils/siteKeys.js');
const bookmarks = require('../build/test/utils/bookmarkQueue.js');
const { resolveGalleryMetadata, runBatchDownload } = require('../build/test/utils/batchPipeline.js');
const Downloader = require('../build/test/background/Downloader.js').default;
const { decodeTurboStream, routerStreamFromHtml } = require('../build/test/utils/turboStream.js');

const FIX = path.join(__dirname, 'fixtures', 'tailspace');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const ROUTE_Q = '?_routes=routes%2Fpages%2Fcomic%2FComicPage';

// Other suites deliberately remove global URL (the Downloader's data-URL
// branch). Supply the parser for this file and put back whatever was there.
const NodeURL = require('url').URL;
function useNodeUrl() {
    let previousGlobalUrl;
    beforeEach(() => {
        previousGlobalUrl = globalThis.URL;
        globalThis.URL = NodeURL;
    });
    afterEach(() => {
        if (previousGlobalUrl === undefined) delete globalThis.URL;
        else globalThis.URL = previousGlobalUrl;
    });
}

describe('Tailspace ids (slug as one encoded path segment)', () => {
    useNodeUrl();
    it('reads the id from comic URLs, ignoring the reader position', () => {
        for (const url of [
            'https://tailspace.com/c/Scale%20Train',
            'https://tailspace.com/c/Scale%20Train?page=3',
            'https://tailspace.com/c/Scale%20Train/',
            'https://www.tailspace.com/c/Scale%20Train#top'
        ]) {
            assert.strictEqual(ids.tailspaceIdFromUrl(url), 'Scale%20Train', url);
        }
        // A different but equivalent spelling of the same slug is canonicalised.
        assert.strictEqual(ids.tailspaceIdFromUrl('https://tailspace.com/c/Scale Train'), 'Scale%20Train');
    });

    it('refuses everything that is not one https comic page', () => {
        for (const url of [
            'http://tailspace.com/c/Scale%20Train', 'https://tailspace.com/', 'https://tailspace.com/browse',
            'https://tailspace.com/c/', 'https://tailspace.com/c/a/b', 'https://tailspace.com/c/%E0%A4%A',
            'https://evil.example/c/Scale%20Train', 'https://tailspace.com.evil.example/c/x',
            'https://user:pw@tailspace.com/c/x', 'https://tailspace.com:8443/c/x', 'not a url'
        ]) {
            assert.strictEqual(ids.tailspaceIdFromUrl(url), null, url);
        }
    });

    it('keeps the composite-key contract: no ":" or whitespace, one canonical form', () => {
        const id = ids.tailspaceIdFromSlug('Tom & Jerry: <Part 1>');
        assert.strictEqual(id, 'Tom%20%26%20Jerry%3A%20%3CPart%201%3E');
        assert.ok(!/[:\s,;|]/.test(id));
        assert.strictEqual(ids.tailspaceSlugFromId(id), 'Tom & Jerry: <Part 1>');
        const key = toGalleryKey(id, 'tailspace');
        assert.deepStrictEqual(splitGalleryKey(key), { site: 'tailspace', id: id });
        for (const bad of ['Scale Train', 'a:b', 'Scale%20train%2', '%2Fetc', '', 'x'.repeat(1300)]) {
            assert.strictEqual(ids.isTailspaceId(bad), false, bad);
        }
        // Non-canonical spelling of a valid slug is refused (one slug, one key).
        assert.strictEqual(ids.isTailspaceId('Scale%20Tr%61in'), false);
    });

    it('accepts slug ids for tailspace only; numeric ids everywhere', () => {
        assert.strictEqual(isGalleryIdForSite('tailspace', 'Scale%20Train'), true);
        assert.strictEqual(isGalleryIdForSite('nhentai', 'Scale%20Train'), false);
        assert.strictEqual(isGalleryIdForSite('hitomi', 'Scale%20Train'), false);
        assert.strictEqual(isGalleryIdForSite('nhentai', '123'), true);
        assert.strictEqual(isGalleryIdForSite('tailspace', 'tailspace:Scale%20Train'), false);
    });
});

describe('Tailspace page data -> gallery record', () => {
    useNodeUrl();
    it('builds the gallery from .data: canonical id, numeric media id, ordered pages, tags, series links', () => {
        const gallery = tailspaceSource.extractGallery(fixture('comic-101.data'));
        assert.strictEqual(gallery.id, 'Scale%20Train');
        assert.strictEqual(gallery.media_id, '101');
        assert.strictEqual(gallery.site, 'tailspace');
        assert.strictEqual(gallery.title.pretty, 'Scale Train - Chapter 1');
        // Unsorted in the data; the site's pageNumber decides. Missing fileType = jpg.
        assert.deepStrictEqual(gallery.images.pages.map((p) => [p.hash, p.t]), [['a1', 'j'], ['b2', 'p'], ['c3', 'w']]);
        assert.strictEqual(gallery.num_pages, 3);
        assert.deepStrictEqual(gallery.tags, [
            { type: 'artist', name: 'Fixture Artist' },
            { type: 'tag', name: 'dragon' },
            { type: 'tag', name: 'train' }
        ]);
        assert.deepStrictEqual(gallery.tailspace, { slug: 'Scale Train', previous: null, next: 'Scale%20Train%202', statedPages: 3 });
        assert.strictEqual(data.tailspacePageCountNote(gallery), '');
    });

    it('reads the same record from the comic page HTML (react-router SSR stream, split chunks)', () => {
        const html = fixture('comic-101.html');
        assert.strictEqual(routerStreamFromHtml(html), fixture('comic-101.data'), 'chunks are unescaped and joined exactly');
        assert.deepStrictEqual(tailspaceSource.extractGallery(html), tailspaceSource.extractGallery(fixture('comic-101.data')));
        assert.ok(!JSON.stringify(tailspaceSource.extractGallery(html)).includes('-mini'), 'thumbnails in the markup are never used');
    });

    it('keeps a "jpeg" extension exact and survives titles that need escaping', () => {
        const gallery = tailspaceSource.extractGallery(fixture('comic-104.data'));
        assert.strictEqual(gallery.id, 'Tom%20%26%20Jerry%3A%20%3CPart%201%3E');
        assert.deepStrictEqual(gallery.images.pages.map((p) => [p.hash, p.t]), [['g7.jpeg', 'j'], ['h8', 'g']]);
        assert.deepStrictEqual(tailspaceSource.getImageUrls('104', 'g7.jpeg.jpg'), ['https://pics.tailspace.com/comics/104/g7.jpeg']);
        assert.deepStrictEqual(tailspaceSource.getImageUrls('104', 'h8.gif'), ['https://pics.tailspace.com/comics/104/h8.gif']);
    });

    it('flags a comic whose listed pages disagree with its stated total', () => {
        const gallery = tailspaceSource.extractGallery(fixture('comic-103.data'));
        assert.strictEqual(gallery.images.pages.length, 2);
        assert.strictEqual(data.tailspacePageCountNote(gallery),
            'The site says this comic has 3 pages but its page data lists 2. The download will contain the 2 listed pages.');
    });

    it('explains every failure in words instead of returning a bare null', () => {
        assert.strictEqual(tailspaceSource.extractGallery(fixture('comic-missing.data')), null);
        assert.strictEqual(tailspaceSource.explainExtractFailure(fixture('comic-missing.data')), 'the site says this comic does not exist');
        assert.match(tailspaceSource.explainExtractFailure('<!DOCTYPE html><html><body>Just a moment...</body></html>'), /web page that carries no comic data/);
        assert.match(tailspaceSource.explainExtractFailure('{"error":"nope"}'), /not Tailspace page data/);
        assert.match(tailspaceSource.explainExtractFailure('[1,2'), /could not be decoded \(not turbo-stream text\)/);
        assert.match(tailspaceSource.explainExtractFailure(fixture('generic-reader.data')), /has no comic in it/);
        assert.strictEqual(tailspaceSource.explainExtractFailure(fixture('comic-101.data')), '');
    });

    it('rejects the whole comic when one page entry is malformed (no silent gaps)', () => {
        const comic = (pages) => ({ id: 5, slug: 'X', name: 'X', pages });
        assert.strictEqual(data.tailspacePageList(comic([{ token: 'a', pageNumber: 1 }, { token: '../x', pageNumber: 2 }])), null);
        assert.strictEqual(data.tailspacePageList(comic([{ token: 'a', pageNumber: 1, fileType: 'svg' }])), null);
        assert.strictEqual(data.tailspacePageList(comic([{ token: 'a' }])), null);
        assert.strictEqual(data.tailspacePageList(comic([])), null);
        assert.strictEqual(data.tailspacePageList(comic(Array.from({ length: 501 }, (_, i) => ({ token: 't' + i, pageNumber: i })))), null);
        assert.deepStrictEqual(data.tailspacePageList(comic([{ token: 'b', pageNumber: 2 }, { token: 'a', pageNumber: 1, fileType: 'PNG' }])),
            [{ token: 'a', type: 'png', pageNumber: 1 }, { token: 'b', type: 'jpg', pageNumber: 2 }]);
    });

    it('decoding stays prototype-free', () => {
        const decoded = decodeTurboStream('[{"_1":2},"__proto__",{"_3":4},"polluted",true]');
        assert.strictEqual({}.polluted, undefined);
        assert.strictEqual(Object.getPrototypeOf(decoded), null);
    });
});

describe('Tailspace adapter', () => {
    useNodeUrl();
    it('is registered and picked by URL and by site', () => {
        assert.strictEqual(getSourceForUrl('https://tailspace.com/c/Scale%20Train'), tailspaceSource);
        assert.strictEqual(getSourceForUrl('https://tailspace.com/browse'), tailspaceSource);
        assert.strictEqual(getSourceForSite('tailspace'), tailspaceSource);
        assert.strictEqual(getSourceForUrl('https://nottailspace.com/c/x'), null);
        assert.strictEqual(tailspaceSource.getGalleryId('https://tailspace.com/browse'), null);
    });

    it('builds the comic and page-data URLs from the id', () => {
        assert.strictEqual(tailspaceSource.getGalleryUrl('Scale%20Train'), 'https://tailspace.com/c/Scale%20Train');
        assert.strictEqual(tailspaceSource.getMetadataUrl('Scale%20Train'), 'https://tailspace.com/c/Scale%20Train.data' + ROUTE_Q);
    });

    it('builds full-size image URLs only for well-formed input, inside its own allowed shape', () => {
        const url = tailspaceSource.getImageUrls('101', 'a1.jpg')[0];
        assert.strictEqual(url, 'https://pics.tailspace.com/comics/101/a1.jpg');
        const parsed = new NodeURL(url);
        assert.ok(tailspaceSource.getImageHosts().includes(parsed.hostname));
        assert.ok(tailspaceSource.getAllowedPathRegex().test(parsed.pathname));
        for (const [mediaId, file] of [['0', 'a1.jpg'], ['abc', 'a1.jpg'], ['101', '../a1.jpg'], ['101', 'a1.svg'], ['101', ''], ['101', 'a1']]) {
            assert.deepStrictEqual(tailspaceSource.getImageUrls(mediaId, file), [], mediaId + ' ' + file);
        }
        assert.ok(!tailspaceSource.getAllowedPathRegex().test('/comics/101/thumbnail-2x.webp?v=2'));
    });

    it('asks for the Referer the site itself sends, on its image host only, with no Origin', () => {
        assert.deepStrictEqual(tailspaceSource.getImageRequestContext(),
            { domains: ['pics.tailspace.com'], referer: 'https://tailspace.com/', origin: '' });
        assert.strictEqual(tailspaceSource.fetchImagesThroughTab(), true);
        assert.strictEqual(tailspaceSource.getTabSiteHost(), 'tailspace.com');
    });
});

describe('Tailspace series walk', () => {
    useNodeUrl();
    const byId = {
        'Scale%20Train': tailspaceSource.extractGallery(fixture('comic-101.data')),
        'Scale%20Train%202': tailspaceSource.extractGallery(fixture('comic-102.data')),
        'Scale%20Train%203': tailspaceSource.extractGallery(fixture('comic-103.data'))
    };

    it('lists every linked part oldest first from any part, one read per part', async () => {
        const reads = [];
        const progress = [];
        const series = await data.walkTailspaceSeries(byId['Scale%20Train%202'], async (id) => { reads.push(id); return byId[id]; }, (n) => progress.push(n));
        assert.deepStrictEqual(series.parts.map((p) => p.id), ['Scale%20Train', 'Scale%20Train%202', 'Scale%20Train%203']);
        assert.deepStrictEqual(reads, ['Scale%20Train', 'Scale%20Train%203']);
        assert.deepStrictEqual(progress, [2, 3]);
        assert.strictEqual(series.broken, false);
        assert.strictEqual(series.truncated, false);
    });

    it('reports an unreadable part with its reason and keeps what it found', async () => {
        const series = await data.walkTailspaceSeries(byId['Scale%20Train%202'], async (id) =>
            id === 'Scale%20Train%203' ? new Error('HTTP 503 Service Unavailable') : byId[id]);
        assert.deepStrictEqual(series.parts.map((p) => p.id), ['Scale%20Train', 'Scale%20Train%202']);
        assert.strictEqual(series.broken, true);
        assert.strictEqual(series.brokenReason, 'The linked part "Scale Train 3" could not be read (HTTP 503 Service Unavailable).');
        const thrown = await data.walkTailspaceSeries(byId['Scale%20Train'], async () => { throw new Error('Failed to fetch'); });
        assert.match(thrown.brokenReason, /\(Failed to fetch\)/);
    });

    it('is loop-safe and capped', async () => {
        const loop = JSON.parse(JSON.stringify(byId['Scale%20Train%202']));
        loop.tailspace.previous = null;
        loop.tailspace.next = 'Scale%20Train%202';
        const looped = await data.walkTailspaceSeries(loop, async () => { throw new Error('must not read itself'); });
        assert.deepStrictEqual(looped.parts.map((p) => p.id), ['Scale%20Train%202'], 'a self-link is never re-read');
        assert.strictEqual(looped.broken, false);
        // A cycle 1 -> 2 -> 1 (part 2 names part 1 as next) stops at the repeat.
        const two = JSON.parse(JSON.stringify(byId['Scale%20Train%202']));
        two.tailspace.next = 'Scale%20Train';
        const cycle = await data.walkTailspaceSeries(byId['Scale%20Train'], async (id) => (id === 'Scale%20Train%202' ? two : byId[id]));
        assert.deepStrictEqual(cycle.parts.map((p) => p.id), ['Scale%20Train', 'Scale%20Train%202']);
        let n = 0;
        const endless = (id) => ({ id, tailspace: { previous: null, next: 'p' + (++n) }, images: { pages: [{}] } });
        const capped = await data.walkTailspaceSeries(endless('p0'), async (id) => endless(id), undefined, 5);
        assert.strictEqual(capped.parts.length, 5);
        assert.strictEqual(capped.truncated, true);
    });
});

describe('Tailspace in the paste box and the bookmark list', () => {
    useNodeUrl();
    it('parses comic links and composite keys into tailspace keys', () => {
        const parsed = bookmarks.parseGalleryInput([
            'https://tailspace.com/c/Scale%20Train?page=2',
            'tailspace.com/c/Foo%20(Part%202)',
            '(https://tailspace.com/c/Bar)',
            'tailspace:Scale%20Train%202',
            'tailspace:not%20canonical%2',
            '177013'
        ].join('\n'));
        assert.deepStrictEqual(parsed.ids, [
            'tailspace:Scale%20Train', 'tailspace:Foo%20(Part%202)', 'tailspace:Bar', 'tailspace:Scale%20Train%202', '177013'
        ]);
        assert.deepStrictEqual(parsed.rejected, ['tailspace:not%20canonical%2']);
    });

    it('stores and reloads tailspace rows; refuses a slug id under another site', () => {
        const added = bookmarks.addBookmarks(bookmarks.emptyBookmarkState(), [
            { id: 'Scale%20Train', site: 'tailspace', title: 'Scale Train', source: 'page' },
            { id: 'Scale%20Train', site: 'nhentai', title: 'wrong site' },
            null
        ], 1000);
        assert.deepStrictEqual(added.added, ['Scale%20Train']);
        const reloaded = bookmarks.normalizeBookmarkState(JSON.parse(JSON.stringify(added.state)));
        assert.strictEqual(reloaded.items.length, 1);
        assert.strictEqual(reloaded.items[0].site, 'tailspace');
        assert.ok(bookmarks.findBookmark(reloaded, 'tailspace:Scale%20Train') !== null);
        assert.ok(bookmarks.bookmarkFilterSites().includes('tailspace'));
    });

    it('bookmarks pasted composite keys under their own site (they were silently dropped before)', () => {
        const parsed = bookmarks.parseGalleryInput('tailspace:Scale%20Train https://hitomi.la/galleries/123.html 177013 hentaifox:55');
        const items = parsed.ids.map((id) => ({ id: id, source: 'paste', sourceUrl: '' }));
        const added = bookmarks.addBookmarks(bookmarks.emptyBookmarkState(), items, 1);
        assert.deepStrictEqual(added.state.items.map((i) => [i.site, i.id]).sort(), [
            ['hentaifox', '55'], ['hitomi', '123'], ['nhentai', '177013'], ['tailspace', 'Scale%20Train']
        ]);
        // Re-pasting is recognised as a duplicate, not added twice.
        const again = bookmarks.addBookmarks(added.state, items, 2);
        assert.strictEqual(again.state.items.length, 4);
        assert.strictEqual(again.added.length, 0);
        // A key that contradicts an explicit site, an unknown site or a bad id is refused.
        const refused = bookmarks.addBookmarks(bookmarks.emptyBookmarkState(), [
            { id: 'tailspace:Scale%20Train', site: 'hitomi' },
            { id: 'madeup:123' },
            { id: 'tailspace:not canonical' },
            { id: 'hitomi:Scale%20Train' }
        ], 1);
        assert.strictEqual(refused.state.items.length, 0);
    });

    it('uses the site\'s own cover for a tailspace gallery', () => {
        const gallery = tailspaceSource.extractGallery(fixture('comic-101.data'));
        assert.strictEqual(bookmarks.thumbnailUrlFromGallery(gallery), 'https://pics.tailspace.com/comics/101/thumbnail-2x.webp');
    });
});

describe('Tailspace bookmark enrichment (worker, no tab needed)', () => {
    useNodeUrl();
    let store;
    let fetched;
    let service;
    beforeEach(() => {
        store = {};
        fetched = [];
        globalThis.chrome = {
            runtime: { lastError: null, sendMessage() {} },
            storage: { local: {
                get(defaults, cb) { const out = {}; for (const k of Object.keys(defaults)) out[k] = k in store ? JSON.parse(JSON.stringify(store[k])) : defaults[k]; cb(out); },
                set(patch, cb) { Object.assign(store, JSON.parse(JSON.stringify(patch))); if (cb) cb(); }
            } },
            tabs: { query(_q, cb) { cb([]); } }
        };
        const files = { 'Scale%20Train': 'comic-101.data', 'Scale%20Train%202': 'comic-102.data' };
        globalThis.fetch = async (url, init) => {
            fetched.push([String(url), init.credentials]);
            const slugId = /\/c\/([^.?]+)\.data/.exec(String(url))[1];
            // The site answering with another comic must not be written onto this row.
            const file = slugId === 'Wrong' ? 'comic-102.data' : files[slugId];
            return file ? { ok: true, status: 200, text: async () => fixture(file) } : { ok: false, status: 404, text: async () => '' };
        };
        service = require('../build/test/background/bookmarkService.js');
    });
    afterEach(() => { delete globalThis.chrome; delete globalThis.fetch; });

    it('fills in title, cover and page count straight from the site; never trusts another comic\'s answer', async function () {
        this.timeout(5000);
        const keys = ['tailspace:Scale%20Train', 'tailspace:Wrong', 'tailspace:Missing'];
        await bookmarks.mutateBookmarks((state) => bookmarks.addBookmarks(state, keys.map((id) => ({ id, source: 'paste' })), 1).state);
        const result = await service.enrichBookmarks(keys);
        assert.strictEqual(result.resolved, 1);
        assert.strictEqual(result.skipped, false, 'no nhentai tab is needed for tailspace rows');
        assert.deepStrictEqual(fetched.map((f) => f[1]), ['omit', 'omit', 'omit']);
        assert.strictEqual(fetched[0][0], 'https://tailspace.com/c/Scale%20Train.data' + ROUTE_Q);
        const row = bookmarks.findBookmark(result.state, 'tailspace:Scale%20Train');
        assert.strictEqual(row.title, 'Scale Train - Chapter 1');
        assert.strictEqual(row.thumbnail, 'https://pics.tailspace.com/comics/101/thumbnail-2x.webp');
        assert.strictEqual(row.pages, 3);
        assert.strictEqual(bookmarks.findBookmark(result.state, 'tailspace:Wrong').title, '');
    });

    it('still reports the missing nhentai tab for numeric ids in the same paste', async () => {
        const result = await service.enrichBookmarks(['tailspace:Scale%20Train', '177013']);
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.resolved, 1);
    });
});

function makeHost(overrides) {
    const messages = [];
    const downloads = [];
    const host = {
        parsing: { GetUrl: (id) => 'https://nhentai.net/api/gallery/' + id },
        aborted: false,
        getAbortSignal: () => null,
        wasAborted: () => false,
        messageExtras: () => ({}),
        sendMessage: (payload) => { messages.push(payload); },
        errorCallback: () => {},
        progressCallback: () => {},
        fetchUrlFromTab: async () => null,
        fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, text: async () => '' }),
        newZip: () => ({ files: {} }),
        downloadGallery: async (job) => { downloads.push(job); },
        messages: messages,
        downloads: downloads
    };
    return Object.assign(host, overrides || {});
}

function dataResponse(text, status = 200) {
    return { ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: { get: () => 'text/x-script' }, text: async () => text };
}

describe('Tailspace through the real download path', () => {
    useNodeUrl();
    it('resolves a pasted comic key through its page data (one request, exact URL)', async () => {
        const calls = [];
        const host = makeHost({ fetchImpl: async (url, init) => { calls.push([String(url), init.credentials, init.redirect]); return dataResponse(fixture('comic-101.data')); } });
        const result = await resolveGalleryMetadata('tailspace:Scale%20Train', { galleryMetadata: {}, apiKey: '', host: host, site: 'nhentai' });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.json.media_id, '101');
        assert.deepStrictEqual(calls, [['https://tailspace.com/c/Scale%20Train.data' + ROUTE_Q, 'omit', 'error']]);
    });

    it('falls back to the comic page HTML when the data route fails, and never accepts another comic', async () => {
        const host = makeHost({
            fetchImpl: async (url) => String(url).includes('.data')
                ? dataResponse('<html>blocked</html>', 403)
                : dataResponse(fixture('comic-101.html'))
        });
        const ok = await resolveGalleryMetadata('tailspace:Scale%20Train', { galleryMetadata: {}, apiKey: '', host: host });
        assert.strictEqual(ok.ok, true);
        assert.strictEqual(ok.json.images.pages.length, 3);
        // The page names comic 101, the request was for part 2: refused.
        const wrong = await resolveGalleryMetadata('tailspace:Scale%20Train%202', { galleryMetadata: {}, apiKey: '', host: host });
        assert.strictEqual(wrong.ok, false);
    });

    it('downloads a whole series as one file per part, oldest first, with tailspace history keys', async () => {
        const parts = ['comic-101.data', 'comic-102.data', 'comic-103.data'].map((f) => tailspaceSource.extractGallery(fixture(f)));
        const allDoujinshis = {};
        const galleryMetadata = {};
        for (const part of parts) { allDoujinshis[part.id] = part.title.pretty; galleryMetadata[part.id] = part; }
        const host = makeHost({ fetchImpl: async () => { throw new Error('metadata was supplied; no request expected'); } });
        const outcome = await runBatchDownload({
            zip: { files: {} }, allDoujinshis, finalName: 'Scale Train - series', downloadAtEnd: true, galleryMetadata,
            options: { site: 'tailspace', downloadSeparately: true, useZip: 'cbz' }, host
        });
        assert.deepStrictEqual(host.downloads.map((job) => job.json.media_id), ['101', '102', '103']);
        assert.deepStrictEqual(outcome.records.map((r) => r.id), ['tailspace:Scale%20Train', 'tailspace:Scale%20Train%202', 'tailspace:Scale%20Train%203']);
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.strictEqual(summary.succeeded, 3);
        assert.strictEqual(summary.failed, 0);
    });

    it('a part that cannot be read fails visibly in the batch summary with the site\'s answer', async () => {
        const host = makeHost({ fetchImpl: async () => dataResponse(fixture('comic-missing.data')) });
        await runBatchDownload({
            zip: { files: {} }, allDoujinshis: { 'Gone': 'Gone' }, finalName: 'x', downloadAtEnd: true,
            options: { site: 'tailspace', downloadSeparately: true }, host
        });
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.strictEqual(summary.failed, 1);
        assert.strictEqual(summary.failedGalleries[0].site, 'tailspace');
        assert.ok(summary.failedGalleries[0].error.length > 0, 'the failure carries a message');
    });

    describe('Downloader', () => {
        class FileReaderStub {
            readAsArrayBuffer(blob) {
                blob.arrayBuffer().then((buf) => { this.result = buf; if (this.onload) this.onload(); });
            }
        }
        const bytes = (...head) => { const b = new Uint8Array(2000); head.forEach((v, i) => { b[i] = v; }); return b; };
        let saved;
        beforeEach(() => {
            saved = [];
            globalThis.chrome = {
                storage: { sync: { get(defaults, cb) { cb(Object.assign({}, defaults, { useZip: 'zip', maxConcurrentDownloads: '3' })); } } },
                runtime: { lastError: null, sendMessage() {} },
                downloads: { download(opts, cb) { saved.push(opts); if (cb) cb(1); } }
            };
            globalThis.URL = undefined;
            globalThis.FileReader = FileReaderStub;
        });
        afterEach(() => { delete globalThis.chrome; delete globalThis.fetch; delete globalThis.FileReader; });

        it('fetches exactly the full-size pages from pics.tailspace.com and zips them in the site\'s order', async () => {
            const gallery = tailspaceSource.extractGallery(fixture('comic-101.data'));
            const attempted = [];
            const body = { 'a1.jpg': bytes(0xff, 0xd8, 0xff), 'b2.png': bytes(0x89, 0x50, 0x4e, 0x47), 'c3.webp': bytes(0x52, 0x49, 0x46, 0x46) };
            globalThis.fetch = (url) => {
                attempted.push(String(url));
                const name = String(url).split('/').pop();
                return Promise.resolve(new Response(body[name], { status: 200, headers: { 'Content-Type': 'image/' + name.split('.')[1].replace('jpg', 'jpeg') } }));
            };
            const downloader = new Downloader(gallery, 'Scale Train', () => {}, () => {}, 'Scale Train', new JSZip(), 'Scale Train');
            downloader.revokeObjectUrlDelayMs = 10;
            downloader.retryBackoffMs = 0;
            await downloader.startAsync();
            assert.deepStrictEqual(attempted.sort(), [
                'https://pics.tailspace.com/comics/101/a1.jpg',
                'https://pics.tailspace.com/comics/101/b2.png',
                'https://pics.tailspace.com/comics/101/c3.webp'
            ]);
            assert.strictEqual(saved.length, 1);
            const zip = await JSZip.loadAsync(Buffer.from(saved[0].url.split(',')[1], 'base64'));
            const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
            assert.deepStrictEqual(names, ['Scale Train/001.jpg', 'Scale Train/002.png', 'Scale Train/003.webp']);
            assert.deepStrictEqual(new Uint8Array(await zip.file('Scale Train/002.png').async('uint8array')), body['b2.png']);
        });

        it('reports a refused image with the server\'s status instead of saving anything', async () => {
            const gallery = tailspaceSource.extractGallery(fixture('comic-102.data'));
            globalThis.fetch = () => Promise.resolve(new Response('denied', { status: 403, statusText: 'Forbidden' }));
            let reported = '';
            const downloader = new Downloader(gallery, 'P2', (e) => { reported = String(e); }, () => {}, 'P2', new JSZip(), 'P2');
            downloader.retryBackoffMs = 0;
            await downloader.startAsync().catch(() => {});
            assert.match(reported, /403/);
            assert.match(reported, /Tailspace refused the page images/, 'the message names the site and what to do');
            assert.strictEqual(saved.length, 0);
        });
    });
});
