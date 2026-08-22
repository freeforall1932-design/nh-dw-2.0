import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { parseGalleryCardsFromHtml } from "../parsing/CardParsing";
import Downloader from "./Downloader";
import { utils, classifyError } from "../utils/utils";
import { getSourceForUrl } from "../sources";
import { clearnetSource } from "../sources/GallerySource";
import { extractGalleryFromHtml, looksLikeGallery, coerceGallery } from "../parsing/GalleryEmbed";
import { executeInTab } from "../preview/activeTabGallery";
import { fetchImageInPage, fetchUrlInPage, fetchUrlFromTab } from "./tabImageFetch";
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
        if (tabs && tabs[0])
            setIcon(tabs[0].url);
    });
});

// MV3 service workers live under js/, so a relative path like "Icon.png" is
// fetched as js/Icon.png and chrome.action.setIcon rejects with
// "Failed to set icon 'Icon.png': Failed to fetch". Root-relative paths
// resolve against the extension origin instead.
const ICON_COLOR = "/Icon.png";
const ICON_GREY = "/Icon-grey.png";

function setIcon(url: string | undefined) {
    const iconPath = url && getSourceForUrl(url) !== null ? ICON_COLOR : ICON_GREY;
    applyActionIcon(iconPath);
}

const iconImageDataCache: Record<string, ImageData> = {};

async function loadIconImageData(iconPath: string): Promise<ImageData | null> {
    if (iconImageDataCache[iconPath]) {
        return iconImageDataCache[iconPath];
    }
    const createImageBitmapFn = (globalThis as any).createImageBitmap;
    const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas;
    if (typeof fetch !== "function" || typeof createImageBitmapFn !== "function" || typeof OffscreenCanvasCtor !== "function") {
        return null;
    }
    try {
        const url = chrome.runtime.getURL(iconPath.replace(/^\//, ""));
        const resp = await fetch(url);
        if (!resp.ok) {
            return null;
        }
        const bitmap = await createImageBitmapFn(await resp.blob());
        const canvas = new OffscreenCanvasCtor(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return null;
        }
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        iconImageDataCache[iconPath] = imageData;
        return imageData;
    } catch (_) {
        return null;
    }
}

function applyActionIcon(iconPath: string) {
    const swallow = (result: any) => {
        if (result && typeof result.catch === "function") {
            result.catch(() => { /* toolbar icon updates are best-effort */ });
        }
    };
    try {
        const result: any = chrome.action.setIcon({ path: iconPath });
        if (result && typeof result.catch === "function") {
            result.catch(() => {
                loadIconImageData(iconPath).then((imageData) => {
                    if (!imageData) {
                        return;
                    }
                    try {
                        swallow(chrome.action.setIcon({ imageData: imageData } as any));
                    } catch (_) { /* ignore */ }
                }).catch(() => {});
            });
        }
    } catch (_) { /* chrome.action may be missing in tests */ }
}

chrome.tabs.query({
    active: true,
    currentWindow: true
}, function (tabs) {
    if (tabs && tabs[0])
        setIcon(tabs[0].url);
});

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

async function getGalleryViaTab(tabId: number, galleryId: string, parsing: AParsing): Promise<any | null> {
    const urlsToTry: string[] = [];
    // API URL (parsing dependent)
    try {
        urlsToTry.push(parsing.GetUrl(galleryId));
    } catch (_) {}
    // Clearnet direct API
    urlsToTry.push(clearnetSource.getApiUrl(galleryId));
    // Gallery pages (main + /1/)
    urlsToTry.push(clearnetSource.getGalleryUrl(galleryId));
    urlsToTry.push("https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/1/");

    // Deduplicate
    const seen = new Set<string>();
    for (const url of urlsToTry) {
        if (seen.has(url)) continue;
        seen.add(url);
        try {
            const via = await fetchUrlFromTab(tabId, url);
            if (via && via.ok && via.text) {
                const parsed = tryParseGalleryText(via.text);
                if (parsed) return parsed;
                // Also try JSON directly if content-type is json
                try {
                    const j = coerceGallery(JSON.parse(via.text));
                    if (j) return j;
                } catch (_) {}
            }
        } catch (_) {
            // continue to next URL
        }
    }
    return null;
}

module background
{
    let currentDownloader: Downloader | null = null;
    let parsing: AParsing;
    // One AbortController per download job, shared by metadata and image
    // fetches so `goBack` aborts in-flight requests instead of only flagging
    // the job as "awaiting abort".
    let jobAbortController: AbortController | null = null;

    function beginJob(): AbortSignal {
        jobAbortController = new AbortController();
        setJobMarker(true);
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

    // ---- active-job marker (chrome.storage.session) ------------------------
    // MV3 service workers can be suspended/restarted at any time. A small
    // marker in session-scoped storage lets a restarted worker (or the popup)
    // detect that a previous download was interrupted instead of silently
    // forgetting it. Session storage survives worker restarts (but not browser
    // restarts), which is exactly the lifetime we need. The worker owns this
    // marker: offscreen documents have no chrome.storage, so the worker sets
    // it when it relays a download command and clears it on goBack, when the
    // offscreen document reports idle (job over), and on fallback completion.

    export function setJobMarker(active: boolean) {
        try {
            (chrome.storage as any).session.set({ downloadJob: { active: active, startedAt: Date.now() } });
        } catch (_) { /* storage.session unavailable (older Chrome) — best effort */ }
    }

    export function clearJobMarker() {
        try {
            (chrome.storage as any).session.remove("downloadJob");
        } catch (_) { /* best effort */ }
    }

    export function jobInterrupted(): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                (chrome.storage as any).session.get("downloadJob", (elems: any) => {
                    resolve(!!(elems && elems.downloadJob && elems.downloadJob.active));
                });
            } catch (_) {
                resolve(false);
            }
        });
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

    export function isDownloadFinished(): boolean {
        return currentDownloader == null || currentDownloader.isDone();
    }

    export function downloadDoujinshi(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string, sourceTabId?: number | null) {
        const signal = beginJob();
        let zip = new JSZip();
        currentDownloader = new Downloader(jsonTmp, path, errorCallback, progressCallback, name, zip, path, signal);
        if (typeof sourceTabId === "number") {
            currentDownloader.sourceTabId = sourceTabId;
        }
        // Clear the job marker when the download finishes (success or error) and
        // keep re-throwing so a failure still surfaces as a worker rejection (the
        // popup has already been told via errorCallback).
        currentDownloader.startAsync()
            .then(() => clearJobMarker())
            .catch(function(error) { clearJobMarker(); throw error; });
    }

    export function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, errorCallback: Function, progressCallback: Function, galleryMetadata: Record<string, any> = {}, sourceTabId?: number | null) {
        beginJob();
        let zip = new JSZip();
        downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, errorCallback, progressCallback, true, galleryMetadata, sourceTabId)
            .then(() => clearJobMarker())
            .catch(function(error) {
                clearJobMarker();
                if (!jobWasAborted()) {
                    errorCallback(String(error));
                }
            });
    }

    async function downloadAllDoujinshisAsync(
        zip: typeof JSZip,
        allDoujinshis: Record<string, string>,
        finalName: string,
        errorCallback: Function,
        progressCallback: Function,
        downloadAtEnd: boolean,
        galleryMetadata: Record<string, any> = {},
        sourceTabId?: number | null
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
            // Tell the popup which gallery the batch is working on.
            chrome.runtime.sendMessage({
                action: "batchProgress",
                current: i + 1,
                total: length,
                galleryName: allDoujinshis[key],
                stage: "Downloading"
            });

            // 1. Already-resolved via selectedGalleryResolver
            // 2. Try via the user's open tab (reuses Cloudflare clearance, tries API + gallery pages)
            // 3. Fall back to extension-origin fetch (likely 403)
            let jsonFromTab: any | null = null;
            if (!galleryMetadata[key] && typeof sourceTabId === "number") {
                jsonFromTab = await getGalleryViaTab(sourceTabId, key, parsing);
            }
            let json: any | null = galleryMetadata[key] || jsonFromTab || null;
            let resp: any = null;
            if (json) {
                resp = { ok: true, status: 200, statusText: "resolved via tab" };
            } else {
                try {
                    resp = await fetch(parsing.GetUrl(key), { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined });
                } catch (e) {
                    resp = { ok: false, status: 0, statusText: String(e), headers: { get: () => null } };
                }
            }

            if (resp.ok)
            {
                try {
                    if (!json) {
                        json = await parsing.GetJsonAsync(resp);
                    }
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
                if (typeof sourceTabId === "number") {
                    currentDownloader.sourceTabId = sourceTabId;
                }
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
                action: "batchSummary",
                succeeded: succeeded,
                failed: failed,
                total: length,
                failedKinds: failedKinds
            });
        }
    }

    export function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, errorCallback: Function, progressCallback: Function, url: string, sourceTabId?: number | null) {
        beginJob();
        downloadAllPagesAsync(allDoujinshis, pagesArr, path, errorCallback, progressCallback, url, sourceTabId)
            .then(() => clearJobMarker())
            .catch(function(error) {
                clearJobMarker();
                if (!jobWasAborted()) {
                    errorCallback(String(error));
                }
            });
    }

    async function downloadAllPagesAsync(
        allDoujinshis: Record<string, string>,
        pagesArr: Array<number>,
        path: string,
        errorCallback: Function,
        progressCallback: Function,
        url: string,
        sourceTabId?: number | null
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

            // Try to reuse the user's tab session for listing pages as well.
            let pageText: string | null = null;
            if (typeof sourceTabId === "number") {
                try {
                    const viaTab = await fetchUrlFromTab(sourceTabId, url);
                    if (viaTab && viaTab.ok && viaTab.text) {
                        pageText = viaTab.text;
                    }
                } catch (_) {}
            }
            if (pageText === null) {
                try {
                    const resp = await fetch(url, { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined });
                    if (resp.ok) {
                        pageText = await resp.text();
                    }
                } catch (_) {}
            }

            if (pageText !== null)
            {
                // Anchor-scoped card parsing (see CardParsing.ts): each gallery ID
                // is matched against its own caption so titles with quotes,
                // entities, or extra markup cannot be mispaired with ids.
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
                await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", errorCallback, progressCallback, i == pagesArr.length - 1, {}, sourceTabId);
            }
        }
    }

    export function goBack() {
        // Abort any in-flight fetch, then let the download loop notice and unwind.
        abortJob();
        clearJobMarker();
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

function sendToOffscreen(message: any, callback: (response: any) => void) {
    chrome.runtime.sendMessage(Object.assign({ target: "offscreen" }, message), callback);
}

function askOffscreen(message: any, callback?: (response: any) => void) {
    ensureOffscreenDocument()
        .then(() => {
            sendToOffscreen(Object.assign({}, message), (response) => {
                // "Receiving end does not exist": the document exists but its
                // listener never registered (the bundle crashed before
                // addListener). Recreate the document once and retry instead
                // of failing the whole job.
                const lastError = chrome.runtime.lastError;
                if (lastError && /Receiving end does not exist/.test(String(lastError.message))) {
                    closeOffscreenDocument();
                    setTimeout(() => {
                        ensureOffscreenDocument()
                            .then(() => sendToOffscreen(Object.assign({}, message), (response2) => {
                                if (callback) callback(response2);
                            }))
                            .catch((error) => {
                                if (callback) callback({ result: false, error: String(error) });
                            });
                    }, 250);
                    return;
                }
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

// Settings the offscreen document needs but cannot read itself (no
// chrome.storage there). The worker reads chrome.storage.sync and relays them
// in every download command.
const DOWNLOAD_OPTION_DEFAULTS = {
    useZip: "zip",
    downloadName: "{pretty}",
    duplicateBehaviour: "rename",
    replaceSpaces: true,
    downloadSeparately: false,
    maxConcurrentDownloads: "3",
    htmlParsing: false
};

function readDownloadOptions(callback: (options: any) => void) {
    try {
        chrome.storage.sync.get(DOWNLOAD_OPTION_DEFAULTS, (elems: any) => {
            callback(elems);
        });
    } catch (_) {
        callback(Object.assign({}, DOWNLOAD_OPTION_DEFAULTS));
    }
}

// Messages from the offscreen document back to the service worker.
// Returns true ONLY when sendResponse will be called asynchronously —
// keeping the channel open for fire-and-forget broadcasts made Chrome log
// "A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received" for every progress
// tick. Broadcasts (updateProgress/downloadError/batchProgress/batchSummary)
// also reach the popup directly, so the worker must NOT relay them back.
function handleOffscreenMessage(request: any, sendResponse: (response: any) => void): boolean {
    if (request.action === "saveDownload") {
        // The offscreen document assembles blobs and exposes them through
        // object URLs, but it cannot call chrome.downloads itself (only
        // chrome.runtime is available there). The worker performs the actual
        // download; blob: URLs are extension-origin so this works. Raw mode
        // relays the original CDN URL instead.
        try {
            chrome.downloads.download({ url: request.url, filename: request.filename }, (downloadId: number) => {
                if (downloadId === undefined) {
                    sendResponse({ result: false, error: String(chrome.runtime.lastError || "Unable to start download") });
                } else {
                    sendResponse({ result: downloadId });
                }
            });
        } catch (error) {
            sendResponse({ result: false, error: String(error) });
        }
        return true;
    }
    if (request.action === "fetchInTab") {
        // The offscreen document cannot call chrome.scripting; the worker
        // injects the image fetch into the gallery tab (see tabImageFetch.ts).
        executeInTab(request.tabId, fetchImageInPage, [request.url], request.world === "MAIN" ? "MAIN" : "ISOLATED")
            .then((result: any) => sendResponse(result));
        return true;
    }
    if (request.action === "fetchUrlInTab") {
        // Same idea for page text (gallery API / listing pages), so the batch
        // can reuse the user tab's Cloudflare clearance for unresolved ids.
        executeInTab(request.tabId, fetchUrlInPage, [request.url], "MAIN")
            .then((result: any) => sendResponse(result));
        return true;
    }
    if (request.action === "jobFinished") {
        // The offscreen document finished a job (success or error). Clear the
        // active-job marker immediately instead of waiting for its 60s idle
        // close, so a later isDownloadFinished cannot misreport a completed
        // download as "interrupted".
        background.clearJobMarker();
        return false;
    }
    if (request.action === "offscreenIdle") {
        // The job is over (or the document went idle after one): clear the
        // marker so a future "interrupted download" notice is accurate, then
        // close the document so it does not linger.
        background.clearJobMarker();
        closeOffscreenDocument();
        return false;
    }
    return false;
}

// Add message listeners for Firefox private mode compatibility.
// A listener may return true (keep the message channel open for an async
// response) ONLY on branches that will actually call sendResponse; every
// other message must return false or Chrome logs "A listener indicated an
// asynchronous response by returning true, but the message channel closed
// before a response was received" once the sender goes away.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request) {
        return false;
    }
    if (request.action === "clearJobMarker") {
        // Popup dismisses the "previous download was interrupted" notice.
        background.clearJobMarker();
        sendResponse({ result: "success" });
        return false;
    }
    if (request.from === "offscreen") {
        return handleOffscreenMessage(request, sendResponse);
    }
    if (USE_OFFSCREEN) {
        // Downloads run in the offscreen document; relay the commands.
        if (request.action === "isDownloadFinished") {
            hasOffscreenDocument().then((hasDocument) => {
                if (!hasDocument) {
                    // Nothing can be downloading if the document is gone.
                    // Report the interruption when a job marker survived a
                    // worker/document restart.
                    background.jobInterrupted().then((interrupted) => {
                        sendResponse({ result: true, interrupted: interrupted });
                    });
                    return;
                }
                chrome.runtime.sendMessage({ target: "offscreen", action: "isDownloadFinished" }, (response) => {
                    // The document may be mid-close: treat "no receiving end"
                    // as "nothing is downloading" instead of assuming busy.
                    const noReceiver = !!(chrome.runtime.lastError && /Receiving end does not exist/.test(String(chrome.runtime.lastError.message)));
                    const result = !!(response && response.result) && !noReceiver;
                    if (!result) {
                        // A download is actively running; not interrupted.
                        sendResponse({ result: false });
                        return;
                    }
                    // The offscreen document is alive and reports the job
                    // finished, so it completed normally. Clear any lingering
                    // marker (the document only cleared it on its 60s idle
                    // close) and never flag a finished job as interrupted:
                    // that stale-marker false positive made the popup claim
                    // "Download interrupted" right after a success.
                    background.clearJobMarker();
                    sendResponse({ result: true, interrupted: false });
                });
            });
            return true;
        }
        // The worker owns the job marker for offscreen jobs (the document has
        // no chrome.storage): set it before the relay, and the offscreenIdle
        // / goBack handlers clear it when the job is over.
        const startRelayedJob = (relayedMessage: any) => {
            readDownloadOptions((options) => {
                background.setJobMarker(true);
                // options: the offscreen document cannot read chrome.storage,
                // so the worker relays the download settings with the command.
                askOffscreen(Object.assign({}, relayedMessage, { options: options }), (response) => {
                    if (response && response.result === "started") {
                        sendResponse({ result: "started" });
                    } else {
                        background.clearJobMarker();
                        relayDownloadError(response && response.error ? response.error : "Unable to start the offscreen download document.");
                        sendResponse({ result: "error" });
                    }
                });
            });
            return true;
        };
        if (request.action === "downloadDoujinshi") {
            return startRelayedJob({ action: "downloadDoujinshi", json: request.json, path: request.path, name: request.name, tabId: request.tabId });
        } else if (request.action === "downloadAllDoujinshis") {
            return startRelayedJob({ action: "downloadAllDoujinshis", allDoujinshis: request.allDoujinshis, galleryMetadata: request.galleryMetadata, finalName: request.finalName, tabId: request.tabId });
        } else if (request.action === "downloadAllPages") {
            return startRelayedJob({ action: "downloadAllPages", allDoujinshis: request.allDoujinshis, pages: request.pages, finalName: request.finalName, url: request.url, tabId: request.tabId });
        } else if (request.action === "goBack") {
            background.clearJobMarker();
            askOffscreen({ action: "goBack" }, () => sendResponse({ result: "success" }));
            return true;
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
            return true;
        }
        // Other actions (e.g. getGalleries from the content script) are
        // handled by the popup itself; do not keep the channel open.
        return false;
    }

    // Fallback path for browsers without chrome.offscreen: the downloads run
    // directly in this worker (base64 data URL delivery).
    if (request.action === "isDownloadFinished") {
        const done = background.isDownloadFinished();
        background.jobInterrupted().then((interrupted) => {
            sendResponse({ result: done, interrupted: done && interrupted });
        });
        return true; // Answered asynchronously.
    } else if (request.action === "downloadDoujinshi") {
        background.downloadDoujinshi(
            request.json,
            request.path,
            (error: string) => {
                chrome.runtime.sendMessage({ action: "downloadError", error: error });
            },
            (progress: number, doujinshiName: string, isZipping: boolean, retry: string | null) => {
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    progress: progress,
                    doujinshiName: doujinshiName,
                    isZipping: isZipping,
                retry: retry
                });
            },
            request.name,
            request.tabId
        );
        sendResponse({ result: "started" });
    } else if (request.action === "downloadAllDoujinshis") {
        background.downloadAllDoujinshis(
            request.allDoujinshis,
            request.finalName,
            (error: string) => {
                chrome.runtime.sendMessage({ action: "downloadError", error: error });
            },
            (progress: number, doujinshiName: string, isZipping: boolean, retry: string | null) => {
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    progress: progress,
                    doujinshiName: doujinshiName,
                    isZipping: isZipping,
                retry: retry
                });
            },
            request.galleryMetadata || {},
            request.tabId
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
            (progress: number, doujinshiName: string, isZipping: boolean, retry: string | null) => {
                chrome.runtime.sendMessage({
                    action: "updateProgress",
                    progress: progress,
                    doujinshiName: doujinshiName,
                    isZipping: isZipping,
                retry: retry
                });
            },
            request.url,
            request.tabId
        );
        sendResponse({ result: "started" });
    } else if (request.action === "goBack") {
        background.goBack();
        sendResponse({ result: "success" });
    } else if (request.action === "updateProgress") {
        // This is handled differently since we need to pass a callback
        // The actual progress updates will be sent via messages
        background.updateProgress((progress: number, doujinshiName: string, isZipping: boolean, retry: string | null) => {
            chrome.runtime.sendMessage({
                action: "updateProgress",
                progress: progress,
                doujinshiName: doujinshiName,
                isZipping: isZipping,
            retry: retry
            });
        });
        sendResponse({ result: "success" });
    }
    // Other actions (e.g. getGalleries from the content script) are handled
    // by the popup itself; do not keep the channel open.
    return false;
});
