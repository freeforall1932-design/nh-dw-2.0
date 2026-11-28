// Watches (INDEXER_PLAN.md §6, phase 4): saved tag combinations the user
// always wants scanned. Pure halves only here — model, validation, the
// refresh query builder (§8.4 pins sort=date), the early-stop step decision,
// the card→row mapping for refresh, the merge, and the new-badge key set.
// The browser engine that drives them over the documented API v2 lives in
// watchRefresh.ts; the storage glue lives in library.ts.
//
// Refresh semantics (pinned here and in test/watches.test.js):
//  * The API lists one tag per call, so a watch refresh walks EACH of its
//    tags separately, in sequence, newest-first (sort=date, the §8.4 pin).
//  * Each tag walk stops at the FIRST id the index already knows (§6:
//    "until it hits ids already in the index"). Everything before that is
//    new and is collected. A capped/sliced index can miss older new titles
//    below the first known id — accepted, documented tradeoff.
//  * Cards may carry full tag objects (they extend the dictionary) or bare
//    tag_ids (resolved against the source's dictionary; unknown ids are
//    dropped WITH a count, never guessed).
//  * The watch's new-badge set = merged rows matching ALL of the watch's
//    tags — the combination is applied at merge time, not in the query.

import { GalleryRow, IndexTag, ROW } from "./indexFormat";
import { composeGalleryKey } from "../utils/siteKeys";

export const WATCHES_STORAGE = "libraryWatches";

/** Safety cap: pages walked per tag per refresh (per_page=100 → 5000 scan). */
export const MAX_PAGES_PER_TAG = 50;
/** Listing page size: the documented maximum (API_V2.md, per_page 1–100). */
export const REFRESH_PER_PAGE = 100;

export interface Watch {
    id: string;
    site: string;
    tagIds: number[];
    label: string;
    createdAt: number;
    /** Epoch ms of the last refresh that completed (even partially); null = never. */
    lastRefresh: number | null;
    /** Words from the last refresh: "" when clean, else what stopped it. */
    lastError: string;
    /** Composite keys new since this watch last produced them (badges). */
    newKeys: string[];
}

export function createWatch(id: string, site: string, tagIds: number[], label: string, now: number): Watch {
    return {
        id,
        site,
        tagIds: Array.from(new Set(tagIds)).sort((a, b) => a - b),
        label,
        createdAt: now,
        lastRefresh: null,
        lastError: "",
        newKeys: [],
    };
}

/** Validate a stored watches list: junk entries are dropped, not fixed. */
export function sanitizeWatchList(value: unknown): Watch[] {
    if (!Array.isArray(value)) return [];
    const out: Watch[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object") continue;
        const w = raw as any;
        if (typeof w.id !== "string" || w.id === "") continue;
        if (typeof w.site !== "string" || w.site === "") continue;
        if (!Array.isArray(w.tagIds) || w.tagIds.length === 0 || !w.tagIds.every((t: any) => Number.isInteger(t))) continue;
        if (typeof w.label !== "string" || w.label === "") continue;
        out.push({
            id: w.id,
            site: w.site,
            tagIds: w.tagIds.slice().sort((a: number, b: number) => a - b),
            label: w.label,
            createdAt: typeof w.createdAt === "number" ? w.createdAt : 0,
            lastRefresh: typeof w.lastRefresh === "number" ? w.lastRefresh : null,
            lastError: typeof w.lastError === "string" ? w.lastError : "",
            newKeys: Array.isArray(w.newKeys) ? w.newKeys.filter((k: any) => typeof k === "string") : [],
        });
    }
    return out;
}

/**
 * The refresh listing URL for one tag page. sort=date is a HARD pin (§8.4):
 * a popular-sorted listing would early-stop on the first known id and find
 * nothing new.
 */
export function watchUrlFor(baseUrl: string, tagId: number, page: number, perPage: number = REFRESH_PER_PAGE): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const pp = Number.isInteger(perPage) && perPage >= 1 && perPage <= 100 ? perPage : REFRESH_PER_PAGE;
    return trimmed + "/api/v2/galleries/tagged?tag_id=" + encodeURIComponent(String(tagId)) +
        "&sort=date&page=" + String(Math.max(1, page)) + "&per_page=" + String(pp);
}

/**
 * One early-stop decision for a newest-first page. Returns the cards to
 * collect (those before the first known id) and whether the walk stops here.
 */
export function refreshStep(cards: any[], knownIds: Set<string>): { collect: any[]; stop: boolean } {
    const collect: any[] = [];
    for (const card of cards) {
        const id = card && card.id !== undefined && card.id !== null ? String(card.id) : "";
        if (id !== "" && knownIds.has(id)) {
            return { collect, stop: true };
        }
        collect.push(card);
    }
    return { collect, stop: cards.length === 0 };
}

/** Mapping stats, same shape philosophy as the indexer's tools mapper. */
export interface RefreshStats {
    mappedRows: number;
    skippedCards: number;
    droppedTagIds: Set<number>;
}

/**
 * Map one listing card to a §2 row for merge. Full tag objects extend
 * `tags` (first-wins); bare tag_ids resolve against it; unresolvable ids
 * are dropped with a count. Duplicate ids (already mapped this refresh)
 * return null.
 */
export function cardToRefreshRow(card: any, tags: Map<number, IndexTag>, knownIds: Set<string>, stats: RefreshStats): GalleryRow | null {
    if (!card || card.id === undefined || card.id === null) {
        stats.skippedCards++;
        return null;
    }
    const id = String(card.id);
    if (knownIds.has(id)) {
        return null; // duplicate (this refresh or the index)
    }
    const mediaId = String(card.media_id !== undefined && card.media_id !== null ? card.media_id : id);
    let tagIds: number[] = [];
    if (Array.isArray(card.tags) && card.tags.length > 0 && typeof card.tags[0] === "object") {
        for (const tag of card.tags) {
            if (!tag || !Number.isFinite(tag.id)) continue;
            const ns = tag.type === "tag" || tag.type === "artist" || tag.type === "group" ||
                tag.type === "character" || tag.type === "parody" || tag.type === "language" ? tag.type : null;
            if (!ns) continue; // `category` and unknown types have no schema-1 namespace
            if (!tags.has(tag.id)) {
                tags.set(tag.id, { id: tag.id, ns, n: String(tag.name || ("tag " + tag.id)), c: 0 });
            }
            tagIds.push(tag.id);
        }
    } else if (Array.isArray(card.tag_ids)) {
        for (const tagId of card.tag_ids) {
            if (!Number.isFinite(tagId)) continue;
            if (tags.has(tagId)) tagIds.push(tagId);
            else stats.droppedTagIds.add(tagId);
        }
    }
    tagIds = Array.from(new Set(tagIds)).sort((a, b) => a - b);

    const title = card.english_title || (card.title && (card.title.english || card.title.pretty || card.title.japanese)) ||
        card.japanese_title || (typeof card.title === "string" && card.title) || id;
    const pages = Number.isFinite(card.num_pages) && card.num_pages >= 0 ? card.num_pages : 0;
    const uploaded = Number.isFinite(card.upload_date) && card.upload_date >= 0 ? card.upload_date : 0;
    let thumbExt: string | undefined;
    const thumbPath = card.thumbnail && typeof card.thumbnail.path === "string" ? card.thumbnail.path
        : (typeof card.thumbnail === "string" ? card.thumbnail : "");
    const extMatch = /\.([a-z0-9]+)(?:\?|$)/i.exec(thumbPath);
    if (extMatch) thumbExt = extMatch[1].toLowerCase();

    knownIds.add(id);
    stats.mappedRows++;
    const row: GalleryRow = [id, mediaId, title, pages, uploaded, tagIds];
    if (thumbExt) row.push(thumbExt);
    return row;
}

/** Recount every tag's `c` from the merged rows (counts are computed, never trusted). */
export function recountRefreshTags(tags: Map<number, IndexTag>, rows: GalleryRow[]): Map<number, IndexTag> {
    const usage = new Map<number, number>();
    for (const row of rows) {
        for (const tagId of row[ROW.TAG_IDS]) usage.set(tagId, (usage.get(tagId) || 0) + 1);
    }
    const out = new Map<number, IndexTag>();
    for (const [id, tag] of tags) {
        out.set(id, { id, ns: tag.ns, n: tag.n, c: usage.get(id) || 0 });
    }
    return out;
}

export interface MergeResult {
    rows: GalleryRow[];
    tags: Map<number, IndexTag>;
    addedCount: number;
}

/**
 * Merge collected rows into one source's index (§2 merge policy: union,
 * local wins — an existing row is never overwritten). The dictionary is the
 * union (existing entries win on conflict), then every tag count is
 * recomputed from the merged rows.
 */
export function mergeRefreshRows(rows: GalleryRow[], tags: Map<number, IndexTag>, collected: GalleryRow[], mappedTags: Map<number, IndexTag>): MergeResult {
    const known = new Set(rows.map((row) => row[ROW.ID]));
    let addedCount = 0;
    for (const row of collected) {
        if (known.has(row[ROW.ID])) continue;
        rows.push(row);
        known.add(row[ROW.ID]);
        addedCount++;
    }
    const mergedTags = new Map(tags);
    for (const [id, tag] of mappedTags) {
        if (!mergedTags.has(id)) mergedTags.set(id, tag);
    }
    return { rows, tags: recountRefreshTags(mergedTags, rows), addedCount };
}

/**
 * The watch's new-badge set: composite keys of the newly appended rows
 * (positions >= existingCount) that match ALL of the watch's tags.
 */
export function newKeysForWatch(site: string, rows: GalleryRow[], existingCount: number, watchTagIds: number[]): string[] {
    const wanted = new Set(watchTagIds);
    const keys: string[] = [];
    for (let i = existingCount; i < rows.length; i++) {
        const row = rows[i];
        let all = true;
        for (const tagId of wanted) {
            if (row[ROW.TAG_IDS].indexOf(tagId) === -1) {
                all = false;
                break;
            }
        }
        if (all) keys.push(composeGalleryKey(site, row[ROW.ID]));
    }
    return keys;
}
