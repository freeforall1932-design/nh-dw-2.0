// Send-to-queue plumbing for the library tab (INDEXER_PLAN.md §5, phase 3).
// Pure halves only: the candidate builder and the §8.9 chunker live here so
// the node tests can pin them; library.ts does the messaging.
//
// The queue is the existing bookmark list (bookmarkQueue.ts): Send-to-queue
// sends `bookmarkAdd` with one BookmarkCandidate per selected title — the
// same mutation a card's Bookmark button makes, so re-download marks,
// per-row cancel and the panel's Bookmark tab all see the rows as first
// class queue entries. Duplicates are NOT re-added or reset by design
// (addBookmarks reports them; the library prints the split).

import type { BookmarkCandidate } from "../utils/bookmarkQueue";
import { GalleryRow, ROW } from "./indexFormat";

/** Rows per bookmarkAdd message (§8.9: never one giant storage write). */
export const SEND_CHUNK = 500;

/** Tag names carried on a candidate (item 68), capped to keep messages light. */
export const MAX_CANDIDATE_TAGS = 10;

export function chunkArray<T>(items: T[], size: number): T[][] {
    if (size <= 0) throw new Error("chunk size must be positive");
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * Tier-3 thumbs are derived per source, never stored (INDEXER_PLAN.md §2).
 * nhentai's thumb host family is documented to rotate — the API forbids
 * hardcoding subdomains — so this builds the canonical host form; the
 * background's dynamic CDN grant flow (cdnConfigService) is what makes
 * fetching it possible for Phase 3b's cache, and a failed <img> falls back
 * to the offline placeholder in the UI.
 */
export function thumbUrlFor(site: string, mediaId: string, thumbExt?: string): string | null {
    if (site === "nhentai" && mediaId) {
        return "https://t.nhentai.net/galleries/" + mediaId + "/thumb." + (thumbExt || "jpg");
    }
    return null;
}

/** One selected §2 row -> one queue candidate. `tagNameOf` resolves the dictionary. */
export function candidateFromGalleryRow(
    site: string,
    row: GalleryRow,
    tagNameOf: (tagId: number) => string | undefined
): BookmarkCandidate {
    const candidate: BookmarkCandidate = {
        id: row[ROW.ID],
        site,
        title: row[ROW.TITLE] || row[ROW.ID],
        pages: row[ROW.PAGES],
        source: "page",
        sourceUrl: "",
    };
    const thumb = thumbUrlFor(site, row[ROW.MEDIA_ID], row[ROW.THUMB_EXT]);
    if (thumb) candidate.thumbnail = thumb;
    const tags: string[] = [];
    for (const tagId of row[ROW.TAG_IDS]) {
        const name = tagNameOf(tagId);
        if (name) tags.push(name);
        if (tags.length >= MAX_CANDIDATE_TAGS) break;
    }
    if (tags.length > 0) candidate.tags = tags;
    return candidate;
}
