const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { hitomiSource } = require("../build/test/sources/hitomiSource");
const {
    parseHitomiGg, hitomiImageNumber, buildHitomiImageUrls, ensureHitomiGg, setHitomiGg, getHitomiGg,
    HITOMI_GG_URL, HITOMI_GG_TTL_MS
} = require("../build/test/sources/hitomiResolver");
const { extractHitomiGallery, extractHitomiReaderImage } = require("../build/test/parsing/hitomiHtml");
const { getSourceForUrl, getSourceForSite } = require("../build/test/sources/index");
const { isAllowedImageUrl } = require("../build/test/sources/cdnConfig");

// Real gg.js and the full-size page requests the browser made with it, from the
// owner's sanitized hitomi capture of 2026-09-22 (captures/ in the repo root).
const GG_TEXT = fs.readFileSync(path.join(__dirname, "fixtures/hitomi/gg-2026-09-22.js"), "utf8");
const CAPTURED_PAGE_URLS = [
    "https://a1.gold-usergeneratedcontent.net/1790046002/3931/a3c45d3aabb085b4789b830706d9f3a211e19da6479f548f57530e97f6b8c5bf.avif",
    "https://a2.gold-usergeneratedcontent.net/1790046002/1212/a8c650cf5c18d63f50bc15c4b6c26f7f8ca9a62fed49a19896c096e7c81febc4.avif",
    "https://a2.gold-usergeneratedcontent.net/1790046002/3345/1de24f1269db3142c604849bafb3e6ab8c9a47007d747f82eb328e1aa87f311d.avif",
    "https://a2.gold-usergeneratedcontent.net/1790046002/1665/4ac8521e1e62bb6b0139ddcdc3f2c70513f0922a854d341f966864f23e65f816.avif"
];
const hashOf = (url) => /([0-9a-f]{64})\.\w+$/.exec(url)[1];

function textResponse(text, status = 200) {
    return { ok: status >= 200 && status < 300, status, statusText: "", text: async () => text };
}

describe("Hitomi Adapter & Resolver", () => {
    afterEach(() => setHitomiGg(null));

    describe("gg.js parsing (text only, never executed)", () => {
        it("reads the prefix, the server table and its default from the captured gg.js", () => {
            const gg = parseHitomiGg(GG_TEXT);
            assert.ok(gg);
            assert.strictEqual(gg.b, "1790046002/");
            assert.strictEqual(gg.defaultM, 1);
            assert.strictEqual(gg.m[1941], 0, "a listed case takes the in-switch value");
            assert.strictEqual(gg.m[825], 0, "the last case before the assignment is included");
            assert.strictEqual(Object.prototype.hasOwnProperty.call(gg.m, 1212), false);
            assert.ok(Object.keys(gg.m).length > 1000);
        });

        it("handles several case groups with different values", () => {
            const text = "gg = { m: function(g) { var o = 0; switch (g) { case 1: case 2: o = 1; break; case 3: o = 2; break; } return o; },\n" +
                "s: function(h) { var m = /(..)(.)$/.exec(h); return parseInt(m[2]+m[1], 16).toString(10); },\nb: '123/' };";
            const gg = parseHitomiGg(text);
            assert.deepStrictEqual(gg, { b: "123/", m: { 1: 1, 2: 1, 3: 2 }, defaultM: 0 });
        });

        it("refuses shapes it does not understand instead of guessing", () => {
            assert.strictEqual(parseHitomiGg(""), null);
            assert.strictEqual(parseHitomiGg("not javascript"), null);
            assert.strictEqual(parseHitomiGg(GG_TEXT.replace("m[2]+m[1]", "m[1]+m[2]")), null, "a changed s() formula");
            assert.strictEqual(parseHitomiGg(GG_TEXT.replace(/b: '[^']*'/, "b: 'x'")), null, "a non-numeric prefix");
            assert.strictEqual(parseHitomiGg(GG_TEXT.replace("var o = 1;", "var o = g;")), null, "a computed default");
            assert.strictEqual(parseHitomiGg(GG_TEXT.replace("o = 0; break;", "")), null, "cases with no assignment");
        });
    });

    describe("page URLs", () => {
        it("reproduces every full-size page request in the capture exactly", () => {
            const gg = parseHitomiGg(GG_TEXT);
            for (const url of CAPTURED_PAGE_URLS) {
                const urls = buildHitomiImageUrls({ hash: hashOf(url), hasavif: 1, name: "x.avif" }, gg, true);
                assert.strictEqual(urls[0], url);
                assert.strictEqual(urls.length, 2, "one alternate server as fallback");
                assert.ok(/^https:\/\/a[12]\./.test(urls[1]) && urls[1] !== urls[0]);
            }
        });

        it("uses gg.s(hash): last hex digit then the two before it", () => {
            assert.strictEqual(hitomiImageNumber("a8c650cf5c18d63f50bc15c4b6c26f7f8ca9a62fed49a19896c096e7c81febc4"), 0x4bc);
            assert.strictEqual(hitomiImageNumber("short"), null);
            assert.strictEqual(hitomiImageNumber("z".repeat(64)), null);
        });

        it("serves webp from the w servers when avif is not available", () => {
            const gg = parseHitomiGg(GG_TEXT);
            const hash = hashOf(CAPTURED_PAGE_URLS[1]);
            assert.strictEqual(buildHitomiImageUrls({ hash, hasavif: 0, name: "x.webp" }, gg)[0],
                "https://w2.gold-usergeneratedcontent.net/1790046002/1212/" + hash + ".webp");
        });

        it("builds nothing without gg.js or a real hash", () => {
            assert.deepStrictEqual(buildHitomiImageUrls({ hash: hashOf(CAPTURED_PAGE_URLS[0]), hasavif: 1, name: "x" }, null), []);
            assert.deepStrictEqual(buildHitomiImageUrls({ hash: "abc", hasavif: 1, name: "x" }, parseHitomiGg(GG_TEXT)), []);
        });

        it("the adapter maps the Downloader's '<hash>.<ext>' name to the same URLs", () => {
            setHitomiGg(parseHitomiGg(GG_TEXT));
            const url = CAPTURED_PAGE_URLS[2];
            assert.strictEqual(hitomiSource.getImageUrls("4203493", hashOf(url) + ".avif")[0], url);
            assert.deepStrictEqual(hitomiSource.getImageUrls("4203493", "3.avif"), [], "no hash, no guess");
        });
    });

    describe("gg.js loading and refresh", () => {
        it("fetches once, shares concurrent requests and caches for the TTL", async () => {
            const calls = [];
            const fetchImpl = async (url, init) => { calls.push({ url, init }); return textResponse(GG_TEXT); };
            const [a, b] = await Promise.all([ensureHitomiGg(fetchImpl, 1000), ensureHitomiGg(fetchImpl, 1000)]);
            assert.strictEqual(a, b);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].url, HITOMI_GG_URL);
            assert.strictEqual(calls[0].init.credentials, "omit");
            await ensureHitomiGg(fetchImpl, 1000 + HITOMI_GG_TTL_MS - 1);
            assert.strictEqual(calls.length, 1, "still fresh");
            await ensureHitomiGg(fetchImpl, 1000 + HITOMI_GG_TTL_MS + 1);
            assert.strictEqual(calls.length, 2, "re-read after the TTL (Hitomi rotates it)");
        });

        it("picks up a rotated prefix on refresh", async () => {
            await ensureHitomiGg(async () => textResponse(GG_TEXT), 0);
            const rotated = GG_TEXT.replace("b: '1790046002/'", "b: '1790049602/'");
            await ensureHitomiGg(async () => textResponse(rotated), HITOMI_GG_TTL_MS + 1);
            assert.strictEqual(getHitomiGg().b, "1790049602/");
        });

        it("keeps the last good copy when a refresh fails, and explains a first failure", async () => {
            await assert.rejects(ensureHitomiGg(async () => textResponse("", 503), 0), /gg\.js\): HTTP 503/);
            await assert.rejects(ensureHitomiGg(async () => textResponse("garbage"), 0), /format was not recognised/);
            await ensureHitomiGg(async () => textResponse(GG_TEXT), 0);
            const kept = await ensureHitomiGg(async () => { throw new Error("offline"); }, HITOMI_GG_TTL_MS + 1);
            assert.strictEqual(kept.b, "1790046002/");
        });

        it("prepareDownload is what the Downloader calls before building URLs", async () => {
            let fetched = 0;
            await hitomiSource.prepareDownload(async () => { fetched++; return textResponse(GG_TEXT); });
            assert.strictEqual(fetched, 1);
            assert.ok(hitomiSource.getImageUrls("1", hashOf(CAPTURED_PAGE_URLS[0]) + ".avif").length === 2);
        });
    });

    describe("image URL allow-list (used for the open-tab fetch)", () => {
        it("accepts exactly the current page-URL shape on the page servers", () => {
            for (const url of CAPTURED_PAGE_URLS) assert.strictEqual(isAllowedImageUrl(url, hitomiSource), true, url);
            const hash = hashOf(CAPTURED_PAGE_URLS[0]);
            const reject = [
                "https://aa.gold-usergeneratedcontent.net/avif/f/bc/" + hash + ".avif",      // the old, wrong layout
                "https://atn.gold-usergeneratedcontent.net/avifsmalltn/f/bc/" + hash + ".avif", // thumbnails
                "https://ltn.gold-usergeneratedcontent.net/galleries/4203493.js",
                "https://a1.gold-usergeneratedcontent.net/1790046002/3931/" + hash + ".avif?x=1",
                "https://a1.evil.example/1790046002/3931/" + hash + ".avif",
                "http://a1.gold-usergeneratedcontent.net/1790046002/3931/" + hash + ".avif"
            ];
            for (const url of reject) assert.strictEqual(isAllowedImageUrl(url, hitomiSource), false, url);
            assert.strictEqual(isAllowedImageUrl(CAPTURED_PAGE_URLS[0]), false, "without the adapter's rules only nhentai passes");
        });

        it("opts into the open-tab image fetch", () => {
            assert.strictEqual(hitomiSource.fetchImagesThroughTab(), true);
        });

        it("the worker relay reads hitomi pages without credentials and refuses anything else", () => {
            const { getConfiguredSources } = require("../build/test/sources/index");
            const { tabFetchCredentialsForUrl } = require("../build/test/background/tabImageFetch");
            const sources = getConfiguredSources();
            // The servers answer Access-Control-Allow-Origin: * (captured), which
            // browsers reject for a credentialed read from the hitomi.la tab.
            assert.strictEqual(tabFetchCredentialsForUrl(CAPTURED_PAGE_URLS[0], sources), "omit");
            assert.strictEqual(tabFetchCredentialsForUrl("https://i.nhentai.net/galleries/987654/1.jpg", sources), "include");
            assert.strictEqual(tabFetchCredentialsForUrl("https://ltn.gold-usergeneratedcontent.net/gg.js", sources), null);
            assert.strictEqual(tabFetchCredentialsForUrl("https://evil.example/x.avif", sources), null);
        });

        it("the injected page fetch honours the credentials mode", async () => {
            const { fetchImageInPage } = require("../build/test/background/tabImageFetch");
            const saved = globalThis.fetch;
            const seen = [];
            globalThis.fetch = async (url, init) => { seen.push(init.credentials); return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/avif" } }); };
            try {
                assert.strictEqual((await fetchImageInPage(CAPTURED_PAGE_URLS[0], "omit")).ok, true);
                await fetchImageInPage("https://i.nhentai.net/galleries/1/1.jpg");
            } finally {
                globalThis.fetch = saved;
            }
            assert.deepStrictEqual(seen, ["omit", "include"]);
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

        it("generates gallery, reader and metadata URLs", () => {
            assert.strictEqual(hitomiSource.getGalleryUrl("123456"), "https://hitomi.la/galleries/123456.html");
            assert.strictEqual(hitomiSource.getReaderPageUrl("123456", 2), "https://hitomi.la/reader/123456.html#2");
            assert.strictEqual(hitomiSource.getMetadataUrl("123456"), "https://ltn.gold-usergeneratedcontent.net/galleries/123456.js");
        });

        it("keeps the declared default format", () => {
            assert.strictEqual(hitomiSource.defaultFormat, "zip", "same as nhentai, imhentai, hentaienvy, hentaifox");
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

    describe("Gallery metadata", () => {
        it("extracts gallery metadata from the galleries/{id}.js assignment", () => {
            const js = `var galleryinfo = {
                "id": "123456",
                "title": "Hitomi {Braces} Doujin",
                "japanese_title": "Hitomi Nihongo Doujin",
                "files": [
                    { "hash": "${hashOf(CAPTURED_PAGE_URLS[0])}", "haswebp": 1, "hasavif": 0, "name": "01.webp", "width": 1280, "height": 1800 },
                    { "hash": "${hashOf(CAPTURED_PAGE_URLS[1])}", "hasavif": 1, "name": "02.png", "width": 1280, "height": 1800 }
                ],
                "tags": [{"tag": "female:sole female"}]
            }`;
            const gallery = extractHitomiGallery(js);
            assert.ok(gallery);
            assert.strictEqual(gallery.id, "123456");
            assert.strictEqual(gallery.site, "hitomi");
            assert.strictEqual(gallery.title.pretty, "Hitomi {Braces} Doujin", "braces inside a title do not break parsing");
            assert.strictEqual(gallery.title.japanese, "Hitomi Nihongo Doujin");
            assert.strictEqual(gallery.num_pages, 2);
            assert.strictEqual(gallery.images.pages[0].t, "w");
            assert.strictEqual(gallery.images.pages[1].t, "a");
            assert.strictEqual(gallery.images.pages[1].hash, hashOf(CAPTURED_PAGE_URLS[1]));
        });

        it("returns null for a rendered gallery page instead of a fake 0-page record", () => {
            // The old fallback read an unrelated number as the id and reported 0 pages.
            const rendered = '<html><head><title>Some Title | Hitomi.la</title></head><body><h1>Read Online</h1>' +
                '<a href="/reader/720.html">read</a><script src="//ltn.gold-usergeneratedcontent.net/galleries/4203493.js"></script></body></html>';
            assert.strictEqual(extractHitomiGallery(rendered), null);
            assert.strictEqual(extractHitomiGallery("var galleryinfo = {\"id\":\"1\",\"files\":[]}"), null);
        });

        it("still reads a reader image tag when one is present", () => {
            assert.strictEqual(extractHitomiReaderImage('<img src="' + CAPTURED_PAGE_URLS[0] + '">'), CAPTURED_PAGE_URLS[0]);
        });
    });
});
