/*
 * "Already saved" bookkeeping for the chapter tool.
 *
 * One record per chapter URL, grouped by site + title. It exists so a repeated
 * run can skip chapters whose archive the browser already confirmed — the same
 * evidence the save path requires — instead of fetching every page again. A
 * record is a convenience, not proof the file still exists on disk; the user can
 * forget it at any time, and nothing is recorded for a failed or cancelled run.
 */

export interface SavedChapterRecord {
    filename: string;
    pages: number;
    savedAt: number;
}

/** title key -> chapter URL -> record */
export type ChapterProgressMap = Record<string, Record<string, SavedChapterRecord>>;

export const MAX_CHAPTERS_PER_TITLE = 500;
export const MAX_TITLES = 100;

/** Stable, non-secret key for a site + title pair. */
export function progressTitleKey(origin: string, title: string): string | null {
    const site = String(origin || "").trim().toLowerCase();
    if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) return null;
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
    if (!cleanTitle) return null;
    return site + " | " + cleanTitle;
}

export interface ChapterLike { chapterUrl: string; }

/** Split a selection into chapters to save and chapters already recorded. */
export function partitionSaved(
    map: ChapterProgressMap | null | undefined, titleKey: string | null, chapters: ChapterLike[]
): { pending: ChapterLike[]; alreadySaved: ChapterLike[] } {
    if (!titleKey || !map || typeof map !== "object" || !map[titleKey] || typeof map[titleKey] !== "object") {
        return { pending: chapters.slice(), alreadySaved: [] };
    }
    const known = map[titleKey];
    const pending: ChapterLike[] = [];
    const alreadySaved: ChapterLike[] = [];
    for (const chapter of chapters) {
        if (Object.prototype.hasOwnProperty.call(known, chapter.chapterUrl)) alreadySaved.push(chapter);
        else pending.push(chapter);
    }
    return { pending, alreadySaved };
}

/**
 * Return a new map with these chapters recorded. Oldest titles and chapters are
 * evicted first so storage cannot grow without bound.
 */
export function recordSaved(
    map: ChapterProgressMap | null | undefined,
    titleKey: string | null,
    entries: { chapterUrl: string; filename: string; pages: number }[],
    now: number = Date.now()
): ChapterProgressMap {
    const next: ChapterProgressMap = {};
    if (map && typeof map === "object") {
        for (const key of Object.keys(map)) {
            const chapters = map[key];
            if (!chapters || typeof chapters !== "object") continue;
            const clean: Record<string, SavedChapterRecord> = {};
            for (const url of Object.keys(chapters)) {
                const rec = chapters[url];
                if (!rec || typeof rec.filename !== "string" || rec.filename === "") continue;
                clean[url] = {
                    filename: rec.filename,
                    pages: Number.isFinite(rec.pages) ? Number(rec.pages) : 0,
                    savedAt: Number.isFinite(rec.savedAt) ? Number(rec.savedAt) : 0
                };
            }
            if (Object.keys(clean).length) next[key] = clean;
        }
    }
    if (!titleKey || entries.length === 0) return next;
    const target = next[titleKey] ? Object.assign({}, next[titleKey]) : {};
    for (const entry of entries) {
        const url = String(entry.chapterUrl || "");
        if (!/^https:\/\//.test(url) || typeof entry.filename !== "string" || entry.filename === "") continue;
        target[url] = { filename: entry.filename, pages: Number(entry.pages) || 0, savedAt: now };
    }
    const urls = Object.keys(target);
    if (urls.length > MAX_CHAPTERS_PER_TITLE) {
        urls.sort((a, b) => target[a].savedAt - target[b].savedAt);
        for (const url of urls.slice(0, urls.length - MAX_CHAPTERS_PER_TITLE)) delete target[url];
    }
    next[titleKey] = target;
    const keys = Object.keys(next);
    if (keys.length > MAX_TITLES) {
        keys.sort((a, b) => newestTimestamp(next[a]) - newestTimestamp(next[b]));
        for (const key of keys.slice(0, keys.length - MAX_TITLES)) delete next[key];
    }
    return next;
}

function newestTimestamp(chapters: Record<string, SavedChapterRecord>): number {
    let newest = 0;
    for (const url of Object.keys(chapters)) newest = Math.max(newest, chapters[url].savedAt || 0);
    return newest;
}

/** Forget everything recorded for one title, or for one site when title is omitted. */
export function forgetSaved(map: ChapterProgressMap | null | undefined, titleKey: string | null): ChapterProgressMap {
    const next: ChapterProgressMap = {};
    if (!map || typeof map !== "object") return next;
    for (const key of Object.keys(map)) {
        if (key === titleKey) continue;
        const chapters = map[key];
        if (chapters && typeof chapters === "object" && Object.keys(chapters).length) next[key] = chapters;
    }
    return next;
}
