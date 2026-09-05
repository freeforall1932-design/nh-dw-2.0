import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import Downloader from "./Downloader";
import { errorMessage } from "../utils/utils";
import { getSourceForUrl } from "../sources";
import { executeInTab } from "../preview/activeTabGallery";
import { fetchImageInPage, fetchUrlInPage, fetchUrlFromTab } from "./tabImageFetch";
import { setImageServers } from "../sources/cdnConfig";
import { runBatchDownload, runPagedBatchDownload, buildRetryJob, BatchHost, BatchJobOptions } from "../utils/batchPipeline";
import * as cdnConfigService from "./cdnConfigService";
import { installDownloadFilenameGuard, recordDownloadRequest } from "./downloadNaming";
import { installDownloadCompletionTracker, startBrowserDownload, awaitDownloadCompletion, cancelTrackedDownload } from "./downloadControl";
import { normalizeFormat, normalizeFormatOverride, resolveJobFormat, formatExtension, DownloadFormat } from "../utils/downloadFormats";
// The worker OWNS the persistent download history (chrome.storage.local): it
// reads it for the pipeline guard, writes it when jobs report success and
// clears it on user request. The offscreen document never touches storage.
import {
    BatchOutcome,
    DownloadHistory,
    applyBatchDate,
    artifactRecordFilename,
    batchCandidateNames,
    historyIds,
    historyRecords,
    pickFreeBatchFilename,
    readHistory,
    recordHistory
} from "../utils/downloadHistory";
// The offscreen document must never see this module: chrome.downloads is a
// worker-only capability and it is what makes "verify before skip" possible.
import { presentBatchFilenames, verifyHistoryOnDisk } from "../utils/downloadVerify";
// Failed galleries of the session (chrome.storage.session): remembered so the
// popup can name them and re-add them even after it was closed mid-job.
import { rememberFailedGalleries, forgetFailedGalleries, readPendingFailuresSettled, clearPendingFailures } from "../utils/failedGalleries";
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
// Completion tracking for browser downloads (raw pages, fallback archives):
// registered at load so terminal events are never missed after a worker
// restart mid-gallery. Harmless where onChanged does not exist.
installDownloadCompletionTracker();

// One awaitDownload relay answer is held open for at most this long; the
// offscreen document simply asks again while the download is still running.
// Kept well under the 5-minute budget MV3 grants a single in-flight event so
// a slow page can never get the worker terminated mid-gallery.
const AWAIT_DOWNLOAD_SLICE_MS = 45000;
const AWAIT_DOWNLOAD_POLL_MS = 10000;

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

module background
{
    let currentDownloader: Downloader | null = null;
    let parsing: AParsing = new ApiParsing();
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
        // The effective output format is resolved ONCE for this job (per-job
        // override -> stored default -> zip) inside the storage read below,
        // and every consumer reads that single value: the Downloader settings,
        // the history record and the retry job. Deriving it twice, from
        // different inputs, is how a record could claim ".zip" while the file
        // on disk is ".cbz"/".pdf"/a raw folder (backlog item 33) - which then
        // breaks "verify before skip" into an endless re-download.
        const requestedFormat = options ? options.useZip : undefined;
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
                // A failure names the gallery and carries the job settings so
                // the popup can re-add it (same format / master folder). The
                // job is built when the failure happens; `settings.useZip` is
                // always set by now (resolved once at job start), so the
                // Downloader's own field and this fallback are the same value
                // and a retry can never change the format of the job.
                const buildRetryJob = (): any => {
                    const retryJob: any = {};
                    const format = resolveJobFormat((currentDownloader && currentDownloader.useZip) || settings.useZip);
                    retryJob.formatOverride = format;
                    if (typeof sourceTabId === "number") retryJob.tabId = sourceTabId;
                    const retryFolder = format === "raw" ? settings.rawMasterFolder : settings.archiveMasterFolder;
                    if (typeof retryFolder === "string") retryJob.masterFolder = retryFolder;
                    return retryJob;
                };
                const namedErrorCallback = (error: any) => {
                    errorCallback(errorMessage(error), {
                        galleryId: jsonTmp && jsonTmp.id !== undefined ? String(jsonTmp.id) : "",
                        galleryName: name,
                        retryJob: buildRetryJob()
                    });
                };
                currentDownloader = new Downloader(jsonTmp, path, namedErrorCallback, progressCallback, name, zip, path, signal, undefined, settings);
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
                        const format = resolveJobFormat(downloader.useZip || settings.useZip);
                        const masterFolder = format === "raw"
                            ? String(settings.rawMasterFolder || "NHDW")
                            : String(settings.archiveMasterFolder || "");
                        const records = [{
                            id: String(jsonTmp.id),
                            filename: artifactRecordFilename({
                                format: format,
                                name: String(downloader.downloadName || path),
                                masterFolder: masterFolder
                            })
                        }];
                        recordHistory(records);
                        forgetRecordedFailures(records);
                    })
                    .catch(function(error) { clearJobMarker(); throw error; });
            };
            try {
                // The raw master folder and the concurrency caps are sync
                // (non-secret) settings; read them here so the Downloader
                // never touches chrome.storage itself (same class runs inside
                // the offscreen document).
                chrome.storage.sync.get({ useZip: "zip", rawMasterFolder: "NHDW", maxConcurrentDownloads: "3", rawMaxConcurrent: "3" }, (elems: any) => {
                    // ONE resolution for the whole job. The Downloader is
                    // always handed the result, so it never falls back to its
                    // own storage read and can never resolve to something the
                    // record/retry job did not expect.
                    settings.useZip = resolveJobFormat(requestedFormat, elems && elems.useZip);
                    if (options && typeof options.rawMasterFolder === "string") {
                        // The caller already resolved the folder for this job.
                        settings.rawMasterFolder = options.rawMasterFolder;
                    } else {
                        settings.rawMasterFolder = elems && elems.rawMasterFolder !== undefined ? String(elems.rawMasterFolder) : "NHDW";
                    }
                    // The caps travel with the resolved format (the Downloader
                    // only reads them from its settings bag).
                    settings.maxConcurrentDownloads = elems && elems.maxConcurrentDownloads !== undefined ? elems.maxConcurrentDownloads : "3";
                    settings.rawMaxConcurrent = elems && elems.rawMaxConcurrent !== undefined ? elems.rawMaxConcurrent : "3";
                    startWithSettings();
                });
            } catch (_) {
                // No storage in this context: the per-job override is all we
                // have, and the shared resolver still yields one value that
                // both the Downloader and the record will use.
                settings.useZip = resolveJobFormat(requestedFormat, undefined);
                settings.maxConcurrentDownloads = "3";
                settings.rawMaxConcurrent = "3";
                if (options && typeof options.rawMasterFolder === "string") {
                    settings.rawMasterFolder = options.rawMasterFolder;
                }
                startWithSettings(); // keep the default master folder
            }
        });
    }

    function makeFallbackBatchHost(errorCallback: Function, progressCallback: Function): BatchHost {
        return {
            get parsing() { return parsing; },
            getAbortSignal: () => jobAbortController ? jobAbortController.signal : null,
            wasAborted: () => jobWasAborted(),
            messageExtras: () => ({}),
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
                if (typeof job.sourceTabId === "number") {
                    currentDownloader.sourceTabId = job.sourceTabId;
                }
                await currentDownloader.startAsync();
            }
        };
    }

    export function downloadAllDoujinshis(allDoujinshis: Record<string, string>, finalName: string, errorCallback: Function, progressCallback: Function, galleryMetadata: Record<string, any> = {}, sourceTabId?: number | null, options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string; alreadyDownloadedIds?: string[]; redownloadIds?: string[] }) {
        beginJob();
        const zip = new JSZip();
        resolveWorkerBatchOptions(options).then((resolved) => {
            runBatchDownload({
                zip: zip,
                allDoujinshis: allDoujinshis,
                finalName: finalName,
                downloadAtEnd: true,
                galleryMetadata: galleryMetadata,
                sourceTabId: sourceTabId,
                options: resolved,
                host: makeFallbackBatchHost(errorCallback, progressCallback)
            }).then((outcome: BatchOutcome) => {
                clearJobMarker();
                if (!jobWasAborted() && outcome.failedGalleries && outcome.failedGalleries.length > 0) {
                    rememberFailedGalleries(outcome.failedGalleries, buildRetryJob(sourceTabId, resolved));
                }
                const format = resolveJobFormat(resolved.useZip);
                const effectiveSeparate = !!(resolved.downloadSeparately || format === "raw");
                const records = historyRecords(outcome, {
                    effectiveSeparate: effectiveSeparate,
                    format: format,
                    finalName: finalName,
                    archiveMasterFolder: typeof resolved.archiveMasterFolder === "string" ? resolved.archiveMasterFolder : ""
                });
                if (records.length > 0) {
                    recordHistory(records);
                    forgetRecordedFailures(records);
                }
            }).catch(function(error) {
                clearJobMarker();
                if (!jobWasAborted()) {
                    errorCallback(errorMessage(error));
                }
            });
        });
    }

    export function downloadAllPages(allDoujinshis: Record<string, string>, pagesArr: Array<number>, path: string, errorCallback: Function, progressCallback: Function, url: string, sourceTabId?: number | null, options?: { useZip?: string; downloadSeparately?: boolean; downloadName?: string; rawMasterFolder?: string; archiveMasterFolder?: string; alreadyDownloadedIds?: string[]; redownloadIds?: string[] }) {
        beginJob();
        resolveWorkerBatchOptions(options).then((resolved) => {
            runPagedBatchDownload({
                allDoujinshis: allDoujinshis,
                pagesArr: pagesArr,
                path: path,
                url: url,
                sourceTabId: sourceTabId,
                options: resolved,
                host: makeFallbackBatchHost(errorCallback, progressCallback)
            }).then((outcome: BatchOutcome) => {
                clearJobMarker();
                if (!jobWasAborted() && outcome.failedGalleries && outcome.failedGalleries.length > 0) {
                    rememberFailedGalleries(outcome.failedGalleries, buildRetryJob(sourceTabId, resolved));
                }
                if (outcome.records.length > 0) {
                    recordHistory(outcome.records);
                    forgetRecordedFailures(outcome.records);
                }
            }).catch(function(error) {
                clearJobMarker();
                if (!jobWasAborted()) {
                    errorCallback(errorMessage(error));
                }
            });
        });
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

// "Verify before skip" preference: default ON. When on, a recorded gallery is
// skipped only if its file can be confirmed on disk; when off, the record list
// is the truth (pre-3.5.0 semantics, fastest).
function readVerificationSetting(): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get({ verifyDownloadedFiles: true }, (elems: any) => {
                resolve(!elems || elems.verifyDownloadedFiles !== false);
            });
        } catch (_) {
            resolve(true);
        }
    });
}

// The persistent history guard needs the recorded ID list. The worker owns
// chrome.storage.local; the offscreen document receives the list relayed
// inside its job options (it has no storage of its own).
function attachHistoryOverrides(overrides: any): Promise<any> {
    return readHistory().then((history) => readVerificationSetting().then((verify) => {
        const apply = (ids: string[]) => {
            overrides.alreadyDownloadedIds = ids;
            if (!Array.isArray(overrides.redownloadIds)) {
                overrides.redownloadIds = [];
            }
            return overrides;
        };
        if (!verify || Object.keys(history).length === 0) {
            return apply(historyIds(history));
        }
        // Verify before skip: only ids whose artifact is still on disk are
        // skipped; deleted files fall through and are downloaded again.
        return verifyHistoryOnDisk(history).then((present) => {
            return apply(historyIds(history).filter((id) => present.has(id)));
        });
    }));
}

// Merged-job naming for listing re-runs (settled with the user):
//  * batchNameDate (default ON) appends _DDMMYYYY to the base name, so
//    homepage / search / artist / tag / genre re-runs get distinguishable
//    merged files ("search_31082026.zip") and the history records THAT name.
//  * The same title+date again becomes _part2, _part3 ... (part numbering).
//  * Merged jobs are NEVER skipped, but when the name is already occupied and
//    the user has not confirmed yet, the worker answers {result:"existing",
//    filename} instead of starting — the UI warns and re-sends with
//    existingConfirmed (the user chose "warn only" for merged re-runs).
// Runs only for merged jobs: separate saves and raw folders are named from the
// per-gallery template, and single-title downloads never pass through here.
async function resolveMergedBatchName(
    relayedMessage: any,
    confirmExisting: boolean,
    jobFormat?: string
): Promise<{ finalName: string } | { existing: string }> {
    const settings = await new Promise<any>((resolve) => {
        try {
            chrome.storage.sync.get({ batchNameDate: true, verifyDownloadedFiles: true, useZip: "zip" }, (elems) => resolve(elems || {}));
        } catch (_) {
            resolve({});
        }
    });
    // ONE format decision for the naming pass: the format the job resolved to
    // when the caller already knows it (relay path), otherwise per-job
    // override -> stored default -> zip. Reading the request alone meant a
    // merged job with no explicit override computed ".zip" candidates for a
    // job whose stored default is cbz/pdf, so the "you already have this
    // file" warning could never match the real artifact and every re-run grew
    // another _partN (backlog item 33).
    const format = normalizeFormat(
        jobFormat !== undefined
            ? jobFormat
            : resolveJobFormat(relayedMessage.formatOverride, settings.useZip),
        "zip"
    );
    if (relayedMessage.separate === true || format === "raw" || relayedMessage.action === "downloadDoujinshi") {
        return { finalName: String(relayedMessage.finalName || "") };
    }
    const dateOn = settings.batchNameDate !== false;
    const verify = settings.verifyDownloadedFiles !== false;
    // formatExtension returns ".zip" (with the dot); the naming helpers expect
    // the bare extension ("zip") and append the dot themselves.
    const extension = formatExtension(format as DownloadFormat).replace(/^\./, "");
    const pages = Array.isArray(relayedMessage.pages) ? relayedMessage.pages : [];
    const pageSuffix = pages.length > 0 ? " (" + String(pages[pages.length - 1]) + ")" : "";
    let base = String(relayedMessage.finalName || "download");
    if (dateOn) {
        base = applyBatchDate(base, Date.now());
    }
    // The part number belongs on the base name; the page marker is appended by
    // the downloadAllPages pipeline AFTER it ("<base>[_partN] (N)"), so the
    // disk candidates carry the page suffix last.
    const candidates = batchCandidateNames(base).map((n) => n + pageSuffix + "." + extension);
    const present = verify
        ? await presentBatchFilenames(candidates)
        : new Set<string>();
    const history: DownloadHistory = await readHistory();
    const first = candidates[0];
    const firstOccupied = verify
        ? present.has(first)
        : Object.keys(history).some((id) => history[id].filename === first);
    if (firstOccupied && !confirmExisting) {
        return { existing: first };
    }
    const chosen = pickFreeBatchFilename(history, base, extension, {
        verify: verify,
        presentFilenames: present,
        suffix: pageSuffix
    });
    // Strip "<pageSuffix><extension>" from the chosen candidate; what remains
    // is the finalName the pipelines save (single page: "<base>[_partN]", multi
    // page: "<base>[_partN]" and downloadAllPages appends " (lastPage)").
    const finalName = chosen.slice(0, -(pageSuffix.length + extension.length + 1));
    return { finalName: finalName };
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
                                if (callback) callback({ result: false, error: errorMessage(error) });
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
                callback({ result: false, error: errorMessage(error) });
            }
        });
}

function relayDownloadError(error: string) {
    chrome.runtime.sendMessage({ action: "downloadError", error: error });
}

// Error reporter for the in-worker fallback pipeline. The optional context
// names the failed gallery and carries the job the popup can re-send.
function fallbackErrorCallback(error: any, context?: { galleryId?: string; galleryName?: string; retryJob?: any }) {
    const payload: any = { action: "downloadError", error: errorMessage(error) };
    if (context) {
        if (context.galleryId !== undefined) payload.galleryId = String(context.galleryId);
        if (context.galleryName !== undefined) payload.galleryName = String(context.galleryName);
        if (context.retryJob !== undefined) payload.retryJob = context.retryJob;
        if (context.galleryId) {
            rememberFailedGalleries(
                [{ id: String(context.galleryId), name: String(context.galleryName || context.galleryId), error: payload.error }],
                context.retryJob || null
            );
        }
    }
    chrome.runtime.sendMessage(payload);
}

// A gallery that downloaded successfully is no longer "failed": drop it from
// the session list (and record it in the history, which the callers do).
function forgetRecordedFailures(records: Array<{ id: string | number; filename: string }>) {
    try {
        forgetFailedGalleries(records.map((entry) => String(entry.id)));
    } catch (_) { /* bookkeeping only */ }
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
    rawMaxConcurrent: "3",
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

function resolveWorkerBatchOptions(options?: BatchJobOptions): Promise<BatchJobOptions> {
    return new Promise<BatchJobOptions>((resolve) => {
        const finish = (stored: any, localApi: { apiKey: string; useServerArchive: boolean }) => {
            const merged: BatchJobOptions = {
                useZip: resolveJobFormat(undefined, stored && stored.useZip),
                downloadName: stored && stored.downloadName ? stored.downloadName : "{pretty}",
                duplicateBehaviour: stored && stored.duplicateBehaviour ? stored.duplicateBehaviour : "rename",
                replaceSpaces: stored && stored.replaceSpaces !== undefined ? stored.replaceSpaces : true,
                downloadSeparately: !!(stored && stored.downloadSeparately),
                maxConcurrentDownloads: stored && stored.maxConcurrentDownloads !== undefined ? stored.maxConcurrentDownloads : "3",
                rawMaxConcurrent: stored && stored.rawMaxConcurrent !== undefined ? stored.rawMaxConcurrent : "3",
                rawMasterFolder: stored && stored.rawMasterFolder !== undefined ? String(stored.rawMasterFolder) : "NHDW",
                apiKey: localApi.apiKey,
                useServerArchive: localApi.useServerArchive
            };
            if (options) {
                if (options.downloadSeparately !== undefined) merged.downloadSeparately = !!options.downloadSeparately;
                if (typeof options.downloadName === "string") merged.downloadName = options.downloadName;
                if (typeof options.rawMasterFolder === "string") merged.rawMasterFolder = options.rawMasterFolder;
                if (typeof options.archiveMasterFolder === "string") merged.archiveMasterFolder = options.archiveMasterFolder;
                if (options.useZip) merged.useZip = resolveJobFormat(options.useZip, merged.useZip);
                if (typeof options.duplicateBehaviour === "string") merged.duplicateBehaviour = options.duplicateBehaviour;
                if (options.replaceSpaces !== undefined) merged.replaceSpaces = options.replaceSpaces;
                if (options.maxConcurrentDownloads !== undefined) merged.maxConcurrentDownloads = options.maxConcurrentDownloads;
                if (options.rawMaxConcurrent !== undefined) merged.rawMaxConcurrent = options.rawMaxConcurrent;
                if (Array.isArray(options.alreadyDownloadedIds)) merged.alreadyDownloadedIds = options.alreadyDownloadedIds;
                if (Array.isArray(options.redownloadIds)) merged.redownloadIds = options.redownloadIds;
            }
            resolve(merged);
        };
        readLocalApiSettings().then((localApi) => {
            try {
                chrome.storage.sync.get({
                    useZip: "zip",
                    downloadName: "{pretty}",
                    duplicateBehaviour: "rename",
                    replaceSpaces: true,
                    downloadSeparately: false,
                    maxConcurrentDownloads: "3",
                    rawMaxConcurrent: "3",
                    rawMasterFolder: "NHDW"
                }, (elems: any) => finish(elems, localApi));
            } catch (_) {
                finish({}, localApi);
            }
        });
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
        //
        // The answer carries the downloadId as soon as the browser accepted
        // the download; the offscreen document then follows it to completion
        // with awaitDownload (below), so a page interrupted after it started
        // reaches the Downloader's retry loop instead of counting as saved.
        startBrowserDownload(String(request.url), String(request.filename || ""))
            .then((downloadId) => { sendResponse({ result: downloadId }); })
            .catch((error: any) => {
                // Message-first, never String(plainObject): an object error
                // must not survive the channel as "[object Object]" (the old
                // raw-mode report) — the offscreen document only sees this
                // string and wraps it once more.
                const reason = error && error.message !== undefined
                    ? String(error.message)
                    : (typeof error === "string" ? error : "Unable to start download");
                sendResponse({ result: false, error: reason });
            });
        return true;
    }
    if (request.action === "awaitDownload") {
        // Bounded wait for a terminal state of one browser download
        // (downloadControl.ts): answers complete / interrupted, or "pending"
        // when the slice elapsed, in which case the offscreen document asks
        // again. Contexts without downloads.onChanged answer "unknown" and
        // the caller keeps the historical "started = saved" behaviour.
        awaitDownloadCompletion(Number(request.downloadId), {
            onTimeout: "report",
            maxWaitMs: AWAIT_DOWNLOAD_SLICE_MS,
            pollMs: AWAIT_DOWNLOAD_POLL_MS
        }).then((outcome) => {
            sendResponse({ result: true, ok: outcome.ok, state: outcome.state, error: outcome.error || null });
        });
        return true;
    }
    if (request.action === "cancelDownload") {
        // The offscreen document gave up on a page (user cancel, or a
        // download that never finishes): stop the browser download so a
        // retry cannot land next to a zombie copy of the same file.
        cancelTrackedDownload(Number(request.downloadId));
        sendResponse({ result: true });
        return false; // answered synchronously
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
            forgetRecordedFailures(request.records);
        }
        return false;
    }
    if (request.action === "batchSummary" || request.action === "downloadError") {
        // Broadcasts also reach the popup directly (never relayed back); the
        // worker only REMEMBERS the named failures they carry, so a popup
        // opened later can still list and retry them.
        try {
            if (request.action === "batchSummary" && Array.isArray(request.failedGalleries) && request.failedGalleries.length > 0) {
                rememberFailedGalleries(request.failedGalleries, request.retryJob || null);
            } else if (request.action === "downloadError" && request.galleryId) {
                rememberFailedGalleries(
                    [{ id: String(request.galleryId), name: String(request.galleryName || request.galleryId), error: String(request.error) }],
                    request.retryJob || null
                );
            }
        } catch (_) { /* bookkeeping only */ }
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
    if (request.action === "getFailedGalleries") {
        // Popup / side panel: which galleries of this browser session failed
        // (names, reasons, and the job settings a retry needs).
        readPendingFailuresSettled().then((failed) => {
            sendResponse({ result: "success", failed: failed });
        });
        return true;
    }
    if (request.action === "forgetFailedGalleries") {
        // User dismissed some (or all) failed galleries.
        const done = Array.isArray(request.ids) ? forgetFailedGalleries(request.ids) : clearPendingFailures();
        done.then(() => sendResponse({ result: "success" }));
        return true;
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
                // ONE resolution for the whole job: per-job override, then the
                // stored default, then zip. Popup format choices affect this
                // job only - the user's persisted default in
                // chrome.storage.sync is never mutated. The offscreen document
                // has no chrome.storage, so it must always receive a concrete
                // format; the merged-name resolution below uses this same
                // value rather than re-reading the raw request, otherwise the
                // disk candidates and part numbering are computed for the
                // wrong extension (backlog item 33).
                options.useZip = resolveJobFormat(relayedMessage.formatOverride, options.useZip);
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
                    const startRelay = () => {
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
                    };
                    // Merged re-runs: date stamp + part numbering + the "you
                    // already have this file" warning (the user chose warn-only
                    // for merged jobs). Resolution must never block a download.
                    if (relayedMessage.action === "downloadAllDoujinshis" || relayedMessage.action === "downloadAllPages") {
                        resolveMergedBatchName(relayedMessage, !!relayedMessage.existingConfirmed, options.useZip)
                            .then((resolved: any) => {
                                if (resolved && resolved.existing) {
                                    sendResponse({ result: "existing", filename: resolved.existing });
                                    return;
                                }
                                relayedMessage = Object.assign({}, relayedMessage, { finalName: resolved.finalName });
                                startRelay();
                            })
                            .catch(() => { startRelay(); });
                        return;
                    }
                    startRelay();
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
            return startRelayedJob({ action: "downloadAllDoujinshis", allDoujinshis: request.allDoujinshis, galleryMetadata: request.galleryMetadata, finalName: request.finalName, tabId: resolveTabId(request, _sender), formatOverride: request.formatOverride, separate: request.separate, nameTemplate: request.nameTemplate, masterFolder: request.masterFolder, redownloadIds: request.redownloadIds, existingConfirmed: !!request.existingConfirmed });
        } else if (request.action === "downloadAllPages") {
            return startRelayedJob({ action: "downloadAllPages", allDoujinshis: request.allDoujinshis, pages: request.pages, finalName: request.finalName, url: request.url, tabId: resolveTabId(request, _sender), formatOverride: request.formatOverride, separate: request.separate, nameTemplate: request.nameTemplate, masterFolder: request.masterFolder, redownloadIds: request.redownloadIds, existingConfirmed: !!request.existingConfirmed });
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
                fallbackErrorCallback,
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
                // Merged re-runs: date + part numbering + "you already have
                // this file" warning (same behaviour as the relay path).
                resolveMergedBatchName(request, !!request.existingConfirmed)
                    .then((resolved: any) => {
                        if (resolved && resolved.existing) {
                            background.clearJobMarker();
                            sendResponse({ result: "existing", filename: resolved.existing });
                            return;
                        }
                        const requestWithName = Object.assign({}, request, { finalName: resolved.finalName });
                        background.downloadAllDoujinshis(
                            requestWithName.allDoujinshis,
                            requestWithName.finalName,
                            fallbackErrorCallback,
                            (progress: number, doujinshiName: string, isZipping: boolean, retry: string | null) => {
                                chrome.runtime.sendMessage({
                                    action: "updateProgress",
                                    progress: progress,
                                    doujinshiName: doujinshiName,
                                    isZipping: isZipping,
                    retry: retry
                                });
                            },
                            requestWithName.galleryMetadata || {},
                            resolveTabId(requestWithName, _sender),
                            overrides
                        );
                        sendResponse({ result: "started" });
                    })
                    .catch(() => {
                        // Name resolution must never block a download.
                        background.downloadAllDoujinshis(
                            request.allDoujinshis,
                            request.finalName,
                            fallbackErrorCallback,
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
        });
        return true; // sendResponse is called asynchronously.
    } else if (request.action === "downloadAllPages") {
        background.setJobMarker(true);
        cdnConfigService.ensureImageServers(request.tabId).then((imageServers) => {
            setImageServers(imageServers);
            attachHistoryOverrides(jobOverridesFromRequest(request)).then((overrides) => {
                const startPages = (withName: any) => {
                    background.downloadAllPages(
                        withName.allDoujinshis,
                        withName.pages,
                        withName.finalName,
                        fallbackErrorCallback,
                        (progress: number, doujinshiName: string, isZipping: boolean, retry: string | null) => {
                            chrome.runtime.sendMessage({
                                action: "updateProgress",
                                progress: progress,
                                doujinshiName: doujinshiName,
                                isZipping: isZipping,
                    retry: retry
                            });
                        },
                        withName.url,
                        resolveTabId(withName, _sender),
                        overrides
                    );
                    sendResponse({ result: "started" });
                };
                // Merged re-runs: date + part numbering + "you already have
                // this file" warning (same behaviour as the relay path).
                resolveMergedBatchName(request, !!request.existingConfirmed)
                    .then((resolved: any) => {
                        if (resolved && resolved.existing) {
                            background.clearJobMarker();
                            sendResponse({ result: "existing", filename: resolved.existing });
                            return;
                        }
                        startPages(Object.assign({}, request, { finalName: resolved.finalName }));
                    })
                    .catch(() => { startPages(request); });
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
