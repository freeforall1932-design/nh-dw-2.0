// Completion tracking for downloads handed to the browser's download manager
// (chrome.downloads), plus the raw-mode concurrency setting.
//
// WHY THIS EXISTS. chrome.downloads.download()'s callback fires when the
// download ITEM is created, not when the file is on disk. Until 3.6.0 raw mode
// (one browser download per page) treated that callback as success, so:
//
//   * a page whose download was interrupted AFTER it started (network drop,
//     disk full, the user cancelling it in the download shelf) was invisible
//     to the Downloader's retry loop — the gallery was counted complete and
//     recorded in the persistent download history with a page missing;
//   * nothing throttled raw mode: every save "finished" instantly, so a
//     200-page gallery became 200 simultaneous browser downloads regardless
//     of the concurrency setting.
//
// awaitDownloadCompletion() resolves only when the item reaches a terminal
// state (complete / interrupted). It listens to chrome.downloads.onChanged and
// re-checks the state through chrome.downloads.search() at a slow poll — a
// safety net for a missed event, and an MV3 keep-alive (extension API calls
// reset the service worker idle timer while a long download is in flight).
// A download that never finishes is cancelled after a hard cap and reported
// as failed, so a retry cannot race a zombie download into a duplicate
// "001 (1).jpg".
//
// Contexts without the event (unit stubs, the e2e harnesses, browsers whose
// downloads API lacks onChanged) keep the historical "started = saved"
// behaviour, so nothing that worked before can hang.
//
// This module touches chrome.downloads and chrome.runtime.lastError only —
// never chrome.storage — so the Downloader (which also runs inside the
// offscreen document, where only chrome.runtime exists) can import it; there
// its direct path is never taken (saveUrl relays to the worker instead).

import { recordDownloadRequest, bindDownloadId, discardDownloadRequest } from "./downloadNaming";

export type DownloadTerminalState = "complete" | "interrupted" | "timeout" | "aborted" | "pending" | "unknown";

export interface DownloadOutcome {
    ok: boolean;
    state: DownloadTerminalState;
    error?: string;
}

export interface CompletionOptions {
    // How often the state is re-checked through chrome.downloads.search().
    pollMs?: number;
    // Upper bound on the wait. What happens then depends on onTimeout.
    maxWaitMs?: number;
    // "cancel" (default): cancel the download and report it as failed.
    // "report": leave it running and answer {state:"pending"} — used by the
    // worker to answer the offscreen document's bounded await requests.
    onTimeout?: "cancel" | "report";
    // User cancellation: stop waiting (and cancel the download when
    // cancelOnAbort is set — right for loose raw pages, wrong for a finished
    // archive the user waited for).
    signal?: AbortSignal | null;
    cancelOnAbort?: boolean;
}

export const DEFAULT_COMPLETION_POLL_MS = 10000;
// Generous for a single page (a few MB): below this speed the connection is
// unusable anyway, and a bounded wait keeps the retry loop moving.
export const DEFAULT_COMPLETION_MAX_WAIT_MS = 4 * 60 * 1000;
// Finished archives written by the fallback pipeline can be large.
export const ARCHIVE_COMPLETION_MAX_WAIT_MS = 30 * 60 * 1000;

// Terminal events can arrive before the caller had a chance to wait for the
// id (tiny files, or an event queued behind the download() callback). They
// are parked here, bounded, and consumed by the next awaitDownloadCompletion.
const RECENT_TERMINAL_CAP = 200;

type Settle = (outcome: DownloadOutcome) => void;

const waiters = new Map<number, Settle[]>();
const recentTerminal = new Map<number, DownloadOutcome>();
// The event object the listener is attached to. Comparing the object (not a
// boolean) makes installation idempotent per API instance, so unit tests that
// swap the global chrome stub between cases re-attach automatically.
let attachedEvent: any = null;

function downloadsApi(): any {
    try {
        if (typeof chrome === "undefined" || !chrome.downloads) return null;
        return chrome.downloads as any;
    } catch (_) {
        return null;
    }
}

function nowMs(): number {
    try {
        return Date.now();
    } catch (_) {
        return 0;
    }
}

// Human-readable reason for an interrupted download. Chrome reports an
// InterruptReason such as NETWORK_FAILED, FILE_NO_SPACE or USER_CANCELED.
// Message-first and never plain String(reason): a structured-cloned or
// object-shaped error (e.g. {message}) would otherwise render as
// "[object Object]" and hide the real reason from the retry loop's report.
export function interruptedMessage(reason: any): string {
    let text = "";
    if (reason !== undefined && reason !== null) {
        if (typeof reason === "string") {
            text = reason;
        } else if (reason && typeof reason.message === "string" && reason.message !== "") {
            text = reason.message;
        }
    }
    return text === "" ? "Download interrupted" : "Download interrupted (" + text + ")";
}

// chrome.runtime.lastError is an object ({message}); String() on it yields
// "[object Object]", which is what raw-mode error reports used to show.
export function lastErrorMessage(fallback: string): string {
    try {
        const error: any = chrome.runtime.lastError;
        if (!error) return fallback;
        if (typeof error === "string") return error;
        if (error.message) return String(error.message);
        return fallback;
    } catch (_) {
        return fallback;
    }
}

function settleWaiters(downloadId: number, outcome: DownloadOutcome): boolean {
    const list = waiters.get(downloadId);
    if (!list || list.length === 0) return false;
    waiters.delete(downloadId);
    for (const settle of list) {
        try { settle(outcome); } catch (_) { /* never break the event */ }
    }
    return true;
}

function onDownloadChanged(delta: any): void {
    try {
        if (!delta || typeof delta.id !== "number" || !delta.state || !delta.state.current) return;
        const state = delta.state.current;
        if (state !== "complete" && state !== "interrupted") return;
        const outcome: DownloadOutcome = state === "complete"
            ? { ok: true, state: "complete" }
            : { ok: false, state: "interrupted", error: interruptedMessage(delta.error && delta.error.current) };
        if (settleWaiters(delta.id, outcome)) return;
        recentTerminal.set(delta.id, outcome);
        while (recentTerminal.size > RECENT_TERMINAL_CAP) {
            const oldest = recentTerminal.keys().next().value;
            if (oldest === undefined) break;
            recentTerminal.delete(oldest);
        }
    } catch (_) { /* never break the event */ }
}

// Register the onChanged listener once per downloads API instance. Safe to
// call repeatedly and at worker load; returns whether completion tracking is
// available in this context at all.
export function installDownloadCompletionTracker(): boolean {
    const api = downloadsApi();
    const event = api && api.onChanged;
    if (!event || typeof event.addListener !== "function") return false;
    if (attachedEvent === event) return true;
    try {
        event.addListener(onDownloadChanged);
        attachedEvent = event;
        return true;
    } catch (_) {
        return false;
    }
}

export function completionTrackingAvailable(): boolean {
    return installDownloadCompletionTracker();
}

// Cancel a browser download (best effort; the id may already be gone).
export function cancelTrackedDownload(downloadId: number): void {
    const api = downloadsApi();
    if (!api || typeof api.cancel !== "function") return;
    try {
        api.cancel(downloadId, () => {
            try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
        });
    } catch (_) { /* already gone */ }
}

// Resolve (never reject) once download `downloadId` reaches a terminal state.
// Without onChanged in this context the download is assumed saved as soon as
// it was accepted — the pre-3.6.0 semantics.
export function awaitDownloadCompletion(downloadId: number, options: CompletionOptions = {}): Promise<DownloadOutcome> {
    if (typeof downloadId !== "number" || !Number.isFinite(downloadId) || !installDownloadCompletionTracker()) {
        return Promise.resolve({ ok: true, state: "unknown" });
    }
    const early = recentTerminal.get(downloadId);
    if (early !== undefined) {
        recentTerminal.delete(downloadId);
        return Promise.resolve(early);
    }
    const pollMs = typeof options.pollMs === "number" && options.pollMs > 0 ? options.pollMs : DEFAULT_COMPLETION_POLL_MS;
    const maxWaitMs = typeof options.maxWaitMs === "number" && options.maxWaitMs > 0 ? options.maxWaitMs : DEFAULT_COMPLETION_MAX_WAIT_MS;
    const onTimeout = options.onTimeout === "report" ? "report" : "cancel";
    const signal = options.signal || null;

    return new Promise<DownloadOutcome>((resolve) => {
        const startedAt = nowMs();
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;

        const onAbort = () => {
            if (options.cancelOnAbort) cancelTrackedDownload(downloadId);
            settle({ ok: false, state: "aborted", error: "Download was aborted" });
        };

        const settle: Settle = (outcome) => {
            if (settled) return;
            settled = true;
            const list = waiters.get(downloadId);
            if (list) {
                const remaining = list.filter((entry) => entry !== settle);
                if (remaining.length > 0) waiters.set(downloadId, remaining);
                else waiters.delete(downloadId);
            }
            if (pollTimer !== null) {
                clearTimeout(pollTimer);
                pollTimer = null;
            }
            if (signal) {
                try { signal.removeEventListener("abort", onAbort); } catch (_) { /* no EventTarget */ }
            }
            resolve(outcome);
        };

        const schedulePoll = () => {
            if (settled) return;
            const elapsed = nowMs() - startedAt;
            const remaining = maxWaitMs - elapsed;
            if (remaining <= 0) {
                expire();
                return;
            }
            pollTimer = setTimeout(poll, Math.min(pollMs, remaining));
        };

        const expire = () => {
            if (onTimeout === "report") {
                settle({ ok: false, state: "pending" });
                return;
            }
            // Stuck: cancel it so a retry cannot end up next to a zombie copy
            // of the same page, then report the failure.
            cancelTrackedDownload(downloadId);
            settle({
                ok: false,
                state: "timeout",
                error: "Download did not finish within " + Math.max(1, Math.round(maxWaitMs / 60000)) + " min and was stopped"
            });
        };

        let polls = 0;
        const poll = () => {
            pollTimer = null;
            if (settled) return;
            if (nowMs() - startedAt >= maxWaitMs) {
                expire();
                return;
            }
            const api = downloadsApi();
            if (!api || typeof api.search !== "function") {
                schedulePoll();
                return;
            }
            const firstCheck = polls === 0;
            polls++;
            try {
                api.search({ id: downloadId }, (items: any[]) => {
                    try { void chrome.runtime.lastError; } catch (_) { /* no runtime */ }
                    if (settled) return;
                    if (!Array.isArray(items)) {
                        schedulePoll(); // search error: rely on the event / next poll
                        return;
                    }
                    const item = items[0];
                    if (!item) {
                        if (firstCheck) {
                            // Right after creation the item may not be
                            // searchable yet; only a LATER empty answer means
                            // it was erased from the browser's list.
                            schedulePoll();
                            return;
                        }
                        // Erased mid-flight: nothing proves the file exists,
                        // so treat it as lost.
                        settle({ ok: false, state: "interrupted", error: "Download disappeared from the browser's download list" });
                        return;
                    }
                    if (item.state === "complete") {
                        settle({ ok: true, state: "complete" });
                    } else if (item.state === "interrupted") {
                        settle({ ok: false, state: "interrupted", error: interruptedMessage(item.error) });
                    } else {
                        schedulePoll();
                    }
                });
            } catch (_) {
                schedulePoll();
            }
        };

        if (signal && signal.aborted) {
            onAbort();
            return;
        }
        const list = waiters.get(downloadId);
        if (list) list.push(settle);
        else waiters.set(downloadId, [settle]);
        if (signal) {
            try { signal.addEventListener("abort", onAbort); } catch (_) { /* no EventTarget */ }
        }
        // Check the state right away (an event may have been missed while the
        // worker was restarting), then keep polling slowly until terminal.
        poll();
    });
}

// Test/diagnostic visibility: how many downloads are being waited on.
export function pendingCompletionCount(): number {
    return waiters.size;
}

// Start one browser download: record the requested name for the
// onDeterminingFilename guard, start it and bind the id. Rejects with an
// Error naming the reason when the browser refuses to create the download.
export function startBrowserDownload(url: string, filename: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        try {
            if (typeof filename === "string" && filename !== "") {
                recordDownloadRequest(url, filename);
            }
            chrome.downloads.download({ url: url, filename: filename, conflictAction: "uniquify" }, (downloadId: number) => {
                if (downloadId === undefined) {
                    // Nothing will ever complete for this URL: release the
                    // recorded name so it cannot pin the global listener.
                    discardDownloadRequest(url);
                    reject(new Error(lastErrorMessage("Unable to start download")));
                    return;
                }
                bindDownloadId(url, downloadId);
                resolve(downloadId);
            });
        } catch (error) {
            discardDownloadRequest(url);
            // Never new Error(String(plainObject)): a synchronous throw that is
            // a bare object would otherwise become an Error whose message is
            // "[object Object]" and surface as "Error: [object Object]" once
            // the Downloader wraps it. Unwrap .message when present, otherwise
            // fall back to a readable constant instead of the object's default
            // toString.
            const message = typeof error === "string" && error !== ""
                ? error
                : (error && typeof error.message === "string" && error.message !== ""
                    ? error.message
                    : "Unable to start download");
            reject(new Error(message));
        }
    });
}

// Full lifecycle of one browser download: start it, then wait for the
// terminal state. Rejects with an Error whose message names the reason
// (creation failure, interruption, timeout, abort); resolves with the id.
export async function startTrackedDownload(url: string, filename: string, completion?: CompletionOptions): Promise<{ downloadId: number }> {
    const downloadId = await startBrowserDownload(url, filename);
    const outcome = await awaitDownloadCompletion(downloadId, completion);
    if (!outcome.ok) {
        throw new Error(outcome.error || "Download interrupted");
    }
    return { downloadId: downloadId };
}

// ---- raw-mode concurrency setting -------------------------------------------
// Raw mode hands every page to the browser's download manager and (since
// 3.6.0) waits for each file to finish, so its batch size is the number of
// browser downloads running at once. It has its own, smaller cap than the
// archive-mode fetch concurrency (up to 15), which would flood the download
// shelf and the disk.

export const RAW_CONCURRENCY_DEFAULT = 3;
export const RAW_CONCURRENCY_MAX = 10;

// The stored "rawMaxConcurrent" value is a select's string; corrupt/legacy
// values fall back to the default and anything outside 1..10 is clamped.
export function normalizeRawConcurrency(value: any): number {
    const parsed = parseInt(value as any, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return RAW_CONCURRENCY_DEFAULT;
    return Math.min(RAW_CONCURRENCY_MAX, parsed);
}
