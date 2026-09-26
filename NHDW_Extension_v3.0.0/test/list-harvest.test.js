// Item 70 — the live-session harvest's pure core.
//
// Item 61 fetches listing pages from the panel (bounded, page by page). This is
// the other half: read what the tab has ALREADY rendered, keep collecting as the
// page mutates (infinite scroll / pagination), and let one click stop it. The
// DOM side lives in listControls.ts; everything decidable without a DOM is here:
//
//   * the run token — only the newest run may write, so a Stop plus a fresh
//     Start can never be clobbered by the run it replaced;
//   * dedupe by composite key, in first-seen order (the page's own order is the
//     order the user saw);
//   * the caps: a hard item cap and a round cap for the optional auto-scroll,
//     so the feature cannot scroll a site forever;
//   * state that survives a reload: the collected cards are stored, and a
//     resumed run merges them back into the selection without duplicating.

const assert = require("node:assert/strict");
const {
    HARVEST_INTERVAL_MS,
    HARVEST_MAX_ITEMS,
    HARVEST_MAX_ROUNDS,
    HARVEST_STORAGE_KEY,
    emptyHarvestState,
    harvestAddCards,
    harvestShouldContinue,
    harvestSummary,
    isHarvestRun,
    mergeHarvestIntoSelection,
    nextHarvestRound,
    selectionKeyMatchesSite,
    normalizeHarvestState,
    startHarvest,
    stopHarvest
} = require("../build/test/utils/listHarvest.js");

const cards = (ids, site) => ids.map((id) => ({ id: id, site: site || "nhentai", title: "T " + id }));

describe("live-session harvest (item 70)", () => {
    it("starts and stops with a run token only the newest run owns", () => {
        const first = startHarvest(emptyHarvestState(), false);
        assert.strictEqual(first.active, true);
        assert.strictEqual(first.run, 1);
        assert.strictEqual(isHarvestRun(first, first.run), true);
        const second = startHarvest(first, true);
        assert.strictEqual(second.run, 2);
        assert.strictEqual(second.autoScroll, true);
        // The replaced run's token is dead: its late callbacks cannot write.
        assert.strictEqual(isHarvestRun(second, first.run), false);
        assert.strictEqual(isHarvestRun(second, second.run), true);
        const stopped = stopHarvest(second, "stopped");
        assert.strictEqual(stopped.active, false);
        assert.strictEqual(stopped.stopReason, "stopped");
        assert.strictEqual(isHarvestRun(stopped, second.run), false);
    });

    it("collects cards once each, in first-seen order, keyed by site", () => {
        let state = startHarvest(emptyHarvestState(), false);
        let result = harvestAddCards(state, cards(["3", "1", "3"]));
        state = result.state;
        assert.strictEqual(result.added, 2);
        assert.deepStrictEqual(state.cards.map((card) => card.id), ["3", "1"]);
        // A second sweep (the observer fires on every mutation) adds only what is new.
        result = harvestAddCards(state, cards(["1", "2"]));
        assert.strictEqual(result.added, 1);
        assert.deepStrictEqual(result.state.cards.map((card) => card.id), ["3", "1", "2"]);
        // The same bare id on another site is a different card.
        result = harvestAddCards(result.state, cards(["3"], "hitomi"));
        assert.strictEqual(result.added, 1);
        assert.deepStrictEqual(result.state.cards.map((card) => card.site), ["nhentai", "nhentai", "nhentai", "hitomi"]);
        // Junk ids are dropped, not collected as empty rows.
        result = harvestAddCards(result.state, [{ id: "", site: "nhentai" }, { id: " 7 ", site: "nhentai" }, null]);
        assert.strictEqual(result.added, 1);
        assert.strictEqual(result.state.cards[result.state.cards.length - 1].id, "7");
    });

    it("stops at the item cap and at the auto-scroll round cap", () => {
        let state = startHarvest(emptyHarvestState(), true);
        const many = [];
        for (let i = 0; i < HARVEST_MAX_ITEMS + 50; i++) {
            many.push({ id: "g" + i, site: "nhentai" });
        }
        state = harvestAddCards(state, many).state;
        assert.strictEqual(state.cards.length, HARVEST_MAX_ITEMS);
        assert.strictEqual(state.active, true); // the cap stops auto-scroll, not the collection
        assert.strictEqual(harvestShouldContinue(state), false);
        // Rounds: a run that keeps finding nothing must still end.
        let rounds = startHarvest(emptyHarvestState(), true);
        for (let i = 0; i < HARVEST_MAX_ROUNDS; i++) {
            rounds = nextHarvestRound(rounds, 1000 + i * HARVEST_INTERVAL_MS);
        }
        assert.strictEqual(rounds.round, HARVEST_MAX_ROUNDS);
        assert.strictEqual(harvestShouldContinue(rounds), false);
        // A quiet run with rounds left is allowed to keep going.
        assert.strictEqual(harvestShouldContinue(startHarvest(emptyHarvestState(), true)), true);
    });

    it("says what it is doing, and what it did", () => {
        const running = harvestAddCards(startHarvest(emptyHarvestState(), true), cards(["1"])).state;
        assert.strictEqual(harvestSummary(running), "1 collected · still collecting…");
        const many = harvestAddCards(startHarvest(emptyHarvestState(), true), cards(["1", "2"])).state;
        assert.strictEqual(harvestSummary(many), "2 collected · still collecting…");
        const done = stopHarvest(many, "stopped");
        assert.strictEqual(harvestSummary(done), "2 collected · stopped");
        const capped = stopHarvest(many, "rounds");
        assert.strictEqual(harvestSummary(capped), "2 collected · stopped at the scroll limit");
        const empty = stopHarvest(startHarvest(emptyHarvestState(), false), "bottom");
        assert.strictEqual(harvestSummary(empty), "0 collected · reached the end of the page");
    });

    it("survives a reload: normalizes stored state and merges it into the selection", () => {
        assert.strictEqual(HARVEST_STORAGE_KEY, "listHarvest");
        const restored = normalizeHarvestState({
            v: 1,
            run: 4,
            active: true,
            autoScroll: true,
            round: 3,
            stopReason: "",
            cards: [{ id: "5", site: "nhentai", title: "Five" }, { id: "5", site: "nhentai" }, { id: "", site: "nhentai" }]
        });
        assert.deepStrictEqual(restored.cards.map((card) => card.id), ["5"]);
        assert.strictEqual(restored.autoScroll, true);
        // A reload cannot resume the tab's scrolling; it must not claim to.
        assert.strictEqual(restored.active, false);
        assert.deepStrictEqual(normalizeHarvestState(null), emptyHarvestState());
        assert.deepStrictEqual(normalizeHarvestState({ cards: "nope" }).cards, []);
        // Merging keeps the harvest's order in front and never duplicates.
        const merged = mergeHarvestIntoSelection(restored, ["nhentai:5", "nhentai:9"]);
        assert.deepStrictEqual(merged, ["nhentai:5", "nhentai:9"]);
        const fresh = mergeHarvestIntoSelection(harvestAddCards(emptyHarvestState(), cards(["7", "8"])).state, ["nhentai:9"]);
        assert.deepStrictEqual(fresh, ["nhentai:7", "nhentai:8", "nhentai:9"]);
        // The page's selection is stamped with ONE site, so the adapter keeps
        // only the keys this page owns: the same number elsewhere is a
        // different title, and a bare key reads as the default site.
        assert.strictEqual(selectionKeyMatchesSite("hitomi:7", "hitomi"), true);
        assert.strictEqual(selectionKeyMatchesSite("hitomi:7", "nhentai"), false);
        assert.strictEqual(selectionKeyMatchesSite("7", "nhentai"), true);
        assert.strictEqual(selectionKeyMatchesSite("7", "hitomi"), false);
    });
});
