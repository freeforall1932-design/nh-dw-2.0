// Failed-gallery bookkeeping: which galleries of a download job did NOT
// complete, so the UI can name them and offer to re-add exactly those.
//
// Why: before 3.6.0 a batch that lost two galleries ended with "2 galleries
// failed" — no names, no retry, and if the popup was closed at that moment
// even the count was gone. Failures are now remembered by the service worker
// in chrome.storage.session (survives worker restarts, cleared with the
// browser session, never syncs) and shown by the popup / side panel until the
// user retries or dismisses them. A gallery that later downloads successfully
// is dropped from the list automatically.
//
// A retry is always a "separate files" batch job: the failed titles are
// re-downloaded on their own with the format / template / master folder of
// the job they failed in, and their ids are forced past the history guard.
// Metadata is resolved again by the pipeline, so nothing large (gallery JSON)
// has to be kept in storage.
//
// Pure helpers (merge / drop / group) are dependency-free and unit-tested; the
// storage functions are for the worker and the popup only (the offscreen
// document has no chrome.storage and reports failures by message instead).
import { FailedGallery } from "./downloadHistory";
import { DEFAULT_SITE, normalizeSite, toGalleryKey } from "./siteKeys";

export const FAILED_GALLERIES_KEY = "nhdwFailedGalleries";

// Bounded so a very long session cannot grow the session store without
// limit; the oldest entries are dropped first.
export const FAILED_GALLERIES_CAP = 200;

// The settings a retry must be started with (per-job overrides in the shape
// the popup sends to the worker). The source tab is advisory: the retry uses
// the active tab when the original one is gone.
export interface RetryJob {
    action?: string;
    tabId?: number;
    formatOverride?: string;
    nameTemplate?: string;
    masterFolder?: string;
    finalName?: string;
    /** Site the job ran on (item 48); absent means the default site. */
    site?: string;
}

export interface PendingFailure extends FailedGallery {
    retryJob: RetryJob | null;
    at: number;
}

export function normalizePendingFailures(value: any): PendingFailure[] {
    if (!Array.isArray(value)) return [];
    const out: PendingFailure[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const id = entry.id === undefined || entry.id === null ? "" : String(entry.id);
        if (id === "") continue;
        out.push({
            id: id,
            name: entry.name === undefined || entry.name === null || entry.name === "" ? id : String(entry.name),
            error: entry.error === undefined || entry.error === null ? "" : String(entry.error),
            // Optional source site (siteKeys.ts); rows from 3.7.x and
            // earlier carry none and read as the default site.
            site: typeof entry.site === "string" && entry.site !== "" ? entry.site : undefined,
            retryJob: entry.retryJob && typeof entry.retryJob === "object" ? entry.retryJob : null,
            at: typeof entry.at === "number" ? entry.at : 0
        });
    }
    return out;
}

// Composite identity of a failure row (siteKeys.ts). The stored id stays
// bare — retry messages resolve metadata with it — while dedupe and removal
// compare in composite space so ids from different sites can never shadow
// each other.
function failureKey(id: string | number, site?: string): string {
    return toGalleryKey(id, site);
}

// Add a job's failures. An id that failed before is replaced (latest error
// and job win); the list is capped, oldest first.
export function mergeFailures(existing: PendingFailure[], incoming: FailedGallery[], retryJob: RetryJob | null, now: number, cap: number = FAILED_GALLERIES_CAP): PendingFailure[] {
    const fresh = normalizePendingFailures((incoming || []).map((entry) => ({
        id: entry && entry.id,
        name: entry && entry.name,
        error: entry && entry.error,
        site: entry && (entry as any).site,
        retryJob: retryJob,
        at: now
    })));
    const freshIds = new Set(fresh.map((entry) => failureKey(entry.id, entry.site)));
    const kept = existing.filter((entry) => !freshIds.has(failureKey(entry.id, entry.site)));
    const merged = kept.concat(fresh);
    return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function dropFailures(existing: PendingFailure[], ids: Array<string | number>): PendingFailure[] {
    const gone = new Set(ids.map((id) => toGalleryKey(id)));
    return existing.filter((entry) => !gone.has(failureKey(entry.id, entry.site)));
}

// Stable key for "same job settings": entries with the same key are retried
// together in ONE downloadAllDoujinshis command.
export function retryJobKey(job: RetryJob | null): string {
    if (!job || typeof job !== "object") return "";
    return JSON.stringify({
        formatOverride: job.formatOverride === undefined ? null : job.formatOverride,
        nameTemplate: job.nameTemplate === undefined ? null : job.nameTemplate,
        masterFolder: job.masterFolder === undefined ? null : job.masterFolder,
        // The site is part of "the settings a retry must be started with"
        // (item 48): the same format/template/folder on two sites is still two
        // different jobs, because a job payload can only name one site.
        site: job.site === undefined || job.site === "" ? null : job.site
    });
}

/**
 * Site of a failure row: the entry's own site wins, then the job's.
 *
 * Item 48. Two failures with identical settings from DIFFERENT sites must not
 * be merged into one retry command — that command can only carry one site, so
 * one of them would be re-fetched through the wrong site's adapter.
 */
export function failureSite(entry: { site?: string } | null | undefined, job: RetryJob | null | undefined): string {
    const fromEntry = entry && typeof entry.site === "string" && entry.site !== "" ? entry.site : "";
    if (fromEntry !== "") return normalizeSite(fromEntry);
    const fromJob = job && typeof job.site === "string" && job.site !== "" ? job.site : "";
    return normalizeSite(fromJob);
}

// Turn failures into the worker commands that re-download exactly those
// galleries: one "separate files" downloadAllDoujinshis per distinct job
// settings, failed ids forced past the history guard. Entries without a job
// use the stored defaults (nothing is invented for them).
export function groupRetryMessages(entries: PendingFailure[], tabId?: number): any[] {
    const messages: any[] = [];
    const batches = new Map<string, any>();
    for (const entry of entries) {
        if (!entry || entry.id === undefined || entry.id === "") continue;
        const job: RetryJob = entry.retryJob && typeof entry.retryJob === "object" ? entry.retryJob : {};
        const site = failureSite(entry, job);
        // One command per (settings, site): a job payload carries a single
        // site, so failures from two sites can never share a retry command
        // (item 48). The site is appended as well as being part of
        // retryJobKey(), because an entry may carry a site while its job does
        // not (a failure remembered with no job at all). Same-site failures
        // still batch exactly as before.
        const key = retryJobKey(job) + "|" + site;
        let batch = batches.get(key);
        if (!batch) {
            batch = {
                action: "downloadAllDoujinshis",
                allDoujinshis: {},
                galleryMetadata: {},
                finalName: typeof job.finalName === "string" && job.finalName !== "" ? job.finalName : "Retry",
                separate: true,
                redownloadIds: []
            };
            if (job.formatOverride !== undefined && job.formatOverride !== null && job.formatOverride !== "") {
                batch.formatOverride = job.formatOverride;
            }
            if (typeof job.nameTemplate === "string") batch.nameTemplate = job.nameTemplate;
            if (typeof job.masterFolder === "string") batch.masterFolder = job.masterFolder;
            if (typeof tabId === "number") batch.tabId = tabId;
            else if (typeof job.tabId === "number") batch.tabId = job.tabId;
            // Only written when it is not the default site, so an nhentai retry
            // payload stays exactly what 3.9.0 sent.
            if (site !== DEFAULT_SITE) batch.site = site;
            batches.set(key, batch);
            messages.push(batch);
        }
        batch.allDoujinshis[String(entry.id)] = String(entry.name || entry.id);
        batch.redownloadIds.push(String(entry.id));
    }
    return messages;
}

// ---- storage (worker + popup only) -----------------------------------------

function sessionStore(): any | null {
    try {
        if (typeof chrome === "undefined" || !chrome.storage) return null;
        const session = (chrome.storage as any).session;
        if (!session || typeof session.get !== "function" || typeof session.set !== "function") return null;
        return session;
    } catch (_) {
        return null;
    }
}

export function readPendingFailures(): Promise<PendingFailure[]> {
    return new Promise((resolve) => {
        const session = sessionStore();
        if (session === null) {
            resolve([]);
            return;
        }
        try {
            session.get([FAILED_GALLERIES_KEY], (elems: any) => {
                try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                resolve(normalizePendingFailures(elems && elems[FAILED_GALLERIES_KEY]));
            });
        } catch (_) {
            resolve([]);
        }
    });
}

function writePendingFailures(entries: PendingFailure[]): Promise<void> {
    return new Promise((resolve) => {
        const session = sessionStore();
        if (session === null) {
            resolve();
            return;
        }
        try {
            const patch: any = {};
            patch[FAILED_GALLERIES_KEY] = entries;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                resolve();
            };
            const maybePromise = session.set(patch, finish);
            if (maybePromise && typeof maybePromise.then === "function") {
                // Promise-style storage (no callback support): settle on it.
                maybePromise.then(finish, finish);
            }
        } catch (_) {
            resolve();
        }
    });
}

// Serialize read-modify-write cycles so two jobs finishing back to back
// cannot lose each other's failures. The worker is the only writer; the
// popup asks it (forgetFailedGalleries message) instead of writing itself.
let writeChain: Promise<void> = Promise.resolve();

function queue(update: (current: PendingFailure[]) => PendingFailure[]): Promise<void> {
    writeChain = writeChain
        .then(() => readPendingFailures())
        .then((current) => writePendingFailures(update(current)))
        .catch(() => { /* bookkeeping is best effort */ });
    return writeChain;
}

// Read that waits for any in-flight write first, so a popup asking right after
// a job reported its failures sees them.
export function readPendingFailuresSettled(): Promise<PendingFailure[]> {
    return writeChain.then(() => readPendingFailures());
}

export function rememberFailedGalleries(failed: FailedGallery[], retryJob: RetryJob | null): Promise<void> {
    if (!Array.isArray(failed) || failed.length === 0) return Promise.resolve();
    const now = Date.now();
    return queue((current) => mergeFailures(current, failed, retryJob, now));
}

export function forgetFailedGalleries(ids: Array<string | number>): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve();
    return queue((current) => dropFailures(current, ids));
}

export function clearPendingFailures(): Promise<void> {
    return queue(() => []);
}
