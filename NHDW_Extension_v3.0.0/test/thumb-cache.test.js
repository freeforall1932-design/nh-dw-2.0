// Phase 3b pure halves (INDEXER_PLAN.md §8.8): the thumbnail cache's LRU
// ledger math and key derivation. Compiled through tsconfig.test.json — the
// OPFS/IndexedDB/fetch glue (thumbCache.ts) is browser-only and stays out.
//
// Contracts pinned here:
//  * thumbKeyFor = sha256 hex of the URL, stable and injective — the OPFS
//    filename IS the key, so nothing path-like can ever reach the filesystem.
//  * evictionPlan: oldest-first, deterministic tie-break, cap 0 disables
//    (everything evictable), and an incoming item bigger than the whole cap
//    is named by the plan so the caller refuses it instead of breaking the cap.
//  * evictionPlan never mutates its input.

const assert = require("assert");
const crypto = require("crypto");
const {
    CACHE_CAP_STORAGE,
    DEFAULT_CACHE_MB,
    THUMB_MODE_STORAGE,
    evictionPlan,
    normalizeThumbMode,
    thumbKeyFor,
    thumbPlan,
    totalBytes,
} = require("../build/test/library/thumbLru.js");
const { LIBRARY_DB_NAME, LIBRARY_DB_VERSION, THUMBS_STORE_NAME, VISITED_STORE_NAME } = require("../build/test/utils/libraryDb.js");

function entry(key, size, lastAccess) {
    return { key, size, lastAccess };
}

describe("thumb cache keys", () => {
    it("matches node's sha256 hex exactly", async () => {
        const url = "https://t.nhentai.net/galleries/m123/thumb.jpg";
        const expected = crypto.createHash("sha256").update(url).digest("hex");
        assert.strictEqual(await thumbKeyFor(url), expected);
        assert.ok(/^[0-9a-f]{64}$/.test(await thumbKeyFor(url)));
    });

    it("is injective and stable", async () => {
        const a = await thumbKeyFor("https://a.example/x.jpg");
        const b = await thumbKeyFor("https://b.example/x.jpg");
        assert.notStrictEqual(a, b);
        assert.strictEqual(await thumbKeyFor("https://a.example/x.jpg"), a);
    });
});

describe("thumb cache LRU eviction plan", () => {
    it("evicts nothing under the cap", () => {
        const entries = [entry("a", 10, 1), entry("b", 10, 2), entry("c", 10, 3)];
        assert.deepStrictEqual(evictionPlan(entries, 100), []);
    });

    it("evicts oldest first until the total fits, newest kept", () => {
        const entries = [entry("a", 10, 1), entry("b", 10, 2), entry("c", 10, 3)];
        const plan = evictionPlan(entries, 20);
        assert.deepStrictEqual(plan, ["a"]);
        const kept = entries.filter((e) => plan.indexOf(e.key) === -1);
        assert.strictEqual(totalBytes(kept) <= 20, true);
        assert.ok(plan.indexOf("c") === -1, "the newest entry survives a normal prune");
    });

    it("breaks lastAccess ties by key, deterministically", () => {
        const entries = [entry("b", 10, 5), entry("a", 10, 5), entry("c", 10, 5)];
        assert.deepStrictEqual(evictionPlan(entries, 30), [], "an exact fit evicts nothing");
        assert.deepStrictEqual(evictionPlan(entries, 20), ["a"], "the key-order tie decides who goes first");
        assert.deepStrictEqual(evictionPlan(entries, 12), ["a", "b"]);
        assert.deepStrictEqual(evictionPlan(entries, 12), evictionPlan(entries.slice().reverse(), 12));
    });

    it("treats cap 0 as disabled: everything is evictable", () => {
        const entries = [entry("a", 1, 1), entry("b", 2, 2)];
        assert.deepStrictEqual(evictionPlan(entries, 0), ["a", "b"]);
    });

    it("names an incoming item bigger than the whole cap so the caller refuses it", () => {
        const entries = [entry("old", 10, 1), entry("huge", 500, 2)];
        const plan = evictionPlan(entries, 100);
        assert.deepStrictEqual(plan, ["old", "huge"], "everything goes; the caller must not cache 'huge'");
    });

    it("never mutates its input", () => {
        const entries = [entry("a", 10, 1), entry("b", 10, 2), entry("c", 10, 3)];
        const snapshot = JSON.stringify(entries);
        evictionPlan(entries, 10);
        assert.strictEqual(JSON.stringify(entries), snapshot);
    });

    it("ignores non-positive sizes in the total", () => {
        const entries = [entry("a", 0, 1), entry("b", -5, 2), entry("c", 8, 3)];
        assert.strictEqual(totalBytes(entries), 8);
        assert.deepStrictEqual(evictionPlan(entries, 8), []);
    });
});

describe("thumbnail source mode (user choice)", () => {
    it("defaults to cached, normalizes junk to cached, honors live", () => {
        assert.strictEqual(normalizeThumbMode(undefined), "cached");
        assert.strictEqual(normalizeThumbMode("nonsense"), "cached");
        assert.strictEqual(normalizeThumbMode("live"), "live");
        assert.strictEqual(normalizeThumbMode("cached"), "cached");
    });

    it("live mode never touches the cache, even when a cached copy exists", () => {
        assert.strictEqual(thumbPlan("live", true), "live");
        assert.strictEqual(thumbPlan("live", false), "live");
    });

    it("cached mode: hit serves the object URL (no network), miss goes live + caches", () => {
        assert.strictEqual(thumbPlan("cached", true), "object-url");
        assert.strictEqual(thumbPlan("cached", false), "live-and-cache");
    });

    it("stores the mode under its own key", () => {
        assert.strictEqual(THUMB_MODE_STORAGE, "libraryThumbMode");
    });
});

describe("thumb cache settings + shared database", () => {
    it("defaults the cap to 2 GB and stores it under its own key", () => {
        assert.strictEqual(DEFAULT_CACHE_MB, 2048);
        assert.strictEqual(CACHE_CAP_STORAGE, "libraryThumbCacheMb");
    });

    it("shares one library database with the visited log, version 2", () => {
        assert.strictEqual(LIBRARY_DB_NAME, "nhdw-library");
        assert.strictEqual(LIBRARY_DB_VERSION, 2, "thumbs ledger joins the visited store in place");
        assert.strictEqual(THUMBS_STORE_NAME, "thumbs");
        assert.strictEqual(VISITED_STORE_NAME, "visited");
    });
});
