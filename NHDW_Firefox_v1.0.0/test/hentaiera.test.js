// Fixture tests for the hentaiera adapter (multi-site v4, item 53).
//
// The fixtures mirror the user-captured material from 2026-09-15 (the
// `694133` gallery page on origin/main and the hentaiera HAR): the ld+json
// ImageGallery block, the thumbnail strip `<img data-src="…/<N>t.<ext>">`, and
// the reader page's `<img id="reader_img" src="…/<N>.<ext>">`. No network.
//
// `npm test` compiles the TypeScript under test into build/test first.

const assert = require('assert');
const { hentaieraSource, HENTAIERA_IMAGE_HOST, HENTAIERA_PAGE_HOST } = require('../build/test/sources/hentaieraSource.js');
const { extractHentaieraGallery, extractHentaieraReaderImage } = require('../build/test/parsing/hentaieraHtml.js');
const { looksLikeGallery } = require('../build/test/parsing/GalleryEmbed.js');
const { clearnetSource } = require('../build/test/sources/GallerySource.js');

const GALLERY_694132 = `<!DOCTYPE html><html><head>
<meta name="csrf-token" content="x">
<title>Watashi ga Tsukurimashita. – Manga – HentaiEra</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ImageGallery","name":"(Reitaisai 23) [Toriaezu (Kari) (Tororo)] Watashi ga Tsukurimashita.","url":"https://hentaiera.to/gallery/694132/","image":"https://hentaiera.site/galleries/4182234/cover.webp","thumbnailUrl":"https://hentaiera.site/galleries/4182234/thumb.webp","numberOfItems":10,"genre":"Manga"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body>
<a class="img_box" href="/gallery/694132/1/"><img class="lazy preloader" data-src="https://hentaiera.site/galleries/4182234/1t.webp" alt="Page 1" loading="lazy" decoding="async"></a>
<a class="img_box" href="/gallery/694132/2/"><img class="lazy preloader" data-src="https://hentaiera.site/galleries/4182234/2t.webp" alt="Page 2" loading="lazy" decoding="async"></a>
</body></html>`;

// Same shape but a .jpg gallery — proves the per-gallery extension is read,
// never assumed (the HAR showed jpg and webp galleries in one session).
const GALLERY_JPG = `<!DOCTYPE html><html><head>
<script type="application/ld+json">{"@type":"ImageGallery","name":"Jpg Gallery","image":"https://hentaiera.site/galleries/2351323/cover.jpg","numberOfItems":5}</script>
</head><body>
<img data-src="https://hentaiera.site/galleries/2351323/1t.jpg">
</body></html>`;

const READER_1 = `<!DOCTYPE html><html><body>
<img id="reader_img" src="https://hentaiera.site/galleries/4182234/1.webp" width="1280" height="1791" alt="(Reitaisai 23) page 1 full" fetchpriority="high">
</body></html>`;

describe('hentaieraSource', () => {
    it('matches hentaiera.to and not other sites', () => {
        assert.strictEqual(hentaieraSource.matchesUrl('https://hentaiera.to/gallery/694132/'), true);
        assert.strictEqual(hentaieraSource.matchesUrl('https://hentaiera.to/'), true);
        assert.strictEqual(hentaieraSource.matchesUrl('https://nhentai.net/g/1/'), false);
        assert.strictEqual(hentaieraSource.matchesUrl('https://imhentai.xxx/gallery/1/'), false);
        assert.strictEqual(hentaieraSource.matchesUrl('https://hentaiera.site/galleries/1/1.webp'), false);
    });

    it('extracts the gallery id from gallery and reader URLs', () => {
        assert.strictEqual(hentaieraSource.getGalleryId('https://hentaiera.to/gallery/694132/'), '694132');
        assert.strictEqual(hentaieraSource.getGalleryId('https://hentaiera.to/gallery/694132/3/'), '694132');
        assert.strictEqual(hentaieraSource.getGalleryId('https://hentaiera.to/'), null);
    });

    it('builds gallery, reader-page and image URLs', () => {
        assert.strictEqual(hentaieraSource.getGalleryUrl('694132'), HENTAIERA_PAGE_HOST + '/gallery/694132/');
        assert.strictEqual(hentaieraSource.getGalleryPageUrl('694132'), HENTAIERA_PAGE_HOST + '/gallery/694132/1/');
        assert.deepStrictEqual(
            hentaieraSource.getImageUrls('4182234', '1.webp'),
            [HENTAIERA_IMAGE_HOST + '/galleries/4182234/1.webp']
        );
    });
});

describe('extractHentaieraGallery', () => {
    it('produces the legacy gallery shape from a real gallery page', () => {
        const g = extractHentaieraGallery(GALLERY_694132);
        assert.ok(g, 'expected a gallery');
        assert.strictEqual(g.media_id, '4182234');
        assert.strictEqual(g.num_pages, 10);
        assert.strictEqual(g.images.pages.length, 10);
        assert.ok(g.images.pages.every((p) => p.t === 'w'), 'all pages should map to webp code "w"');
        assert.strictEqual(g.title.english, '(Reitaisai 23) [Toriaezu (Kari) (Tororo)] Watashi ga Tsukurimashita.');
        assert.ok(looksLikeGallery(g), 'must satisfy the shared legacy shape');
    });

    it('reads the per-gallery extension (jpg), never assuming webp', () => {
        const g = extractHentaieraGallery(GALLERY_JPG);
        assert.ok(g);
        assert.strictEqual(g.media_id, '2351323');
        assert.strictEqual(g.num_pages, 5);
        assert.ok(g.images.pages.every((p) => p.t === 'j'), 'all pages should map to jpg code "j"');
    });

    it('returns null for a non-hentaiera page', () => {
        assert.strictEqual(extractHentaieraGallery('<html><body>hello</body></html>'), null);
        assert.strictEqual(extractHentaieraGallery(''), null);
    });
});

describe('extractHentaieraReaderImage', () => {
    it('reads the full-page image off the reader page', () => {
        assert.strictEqual(
            extractHentaieraReaderImage(READER_1),
            'https://hentaiera.site/galleries/4182234/1.webp'
        );
    });

    it('returns null when there is no reader image', () => {
        assert.strictEqual(extractHentaieraReaderImage(GALLERY_694132), null);
    });
});

describe('source registry stays nhentai-clean', () => {
    // Registration of hentaieraSource into sources/index.ts is deliberately
    // deferred to the site-aware wiring (item 48): doing it now would make the
    // popup resolve a hentaiera id and feed it to the nhentai API (id
    // collision). Pin that the default registry still only resolves nhentai.
    it('clearnetSource still owns nhentai and not hentaiera', () => {
        assert.strictEqual(clearnetSource.matchesUrl('https://nhentai.net/g/1/'), true);
        assert.strictEqual(clearnetSource.matchesUrl('https://hentaiera.to/gallery/1/'), false);
    });
});
