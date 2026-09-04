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
import { fetchNhentaiApi } from "../utils/apiAuth";
import { setImageServers } from "../sources/cdnConfig";
import * as cdnConfigService from "./cdnConfigService";
import { installDownloadFilenameGuard, recordDownloadRequest, bindDownloadId, discardDownloadRequest } from "./downloadNaming";
import { normalizeFormat, DownloadFormat } from "../utils/downloadFormats";
// The worker OWNS the persistent download history (chrome.storage.local): it
// reads it for the pipeline guard, writes it when jobs report success and
// clears it on user request. The offscreen document never touches storage.
import {
    BatchOutcome,
    artifactRecordFilename,
    historyIds,
    historyRecords,
    readHistory,
    recordHistory
} from "../utils/downloadHistory";
var JSZip = require("jszip");

// Folder-naming guard: re-asserts the filename/folder structure we request
// for our own downloads when another extension's onDeterminingFilename
// listener would suppress it (Chromium bug 579563 — the reason raw pages can
// land as "1.jpg" in Downloads instead of "NHDW/<Title>/001.jpg").
//
// This installs the bookkeeping half only. The global onDeterminingFilename
// listener is attached on demand, while our own downloads are in flight, and
// detached the moment they drain — see the lifetime notes in
// downloadNaming.ts. An idle worker must NOT be a participant in the
// browser-wide filename chain, or Chrome can blame this extension for
// unrelated downloads started by other extensions.
installDownloadFilenameGuard();

// ---- toolbar UI mode: side panel or popup -------------------------------
// The user's other extension uses a side panel and the hovering popup cannot
// be repositioned, so the panel is now the shipping default with the popup
// kept as a fallback. Both render the SAME document (index.html), so there is
// no duplicated markup: only what the toolbar click opens changes.
//
// chrome.sidePanel is Chrome 114+. Everything below is feature-detected so
// older Chromium builds (and Firefox, where the API does not exist) silently
// keep the popup.
const UI_MODE_DEFAULT = "sidepanel";

function applyUiMode(mode: string) {
    const useSidePanel = mode === "sidepanel";
    const sidePanelApi: any = (chrome as any).sidePanel;
    if (!sidePanelApi || typeof sidePanelApi.setPanelBehavior !== "function") {
        // No side panel support: make sure the popup is the toolbar action.
        try {
            chrome.action.setPopup({ popup: "index.html" });
        } catch (_) { /* chrome.action may be missing in tests */ }
        return;
    }
    try {
        const behavior = sidePanelApi.setPanelBehavior({ openPanelOnActionClick: useSidePanel });
        if (behavior && typeof behavior.catch === "function") {
            behavior.catch(() => { /* unsupported build: popup stays */ });
        }
    } catch (_) { /* unsupported build: popup stays */ }
    try {
        // An action popup always wins over openPanelOnActionClick, so it has
        // to be cleared for the panel to open and restored for popup mode.
        chrome.action.setPopup({ popup: useSidePanel ? "" : "index.html" });
    } catch (_) { /* chrome.action may be missing in tests */ }
}

try {
    chrome.storage.sync.get({ uiMode: UI_MODE_DEFAULT }, (elems: any) => {
        applyUiMode(elems && elems.uiMode ? String(elems.uiMode) : UI_MODE_DEFAULT);
    });
    chrome.storage.onChanged.addListener((changes: any, area: string) => {
        if (area === "sync" && changes && changes.uiMode) {
            applyUiMode(String(changes.uiMode.newValue || UI_MODE_DEFAULT));
        }
    });
} catch (_) { /* storage unavailable in some test harnesses */ }


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
        } catch (_) { /* storage.session unavailable (older Chrome) - best effort */ }
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

    export function downloadDoujinshi(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string, sourceTabId?: number | null, options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string }) {
        const signal = beginJob();
        // Single-gallery jobs always own their archive: pages go to the root
        // and the file is named after the gallery (no Title/Title double name).
        const settings: any = { archiveLayout: "flat" };
        if (options && options.useZip) {
            settings.useZip = options.useZip;
        }
        // Optional master folder (the wrap is a user choice, never forced).
        if (options && typeof options.archiveMasterFolder === "string") {
            settings.archiveMasterFolder = options.archiveMasterFolder;
        }
        // Attach the API key fields up front (worker context has storage):
        // the Downloader itself must never touch chrome.storage so the same
        // class stays safe inside the offscreen document.
        readLocalApiSettings().then((localApi) => {
            settings.apiKey = localApi.apiKey || null;
            settings.useServerArchive = localApi.useServerArchive;
            const startWithSettings = () => {
                let zip = new JSZip();
                currentDownloader = new Downloader(jsonTmp, path, errorCallback, progressCallback, name, zip, path, signal, undefined, settings);
                if (typeof sourceTabId === "number") {
                    currentDownloader.sourceTabId = sourceTabId;
                }
                // Clear the job marker when the download finishes (success or error) and
                // keep re-throwing so a failure still surfaces as a worker rejection (the
                // popup has already been told via errorCallback).
                const downloader = currentDownloader;
                downloader.startAsync()
                    .then(() => {
                        clearJobMarker();
                        // Record history ONLY after a fully successful download.
                        // The Downloader resolved the effective format from its
                        // settings by now, so the record always matches the file.
                        const format = normalizeFormat(downloader.useZip || settings.useZip || "zip", "zip");
                        const masterFolder = format === "raw"
                            ? String(settings.rawMasterFolder || "NHDW")
                            : String(settings.archiveMasterFolder || "");
                        recordHistory([{
                            id: String(jsonTmp.id),
                            filename: artifactRecordFilename({
                                format: format,
                                name: String(downloader.downloadName || path),
                                masterFolder: masterFolder
                            })
                        }]);
                    })
                    .catch(function(error) { clearJobMarker(); throw error; });
            };
            try {
                // The raw master folder is a sync (non-secret) setting; read it
                // here so the Downloader never touches chrome.storage itself
                // (same class runs inside the offscreen document).
                if (options && typeof options.rawMasterFolder === "string") {
                    // The caller already resolved the folder for this job.
                    settings.rawMasterFolder = options.rawMasterFolder;
                    startWithSettings();
                    return;
                }
                chrome.storage.sync.get({ rawMasterFolder: "NHDW" }, (elems: any) => {
                    settings.rawMasterFolder = elems && elems.rawMasterFolder !== undefined ? String(elems.rawMasterFolder) : "NHDW";
                    startWithSettings();
                });
            } catch (_) {
                startWithSettings(); // keep the default master folder
            }
        });
    }

    export function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, errorCallback: Function, progressCallback: Function, galleryMetadata: Record<string, any> = {}, sourceTabId?: number | null, options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string; alreadyDownloadedIds?: string[]; redownloadIds?: string[] }) {
        beginJob();
        let zip = new JSZip();
        downloadAllDoujinshisAsync(zip, allDoujinshis, finalName, errorCallback, progressCallback, true, galleryMetadata, sourceTabId, options)
            .then((outcome: BatchOutcome) => {
                clearJobMarker();
                // Record on SUCCESS only: separate mode per successful gallery;
                // merged mode records every title only when the whole job is clean.
                const jobOptions = options || {};
                const format = normalizeFormat(jobOptions.useZip || "zip", "zip");
                const effectiveSeparate = !!(jobOptions.downloadSeparately || format === "raw");
                const resolved = historyRecords(outcome, {
                    effectiveSeparate: effectiveSeparate,
                    format: format,
                    finalName: finalName,
                    archiveMasterFolder: typeof jobOptions.archiveMasterFolder === "string" ? jobOptions.archiveMasterFolder : ""
                });
                if (resolved.length > 0) {
                    recordHistory(resolved);
                }
            })
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
        sourceTabId?: number | null,
        options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string; alreadyDownloadedIds?: string[]; redownloadIds?: string[] }
    ): Promise<BatchOutcome> {
        let downloadName: string = "";
        let duplicateBehaviour: string = "";
        let replaceSpaces: boolean = false;
        let downloadSeparately: boolean = false;
        let maxConcurrentDownloads: string | undefined;
        let rawMasterFolder: string = "NHDW";
        await new Promise((resolve, _reject) => {
            resolve(
                chrome.storage.sync.get({
                    downloadName: "{pretty}",
                    duplicateBehaviour: "rename",
                    replaceSpaces: true,
                    downloadSeparately: false,
                    maxConcurrentDownloads: "3",
                    rawMasterFolder: "NHDW"
                }, function(elems) {
                    downloadName = elems.downloadName;
                    duplicateBehaviour = elems.duplicateBehaviour;
                    replaceSpaces = elems.replaceSpaces;
                    downloadSeparately = elems.downloadSeparately;
                    maxConcurrentDownloads = elems.maxConcurrentDownloads;
                    rawMasterFolder = elems.rawMasterFolder;
                })
            );
        });
        // A per-job override (the popup's similar-gallery panel always asks
        // for one archive per selected gallery) beats the stored "download
        // each file separately" option.
        if (options && options.downloadSeparately !== undefined) {
            downloadSeparately = !!options.downloadSeparately;
        }
        // List mode carries its own filename template and its own (optional)
        // master folder. Without the template override the batch fell back to
        // the listing page's URL for the produced file name.
        if (options && typeof options.downloadName === "string") {
            downloadName = options.downloadName;
        }
        if (options && typeof options.rawMasterFolder === "string") {
            rawMasterFolder = options.rawMasterFolder;
        }
        // Each gallery in a separate archive owns that archive: flat entries,
        // file named after the gallery. One shared archive keeps a folder per
        // gallery inside so titles never collide.
        const gallerySettings: any = { archiveLayout: downloadSeparately ? "flat" : "nested" };
        gallerySettings.rawMasterFolder = rawMasterFolder;
        if (options && typeof options.archiveMasterFolder === "string") {
            gallerySettings.archiveMasterFolder = options.archiveMasterFolder;
        }
        if (options && options.useZip) {
            gallerySettings.useZip = options.useZip;
            gallerySettings.maxConcurrentDownloads = maxConcurrentDownloads;
        }
        // API key mode lives in chrome.storage.local (secrets never sync).
        // Empty string = keyless mode, which keeps its previous route order.
        const localApi = await readLocalApiSettings();
        const apiKey = localApi.apiKey;
        // Relay the API key fields with the per-gallery settings: the
        // offscreen document cannot read chrome.storage, and the Downloader
        // must not touch it either (only chrome.runtime is exposed there).
        gallerySettings.apiKey = apiKey || null;
        gallerySettings.useServerArchive = localApi.useServerArchive;
        let names: Array<string> = [];
        let length = Object.keys(allDoujinshis).length;
        let allKeys = Object.keys(allDoujinshis);
        // Per-gallery tally for the end-of-batch summary.
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        const failedKinds: Record<string, number> = {};

        // Persistent history guard (authoritative safety net behind the UI
        // pre-check): skip already-recorded galleries BEFORE any metadata
        // fetch, minus the user's "download anyway" picks. The worker read
        // chrome.storage.local at enqueue time; the recorded set is relayed in
        // options to the offscreen document when this runs there.
        const format: string = normalizeFormat(options ? options.useZip : "zip", "zip");
        const effectiveSeparate: boolean = !!(options && (options.downloadSeparately || format === "raw"));
        const alreadySet = new Set<string>(
            options && Array.isArray(options.alreadyDownloadedIds) ? options.alreadyDownloadedIds.map(String) : []
        );
        const redownloadSet = new Set<string>(
            options && Array.isArray(options.redownloadIds) ? options.redownloadIds.map(String) : []
        );
        // History records produced by this invocation.
        const records: Array<{ id: string; filename: string }> = [];
        const batchKeys: string[] = [];
        let finalSaveOk = false;

        function countFailure(error: any) {
            failed++;
            const { kind } = classifyError(error);
            failedKinds[kind] = (failedKinds[kind] || 0) + 1;
        }

        for (let i = 0; i < length; i++) {
            let key = allKeys[i];
            // Only per-title (separate) output can skip a gallery: a merged
            // archive must contain every selected title, so batch jobs never
            // skip (they re-record everything only when the whole job succeeds).
            if (effectiveSeparate && alreadySet.has(key) && !redownloadSet.has(key)) {
                skipped++;
                continue;
            }
            // Tell the popup which gallery the batch is working on.
            chrome.runtime.sendMessage({
                action: "batchProgress",
                current: i + 1,
                total: length,
                galleryName: allDoujinshis[key],
                stage: "Downloading"
            });

            // Metadata route order.
            // API key mode:
            //   0. Official keyed API (Authorization: Key ..., 429 backoff)
            // Keyless mode is unchanged:
            //   1. Already-resolved via selectedGalleryResolver
            //   2. Via the user's open tab (reuses Cloudflare clearance)
            //   3. Extension-origin fetch (likely 403)
            // A failing keyed request simply falls through to the keyless
            // routes, so an invalid key can never break a download.
            let json: any | null = galleryMetadata[key] || null;
            if (json === null && apiKey) {
                try {
                    const keyedParsing = new ApiParsing();
                    const keyedResp = await fetchNhentaiApi(
                        keyedParsing.GetUrl(key),
                        { credentials: "include", cache: "no-store", signal: jobAbortController ? jobAbortController.signal : undefined },
                        apiKey
                    );
                    if (keyedResp.ok) {
                        json = await keyedParsing.GetJsonAsync(keyedResp);
                    }
                } catch (_) {
                    // Fall through to the tab-based routes.
                }
            }
            let jsonFromTab: any | null = null;
            if (json === null && typeof sourceTabId === "number") {
                jsonFromTab = await getGalleryViaTab(sourceTabId, key, parsing);
            }
            if (json === null) {
                json = jsonFromTab;
            }
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
                if (effectiveSeparate) {
                    // Separate files are named from the (list-mode) template
                    // and the gallery's OWN metadata, cleaned exactly like a
                    // single-title download - never from the page URL.
                    zipName = utils.cleanName(title, replaceSpaces, key);
                } else if (downloadAtEnd && i == length - 1) {
                    zipName = finalName;
                }
                // Batch mode: the merged archive is saved by the LAST gallery's
                // Downloader. Its success is what makes the job "clean".
                const isFinalSave = !effectiveSeparate && downloadAtEnd && i === length - 1;
                currentDownloader = new Downloader(json, utils.cleanName(title, replaceSpaces, key), errorCallback, progressCallback, allDoujinshis[key],
                effectiveSeparate ? new JSZip() : zip, // If we download separately, we make sure to not reuse the previous ZIP
                zipName, jobAbortController ? jobAbortController.signal : null, undefined, gallerySettings);
                if (typeof sourceTabId === "number") {
                    currentDownloader.sourceTabId = sourceTabId;
                }
                // We download the ZIP file in the following cases:
                // downloadSeparately is true / raw (effective separate)
                // OR downloadAtEnd is true (can be false if downloading many pages) AND we are at the doujin of the current list

                try {
                    await currentDownloader.startAsync();
                    succeeded++;
                    if (isFinalSave) {
                        finalSaveOk = true;
                    }
                    if (effectiveSeparate) {
                        // Only a fully successful gallery is recorded; a
                        // partial gallery (any page failed) stays un-recorded
                        // so the next run re-fetches it cleanly.
                        records.push({
                            id: key,
                            filename: artifactRecordFilename({
                                format: format,
                                name: zipName || utils.cleanName(title, replaceSpaces, key),
                                masterFolder: format === "raw"
                                    ? String(rawMasterFolder || "NHDW")
                                    : (options && typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : "")
                            })
                        });
                    } else {
                        batchKeys.push(key);
                    }
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
                    errorCallback("Can't download " + key + " - Cloudflare blocked the request (HTTP " + resp.status + "). Open the gallery in a tab, complete any challenge, then try again.");
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
                skipped: skipped,
                total: length,
                failedKinds: failedKinds
            });
        }
        // Batch mode is all-or-nothing: every gallery must have succeeded AND
        // the merged artifact must have been saved (the last gallery carries
        // the save). A merged file only records its title set when the run is
        // fully clean, so a failure part-way leaves all of them re-downloadable.
        const clean = effectiveSeparate
            ? true
            : (failed === 0 && finalSaveOk && batchKeys.length > 0);
        return {
            records: records,
            clean: clean,
            batchKeys: batchKeys,
            skipped: skipped
        } as BatchOutcome;
    }

    export function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, errorCallback: Function, progressCallback: Function, url: string, sourceTabId?: number | null, options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string; alreadyDownloadedIds?: string[]; redownloadIds?: string[] }) {
        beginJob();
        downloadAllPagesAsync(allDoujinshis, pagesArr, path, errorCallback, progressCallback, url, sourceTabId, options)
            .then((outcome: BatchOutcome) => {
                clearJobMarker();
                // Records are already resolved (merged mode is all-or-nothing).
                if (outcome.records.length > 0) {
                    recordHistory(outcome.records);
                }
            })
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
        sourceTabId?: number | null,
        options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string; alreadyDownloadedIds?: string[]; redownloadIds?: string[] }
    ): Promise<BatchOutcome> {
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
        const format: string = normalizeFormat(options ? options.useZip : "zip", "zip");
        const effectiveSeparate: boolean = !!(options && (options.downloadSeparately || format === "raw"));

        // Aggregate every page's outcome: separate mode keeps per-gallery
        // records (they are real, independent files); merged mode records every
        // title only when EVERY page succeeded and the artifact was saved.
        const allRecords: Array<{ id: string; filename: string }> = [];
        const allBatchKeys: string[] = [];
        let allClean = true;
        let skippedTotal = 0;
        let pagesFetched = 0;

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
                const outcome = await downloadAllDoujinshisAsync(zip, allDoujinshis, path + " (" + curr + ")", errorCallback, progressCallback, i == pagesArr.length - 1, {}, sourceTabId, options);
                allRecords.push.apply(allRecords, outcome.records);
                allBatchKeys.push.apply(allBatchKeys, outcome.batchKeys);
                skippedTotal += outcome.skipped;
                if (!outcome.clean) {
                    allClean = false;
                }
                pagesFetched++;
            } else {
                // A page that could not be fetched contributes nothing: a
                // merged job is never clean without it, so no batch titles
                // are recorded.
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
                masterFolder: options && typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : ""
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

// Popup format choices arrive as a per-job override. "folder" is the retired
// image-folder format: map it to its replacement (PDF) so old callers keep
// working; unknown values return undefined and the stored default applies.
// Downloads can be triggered from the popup / side panel (which knows the
// gallery tab id) or from the in-page card controls (a content script, whose
// own tab is the source tab). Resolving both here keeps the source-tab
// requirement - metadata and images are read through the user's tab - working
// for every entry point.
// Per-job overrides shared by the offscreen relay and the in-worker fallback
// path, so both honour the list-mode format, output mode, filename template
// and optional master folder identically.
function jobOverridesFromRequest(request: any): {
    useZip?: string;
    downloadSeparately?: boolean;
    downloadName?: string;
    rawMasterFolder?: string;
    archiveMasterFolder?: string;
    redownloadIds?: string[];
} {
    const overrides: any = { useZip: normalizeFormatOverride(request.formatOverride) };
    if (request.separate !== undefined) {
        overrides.downloadSeparately = !!request.separate;
    }
    if (typeof request.nameTemplate === "string") {
        overrides.downloadName = request.nameTemplate;
    }
    if (typeof request.masterFolder === "string") {
        overrides.rawMasterFolder = request.masterFolder;
        overrides.archiveMasterFolder = request.masterFolder;
    }
    // Per-download "download anyway" override: recorded galleries in this list
    // are exempt from the history guard.
    overrides.redownloadIds = Array.isArray(request.redownloadIds) ? request.redownloadIds.map(String) : [];
    return overrides;
}

// The persistent history guard needs the recorded ID list. The worker owns
// chrome.storage.local; the offscreen document receives the list relayed
// inside its job options (it has no storage of its own).
function attachHistoryOverrides(overrides: any): Promise<any> {
    return readHistory().then((history) => {
        overrides.alreadyDownloadedIds = historyIds(history);
        if (!Array.isArray(overrides.redownloadIds)) {
            overrides.redownloadIds = [];
        }
        return overrides;
    });
}

function resolveTabId(request: any, sender: any): number | undefined {
    if (typeof request.tabId === "number") {
        return request.tabId;
    }
    if (sender && sender.tab && typeof sender.tab.id === "number") {
        return sender.tab.id;
    }
    return undefined;
}

function normalizeFormatOverride(value: any): DownloadFormat | undefined {
    // Shared registry (utils/downloadFormats): one definition of the four
    // formats and of the retired "folder" -> "pdf" mapping, so list mode and
    // single-title mode can never disagree about what a format means.
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const normalized = normalizeFormat(value, "zip");
    // An unrecognized value must stay undefined (fall back to the stored
    // default) rather than silently becoming zip.
    return (value === "folder" || normalized === value) ? normalized : undefined;
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
    htmlParsing: false,
    rawMasterFolder: "NHDW"
};

// API key settings are stored in chrome.storage.local (a secret must never
// sync). Read once per batch / relayed command.
function readLocalApiSettings(): Promise<{ apiKey: string; useServerArchive: boolean }> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ apiKey: "", useServerArchive: false }, (elems: any) => {
                resolve({
                    apiKey: elems && elems.apiKey ? String(elems.apiKey) : "",
                    useServerArchive: !!(elems && elems.useServerArchive)
                });
            });
        } catch (_) {
            resolve({ apiKey: "", useServerArchive: false });
        }
    });
}

function readDownloadOptions(callback: (options: any) => void) {
    try {
        chrome.storage.sync.get(DOWNLOAD_OPTION_DEFAULTS, (elems: any) => {
            readLocalApiSettings().then((localApi) => {
                callback(Object.assign({}, elems, {
                    apiKey: localApi.apiKey,
                    useServerArchive: localApi.useServerArchive
                }));
            });
        });
    } catch (_) {
        callback(Object.assign({}, DOWNLOAD_OPTION_DEFAULTS, { apiKey: "", useServerArchive: false }));
    }
}

// Messages from the offscreen document back to the service worker.
// Returns true ONLY when sendResponse will be called asynchronously -
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
        //
        // The requested name is recorded BEFORE download() starts: the
        // onDeterminingFilename guard (installDownloadFilenameGuard) reads
        // the map to re-assert the name/folder when another extension's
        // listener would otherwise suppress it (Chromium bug 579563).
        try {
            if (typeof request.filename === "string" && request.filename !== "") {
                recordDownloadRequest(String(request.url), request.filename);
            }
            chrome.downloads.download({ url: request.url, filename: request.filename, conflictAction: "uniquify" }, (downloadId: number) => {
                if (downloadId === undefined) {
                    // Release the recorded name: nothing will complete for it
                    // and a stuck entry would pin the global listener.
                    discardDownloadRequest(String(request.url));
                    sendResponse({ result: false, error: String(chrome.runtime.lastError || "Unable to start download") });
                } else {
                    bindDownloadId(String(request.url), downloadId);
                    sendResponse({ result: downloadId });
                }
            });
        } catch (error) {
            sendResponse({ result: false, error: String(error) });
        }
        return true;
    }
    if (request.action === "recordDownloadName") {
        // Fire-and-forget bookkeeping from the offscreen document: blob saves
        // that go through the anchor mechanism never reach chrome.downloads
        // here, but the onDeterminingFilename guard still sees them (the
        // event fires for every download in the profile), so the mapping is
        // recorded to keep their title-based name stable too.
        try {
            if (typeof request.filename === "string" && request.filename !== "") {
                recordDownloadRequest(String(request.url), request.filename);
            }
        } catch (_) { /* bookkeeping must never break the save */ }
        sendResponse({ result: true });
        return false; // answered synchronously
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
        // Persistent download history: the offscreen document reports the
        // galleries that fully succeeded (never enqueues/failures); the worker
        // writes them to chrome.storage.local. recordHistory is best-effort
        // and must never reject (storage failure cannot fail the download).
        if (Array.isArray(request.records) && request.records.length > 0) {
            recordHistory(request.records);
        }
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
    if (request.action === "getCdnStatus") {
        // Popup asks which image CDN servers are active and whether nhentai
        // reported hosts that still need the optional host grant. The worker
        // owns this (chrome.permissions / storage live here, not in the popup
        // context of every browser). Answered asynchronously.
        cdnConfigService.getCdnStatus().then((status) => {
            sendResponse({
                result: "success",
                imageServers: status.imageServers,
                missingOrigins: status.missingOrigins
            });
        });
        return true;
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
                // One shared format registry: list mode, single-title mode and
                // the in-page card controls all send the same values, and the
                // retired "folder" format still maps to PDF.
                const formatOverride = relayedMessage.formatOverride;
                if (formatOverride !== undefined && formatOverride !== null && formatOverride !== "") {
                    // Popup format choices affect this job only; do not mutate
                    // the user's persisted default in chrome.storage.sync.
                    options.useZip = normalizeFormat(formatOverride, options.useZip);
                }
                if (relayedMessage.separate !== undefined) {
                    // Explicit output mode from the caller (list mode defaults
                    // to separate files; the similar-gallery panel always asks
                    // for one archive per gallery). Both true AND false must
                    // win over the stored default, otherwise "batch" could
                    // never be requested from a UI whose default is separate.
                    options.downloadSeparately = !!relayedMessage.separate;
                }
                if (typeof relayedMessage.nameTemplate === "string") {
                    // List mode has its own filename template. Without this the
                    // batch fell back to the listing page's URL for the name.
                    options.downloadName = relayedMessage.nameTemplate;
                }
                if (typeof relayedMessage.masterFolder === "string") {
                    // Optional (not forced) master folder, applied to both raw
                    // folders and finished archives.
                    options.rawMasterFolder = relayedMessage.masterFolder;
                    options.archiveMasterFolder = relayedMessage.masterFolder;
                }
                if (Array.isArray(relayedMessage.redownloadIds)) {
                    options.redownloadIds = relayedMessage.redownloadIds.map(String);
                }
                // Relay the persistent history with the job: the offscreen
                // guard (and Download all across pages) needs the recorded ID
                // list to skip already-downloaded galleries without fetching
                // their metadata.
                attachHistoryOverrides(options).then((optionsWithHistory) => {
                    const jobOptions = optionsWithHistory;
                    background.setJobMarker(true);
                    // Resolve the nhentai image CDN config (GET /api/v2/cdn, cached
                    // for the session) before the job starts, and relay the
                    // validated, permission-filtered server list with the job: the
                    // offscreen document cannot read storage or chrome.permissions
                    // itself. ensureImageServers never rejects - worst case it
                    // returns the cached fallback list after a short timeout.
                    cdnConfigService.ensureImageServers(relayedMessage.tabId).then((imageServers) => {
                        jobOptions.imageServers = imageServers;
                        // options: the offscreen document cannot read chrome.storage,
                        // so the worker relays the download settings with the command.
                        askOffscreen(Object.assign({}, relayedMessage, { options: jobOptions }), (response) => {
                            if (response && (response.result === "started" || response.result === "queued")) {
                                // A queued job is held by the offscreen document and
                                // will start after the active job sends jobFinished.
                                // Keep the worker marker set across the whole queue.
                                sendResponse({ result: response.result, position: response.position });
                            } else {
                                background.clearJobMarker();
                                relayDownloadError(response && response.error ? response.error : "Unable to start the offscreen download document.");
                                sendResponse({ result: "error" });
                            }
                        });
                    });
                }).catch(() => {
                    // History read failure must never block a download: relay
                    // with an empty history list (nothing is skipped).
                    background.setJobMarker(true);
                    cdnConfigService.ensureImageServers(relayedMessage.tabId).then((imageServers) => {
                        options.imageServers = imageServers;
                        options.alreadyDownloadedIds = [];
                        askOffscreen(Object.assign({}, relayedMessage, { options: options }), (response) => {
                            if (response && (response.result === "started" || response.result === "queued")) {
                                sendResponse({ result: response.result, position: response.position });
                            } else {
                                background.clearJobMarker();
                                relayDownloadError(response && response.error ? response.error : "Unable to start the offscreen download document.");
                                sendResponse({ result: "error" });
                            }
                        });
                    });
                });
            });
            return true;
        };
        if (request.action === "downloadDoujinshi") {
            return startRelayedJob({ action: "downloadDoujinshi", json: request.json, path: request.path, name: request.name, tabId: resolveTabId(request, _sender), formatOverride: request.formatOverride, masterFolder: request.masterFolder });
        } else if (request.action === "downloadAllDoujinshis") {
            return startRelayedJob({ action: "downloadAllDoujinshis", allDoujinshis: request.allDoujinshis, galleryMetadata: request.galleryMetadata, finalName: request.finalName, tabId: resolveTabId(request, _sender), formatOverride: request.formatOverride, separate: request.separate, nameTemplate: request.nameTemplate, masterFolder: request.masterFolder, redownloadIds: request.redownloadIds });
        } else if (request.action === "downloadAllPages") {
            return startRelayedJob({ action: "downloadAllPages", allDoujinshis: request.allDoujinshis, pages: request.pages, finalName: request.finalName, url: request.url, tabId: resolveTabId(request, _sender), formatOverride: request.formatOverride, separate: request.separate, nameTemplate: request.nameTemplate, masterFolder: request.masterFolder, redownloadIds: request.redownloadIds });
        } else if (request.action === "goBack") {
            background.clearJobMarker();
            askOffscreen({ action: "goBack" }, () => sendResponse({ result: "success" }));
            return true;
        } else if (request.action === "pause" || request.action === "resume") {
            askOffscreen({ action: request.action }, (response) => sendResponse(response || { result: "error" }));
            return true;
        } else if (request.action === "clearQueue") {
            askOffscreen({ action: "clearQueue" }, (response) => {
                sendResponse(response || { result: "error" });
            });
            return true;
        } else if (request.action === "updateProgress") {
            askOffscreen({ action: "getProgress" }, (response) => {
                if (response && typeof response.progress === "number") {
                    chrome.runtime.sendMessage({
                        action: "updateProgress",
                        progress: response.progress,
                        doujinshiName: response.doujinshiName,
                        isZipping: response.isZipping,
                        retry: response.retry,
                        queued: response.queued,
                        paused: response.paused
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
        // Resolve the CDN image server list (cached; falls back to the
        // built-in mirrors) before the job starts, then run in this worker.
        // The marker goes up synchronously (like the relayed path) so a popup
        // opened during the resolution window still sees the active job.
        background.setJobMarker(true);
        cdnConfigService.ensureImageServers(request.tabId).then((imageServers) => {
            setImageServers(imageServers);
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
                resolveTabId(request, _sender),
                jobOverridesFromRequest(request)
            );
            sendResponse({ result: "started" });
        });
        return true; // sendResponse is called asynchronously.
    } else if (request.action === "downloadAllDoujinshis") {
        background.setJobMarker(true);
        cdnConfigService.ensureImageServers(request.tabId).then((imageServers) => {
            setImageServers(imageServers);
            // Persistent history guard: the same worker-side read the relay
            // path uses, so the fallback pipeline skips recorded galleries
            // (minus the per-download "download anyway" ids) identically.
            attachHistoryOverrides(jobOverridesFromRequest(request)).then((overrides) => {
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
                    resolveTabId(request, _sender),
                    overrides
                );
                sendResponse({ result: "started" });
            });
        });
        return true; // sendResponse is called asynchronously.
    } else if (request.action === "downloadAllPages") {
        background.setJobMarker(true);
        cdnConfigService.ensureImageServers(request.tabId).then((imageServers) => {
            setImageServers(imageServers);
            attachHistoryOverrides(jobOverridesFromRequest(request)).then((overrides) => {
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
                    resolveTabId(request, _sender),
                    overrides
                );
                sendResponse({ result: "started" });
            });
        });
        return true; // sendResponse is called asynchronously.
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
