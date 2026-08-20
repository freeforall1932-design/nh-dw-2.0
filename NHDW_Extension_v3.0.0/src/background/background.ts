import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import Downloader from "./Downloader";
import { utils } from "../utils/utils";
var JSZip = require("jszip");

chrome.tabs.onUpdated.addListener(function
    (_tabId, changeInfo, _tab) {
        if (changeInfo.url !== undefined)
            setIcon(changeInfo.url);
    }
);

chrome.tabs.onActivated.addListener(function() {
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, function (tabs) {
        setIcon(tabs[0].url!);
    });
});

function setIcon(url: string) {
    if (url.startsWith("https://nhentai.net"))
        chrome.action.setIcon({path: "Icon.png"});
    else
        chrome.action.setIcon({path: "Icon-grey.png"});
}

module background
{
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

    export function isDownloadFinished(): boolean {
        return currentDownloader == null || currentDownloader.isDone();
    }

    export function downloadDoujinshi(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string) {
        let zip = new JSZip();
        currentDownloader = new Downloader(jsonTmp, path, errorCallback, progressCallback, name, zip, path);
        currentDownloader.startAsync();
    }

    export function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, errorCallback: Function, progressCallback: Function) {
        let zip = new JSZip();
        downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, errorCallback, progressCallback, true);
    }

    async function downloadAllDoujinshisAsync(
        zip: typeof JSZip,
        allDoujinshis: Record<string, string>,
        finalName: string,
        errorCallback: Function,
        progressCallback: Function,
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
            const resp = await fetch(parsing.GetUrl(key));
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

    export function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, errorCallback: Function, progressCallback: Function, url: string) {
        downloadAllPagesAsync(allDoujinshis, pagesArr, path, errorCallback, progressCallback, url);
    }

    async function downloadAllPagesAsync(
        allDoujinshis: Record<string, string>,
        pagesArr: Array<number>,
        path: string,
        errorCallback: Function,
        progressCallback: Function,
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
            const resp = await fetch(url);
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
                await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", errorCallback, progressCallback, i == pagesArr.length - 1);
            }
        }
    }

    export function goBack() {
        if (!isDownloadFinished()) {
            currentDownloader!.isAwaitingAbort = true;
            currentDownloader!.currentProgress = 100;
        }
        currentDownloader = null;
    }

    export function updateProgress(updateCallback: Function) {
        if (!isDownloadFinished())
        {
            currentDownloader!.updateProgressLatest(updateCallback);
        }
    }
}

// NOTE: MV3 service workers run in a worker global scope without `window`.
// Do not assign background functions to `window` here: the first assignment
// would throw a ReferenceError and prevent the message listener below from
// ever registering. All communication goes through chrome.runtime.onMessage.

// ---- offscreen document plumbing -----------------------------------------
// When chrome.offscreen is available, downloads run in an offscreen document:
// it can create real object URLs (no base64 memory blow-up) and it is not
// subject to the service worker idle timeout. The service worker then only
// relays commands and lifecycle messages.
const USE_OFFSCREEN: boolean = typeof chrome !== "undefined"
    && typeof (chrome as any).offscreen !== "undefined"
    && typeof (chrome as any).offscreen.createDocument === "function";

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
    if (creatingOffscreen !== null) {
        return creatingOffscreen;
    }
    creatingOffscreen = (async () => {
        const offscreen = (chrome as any).offscreen;
        if (offscreen === undefined || typeof offscreen.createDocument !== "function") {
            throw new Error("chrome.offscreen is not available");
        }
        const hasDocument = await hasOffscreenDocument();
        if (!hasDocument) {
            await new Promise<void>((resolve, reject) => {
                let result: any;
                try {
                    result = offscreen.createDocument({
                        url: "offscreen.html",
                        reasons: ["BLOBS"],
                        justification: "Create object URLs for ZIP downloads; service workers have no URL.createObjectURL"
                    }, () => resolve());
                } catch (error) {
                    reject(error);
                    return;
                }
                if (result && typeof result.then === "function") {
                    result.then(() => resolve()).catch(reject);
                }
            });
        }
    })();
    try {
        await creatingOffscreen;
    } finally {
        creatingOffscreen = null;
    }
}

function hasOffscreenDocument(): Promise<boolean> {
    const offscreen = (chrome as any).offscreen;
    if (offscreen === undefined || typeof offscreen.hasDocument !== "function") {
        return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
        let result: any;
        try {
            result = offscreen.hasDocument((has: boolean) => resolve(!!has));
        } catch (_) {
            resolve(false);
            return;
        }
        if (result && typeof result.then === "function") {
            result.then((has: boolean) => resolve(!!has)).catch(() => resolve(false));
        }
    });
}

function closeOffscreenDocument() {
    const offscreen = (chrome as any).offscreen;
    if (offscreen === undefined || typeof offscreen.closeDocument !== "function") {
        return;
    }
    let result: any;
    try {
        result = offscreen.closeDocument();
    } catch (_) {
        return;
    }
    if (result && typeof result.catch === "function") {
        result.catch(() => {});
    }
}

function askOffscreen(message: any, callback?: (response: any) => void) {
    ensureOffscreenDocument()
        .then(() => {
            chrome.runtime.sendMessage(Object.assign({ target: "offscreen" }, message), (response) => {
                if (callback) {
                    callback(response);
                }
            });
        })
        .catch((error) => {
            if (callback) {
                callback({ result: false, error: String(error) });
            }
        });
}

function relayDownloadError(error: string) {
    chrome.runtime.sendMessage({ action: "downloadError", error: error });
}

// Messages from the offscreen document back to the service worker.
// updateProgress/downloadError broadcasts also reach the popup directly, so
// the service worker must NOT act on them (acting would ping-pong forever).
function handleOffscreenMessage(request: any): boolean {
    if (request.action === "offscreenIdle") {
        closeOffscreenDocument();
    }
    return true;
}

// Add message listeners for Firefox private mode compatibility
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) {
        return false;
    }
    if (request.from === "offscreen") {
        return handleOffscreenMessage(request);
    }
    if (USE_OFFSCREEN) {
        // Downloads run in the offscreen document; relay the commands.
        if (request.action === "isDownloadFinished") {
            hasOffscreenDocument().then((hasDocument) => {
                if (!hasDocument) {
                    // Nothing can be downloading if the document is gone.
                    sendResponse({ result: true });
                    return;
                }
                chrome.runtime.sendMessage({ target: "offscreen", action: "isDownloadFinished" }, (response) => {
                    sendResponse({ result: !!(response && response.result) });
                });
            });
        } else if (request.action === "downloadDoujinshi") {
            askOffscreen({ action: "downloadDoujinshi", json: request.json, path: request.path, name: request.name }, (response) => {
                if (response && response.result === "started") {
                    sendResponse({ result: "started" });
                } else {
                    relayDownloadError(response && response.error ? response.error : "Unable to start the offscreen download document.");
                    sendResponse({ result: "error" });
                }
            });
        } else if (request.action === "downloadAllDoujinshis") {
            askOffscreen({ action: "downloadAllDoujinshis", allDoujinshis: request.allDoujinshis, finalName: request.finalName }, (response) => {
                if (response && response.result === "started") {
                    sendResponse({ result: "started" });
                } else {
                    relayDownloadError(response && response.error ? response.error : "Unable to start the offscreen download document.");
                    sendResponse({ result: "error" });
                }
            });
        } else if (request.action === "downloadAllPages") {
            askOffscreen({ action: "downloadAllPages", allDoujinshis: request.allDoujinshis, pages: request.pages, finalName: request.finalName, url: request.url }, (response) => {
                if (response && response.result === "started") {
                    sendResponse({ result: "started" });
                } else {
                    relayDownloadError(response && response.error ? response.error : "Unable to start the offscreen download document.");
                    sendResponse({ result: "error" });
                }
            });
        } else if (request.action === "goBack") {
            askOffscreen({ action: "goBack" }, () => sendResponse({ result: "success" }));
        } else if (request.action === "updateProgress") {
            askOffscreen({ action: "getProgress" }, (response) => {
                if (response && typeof response.progress === "number") {
                    chrome.runtime.sendMessage({
                        action: "updateProgress",
                        progress: response.progress,
                        doujinshiName: response.doujinshiName,
                        isZipping: response.isZipping
                    });
                }
                sendResponse({ result: "success" });
            });
        }
        return true; // Required for async response
    }

    // Fallback path for browsers without chrome.offscreen: the downloads run
    // directly in this worker (base64 data URL delivery).
    if (request.action === "isDownloadFinished") {
        sendResponse({ result: background.isDownloadFinished() });
    } else if (request.action === "downloadDoujinshi") {
        background.downloadDoujinshi(
            request.json,
            request.path,
            (error: string) => {
                chrome.runtime.sendMessage({ action: "downloadError", error: error });
            },
            (progress: number, doujinshiName: string, isZipping: boolean) => {
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    progress: progress,
                    doujinshiName: doujinshiName,
                    isZipping: isZipping
                });
            },
            request.name
        );
        sendResponse({ result: "started" });
    } else if (request.action === "downloadAllDoujinshis") {
        background.downloadAllDoujinshis(
            request.allDoujinshis,
            request.finalName,
            (error: string) => {
                chrome.runtime.sendMessage({ action: "downloadError", error: error });
            },
            (progress: number, doujinshiName: string, isZipping: boolean) => {
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    progress: progress,
                    doujinshiName: doujinshiName,
                    isZipping: isZipping
                });
            }
        );
        sendResponse({ result: "started" });
    } else if (request.action === "downloadAllPages") {
        background.downloadAllPages(
            request.allDoujinshis,
            request.pages,
            request.finalName,
            (error: string) => {
                chrome.runtime.sendMessage({ action: "downloadError", error: error });
            },
            (progress: number, doujinshiName: string, isZipping: boolean) => {
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    progress: progress,
                    doujinshiName: doujinshiName,
                    isZipping: isZipping
                });
            },
            request.url
        );
        sendResponse({ result: "started" });
    } else if (request.action === "goBack") {
        background.goBack();
        sendResponse({ result: "success" });
    } else if (request.action === "updateProgress") {
        // This is handled differently since we need to pass a callback
        // The actual progress updates will be sent via messages
        background.updateProgress((progress: number, doujinshiName: string, isZipping: boolean) => {
            chrome.runtime.sendMessage({
                action: "updateProgress",
                progress: progress,
                doujinshiName: doujinshiName,
                isZipping: isZipping
            });
        });
        sendResponse({ result: "success" });
    }
    return true; // Required for async response
});