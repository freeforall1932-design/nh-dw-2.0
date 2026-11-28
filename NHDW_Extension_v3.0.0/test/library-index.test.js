// Library index (INDEXER_PLAN.md §2, Phase 1): the offline index format and
// the in-memory inverted index that makes tag filtering instant. Pure
// modules, compiled through tsconfig.test.json — no browser needed.
//
// Contract pinned here:
//  * parseIndexText() refuses, in words, anything it cannot trust: missing or
//    unsupported _meta header, tag rows after gallery rows, wrong arity,
//    wrong types, count mismatches.
//  * serializeIndex() round-trips what parseIndexText() read — the export
//    path stays symmetric with the import path.
//  * The inverted index is tag AND + title all-words, the same rule as the
//    panel's bookmark search.
//  * Rows stay positional arrays end to end (§8.8): no test re-hydrates one
//    into an object, and neither may production code.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    INDEX_SCHEMA,
    IndexFormatError,
    parseIndexText,
    serializeIndex,
    namespaceLabel,
    ROW,
} = require("../build/test/library/indexFormat.js");
const {
    buildInvertedIndex,
    countByTag,
    filterRows,
    sortRowPositions,
} = require("../build/test/library/invertedIndex.js");
const { SAMPLE_LIBRARY, buildSampleIndex } = require("../build/test/library/sampleIndex.js");

function sampleText() {
    return serializeIndex(SAMPLE_LIBRARY);
}

describe("library index format", () => {
    it("reads the sample index: header, tags, rows, counts agree", () => {
        const parsed = parseIndexText(sampleText());
        assert.strictEqual(parsed.meta.schema, INDEX_SCHEMA);
        assert.strictEqual(parsed.meta.site, "sample");
        assert.strictEqual(parsed.rows.length, SAMPLE_LIBRARY.rows.length);
        assert.strictEqual(parsed.tags.size, SAMPLE_LIBRARY.tags.size);
        assert.strictEqual(parsed.meta.count, parsed.rows.length);
        assert.strictEqual(parsed.meta.tagCount, parsed.tags.size);
    });

    it("keeps rows positional: field positions read back in order", () => {
        const parsed = parseIndexText(sampleText());
        const row = parsed.rows[0];
        assert.strictEqual(typeof row[ROW.ID], "string");
        assert.strictEqual(typeof row[ROW.MEDIA_ID], "string");
        assert.strictEqual(typeof row[ROW.TITLE], "string");
        assert.strictEqual(typeof row[ROW.PAGES], "number");
        assert.strictEqual(typeof row[ROW.UPLOADED], "number");
        assert.ok(Array.isArray(row[ROW.TAG_IDS]));
    });

    it("round-trips serialize -> parse unchanged", () => {
        const once = parseIndexText(sampleText());
        const twice = parseIndexText(serializeIndex(once));
        assert.deepStrictEqual(twice.rows, once.rows);
        assert.strictEqual(twice.tags.size, once.tags.size);
        assert.strictEqual(twice.meta.site, once.meta.site);
    });

    it("tolerates CRLF line endings and a trailing newline", () => {
        const text = sampleText().split("\n").join("\r\n");
        const parsed = parseIndexText(text);
        assert.strictEqual(parsed.rows.length, SAMPLE_LIBRARY.rows.length);
    });

    it("refuses a file without a _meta header", () => {
        assert.throws(() => parseIndexText('{"_t":1,"id":1,"ns":"tag","n":"x","c":1}\n'),
            (e) => e instanceof IndexFormatError && /_meta/.test(e.message));
    });

    it("refuses an unsupported schema version", () => {
        const text = JSON.stringify({ _meta: { schema: 999, site: "x", exported: "", count: 0, tagCount: 0 } }) + "\n";
        assert.throws(() => parseIndexText(text),
            (e) => e instanceof IndexFormatError && /schema/.test(e.message));
    });

    it("refuses tag rows placed after the gallery rows", () => {
        const good = sampleText().split("\n");
        const tagRow = good[1];
        good.splice(1, 1);
        good.push(tagRow, "");
        assert.throws(() => parseIndexText(good.join("\n")),
            (e) => e instanceof IndexFormatError && /before the gallery rows/.test(e.message));
    });

    it("refuses a gallery row with the wrong arity", () => {
        const text = sampleText() + JSON.stringify(["1", "m1", "t", 5, 100, [1], "jpg", "extra"]) + "\n";
        assert.throws(() => parseIndexText(text),
            (e) => e instanceof IndexFormatError && /gallery rows are/.test(e.message));
    });

    it("refuses a gallery row with non-integer pages", () => {
        const text = sampleText() + JSON.stringify(["1", "m1", "t", "many", 100, [1]]) + "\n";
        assert.throws(() => parseIndexText(text),
            (e) => e instanceof IndexFormatError && /pages/.test(e.message));
    });

    it("refuses a header whose count disagrees with the rows", () => {
        const header = JSON.stringify({ _meta: { schema: 1, site: "x", exported: "", count: 7, tagCount: 0 } });
        const text = header + "\n" + JSON.stringify(["1", "m1", "t", 5, 100, []]) + "\n";
        assert.throws(() => parseIndexText(text),
            (e) => e instanceof IndexFormatError && /count says/.test(e.message));
    });

    it("refuses a duplicate tag id", () => {
        const header = JSON.stringify({ _meta: { schema: 1, site: "x", exported: "", count: 0, tagCount: 0 } });
        const tag = JSON.stringify({ _t: 1, id: 5, ns: "tag", n: "vanilla", c: 0 });
        const text = header + "\n" + tag + "\n" + tag + "\n";
        assert.throws(() => parseIndexText(text),
            (e) => e instanceof IndexFormatError && /duplicate tag id/.test(e.message));
    });

    it("labels every namespace for the sidebar", () => {
        assert.strictEqual(namespaceLabel("tag"), "Tags");
        assert.strictEqual(namespaceLabel("artist"), "Artists");
        assert.strictEqual(namespaceLabel("group"), "Groups");
        assert.strictEqual(namespaceLabel("character"), "Characters");
        assert.strictEqual(namespaceLabel("parody"), "Parodies");
        assert.strictEqual(namespaceLabel("language"), "Languages");
    });
});

describe("library inverted index", () => {
    const rows = SAMPLE_LIBRARY.rows;
    const inverted = buildInvertedIndex(rows);

    it("counts rows per tag from the sample data", () => {
        const counts = countByTag(inverted);
        for (const tag of SAMPLE_LIBRARY.tags.values()) {
            assert.strictEqual(counts.get(tag.id), tag.c,
                "tag " + tag.n + " count should match its declared c");
        }
    });

    it("ANDs tag filters: vanilla + english selects only rows carrying both", () => {
        const chosen = filterRows(rows, inverted, { tagIds: [17, 1223], titleWords: [] });
        assert.ok(chosen.length > 0, "sample data must have vanilla+english rows");
        for (const i of chosen) {
            assert.ok(rows[i][ROW.TAG_IDS].indexOf(17) !== -1);
            assert.ok(rows[i][ROW.TAG_IDS].indexOf(1223) !== -1);
        }
    });

    it("an unknown tag yields an empty result, not a crash", () => {
        assert.deepStrictEqual(filterRows(rows, inverted, { tagIds: [999999], titleWords: [] }), []);
    });

    it("title search requires every word (bookmark-search rule)", () => {
        const chosen = filterRows(rows, inverted, { tagIds: [], titleWords: ["sample"] });
        assert.ok(chosen.length > 0);
        for (const i of chosen) {
            assert.ok(rows[i][ROW.TITLE].toLowerCase().indexOf("sample") !== -1);
        }
        const none = filterRows(rows, inverted, { tagIds: [], titleWords: ["sample", "dragon"] });
        assert.strictEqual(none.length, 0);
    });

    it("combines tag AND with title words", () => {
        const both = filterRows(rows, inverted, { tagIds: [17], titleWords: ["sample"] });
        for (const i of both) {
            assert.ok(rows[i][ROW.TAG_IDS].indexOf(17) !== -1);
            assert.ok(rows[i][ROW.TITLE].toLowerCase().indexOf("sample") !== -1);
        }
    });

    it("sorts positions without re-hydrating rows", () => {
        const all = filterRows(rows, inverted, { tagIds: [], titleWords: [] });
        const newest = sortRowPositions([...all], rows, "newest");
        for (let k = 1; k < newest.length; k++) {
            assert.ok(rows[newest[k - 1]][ROW.UPLOADED] >= rows[newest[k]][ROW.UPLOADED]);
        }
        const pages = sortRowPositions([...all], rows, "pages");
        for (let k = 1; k < pages.length; k++) {
            assert.ok(rows[pages[k - 1]][ROW.PAGES] >= rows[pages[k]][ROW.PAGES]);
        }
        const title = sortRowPositions([...all], rows, "title");
        for (let k = 1; k < title.length; k++) {
            assert.ok(rows[title[k - 1]][ROW.TITLE].localeCompare(rows[title[k]][ROW.TITLE]) <= 0);
        }
    });
});

describe("library page hygiene (same rules as the chapter page)", () => {
    const root = path.resolve(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "library.html"), "utf8");

    it("loads its bundled script and never an inline one", () => {
        assert.ok(html.includes("js/library.js"), "the page loads its bundled script");
        assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html),
            "the library page must not use inline scripts under the extension CSP");
    });

    it("embeds no hardcoded site or media URL", () => {
        assert.ok(!/https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, "")),
            "the library page must not embed a hardcoded site or media URL");
    });

    it("carries all five rail sections", () => {
        for (const section of ["browse", "bookmarks", "history", "queue", "settings"]) {
            assert.ok(html.includes('data-section="' + section + '"'), "missing rail entry " + section);
        }
    });
});

describe("bundled sample library", () => {
    it("builds a self-consistent dictionary: every row tag resolves", () => {
        const sample = buildSampleIndex();
        for (const row of sample.rows) {
            for (const tagId of row[ROW.TAG_IDS]) {
                assert.ok(sample.tags.has(tagId), "row tag " + tagId + " must exist in the dictionary");
            }
        }
        const seen = new Set();
        for (const row of sample.rows) {
            assert.ok(!seen.has(row[ROW.ID]), "sample ids must be unique");
            seen.add(row[ROW.ID]);
        }
    });

    it("carries enough english+vanilla rows to demo chip stacking", () => {
        const chosen = filterRows(SAMPLE_LIBRARY.rows, buildInvertedIndex(SAMPLE_LIBRARY.rows),
            { tagIds: [17, 1223], titleWords: [] });
        assert.ok(chosen.length >= 2, "vanilla + english must match several sample rows");
    });
});
