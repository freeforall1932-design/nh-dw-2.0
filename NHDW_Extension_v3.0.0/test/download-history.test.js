// Persistent download history: keying, normalization, skip partitioning and
// the chrome.storage.local record/clear contract.
//
// These are the rules that make re-running a listing skip galleries that were
// already downloaded instead of producing "Title (1).zip", "Title (2).zip" ...
// No browser needed: the module under test is dependency-free (chrome.storage
// is only touched inside the storage functions, which are exercised here with
// a tiny in-memory stub).

const assert = require('assert');
const {
    DOWNLOAD_HISTORY_KEY,
    normalizeHistory,
    historyIds,
    countHistory,
    partitionKnown,
    artifactRecordFilename,
    historyRecords,
    batchDateStamp,
    applyBatchDate,
    batchCandidateNames,
    pickFreeBatchFilename,
    readHistory,
    recordHistory,
    clearHistory
} = require('../build/test/utils/downloadHistory.js');

// Tiny chrome.storage.local stub so the storage functions can run in Node.
function installChromeStub() {
    const store = {};
    const chrome = {
        runtime: { lastError: null },
        storage: {
            local: {
                get(defaults, cb) {
                    const out = Object.assign({}, defaults);
                    for (const key of Object.keys(store)) {
                        out[key] = store[key];
                    }
                    cb(out);
                },
                set(items, cb) {
                    Object.assign(store, items);
                    if (cb) cb();
                },
                remove(key, cb) {
                    delete store[key];
                    if (cb) cb();
                }
            }
        }
    };
    return { chrome, store };
}

describe('download history (pure)', () => {
    it('normalizes valid records and drops corrupt entries', () => {
        const raw = {
            "123456": { filename: "NHDW/Title.zip", when: 1700000000000 },
            "654321": { filename: "Title 2.cbz", when: 1700000000001 },
            "999999": { filename: "broken", when: "not-a-number" },
            "000000": "garbage",
            "111111": null
        };
        const history = normalizeHistory(raw);
        assert.deepStrictEqual(historyIds(history), ["123456", "654321", "999999"]);
        assert.strictEqual(history["123456"].filename, "NHDW/Title.zip");
        assert.ok(history["999999"].when === 0, 'non-numeric when must fall back to 0');
        assert.ok(!Object.prototype.hasOwnProperty.call(history, "000000"));
        assert.ok(!Object.prototype.hasOwnProperty.call(history, "111111"));
    });

    it('ignores non-object history shapes instead of throwing', () => {
        assert.deepStrictEqual(normalizeHistory(null), {});
        assert.deepStrictEqual(normalizeHistory(undefined), {});
        assert.deepStrictEqual(normalizeHistory([]), {});
        assert.deepStrictEqual(normalizeHistory("nope"), {});
    });

    it('counts only real entries', () => {
        assert.strictEqual(countHistory(normalizeHistory({ "1": { filename: "a", when: 1 } })), 1);
        assert.strictEqual(countHistory(normalizeHistory({ "1": {}, "2": "x" })), 0);
    });

    it('splits candidates into download / skip by recorded + redownload ids', () => {
        const history = normalizeHistory({ "111": { filename: "A.zip", when: 1 }, "222": { filename: "B.zip", when: 2 } });
        assert.deepStrictEqual(partitionKnown(history, ["111", "222", "333"]), { download: ["333"], skip: ["111", "222"] });
        assert.deepStrictEqual(partitionKnown(history, ["111", "222", "333"], ["222"]), { download: ["222", "333"], skip: ["111"] });
        assert.deepStrictEqual(partitionKnown(history, [], []), { download: [], skip: [] });
        // Unrecorded ids always download even when they appear in redownloadIds.
        assert.deepStrictEqual(partitionKnown(history, ["999"], ["999"]), { download: ["999"], skip: [] });
    });

    it('formats the recorded artifact filename like the pipeline saves it', () => {
        assert.strictEqual(artifactRecordFilename({ format: "zip", name: "Test", masterFolder: "" }), "Test.zip");
        assert.strictEqual(artifactRecordFilename({ format: "cbz", name: "Test", masterFolder: "NHDW" }), "NHDW/Test.cbz");
        assert.strictEqual(artifactRecordFilename({ format: "pdf", name: "Test", masterFolder: "NHDW" }), "NHDW/Test.pdf");
        assert.strictEqual(artifactRecordFilename({ format: "raw", name: "Test", masterFolder: "NHDW" }), "NHDW/Test/001.jpg");
        assert.strictEqual(artifactRecordFilename({ format: "raw", name: "Test", masterFolder: "" }), "Test/001.jpg");
        // The retired "folder" format still maps to pdf.
        assert.strictEqual(artifactRecordFilename({ format: "folder", name: "Old", masterFolder: "" }), "Old.pdf");
        // Master folder "/" edges are trimmed, never doubled.
        assert.strictEqual(artifactRecordFilename({ format: "zip", name: "Test", masterFolder: "/NHDW/" }), "NHDW/Test.zip");
    });

    it('keeps separate-mode per-gallery records as-is', () => {
        const outcome = {
            records: [{ id: "1", filename: "A.zip" }, { id: "2", filename: "B.zip" }],
            clean: true,
            batchKeys: [],
            skipped: 0
        };
        assert.deepStrictEqual(
            historyRecords(outcome, { effectiveSeparate: true, format: "zip", finalName: "Merged", archiveMasterFolder: "" }),
            outcome.records
        );
    });

    it('records a fully clean merged batch under the merged file name', () => {
        const outcome = { records: [], clean: true, batchKeys: ["1", "2"], skipped: 0 };
        assert.deepStrictEqual(
            historyRecords(outcome, { effectiveSeparate: false, format: "zip", finalName: "Merged (2)", archiveMasterFolder: "NHDW" }),
            [{ id: "1", filename: "NHDW/Merged (2).zip" }, { id: "2", filename: "NHDW/Merged (2).zip" }]
        );
    });

    it('records NOTHING for a merged batch that was not fully clean', () => {
        const outcome = { records: [], clean: false, batchKeys: ["1", "2"], skipped: 0 };
        assert.deepStrictEqual(
            historyRecords(outcome, { effectiveSeparate: false, format: "zip", finalName: "Merged", archiveMasterFolder: "" }),
            []
        );
    });
});

describe('merge naming: date stamp + part numbering', () => {
    // 2026-08-31 local time.
    const NOW = new Date(2026, 7, 31, 12, 0, 0).getTime();

    it('stamps DDMMYYYY (31082026 style, no separators)', () => {
        assert.strictEqual(batchDateStamp(NOW), "31082026");
        assert.strictEqual(batchDateStamp(new Date(2026, 0, 5).getTime()), "05012026");
    });

    it('appends the date once and never double-stamps', () => {
        assert.strictEqual(applyBatchDate("search", NOW), "search_31082026");
        assert.strictEqual(applyBatchDate("search_31082026", NOW), "search_31082026");
        assert.strictEqual(applyBatchDate("search_31082026_part2", NOW), "search_31082026_part2");
        assert.strictEqual(applyBatchDate("", NOW), "31082026");
    });

    it('builds base, base_part2, base_part3 ... candidates', () => {
        assert.deepStrictEqual(batchCandidateNames("x", 4), ["x", "x_part2", "x_part3", "x_part4"]);
        assert.deepStrictEqual(batchCandidateNames("x", 1), ["x"]);
    });

    it('record-only mode: a recorded name moves to the next part', () => {
        const history = normalizeHistory({ "1": { filename: "x.zip", when: 1 } });
        assert.strictEqual(
            pickFreeBatchFilename(history, "x", "zip", { verify: false, presentFilenames: new Set() }),
            "x_part2.zip"
        );
        const history2 = normalizeHistory({
            "1": { filename: "x.zip", when: 1 },
            "2": { filename: "x_part2.zip", when: 2 }
        });
        assert.strictEqual(
            pickFreeBatchFilename(history2, "x", "zip", { verify: false, presentFilenames: new Set() }),
            "x_part3.zip"
        );
    });

    it('verify mode: a present file moves to the next part; a deleted file reuses its name', () => {
        // Recorded AND still on disk -> the new copy must not overwrite it.
        const history = normalizeHistory({ "1": { filename: "x.zip", when: 1 } });
        const present = new Set(["x.zip"]);
        assert.strictEqual(
            pickFreeBatchFilename(history, "x", "zip", { verify: true, presentFilenames: present }),
            "x_part2.zip"
        );
        // Recorded but deleted -> the old name is free again (no part growth).
        assert.strictEqual(
            pickFreeBatchFilename(history, "x", "zip", { verify: true, presentFilenames: new Set() }),
            "x.zip"
        );
        // First two parts present -> part 3.
        assert.strictEqual(
            pickFreeBatchFilename(history, "x", "zip", { verify: true, presentFilenames: new Set(["x.zip", "x_part2.zip"]) }),
            "x_part3.zip"
        );
        // A file on disk WITHOUT a record (pre-3.5.0 run) still blocks the name.
        assert.strictEqual(
            pickFreeBatchFilename({}, "x", "zip", { verify: true, presentFilenames: new Set(["x.zip"]) }),
            "x_part2.zip"
        );
    });

    it('multi-page suffix: the part number sits on the base, before the page marker', () => {
        // downloadAllPages saves "<base>[_partN] (lastPage)"; the page marker
        // must never move between the base and the part number.
        const base = "Pages_31082026";
        const suffix = " (2)";
        assert.strictEqual(
            pickFreeBatchFilename({}, base, "zip", { verify: false, presentFilenames: new Set(), suffix: suffix }),
            "Pages_31082026 (2).zip"
        );
        const present = new Set(["Pages_31082026 (2).zip"]);
        assert.strictEqual(
            pickFreeBatchFilename({}, base, "zip", { verify: true, presentFilenames: present, suffix: suffix }),
            "Pages_31082026_part2 (2).zip"
        );
        // A deleted part-2 file is reused, with the page marker intact.
        assert.strictEqual(
            pickFreeBatchFilename({}, base, "zip", { verify: true, presentFilenames: new Set(), suffix: suffix }),
            "Pages_31082026 (2).zip"
        );
    });

    it('falls back to the last candidate rather than blocking when every part is occupied', () => {
        // Default candidate count is 10; every one present -> the last is
        // returned and Chrome's conflictAction uniquifies from there.
        const present = new Set(batchCandidateNames("x").map((n) => n + ".zip"));
        assert.strictEqual(
            pickFreeBatchFilename({}, "x", "zip", { verify: true, presentFilenames: present }),
            "x_part10.zip"
        );
    });
});

describe('download history (chrome.storage.local)', () => {
    let chrome;
    let store;

    beforeEach(() => {
        const installed = installChromeStub();
        chrome = installed.chrome;
        store = installed.store;
        global.chrome = chrome;
    });

    afterEach(() => {
        delete global.chrome;
    });

    it('records id -> {filename, when} only for valid entries', async () => {
        await recordHistory([
            { id: "123456", filename: "NHDW/Title.zip" },
            { id: "", filename: "ignored" },
            { id: "654321", filename: "" },
            null
        ]);
        const history = await readHistory();
        assert.strictEqual(countHistory(history), 1);
        assert.strictEqual(history["123456"].filename, "NHDW/Title.zip");
        assert.ok(typeof history["123456"].when === "number" && history["123456"].when > 0);
        assert.deepStrictEqual(Object.keys(store), [DOWNLOAD_HISTORY_KEY]);
    });

    it('merges new records without losing existing ones', async () => {
        await recordHistory([{ id: "1", filename: "A.zip" }]);
        await recordHistory([{ id: "2", filename: "B.zip" }]);
        const history = await readHistory();
        assert.deepStrictEqual(historyIds(history).sort(), ["1", "2"]);
    });

    it('#clearHistory removes the whole list', async () => {
        await recordHistory([{ id: "1", filename: "A.zip" }]);
        await clearHistory();
        assert.deepStrictEqual(await readHistory(), {});
        assert.deepStrictEqual(Object.keys(store), []);
    });

    it('normalizes whatever a corrupt store contains', async () => {
        store[DOWNLOAD_HISTORY_KEY] = { "1": { filename: "A.zip", when: 3 }, "2": "junk" };
        const history = await readHistory();
        assert.deepStrictEqual(historyIds(history), ["1"]);
    });
});
