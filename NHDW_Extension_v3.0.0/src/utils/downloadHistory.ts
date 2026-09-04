// Persistent "already downloaded" history, keyed by gallery ID.
//
// Why: re-running a listing (search / tag / artist / homepage) re-downloaded
// every gallery and conflictAction "uniquify" turned them into
// "Title (1).zip", "Title (2).zip" ... The only dedupe that used to exist
// (duplicateBehaviour) was rebuilt per job and discarded when the job ended,
// so it could never remember anything across jobs.
//
// Design (settled with the user):
//  * chrome.storage.local — never sync. 6-digit IDs make ~10,000 entries only
//    ~60-70 KB, while sync is capped at ~100 KB / 512 items.
//  * Keyed on the GALLERY ID, never the title: it survives template changes,
//    title/language edits and uniquify renames.
//  * A record is written ONLY after a download fully succeeded, never on
//    enqueue — a cancelled or failed job cannot poison the history.
//  * Store { filename, when } (not a bare ID set) so the UI can show what it
//    is skipping.
//  * Separate mode records per gallery. Batch/merged mode records ALL of the
//    job's titles only when the whole merged job succeeded; a failed or
//    cancelled merge records nothing.
//  * Partial galleries (any failed page) are never recorded: a re-run
//    re-fetches them cleanly. nhentai publishes no content hash, so byte
//    identity cannot be verified, and a broken file would otherwise be
//    skipped forever.
//  * Escape hatches: a per-download "download anyway" override
//    (redownloadIds) and the "clear history" button in Settings.
//
// IMPORTANT CONTEXT RULE: this module touches chrome.storage.local ONLY
// inside functions. The offscreen document imports the pure helpers (to skip
// recorded galleries) but must never call the storage functions — it has no
// chrome.storage there (only chrome.runtime is exposed).

export const DOWNLOAD_HISTORY_KEY = "downloadHistory";

export interface DownloadRecord {
    /** Artifact name as saved, e.g. "NHDW/Title.zip" or "NHDW/Title/001.jpg". */
    filename: string;
    /** Milliseconds since epoch when the record was written. */
    when: number;
}

export type DownloadHistory = Record<string, DownloadRecord>;

// Tolerate corrupt / legacy shapes instead of throwing in the UI.
export function normalizeHistory(raw: any): DownloadHistory {
    const history: DownloadHistory = {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return history;
    }
    for (const id of Object.keys(raw)) {
        const entry = raw[id];
        if (entry === null || typeof entry !== "object") {
            continue;
        }
        const filename = typeof entry.filename === "string" ? entry.filename : "";
        const when = Number.isFinite(entry.when) ? Number(entry.when) : 0;
        if (filename !== "" || when > 0) {
            history[String(id)] = { filename: filename, when: when };
        }
    }
    return history;
}

export function historyIds(history: DownloadHistory): string[] {
    return Object.keys(history);
}

export function countHistory(history: DownloadHistory): number {
    return Object.keys(history).length;
}

// Pure split used by BOTH the UI pre-check and the pipeline guard: which
// candidate ids are skipped (already recorded and not in redownloadIds) and
// which are downloaded.
export function partitionKnown(
    history: DownloadHistory,
    candidates: Array<string | number>,
    redownloadIds: Array<string | number> = []
): { download: string[]; skip: string[] } {
    const force = new Set<string>();
    for (const id of redownloadIds) {
        force.add(String(id));
    }
    const download: string[] = [];
    const skip: string[] = [];
    for (const id of candidates) {
        const key = String(id);
        if (Object.prototype.hasOwnProperty.call(history, key) && !force.has(key)) {
            skip.push(key);
        } else {
            download.push(key);
        }
    }
    return { download: download, skip: skip };
}

// The filename recorded for an artifact, matching what the pipeline saves:
//  * archives: [masterFolder/]<name>.<format>
//  * raw:      [masterFolder/]<folder>/001.jpg
// "folder" is the retired format, still mapping to pdf.
export function artifactRecordFilename(opts: { format: string; name: string; masterFolder: string }): string {
    const format = String(opts.format === "folder" ? "pdf" : String(opts.format || "zip")).toLowerCase().trim();
    const folder = String(opts.masterFolder || "").replace(/^\/+|\/+$/g, "").trim();
    const prefix = folder === "" ? "" : folder + "/";
    if (format === "raw") {
        return prefix + String(opts.name) + "/001.jpg";
    }
    return prefix + String(opts.name) + "." + format;
}

// Outcome of one downloadAllDoujinshisAsync invocation, used to decide what
// goes into the persistent history.
export interface BatchOutcome {
    /**
     * Separate mode: one record per gallery that fully succeeded.
     * Batch mode: empty (the top-level call renames them from batchKeys once
     * it knows the final artifact name).
     */
    records: Array<{ id: string; filename: string }>;
    /**
     * Separate mode: always true. Batch mode: true only when every gallery
     * succeeded AND the merged artifact was actually saved.
     */
    clean: boolean;
    /** Batch mode: keys that belong to this invocation's merged artifact. */
    batchKeys: string[];
    /** Galleries skipped because they were already downloaded (separate mode only). */
    skipped: number;
}

// Turn a BatchOutcome into the history entries to write.
// Separate mode keeps per-gallery records; batch mode records EVERYTHING or
// NOTHING (only a fully clean merged job) under the merged file's name.
export function historyRecords(
    outcome: BatchOutcome,
    opts: { effectiveSeparate: boolean; format: string; finalName: string; archiveMasterFolder: string }
): Array<{ id: string; filename: string }> {
    if (opts.effectiveSeparate) {
        return outcome.records;
    }
    if (!outcome.clean) {
        return [];
    }
    const filename = artifactRecordFilename({
        format: opts.format,
        name: opts.finalName,
        masterFolder: opts.archiveMasterFolder
    });
    return outcome.batchKeys.map((id) => ({ id: id, filename: filename }));
}

// ---- storage (worker / popup / content script contexts only) -------------

export function readHistory(): Promise<DownloadHistory> {
    return new Promise((resolve) => {
        const done = (history: DownloadHistory) => resolve(history);
        try {
            const defaults: any = {};
            defaults[DOWNLOAD_HISTORY_KEY] = {};
            chrome.storage.local.get(defaults, (elems: any) => {
                done(normalizeHistory(elems && elems[DOWNLOAD_HISTORY_KEY]));
            });
        } catch (_) {
            done({});
        }
    });
}

// Serialize read-modify-write so overlapping record calls (e.g. the worker's
// queue of jobs) cannot clobber each other. Best-effort: a storage failure
// must never fail or poison a download.
let historyWriteChain: Promise<void> = Promise.resolve();

export function recordHistory(records: Array<{ id: string | number; filename: string }>): Promise<void> {
    const entries = (records || [])
        .map((entry) => ({ id: String(entry && entry.id), filename: String(entry && (entry as any).filename || "") }))
        .filter((entry) => entry.id !== "" && entry.filename !== "");
    if (entries.length === 0) {
        return Promise.resolve();
    }
    historyWriteChain = historyWriteChain
        .then(() => writeHistoryEntries(entries))
        .catch(() => { /* storage write is best-effort */ });
    return historyWriteChain;
}

function writeHistoryEntries(entries: Array<{ id: string; filename: string }>): Promise<void> {
    return new Promise((resolve) => {
        try {
            const defaults: any = {};
            defaults[DOWNLOAD_HISTORY_KEY] = {};
            chrome.storage.local.get(defaults, (existing: any) => {
                try {
                    const history = normalizeHistory(existing && existing[DOWNLOAD_HISTORY_KEY]);
                    const now = Date.now();
                    for (const entry of entries) {
                        history[entry.id] = { filename: entry.filename, when: now };
                    }
                    const patch: any = {};
                    patch[DOWNLOAD_HISTORY_KEY] = history;
                    chrome.storage.local.set(patch, () => {
                        // Never surface a storage error: history is bookkeeping.
                        try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                        resolve();
                    });
                } catch (_) {
                    resolve();
                }
            });
        } catch (_) {
            resolve();
        }
    });
}

export function clearHistory(): Promise<void> {
    const clear = historyWriteChain.then(() => new Promise<void>((resolve) => {
        try {
            chrome.storage.local.remove(DOWNLOAD_HISTORY_KEY, () => {
                try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                resolve();
            });
        } catch (_) {
            resolve();
        }
    })).catch(() => { /* best effort */ });
    historyWriteChain = clear;
    return clear;
}
