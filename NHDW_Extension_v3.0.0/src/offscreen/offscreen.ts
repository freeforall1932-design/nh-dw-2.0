import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import Downloader from "../background/Downloader";
import { errorMessage } from "../utils/utils";
import { fetchUrlFromTab } from "../background/tabImageFetch";
import { setImageServers } from "../sources/cdnConfig";
import { normalizeFormat } from "../utils/downloadFormats";
import { runBatchDownload, runPagedBatchDownload, buildRetryJob, BatchHost, BatchJobOptions } from "../utils/batchPipeline";
// Pure helpers only: the offscreen document must never call the storage
// functions of this module (it has no chrome.storage). The service worker
// relays the recorded IDs with the job and owns every history write.
import {
    BatchOutcome,
    artifactRecordFilename,
    historyRecords
} from "../utils/downloadHistory";
var JSZip = require("jszip");

// This offscreen document runs the actual download pipeline.
//
// Why: MV3 service workers cannot create object URLs (no URL.createObjectURL)
// and can be terminated while long work is in flight. The offscreen document
// is a hidden extension page with a DOM, so it exposes the finished ZIP through
// a real object URL instead of the memory-hungry base64 round-trip, and it is
// not subject to the service worker idle timeout.
//
// The service worker relays commands with {target: "offscreen", action: ...}
// and forwards answers back; progress and errors are broadcast from here with
// the same updateProgress/downloadError messages the popup already listens to.
//
// API surface: per the Chrome docs, "The runtime API is the only extensions
// API supported by offscreen documents". This file must therefore NEVER touch
// chrome.storage, chrome.downloads, or chrome.scripting directly - settings
// arrive in the relayed message (`options`, read by the worker from
// chrome.storage), finished artifacts are saved by the worker (saveDownload),
// and tab injections are performed by the worker (fetchInTab / fetchUrlInTab,
// see tabImageFetch.ts). Doing otherwise crashes the document at load time
// (TypeError: Cannot read properties of undefined) before the message
// listener below registers, and every download then fails with
// "Could not establish connection. Receiving end does not exist."

let currentDownloader: Downloader | null = null;
let parsing: AParsing = new ApiParsing();

// One AbortController per download job. All metadata and image fetches share
// this signal so that `goBack` can abort in-flight requests, not merely flag
// the job as "awaiting abort" while the network calls run to completion.
let jobAbortController: AbortController | null = null;

// True while a top-level job (single gallery, batch, or pages) is running.
// isDownloadFinished answers from this flag rather than
// `currentDownloader.isDone()`, which is momentarily true between galleries in
// a batch (the last gallery's Downloader is done but the batch is not) and
// used to make the popup misreport a running batch as finished/interrupted.
let jobRunning = false;
let jobPaused = false;

// Jobs are serialized inside the long-lived offscreen document. Keeping this
// queue here (rather than in the MV3 worker) means it remains available while
// the worker is idle and is reawakened by progress/finish messages. Each entry
// already contains its per-job options and source tab id supplied by the worker.
const queuedJobs: any[] = [];

// Records of successfully completed galleries since the last jobFinished.
// Queued jobs run without sending jobFinished between them (the worker's
// active-job marker must stay set), so records accumulate here and are
// delivered together with the FINAL jobFinished. The worker writes them to
// chrome.storage.local: only successful completions are recorded, never
// enqueues, so a cancelled or failed job cannot poison the history.
let pendingHistoryRecords: Array<{ id: string; filename: string }> = [];

function beginJob(): AbortSignal {
    jobAbortController = new AbortController();
    return jobAbortController.signal;
}

function abortJob() {
    if (jobAbortController !== null) {
        jobAbortController.abort();
    }
}

function jobWasAborted(): boolean {
    return jobAbortController !== null && jobAbortController.signal.aborted;
}

// Tell the service worker the job is over so it clears the active-job marker
// right away. The document itself is closed later by the 60s idle timer;
// clearing the marker at completion (not on idle) stops the popup from
// misreporting a finished download as "interrupted" during that window.
function notifyJobFinished() {
    jobRunning = false;
    const next = queuedJobs.shift();
    if (next) {
        // Continue directly into the next job. Do not send jobFinished between
        // queued jobs: the worker's active-job marker must stay set. Finished
        // galleries from the previous job stay in pendingHistoryRecords and
        // ride along with the final jobFinished.
        broadcastQueueState();
        runQueuedJob(next);
        return;
    }
    const records = pendingHistoryRecords;
    pendingHistoryRecords = [];
    chrome.runtime.sendMessage({ from: "offscreen", action: "jobFinished", records: records });
}

// Accumulate history records produced by one finished job (they are written
// by the worker when jobFinished is finally sent).
function collectHistoryRecords(records: Array<{ id: string; filename: string }>) {
    if (records && records.length > 0) {
        pendingHistoryRecords = pendingHistoryRecords.concat(records);
    }
}

// The active-job marker lives in the service worker's chrome.storage.session
// (offscreen documents have no chrome.storage). The worker sets it when it
// relays a download command and clears it on jobFinished / goBack /
// offscreenIdle.

// Pick the metadata parser for this job from the options the service worker
// relayed (it read chrome.storage.sync on our behalf).
function applyParserOptions(options: any) {
    parsing = (options && options.htmlParsing) ? new HtmlParsing() : new ApiParsing();
}

// Apply the image CDN server list the service worker resolved (GET /api/v2/cdn,
// validated, permission-filtered, cached for the session) and relayed with the
// job. The offscreen document must not fetch the config itself: it has no
// chrome.storage to cache in and no chrome.permissions to filter with. The
// list feeds both URL generation and allowed-image validation (cdnConfig.ts is
// shared with tabImageFetch), and the built-in fallback mirrors always remain
// as the tail. Each queued job carries its own options, so this is applied per
// job rather than once.
function applyCdnServers(options: any) {
    const relayed = options && Array.isArray(options.imageServers) ? options.imageServers : null;
    setImageServers(relayed && relayed.length > 0 ? relayed : null);
}

// One request/response round trip to the service worker. Resolves with the
// response (null when the worker is unreachable or answered nothing); never
// rejects. Handles both the callback and the promise flavour of sendMessage.
function askWorker(message: any): Promise<any> {
    return new Promise<any>((resolve) => {
        let settled = false;
        const finish = (response: any) => {
            if (settled) return;
            settled = true;
            resolve(response === undefined ? null : response);
        };
        try {
            const result: any = chrome.runtime.sendMessage(
                Object.assign({ from: "offscreen" }, message),
                (response: any) => {
                    if (chrome.runtime.lastError) {
                        finish(null);
                        return;
                    }
                    finish(response);
                }
            );
            if (result && typeof result.then === "function") {
                result.then((response: any) => finish(response)).catch(() => finish(null));
            }
        } catch (_) {
            finish(null);
        }
    });
}

// Follow one browser download (started by the worker on our behalf) to its
// terminal state. chrome.downloads.download's callback only means the item
// was CREATED; a raw page interrupted afterwards used to count as saved and
// the gallery was recorded complete with a page missing. The worker answers
// each awaitDownload after a bounded slice ("pending" while still running),
// so no single message channel is held open long enough to get the MV3
// worker terminated. Workers without downloads.onChanged answer "unknown"
// and keep the historical "started = saved" behaviour.
const AWAIT_DOWNLOAD_MAX_MS = 4 * 60 * 1000;

async function awaitDownloadViaServiceWorker(downloadId: number, signal: AbortSignal | null): Promise<void> {
    const startedAt = Date.now();
    while (true) {
        if (signal && signal.aborted) {
            // Loose pages are worthless half-done: stop the browser download.
            void askWorker({ action: "cancelDownload", downloadId: downloadId });
            throw new Error("Download was aborted");
        }
        const answer = await askWorker({ action: "awaitDownload", downloadId: downloadId });
        if (!answer || answer.result !== true) {
            // Older worker or unreachable: nothing more can be learned.
            return;
        }
        if (answer.ok) {
            return;
        }
        if (answer.state === "pending") {
            if (Date.now() - startedAt >= AWAIT_DOWNLOAD_MAX_MS) {
                void askWorker({ action: "cancelDownload", downloadId: downloadId });
                throw new Error("Download did not finish within " + Math.round(AWAIT_DOWNLOAD_MAX_MS / 60000) + " min and was stopped");
            }
            continue;
        }
        // errorMessage() (never String()): a worker that answers with a
        // structured-cloned Error object would otherwise stringify to
        // "Error: [object Object]" and swallow the real reason. Message-first
        // keeps every reason readable regardless of what crossed the channel.
        throw new Error(errorMessage(answer.error) || "Download interrupted");
    }
}

// Ask the service worker to hand a URL to the download manager and wait until
// the file is actually written. The URL is either a blob: object URL created
// here (zip/pdf mode) or the original CDN URL (raw mode). Blob URLs are
// extension-origin, so the worker can download them even though it cannot
// create object URLs itself.
async function saveViaServiceWorker(url: string, filename: string): Promise<void> {
    const response = await askWorker({ action: "saveDownload", url: url, filename: filename });
    if (!response) {
        throw new Error("Unable to save the file (worker unreachable)");
    }
    if (response.result === false) {
        // Message-first, never String(): an Error object in response.error
        // would render as "Error: [object Object]" (the old raw-mode report).
        throw new Error(errorMessage(response.error) || "Unable to save the file");
    }
    if (typeof response.result === "number") {
        await awaitDownloadViaServiceWorker(response.result, jobAbortController ? jobAbortController.signal : null);
    }
}

// Some Chromium builds ignore chrome.downloads.download's `filename` for
// blob: URLs and save the artifact under the blob's UUID instead of the
// gallery title (content arrives fine, the name does not). For blobs created
// in THIS document we sidestep that entirely with the standard HTML5 download
// mechanism: a same-context anchor whose `download` attribute carries the
// name. The anchor resolves the blob in the context that created it, so the
// name is applied by the browser itself rather than by chrome.downloads.
function saveBlobViaAnchor(blobUrl: string, filename: string): void {
    // Tell the worker which name this blob carries BEFORE the click: the
    // worker's onDeterminingFilename guard re-asserts it if any other
    // extension's listener would rename the download (Chromium bug 579563).
    // Fire-and-forget — the save must proceed even if the worker is gone.
    try {
        chrome.runtime.sendMessage({ from: "offscreen", action: "recordDownloadName", url: blobUrl, filename: filename });
    } catch (_) { /* bookkeeping only */ }
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    // Detach after the browser has picked up the download. The blob itself
    // stays alive for revokeObjectUrlDelayMs (handled by the Downloader).
    setTimeout(() => {
        try {
            document.body.removeChild(anchor);
        } catch (_) { /* already detached */ }
    }, 0);
}

// Route a finished artifact to the download manager. Blob artifacts
// (zip/cbz/pdf) go through the anchor mechanism above; everything else
// (raw-mode CDN URLs) is relayed to the service worker's
// chrome.downloads.download, which names plain http(s) URLs correctly.
function saveArtifactSmart(url: string, filename: string): Promise<void> {
    if (typeof url === "string" && url.indexOf("blob:") === 0) {
        try {
            saveBlobViaAnchor(url, filename);
            return Promise.resolve();
        } catch (_) {
            // DOM unavailable/unexpected: fall back to the worker relay.
            return saveViaServiceWorker(url, filename);
        }
    }
    return saveViaServiceWorker(url, filename);
}

// ---- idle handling -------------------------------------------------------
// After the last job finishes, tell the service worker to close this document
// so it does not linger forever. New jobs cancel the timer.
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleTimer() {
    if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function scheduleIdleClose() {
    cancelIdleTimer();
    idleTimer = setTimeout(function() {
        chrome.runtime.sendMessage({ from: "offscreen", action: "offscreenIdle" });
    }, 60000);
}

// ---- progress / error plumbing -------------------------------------------
// Remember the latest progress so getProgress can refresh the popup when it
// (re)opens mid-download.
// All broadcasts are marked from:"offscreen" so the service worker can tell
// them apart from popup commands (they reach the popup directly).
let latestProgress: { progress: number; doujinshiName: string | null; isZipping: boolean; retry: string | null } | null = null;

function errorCallback(error: string) {
    chrome.runtime.sendMessage({ from: "offscreen", action: "downloadError", error: error });
}

// Single-gallery failure report that also NAMES the gallery and carries what
// the popup needs to offer "Retry": the id and the job it was started with.
function galleryErrorCallback(id: string, name: string, retryJob: any) {
    return (error: any) => {
        chrome.runtime.sendMessage({
            from: "offscreen",
            action: "downloadError",
            error: errorMessage(error),
            galleryId: String(id),
            galleryName: name,
            retryJob: retryJob
        });
    };
}

function broadcastQueueState() {
    if (latestProgress !== null) {
        chrome.runtime.sendMessage(Object.assign({ from: "offscreen", action: "updateProgress", queued: queuedJobs.length, paused: jobPaused }, latestProgress));
    }
}

function progressCallback(progress: number, doujinshiName: string | null, isZipping: boolean, retry: string | null = null) {
    latestProgress = { progress: progress, doujinshiName: doujinshiName, isZipping: isZipping, retry: retry };
    chrome.runtime.sendMessage({
        from: "offscreen",
        action: "updateProgress",
        progress: progress,
        doujinshiName: doujinshiName,
        isZipping: isZipping,
        retry: retry,
        queued: queuedJobs.length
    });
}

function isDownloadFinished(): boolean {
    return !jobRunning;
}

function downloadDoujinshi(jsonTmp: any, path: string, name: string, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    const signal = beginJob();
    jobRunning = true;
    let zip = new JSZip();
    // A failure names the gallery and carries the job settings so the popup
    // can re-add it (same format / master folder; metadata is re-resolved).
    const galleryId = jsonTmp && jsonTmp.id !== undefined ? String(jsonTmp.id) : "";
    const retryJob = buildRetryJob(sourceTabId, options);
    // Single-gallery jobs own their archive: pages at the root, file named
    // after the gallery (no Title/Title double folder).
    currentDownloader = new Downloader(jsonTmp, path, galleryErrorCallback(galleryId, name, retryJob), progressCallback, name, zip, path, signal,
        undefined, { useZip: options ? options.useZip : undefined, maxConcurrentDownloads: options ? options.maxConcurrentDownloads : undefined, rawMaxConcurrent: options ? options.rawMaxConcurrent : undefined, archiveLayout: "flat", apiKey: options && options.apiKey ? options.apiKey : undefined, useServerArchive: options ? !!options.useServerArchive : undefined, rawMasterFolder: options && typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : undefined, archiveMasterFolder: options && typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : undefined });
    currentDownloader.saveUrl = saveArtifactSmart;
    if (typeof sourceTabId === "number") {
        currentDownloader.sourceTabId = sourceTabId;
    }
    // Record history ONLY on a fully successful single-title download (never
    // on enqueue, never on failure/cancel). "filename" mirrors what the
    // Downloader saves: <path>.<format> for archives, <master>/<path>/001.jpg
    // for raw.
    const format = normalizeFormat(options && options.useZip, "zip");
    const masterFolder = format === "raw"
        ? (options && typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : "NHDW")
        : (options && typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : "");
    currentDownloader.startAsync()
        .then(() => {
            collectHistoryRecords([{
                id: String(jsonTmp.id),
                filename: artifactRecordFilename({ format: format, name: path, masterFolder: masterFolder })
            }]);
            notifyJobFinished(); scheduleIdleClose();
        })
        .catch(() => { notifyJobFinished(); scheduleIdleClose(); });
}

function makeOffscreenBatchHost(): BatchHost {
    return {
        get parsing() { return parsing; },
        getAbortSignal: () => jobAbortController ? jobAbortController.signal : null,
        wasAborted: () => jobWasAborted(),
        messageExtras: () => ({ from: "offscreen", queued: queuedJobs.length }),
        sendMessage: (payload: any) => { chrome.runtime.sendMessage(payload); },
        errorCallback: errorCallback,
        progressCallback: progressCallback,
        fetchUrlFromTab: fetchUrlFromTab,
        fetchImpl: (url: string, init?: any) => fetch(url, init),
        newZip: () => new JSZip(),
        downloadGallery: async (job) => {
            currentDownloader = new Downloader(
                job.json,
                job.path,
                errorCallback,
                progressCallback,
                job.displayName,
                job.zip,
                job.zipName,
                jobAbortController ? jobAbortController.signal : null,
                undefined,
                job.gallerySettings
            );
            currentDownloader.saveUrl = saveArtifactSmart;
            if (typeof job.sourceTabId === "number") {
                currentDownloader.sourceTabId = job.sourceTabId;
            }
            await currentDownloader.startAsync();
        }
    };
}

function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, galleryMetadata: Record<string, any> = {}, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    beginJob();
    jobRunning = true;
    let zip = new JSZip();
    const jobOptions: BatchJobOptions = options || {};
    runBatchDownload({
        zip: zip,
        allDoujinshis: allDoujinshis,
        finalName: finalName,
        downloadAtEnd: true,
        galleryMetadata: galleryMetadata,
        sourceTabId: sourceTabId,
        options: jobOptions,
        host: makeOffscreenBatchHost()
    })
        .then((outcome: BatchOutcome) => {
            const format = normalizeFormat(jobOptions.useZip, "zip");
            const effectiveSeparate = !!(jobOptions.downloadSeparately || format === "raw");
            collectHistoryRecords(historyRecords(outcome, {
                effectiveSeparate: effectiveSeparate,
                format: format,
                finalName: finalName,
                archiveMasterFolder: typeof jobOptions.archiveMasterFolder === "string" ? jobOptions.archiveMasterFolder : ""
            }));
            notifyJobFinished(); scheduleIdleClose();
        })
        .catch(function(error) {
            if (!jobWasAborted()) {
                errorCallback(String(error));
            }
            notifyJobFinished();
            scheduleIdleClose();
        });
}

function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, url: string, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    beginJob();
    jobRunning = true;
    const jobOptions: BatchJobOptions = options || {};
    runPagedBatchDownload({
        allDoujinshis: allDoujinshis,
        pagesArr: pagesArr,
        path: path,
        url: url,
        sourceTabId: sourceTabId,
        options: jobOptions,
        host: makeOffscreenBatchHost()
    })
        .then((outcome: BatchOutcome) => {
            collectHistoryRecords(outcome.records);
            notifyJobFinished(); scheduleIdleClose();
        })
        .catch(function(error) {
            if (!jobWasAborted()) {
                errorCallback(String(error));
            }
            notifyJobFinished();
            scheduleIdleClose();
        });
}

function goBack() {
    jobPaused = false;
    if (currentDownloader) currentDownloader.resume();
    abortJob();
    jobRunning = false;
    if (currentDownloader !== null && !currentDownloader.isDone()) {
        currentDownloader.isAwaitingAbort = true;
        currentDownloader.currentProgress = 100;
    }
    currentDownloader = null;
}

function runQueuedJob(request: any) {
    jobPaused = false;
    if (request.action === "downloadDoujinshi") {
        downloadDoujinshi(request.json, request.path, request.name, request.tabId, request.options);
    } else if (request.action === "downloadAllDoujinshis") {
        downloadAllDoujinshis(request.allDoujinshis, request.finalName, request.galleryMetadata || {}, request.tabId, request.options);
    } else if (request.action === "downloadAllPages") {
        downloadAllPages(request.allDoujinshis, request.pages, request.finalName, request.url, request.tabId, request.options);
    }
}

// Commands relayed by the service worker.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || request.target !== "offscreen") {
        return false;
    }
    if (request.action === "isDownloadFinished") {
        sendResponse({ result: isDownloadFinished(), queued: queuedJobs.length });
    } else if (request.action === "downloadDoujinshi" || request.action === "downloadAllDoujinshis" || request.action === "downloadAllPages") {
        if (jobRunning) {
            queuedJobs.push(request);
            broadcastQueueState();
            sendResponse({ result: "queued", position: queuedJobs.length });
        } else {
            runQueuedJob(request);
            sendResponse({ result: "started" });
        }
    } else if (request.action === "goBack") {
        goBack();
        sendResponse({ result: "success" });
    } else if (request.action === "pause") {
        if (currentDownloader) currentDownloader.pause();
        jobPaused = true;
        sendResponse({ result: "success", paused: true });
    } else if (request.action === "resume") {
        if (currentDownloader) currentDownloader.resume();
        jobPaused = false;
        sendResponse({ result: "success", paused: false });
    } else if (request.action === "getProgress") {
        sendResponse(Object.assign({ result: "success", queued: queuedJobs.length, paused: jobPaused },
            latestProgress === null
                ? { progress: undefined, doujinshiName: null, isZipping: false, retry: null }
                : latestProgress));
    } else if (request.action === "clearQueue") {
        const removed = queuedJobs.length;
        queuedJobs.splice(0, queuedJobs.length);
        broadcastQueueState();
        sendResponse({ result: "success", removed: removed });
    }
    return false;
});

scheduleIdleClose();
