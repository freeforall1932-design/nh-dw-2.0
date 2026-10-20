// Item 72 — cross-mirror fallback chains (the mirror network's
// throttle routing). Pure-module tests for utils/mirrorFallback.ts
// and the adapter token-swap, plus Downloader integration cases
// (token host-swap, title-match switch, exhaustion honesty,
// setting-off) driven by the same fetch-stub harness as
// downloader.test.js. No network access.

const assert = require('assert');
const JSZip = require('jszip');
const Downloader = require('../build/test/background/Downloader.js').default;
const {
    MIRROR_FALLBACK_CHAINS,
    mirrorFallbackChainFor,
    MIRROR_STORE_HOSTS,
    sharedStoreImageUrls,
    buildMirrorSearchUrl,
    mirrorSearchQueryVariants,
    normalizeMirrorTitle,
    mirrorTitleScore,
    parseMirrorSearchResults,
    pickMirrorTitleMatch,
    MIRROR_TITLE_MATCH_THRESHOLD
} = require('../build/test/utils/mirrorFallback.js');
const { imhentaiSource } = require('../build/test/sources/imhentaiSource.js');
const { hentaienvySource } = require('../build/test/sources/hentaienvySource.js');
const { hentaieraSource } = require('../build/test/sources/hentaieraSource.js');
const { extractImhentaiGallery } = require('../build/test/parsing/imhentaiHtml.js');
const { extractHentaieraGallery } = require('../build/test/parsing/hentaieraHtml.js');
const { extractHentaienvyGallery } = require('../build/test/parsing/hentaienvyHtml.js');

// ---- chain table -------------------------------------------------------

describe('Mirror fallback chains (utils/mirrorFallback.ts)', () => {
    it('encodes the owner-recorded routing orders', () => {
        // imh -> envy (token swap) -> era (title match)
        assert.deepStrictEqual(mirrorFallbackChainFor('imhentai'), [
            { site: 'hentaienvy', mode: 'token' },
            { site: 'hentaiera', mode: 'title' }
        ]);
        // envy -> era (title) -> imh (token) — the owner's order
        assert.deepStrictEqual(mirrorFallbackChainFor('hentaienvy'), [
            { site: 'hentaiera', mode: 'title' },
            { site: 'imhentai', mode: 'token' }
        ]);
        // era -> envy -> imh, both by title (era's store is separate)
        assert.deepStrictEqual(mirrorFallbackChainFor('hentaiera'), [
            { site: 'hentaienvy', mode: 'title' },
            { site: 'imhentai', mode: 'title' }
        ]);
    });

    it('gives no chain to sites outside the mirror network', () => {
        for (const site of ['nhentai', 'hentaifox', 'hitomi', 'unknown-site', '']) {
            assert.deepStrictEqual(mirrorFallbackChainFor(site), [], site);
        }
    });

    it('returns a defensive copy (callers cannot mutate the table)', () => {
        const chain = mirrorFallbackChainFor('imhentai');
        chain.push({ site: 'hentaifox', mode: 'token' });
        assert.strictEqual(mirrorFallbackChainFor('imhentai').length, 2);
    });

    // ---- token host swap -------------------------------------------------

    it('builds the shared-store URLs on the named twin host', () => {
        const urls = sharedStoreImageUrls('w62za5o4v3', '1.webp', 'hentaienvy');
        assert.deepStrictEqual(urls, [
            'https://m11.hentaienvy.com/033/w62za5o4v3/1.webp',
            'https://m1.hentaienvy.com/033/w62za5o4v3/1.webp',
            'https://m2.hentaienvy.com/033/w62za5o4v3/1.webp',
            'https://m3.hentaienvy.com/033/w62za5o4v3/1.webp',
            'https://m4.hentaienvy.com/033/w62za5o4v3/1.webp',
            'https://m5.hentaienvy.com/033/w62za5o4v3/1.webp'
        ]);
        assert.deepStrictEqual(sharedStoreImageUrls('tok', '11.jpg', 'imhentai')[0],
            'https://m11.imhentai.xxx/033/tok/11.jpg');
        assert.deepStrictEqual(sharedStoreImageUrls('tok', '1.jpg', 'hentaiera'), []);
    });

    it('the twins expose each other as getFallbackImageUrls, byte-path identical', () => {
        // The fallback list of one twin must be exactly the other
        // twin's own getImageUrls for the same token + filename —
        // the shared /033/ store means the path never changes.
        assert.deepStrictEqual(
            imhentaiSource.getFallbackImageUrls('w62za5o4v3', '3.webp'),
            hentaienvySource.getImageUrls('w62za5o4v3', '3.webp'));
        assert.deepStrictEqual(
            hentaienvySource.getFallbackImageUrls('w62za5o4v3', '3.webp'),
            imhentaiSource.getImageUrls('w62za5o4v3', '3.webp'));
        // hentaiera is a separate backend: no token swap exists.
        assert.strictEqual(hentaieraSource.getFallbackImageUrls, undefined);
        // The shared-store table must stay in sync with each
        // adapter's own declared host list — the drift trap
        // (a host added on one side but not the other) would
        // silently miss the swap. This is the pin the table's
        // comment promises.
        assert.deepStrictEqual(
            MIRROR_STORE_HOSTS.hentaienvy.map((h) => h.replace(/^https:\/\//, "")),
            hentaienvySource.getImageHosts());
        assert.deepStrictEqual(
            MIRROR_STORE_HOSTS.imhentai.map((h) => h.replace(/^https:\/\//, "")),
            imhentaiSource.getImageHosts());
    });

    // ---- title matching --------------------------------------------------

    it('normalizes titles for cross-site matching', () => {
        assert.strictEqual(normalizeMirrorTitle('Foo Bar [Translated]'), 'foo bar');
        assert.strictEqual(normalizeMirrorTitle('Foo_Bar'), 'foo bar');
        assert.strictEqual(normalizeMirrorTitle('  Foo   Bar  '), 'foo bar');
        // Parenthesized groups are treated like bracketed ones
        // (translator groups live in both) and dropped.
        assert.strictEqual(normalizeMirrorTitle('Foo (Vol. 2)'), 'foo');
        assert.strictEqual(normalizeMirrorTitle('タイトル 2'), 'タイトル 2');
        assert.strictEqual(normalizeMirrorTitle(null), '');
    });

    it('scores an exact normalized match at 1, including separator variants', () => {
        assert.strictEqual(mirrorTitleScore('Random Renaissance Art', 'random renaissance art'), 1);
        // The owner's live note: mirrors differ by underline vs space.
        assert.strictEqual(mirrorTitleScore('Random_Renaissance_Art', 'Random Renaissance Art'), 1);
        // Bracketed translator groups are cosmetic.
        assert.strictEqual(mirrorTitleScore('Art [some group]', 'art'), 1);
        // A shorter title contained in a longer one (Vol. 2 suffix).
        assert.strictEqual(mirrorTitleScore('Art', 'art vol 2'), 1);
    });

    it('refuses weak matches: one shared word is not a title', () => {
        assert.strictEqual(mirrorTitleScore('Foo Bar', 'Foo Baz'), 0);
        assert.strictEqual(mirrorTitleScore('Foo Bar', 'Baz Qux'), 0);
        assert.strictEqual(mirrorTitleScore('', 'foo bar'), 0);
    });

    it('builds the mirror-network search URL (all three share /search/?key=)', () => {
        assert.strictEqual(buildMirrorSearchUrl('imhentai', 'Foo Bar'),
            'https://imhentai.xxx/search/?key=Foo%20Bar');
        assert.strictEqual(buildMirrorSearchUrl('hentaienvy', 'Foo Bar'),
            'https://hentaienvy.com/search/?key=Foo%20Bar');
        assert.strictEqual(buildMirrorSearchUrl('hentaiera', 'Foo Bar'),
            'https://hentaiera.to/search/?key=Foo%20Bar');
        assert.strictEqual(buildMirrorSearchUrl('nhentai', 'Foo Bar'), null);
        assert.strictEqual(buildMirrorSearchUrl('imhentai', '   '), null);
    });

    // ---- search-result parsing (markup measured from the captures) ------

    it('parses imhentai search cards (div.thumb > h2.gallery_title)', () => {
        const html = [
            '<div class="thumb" data-tags="81 290">',
            '  <div class="thumbnail">',
            '    <div class="inner_thumb">',
            '      <a href="/gallery/1738518/"><img class="lazy" data-src="https://m11.imhentai.xxx/033/w62za5o4v3/thumb.jpg" alt="DUMMY_TITLE_008" /></a>',
            '    </div>',
            '    <div class="caption">',
            '      <h2 class="gallery_title"><a href="/gallery/1738518/">DUMMY_TITLE_008</a></h2>',
            '    </div>',
            '  </div>',
            '</div>',
            '<div class="thumb" data-tags="15 175">',
            '  <div class="thumbnail">',
            '    <div class="inner_thumb">',
            '      <a href="/gallery/1738519/"><img class="lazy" data-src="https://m11.imhentai.xxx/033/5f17rh3z8b/thumb.jpg" alt="Other Gallery" /></a>',
            '    </div>',
            '    <div class="caption">',
            '      <h2 class="gallery_title"><a href="/gallery/1738519/">Other Gallery</a></h2>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');
        assert.deepStrictEqual(parseMirrorSearchResults(html, 'imhentai'), [
            { id: '1738518', title: 'DUMMY_TITLE_008' },
            { id: '1738519', title: 'Other Gallery' }
        ]);
    });

    it('parses hentaiera search cards (a.inner_thumb.img_box + h2.gallery_title)', () => {
        const html = [
            '<div class="thumb " >',
            '  <div class="thumbnail">',
            '    <a class="inner_thumb img_box" href="/gallery/694133/">',
            '      <img class="lazy preloader" data-src="https://hentaiera.site/galleries/4182258/thumb.webp" alt="DUMMY_TITLE_015" width="250" height="350">',
            '    </a>',
            '    <div class="g_text">',
            '      <h2 class="gallery_title"><a href="/gallery/694133/">DUMMY_TITLE_015</a></h2>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');
        assert.deepStrictEqual(parseMirrorSearchResults(html, 'hentaiera'), [
            { id: '694133', title: 'DUMMY_TITLE_015' }
        ]);
    });

    it('parses hentaienvy search cards (article.hnv-gallery-card)', () => {
        const html = [
            '<article class="hnv-gallery-card" data-tags="51121 118001">',
            '  <div class="hnv-gallery-card__media thumb">',
            '    <a class="hnv-gallery-card__cover" href="/gallery/1606086/" aria-label="DUMMY_TITLE_024">',
            '      <img src="https://m11.hentaienvy.com/033/w62za5o4v3/thumb.jpg" alt="" loading="lazy">',
            '    </a>',
            '  </div>',
            '  <footer class="hnv-gallery-card__caption">',
            '    <h2 class="hnv-gallery-card__title"><a href="/gallery/1606086/">DUMMY_TITLE_024</a></h2>',
            '  </footer>',
            '</article>'
        ].join('');
        assert.deepStrictEqual(parseMirrorSearchResults(html, 'hentaienvy'), [
            { id: '1606086', title: 'DUMMY_TITLE_024' }
        ]);
    });

    it('falls back to the cover alt/aria-label when the title heading is absent', () => {
        const html = '<div class="thumb"><div class="inner_thumb">'
            + '<a href="/gallery/42/"><img alt="Cover Alt Title" src="x"/></a>'
            + '</div></div>';
        assert.deepStrictEqual(parseMirrorSearchResults(html, 'imhentai'), [
            { id: '42', title: 'Cover Alt Title' }
        ]);
    });

    it('rejects non-search HTML and unknown sites', () => {
        assert.deepStrictEqual(parseMirrorSearchResults('<html><body>Just a moment...</body></html>', 'imhentai'), []);
        assert.deepStrictEqual(parseMirrorSearchResults('<div class="thumb">no gallery link here</div>', 'imhentai'), []);
        assert.deepStrictEqual(parseMirrorSearchResults('<div class="thumb"><a href="/gallery/1/">x</a></div>', 'nhentai'), []);
        assert.deepStrictEqual(parseMirrorSearchResults('', 'imhentai'), []);
    });

    it('picks the best title match and refuses below-threshold noise', () => {
        const cards = [
            { id: '1', title: 'Completely Different Thing' },
            { id: '2', title: 'DUMMY_TITLE_015' },
            { id: '3', title: 'dummy title 015 [group]' }
        ];
        const pick = pickMirrorTitleMatch(cards, 'DUMMY TITLE 015');
        assert.strictEqual(pick.id, '2'); // exact normalized match outranks the bracketed twin

        assert.strictEqual(pickMirrorTitleMatch(cards, 'Nothing Matches This'), null);
        assert.strictEqual(pickMirrorTitleMatch([], 'anything'), null);
        // The threshold itself stays pinned so a looser default
        // cannot silently start accepting wrong galleries.
        assert.strictEqual(MIRROR_TITLE_MATCH_THRESHOLD, 0.9);
    });
});

// ---- Downloader integration ---------------------------------------------

const pageBytes = (() => {
    function make(...marker) {
        const buf = new Uint8Array(2000);
        for (let i = 0; i < marker.length && i < 10; i++) buf[i] = marker[i];
        return buf;
    }
    return [make(0xff, 0xd8, 0xff, 0xe0), make(0x89, 0x50, 0x4e, 0x47, 0x0a)];
})();

function makeChromeStub(useZip, maxConcurrentDownloads = '1') {
    const stub = {
        storage: {
            sync: {
                get(defaults, cb) {
                    cb(Object.assign({}, defaults, { useZip, maxConcurrentDownloads }));
                }
            }
        },
        runtime: { lastError: null, sendMessage() {} },
        downloads: {
            download(opts, cb) { if (cb) cb(1); }
        }
    };
    return stub;
}

// Route-table fetch stub: [pattern, handler] pairs, first match wins.
// Records every attempted URL.
function makeRouter() {
    const routes = [];
    const attempted = [];
    const fn = (url) => {
        const u = String(url);
        attempted.push(u);
        for (const [pattern, handler] of routes) {
            if (pattern.test(u)) return handler(u);
        }
        return Promise.resolve(new Response('not routed', { status: 404 }));
    };
    fn.attempted = attempted;
    fn.add = (pattern, handler) => routes.push([pattern, handler]);
    return fn;
}

class FileReaderStub {
    readAsArrayBuffer(blob) {
        blob.arrayBuffer().then(
            (buf) => { this.result = buf; if (this.onload) this.onload(); },
            (err) => { this.error = err; if (this.onerror) this.onerror(err); }
        );
    }
}

const IMH_GALLERY = {
    site: 'imhentai',
    id: 1738518,
    media_id: 'w62za5o4v3', // the content-store token, not an id
    title: { pretty: 'DUMMY_TITLE_008', english: 'DUMMY_TITLE_008', japanese: '' },
    images: { pages: [{ t: 'w' }, { t: 'w' }] },
    num_pages: 2,
    tags: [], scanlator: ''
};

const ERA_GALLERY = {
    site: 'hentaiera',
    id: 694133,
    media_id: 4182258, // numeric, era's own store
    title: { pretty: 'DUMMY_TITLE_015', english: 'DUMMY_TITLE_015', japanese: '' },
    images: { pages: [{ t: 'w' }, { t: 'w' }] },
    num_pages: 2,
    tags: [], scanlator: ''
};

// An envy search page carrying the era gallery's title.
const ENVY_SEARCH_HTML = '<html><body>'
    + '<article class="hnv-gallery-card"><div class="hnv-gallery-card__media thumb">'
    + '<a class="hnv-gallery-card__cover" href="/gallery/1606086/" aria-label="DUMMY_TITLE_015">'
    + '<img src="https://m11.hentaienvy.com/033/envytok123/thumb.jpg"/></a></div>'
    + '<footer><h2 class="hnv-gallery-card__title"><a href="/gallery/1606086/">DUMMY_TITLE_015</a></h2></footer>'
    + '</article></body></html>';

// The matched envy gallery page: same title, same page count,
// its own token in the shared store.
const ENVY_GALLERY_HTML = '<html><body>'
    + '<div id="js-thumbs-grid" data-gallery-id="1606086" data-total-pages="2">'
    + '<a href="/gallery/1606086/"><img src="https://m11.hentaienvy.com/033/envytok123/1t.webp"/></a>'
    + '</div><h1 id="gallery-title">DUMMY_TITLE_015</h1>'
    + '<script type="application/json" id="readerPagesJson">'
    + JSON.stringify([{ ext: 'webp', width: 800, height: 1200 }, { ext: 'webp', width: 800, height: 1200 }])
    + '</script></body></html>';

// The same search page but the gallery copy has a different page
// count — the switch must be refused (a different gallery).
// readerPagesJson is the parser's ground truth, so the JSON
// itself carries five pages here.
const ENVY_GALLERY_HTML_WRONG_PAGES = ENVY_GALLERY_HTML.replace(
    JSON.stringify([{ ext: 'webp', width: 800, height: 1200 }, { ext: 'webp', width: 800, height: 1200 }]),
    JSON.stringify([1, 2, 3, 4, 5].map(() => ({ ext: 'webp', width: 800, height: 1200 }))));

async function decodeZip(url) {
    assert.ok(/^data:application\/zip;base64,/.test(url), 'expected a base64 zip data URL, got ' + url.slice(0, 40));
    return JSZip.loadAsync(Buffer.from(url.split(',')[1], 'base64'));
}

describe('Downloader mirror fallback (item 72)', () => {
    let chrome;
    let fetchStub;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        fetchStub = makeRouter();
        globalThis.chrome = chrome;
        globalThis.fetch = fetchStub;
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('token swap: an imhentai throttle routes the same token to hentaienvy hosts', async () => {
        // The whole imhentai store fails; the shared /033/ token
        // answers on the envy twin (same path, sibling hosts).
        fetchStub.add(/imhentai\.xxx\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/hentaienvy\.com\/033\//, (u) => {
            const m = /\/033\/([a-z0-9]+)\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[2], 10) - 1], { status: 200 }));
        });

        const downloader = new Downloader(IMH_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        const imageAttempts = fetchStub.attempted.filter((u) => u.indexOf('/033/') !== -1);
        // Every page walked imhentai's mirrors first, then envy's.
        assert.ok(imageAttempts.some((u) => u.indexOf('m11.imhentai.xxx/033/w62za5o4v3/') !== -1));
        assert.ok(imageAttempts.some((u) => u.indexOf('m11.hentaienvy.com/033/w62za5o4v3/') !== -1));
        // Same token on both sides — a host swap, never an id lookup.
        assert.ok(imageAttempts.every((u) => u.indexOf('/033/w62za5o4v3/') !== -1));
    });

    it('token swap: the finished archive carries the pages', async () => {
        fetchStub.add(/imhentai\.xxx\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/hentaienvy\.com\/033\//, (u) => {
            const m = /\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
        });

        let savedUrl = null;
        chrome.downloads.download = (opts, cb) => { savedUrl = opts.url; if (cb) cb(1); };

        const downloader = new Downloader(IMH_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test', null, undefined, { archiveLayout: "flat" });
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        const zip = await decodeZip(savedUrl);
        const names = Object.keys(zip.files).sort();
        assert.deepStrictEqual(names, ['001.webp', '002.webp']);
    });

    it('title match: a hentaiera throttle searches the siblings and switches the walk', async () => {
        // era's own store fails; the chain searches envy (title
        // step), matches the title, re-resolves the gallery there
        // and downloads from envy's store.
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/hentaienvy\.com\/search\//, () => Promise.resolve(new Response(ENVY_SEARCH_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/gallery\//, () => Promise.resolve(new Response(ENVY_GALLERY_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/033\//, (u) => {
            const m = /\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
        });

        const downloader = new Downloader(ERA_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        // The search was run against the sibling with the title.
        assert.ok(fetchStub.attempted.some((u) => u === 'https://hentaienvy.com/search/?key=DUMMY_TITLE_015'),
            'expected the envy search URL, got: ' + fetchStub.attempted.filter((u) => u.indexOf('/search/') !== -1).join(', '));
        // The matched gallery page was re-resolved there…
        assert.ok(fetchStub.attempted.some((u) => u === 'https://hentaienvy.com/gallery/1606086/'));
        // …and the pages came from the sibling's store token.
        assert.ok(fetchStub.attempted.some((u) => u.indexOf('m11.hentaienvy.com/033/envytok123/') !== -1));
    });

    it('title match: the switch is sticky — later pages never touch the failed store', async () => {
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/hentaienvy\.com\/search\//, () => Promise.resolve(new Response(ENVY_SEARCH_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/gallery\//, () => Promise.resolve(new Response(ENVY_GALLERY_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/033\//, (u) => {
            const m = /\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
        });

        const downloader = new Downloader(ERA_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        // Page 1's single era-store attempt resolved the switch
        // for the whole gallery; page 2 went straight to the
        // sibling (the switch is sticky).
        const eraAttempts = fetchStub.attempted.filter((u) => u.indexOf('hentaiera.site/') !== -1);
        assert.strictEqual(eraAttempts.length, 1);
        const envyAttempts = fetchStub.attempted.filter((u) => u.indexOf('/033/envytok123/') !== -1);
        assert.strictEqual(envyAttempts.length, 2);
    });

    it('title match: a sibling with a different page count is refused (different gallery)', async () => {
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/hentaienvy\.com\/search\//, () => Promise.resolve(new Response(ENVY_SEARCH_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/gallery\//, () => Promise.resolve(new Response(ENVY_GALLERY_HTML_WRONG_PAGES, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        // No imhentai search match either — the chain ends exhausted.
        fetchStub.add(/imhentai\.xxx\/search\//, () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));

        const downloader = new Downloader(ERA_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync(), /Mirror fallback found no copy/);
    });

    it('exhausted chain: the failure names the siblings that were tried', async () => {
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/\/search\//, () => Promise.resolve(new Response('<html><body>no results</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));

        const errors = [];
        const downloader = new Downloader(ERA_GALLERY, 'Downloads/Test', (e) => errors.push(String(e)), () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync(), /Mirror fallback found no copy on the sibling sites/);
        assert.ok(errors.some((e) => e.indexOf('Mirror fallback found no copy') !== -1));
    });

    it('setting off: no sibling URL is ever requested', async () => {
        fetchStub.add(/imhentai\.xxx\//, () => Promise.resolve(new Response('throttled', { status: 429 })));

        const downloader = new Downloader(IMH_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test', null, undefined, { mirrorFallback: false });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync(), /Failed to fetch original image/);

        assert.ok(fetchStub.attempted.every((u) => u.indexOf('hentaienvy.com') === -1),
            'with the setting off, no sibling host may be contacted');
        assert.ok(fetchStub.attempted.every((u) => u.indexOf('hentaiera.to') === -1));
    });

    it('a healthy primary site makes zero sibling requests', async () => {
        fetchStub.add(/imhentai\.xxx\/033\//, (u) => {
            const m = /\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
        });

        const downloader = new Downloader(IMH_GALLERY, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        assert.ok(fetchStub.attempted.every((u) => u.indexOf('hentaienvy.com') === -1
            && u.indexOf('hentaiera.to') === -1),
            'a healthy download must not touch any sibling (reactive-only rule)');
    });
});

// ---- item 73: the wording ladder ------------------------------------
// The owner's live note: envy search answers like nhentai's, but
// imhentai and hentaiera often return NOTHING unless the query is
// worded like the full title — or searched by tags instead. The
// title-match leg therefore climbs a query ladder, each variant
// tried only when the previous search parses to zero usable cards.

describe('Mirror search wording ladder (item 73)', () => {
    it('orders raw title, normalized title, then the strongest tag term', () => {
        const variants = mirrorSearchQueryVariants('Foo Bar (Vol. 2)', [
            { type: 'language', name: 'english' },
            { type: 'tag', name: 'latex' },
            { type: 'artist', name: 'Ochiba' }
        ]);
        assert.deepStrictEqual(variants, ['Foo Bar (Vol. 2)', 'foo bar', 'Ochiba']);
    });

    it('dedupes when normalization changes nothing', () => {
        const variants = mirrorSearchQueryVariants('Plain Title', [
            { type: 'tag', name: 'latex' }
        ]);
        assert.deepStrictEqual(variants, ['Plain Title', 'latex']);
    });

    it('prefers artist tags, then group/character, then any non-language tag', () => {
        // 'T' and its lowercase normalization dedupe to one rung.
        assert.deepStrictEqual(
            mirrorSearchQueryVariants('T', [{ type: 'tag', name: 'zz' }, { type: 'character', name: 'Reimu' }]),
            ['T', 'Reimu']);
        assert.deepStrictEqual(
            mirrorSearchQueryVariants('T', [{ type: 'tag', name: 'zz' }]),
            ['T', 'zz']);
        // Language tags carry no matching signal.
        assert.deepStrictEqual(mirrorSearchQueryVariants('T', [{ type: 'language', name: 'english' }]), ['T']);
    });

    it('tolerates plain-string tags and a missing tag list', () => {
        assert.deepStrictEqual(mirrorSearchQueryVariants('T', ['ochiba']), ['T', 'ochiba']);
        assert.deepStrictEqual(mirrorSearchQueryVariants('T'), ['T']);
        assert.deepStrictEqual(mirrorSearchQueryVariants('T', 'nope'), ['T']);
    });

    it('returns an empty ladder without a title', () => {
        assert.deepStrictEqual(mirrorSearchQueryVariants('', [{ type: 'artist', name: 'x' }]), []);
        assert.deepStrictEqual(mirrorSearchQueryVariants(null), []);
    });
});

describe('Mirror gallery tag parsing (item 73)', () => {
    // Grounded in the captured gallery pages (2026-09-15 HARs):
    // imhentai's tag row sits in ul.galleries_info with single-quoted
    // attrs and a count badge; hentaiera's tag buttons are typed by
    // href prefix; hentaienvy's carry a clean title attribute.
    it('imhentai: typed tags from the galleries_info row, language dropped', () => {
        const html = '<html><body>'
            + '<input id="gallery_id" value="1738518"/>'
            + '<input id="load_id" value="imhtok789"/>'
            + '<input id="gallery_title" value="DUMMY_TITLE_015"/>'
            + '<input id="load_pages" value="2"/>'
            + '<ul class="galleries_info"><li><span class=\'tags_text\'>Tags:</span> '
            + '<a class=\'tag  btn btn-primary\' href=\'/tag/latex/\'>latex\n'
            + '<span class=\'badge\'>13265</span>\n</a>'
            + '<a class=\'tag  btn btn-primary\' href=\'/artist/ochiba/\'>ochiba\n'
            + '<span class=\'badge\'>42</span>\n</a>'
            + '<a class=\'tag  btn btn-primary\' href=\'/language/english/\'>english\n'
            + '<span class=\'badge\'>9</span>\n</a>'
            + '</li></ul></body></html>';
        const gallery = extractImhentaiGallery(html);
        assert.ok(gallery, 'the imhentai fixture must parse');
        assert.deepStrictEqual(gallery.tags, [
            { type: 'tag', name: 'latex' },
            { type: 'artist', name: 'ochiba' }
        ]);
    });

    it('hentaiera: typed tags from the tag buttons, language dropped', () => {
        const html = '<html><body>'
            + '<script type="application/ld+json">{"@type":"ImageGallery","name":"DUMMY_TITLE_015",'
            + '"numberOfItems":2,"image":"https://hentaiera.site/galleries/4182258/cover.webp"}</script>'
            + '<div class="info_tags"><div class="tags_text">'
            + '<a class="tag btn btn-primary" href="/artist/tororo/">tororo</a>'
            + '<a class="tag btn btn-primary" href="/character/reimu-hakurei/">reimu hakurei</a>'
            + '<a class="tag btn btn-primary" href="/group/toriaezu-kari/">toriaezu kari</a>'
            + '<a class="tag btn btn-primary" href="/language/japanese/">japanese</a>'
            + '<a class="tag btn btn-primary" href="/tag/big-breasts/">big breasts</a>'
            + '</div></div></body></html>';
        const gallery = extractHentaieraGallery(html);
        assert.ok(gallery, 'the hentaiera fixture must parse');
        assert.deepStrictEqual(gallery.tags, [
            { type: 'artist', name: 'tororo' },
            { type: 'character', name: 'reimu hakurei' },
            { type: 'group', name: 'toriaezu kari' },
            { type: 'tag', name: 'big breasts' }
        ]);
    });

    it('hentaienvy: typed tags from the gallery-tag links, language dropped', () => {
        const html = '<html><body>'
            + '<div id="js-thumbs-grid" data-gallery-id="1606086" data-total-pages="2">'
            + '<a href="/gallery/1606086/"><img src="https://m11.hentaienvy.com/033/envytok123/1t.webp"/></a>'
            + '</div><h1 id="gallery-title">DUMMY_TITLE_015</h1>'
            + '<a class="hnv-gallery-tag" href="/artist/ochiba/" title="ochiba">'
            + '<span class="hnv-gallery-tag__name">ochiba</span></a>'
            + '<a class="hnv-gallery-tag" href="/category/artist-cg/" title="artist cg">'
            + '<span class="hnv-gallery-tag__name">artist cg</span></a>'
            + '<a class="hnv-gallery-tag" href="/language/translated/" title="translated">'
            + '<span class="hnv-gallery-tag__name">translated</span></a>'
            + '<a class="hnv-gallery-tag" href="/tag/corruption/" title="corruption">'
            + '<span class="hnv-gallery-tag__name">corruption</span></a>'
            + '<script type="application/json" id="readerPagesJson">'
            + JSON.stringify([{ ext: 'webp', width: 800, height: 1200 }, { ext: 'webp', width: 800, height: 1200 }])
            + '</script></body></html>';
        const gallery = extractHentaienvyGallery(html);
        assert.ok(gallery, 'the hentaienvy fixture must parse');
        assert.deepStrictEqual(gallery.tags, [
            { type: 'artist', name: 'ochiba' },
            { type: 'category', name: 'artist cg' },
            { type: 'tag', name: 'corruption' }
        ]);
    });
});

describe('Downloader wording ladder (item 73)', () => {
    let chrome;
    let fetchStub;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        globalThis.chrome = chrome;
        globalThis.FileReader = FileReaderStub;
        globalThis.URL = undefined;
        fetchStub = makeRouter();
        globalThis.fetch = fetchStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.FileReader;
        globalThis.URL = URL;
    });

    // The raw pretty title carries a bracketed group — the
    // wording imhentai/hentaiera search often refuses. Variant
    // 1 comes back empty, the normalized variant lands.
    it('a bracketed title is rescued by the normalized query', async () => {
        const gallery = Object.assign({}, ERA_GALLERY, {
            title: { pretty: 'DUMMY_TITLE_015 (Vol. 2)', english: 'DUMMY_TITLE_015 (Vol. 2)', japanese: '' }
        });
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        // Parens survive encodeURIComponent (they are legal
        // URL query characters), so the raw-title rung's URL
        // carries them literally.
        fetchStub.add(/key=DUMMY_TITLE_015%20\(Vol/, () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/search\//, () => Promise.resolve(new Response(ENVY_SEARCH_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/gallery\//, () => Promise.resolve(new Response(ENVY_GALLERY_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/033\//, (u) => {
            const m = /\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
        });

        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        assert.ok(fetchStub.attempted.some((u) => u.indexOf('key=DUMMY_TITLE_015%20(Vol') !== -1),
            'the raw-title search must be tried first');
        assert.ok(fetchStub.attempted.some((u) => u === 'https://hentaienvy.com/search/?key=dummy%20title%20015'),
            'the normalized-title search must be the second rung');
        assert.ok(fetchStub.attempted.some((u) => u.indexOf('m11.hentaienvy.com/033/envytok123/') !== -1),
            'the switch must still complete from the sibling store');
    });

    // A title no sibling search will ever answer; the artist
    // tag is the third rung and it lands.
    it('an unsearchable title is rescued by the artist tag', async () => {
        const gallery = Object.assign({}, ERA_GALLERY, {
            title: { pretty: 'UNSEARCHABLE_TITLE_999', english: 'UNSEARCHABLE_TITLE_999', japanese: '' },
            tags: [
                { type: 'language', name: 'english' },
                { type: 'tag', name: 'latex' },
                { type: 'artist', name: 'Ochiba' }
            ]
        });
        const envySearch = ENVY_SEARCH_HTML.split('DUMMY_TITLE_015').join('UNSEARCHABLE_TITLE_999');
        const envyGallery = ENVY_GALLERY_HTML.split('DUMMY_TITLE_015').join('UNSEARCHABLE_TITLE_999');
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/key=UNSEARCHABLE_TITLE_999/, () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/key=Ochiba/, () => Promise.resolve(new Response(envySearch, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/gallery\//, () => Promise.resolve(new Response(envyGallery, { status: 200, headers: { 'Content-Type': 'text/html' } })));
        fetchStub.add(/hentaienvy\.com\/033\//, (u) => {
            const m = /\/([0-9]+)\.webp/.exec(u);
            return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
        });

        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        assert.ok(fetchStub.attempted.some((u) => u === 'https://hentaienvy.com/search/?key=Ochiba'),
            'the artist-tag query must be the third rung, got: '
            + fetchStub.attempted.filter((u) => u.indexOf('/search/') !== -1).join(', '));
        assert.ok(fetchStub.attempted.some((u) => u.indexOf('m11.hentaienvy.com/033/envytok123/') !== -1),
            'the tag-rung match must still switch the walk to the sibling');
    });

    // Every rung empty: the failure stays honest, and both
    // title rungs were actually attempted (the ladder climbed).
    it('an empty ladder on every sibling still fails honestly', async () => {
        const gallery = Object.assign({}, ERA_GALLERY, {
            title: { pretty: 'DUMMY_TITLE_015 (Vol. 2)', english: 'DUMMY_TITLE_015 (Vol. 2)', japanese: '' }
        });
        fetchStub.add(/hentaiera\.site\//, () => Promise.resolve(new Response('throttled', { status: 429 })));
        fetchStub.add(/\/search\//, () => Promise.resolve(new Response('<html><body>no results</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));

        const downloader = new Downloader(gallery, 'Downloads/Test', (e) => { throw e; }, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync(), /Mirror fallback found no copy/);

        assert.ok(fetchStub.attempted.some((u) => u.indexOf('key=DUMMY_TITLE_015%20(Vol') !== -1),
            'the raw-title rung must be attempted');
        assert.ok(fetchStub.attempted.some((u) => u === 'https://hentaienvy.com/search/?key=dummy%20title%20015'),
            'the normalized rung must be attempted too');
    });
});
