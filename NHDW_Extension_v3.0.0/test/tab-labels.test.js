// Item 65 — the panel's third tab is the user's Bookmark list.
//
// The rename is UI-only on purpose: the tab is labelled "Bookmark", and no
// user-facing copy calls it a "Queue" any more. Everything the code and the
// stored data depend on keeps its old name — the `bookmarkQueue` storage key,
// the `#tabQueue` / `#queuePane` element ids, the `nhdwBm*` row classes, the
// `bookmarkGet` / `bookmarkImport` message actions and the export format.
// This file locks both halves so a future "cleanup" cannot quietly rename a
// persisted key, or re-label the tab.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

describe("item 65 — the Queue tab is the Bookmark tab in every user-facing string", function () {
    it("labels #tabQueue \"Bookmark\" in index.html", function () {
        const html = read("index.html");
        const match = /<button id="tabQueue"[^>]*>([^<]*)<\/button>/.exec(html);
        assert.ok(match, "index.html must keep a #tabQueue button (it is the click hook)");
        assert.strictEqual(match[1].trim(), "Bookmark");
    });

    it("keeps every internal name the rename must not touch", function () {
        const html = read("index.html");
        assert.ok(html.indexOf('id="tabQueue"') !== -1, "#tabQueue id stays");
        assert.ok(html.indexOf('id="queuePane"') !== -1, "#queuePane id stays");
        const queue = read("src/utils/bookmarkQueue.ts");
        assert.ok(queue.indexOf('BOOKMARK_QUEUE_KEY') !== -1, "the bookmarkQueue storage key stays");
        assert.ok(queue.indexOf('"bookmarkQueue"') !== -1 || /BOOKMARK_QUEUE_KEY\s*=\s*"bookmarkQueue"/.test(queue),
            "the persisted key is still the literal \"bookmarkQueue\"");
    });

    it("drops the old wording from user-facing copy", function () {
        const banned = {
            "src/preview/popupSettings.ts": ["Queue tab", "Queue panel"],
            "src/content/listControls.ts": ["Queue panel"],
            "src/utils/bookmarkQueue.ts": ["(Queue tab)"],
            "src/utils/titleBookmark.ts": ["(Queue tab)"],
        };
        for (const file of Object.keys(banned)) {
            const text = read(file);
            for (const needle of banned[file]) {
                assert.ok(text.indexOf(needle) === -1,
                    file + " must not say \"" + needle + "\" any more");
            }
        }
    });

    it("actually says Bookmark where the old copy said Queue", function () {
        const expected = {
            "src/preview/popupSettings.ts": ["Bookmark tab", "Open the dockable Bookmark panel"],
            "src/content/listControls.ts": ["Bookmark panel"],
            "src/utils/bookmarkQueue.ts": ["(Bookmark tab)"],
            "src/utils/titleBookmark.ts": ["(Bookmark tab)"],
        };
        for (const file of Object.keys(expected)) {
            const text = read(file);
            for (const needle of expected[file]) {
                assert.ok(text.indexOf(needle) !== -1,
                    file + " must say \"" + needle + "\" (item 65 renamed the copy)");
            }
        }
    });
});
