// In-memory inverted index over the compact gallery rows (INDEXER_PLAN.md §2):
// tag -> set of row positions, built once at import so a tag click is a set
// intersection — instant, offline, no site round-trips.
//
// Pure module, node-testable. Rows stay positional ARRAYS end to end (§8.8):
// nothing here re-hydrates a row into an object; comparators read fields off
// the tuples via the ROW positions from indexFormat.ts.

import { GalleryRow, ROW } from "./indexFormat";

/** tag id -> set of row positions within one source's rows array. */
export type InvertedIndex = Map<number, Set<number>>;

export function buildInvertedIndex(rows: GalleryRow[]): InvertedIndex {
    const map: InvertedIndex = new Map();
    for (let i = 0; i < rows.length; i++) {
        const tagIds = rows[i][ROW.TAG_IDS];
        for (const tagId of tagIds) {
            let set = map.get(tagId);
            if (!set) {
                set = new Set();
                map.set(tagId, set);
            }
            set.add(i);
        }
    }
    return map;
}

export interface FilterOptions {
    /** Rows must carry EVERY one of these tags (AND — chip stacking). */
    tagIds: number[];
    /** Title must contain every word (case-insensitive) — same "all words
        must match" rule as the panel's bookmark search. */
    titleWords: string[];
}

/** AND-filter row positions for one source. Empty filters select everything. */
export function filterRows(rows: GalleryRow[], inverted: InvertedIndex, options: FilterOptions): number[] {
    const tagIds = options.tagIds;
    let candidates: Set<number> | null = null;
    for (const tagId of tagIds) {
        const set = inverted.get(tagId);
        if (!set || set.size === 0) return [];
        candidates = candidates === null ? new Set(set) : intersect(candidates, set);
        if (candidates.size === 0) return [];
    }
    const words = options.titleWords.map((w) => w.toLowerCase()).filter((w) => w !== "");
    const out: number[] = [];
    const source = candidates === null ? indicesOf(rows) : candidates;
    for (const i of source) {
        if (words.length > 0) {
            const title = rows[i][ROW.TITLE].toLowerCase();
            let ok = true;
            for (const word of words) {
                if (title.indexOf(word) === -1) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
        }
        out.push(i);
    }
    return out;
}

function indicesOf(rows: GalleryRow[]): number[] {
    const out: number[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) out[i] = i;
    return out;
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    const out = new Set<number>();
    for (const value of small) if (large.has(value)) out.add(value);
    return out;
}

/** Rows per tag id — cheaper than re-scanning when the sidebar re-renders. */
export function countByTag(inverted: InvertedIndex): Map<number, number> {
    const out = new Map<number, number>();
    for (const [tagId, set] of inverted) out.set(tagId, set.size);
    return out;
}

export type SortMode = "newest" | "oldest" | "pages" | "title";

/** Sort row positions in place by the chosen mode. Reads tuples directly. */
export function sortRowPositions(positions: number[], rows: GalleryRow[], mode: SortMode): number[] {
    switch (mode) {
        case "newest":
            return positions.sort((a, b) => rows[b][ROW.UPLOADED] - rows[a][ROW.UPLOADED] || compareIds(rows, a, b));
        case "oldest":
            return positions.sort((a, b) => rows[a][ROW.UPLOADED] - rows[b][ROW.UPLOADED] || compareIds(rows, a, b));
        case "pages":
            return positions.sort((a, b) => rows[b][ROW.PAGES] - rows[a][ROW.PAGES] || compareIds(rows, a, b));
        case "title":
            return positions.sort((a, b) => rows[a][ROW.TITLE].localeCompare(rows[b][ROW.TITLE]) || compareIds(rows, a, b));
    }
}

function compareIds(rows: GalleryRow[], a: number, b: number): number {
    return rows[a][ROW.ID].localeCompare(rows[b][ROW.ID]);
}
