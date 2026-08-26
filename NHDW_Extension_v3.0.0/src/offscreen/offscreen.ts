import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { parseGalleryCardsFromHtml } from "../parsing/CardParsing";
import Downloader from "../background/Downloader";
import { utils, classifyError } from "../utils/utils";
import { extractGalleryFromHtml, looksLikeGallery, coerceGallery } from "../parsing/GalleryEmbed";
import { fetchUrlFromTab, TabUrlResult } from "../background/tabImageFetch";
import { fetchNhentaiApi } from "../utils/apiAuth";
import { setImageServers } from "../sources/cdnConfig";
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
// chrome.storage, chrome.downloads, or chrome.scripting directly — settings
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
        // queued jobs: the worker's active-job marker must stay set.
        broadcastQueueState();
        runQueuedJob(next);
        return;
    }
    chrome.runtime.sendMessage({ from: "offscreen", action: "jobFinished" });
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

// Ask the service worker to hand a URL to the download manager. The URL is
// either a blob: object URL created here (zip/pdf mode) or the original
// CDN URL (raw mode). Blob URLs are extension-origin, so the worker can
// download them even though it cannot create object URLs itself.
function saveViaServiceWorker(url: string, filename: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error: string | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error === null) {
                resolve();
            } else {
                reject(new Error(error));
            }
        };
        try {
            const result: any = chrome.runtime.sendMessage(
                { from: "offscreen", action: "saveDownload", url: url, filename: filename },
                (response: any) => {
                    if (chrome.runtime.lastError || !response) {
                        finish(String(chrome.runtime.lastError || "Unable to save the file (worker unreachable)"));
                        return;
                    }
                    if (response.result === false) {
                        finish(String(response.error || "Unable to save the file"));
                        return;
                    }
                    finish(null);
                }
            );
            if (result && typeof result.then === "function") {
                result.then((response: any) => {
                    if (!response) {
                        finish("Unable to save the file (worker unreachable)");
                    } else if (response.result === false) {
                        finish(String(response.error || "Unable to save the file"));
                    } else {
                        finish(null);
                    }
                }).catch((error: any) => finish(String(error)));
            }
        } catch (error) {
            finish(String(error));
        }
    });
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
    // Single-gallery jobs own their archive: pages at the root, file named
    // after the gallery (no Title/Title double folder).
    currentDownloader = new Downloader(jsonTmp, path, errorCallback, progressCallback, name, zip, path, signal,
        undefined, { useZip: options ? options.useZip : undefined, maxConcurrentDownloads: options ? options.maxConcurrentDownloads : undefined, archiveLayout: "flat", apiKey: options && options.apiKey ? options.apiKey : undefined, useServerArchive: options ? !!options.useServerArchive : undefined });
    currentDownloader.saveUrl = saveViaServiceWorker;
    if (typeof sourceTabId === "number") {
        currentDownloader.sourceTabId = sourceTabId;
    }
    currentDownloader.startAsync()
        .then(() => { notifyJobFinished(); scheduleIdleClose(); })
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
    // Each gallery in a separate archive owns that archive (flat entries,
    // named after the gallery); a shared batch archive keeps one folder per
    // gallery inside.
    const gallerySettings: any = {
        useZip: options.useZip,
        maxConcurrentDownloads: options.maxConcurrentDownloads,
        archiveLayout: downloadSeparately ? "flat" : "nested",
        apiKey: options.apiKey || null,
        useServerArchive: !!options.useServerArchive
    };
    let names: Array<string> = [];
    let length = Object.keys(allDoujinshis).length;
    let allKeys = Object.keys(allDoujinshis);
    // Per-gallery tally for the end-of-batch summary.
    let succeeded = 0;
    let failed = 0;
    const failedKinds: Record<string, number> = {};

    function countFailure(error: any) {
        failed++;
        const { kind } = classifyError(error);
        failedKinds[kind] = (failedKinds[kind] || 0) + 1;
    }

    for (let i = 0; i < length; i++) {
        let key = allKeys[i];
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
            } catch (error) {
                countFailure(error);
                errorCallback("Can't download " + key + " (" + String(error) + ").");
                continue;
            }

            let title = utils.getDownloadName(downloadName, json.title.pretty === "" ?
                json.title.english.replace(/\[[^\]]+\]/g, '').replace(/\([^\)]+\)/g, '') : json.title.pretty,
                json.title.english, json.title.japanese, key, json.tags);
            if (names.includes(title)) {
                if (duplicateBehaviour === "ignore") {
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
            if (downloadSeparately) {
                zipName = title;
            } else if (downloadAtEnd && i == length - 1) {
                zipName = finalName;
            }
            currentDownloader = new Downloader(json, utils.cleanName(title, replaceSpaces, key), errorCallback, progressCallback, allDoujinshis[key],
            downloadSeparately ? new JSZip() : zip,
            zipName, jobAbortController ? jobAbortController.signal : null, undefined,
            gallerySettings);
            currentDownloader.saveUrl = saveViaServiceWorker;
            if (typeof sourceTabId === "number") {
                currentDownloader.sourceTabId = sourceTabId;
            }

            try {
                await currentDownloader.startAsync();
                succeeded++;
            } catch (error) {
                countFailure(error);
            }
        }
        else
        {
            const isCf = resp.status === 503 || resp.status === 403;
            const ct = (resp.headers.get("content-type") || "").toLowerCase();
            const isHtml = ct.includes("html");
            if (isCf || isHtml) {
                errorCallback("Can't download " + key + " — Cloudflare blocked the request (HTTP " + resp.status + "). Open the gallery in a tab, complete any challenge, then try again.");
            } else {
                errorCallback("Can't download " + key + " (Code " + resp.status + ": " + resp.statusText + ").");
            }
            countFailure("Can't download " + key + " (Code " + resp.status + ": " + resp.statusText + ").");
        }
    }

    if (!jobWasAborted()) {
        chrome.runtime.sendMessage({
            from: "offscreen",
            action: "batchSummary",
            succeeded: succeeded,
            failed: failed,
            total: length,
            failedKinds: failedKinds
        });
    }
}

function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, galleryMetadata: Record<string, any> = {}, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    beginJob();
    jobRunning = true;
    let zip = new JSZip();
    downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, true, galleryMetadata, sourceTabId, options || {})
        .then(() => { notifyJobFinished(); scheduleIdleClose(); })
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
) {
    let downloadName: string = options.downloadName || "{pretty}";

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
            await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", i == pagesArr.length - 1, {}, sourceTabId, options);
        }
    }
}

function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, url: string, sourceTabId?: number | null, options?: any) {
    cancelIdleTimer();
    applyParserOptions(options);
    applyCdnServers(options);
    beginJob();
    jobRunning = true;
    downloadAllPagesAsync(allDoujinshis, pagesArr, path, url, sourceTabId, options || {})
        .then(() => { notifyJobFinished(); scheduleIdleClose(); })
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
