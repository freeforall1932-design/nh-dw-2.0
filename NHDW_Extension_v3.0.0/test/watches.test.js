// Phase 4 pure halves (INDEXER_PLAN.md §6): the watch model, the refresh
// query builder (sort=date pinned per §8.4), the early-stop step decision,
// the card→row mapping for refresh, the merge with recomputed counts, the
// new-badge key set, the sequential engine over a fake fetch, and the §7
// download-options builder. No network, no browser.

const assert = require("assert");
const {
    WATCHES_STORAGE,
    MAX_PAGES_PER_TAG,
    REFRESH_PER_PAGE,
    Watch,
    cardToRefreshRow,
    createWatch,
    mergeRefreshRows,
    newKeysForWatch,
    refreshStep,
    sanitizeWatchList,
    watchUrlFor,
} = require("../build/test/library/watches.js");
const { refreshWatch } = require("../build/test/library/watchRefresh.js");
const { BYPASS_SAVE_AS_STORAGE, downloadOptionsFor } = require("../build/test/background/downloadControl.js");
const { ROW } = require("../build/test/library/indexFormat.js");

function card(id, extra) {
    return Object.assign({
        id,
        media_id: "m" + id,
        title: { english: "Title " + id },
        num_pages: 10,
        upload_date: 1700000000 + id,
        thumbnail: { path: "/galleries/m" + id + "/thumb.jpg" },
        tag_ids: [17], // listing-card shape: bare ids resolved against the dictionary
    }, extra || {});
}

describe("watch model", () => {
    it("creates a sorted, de-duplicated watch with clean status", () => {
        const watch = createWatch("w1", "nhentai", [1223, 17, 17], "vanilla + english", 1000);
        assert.deepStrictEqual(watch.tagIds, [17, 1223]);
        assert.strictEqual(watch.label, "vanilla + english");
        assert.strictEqual(watch.createdAt, 1000);
        assert.strictEqual(watch.lastRefresh, null);
        assert.strictEqual(watch.lastError, "");
        assert.deepStrictEqual(watch.newKeys, []);
    });

    it("sanitizeWatchList drops junk and keeps good rows", () => {
        const good = createWatch("w1", "nhentai", [17], "vanilla", 5);
        const junk = [null, {}, { id: "" }, { id: "w2", site: "x", tagIds: [], label: "" }, { id: "w3", site: "x", tagIds: ["a"], label: "x" }, good];
        const kept = sanitizeWatchList(junk);
        assert.strictEqual(kept.length, 1);
        assert.strictEqual(kept[0].id, "w1");
        assert.deepStrictEqual(sanitizeWatchList("nonsense"), []);
    });

    it("names its storage key", () => {
        assert.strictEqual(WATCHES_STORAGE, "libraryWatches");
    });
});

describe("refresh query builder (§8.4)", () => {
    it("pins sort=date and the documented parameters", () => {
        const url = watchUrlFor("https://nhentai.net", 17, 2);
        assert.ok(url.includes("/api/v2/galleries/tagged"), "the documented listing endpoint");
        assert.ok(url.includes("tag_id=17"));
        assert.ok(url.includes("sort=date"), "a popular sort would early-stop wrongly");
        assert.ok(url.includes("page=2"));
        assert.ok(url.includes("per_page=" + REFRESH_PER_PAGE));
        assert.ok(REFRESH_PER_PAGE <= 100, "per_page stays in the documented 1-100 range");
        assert.ok(MAX_PAGES_PER_TAG > 0);
    });

    it("clamps out-of-range per_page and pages", () => {
        assert.ok(watchUrlFor("https://x", 1, -5).includes("page=1"));
        assert.ok(watchUrlFor("https://x", 1, 1, 500).includes("per_page=" + REFRESH_PER_PAGE));
    });
});

describe("early-stop step decision", () => {
    it("collects everything before the first known id and stops", () => {
        const known = new Set(["3"]);
        const step = refreshStep([card(1), card(2), card(3), card(4)], known);
        assert.deepStrictEqual(step.collect.map((c) => String(c.id)), ["1", "2"]);
        assert.strictEqual(step.stop, true);
    });

    it("an all-unknown page collects everything and continues", () => {
        const step = refreshStep([card(1), card(2)], new Set());
        assert.strictEqual(step.collect.length, 2);
        assert.strictEqual(step.stop, false);
    });

    it("an empty page ends the walk", () => {
        assert.strictEqual(refreshStep([], new Set()).stop, true);
    });

    it("a known first id collects nothing but still stops", () => {
        const step = refreshStep([card(9)], new Set(["9"]));
        assert.deepStrictEqual(step.collect, []);
        assert.strictEqual(step.stop, true);
    });
});

describe("card mapping for refresh", () => {
    it("full tag objects extend the dictionary; category has no namespace", () => {
        const tags = new Map();
        const stats = { mappedRows: 0, skippedCards: 0, droppedTagIds: new Set() };
        const row = cardToRefreshRow(card(1, {
            tags: [
                { id: 17, type: "tag", name: "vanilla" },
                { id: 1223, type: "language", name: "english" },
                { id: 9, type: "category", name: "manga" },
            ],
        }), tags, new Set(), stats);
        assert.strictEqual(tags.get(17).n, "vanilla");
        assert.strictEqual(tags.get(1223).ns, "language");
        assert.strictEqual(tags.has(9), false);
        assert.ok(row[ROW.TAG_IDS].indexOf(17) !== -1 && row[ROW.TAG_IDS].indexOf(1223) !== -1);
        assert.strictEqual(row[ROW.THUMB_EXT], "jpg");
        assert.strictEqual(stats.mappedRows, 1);
    });

    it("bare tag_ids resolve; unknown ids drop with a count, never guessed", () => {
        const tags = new Map([[17, { id: 17, ns: "tag", n: "vanilla", c: 0 }]]);
        const stats = { mappedRows: 0, skippedCards: 0, droppedTagIds: new Set() };
        const row = cardToRefreshRow(card(2, { tag_ids: [17, 999999] }), tags, new Set(), stats);
        assert.deepStrictEqual(row[ROW.TAG_IDS], [17]);
        assert.ok(stats.droppedTagIds.has(999999));
    });

    it("an id already known (index or this refresh) maps to nothing", () => {
        const stats = { mappedRows: 0, skippedCards: 0, droppedTagIds: new Set() };
        const tags = new Map();
        assert.strictEqual(cardToRefreshRow(card(1), tags, new Set(["1"]), stats), null);
        assert.strictEqual(cardToRefreshRow(null, tags, new Set(), stats), null);
        assert.strictEqual(stats.skippedCards, 1);
    });
});

describe("merge with recomputed counts", () => {
    it("appends new rows, never overwrites existing ones, recounts every tag", () => {
        const rows = [["1", "m1", "Old", 5, 100, [17]]];
        const tags = new Map([[17, { id: 17, ns: "tag", n: "vanilla", c: 99 }]]);
        const mappedTags = new Map([[17, { id: 17, ns: "tag", n: "vanilla", c: 0 }], [21, { id: 21, ns: "tag", n: "comedy", c: 0 }]]);
        const collected = [["1", "m1", "Newer Old (must be ignored)", 5, 100, [17]], ["2", "m2", "New", 8, 200, [17, 21]]];
        const merged = mergeRefreshRows(rows, tags, collected, mappedTags);
        assert.strictEqual(merged.addedCount, 1);
        assert.strictEqual(merged.rows.length, 2);
        assert.strictEqual(merged.rows[0][ROW.TITLE], "Old", "local wins: the existing row is kept");
        assert.strictEqual(merged.tags.get(17).c, 2, "counts recomputed from merged rows");
        assert.strictEqual(merged.tags.get(21).c, 1);
    });
});

describe("new-badge key set", () => {
    it("keys only the newly appended rows matching ALL of the watch's tags", () => {
        const rows = [
            ["1", "m1", "existing vanilla", 1, 1, [17]],
            ["2", "m2", "new vanilla+english", 1, 2, [17, 1223]],
            ["3", "m3", "new vanilla only", 1, 3, [17]],
        ];
        const keys = newKeysForWatch("nhentai", rows, 1, [17, 1223]);
        assert.deepStrictEqual(keys, ["nhentai:2"]);
    });
});

describe("sequential refresh engine (fake fetch)", () => {
    function baseWatch() {
        return createWatch("w1", "nhentai", [17], "vanilla", 0);
    }
    function baseSource() {
        return {
            site: "nhentai",
            rows: [["1", "m1", "Known", 5, 100, [17]]],
            tags: new Map([[17, { id: 17, ns: "tag", n: "vanilla", c: 1 }]]),
        };
    }

    it("walks newest-first, early-stops on the first known id, merges the new", async () => {
        const pages = {
            1: [card(30), card(20)], // both unknown
            2: [card(10), card(1)],  // card(1) is known → stop here
        };
        const calls = [];
        const outcome = await refreshWatch(baseWatch(), baseSource(), {
            minIntervalMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async (url) => {
                calls.push(url);
                const page = Number(/page=(\d+)/.exec(url)[1]);
                return { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ result: pages[page] || [] }) };
            },
        });
        assert.ok(calls.every((u) => u.includes("sort=date")), "every request pins sort=date");
        assert.strictEqual(outcome.stopped, false);
        assert.strictEqual(outcome.addedCount, 3);
        assert.deepStrictEqual(outcome.newKeys, ["nhentai:30", "nhentai:20", "nhentai:10"], "badge set is the watch's combination");
        assert.strictEqual(outcome.rows.length, 4);
        assert.ok(outcome.lines.some((l) => l.startsWith("vanilla: 3 new")));
    });

    it("walks the watch's tags in sequence, one after another", async () => {
        const watch = createWatch("w2", "nhentai", [17, 1223], "vanilla + english", 0);
        const order = [];
        const outcome = await refreshWatch(watch, baseSource(), {
            minIntervalMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async (url) => {
                order.push(Number(/tag_id=(\d+)/.exec(url)[1]));
                return { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ result: [] }) };
            },
        });
        assert.deepStrictEqual(order, [17, 1223], "tags are walked strictly in sequence");
        assert.strictEqual(outcome.stopped, false);
    });

    it("a 429 stops the walk with words and keeps partial progress", async () => {
        let call = 0;
        const outcome = await refreshWatch(baseWatch(), baseSource(), {
            minIntervalMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async () => {
                call++;
                if (call === 1) {
                    return { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ result: [card(30)] }) };
                }
                return { status: 429, headers: { get: (h) => (h === "retry-after" ? "30" : null) }, text: async () => "" };
            },
        });
        assert.strictEqual(outcome.stopped, true);
        assert.strictEqual(outcome.addedCount, 1, "progress made before the stop is kept");
        assert.ok(outcome.lines.some((l) => l.includes("429")));
        assert.ok(outcome.newKeys.indexOf("nhentai:30") !== -1);
    });

    it("a Cloudflare challenge stops with words, never a bypass attempt", async () => {
        const outcome = await refreshWatch(baseWatch(), baseSource(), {
            minIntervalMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async () => ({
                status: 403,
                headers: { get: () => "text/html" },
                text: async () => "<!DOCTYPE html><title>Just a moment...</title>",
            }),
        });
        assert.strictEqual(outcome.stopped, true);
        assert.ok(outcome.lines.some((l) => l.includes("Cloudflare")));
        assert.strictEqual(outcome.addedCount, 0);
    });

    it("a 404 past page 1 is the depth cap: keeps what it found, not fatal", async () => {
        const outcome = await refreshWatch(baseWatch(), baseSource(), {
            minIntervalMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async (url) => {
                if (url.includes("page=2")) {
                    return { status: 404, headers: { get: () => null }, text: async () => "" };
                }
                return { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ result: [card(30)] }) };
            },
        });
        assert.strictEqual(outcome.stopped, false, "a cap is not an error stop");
        assert.strictEqual(outcome.addedCount, 1);
        assert.ok(outcome.lines.some((l) => l.includes("depth cap")));
    });

    it("refuses a cross-site refresh in words", async () => {
        const outcome = await refreshWatch(baseWatch(), { site: "imhentai", rows: [], tags: new Map() }, {
            fetchImpl: async () => { throw new Error("must not be called"); },
        });
        assert.strictEqual(outcome.stopped, false);
        assert.ok(outcome.lines[0].includes("imhentai"));
    });

    it("keyed refreshes send the documented Authorization header", async () => {
        let auth = null;
        await refreshWatch(baseWatch(), baseSource(), {
            apiKey: "K9",
            minIntervalMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async (url, init) => {
                auth = init.headers["Authorization"];
                return { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ result: [] }) };
            },
        });
        assert.strictEqual(auth, "Key K9");
    });
});

describe("download save-as bypass (§7)", () => {
    it("off by default: no saveAs key at all (browser behavior untouched)", () => {
        const options = downloadOptionsFor("https://blob/x", "Title [1].zip", false);
        assert.deepStrictEqual(options, { url: "https://blob/x", filename: "Title [1].zip", conflictAction: "uniquify" });
        assert.strictEqual("saveAs" in options, false);
    });

    it("on: saveAs is only ever false (suppress, never force)", () => {
        const options = downloadOptionsFor("https://blob/x", "Title [1].zip", true);
        assert.strictEqual(options.saveAs, false);
    });

    it("names its storage key", () => {
        assert.strictEqual(BYPASS_SAVE_AS_STORAGE, "bypassSaveAs");
    });
});
