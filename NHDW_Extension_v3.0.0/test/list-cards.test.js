// Listing-card selector table — the pure half (utils/listCards.ts).
//
// Item 63: card controls (Select + Bookmark + Download) must reach all six
// supported sites, with per-site selectors declared like the titleBookmark
// table — never one brittle global selector. This pins the table's contracts
// with no browser needed:
//   * every supported site has a row (no silent fall-through to nhentai),
//   * resolveListCardPage() answers LISTING urls and refuses single-gallery
//     pages (a gallery page must never be decorated as a listing card),
//   * cardIdFromHref() extracts the bare gallery id from each site's own
//     URL shapes (adapter-consistent, relative and absolute hrefs),
//   * the discovery modes cover the three captured architectures
//     (link+caption inside, card container, heading block).

const assert = require('assert');
const {
    LIST_CARD_TARGETS,
    listCardTargetForSite,
    resolveListCardPage,
    cardIdFromHref
} = require('../build/test/utils/listCards.js');

const SUPPORTED_SITES = ['nhentai', 'hentaiera', 'imhentai', 'hentaienvy', 'hentaifox', 'hitomi'];

describe('list card target table (item 63)', () => {
    it('declares a row for every supported site', () => {
        for (const site of SUPPORTED_SITES) {
            const row = listCardTargetForSite(site);
            assert.ok(row, 'site "' + site + '" must have a list-card row');
            assert.strictEqual(row.site, site);
            assert.ok(typeof row.linkSelector === 'string' && row.linkSelector !== '',
                site + ': a link selector is declared');
            assert.ok(row.linkPattern instanceof RegExp, site + ': a link pattern is declared');
        }
        assert.strictEqual(listCardTargetForSite('unknown-site'), null);
        assert.strictEqual(listCardTargetForSite(undefined), null);
    });

    it('uses the three discovery architectures seen in the captures', () => {
        // nhentai: caption INSIDE the cover link (link mode).
        assert.strictEqual(LIST_CARD_TARGETS.nhentai.mode, 'link');
        assert.strictEqual(LIST_CARD_TARGETS.nhentai.captionSelector, '.caption');
        // hentaifox / imhentai / hentaiera: card container + title outside the
        // cover link (card mode); each names ITS captured container/title.
        assert.strictEqual(LIST_CARD_TARGETS.hentaifox.mode, 'card');
        assert.strictEqual(LIST_CARD_TARGETS.hentaifox.containerSelector, '.thumb');
        assert.strictEqual(LIST_CARD_TARGETS.hentaifox.titleSelector, '.caption');
        assert.strictEqual(LIST_CARD_TARGETS.imhentai.mode, 'card');
        assert.strictEqual(LIST_CARD_TARGETS.imhentai.containerSelector, '.thumb');
        assert.strictEqual(LIST_CARD_TARGETS.hentaiera.mode, 'card');
        assert.strictEqual(LIST_CARD_TARGETS.hentaiera.containerSelector, '.thumb');
        assert.strictEqual(LIST_CARD_TARGETS.hentaiera.titleSelector, '.gallery_title');
        // hentaienvy: its own article card, never a bare global .thumb.
        assert.strictEqual(LIST_CARD_TARGETS.hentaienvy.mode, 'card');
        assert.strictEqual(LIST_CARD_TARGETS.hentaienvy.containerSelector, 'article.hnv-gallery-card');
        assert.strictEqual(
            LIST_CARD_TARGETS.hentaienvy.titleSelector, '.hnv-gallery-card__title');
        // hitomi: heading blocks inside .gallery-content (content mode).
        assert.strictEqual(LIST_CARD_TARGETS.hitomi.mode, 'content');
        assert.strictEqual(LIST_CARD_TARGETS.hitomi.containerAncestorClass, 'gallery-content');
    });

    it('resolves listing urls and refuses single-gallery pages', () => {
        const listing = [
            ['https://nhentai.net/', 'nhentai'],
            ['https://nhentai.net/search?q=foo', 'nhentai'],
            ['https://nhentai.net/tag/big-adventures/', 'nhentai'],
            ['https://hentaifox.com/', 'hentaifox'],
            ['https://hentaifox.com/search/?q=girl', 'hentaifox'],
            ['https://imhentai.xxx/', 'imhentai'],
            ['https://hentaiera.to/tag/milf/', 'hentaiera'],
            ['https://hentaienvy.com/', 'hentaienvy'],
            ['https://hitomi.la/search.html?tag%3Afemale%3Aschoolgirl', 'hitomi'],
            ['https://hitomi.la/index-english.html', 'hitomi']
        ];
        for (const [url, site] of listing) {
            const resolved = resolveListCardPage(url);
            assert.ok(resolved, url + ' is a listing page and must resolve');
            assert.strictEqual(resolved.site, site, url);
            assert.strictEqual(resolved.target, LIST_CARD_TARGETS[site], url);
        }

        const galleryPages = [
            'https://nhentai.net/g/123456/',
            'https://nhentai.net/g/123456/2/', // reader
            'https://hentaifox.com/gallery/173098/',
            'https://imhentai.xxx/gallery/1738519/',
            'https://hentaiera.to/gallery/694133/',
            'https://hentaienvy.com/gallery/1606086/',
            'https://hitomi.la/galleries/12345.html',
            'https://hitomi.la/anime/some-title-english-7363.html',
            'https://hitomi.la/reader/7363.html'
        ];
        for (const url of galleryPages) {
            assert.strictEqual(resolveListCardPage(url), null,
                url + ' is a single-gallery page and must not resolve to a card row');
        }

        assert.strictEqual(resolveListCardPage('https://example.com/'), null);
        assert.strictEqual(resolveListCardPage(''), null);
    });

    it('extracts bare gallery ids from each site href shape', () => {
        const cases = [
            ['nhentai', '/g/123456/', '123456'],
            ['nhentai', 'https://nhentai.net/g/123456/', '123456'],
            ['hentaifox', '/gallery/173098/', '173098'],
            ['hentaifox', 'https://hentaifox.com/gallery/173098/', '173098'],
            ['imhentai', '/gallery/1738519/', '1738519'],
            ['hentaiera', '/gallery/694133/', '694133'],
            ['hentaienvy', '/gallery/1606086/', '1606086'],
            ['hitomi', 'https://hitomi.la/galleries/12345.html', '12345'],
            ['hitomi', 'https://hitomi.la/anime/isourou-tengoku-1-english-7363.html', '7363'],
            ['hitomi', 'https://hitomi.la/doujinshi/1929348.html', '1929348']
        ];
        for (const [site, href, expected] of cases) {
            const row = LIST_CARD_TARGETS[site];
            assert.strictEqual(cardIdFromHref(row, href), expected,
                site + ': id from ' + href);
        }
        // Non-gallery hrefs never yield an id.
        for (const href of ['/tag/big/', '/category/doujinshi/', '/search/?q=x',
            'https://hitomi.la/index-english.html', '#top', '/language/english/']) {
            for (const site of SUPPORTED_SITES) {
                assert.strictEqual(cardIdFromHref(LIST_CARD_TARGETS[site], href), null,
                    site + ': ' + href + ' must not yield a gallery id');
            }
        }
    });
});
