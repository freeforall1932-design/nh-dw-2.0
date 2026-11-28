// Watch refresh engine (INDEXER_PLAN.md §6, phase 4): walks the documented
// API v2 for each of a watch's tags — sequentially, newest-first, early-
// stopping at the first known id — and returns the merged index state plus
// words for the UI. No chrome.* at module scope; fetch/sleep are injectable
// so test/watches.test.js drives everything offline.
//
// Politeness: request spacing derives from the documented tagged-listing
// limits (15/min anon, 30/min keyed) with headroom; a 429 stops the refresh
// with words (never retried, house rule), a Cloudflare challenge body stops
// with words, and a 404 past page 1 is the listing-depth cap (§8.5) — the
// walk keeps what it collected and reports the cap. Partial progress is
// merged: a stopped refresh still keeps the new titles it found.

import { GalleryRow, IndexTag, ROW } from "./indexFormat";
import { normalizeSite } from "../utils/siteKeys";
import {
    MAX_PAGES_PER_TAG,
    REFRESH_PER_PAGE,
    RefreshStats,
    Watch,
    cardToRefreshRow,
    mergeRefreshRows,
    newKeysForWatch,
    refreshStep,
    watchUrlFor,
} from "./watches";

/** Documented tagged listing limits, per minute. */
const TAGGED_PER_MIN = { anon: 15, keyed: 30 };

export interface RefreshSourceState {
    site: string;
    rows: GalleryRow[];
    tags: Map<number, IndexTag>;
}

export interface RefreshOutcome {
    rows: GalleryRow[];
    tags: Map<number, IndexTag>;
    addedCount: number;
    newKeys: string[];
    /** Human words: per-tag results and anything that stopped the walk. */
    lines: string[];
    /** True when a 429/challenge/server error stopped the walk mid-way. */
    stopped: boolean;
}

export interface RefreshOptions {
    apiKey?: string;
    baseUrl?: string;
    fetchImpl?: (url: string, init?: any) => Promise<{ status: number; headers?: { get?: (name: string) => string | null }; text: () => Promise<string> }>;
    sleepImpl?: (ms: number) => Promise<void>;
    minIntervalMs?: number;
    perPage?: number;
    maxPagesPerTag?: number;
    now?: () => number;
}

function defaultIntervalMs(hasKey: boolean): number {
    return Math.ceil(60000 / (hasKey ? TAGGED_PER_MIN.keyed : TAGGED_PER_MIN.anon)) + 200;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function looksLikeChallenge(status: number, contentType: string | null, bodyText: string): boolean {
    const html = (contentType || "").includes("text/html") || /^\s*<!DOCTYPE/i.test(bodyText) || /^\s*<html/i.test(bodyText);
    if (!html) return false;
    return /Just a moment|challenge-platform|cf-chl|Attention Required/i.test(bodyText) || status === 403 || status === 503;
}

function retryAfterOf(response: any): string {
    try {
        const raw = response.headers && typeof response.headers.get === "function" ? response.headers.get("retry-after") : null;
        return raw ? " (Retry-After " + raw + "s)" : "";
    } catch (_) {
        return "";
    }
}

/**
 * Refresh one watch against one source's current index state. Never
 * throws: outcomes carry words. The returned rows/tags are new arrays —
 * the caller replaces its SourceState and persists.
 */
export async function refreshWatch(watch: Watch, source: RefreshSourceState, options: RefreshOptions = {}): Promise<RefreshOutcome> {
    const site = normalizeSite(source.site);
    if (watch.site !== site) {
        return {
            rows: source.rows, tags: source.tags, addedCount: 0, newKeys: [],
            lines: ["the watch belongs to " + watch.site + " but the loaded source is " + site + " — nothing to refresh"],
            stopped: false,
        };
    }
    const fetchImpl = options.fetchImpl;
    if (typeof fetchImpl !== "function") {
        return {
            rows: source.rows, tags: source.tags, addedCount: 0, newKeys: [],
            lines: ["no fetch implementation available in this context"],
            stopped: false,
        };
    }
    const sleepImpl = options.sleepImpl || defaultSleep;
    const minIntervalMs = typeof options.minIntervalMs === "number" && options.minIntervalMs >= 0
        ? options.minIntervalMs
        : defaultIntervalMs(!!options.apiKey);
    const perPage = options.perPage || REFRESH_PER_PAGE;
    const maxPages = options.maxPagesPerTag || MAX_PAGES_PER_TAG;
    const baseUrl = options.baseUrl || "https://nhentai.net";

    const lines: string[] = [];
    const knownIds = new Set(source.rows.map((row) => row[ROW.ID]));
    const tags = new Map(source.tags);
    const stats: RefreshStats = { mappedRows: 0, skippedCards: 0, droppedTagIds: new Set() };
    const collected: GalleryRow[] = [];
    let stopped = false;

    for (const tagId of watch.tagIds) {
        const tagName = tags.get(tagId) ? tags.get(tagId)!.n : "tag " + tagId;
        let page = 1;
        let tagDone = false;
        let tagNew = 0;
        while (!tagDone && page <= maxPages) {
            let response: any;
            try {
                response = await fetchImpl(watchUrlFor(baseUrl, tagId, page, perPage), {
                    headers: options.apiKey
                        ? { "Accept": "application/json", "Authorization": "Key " + options.apiKey }
                        : { "Accept": "application/json" },
                });
            } catch (networkError: any) {
                lines.push(tagName + ": network failure (" + (networkError && networkError.message ? networkError.message : String(networkError)) + ") — the walk keeps what it found so far");
                stopped = true;
                break;
            }
            if (response.status === 429) {
                lines.push(tagName + ": the API answered 429 (rate limited" + retryAfterOf(response) + ") — refresh stopped so the site is never pressured; try again later");
                stopped = true;
                break;
            }
            let bodyText = "";
            try {
                bodyText = await response.text();
            } catch (_) { /* text read failure handled by the JSON parse below */ }
            const contentType = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-type") : null;
            if (looksLikeChallenge(response.status, contentType, bodyText)) {
                lines.push(tagName + ": a Cloudflare challenge page came back instead of JSON — the refresh will not bypass it; try again later");
                stopped = true;
                break;
            }
            if (response.status === 404) {
                if (page === 1) {
                    lines.push(tagName + ": the tag listing answered 404 — the tag may no longer exist on " + site);
                } else {
                    lines.push(tagName + ": stopped at the listing depth cap (404 on page " + page + ") — deeper fills need a one-time crawl, watches stay safe");
                }
                tagDone = true;
                break;
            }
            if (response.status < 200 || response.status >= 300) {
                lines.push(tagName + ": the API answered " + response.status + " — refresh stopped");
                stopped = true;
                break;
            }
            let listing: any;
            try {
                listing = JSON.parse(bodyText);
            } catch (_) {
                lines.push(tagName + ": the API returned non-JSON where JSON was expected — refresh stopped");
                stopped = true;
                break;
            }
            const cards = listing && Array.isArray(listing.result) ? listing.result : [];
            if (cards.length === 0) {
                tagDone = true;
                break;
            }
            const step = refreshStep(cards, knownIds);
            for (const card of step.collect) {
                const row = cardToRefreshRow(card, tags, knownIds, stats);
                if (row) {
                    collected.push(row);
                    tagNew++;
                }
            }
            if (step.stop) {
                tagDone = true;
                break;
            }
            page++;
            await sleepImpl(minIntervalMs);
        }
        if (page > maxPages && !tagDone) {
            lines.push(tagName + ": stopped at the safety cap of " + maxPages + " pages this refresh");
            stopped = true;
        }
        lines.push(tagName + ": " + tagNew + " new");
    }

    const merged = mergeRefreshRows(source.rows.slice(), tags, collected, tags);
    const newKeys = newKeysForWatch(site, merged.rows, source.rows.length, watch.tagIds);
    const dropped = stats.droppedTagIds.size;
    if (dropped > 0) {
        lines.push(dropped + " tag id(s) on the new cards are not in this source's dictionary and were dropped from those rows (they will resolve after a --tags dictionary refresh and re-crawl)");
    }
    if (stats.skippedCards > 0) lines.push(stats.skippedCards + " unusable card(s) skipped");

    return {
        rows: merged.rows,
        tags: merged.tags,
        addedCount: merged.addedCount,
        newKeys,
        lines,
        stopped,
    };
}
