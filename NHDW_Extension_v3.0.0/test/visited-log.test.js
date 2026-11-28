// Phase 3 pure halves (INDEXER_PLAN.md §5/§8): the visited log's validation
// + merge rules, and the Send-to-queue candidate builder + §8.9 chunker.
// Compiled through tsconfig.test.json — no browser, no chrome.*, no network.
//
// Contracts pinned here:
//  * visitInputFromRequest refuses, in words, anything without a usable
//    site:id — the worker stores only validated records (an index file is
//    untrusted input; so is any message).
//  * upsertVisitRecord: a revisit never loses the first date, always bumps
//    the count, fills empty fields from the newer visit, never overwrites
//    known fields with empty ones.
//  * candidateFromGalleryRow: one §2 row -> one BookmarkCandidate the
//    existing bookmarkAdd mutation accepts, with the derived thumb URL and
//    the dictionary-resolved tag names (capped).
//  * chunkArray: the §8.9 guarantee — batches, never one giant write.

const assert = require("assert");
const {
    visitInputFromRequest,
    upsertVisitRecord,
    VISITED_DB_NAME,
    VISITED_STORE,
} = require("../build/test/utils/visitedLog.js");
const {
    SEND_CHUNK,
    MAX_CANDIDATE_TAGS,
    chunkArray,
    candidateFromGalleryRow,
    thumbUrlFor,
} = require("../build/test/library/sendQueue.js");
const { composeGalleryKey, DEFAULT_SITE } = require("../build/test/utils/siteKeys.js");
const { SAMPLE_LIBRARY } = require("../build/test/library/sampleIndex.js");
const { ROW } = require("../build/test/library/indexFormat.js");

describe("visited log input validation", () => {
    it("accepts a well-formed visit and composes the siteKeys key", () => {
        const input = visitInputFromRequest({
            site: "nhentai", id: "366220", title: "T", cover: "https://x/c.jpg",
            pages: 12, sourceUrl: "https://nhentai.net/g/366220/"
        });
        assert.ok(input);
        assert.strictEqual(input.key, "nhentai:366220");
        assert.strictEqual(input.pages, 12);
    });

    it("normalizes a missing site to the default site", () => {
        const input = visitInputFromRequest({ id: "42" });
        assert.ok(input);
        assert.strictEqual(input.site, DEFAULT_SITE);
        assert.strictEqual(input.key, DEFAULT_SITE + ":42");
    });

    it("refuses records without an id, or with a composite id", () => {
        assert.strictEqual(visitInputFromRequest({ site: "nhentai" }), null);
        assert.strictEqual(visitInputFromRequest(null), null);
        assert.strictEqual(visitInputFromRequest({ id: "nhentai:366220" }), null,
            "the worker composes the key itself; a composite id is a caller bug");
    });

    it("coerces bad optional fields instead of storing them", () => {
        const input = visitInputFromRequest({ id: "1", pages: "many", cover: 42, sourceUrl: "javascript:alert(1)" });
        assert.ok(input);
        assert.strictEqual(input.pages, null);
        assert.strictEqual(input.cover, "");
        assert.strictEqual(input.sourceUrl, "", "non-https source URLs are dropped");
    });

    it("names the store so the library page and the worker share it", () => {
        assert.strictEqual(VISITED_DB_NAME, "nhdw-library");
        assert.strictEqual(VISITED_STORE, "visited");
    });
});

describe("visited log merge rules", () => {
    const base = { key: "nhentai:1", site: "nhentai", id: "1", title: "T", cover: "", pages: null, sourceUrl: "" };

    it("a first visit starts count 1 with both dates equal", () => {
        const entry = upsertVisitRecord(null, base, 1000);
        assert.strictEqual(entry.visitCount, 1);
        assert.strictEqual(entry.firstVisited, 1000);
        assert.strictEqual(entry.lastVisited, 1000);
    });

    it("a revisit keeps firstVisited, bumps count and lastVisited", () => {
        const first = upsertVisitRecord(null, base, 1000);
        const second = upsertVisitRecord(first, Object.assign({}, base, { sourceUrl: "https://x/2" }), 2000);
        assert.strictEqual(second.visitCount, 2);
        assert.strictEqual(second.firstVisited, 1000);
        assert.strictEqual(second.lastVisited, 2000);
        assert.strictEqual(second.sourceUrl, "https://x/2", "the newer visit's URL wins");
    });

    it("backfills empty fields from the newer visit, never the reverse", () => {
        const first = upsertVisitRecord(null, base, 1000); // no cover, no pages
        const richer = Object.assign({}, base, { cover: "https://x/c.jpg", pages: 8 });
        const second = upsertVisitRecord(first, richer, 2000);
        assert.strictEqual(second.cover, "https://x/c.jpg");
        assert.strictEqual(second.pages, 8);
        // Now a later, poorer visit must NOT wipe the known fields.
        const third = upsertVisitRecord(second, base, 3000);
        assert.strictEqual(third.cover, "https://x/c.jpg");
        assert.strictEqual(third.pages, 8);
    });
});

describe("send-to-queue candidates", () => {
    const row = SAMPLE_LIBRARY.rows[0];
    const tagNameOf = (tagId) => {
        const tag = SAMPLE_LIBRARY.tags.get(tagId);
        return tag ? tag.n : undefined;
    };

    it("maps one sample row to a bookmarkAdd candidate the worker accepts", () => {
        const candidate = candidateFromGalleryRow("sample", row, tagNameOf);
        assert.strictEqual(candidate.id, row[ROW.ID]);
        assert.strictEqual(candidate.site, "sample");
        assert.strictEqual(candidate.title, row[ROW.TITLE]);
        assert.strictEqual(candidate.pages, row[ROW.PAGES]);
        assert.ok(Array.isArray(candidate.tags) && candidate.tags.length > 0, "dictionary tag names ride along (item 68)");
        assert.strictEqual(candidate.thumbnail, undefined, "the sample source has no derivable thumb host");
    });

    it("derives the nhentai thumb URL from media_id, honoring the stored extension", () => {
        assert.strictEqual(
            thumbUrlFor("nhentai", "m123", "png"),
            "https://t.nhentai.net/galleries/m123/thumb.png");
        assert.strictEqual(thumbUrlFor("nhentai", "m123"), "https://t.nhentai.net/galleries/m123/thumb.jpg");
        assert.strictEqual(thumbUrlFor("sample", "m123"), null);
    });

    it("caps the carried tag names", () => {
        const wideRow = [row[ROW.ID], row[ROW.MEDIA_ID], row[ROW.TITLE], row[ROW.PAGES], row[ROW.UPLOADED],
            Array.from({ length: 40 }, (_, i) => 17 + i)];
        const candidate = candidateFromGalleryRow("nhentai", wideRow, (id) => "tag" + id);
        assert.strictEqual(candidate.tags.length, MAX_CANDIDATE_TAGS);
    });
});

describe("chunked queue writes (§8.9)", () => {
    it("splits selections into SEND_CHUNK batches and never loses a row", () => {
        const items = Array.from({ length: SEND_CHUNK * 2 + 37 }, (_, i) => i);
        const chunks = chunkArray(items, SEND_CHUNK);
        assert.strictEqual(chunks.length, 3);
        assert.strictEqual(chunks[0].length, SEND_CHUNK);
        assert.strictEqual(chunks[2].length, 37);
        assert.deepStrictEqual(chunks.flat(), items);
    });

    it("handles the small and the degenerate cases", () => {
        assert.deepStrictEqual(chunkArray([], 500), []);
        assert.deepStrictEqual(chunkArray([1, 2], 500), [[1, 2]]);
        assert.throws(() => chunkArray([1], 0));
    });
});
