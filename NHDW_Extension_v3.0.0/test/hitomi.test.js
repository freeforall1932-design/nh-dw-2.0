const assert = require("assert");
const { hitomiSource } = require("../build/test/sources/hitomiSource");
const { fullPathFromHash, subdomainFromHash, buildHitomiImageUrls } = require("../build/test/sources/hitomiResolver");
const { extractHitomiGallery, extractHitomiReaderImage } = require("../build/test/parsing/hitomiHtml");
const { getSourceForUrl, getSourceForSite } = require("../build/test/sources/index");

describe("Hitomi Adapter & Resolver", () => {
    describe("Hash Path & Subdomain Math", () => {
        const sampleHash = "f123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde2";

        it("computes directory structure from SHA-256 hash", () => {
            const path = fullPathFromHash(sampleHash);
            assert.strictEqual(path, "2/de/" + sampleHash);
        });

        it("computes frontend subdomain prefix from hash", () => {
            const sub = subdomainFromHash(sampleHash, "webp");
            assert.ok(typeof sub === "string" && sub.length >= 2);
        });

        it("builds image mirror URLs from file object", () => {
            const urls = buildHitomiImageUrls({
                hash: sampleHash,
                haswebp: 1,
                name: "01.webp"
            });
            assert.ok(urls.length >= 3);
            assert.ok(urls[0].includes("/webp/2/de/" + sampleHash + ".webp"));
            assert.ok(urls[0].includes("gold-usergeneratedcontent.net"));
        });

        it("supports avif format when requested and available", () => {
            const urls = buildHitomiImageUrls({
                hash: sampleHash,
                hasavif: 1,
                name: "01.avif"
            }, true);
            assert.ok(urls[0].includes("/avif/2/de/" + sampleHash + ".avif"));
        });
    });

    describe("URL Matching & ID Extraction", () => {
        it("matches various Hitomi page and reader URLs", () => {
            assert.strictEqual(hitomiSource.matchesUrl("https://hitomi.la/galleries/123456.html"), true);
            assert.strictEqual(hitomiSource.matchesUrl("https://hitomi.la/doujinshi/sample-title-123456.html"), true);
            assert.strictEqual(hitomiSource.matchesUrl("https://hitomi.la/manga/sample-manga-123456.html"), true);
            assert.strictEqual(hitomiSource.matchesUrl("https://hitomi.la/reader/123456.html#1"), true);
            assert.strictEqual(hitomiSource.matchesUrl("https://nhentai.net/g/123456/"), false);
            assert.strictEqual(hitomiSource.matchesUrl("https://hentaifox.com/gallery/123456/"), false);
        });

        it("extracts numeric gallery id from various slug formats", () => {
            assert.strictEqual(hitomiSource.getGalleryId("https://hitomi.la/galleries/123456.html"), "123456");
            assert.strictEqual(hitomiSource.getGalleryId("https://hitomi.la/doujinshi/cool-artist-doujin-123456.html"), "123456");
            assert.strictEqual(hitomiSource.getGalleryId("https://hitomi.la/reader/123456.html#3"), "123456");
        });

        it("generates gallery and reader URLs", () => {
            assert.strictEqual(hitomiSource.getGalleryUrl("123456"), "https://hitomi.la/galleries/123456.html");
            assert.strictEqual(hitomiSource.getReaderPageUrl("123456", 2), "https://hitomi.la/reader/123456.html#2");
        });

        it("defaults format to raw for Hitomi", () => {
            assert.strictEqual(hitomiSource.defaultFormat, "raw");
        });

        it("validates allowed path regex", () => {
            const regex = hitomiSource.getAllowedPathRegex();
            assert.strictEqual(regex.test("/webp/2/de/f123456789abcdef.webp"), true);
            assert.strictEqual(regex.test("/avif/2/de/f123456789abcdef.avif"), true);
            assert.strictEqual(regex.test("/galleries/123456.js"), true);
        });
    });

    describe("Registry Resolution", () => {
        it("resolves hitomi adapter from URL and site key", () => {
            const byUrl = getSourceForUrl("https://hitomi.la/galleries/123456.html");
            assert.ok(byUrl);
            assert.strictEqual(byUrl.site, "hitomi");

            const bySite = getSourceForSite("hitomi");
            assert.ok(bySite);
            assert.strictEqual(bySite.site, "hitomi");
        });
    });

    describe("HTML & JS Parsing", () => {
        it("extracts gallery metadata from JS galleryinfo assignment", () => {
            const js = `
                var galleryinfo = {
                    "id": "123456",
                    "title": "Hitomi Awesome Doujin",
                    "japanese_title": "Hitomi Nihongo Doujin",
                    "files": [
                        { "hash": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", "haswebp": 1, "hasavif": 0, "name": "01.webp", "width": 1280, "height": 1800 },
                        { "hash": "bcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789a", "haswebp": 1, "hasavif": 1, "name": "02.avif", "width": 1280, "height": 1800 }
                    ],
                    "tags": [{"tag": "female:sole female"}]
                };
            `;
            const gallery = extractHitomiGallery(js);
            assert.ok(gallery);
            assert.strictEqual(gallery.id, "123456");
            assert.strictEqual(gallery.site, "hitomi");
            assert.strictEqual(gallery.title.pretty, "Hitomi Awesome Doujin");
            assert.strictEqual(gallery.title.japanese, "Hitomi Nihongo Doujin");
            assert.strictEqual(gallery.num_pages, 2);
            assert.strictEqual(gallery.images.pages.length, 2);
            assert.strictEqual(gallery.images.pages[0].t, "w");
            assert.strictEqual(gallery.images.pages[1].t, "a");
        });
    });
});
