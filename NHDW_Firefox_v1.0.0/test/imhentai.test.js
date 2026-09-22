const assert = require("assert");
const { imhentaiSource } = require("../build/test/sources/imhentaiSource");
const { extractImhentaiGallery, extractImhentaiReaderImage } = require("../build/test/parsing/imhentaiHtml");
const { getSourceForUrl, getSourceForSite } = require("../build/test/sources/index");

describe("ImHentai Adapter & Parsing", () => {
    describe("URL Matching & ID Extraction", () => {
        it("matches gallery and reader URLs", () => {
            assert.strictEqual(imhentaiSource.matchesUrl("https://imhentai.xxx/gallery/1304561/"), true);
            assert.strictEqual(imhentaiSource.matchesUrl("https://imhentai.xxx/view/1304561/1/"), true);
            assert.strictEqual(imhentaiSource.matchesUrl("https://m11.imhentai.xxx/033/w62za5o4v3/1.webp"), true);
            assert.strictEqual(imhentaiSource.matchesUrl("https://hentaiera.com/gallery/1304561/"), false);
            assert.strictEqual(imhentaiSource.matchesUrl("https://nhentai.net/g/1304561/"), false);
        });

        it("extracts gallery id correctly", () => {
            assert.strictEqual(imhentaiSource.getGalleryId("https://imhentai.xxx/gallery/1304561/"), "1304561");
            assert.strictEqual(imhentaiSource.getGalleryId("https://imhentai.xxx/view/1304561/12/"), "1304561");
            assert.strictEqual(imhentaiSource.getGalleryId("https://imhentai.xxx/search?key=test"), null);
        });

        it("generates gallery and reader URLs", () => {
            assert.strictEqual(imhentaiSource.getGalleryUrl("1304561"), "https://imhentai.xxx/gallery/1304561/");
            assert.strictEqual(imhentaiSource.getReaderPageUrl("1304561", 5), "https://imhentai.xxx/view/1304561/5/");
        });

        it("generates image mirror URLs with unpadded numbering", () => {
            const urls = imhentaiSource.getImageUrls("w62za5o4v3", "1.webp");
            assert.strictEqual(urls[0], "https://m11.imhentai.xxx/033/w62za5o4v3/1.webp");
            assert.strictEqual(urls[1], "https://m1.imhentai.xxx/033/w62za5o4v3/1.webp");
            assert.strictEqual(urls.length, 6);
        });

        it("validates allowed path regex", () => {
            const regex = imhentaiSource.getAllowedPathRegex();
            assert.strictEqual(regex.test("/033/w62za5o4v3/1.webp"), true);
            assert.strictEqual(regex.test("/033/abc123xyz/999.jpg"), true);
            assert.strictEqual(regex.test("/galleries/123/1.jpg"), false);
            assert.strictEqual(regex.test("/033/token/../evil.jpg"), false);
        });
    });

    describe("Registry Resolution", () => {
        it("resolves imhentai adapter from URL and site key", () => {
            const byUrl = getSourceForUrl("https://imhentai.xxx/gallery/1304561/");
            assert.ok(byUrl);
            assert.strictEqual(byUrl.site, "imhentai");

            const bySite = getSourceForSite("imhentai");
            assert.ok(bySite);
            assert.strictEqual(bySite.site, "imhentai");
        });
    });

    describe("HTML Parsing", () => {
        it("extracts gallery metadata from gallery page HTML", () => {
            const html = `
                <html>
                <head><title>Test ImHentai</title></head>
                <body>
                    <input type="hidden" id="gallery_id" value="1304561" />
                    <input type="hidden" id="load_id" value="w62za5o4v3" />
                    <input type="hidden" id="load_dir" value="033" />
                    <input type="hidden" id="load_server" value="11" />
                    <input type="hidden" id="load_pages" value="3" />
                    <input type="hidden" id="gallery_title" value="My Awesome ImHentai Doujinshi" />
                    <script>
                        var g_th = $.parseJSON('{"1":"w,1280,1807","2":"w,1280,1807","3":"p,1280,1807"}');
                    </script>
                </body>
                </html>
            `;
            const gallery = extractImhentaiGallery(html);
            assert.ok(gallery);
            assert.strictEqual(gallery.id, "1304561");
            assert.strictEqual(gallery.media_id, "w62za5o4v3");
            assert.strictEqual(gallery.title.pretty, "My Awesome ImHentai Doujinshi");
            assert.strictEqual(gallery.num_pages, 3);
            assert.strictEqual(gallery.images.pages.length, 3);
            assert.strictEqual(gallery.images.pages[0].t, "w");
            assert.strictEqual(gallery.images.pages[1].t, "w");
            assert.strictEqual(gallery.images.pages[2].t, "p");
        });

        it("extracts image URL from reader page HTML", () => {
            const html = `
                <html>
                <body>
                    <img id="gimg" src="https://m11.imhentai.xxx/033/w62za5o4v3/1.webp" alt="Page 1" />
                </body>
                </html>
            `;
            const src = extractImhentaiReaderImage(html);
            assert.strictEqual(src, "https://m11.imhentai.xxx/033/w62za5o4v3/1.webp");
        });

        it("returns null on empty or invalid HTML", () => {
            assert.strictEqual(extractImhentaiGallery(""), null);
            assert.strictEqual(extractImhentaiGallery("<div>Hello</div>"), null);
            assert.strictEqual(extractImhentaiReaderImage(""), null);
        });
    });
});
