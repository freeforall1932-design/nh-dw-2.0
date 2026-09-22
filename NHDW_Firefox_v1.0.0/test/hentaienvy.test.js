const assert = require("assert");
const { hentaienvySource } = require("../build/test/sources/hentaienvySource");
const { extractHentaienvyGallery, extractHentaienvyReaderImage } = require("../build/test/parsing/hentaienvyHtml");
const { getSourceForUrl, getSourceForSite } = require("../build/test/sources/index");

describe("HentaiEnvy Adapter & Parsing", () => {
    describe("URL Matching & ID Extraction", () => {
        it("matches gallery and reader URLs", () => {
            assert.strictEqual(hentaienvySource.matchesUrl("https://hentaienvy.com/gallery/1606086/"), true);
            assert.strictEqual(hentaienvySource.matchesUrl("https://hentaienvy.com/g/1606086/1/"), true);
            assert.strictEqual(hentaienvySource.matchesUrl("https://m11.hentaienvy.com/033/w62za5o4v3/1.webp"), true);
            assert.strictEqual(hentaienvySource.matchesUrl("https://hentaifox.com/gallery/1606086/"), false);
            assert.strictEqual(hentaienvySource.matchesUrl("https://nhentai.net/g/1606086/"), false);
        });

        it("extracts gallery id correctly", () => {
            assert.strictEqual(hentaienvySource.getGalleryId("https://hentaienvy.com/gallery/1606086/"), "1606086");
            assert.strictEqual(hentaienvySource.getGalleryId("https://hentaienvy.com/g/1606086/5/"), "1606086");
            assert.strictEqual(hentaienvySource.getGalleryId("https://hentaienvy.com/search?q=test"), null);
        });

        it("generates gallery and reader URLs", () => {
            assert.strictEqual(hentaienvySource.getGalleryUrl("1606086"), "https://hentaienvy.com/gallery/1606086/");
            assert.strictEqual(hentaienvySource.getReaderPageUrl("1606086", 3), "https://hentaienvy.com/g/1606086/3/");
        });

        it("generates image mirror URLs with unpadded numbering", () => {
            const urls = hentaienvySource.getImageUrls("w62za5o4v3", "1.webp");
            assert.strictEqual(urls[0], "https://m11.hentaienvy.com/033/w62za5o4v3/1.webp");
            assert.strictEqual(urls[1], "https://m1.hentaienvy.com/033/w62za5o4v3/1.webp");
            assert.strictEqual(urls.length, 6);
        });

        it("validates allowed path regex", () => {
            const regex = hentaienvySource.getAllowedPathRegex();
            assert.strictEqual(regex.test("/033/w62za5o4v3/1.webp"), true);
            assert.strictEqual(regex.test("/033/abc123xyz/999.jpg"), true);
            assert.strictEqual(regex.test("/galleries/123/1.jpg"), false);
        });
    });

    describe("Registry Resolution", () => {
        it("resolves hentaienvy adapter from URL and site key", () => {
            const byUrl = getSourceForUrl("https://hentaienvy.com/gallery/1606086/");
            assert.ok(byUrl);
            assert.strictEqual(byUrl.site, "hentaienvy");

            const bySite = getSourceForSite("hentaienvy");
            assert.ok(bySite);
            assert.strictEqual(bySite.site, "hentaienvy");
        });
    });

    describe("HTML Parsing", () => {
        it("extracts gallery metadata from reader page with readerPagesJson", () => {
            const html = `
                <html>
                <head><title>Test HentaiEnvy</title></head>
                <body>
                    <h1 id="gallery-title">Mahou Shoujo no Himitsu</h1>
                    <script type="application/json" id="readerPagesJson">[
                        {"page":1,"ext":"webp","width":1280,"height":1811},
                        {"page":2,"ext":"webp","width":1280,"height":1811},
                        {"page":3,"ext":"jpg","width":1280,"height":1811}
                    ]</script>
                    <img id="readerImg" src="https://m11.hentaienvy.com/033/w62za5o4v3/1.webp" />
                </body>
                </html>
            `;
            const gallery = extractHentaienvyGallery(html);
            assert.ok(gallery);
            assert.strictEqual(gallery.media_id, "w62za5o4v3");
            assert.strictEqual(gallery.title.pretty, "Mahou Shoujo no Himitsu");
            assert.strictEqual(gallery.num_pages, 3);
            assert.strictEqual(gallery.images.pages.length, 3);
            assert.strictEqual(gallery.images.pages[0].t, "w");
            assert.strictEqual(gallery.images.pages[2].t, "j");
        });

        it("extracts gallery metadata from gallery page with thumbs grid", () => {
            const html = `
                <html>
                <head><link rel="canonical" href="https://hentaienvy.com/gallery/1606086/"></head>
                <body>
                    <h1 id="gallery-title">Mahou Shoujo no Himitsu</h1>
                    <div id="js-thumbs-grid" data-gallery-id="1606086" data-total-pages="3" data-title="Mahou Shoujo no Himitsu">
                        <img src="https://m11.hentaienvy.com/033/w62za5o4v3/1t.jpg" />
                    </div>
                </body>
                </html>
            `;
            const gallery = extractHentaienvyGallery(html);
            assert.ok(gallery);
            assert.strictEqual(gallery.id, "1606086");
            assert.strictEqual(gallery.media_id, "w62za5o4v3");
            assert.strictEqual(gallery.num_pages, 3);
            assert.strictEqual(gallery.images.pages.length, 3);
        });

        it("extracts image URL from reader page", () => {
            const html = `<img id="readerImg" src="https://m11.hentaienvy.com/033/w62za5o4v3/1.webp" />`;
            const src = extractHentaienvyReaderImage(html);
            assert.strictEqual(src, "https://m11.hentaienvy.com/033/w62za5o4v3/1.webp");
        });
    });
});
