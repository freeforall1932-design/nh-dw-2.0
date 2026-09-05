import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { parseGalleryCardsFromHtml } from "../parsing/CardParsing";
import Downloader from "../background/Downloader";
import { utils, classifyError, errorMessage } from "../utils/utils";
import { extractGalleryFromHtml, looksLikeGallery, coerceGallery, requireGallery } from "../parsing/GalleryEmbed";
import { fetchUrlFromTab, TabUrlResult } from "../background/tabImageFetch";
import { fetchNhentaiApi } from "../utils/apiAuth";
import { setImageServers } from "../sources/cdnConfig";
import { normalizeFormat } from "../utils/downloadFormats";
// Pure helpers only: the offscreen document must never call the storage
// functions of this module (it has no chrome.storage). The service worker
// relays the recorded IDs with the job and owns every history write.
import {
    BatchOutcome,
    FailedGallery,
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

function tryParseGalleryText(text: string): any | null {
    if (!text) return null;
    const trimmed = String(text).trim();
    if (trimmed.startsWith("{")) {
        try {
            const j = coerceGallery(JSON.parse(trimmed));
            if (j) return j;
        } catch (_) {}
    }
    const fromHtml = extractGalleryFromHtml(text);
    if (looksLikeGallery(fromHtml)) return fromHtml;
    return null;
}

async function getGalleryViaTab(tabId: number, galleryId: string): Promise<any | null> {
    const urls = [
        "https://nhentai.net/api/v2/galleries/" + encodeURIComponent(galleryId),
        "https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/",
        "https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/1/"
    ];
    for (const url of urls) {
        try {
            const via = await fetchUrlFromTab(tabId, url);
            if (via && via.ok && via.text) {
                const parsed = tryParseGalleryText(via.text);
                if (parsed) return parsed;
            }
        } catch (_) {}
    }
    return null;
}

async function downloadAllDoujinshisAsync(
    zip: typeof JSZip,
    allDoujinshis: Record<string, string>,
    finalName: string,
    downloadAtEnd: boolean,
    galleryMetadata: Record<string, any> = {},
    sourceTabId?: number | null,
    options: any = {}
) {
    // The service worker read these from chrome.storage.sync and relayed them
    // (offscreen documents have no chrome.storage of their own).
    let downloadName: string = options.downloadName || "{pretty}";
    let duplicateBehaviour: string = options.duplicateBehaviour || "rename";
    let replaceSpaces: boolean = options.replaceSpaces !== undefined ? options.replaceSpaces : true;
    let downloadSeparately: boolean = !!options.downloadSeparately;
    // Raw can never merge (no container), so it always behaves as one folder
    // per title and is recorded per gallery regardless of the requested mode.
    const format: string = normalizeFormat(options.useZip, "zip");
    const effectiveSeparate: boolean = downloadSeparately || format === "raw";
    // Each gallery in a separate archive owns that archive (flat entries,
    // named after the gallery); a shared batch archive keeps one folder per
    // gallery inside.
    const gallerySettings: any = {
        useZip: options.useZip,
        maxConcurrentDownloads: options.maxConcurrentDownloads,
        // Raw mode's own cap on simultaneous browser downloads (each page is
        // awaited to completion, so this is the number in flight at once).
        rawMaxConcurrent: options.rawMaxConcurrent,
        archiveLayout: downloadSeparately ? "flat" : "nested",
        apiKey: options.apiKey || null,
        useServerArchive: !!options.useServerArchive,
        rawMasterFolder: typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : undefined,
        // Optional master folder for finished archives too - the wrap is a
        // user choice in list mode, not something forced on every download.
        archiveMasterFolder: typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : undefined
    };
    let names: Array<string> = [];
    let length = Object.keys(allDoujinshis).length;
    let allKeys = Object.keys(allDoujinshis);
    // Per-gallery tally for the end-of-batch summary.
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const failedKinds: Record<string, number> = {};

    // History guard (the authoritative safety net): the UI pre-check already
    // removes recorded galleries before enqueueing, but anything that falls
    // through (a race, a stale panel, Download all across pages parsed here)
    // is skipped WITHOUT fetching metadata — zero API calls for skipped items.
    // The worker relayed the recorded ID list with the job (offscreen has no
    // chrome.storage); redownloadIds are the user's "download anyway" picks.
    const alreadySet = new Set<string>(
        Array.isArray(options.alreadyDownloadedIds) ? options.alreadyDownloadedIds.map(String) : []
    );
    const redownloadSet = new Set<string>(
        Array.isArray(options.redownloadIds) ? options.redownloadIds.map(String) : []
    );

    // History records produced by this invocation.
    const records: Array<{ id: string; filename: string }> = [];
    const batchKeys: string[] = [];
    let finalSaveOk = false;
    // Every gallery that did not complete, by name, so the summary can list
    // them and the popup can re-add exactly those.
    const failedGalleries: FailedGallery[] = [];

    function countFailure(key: string, error: any) {
        failed++;
        const { kind } = classifyError(error);
        failedKinds[kind] = (failedKinds[kind] || 0) + 1;
        failedGalleries.push({ id: String(key), name: String(allDoujinshis[key] || key), error: errorMessage(error) });
    }

    for (let i = 0; i < length; i++) {
        let key = allKeys[i];
        // Only per-title (separate) output can skip a gallery: a merged
        // archive must contain every selected title, so batch jobs never skip
        // (they re-record everything only when the whole job succeeds).
        if (effectiveSeparate && alreadySet.has(key) && !redownloadSet.has(key)) {
            skipped++;
            continue;
        }
        // Tell the popup which gallery the batch is working on. Broadcast with
        // from:"offscreen" so the service worker does not relay it back.
        chrome.runtime.sendMessage({
            from: "offscreen",
            action: "batchProgress",
            current: i + 1,
            total: length,
            galleryName: allDoujinshis[key],
            stage: "Downloading",
            queued: queuedJobs.length
        });

        // Metadata route order mirrors the service worker's batch loop:
        //   keyed mode:  pre-resolved -> keyed official API -> tab -> direct
        //   keyless:     pre-resolved -> tab -> direct (unchanged)
        const apiKey = options && options.apiKey ? String(options.apiKey) : "";
        let jsonKeyed: any | null = null;
        let jsonViaTab: any | null = null;
        let resp: any = null;
        if (galleryMetadata[key]) {
            resp = { ok: true, status: 200, statusText: "resolved in browser" };
        } else if (apiKey) {
            // API key mode: the official keyed API is the primary route. A
            // failure here falls through to the tab-based routes below.
            try {
                const keyedParsing = new ApiParsing();
                const keyedResp = await fetchNhentaiApi(
                    keyedParsing.GetUrl(key),
                    { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined },
                    apiKey
                );
                if (keyedResp.ok) {
                    jsonKeyed = await keyedParsing.GetJsonAsync(keyedResp);
                }
            } catch (_) {
                // Fall through to the tab-based routes.
            }
            if (jsonKeyed) {
                resp = { ok: true, status: 200, statusText: "resolved via keyed API" };
            }
        }
        if (!resp) {
            // Try via the user's tab session (API + gallery pages)
            if (typeof sourceTabId === "number") {
                jsonViaTab = await getGalleryViaTab(sourceTabId, key);
                if (jsonViaTab) {
                    resp = { ok: true, status: 200, statusText: "resolved via tab" };
                }
            }
            if (!resp) {
                // Fallback to extension-origin fetch (often 403)
                let viaTab: TabUrlResult | null = null;
                if (typeof sourceTabId === "number") {
                    viaTab = await fetchUrlFromTab(sourceTabId, parsing.GetUrl(key));
                }
                if (viaTab && viaTab.ok && viaTab.text !== null) {
                    const tabText = viaTab.text;
                    const tabStatus = viaTab.status;
                    const tabStatusText = viaTab.statusText;
                    const tabContentType = viaTab.contentType;
                    resp = {
                        ok: true,
                        status: tabStatus,
                        statusText: tabStatusText,
                        headers: { get: (name: string) => (String(name).toLowerCase() === "content-type" ? tabContentType : null) },
                        text: () => Promise.resolve(tabText)
                    };
                } else {
                    const headers: Record<string, string> = {};
                    if (options && typeof options.apiKey === "string" && options.apiKey.trim()) {
                        headers["Authorization"] = "Key " + options.apiKey.trim();
                    }
                    resp = await fetch(parsing.GetUrl(key), {
                        credentials: "include",
                        cache: "no-store",
                        headers: headers,
                        signal: jobAbortController ? jobAbortController.signal : undefined
                    });
                }
            }
        }

        if (resp.ok)
        {
            let json: any;
            try {
                if (galleryMetadata[key]) {
                    json = galleryMetadata[key];
                } else if (jsonKeyed) {
                    json = jsonKeyed;
                } else if (jsonViaTab) {
                    json = jsonViaTab;
                } else {
                    json = await parsing.GetJsonAsync(resp);
                    // If parsing is ApiParsing but we actually fetched a gallery page via tab fallback,
                    // try HTML parsing as second chance.
                    json = coerceGallery(json) || json;
                    if (!looksLikeGallery(json) && resp.text) {
                        try {
                            const t = typeof resp.text === "function" ? await resp.text() : "";
                            const htmlParsed = extractGalleryFromHtml(t);
                            if (looksLikeGallery(htmlParsed)) json = htmlParsed;
                        } catch (_) {}
                    }
                }
                // After every metadata route: require a real gallery before
                // touching json.title. Non-gallery JSON ({}, {error:...}) used
                // to throw outside this try and reject the whole batch (item 28).
                json = requireGallery(json);
            } catch (error) {
                countFailure(key, error);
                errorCallback("Can't download " + key + " (" + errorMessage(error) + ").");
                continue;
            }

            let title = utils.getDownloadName(downloadName, json.title.pretty === "" ?
                json.title.english.replace(/\[[^\]]+\]/g, '').replace(/\([^\)]+\)/g, '') : json.title.pretty,
                json.title.english, json.title.japanese, key, json.tags);
            if (names.includes(title)) {
                // "ignore" only skips a duplicate FILE in separate mode,
                // and that skip is counted so the summary stays honest.
                // Merged jobs must never drop a gallery silently (item 31):
                // the second title is id-suffixed so the archive still
                // contains every selected gallery.
                if (duplicateBehaviour === "ignore" && effectiveSeparate) {
                    skipped++;
                    continue;
                }
                let tmp = title;
                while (names.includes(tmp)) {
                    tmp = title + " (" + key + ")";
                }
                title = tmp;
            }
            names.push(title);
            let zipName = null;
            if (effectiveSeparate) {
                // Separate files are named from the (list-mode) template and
                // the gallery's OWN metadata, cleaned exactly like a
                // single-title download - never from the page URL.
                zipName = utils.cleanName(title, replaceSpaces, key);
            } else if (downloadAtEnd && i == length - 1) {
                zipName = finalName;
            }
            // Batch mode: the merged archive is saved by the LAST gallery's
            // Downloader. Its success is what makes the job "clean".
            const isFinalSave = !effectiveSeparate && downloadAtEnd && i === length - 1;
            currentDownloader = new Downloader(json, utils.cleanName(title, replaceSpaces, key), errorCallback, progressCallback, allDoujinshis[key],
            downloadSeparately ? new JSZip() : zip,
            zipName, jobAbortController ? jobAbortController.signal : null, undefined,
            gallerySettings);
            currentDownloader.saveUrl = saveArtifactSmart;
            if (typeof sourceTabId === "number") {
                currentDownloader.sourceTabId = sourceTabId;
            }

            try {
                await currentDownloader.startAsync();
                succeeded++;
                if (isFinalSave) {
                    finalSaveOk = true;
                }
                if (effectiveSeparate) {
                    // Only a fully successful gallery is recorded; a partial
                    // gallery (any page failed) re-downloads cleanly next run.
                    records.push({
                        id: key,
                        filename: artifactRecordFilename({
                            format: format,
                            name: zipName || utils.cleanName(title, replaceSpaces, key),
                            masterFolder: format === "raw"
                                ? (typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : "NHDW")
                                : (typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : "")
                        })
                    });
                } else {
                    batchKeys.push(key);
                }
            } catch (error) {
                countFailure(key, error);
            }
        }
        else
        {
            const isCf = resp.status === 503 || resp.status === 403;
            const ct = (resp.headers.get("content-type") || "").toLowerCase();
            const isHtml = ct.includes("html");
            if (isCf || isHtml) {
                errorCallback("Can't download " + key + " - Cloudflare blocked the request (HTTP " + resp.status + "). Open the gallery in a tab, complete any challenge, then try again.");
            } else {
                errorCallback("Can't download " + key + " (Code " + resp.status + ": " + resp.statusText + ").");
            }
            countFailure(key, "Can't download " + key + " (Code " + resp.status + ": " + resp.statusText + ").");
        }
    }

    if (!jobWasAborted()) {
        chrome.runtime.sendMessage({
            from: "offscreen",
            action: "batchSummary",
            succeeded: succeeded,
            failed: failed,
            skipped: skipped,
            total: length,
            failedKinds: failedKinds,
            // Names + ids of the failures and the job settings, so the popup
            // can show WHICH galleries failed and re-add exactly those.
            failedGalleries: failedGalleries,
            retryJob: buildRetryJob(sourceTabId, options)
        });
    }
    // Batch mode is all-or-nothing: every gallery must have succeeded AND the
    // merged artifact must have been saved (the last gallery carries the save).
    // A merged file only records its title set when the run is fully clean, so
    // a failure part-way leaves all of them re-downloadable. Multi-page
    // "Download all" calls run this per page with downloadAtEnd true ONLY on
    // the final page: earlier pages must be failure-free but cannot yet be
    // clean (the save belongs to the last page), so finalSaveOk is required
    // only when this invocation owns the save.
    const clean = effectiveSeparate
        ? true
        : (failed === 0 && batchKeys.length > 0 && (!downloadAtEnd || finalSaveOk));
    return {
        records: records,
        clean: clean,
        batchKeys: batchKeys,
        skipped: skipped,
        failedGalleries: failedGalleries
    } as BatchOutcome;
}

// The settings a retry of failed galleries must be started with (per-job
// overrides in the shape the popup sends to the worker; see
// utils/failedGalleries.ts). A retry always produces separate files: the
// failed titles are re-downloaded on their own, never merged into a second
// partial archive. Metadata is resolved again, so nothing large is kept.
function buildRetryJob(sourceTabId: number | null | undefined, options: any): any {
    const format = normalizeFormat(options ? options.useZip : "zip", "zip");
    const job: any = { formatOverride: format };
    if (typeof sourceTabId === "number") job.tabId = sourceTabId;
    if (options && typeof options.downloadName === "string") job.nameTemplate = options.downloadName;
    const masterFolder = format === "raw"
        ? (options && typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : undefined)
        : (options && typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : undefined);
    if (typeof masterFolder === "string") job.masterFolder = masterFolder;
    return job;
}

function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, galleryMetadata: Record<string, any> = {}, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    beginJob();
    jobRunning = true;
    let zip = new JSZip();
    downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, true, galleryMetadata, sourceTabId, options || {})
        .then((outcome: BatchOutcome) => {
            // Record on SUCCESS only: separate mode per successful gallery;
            // merged mode records every title only when the whole job is clean.
            const jobOptions = options || {};
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

async function downloadAllPagesAsync(
    allDoujinshis: Record<string, string>,
    pagesArr: Array<number>,
    path: string,
    url: string,
    sourceTabId?: number | null,
    options: any = {}
): Promise<BatchOutcome> {
    let downloadName: string = options.downloadName || "{pretty}";
    const format: string = normalizeFormat(options.useZip, "zip");
    const effectiveSeparate: boolean = !!(options.downloadSeparately || format === "raw");

    // Aggregate every page's outcome: separate mode keeps per-gallery records
    // (they are real, independent files); merged mode records every title only
    // when EVERY page succeeded and the artifact was saved.
    const allRecords: Array<{ id: string; filename: string }> = [];
    const allBatchKeys: string[] = [];
    let allClean = true;
    let skippedTotal = 0;
    let pagesFetched = 0;

    let zip = new JSZip();
    for (let i = 0; i < pagesArr.length; i++) {
        let curr = pagesArr[i];
        let m = /page=([0-9]+)/.exec(url)
        if (m !== null) {
            url = url.replace(m[0], "page=" + curr);
        } else if (url.includes("?")) {
            url += "&page=" + curr
        } else {
            url += "?page=" + curr
        }
        let pageText: string | null = null;
        if (typeof sourceTabId === "number") {
            const viaTab = await fetchUrlFromTab(sourceTabId, url);
            if (viaTab && viaTab.ok && viaTab.text !== null) {
                pageText = viaTab.text;
            }
        }
        if (pageText === null) {
            const resp = await fetch(url, { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined });
            if (resp.ok) {
                pageText = await resp.text();
            }
        }
        if (pageText !== null)
        {
            const cards = parseGalleryCardsFromHtml(pageText);
            allDoujinshis = {};
            for (const card of cards) {
                let tmpName;
                if (downloadName === "{pretty}") {
                    tmpName = card.title.replace(/\[[^\]]+\]/g, "").replace(/\([^\)]+\)/g, "").replace(/\{[^\}]+\}/g, "").trim();
                } else {
                    tmpName = card.title.trim();
                }
                allDoujinshis[card.id] = tmpName;
            }
            const outcome = await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", i == pagesArr.length - 1, {}, sourceTabId, options);
            allRecords.push.apply(allRecords, outcome.records);
            allBatchKeys.push.apply(allBatchKeys, outcome.batchKeys);
            skippedTotal += outcome.skipped;
            if (!outcome.clean) {
                allClean = false;
            }
            pagesFetched++;
        } else {
            // A page that could not be fetched contributes nothing: a merged
            // job is never clean without it, so no batch titles are recorded.
            allClean = false;
        }
    }

    const clean = effectiveSeparate
        ? true
        : (allClean && pagesFetched === pagesArr.length && pagesArr.length > 0);
    if (!effectiveSeparate && clean) {
        const finalName = path + " (" + String(pagesArr[pagesArr.length - 1]) + ")";
        const filename = artifactRecordFilename({
            format: format,
            name: finalName,
            masterFolder: typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : ""
        });
        return {
            records: allBatchKeys.map((id) => ({ id: id, filename: filename })),
            clean: true,
            batchKeys: [],
            skipped: skippedTotal
        } as BatchOutcome;
    }
    return {
        records: effectiveSeparate ? allRecords : [],
        clean: clean,
        batchKeys: [],
        skipped: skippedTotal
    } as BatchOutcome;
}

function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, url: string, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    beginJob();
    jobRunning = true;
    downloadAllPagesAsync(allDoujinshis, pagesArr, path, url, sourceTabId, options || {})
        .then((outcome: BatchOutcome) => {
            // Records are already resolved (merged mode is all-or-nothing).
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
