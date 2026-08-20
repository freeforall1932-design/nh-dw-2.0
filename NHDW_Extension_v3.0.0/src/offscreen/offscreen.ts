import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import Downloader from "../background/Downloader";
import { utils } from "../utils/utils";
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
let latestProgress: { progress: number; doujinshiName: string | null; isZipping: boolean } | null = null;

function errorCallback(error: string) {
    chrome.runtime.sendMessage({ from: "offscreen", action: "downloadError", error: error });
}

function progressCallback(progress: number, doujinshiName: string | null, isZipping: boolean) {
    latestProgress = { progress: progress, doujinshiName: doujinshiName, isZipping: isZipping };
    chrome.runtime.sendMessage({
        from: "offscreen",
        action: "updateProgress",
        progress: progress,
        doujinshiName: doujinshiName,
        isZipping: isZipping
    });
}

function isDownloadFinished(): boolean {
    return currentDownloader == null || currentDownloader.isDone();
}

function downloadDoujinshi(jsonTmp: any, path: string, name: string) {
    cancelIdleTimer();
    let zip = new JSZip();
    currentDownloader = new Downloader(jsonTmp, path, errorCallback, progressCallback, name, zip, path);
    currentDownloader.startAsync().then(scheduleIdleClose).catch(scheduleIdleClose);
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

    for (let i = 0; i < length; i++) {
        let key = allKeys[i];
        const resp = await fetch(parsing.GetUrl(key), { credentials: "include", cache: "no-store" });
        if (resp.ok)
        {
            const json = await parsing.GetJsonAsync(resp);

            let title = utils.getDownloadName(downloadName, json.title.pretty === "" ?
                json.title.english.replace(/\[[^\]]+\]/g, '').replace(/\([^\)]+\)/g, '') : json.title.pretty,
                json.title.english, json.title.japanese, key, json.tags);
            if (names.includes(title)) {
                if (duplicateBehaviour === "ignore") {
                    continue;
                }
                let c = 2;
                let tmp = title;
                while (names.includes(tmp)) {
                    tmp = title + " (" + c + ")";
                    c++;
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
            currentDownloader = new Downloader(json, utils.cleanName(title, replaceSpaces), errorCallback, progressCallback, allDoujinshis[key],
            downloadSeparately ? new JSZip() : zip, // If we download separately, we make sure to not reuse the previous ZIP
            zipName);
            // We download the ZIP file in the following cases:
            // downloadSeparately is true (set in extension options)
            // OR downloadAtEnd is true (can be false if downloading many pages) AND we are at the doujin of the current list

            await currentDownloader.startAsync();
        }
        else
        {
            errorCallback("Can't download " + key + " (Code " + resp.status + ": " + resp.statusText + ").");
        }
    }
}

function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string) {
    cancelIdleTimer();
    let zip = new JSZip();
    downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, true)
        .then(scheduleIdleClose)
        .catch(function(error) { errorCallback(String(error)); scheduleIdleClose(); });
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
        const resp = await fetch(url, { credentials: "include", cache: "no-store" });
        if (resp.ok)
        {
            const text = await resp.text();
            allDoujinshis = {};
            let matchs = /<a href="\/g\/([0-9]+)\/".+<div class="caption">([^<]+)((<br>)+<input [^>]+>[^<]+<br>[^<]+<br>[^<]+)?<\/div>/g
            let match;
            let pageHtml = text.replace(/<\/a>/g, '\n');
            do {
                match = matchs.exec(pageHtml);
                if (match !== null) {
                    let tmpName;
                    if (downloadName === "{pretty}") {
                        tmpName = match[2].replace(/\[[^\]]+\]/g, "").replace(/\([^\)]+\)/g, "").replace(/\{[^\}]+\}/g, "").trim();
                    } else {
                        tmpName = match[2].trim();
                    }
                    allDoujinshis[match[1]] = tmpName;
                }
            } while (match);
            await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", i == pagesArr.length - 1);
        }
    }
}

function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, url: string) {
    cancelIdleTimer();
    downloadAllPagesAsync(allDoujinshis, pagesArr, path, url)
        .then(scheduleIdleClose)
        .catch(function(error) { errorCallback(String(error)); scheduleIdleClose(); });
}

function goBack() {
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
                ? { progress: undefined, doujinshiName: null, isZipping: false }
                : latestProgress));
    }
    return false;
});

scheduleIdleClose();
