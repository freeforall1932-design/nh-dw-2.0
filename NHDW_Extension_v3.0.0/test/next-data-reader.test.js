// Next.js page data (`__NEXT_DATA__`) as a chapter page-list source.
// Synthetic fixtures shaped like a Next.js "pages" router chapter (the layout
// mangak.io uses: props.pageProps.initialChapter.images). No live site.
const assert = require('assert');
const { URL: NodeURL } = require('url');
const {
    nextDataText, parseNextData, nextDataImageUrls, nextDataMatchesUrl,
    collectNextDataPages, collectNextDataPagesFromText
} = require('../build/test/utils/universalChapter.js');
const { profileFor, saveProfile, checkProfile } = require('../build/test/utils/siteProfiles.js');

const chapterUrl = 'https://reader.example/some-title/chapter-1';
const pagesOf = (n, host = 'cdn.example') => Array.from({ length: n }, (_, i) => 'https://' + host + '/c/' + (i + 1) + '-h' + (97 * (i + 3)) + '.webp');

function nextData(pageProps, extra = {}) {
    return Object.assign({
        props: { pageProps },
        page: '/[slug]/[chapter]',
        query: { slug: 'some-title', chapter: 'chapter-1' },
        buildId: 'fixture'
    }, extra);
}
function htmlWith(data, attrs = 'id="__NEXT_DATA__" type="application/json"') {
    return '<!doctype html><html><body><div id="__next"><div class="reader"></div></div>' +
        '<script ' + attrs + '>' + JSON.stringify(data) + '</script></body></html>';
}

describe('Next.js page data as a chapter page list', () => {
    const previous = globalThis.URL;
    before(() => { globalThis.URL = NodeURL; });
    after(() => { if (previous === undefined) delete globalThis.URL; else globalThis.URL = previous; });

    it('reads the ordered list from initialChapter.images and keeps the site order', () => {
        const urls = pagesOf(5);
        const html = htmlWith(nextData({ initialChapter: { name: 'Chapter 1', images: urls }, initialManga: { id: 'x', image: 'https://cdn.example/cover.jpg' } }));
        const pages = collectNextDataPages(html, chapterUrl);
        assert.deepStrictEqual(pages.map(p => p.url), urls);
        assert.deepStrictEqual(Array.from(new Set(pages.map(p => p.host))), ['cdn.example']);
    });

    it('accepts other common layouts and {url}/{src} entries', () => {
        assert.deepStrictEqual(nextDataImageUrls(nextData({ chapter: { images: ['https://a.example/1.jpg'] } })), ['https://a.example/1.jpg']);
        assert.deepStrictEqual(nextDataImageUrls(nextData({ chapter: { imageUrls: [{ url: 'https://a.example/1.jpg' }, { src: 'https://a.example/2.jpg' }] } })),
            ['https://a.example/1.jpg', 'https://a.example/2.jpg']);
        // Unknown nesting, but exactly one candidate list: accepted.
        assert.deepStrictEqual(nextDataImageUrls(nextData({ data: { reader: { pageImages: ['https://a.example/9.jpg'] } } })), ['https://a.example/9.jpg']);
    });

    it('refuses an ambiguous document instead of guessing', () => {
        const ambiguous = nextData({ a: { images: ['https://a.example/1.jpg'] }, b: { images: ['https://b.example/1.jpg'] } });
        assert.deepStrictEqual(nextDataImageUrls(ambiguous), []);
        // Lists of cards (related titles) are never walked into.
        assert.deepStrictEqual(nextDataImageUrls(nextData({ related: [{ images: ['https://a.example/cover.jpg'] }] })), []);
        // A title page (manga info only) has no page list.
        assert.deepStrictEqual(nextDataImageUrls(nextData({ initialManga: { id: 'x', name: 'Title', image: 'https://a.example/c.jpg' } })), []);
    });

    it('is all or nothing: one unusable entry rejects the whole list', () => {
        const mixed = pagesOf(3).concat(['http://insecure.example/4.jpg']);
        assert.deepStrictEqual(collectNextDataPages(htmlWith(nextData({ initialChapter: { images: mixed } })), chapterUrl), []);
        assert.deepStrictEqual(nextDataImageUrls(nextData({ initialChapter: { images: ['https://a.example/1.jpg', 'not a url'] } })), []);
        assert.deepStrictEqual(nextDataImageUrls(nextData({ initialChapter: { images: ['https://a.example/1.jpg', 5] } })), []);
        assert.deepStrictEqual(nextDataImageUrls(nextData({ initialChapter: { images: [] } })), []);
        // Relative entries resolve against the chapter URL.
        const pages = collectNextDataPages(htmlWith(nextData({ initialChapter: { images: ['/img/1.jpg'] } })), chapterUrl);
        assert.deepStrictEqual(pages.map(p => p.url), ['https://reader.example/img/1.jpg']);
    });

    it('parses only a JSON script block, never executes anything', () => {
        assert.strictEqual(nextDataText('<div>no data</div>'), null);
        assert.strictEqual(parseNextData('not json'), null);
        assert.strictEqual(parseNextData('[1,2]'), null);
        assert.strictEqual(parseNextData(null), null);
        const evil = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialChapter":{"images":["https://a.example/1.jpg"]}}},"x":alert(1)}</script>';
        assert.deepStrictEqual(collectNextDataPages(evil, chapterUrl), []);
        // Attribute order and quoting do not matter.
        const data = nextData({ initialChapter: { images: ['https://a.example/1.jpg'] } });
        assert.strictEqual(collectNextDataPages(htmlWith(data, "type='application/json' id='__NEXT_DATA__'"), chapterUrl).length, 1);
        assert.throws(() => collectNextDataPages(htmlWith(data), 'http://reader.example/x'), /not allowed/);
    });

    it('detects stale data in a live tab after client-side navigation', () => {
        const data = nextData({ initialChapter: { images: pagesOf(2) } });
        assert.strictEqual(nextDataMatchesUrl(data, 'https://reader.example/some-title/chapter-1'), true);
        assert.strictEqual(nextDataMatchesUrl(data, 'https://reader.example/some-title/chapter-1?x=1'), true);
        assert.strictEqual(nextDataMatchesUrl(data, 'https://reader.example/some-title/chapter-2'), false, 'another chapter');
        assert.strictEqual(nextDataMatchesUrl(data, 'https://reader.example/some-title'), false, 'the title page');
        assert.strictEqual(nextDataMatchesUrl(data, 'https://reader.example/some-title/chapter-1/extra'), false);
        assert.strictEqual(nextDataMatchesUrl(Object.assign({}, data, { page: '/_error' }), chapterUrl), false);
        assert.strictEqual(nextDataMatchesUrl({ props: {} }, chapterUrl), false, 'no route means unverifiable');
        // Static and catch-all segments.
        assert.strictEqual(nextDataMatchesUrl({ page: '/read/[...parts]', query: { parts: ['a', 'b'] } }, 'https://r.example/read/a/b'), true);
        assert.strictEqual(nextDataMatchesUrl({ page: '/read/[...parts]', query: { parts: ['a'] } }, 'https://r.example/read/a/b'), false);
        assert.strictEqual(nextDataMatchesUrl({ page: '/read/[id]', query: { id: 'caf\u00e9' } }, 'https://r.example/read/caf%C3%A9'), true);

        const live = collectNextDataPagesFromText(JSON.stringify(data), 'https://reader.example/some-title/chapter-2', 'https://reader.example/some-title/chapter-2');
        assert.deepStrictEqual(live, { pages: [], stale: true, present: true });
        const fresh = collectNextDataPagesFromText(JSON.stringify(data), chapterUrl, chapterUrl);
        assert.strictEqual(fresh.pages.length, 2);
        assert.strictEqual(fresh.stale, false);
        // Fetched HTML for an exact chapter URL is not subject to the live check.
        assert.strictEqual(collectNextDataPagesFromText(JSON.stringify(data), 'https://reader.example/some-title/chapter-2', null).pages.length, 2);
        assert.deepStrictEqual(collectNextDataPagesFromText(null, chapterUrl, chapterUrl), { pages: [], stale: false, present: false });
    });
});

describe('opt-in referrer in remembered site settings', () => {
    const good = { selector: '#readerarea img', attribute: 'auto', order: 'reader', fullSizeSuffix: '' };

    it('defaults to off, round-trips when on, and rejects non-boolean values', () => {
        assert.strictEqual(profileFor(saveProfile({}, 'https://reader.example', good, 1), 'https://reader.example').sendReferrer, false);
        const on = saveProfile({}, 'https://reader.example', Object.assign({}, good, { sendReferrer: true }), 1);
        assert.strictEqual(profileFor(JSON.parse(JSON.stringify(on)), 'https://reader.example').sendReferrer, true);
        assert.strictEqual(checkProfile(Object.assign({}, good, { sendReferrer: 'yes' })).ok, false);
        // An older stored profile without the field still loads, as off.
        const legacy = { 'https://reader.example': Object.assign({}, good, { savedAt: 3 }) };
        assert.strictEqual(profileFor(legacy, 'https://reader.example').sendReferrer, false);
    });
});
