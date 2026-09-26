// Item 71 — the panel's list actions vs. the on-page Select controls.
//
// Item 61 replaced the old blanket "Download all (N pages)" button with the
// explicit range block, and item 64 made the panel list and the page's cards
// share one selection (`allIds`). Item 71 closes the loop: the panel offers NO
// second multi-page entry, and it says out loud that ticking a card and
// ticking a row are the same act. These assertions are deliberately
// source-level: the panel DOM is rendered from these strings, and the popup
// harness (scripts/e2e-popup.js) separately drives the rendered result.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

describe("item 71 — one multi-page entry, and a pointer to the shared selection", function () {
    it("keeps exactly one multi-page control: the range block's Download range now", function () {
        const popup = read("src/preview/popup.ts");
        assert.ok(popup.indexOf('id="rangeBlock"') !== -1, "the range block is the multi-page path (item 61)");
        assert.ok(popup.indexOf('value="Download range now"') !== -1, "#buttonAll is the range action");
        const buttonAlls = popup.match(/id="buttonAll"/g) || [];
        assert.strictEqual(buttonAlls.length, 1, "exactly one #buttonAll");
        assert.ok(popup.indexOf('value="Download all') === -1,
            "the retired blanket entry must not come back (item 71)");
    });

    it("points at the shared selection where the page has cards", function () {
        const popup = read("src/preview/popup.ts");
        assert.ok(popup.indexOf('id="selectionPointer"') !== -1,
            "the list must say that its rows and the page's cards are one selection (item 71)");
        // The pointer is only meaningful when the page actually has cards: it
        // must be gated on the card list, not rendered unconditionally.
        assert.ok(/id="selectionPointer"[\s\S]{0,400}?allIds\.length/.test(popup)
            || /allIds\.length[\s\S]{0,400}?id="selectionPointer"/.test(popup),
            "the pointer must be tied to the card list (allIds)");
    });

    it("does not promise the retired blanket entry in the List-mode settings hint", function () {
        const settings = read("src/preview/popupSettings.ts");
        assert.ok(settings.indexOf("Download all") === -1,
            "no user-facing copy may promise a \"Download all\" control any more (item 71)");
        assert.ok(/List mode[\s\S]{0,600}?range block/.test(settings),
            "the List-mode hint should name the range block the panel actually has");
    });
});
