// Item 68 — the Bookmark tab's search / filter / windowing helpers.
//
// These are the pure half of the item: the panel renders with them, so every
// rule the owner asked for (search, tag/artist text, date buckets, status,
// "only selected", the already-downloaded mark, chunked rendering) is pinned
// here without a DOM. The panel-side wiring (elements, marks, chunks) is
// pinned by the e2e-bookmark-panel phases.
//
// Contract notes that matter:
//   * Order is NEVER changed: the stored order is the download order, and the
//     drag handle exists precisely to edit it. Filtering only removes.
//   * The already-downloaded mark is HISTORY, not row status. A row whose
//     status says "done" but that has no history record is NOT marked (the
//     owner's "green check only on true success" rule), and a row that failed
//     after an earlier success IS marked, because the file is on disk.
//   * Text search matches title, id, site and stored tags, term by term (all
//     terms must match), case-insensitively.

const assert = require("node:assert/strict");
const {
    BOOKMARK_PAGE_SIZE,
    BOOKMARK_QUERY_DEFAULTS,
    bookmarkHistoryName,
    bookmarkIsDownloaded,
    bookmarkMatchesQuery,
    bookmarkQuerySummary,
    chunkBookmarkRows,
    isDefaultBookmarkQuery,
    nextBookmarkChunkSize,
    normalizeBookmarkQuery,
    queryBookmarks
} = require("../build/test/utils/bookmarkFilters.js");
const { normalizeBookmarkState, toGalleryKey } = (() => {
    const queue = require("../build/test/utils/bookmarkQueue.js");
    const keys = require("../build/test/utils/siteKeys.js");
    return { normalizeBookmarkState: queue.normalizeBookmarkState, toGalleryKey: keys.toGalleryKey };
})();

const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function item(over) {
    return Object.assign({
        id: "1",
        site: "nhentai",
        title: "Some Title",
        thumbnail: "",
        pages: 10,
        source: "card",
        sourceUrl: "",
        addedAt: NOW - DAY,
        selected: true,
        status: "saved",
        error: "",
        filename: ""
    }, over || {});
}

function state(items) {
    return { v: 1, collapsed: false, items: items };
}

describe("bookmark search and filters (item 68)", () => {
    it("defaults the query to the whole list and normalizes hostile values", () => {
        assert.deepStrictEqual(normalizeBookmarkQuery(undefined), BOOKMARK_QUERY_DEFAULTS);
        assert.deepStrictEqual(normalizeBookmarkQuery({ site: "ALL", text: 7, status: "nope", date: "yesterday" }),
            { site: "all", text: "7", status: "all", date: "all" });
        assert.deepStrictEqual(normalizeBookmarkQuery({ text: "  Pretty  " }).text, "Pretty");
        // A known site survives, unknown ones fall back to all (same rule as item 66).
        assert.strictEqual(normalizeBookmarkQuery({ site: "hitomi" }).site, "hitomi");
        assert.strictEqual(isDefaultBookmarkQuery(BOOKMARK_QUERY_DEFAULTS), true);
        assert.strictEqual(isDefaultBookmarkQuery({ site: "hitomi", text: "", status: "all", date: "all" }), false);
        assert.strictEqual(isDefaultBookmarkQuery({ site: "all", text: "x", status: "all", date: "all" }), false);
    });

    it("searches title, id, site and stored tags, case-insensitively, all terms required", () => {
        const milk = item({ id: "240001", title: "Milky Way", tags: ["artist:someone", "language:english"] });
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "milky" }, NOW), true);
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "240001" }, NOW), true);
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "nhentai" }, NOW), true);
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "english" }, NOW), true);
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "milky way" }, NOW), true);
        // every term must match, in any order
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "milky english" }, NOW), true);
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "english missing" }, NOW), false);
        assert.strictEqual(bookmarkMatchesQuery(milk, { text: "unrelated" }, NOW), false);
        // an item with no tags is still searchable by title/id
        assert.strictEqual(bookmarkMatchesQuery(item({ title: "Plain" }), { text: "plain" }, NOW), true);
    });

    it("filters by status, including the selected-only and saved-only views", () => {
        const rows = [
            item({ id: "1", status: "saved", selected: true }),
            item({ id: "2", status: "done", selected: false }),
            item({ id: "3", status: "failed", selected: true }),
            item({ id: "4", status: "downloading", selected: false })
        ];
        const ids = (query) => queryBookmarks(state(rows), query, NOW).map((row) => row.id);
        assert.deepStrictEqual(ids({ status: "done" }), ["2"]);
        assert.deepStrictEqual(ids({ status: "failed" }), ["3"]);
        assert.deepStrictEqual(ids({ status: "saved" }), ["1"]);
        assert.deepStrictEqual(ids({ status: "selected" }), ["1", "3"]);
        assert.deepStrictEqual(ids({ status: "all" }), ["1", "2", "3", "4"]);
    });

    it("filters by date bucket off the stored addedAt, and reads a clock it is given", () => {
        const rows = [
            item({ id: "today", addedAt: NOW - 60 * 1000 }),
            item({ id: "week", addedAt: NOW - 3 * DAY }),
            item({ id: "month", addedAt: NOW - 20 * DAY }),
            item({ id: "older", addedAt: NOW - 90 * DAY })
        ];
        const ids = (query) => queryBookmarks(state(rows), query, NOW).map((row) => row.id);
        assert.deepStrictEqual(ids({ date: "today" }), ["today"]);
        assert.deepStrictEqual(ids({ date: "week" }), ["today", "week"]);
        assert.deepStrictEqual(ids({ date: "month" }), ["today", "week", "month"]);
        assert.deepStrictEqual(ids({ date: "older" }), ["older"]);
    });

    it("composes site, text, status and date, and never reorders the stored list", () => {
        const rows = [
            item({ id: "3", site: "nhentai", title: "Zeta", addedAt: NOW - 2 * DAY }),
            item({ id: "1", site: "hitomi", title: "Alpha", addedAt: NOW - 2 * DAY }),
            item({ id: "2", site: "nhentai", title: "Alpha Again", addedAt: NOW - 40 * DAY })
        ];
        const hitomi = queryBookmarks(state(rows), { site: "hitomi" }, NOW);
        assert.deepStrictEqual(hitomi.map((row) => row.id), ["1"]);
        // Site + text compose: the hitomi "Alpha" is excluded by the site, and
        // the nhentai "Zeta" by the text.
        assert.deepStrictEqual(queryBookmarks(state(rows), { site: "nhentai", text: "alpha" }, NOW).map((row) => row.id), ["2"]);
        // Date narrows an otherwise matching set to the older row only.
        assert.deepStrictEqual(queryBookmarks(state(rows), { text: "alpha", date: "older" }, NOW).map((row) => row.id), ["2"]);
        // Site + date, no text.
        assert.deepStrictEqual(queryBookmarks(state(rows), { site: "nhentai", date: "week" }, NOW).map((row) => row.id), ["3"]);
        // Order is the download order, so a plain filter keeps it intact.
        assert.deepStrictEqual(queryBookmarks(state(rows), {}, NOW).map((row) => row.id), ["3", "1", "2"]);
    });

    it("marks a row as downloaded from HISTORY only, never from its status", () => {
        const historyKeys = [toGalleryKey("1", "nhentai"), toGalleryKey("2", "hitomi")];
        assert.strictEqual(bookmarkIsDownloaded(item({ id: "1", site: "nhentai" }), historyKeys), true);
        // Same number, other site: the composite key is what makes the mark right.
        assert.strictEqual(bookmarkIsDownloaded(item({ id: "1", site: "hentaifox" }), historyKeys), false);
        // The owner's rule: a row that only SAYS done is not marked...
        assert.strictEqual(bookmarkIsDownloaded(item({ id: "9", status: "done" }), historyKeys), false);
        // ...while a failed retry of a title that IS on disk stays marked.
        assert.strictEqual(bookmarkIsDownloaded(item({ id: "2", site: "hitomi", status: "failed" }), historyKeys), true);
    });

    it("names the artifact behind the mark, tolerating a bare-id history", () => {
        const history = { "nhentai:1": { filename: "NHDW/One.zip", when: NOW } };
        assert.strictEqual(bookmarkHistoryName(item({ id: "1" }), history), "NHDW/One.zip");
        assert.strictEqual(bookmarkHistoryName(item({ id: "2" }), history), "");
        assert.strictEqual(bookmarkHistoryName(item({ id: "1", site: "hitomi" }), history), "");
        assert.strictEqual(bookmarkHistoryName(item({ id: "1" }), null), "");
    });

    it("summarizes the filtered view for the panel's own line", () => {
        const rows = [
            item({ id: "1", selected: true }),
            item({ id: "2", selected: false }),
            item({ id: "3", selected: true })
        ];
        const summary = bookmarkQuerySummary(rows, [toGalleryKey("1", "nhentai")]);
        assert.deepStrictEqual(summary, { matched: 3, alreadyDownloaded: 1, selected: 2, downloadNow: 1 });
        // "downloadNow" is what the queue would actually fetch: selected rows
        // the history does not already record (row 1 is selected AND recorded,
        // so it is not counted).
        assert.deepStrictEqual(bookmarkQuerySummary([item({ id: "1", selected: false })], [toGalleryKey("1", "nhentai")]),
            { matched: 1, alreadyDownloaded: 1, selected: 0, downloadNow: 0 });
    });

    it("windows the rows so a huge list keeps a bounded DOM", () => {
        const rows = [];
        for (let i = 0; i < 1000; i++) {
            rows.push(item({ id: String(i) }));
        }
        assert.strictEqual(BOOKMARK_PAGE_SIZE, 200);
        assert.strictEqual(chunkBookmarkRows(rows, BOOKMARK_PAGE_SIZE).length, 200);
        assert.strictEqual(chunkBookmarkRows(rows, BOOKMARK_PAGE_SIZE)[199].id, "199");
        // The chunk keeps the order it was given.
        assert.deepStrictEqual(chunkBookmarkRows(rows, 3).map((row) => row.id), ["0", "1", "2"]);
        // A shown count past the end, or a hostile one, degrades instead of throwing.
        assert.strictEqual(chunkBookmarkRows(rows, 5000).length, 1000);
        assert.strictEqual(chunkBookmarkRows(rows, -5).length, 0);
        assert.strictEqual(nextBookmarkChunkSize(200, 1000), 400);
        assert.strictEqual(nextBookmarkChunkSize(900, 1000), 1000);
        assert.strictEqual(nextBookmarkChunkSize(1000, 1000), 1000);
    });

    it("keeps stored tags through a state round trip and tolerates junk", () => {
        const normalized = normalizeBookmarkState({
            v: 1,
            collapsed: false,
            items: [
                { id: "1", site: "nhentai", title: "Tagged", tags: ["artist:a", "", 7, "language:english"] },
                { id: "2", site: "nhentai", title: "Untagged" }
            ]
        });
        assert.deepStrictEqual(normalized.items[0].tags, ["artist:a", "language:english"]);
        assert.deepStrictEqual(normalized.items[1].tags, []);
    });
});
