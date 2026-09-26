// Item 70 — the live-session harvest's pure core.
//
// Item 61 fetches listing pages from the panel: bounded, page by page, decided
// by the user's range. This is the other half of the idea, ported from the
// twitter-batch-download project: read what the tab has ALREADY rendered
// (shallow read, no refetch), keep collecting as the page mutates itself
// (infinite scroll, pagination, late-rendered cards), let one click stop it,
// and optionally scroll the page for the user.
//
// Everything decidable without a DOM lives here, so the content script stays a
// thin adapter and this file is unit-tested:
//
//   * the RUN TOKEN. Each start bumps it; late callbacks from a run the user
//     already stopped are rejected. Without this, Stop followed by a fresh
//     Start races: the old run's timer lands and writes into the new one.
//   * dedupe by composite key in FIRST-SEEN order. The page's order is the
//     order the user saw, and it becomes the download order.
//   * the caps. A hard item cap and a round cap for auto-scroll, so the
//     feature cannot walk a site's pagination forever on the user's behalf.
//   * reload survival. The collected cards are persisted; a reload cannot
//     resume scrolling (the old page is gone) but it must not lose the harvest,
//     so the restored state is inactive and the cards merge back into the
//     selection without duplicating.
//
// Stop keeps what was collected. Discarding on Stop would punish the user for
// ending a run early, and the selection is the whole point of collecting.

import { normalizeSite, splitGalleryKey, toGalleryKey } from "./siteKeys";

/** Hard cap on one harvest. The selection list is a working set, not an archive. */
export const HARVEST_MAX_ITEMS = 2000;
/** Delay between auto-scroll steps: polite to the site and to the user's eyes. */
export const HARVEST_INTERVAL_MS = 700;
/** Auto-scroll rounds before the run stops itself and says so. */
export const HARVEST_MAX_ROUNDS = 40;
/** Where a run's cards are persisted so a reload does not lose them. */
export const HARVEST_STORAGE_KEY = "listHarvest";

/** Why a run ended; "" while it is running. */
export type HarvestStopReason = "" | "stopped" | "rounds" | "limit" | "bottom";

export interface HarvestCard {
    id: string;
    site: string;
    title: string;
}

export interface HarvestState {
    v: number;
    /** Run token; only the newest run may write. */
    run: number;
    active: boolean;
    autoScroll: boolean;
    /** Completed auto-scroll steps. */
    round: number;
    /** When the last step happened (ms), 0 before the first. */
    lastRound: number;
    stopReason: HarvestStopReason;
    cards: HarvestCard[];
}

export function emptyHarvestState(): HarvestState {
    return { v: 1, run: 0, active: false, autoScroll: false, round: 0, lastRound: 0, stopReason: "", cards: [] };
}

const STOP_REASONS: HarvestStopReason[] = ["", "stopped", "rounds", "limit", "bottom"];
const CARD_ID = /^[A-Za-z0-9_-]{1,32}$/;

function normalizeCard(raw: any): HarvestCard | null {
    if (raw === null || typeof raw !== "object") {
        return null;
    }
    const id = String(raw.id === undefined || raw.id === null ? "" : raw.id).trim();
    if (!CARD_ID.test(id)) {
        return null;
    }
    return {
        id: id,
        site: normalizeSite(raw.site),
        title: typeof raw.title === "string" ? raw.title : ""
    };
}

/**
 * Tolerant read of a harvest, in either direction:
 *   * from STORAGE (`normalizeHarvestState`), `active` always comes back false:
 *     a reload cannot resume the previous page's scrolling, and claiming
 *     otherwise would leave a run token nobody can stop;
 *   * in MEMORY (every internal call), `active` is preserved - an operation on
 *     a live run must not silently end it. This split is the reason the two
 *     entry points exist: one bug class is "a reload resurrects a dead run"
 *     and the mirror-image one is "reading the state kills the run".
 */
function coerceHarvestState(raw: any, fromStorage: boolean): HarvestState {
    const base = emptyHarvestState();
    if (raw === null || typeof raw !== "object") {
        return base;
    }
    const seen = new Set<string>();
    const cards: HarvestCard[] = [];
    const list = Array.isArray(raw.cards) ? raw.cards : [];
    for (const entry of list) {
        const card = normalizeCard(entry);
        if (card === null) {
            continue;
        }
        const key = toGalleryKey(card.id, card.site);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        cards.push(card);
        if (cards.length >= HARVEST_MAX_ITEMS) {
            break;
        }
    }
    return {
        v: 1,
        run: Number.isFinite(Number(raw.run)) ? Math.max(0, Math.floor(Number(raw.run))) : 0,
        active: fromStorage ? false : raw.active === true,
        autoScroll: raw.autoScroll === true,
        round: Number.isFinite(Number(raw.round)) ? Math.max(0, Math.floor(Number(raw.round))) : 0,
        lastRound: Number.isFinite(Number(raw.lastRound)) ? Math.max(0, Math.floor(Number(raw.lastRound))) : 0,
        stopReason: STOP_REASONS.indexOf(raw.stopReason) !== -1 ? raw.stopReason : "",
        cards: cards
    };
}

/** A persisted harvest: never active (see coerceHarvestState). */
export function normalizeHarvestState(raw: any): HarvestState {
    return coerceHarvestState(raw, true);
}

/**
 * Begin a run. The token moves, so every callback still carrying the previous
 * token is dead from this moment. Collected cards are KEPT: Stop then Start
 * continues a harvest instead of throwing the user's work away.
 */
export function startHarvest(previous: HarvestState, autoScroll: boolean, now: number = Date.now()): HarvestState {
    const base = coerceHarvestState(previous, false);
    return Object.assign({}, base, {
        run: base.run + 1,
        active: true,
        autoScroll: !!autoScroll,
        round: 0,
        lastRound: Number.isFinite(now) ? now : Date.now(),
        stopReason: "" as HarvestStopReason
    });
}

/** Only this state's own, still-active run may write. */
export function isHarvestRun(state: HarvestState, run: number): boolean {
    return !!state && state.active === true && state.run === run;
}

export function stopHarvest(state: HarvestState, reason: HarvestStopReason = "stopped"): HarvestState {
    const base = coerceHarvestState(state, false);
    return Object.assign({}, base, { active: false, stopReason: reason });
}

/**
 * Collect cards. Returns the new state plus how many were actually new, which
 * is what the status line reports ("3 new" is information; a total is noise).
 */
export function harvestAddCards(state: HarvestState, cards: any): { state: HarvestState; added: number } {
    const base = coerceHarvestState(state, false);
    const known = new Set<string>(base.cards.map((card) => toGalleryKey(card.id, card.site)));
    const collected = base.cards.slice();
    let added = 0;
    for (const entry of Array.isArray(cards) ? cards : []) {
        const card = normalizeCard(entry);
        if (card === null) {
            continue;
        }
        const key = toGalleryKey(card.id, card.site);
        if (known.has(key)) {
            continue;
        }
        known.add(key);
        collected.push(card);
        added++;
        if (collected.length >= HARVEST_MAX_ITEMS) {
            break;
        }
    }
    return { state: Object.assign({}, base, { cards: collected }), added: added };
}

/**
 * May the run keep going? The item cap and the round cap both end it; the run
 * itself stays active until the adapter stops it, so the status line can say
 * WHY it ended rather than silently going quiet.
 */
export function harvestShouldContinue(state: HarvestState): boolean {
    return !!state
        && state.active === true
        && (state.cards || []).length < HARVEST_MAX_ITEMS
        && (state.round || 0) < HARVEST_MAX_ROUNDS;
}

/** Count a completed auto-scroll step. */
export function nextHarvestRound(state: HarvestState, now: number = Date.now()): HarvestState {
    const base = coerceHarvestState(state, false);
    return Object.assign({}, base, {
        round: (base.round || 0) + 1,
        lastRound: Number.isFinite(now) ? now : Date.now()
    });
}

/** The status line: what was collected, and what is still happening. */
export function harvestSummary(state: HarvestState): string {
    const base = coerceHarvestState(state, false);
    const count = base.cards.length;
    const collected = count === 1 ? "1 collected" : count + " collected";
    if (base.active) {
        return collected + " \u00b7 still collecting\u2026";
    }
    switch (base.stopReason) {
        case "stopped": return collected + " \u00b7 stopped";
        case "rounds": return collected + " \u00b7 stopped at the scroll limit";
        case "limit": return collected + " \u00b7 item limit reached";
        case "bottom": return collected + " \u00b7 reached the end of the page";
        default: return collected;
    }
}

/**
 * Merge a harvest into a selection of composite keys. The harvest's own order
 * comes first (that is the order the user watched it collect, and it becomes
 * the download order); ids already in the selection follow, minus duplicates.
 * Passing the same state twice is a no-op, so a resume cannot double a row.
 */
export function mergeHarvestIntoSelection(state: HarvestState, selectedKeys: string[]): string[] {
    const base = coerceHarvestState(state, false);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const card of base.cards) {
        const key = toGalleryKey(card.id, card.site);
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(key);
        }
    }
    for (const key of Array.isArray(selectedKeys) ? selectedKeys : []) {
        const normalized = String(key === undefined || key === null ? "" : key).trim();
        if (normalized === "" || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        merged.push(normalized);
    }
    return merged;
}

/** True when a stored selection key belongs to the given site (resume filter). */
export function selectionKeyMatchesSite(key: string, site: string): boolean {
    return splitGalleryKey(key).site === normalizeSite(site);
}
