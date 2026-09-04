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
