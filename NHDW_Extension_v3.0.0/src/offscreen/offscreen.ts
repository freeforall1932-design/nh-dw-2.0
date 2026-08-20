import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { parseGalleryCardsFromHtml } from "../parsing/CardParsing";
import Downloader from "../background/Downloader";
import { utils, classifyError } from "../utils/utils";
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

let currentDownloader: Downloader | null = null;
let parsing: AParsing;

// One AbortController per download job. All metadata and image fetches share
// this signal so that `goBack` can abort in-flight requests, not merely flag
// the job as "awaiting abort" while the network calls run to completion.
let jobAbortController: AbortController | null = null;

function beginJob(): AbortSignal {
    jobAbortController = new AbortController();
    writeJobMarker(true);
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

// ---- active-job marker (chrome.storage.session) --------------------------
// Same key the service worker uses (and clears via clearJobMarker), so a
// restarted service worker or a reopened popup can detect a download that was
// interrupted when this document died unexpectedly. Session storage survives
// worker restarts, not browser restarts — exactly the lifetime we need.
function writeJobMarker(active: boolean) {
    try {
        (chrome.storage as any).session.set({ downloadJob: { active: active, startedAt: Date.now() } });
    } catch (_) { /* storage.session unavailable — best effort */ }
}

function clearJobMarker() {
    try {
        (chrome.storage as any).session.remove("downloadJob");
    } catch (_) { /* best effort */ }
}

chrome.storage.sync.get({
    htmlParsing: false,
    maxConcurrentDownloads: "3"
}, function(elems) {
    if (elems.htmlParsing) {
        parsing = new HtmlParsing();
    } else {
        parsing = new ApiParsing();
    }
});

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

function progressCallback(progress: number, doujinshiName: string | null, isZipping: boolean, retry: string | null = null) {
    latestProgress = { progress: progress, doujinshiName: doujinshiName, isZipping: isZipping, retry: retry };
    chrome.runtime.sendMessage({
        from: "offscreen",
        action: "updateProgress",
        progress: progress,
        doujinshiName: doujinshiName,
        isZipping: isZipping,
        retry: retry
    });
}

function isDownloadFinished(): boolean {
    return currentDownloader == null || currentDownloader.isDone();
}

function downloadDoujinshi(jsonTmp: any, path: string, name: string) {
    cancelIdleTimer();
    const signal = beginJob();
    let zip = new JSZip();
    currentDownloader = new Downloader(jsonTmp, path, errorCallback, progressCallback, name, zip, path, signal);
    currentDownloader.startAsync()
        .then(() => { clearJobMarker(); scheduleIdleClose(); })
        .catch(() => { clearJobMarker(); scheduleIdleClose(); });
}

async function downloadAllDoujinshisAsync(
    zip: typeof JSZip,
    allDoujinshis: Record<string, string>,
    finalName: string,
    downloadAtEnd: boolean
) {
    let downloadName: string = "";
    let duplicateBehaviour: string = "";
    let replaceSpaces: boolean = false;
    let downloadSeparately: boolean = false;
    await new Promise((resolve, _reject) => {
        resolve(
            chrome.storage.sync.get({
                downloadName: "{pretty}",
                duplicateBehaviour: "rename",
                replaceSpaces: true,
                downloadSeparately: false,
                maxConcurrentDownloads: "3"
            }, function(elems) {
                downloadName = elems.downloadName;
                duplicateBehaviour = elems.duplicateBehaviour;
                replaceSpaces = elems.replaceSpaces;
                downloadSeparately = elems.downloadSeparately;
            })
        );
    });
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
            stage: "Downloading"
        });
        const resp = await fetch(parsing.GetUrl(key), { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined });
        if (resp.ok)
        {
            let json: any;
            try {
                json = await parsing.GetJsonAsync(resp);
            } catch (error) {
                // Metadata parse failure (e.g. a Cloudflare HTML page).
                countFailure(error);
                errorCallback("Can't download " + key + " (" + String(error) + ").");
                continue; // Keep going with the remaining galleries.
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
                    // Use the gallery ID (key) as the disambiguator so the
                    // resulting name is deterministic and traceable back to
                    // the source gallery instead of depending on iteration order.
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
            downloadSeparately ? new JSZip() : zip, // If we download separately, we make sure to not reuse the previous ZIP
            zipName, jobAbortController ? jobAbortController.signal : null);
            // We download the ZIP file in the following cases:
            // downloadSeparately is true (set in extension options)
            // OR downloadAtEnd is true (can be false if downloading many pages) AND we are at the doujin of the current list

            try {
                await currentDownloader.startAsync();
                succeeded++;
            } catch (error) {
                // The Downloader already surfaced its own failure through
                // errorCallback (and intentionally stays silent on abort).
                // Keep going with the remaining galleries; the summary at
                // the end reports the total count of successes/failures.
                countFailure(error);
            }
        }
        else
        {
            // Distinguish Cloudflare blocks from other HTTP errors so the
            // user knows to open the gallery and complete any challenge.
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

    // End-of-batch summary (not sent when the job was cancelled).
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

function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string) {
    cancelIdleTimer();
    beginJob();
    let zip = new JSZip();
    downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, true)
        .then(() => { clearJobMarker(); scheduleIdleClose(); })
        .catch(function(error) {
            clearJobMarker();
            if (!jobWasAborted()) {
                errorCallback(String(error));
            }
            scheduleIdleClose();
        });
}

async function downloadAllPagesAsync(
    allDoujinshis: Record<string, string>,
    pagesArr: Array<number>,
    path: string,
    url: string
) {
    let downloadName: string = "";
    await new Promise((resolve, _reject) => {
        resolve(
            chrome.storage.sync.get({
                downloadName: "{pretty}",
                maxConcurrentDownloads: "3"
            }, function(elems) {
                downloadName = elems.downloadName;
            })
        );
    });

    let zip = new JSZip();
    for (let i = 0; i < pagesArr.length; i++) {
        // Take the page at the current index. Do not mutate pagesArr here:
        // splicing while iterating made the "last page" check below wrong and
        // the final ZIP was never downloaded.
        let curr = pagesArr[i];
        let m = /page=([0-9]+)/.exec(url)
        if (m !== null) {
            url = url.replace(m[0], "page=" + curr);
        } else if (url.includes("?")) {
            url += "&page=" + curr
        } else {
            url += "?page=" + curr
        }
        const resp = await fetch(url, { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined });
        if (resp.ok)
        {
            const text = await resp.text();
            // Anchor-scoped card parsing (see CardParsing.ts): each gallery ID
            // is matched against its own caption so titles with quotes,
            // entities, or extra markup cannot be mispaired with ids.
            const cards = parseGalleryCardsFromHtml(text);
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
            await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", i == pagesArr.length - 1);
        }
    }
}

function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, url: string) {
    cancelIdleTimer();
    beginJob();
    downloadAllPagesAsync(allDoujinshis, pagesArr, path, url)
        .then(() => { clearJobMarker(); scheduleIdleClose(); })
        .catch(function(error) {
            clearJobMarker();
            if (!jobWasAborted()) {
                errorCallback(String(error));
            }
            scheduleIdleClose();
        });
}

function goBack() {
    // Abort any in-flight fetch, then let the download loop notice and unwind.
    abortJob();
    clearJobMarker();
    if (!isDownloadFinished()) {
        currentDownloader!.isAwaitingAbort = true;
        currentDownloader!.currentProgress = 100;
    }
    currentDownloader = null;
}

// Commands relayed by the service worker.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || request.target !== "offscreen") {
        return false;
    }
    if (request.action === "isDownloadFinished") {
        sendResponse({ result: isDownloadFinished() });
    } else if (request.action === "downloadDoujinshi") {
        downloadDoujinshi(request.json, request.path, request.name);
        sendResponse({ result: "started" });
    } else if (request.action === "downloadAllDoujinshis") {
        downloadAllDoujinshis(request.allDoujinshis, request.finalName);
        sendResponse({ result: "started" });
    } else if (request.action === "downloadAllPages") {
        downloadAllPages(request.allDoujinshis, request.pages, request.finalName, request.url);
        sendResponse({ result: "started" });
    } else if (request.action === "goBack") {
        goBack();
        sendResponse({ result: "success" });
    } else if (request.action === "getProgress") {
        // The popup asked the service worker for the latest progress; the
        // service worker turns this response into an updateProgress message.
        sendResponse(Object.assign({ result: "success" },
            latestProgress === null
                ? { progress: undefined, doujinshiName: null, isZipping: false, retry: null }
                : latestProgress));
    }
    return false;
});

scheduleIdleClose();
