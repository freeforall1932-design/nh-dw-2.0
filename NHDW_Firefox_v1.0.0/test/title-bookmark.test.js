// Title-page Bookmark button — the pure half (utils/titleBookmark.ts).
//
// The contract pinned here is "which URLs get the button, and where does it
// go", because those are the two things that quietly break when a site
// changes its markup or when a seventh adapter is registered without a
// matching row in the target table. No browser needed.

const assert = require('assert');
const {
    BOOKMARK_ICON_PATH,
    BOOKMARK_ICON_OUTLINE_PATH,
    BOOKMARK_ICON_VIEWBOX,
    TITLE_BOOKMARK_CLASS,
    TITLE_BOOKMARK_ICON_CLASS,
    TITLE_BOOKMARK_LABEL,
    TITLE_BOOKMARK_LABEL_CLASS,
    TITLE_BOOKMARK_LABEL_ON,
    TITLE_BOOKMARK_ON_CLASS,
    cleanGalleryTitle,
    parsePageCount,
    presentationalButtonClasses,
    resolveTitleBookmarkPage,
    targetForSite,
    titleBookmarkSites
} = require('../build/test/utils/titleBookmark.js');
const { getConfiguredSources } = require('../build/test/sources/index.js');

const GALLERY_PAGES = [
    ['https://nhentai.net/g/683215/', 'nhentai', '683215'],
    ['https://hentaiera.to/gallery/694133/', 'hentaiera', '694133'],
    ['https://hentaiera.com/gallery/694133/', 'hentaiera', '694133'],
    ['https://imhentai.xxx/gallery/1738518/', 'imhentai', '1738518'],
    ['https://hentaienvy.com/gallery/1606086/', 'hentaienvy', '1606086'],
    ['https://hentaifox.com/gallery/173098/', 'hentaifox', '173098'],
    ['https://hitomi.la/galleries/4203493.html', 'hitomi', '4203493']
];

// Reader pages and listings must NOT get the button: the Favorite/Download row
// they would anchor to does not exist there, and a mis-anchored button on a
// reader page is worse than none.
const NOT_GALLERY_PAGES = [
    'https://nhentai.net/',
    'https://nhentai.net/g/683215/1/',
    'https://nhentai.net/tag/big-adventures/',
    'https://hentaiera.to/',
    'https://hentaiera.to/gallery/694133/1/',
    'https://hentaiera.to/tag/big-adventures/',
    'https://imhentai.xxx/',
    'https://imhentai.xxx/view/1738518/1/',
    'https://hentaienvy.com/g/1606086/1/',
    'https://hentaifox.com/g/173098/1/',
    'https://hitomi.la/reader/4203493.html',
    'https://hitomi.la/index-korean.html',
    'https://example.com/g/683215/',
    ''
];

describe('title-page bookmark targets', () => {
    it('resolves a gallery page on every supported site to its composite key', () => {
        for (const [url, site, id] of GALLERY_PAGES) {
            const page = resolveTitleBookmarkPage(url);
            assert.ok(page !== null, 'expected a title-page target for ' + url);
            assert.strictEqual(page.site, site, 'site for ' + url);
            assert.strictEqual(page.id, id, 'gallery id for ' + url);
            assert.strictEqual(page.galleryKey, site + ':' + id, 'composite key for ' + url);
            assert.strictEqual(page.target.site, site);
        }
    });

    it('accepts a query string or fragment on a gallery url', () => {
        const page = resolveTitleBookmarkPage('https://nhentai.net/g/683215/?utm=1#top');
        assert.ok(page !== null);
        assert.strictEqual(page.id, '683215');
    });

    it('refuses listings, reader pages and unknown hosts', () => {
        for (const url of NOT_GALLERY_PAGES) {
            assert.strictEqual(resolveTitleBookmarkPage(url), null,
                'must not inject a bookmark button on ' + JSON.stringify(url));
        }
    });

    it('has a row for every registered adapter site', () => {
        // Guard rail: registering a seventh adapter without a target row would
        // silently ship a site with no way to bookmark it.
        for (const source of getConfiguredSources()) {
            assert.ok(targetForSite(source.site) !== null,
                'no title-page bookmark target for adapter site "' + source.site + '"');
        }
        assert.deepStrictEqual(titleBookmarkSites().sort(), [
            'hentaienvy', 'hentaiera', 'hentaifox', 'hitomi', 'imhentai', 'nhentai'
        ]);
    });

    it('anchors after the Download button so the row reads Favorite / Download / Bookmark', () => {
        for (const site of titleBookmarkSites()) {
            const target = targetForSite(site);
            assert.ok(target.anchorSelectors.length > 0, site + ' needs at least one anchor');
            assert.ok(/(dl|download)/i.test(target.anchorSelectors[0]),
                site + ' must anchor on its Download button first, got ' + target.anchorSelectors[0]);
        }
    });

    it('never copies a site behavior hook onto our button', () => {
        // `js-*` / `*_btn` classes are how these sites bind click handlers; the
        // new button must not be enlisted in them.
        for (const site of titleBookmarkSites()) {
            for (const className of targetForSite(site).buttonClasses) {
                assert.ok(!/^js/i.test(className), site + ' copies behavior class ' + className);
                assert.ok(!/_btn$/.test(className), site + ' copies behavior class ' + className);
            }
        }
    });

    it('reads the title, cover and page count from site-specific nodes', () => {
        for (const site of titleBookmarkSites()) {
            const target = targetForSite(site);
            assert.ok(target.titleSelectors.length > 0, site + ' needs a title selector');
            assert.ok(target.thumbnailSelectors.length > 0, site + ' needs a thumbnail selector');
            assert.ok(target.pageCountSelectors.length > 0 || site === 'hitomi',
                site + ' needs a page-count selector');
        }
    });

    it('falls back to the document title when the page has no known heading', () => {
        assert.strictEqual(cleanGalleryTitle('Some Title', '123'), 'Some Title');
        assert.strictEqual(cleanGalleryTitle('', '123'), '123');
        assert.strictEqual(cleanGalleryTitle('   ', '123'), '123');
    });

    it('strips reader-page and site-name suffixes from a title', () => {
        assert.strictEqual(
            cleanGalleryTitle('Watashi ga Tsukurimashita. (Touhou Project) - Page 3', '694133'),
            'Watashi ga Tsukurimashita. (Touhou Project)');
        assert.strictEqual(cleanGalleryTitle('Moonlit Waon-chan – Page 12', '1'), 'Moonlit Waon-chan');
        assert.strictEqual(cleanGalleryTitle('Some Title | nhentai', '1'), 'Some Title');
        assert.strictEqual(cleanGalleryTitle('Some Title - HentaiEra', '1'), 'Some Title');
    });
});

describe('title-page bookmark page counts', () => {
    it('reads the labelled forms the supported sites print', () => {
        assert.strictEqual(parsePageCount('Pages: 49'), 49);
        assert.strictEqual(parsePageCount('Pages  51'), 51);
        assert.strictEqual(parsePageCount('51 pages'), 51);
        assert.strictEqual(parsePageCount('1 page'), 1);
        assert.strictEqual(parsePageCount('Pages:\n  49  '), 49);
    });

    it('reports 0 for anything that is not a page count', () => {
        assert.strictEqual(parsePageCount(''), 0);
        assert.strictEqual(parsePageCount('Tags: big adventures'), 0);
        assert.strictEqual(parsePageCount('999999'), 0);
        assert.strictEqual(parsePageCount('Pages: 0'), 0);
    });
});

describe('classes copied from the site\'s own button', () => {
    it('keeps the presentational classes that carry the sizing', () => {
        // Verbatim from a saved imhentai gallery page.
        assert.deepStrictEqual(
            presentationalButtonClasses('tag btn btn-primary dl_btn'),
            ['tag', 'btn', 'btn-primary']);
        assert.deepStrictEqual(
            presentationalButtonClasses('tag btn btn-primary fav_btn'),
            ['tag', 'btn', 'btn-primary']);
        assert.deepStrictEqual(presentationalButtonClasses('hnv-gallery-action'), ['hnv-gallery-action']);
    });

    it('never copies a behavior hook, a state flag or our own namespace', () => {
        const filtered = presentationalButtonClasses(
            'nhdw-title-bookmark btn active selected hidden js-ajax-action js_track save_dl_btn load-trigger');
        assert.deepStrictEqual(filtered, ['btn']);
    });

    it('is idempotent, order-preserving and safe on empty input', () => {
        assert.deepStrictEqual(presentationalButtonClasses('btn btn'), ['btn']);
        assert.deepStrictEqual(presentationalButtonClasses(''), []);
        assert.deepStrictEqual(presentationalButtonClasses(null), []);
        assert.deepStrictEqual(presentationalButtonClasses(undefined), []);
        assert.deepStrictEqual(presentationalButtonClasses('   '), []);
        // A template/utility blob is not a class name worth copying.
        assert.deepStrictEqual(presentationalButtonClasses('a'.repeat(41) + ' btn'), ['btn']);
    });

    it('pins the hentaifox row to the ids every hentaifox gallery page has', () => {
        const fox = targetForSite('hentaifox');
        assert.strictEqual(fox.anchorSelectors[0], '#download_btn',
            'the visible Download button is #download_btn, not #dl_new');
        assert.ok(fox.anchorSelectors.includes('#add_fav_btn'));
        assert.ok(fox.titleSelectors.includes('div.info h1'));
        assert.ok(fox.thumbnailSelectors.includes('div.cover img'));
    });
});

describe('title-page bookmark button constants', () => {
    it('ships a filled and an outline glyph from one 24x24 viewBox', () => {
        assert.strictEqual(BOOKMARK_ICON_VIEWBOX, '0 0 24 24');
        assert.ok(BOOKMARK_ICON_PATH.length > 20);
        assert.ok(BOOKMARK_ICON_OUTLINE_PATH.length > 20);
        assert.notStrictEqual(BOOKMARK_ICON_PATH, BOOKMARK_ICON_OUTLINE_PATH);
    });

    it('names the classes the injected CSS styles', () => {
        assert.strictEqual(TITLE_BOOKMARK_CLASS, 'nhdw-title-bookmark');
        assert.strictEqual(TITLE_BOOKMARK_ON_CLASS, 'nhdw-title-bookmark-on');
        assert.strictEqual(TITLE_BOOKMARK_ICON_CLASS, 'nhdw-title-bookmark-icon');
        assert.strictEqual(TITLE_BOOKMARK_LABEL_CLASS, 'nhdw-title-bookmark-label');
    });

    it('labels the button Bookmark / Bookmarked', () => {
        assert.strictEqual(TITLE_BOOKMARK_LABEL, 'Bookmark');
        assert.strictEqual(TITLE_BOOKMARK_LABEL_ON, 'Bookmarked');
    });
});
