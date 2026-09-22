const assert = require("assert");
const { hentaifoxSource } = require("../build/test/sources/hentaifoxSource");
const { extractHentaifoxGallery, extractHentaifoxReaderImage } = require("../build/test/parsing/hentaifoxHtml");
const { getSourceForUrl, getSourceForSite } = require("../build/test/sources/index");

describe("HentaiFox Adapter & Parsing", () => {
    describe("URL Matching & ID Extraction", () => {
        it("matches gallery and reader URLs", () => {
            assert.strictEqual(hentaifoxSource.matchesUrl("https://hentaifox.com/gallery/173098/"), true);
            assert.strictEqual(hentaifoxSource.matchesUrl("https://hentaifox.com/g/173098/1/"), true);
            assert.strictEqual(hentaifoxSource.matchesUrl("https://i3.hentaifox.com/005/4190711/1.jpg"), true);
            assert.strictEqual(hentaifoxSource.matchesUrl("https://hentaienvy.com/gallery/173098/"), false);
            assert.strictEqual(hentaifoxSource.matchesUrl("https://nhentai.net/g/173098/"), false);
        });

        it("extracts gallery id correctly", () => {
            assert.strictEqual(hentaifoxSource.getGalleryId("https://hentaifox.com/gallery/173098/"), "173098");
            assert.strictEqual(hentaifoxSource.getGalleryId("https://hentaifox.com/g/173098/5/"), "173098");
            assert.strictEqual(hentaifoxSource.getGalleryId("https://hentaifox.com/tag/comic/"), null);
        });

        it("generates gallery and reader URLs", () => {
            assert.strictEqual(hentaifoxSource.getGalleryUrl("173098"), "https://hentaifox.com/gallery/173098/");
            assert.strictEqual(hentaifoxSource.getReaderPageUrl("173098", 2), "https://hentaifox.com/g/173098/2/");
        });

        it("generates image mirror URLs with unpadded numbering and directory prefix", () => {
            const urls = hentaifoxSource.getImageUrls("005/4190711", "1.jpg");
            assert.strictEqual(urls[0], "https://i.hentaifox.com/005/4190711/1.jpg");
            assert.strictEqual(urls[1], "https://i1.hentaifox.com/005/4190711/1.jpg");
            assert.strictEqual(urls[3], "https://i3.hentaifox.com/005/4190711/1.jpg");
            assert.strictEqual(urls.length, 5);
        });

        it("validates allowed path regex for /004/ and /005/ patterns", () => {
            const regex = hentaifoxSource.getAllowedPathRegex();
            assert.strictEqual(regex.test("/005/4190711/1.jpg"), true);
            assert.strictEqual(regex.test("/004/4163347/10.png"), true);
            assert.strictEqual(regex.test("/galleries/123/1.jpg"), false);
            assert.strictEqual(regex.test("/005/4190711/../evil.php"), false);
        });
    });

    describe("Registry Resolution", () => {
        it("resolves hentaifox adapter from URL and site key", () => {
            const byUrl = getSourceForUrl("https://hentaifox.com/gallery/173098/");
            assert.ok(byUrl);
            assert.strictEqual(byUrl.site, "hentaifox");

            const bySite = getSourceForSite("hentaifox");
            assert.ok(bySite);
            assert.strictEqual(bySite.site, "hentaifox");
        });
    });

    describe("HTML Parsing", () => {
        it("extracts gallery metadata from gallery page HTML", () => {
            const html = `
                <html>
                <head><title>HentaiFox Test</title></head>
                <body>
                    <input type="hidden" id="gallery_id" value="173098" />
                    <input type="hidden" id="load_id" value="4190711" />
                    <input type="hidden" id="load_dir" value="005" />
                    <input type="hidden" id="gallery_title" value="Test Doujin Title" />
                    <script>
                        var g_th = $.parseJSON('{"1":"j,1280,1807","2":"j,1280,1807","3":"p,1280,1807"}');
                    </script>
                </body>
                </html>
            `;
            const gallery = extractHentaifoxGallery(html);
            assert.ok(gallery);
            assert.strictEqual(gallery.id, "173098");
            assert.strictEqual(gallery.media_id, "005/4190711");
            assert.strictEqual(gallery.title.pretty, "Test Doujin Title");
            assert.strictEqual(gallery.num_pages, 3);
            assert.strictEqual(gallery.images.pages.length, 3);
            assert.strictEqual(gallery.images.pages[0].t, "j");
            assert.strictEqual(gallery.images.pages[2].t, "p");
        });

        it("extracts image URL from reader page", () => {
            const html = `<img id="gimg" src="https://i3.hentaifox.com/005/4190711/1.jpg" />`;
            const src = extractHentaifoxReaderImage(html);
            assert.strictEqual(src, "https://i3.hentaifox.com/005/4190711/1.jpg");
        });
    });
});
