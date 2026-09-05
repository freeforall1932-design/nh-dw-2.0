import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import { utils, escapeHtml, errorMessage } from "../utils/utils";
import { message } from "./message"
import { resolveSelectedGalleries } from "./selectedGalleryResolver"
import { getSourceForUrl } from "../sources"
import { getActiveTabId, readGalleryFromTab } from "./activeTabGallery"
import { getApiModeState, decideGate, saveApiKey, skipApiKeyGate, fetchNhentaiApi } from "../utils/apiAuth"
import {
    DownloadFormat,
    effectiveOutputMode,
    formatExtension,
    normalizeFormat,
    normalizeOutputMode,
    outputModeToSeparate,
    shouldWarnPdfMerge
} from "../utils/downloadFormats"
import { ListModeSettings, resolveMasterFolder, saveListSettings } from "../utils/listSettings"
import { readHistory, partitionKnown, applyBatchDate, DownloadHistory, FailedGallery } from "../utils/downloadHistory"
import { PendingFailure, groupRetryMessages } from "../utils/failedGalleries"
import { confirmPdfMerge } from "./pdfMergeWarning"

// Manifest V3 removed chrome.tabs.executeScript. Keep all active-tab injection in
// one place so it works from the popup and uses the current tab explicitly.
function executeActiveTabScript(file: string): void {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        const tabId = tabs[0] && tabs[0].id;
        if (tabId === undefined) {
            return;
        }
        // @ts-ignore Older @types/chrome versions do not contain the MV3 scripting API.
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: [file] });
    });
}


// Extract metadata from the already-open gallery page. Prefer the rendered
// DOM (window._gallery / embedded JSON) so we never need /api/gallery, which
// Cloudflare commonly 403s for both the extension origin and the page itself.
async function getGalleryFromActiveTab(id: string): Promise<any | null> {
    const tabId = await getActiveTabId();
    if (tabId === undefined) {
        return null;
    }
    return readGalleryFromTab(tabId, id);
}

function getOptionalApiHeaders(): Promise<Record<string, string>> {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get({ apiKey: "" }, (stored: any) => {
                const apiKey = typeof stored.apiKey === "string" ? stored.apiKey.trim() : "";
                resolve(apiKey ? { "Authorization": "Key " + apiKey } : {});
            });
        } catch (_) {
            resolve({});
        }
    });
}

async function getRelatedGalleries(galleryId: string): Promise<Array<{ id: string; title: string; pages: number }>> {
    const response = await fetch("https://nhentai.net/api/v2/galleries/" + encodeURIComponent(galleryId) + "/related", {
        credentials: "include",
        cache: "no-store",
        headers: await getOptionalApiHeaders()
    });
    if (!response.ok) {
        throw new Error("Related galleries request failed (HTTP " + response.status + ").");
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.result)) {
        throw new Error("Related galleries response was invalid.");
    }
    const galleries: Array<{ id: string; title: string; pages: number }> = [];
    for (const gallery of payload.result) {
        if (!gallery || !Number.isFinite(Number(gallery.id))) {
            continue;
        }
        // Related cards can lack both titles (nhentai itself shows
        // "(Non-titled)"): keep the id visible so the row stays identifiable
        // and the resulting file remains traceable.
        const title = String(gallery.english_title || gallery.japanese_title || "").trim()
            || ("(Non-titled) " + gallery.id);
        galleries.push({
            id: String(gallery.id),
            title: title,
            pages: Number(gallery.num_pages) || 0
        });
    }
    return galleries;
}

function wireActiveJobControls() {
    const buttonBack = document.getElementById('buttonBack');
    if (buttonBack) {
        buttonBack.addEventListener('click', function() {
            const popup = Popup.getInstance();
            chrome.runtime.sendMessage({ action: "goBack" }, function() {
                popup.updatePreviewAsync(popup.url);
            });
        });
    }
    const pauseResume = document.getElementById('buttonPause') || document.getElementById('buttonResume');
    if (pauseResume) {
        const action = pauseResume.id === 'buttonPause' ? 'pause' : 'resume';
        pauseResume.addEventListener('click', function() {
            chrome.runtime.sendMessage({ action: action }, () => {
                chrome.runtime.sendMessage({ action: 'updateProgress' });
            });
        });
    }
    const clearQueue = document.getElementById('buttonClearQueue');
    if (clearQueue) {
        clearQueue.addEventListener('click', function() {
            chrome.runtime.sendMessage({ action: "clearQueue" }, function() {
                clearQueue.remove();
            });
        });
    }
}

// ---- retry of failed galleries --------------------------------------------
// The pipelines report WHICH galleries failed (id + name + reason) together
// with the job settings they ran under (retryJob), and the worker remembers
// them for the session. The popup re-sends exactly those galleries: same
// format / template / master folder, one file per title, failed ids forced
// past the history guard (see utils/failedGalleries.ts).

function pendingFromMessage(failed: FailedGallery[], retryJob: any): PendingFailure[] {
    return failed.map((entry) => ({
        id: String(entry.id),
        name: String(entry.name || entry.id),
        error: String(entry.error || ""),
        retryJob: retryJob && typeof retryJob === "object" ? retryJob : null,
        at: Date.now()
    }));
}

// Send the retry command(s) for these failures. Several commands (different
// job settings) are queued by the worker one after the other.
export async function retryFailedGalleries(entries: PendingFailure[]): Promise<void> {
    const tabId = await getActiveTabId();
    const messages = groupRetryMessages(entries, tabId);
    if (messages.length === 0) {
        return;
    }
    const names = entries.map((entry) => entry.name);
    document.getElementById('action')!.innerHTML = "Retrying " + entries.length + " gallery" + (entries.length === 1 ? "" : "ies") + ": " + escapeHtml(names.join(", "));
    let index = 0;
    const sendNext = () => {
        if (index >= messages.length) {
            return;
        }
        const notice = document.getElementById('failedNotice');
        if (notice) {
            // The retry is in progress; the list comes back (minus whatever
            // succeeded) with the summary.
            notice.hidden = true;
        }
        const payload = messages[index++];
        chrome.runtime.sendMessage(payload, (response: any) => {
            try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
            if (response && response.result === "queued") {
                document.getElementById('action')!.innerHTML = "Retry queued at position " + response.position + ".";
            } else if (!response || response.result !== "error") {
                Popup.getInstance().updateProgress(0, names.join(", "), false);
            }
            sendNext();
        });
    };
    sendNext();
}

function wireRetryButton(entries: PendingFailure[]) {
    const button = document.getElementById('buttonRetryFailed') as HTMLInputElement | null;
    if (!button) return;
    button.addEventListener('click', function() {
        button.disabled = true;
        retryFailedGalleries(entries);
    });
}

function wireBackButton() {
    const buttonBack = document.getElementById('buttonBack');
    if (buttonBack) {
        buttonBack.addEventListener('click', function() {
            let popup = Popup.getInstance();
            chrome.runtime.sendMessage({ action: "goBack" }, function() {
                popup.updatePreviewAsync(popup.url);
                // Leaving the summary: keep the failed titles visible above
                // the preview until the user retries or dismisses them.
                refreshFailedNotice();
            });
        });
    }
}

// Failed galleries remembered by the worker for this session. Shown above the
// normal preview until the user retries or dismisses them, so closing the
// popup during a batch no longer loses track of what did not download.
export function refreshFailedNotice(): void {
    const notice = document.getElementById('failedNotice');
    if (!notice) {
        return;
    }
    try {
        chrome.runtime.sendMessage({ action: "getFailedGalleries" }, (response: any) => {
            try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
            const failed: PendingFailure[] = response && response.result === "success" && Array.isArray(response.failed) ? response.failed : [];
            if (failed.length === 0) {
                notice.hidden = true;
                notice.innerHTML = "";
                return;
            }
            notice.innerHTML = message.failedNotice(failed);
            notice.hidden = false;
            const retryButton = document.getElementById('buttonRetryPending') as HTMLInputElement | null;
            if (retryButton) {
                retryButton.addEventListener('click', function() {
                    retryButton.disabled = true;
                    notice.hidden = true;
                    retryFailedGalleries(failed);
                });
            }
            const dismissButton = document.getElementById('buttonDismissFailed');
            if (dismissButton) {
                dismissButton.addEventListener('click', function() {
                    notice.hidden = true;
                    chrome.runtime.sendMessage({ action: "forgetFailedGalleries" }, () => {
                        try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                    });
                });
            }
        });
    } catch (_) { /* worker unreachable: no notice */ }
}

// Add message listener for progress updates and error messages
// NOTE: This listener is fire-and-forget — it never calls sendResponse, so it
// must return false. Returning true kept the message channel open and made
// Chrome log "A listener indicated an asynchronous response by returning true,
// but the message channel closed before a response was received" for every
// progress tick, with offscreen.html as the sender.
chrome.runtime.onMessage.addListener(function(request) {
    if (request.action === "updateProgress") {
        Popup.getInstance().updateProgress(request.progress, request.doujinshiName, request.isZipping, request.retry, request.queued, request.paused);
    } else if (request.action === "downloadError") {
        // Label the failure kind (metadata / Cloudflare / image / archive /
        // cancellation), NAME the gallery when the pipeline told us which one
        // failed, and offer a retry when it can be re-added.
        const failed: FailedGallery[] = request.galleryId !== undefined && request.galleryId !== null && request.galleryId !== ""
            ? [{ id: String(request.galleryId), name: String(request.galleryName || request.galleryId), error: String(request.error) }]
            : [];
        const retryable = failed.length > 0;
        document.getElementById('action')!.innerHTML = message.downloadError(String(request.error), request.galleryName, retryable);
        setTimeout(() => {
            if (retryable) {
                wireRetryButton(pendingFromMessage(failed, request.retryJob));
            }
            // Go Back is always rendered (item 29); wire it even when the
            // error is not retryable so the popup is never a dead-end.
            wireBackButton();
        }, 0);
        if (retryable) {
            // The worker is remembering this failure at the same time; refresh
            // the session list once it has had a moment to land.
            setTimeout(refreshFailedNotice, 500);
        }
    } else if (request.action === "batchProgress") {
        // Per-gallery progress while a batch download is running
        document.getElementById('action')!.innerHTML = message.batchProgress(
            request.current, request.total, request.galleryName, request.stage || "Downloading", request.queued || 0);
        setTimeout(wireActiveJobControls, 0);
    } else if (request.action === "batchSummary") {
        // End-of-batch success/failure summary (skipped = already-downloaded
        // galleries the persistent history guard dropped). Failed galleries
        // are listed by name with a "Retry failed" button.
        const failed: FailedGallery[] = Array.isArray(request.failedGalleries) ? request.failedGalleries : [];
        const retryable = failed.length > 0;
        document.getElementById('action')!.innerHTML = message.batchSummary(
            request.succeeded, request.failed, request.total, request.failedKinds, request.skipped, failed, retryable);
        setTimeout(() => {
            wireBackButton();
            if (retryable) {
                wireRetryButton(pendingFromMessage(failed, request.retryJob));
            }
        }, 0);
        // A retry that succeeded drops titles from the session list; a new
        // failure adds to it. Either way the notice above the preview must
        // follow (after the worker's bookkeeping had a moment to land).
        setTimeout(refreshFailedNotice, 500);
    }
    return false;
});

export default class Popup
{
    //#region "singleton"
    static getInstance(): Popup {
        if (Popup.#instance === null) {
            Popup.#instance = new Popup();
        }
        return Popup.#instance;
    }

    static #instance: Popup | null = null
    //#endregion "singleton"

    // Update progress bar on the preview popup
    updateProgress(progress: number, doujinshiName: string, isZipping: boolean, retry?: string, queued: number = 0, paused: boolean = false) {
        if (isZipping && progress == 100) { // File is being downloaded
            document.getElementById('action')!.innerHTML = message.downloadDone();
            // Add event listener after updating the HTML content
            setTimeout(() => {
                const buttonBack = document.getElementById('buttonBack');
                if (buttonBack) {
                    buttonBack.addEventListener('click', function() {
                        let popup = Popup.getInstance();
                        // Use message passing instead of direct background page access for Firefox private mode compatibility
                        chrome.runtime.sendMessage({ action: "goBack" }, function() {
                            popup.updatePreviewAsync(popup.url);
                        });
                    });
                }
            }, 0);
        } else { // Download in progress
            document.getElementById('action')!.innerHTML = message.downloadProgress(isZipping ? "Zipping" : "Downloading", doujinshiName, progress, retry, queued, paused);
            // Add event listeners after updating the HTML content
            setTimeout(() => {
                const buttonBack = document.getElementById('buttonBack');
                if (buttonBack) {
                    buttonBack.addEventListener('click', function() {
                        let popup = Popup.getInstance();
                        // Use message passing instead of direct background page access for Firefox private mode compatibility
                        chrome.runtime.sendMessage({ action: "goBack" }, function() {
                            popup.updatePreviewAsync(popup.url);
                        });
                    });
                }
                const clearQueue = document.getElementById('buttonClearQueue');
                if (clearQueue) {
                    clearQueue.addEventListener('click', function() {
                        chrome.runtime.sendMessage({ action: "clearQueue" }, function() {
                            clearQueue.remove();
                        });
                    });
                }
            }, 0);
            setTimeout(wireActiveJobControls, 0);
        }
    }

    //#region "API key gate"
    // First-run gate between the two modes. Shown only when no key is stored
    // and the user has not previously chosen "Continue without API key".
    // Submitting a key enters API key mode; skipping remembers the decision
    // and continues in open-tab mode. Either way the preview then renders.
    async ensureApiGateThen(continueFn: () => void): Promise<void> {
        let state;
        try {
            state = await getApiModeState();
        } catch (_) {
            continueFn();
            return;
        }
        const decision = decideGate(state);
        if (decision !== "gate") {
            continueFn();
            return;
        }
        document.getElementById('action')!.innerHTML = message.apiKeyGate();
        setTimeout(() => {
            // Some browsers offer no right-click menu on extension pages, so
            // intercept paste explicitly: fill the box from the clipboard text.
            const gateInput = document.getElementById('apiKeyInput') as HTMLInputElement | null;
            if (gateInput) {
                gateInput.addEventListener('paste', function(event: ClipboardEvent) {
                    const data = event.clipboardData ? event.clipboardData.getData('text') : '';
                    if (data && data.trim().length > 0) {
                        event.preventDefault();
                        gateInput.value = data.trim();
                    }
                });
            }
            const submitButton = document.getElementById('apiKeySubmit');
            if (submitButton) {
                submitButton.addEventListener('click', async function() {
                    const input = document.getElementById('apiKeyInput') as HTMLInputElement;
                    const value = input ? input.value.trim() : "";
                    if (value.length === 0) {
                        const errorBox = document.getElementById('apiKeyGateError');
                        if (errorBox) {
                            errorBox.innerHTML = message.apiKeyGateEmptyError();
                        }
                        return;
                    }
                    await saveApiKey(value);
                    continueFn();
                });
            }
            const skipButton = document.getElementById('apiKeySkip');
            if (skipButton) {
                skipButton.addEventListener('click', async function() {
                    await skipApiKeyGate();
                    continueFn();
                });
            }
        }, 0);
    }
    //#endregion

    // #region "single download"
    async updatePreviewAsync(newUrl: string) {
        let self = Popup.getInstance();
        self.url = newUrl;
        const source = getSourceForUrl(self.url);
        const galleryId = source ? source.getGalleryId(self.url) : null;
        if (galleryId !== null) {
            await self.#doujinshiPreviewAsync(galleryId);
        } else if (source !== null) {
            executeActiveTabScript("js/getGalleries.js");
        } else {
            document.getElementById('action')!.innerHTML =  message.invalidPage();
        }
    }

    // Display popup for a doujinshi
    async #doujinshiPreviewAsync(id: string) {
        let json: any | null = null;
        let status = 0;
        let statusText = "";

        // API key mode: the official keyed API is the PRIMARY metadata route
        // (higher limits, independent of the tab's session). Keyless mode and
        // any keyed failure keep the original order below.
        const modeState = await getApiModeState();
        let keyedRejected = false;
        if (modeState.mode === "keyed") {
            try {
                const keyedParsing = new ApiParsing();
                const keyedResp = await fetchNhentaiApi(keyedParsing.GetUrl(id), { cache: "no-store" }, modeState.apiKey);
                status = keyedResp.status;
                statusText = keyedResp.statusText;
                if (keyedResp.ok) {
                    json = await keyedParsing.GetJsonAsync(keyedResp);
                } else if (keyedResp.status === 401) {
                    keyedRejected = true;
                }
            } catch (error) {
                statusText = errorMessage(error);
            }
        }

        // Read the open gallery tab. Extension-origin fetches to the gallery
        // API are what Cloudflare 403s; the rendered page already carries its
        // metadata once any challenge is done.
        if (json === null) {
            json = await getGalleryFromActiveTab(id);
        }

        if (json === null) {
            try {
                const resp = await fetch(this.parsing!.GetUrl(id), {
                    credentials: "include",
                    cache: "no-store",
                    headers: await getOptionalApiHeaders()
                });
                status = resp.status;
                statusText = resp.statusText;
                if (resp.ok) {
                    json = await this.parsing!.GetJsonAsync(resp);
                }
            } catch (error) {
                statusText = errorMessage(error);
            }
        }
        if (json === null) {
            let html = status === 404
                ? message.errorOther(status, statusText)
                : message.cloudflareMetadata();
            if (keyedRejected) {
                html += '<br/><small>Your API key was rejected (HTTP 401). Check it in the extension options, or clear it there to use open-tab mode only.</small>';
            }
            document.getElementById('action')!.innerHTML = html;
            return;
        }

        let self = this;
        chrome.storage.sync.get({
                useZip: "zip",
                downloadName: "{pretty}",
                replaceSpaces: true
            }, async function(elems) {
                let extension = "";
                if (elems.useZip == "zip")
                    extension = ".zip";
                else if (elems.useZip == "cbz")
                    extension = ".cbz";
                else if (elems.useZip == "pdf" || elems.useZip == "folder")
                    // "folder" is the retired format; PDF replaced it.
                    extension = ".pdf";

                let title = utils.getDownloadName(elems.downloadName, json.title.pretty === "" ?
                    json.title.english.replace(/\[[^\]]+\]/g, '').replace(/\([^\)]+\)/g, '') : json.title.pretty,
                    json.title.english, json.title.japanese, id, json.tags);
                // Persistent history (chrome.storage.local): tell the user this
                // gallery was already downloaded. A single-title click is an
                // explicit request, so it is NOT auto-blocked — the button
                // becomes "Download again" instead.
                let alreadyNote: string = "";
                try {
                    const history: DownloadHistory = await readHistory();
                    const rec = history[id];
                    if (rec) {
                        alreadyNote = escapeHtml(rec.filename) + (rec.when ? " (" + new Date(rec.when).toLocaleDateString() + ")" : "");
                    }
                } catch (_) { /* history is cosmetic; never block the preview */ }
                document.getElementById('action')!.innerHTML = message.apiModeBadge(modeState.mode === "keyed") + message.downloadInfo(escapeHtml(title), json.images.pages.length, extension, elems.useZip, alreadyNote);
                (document.getElementById('path') as HTMLInputElement).value = utils.cleanName(title, elems.replaceSpaces, id);

                // Add event listeners after updating the HTML content.
                setTimeout(() => {
                    const selectedFormat = () => {
                        const value = (document.getElementById('downloadFormat') as HTMLSelectElement | null)?.value;
                        return value === 'cbz' || value === 'pdf' || value === 'raw' ? value : 'zip';
                    };
                    const button = document.getElementById('button');
                    if (button) {
                        button.addEventListener('click', async function() {
                            const tabId = await getActiveTabId();
                            chrome.runtime.sendMessage({
                                action: "downloadDoujinshi",
                                json: json,
                                path: (document.getElementById('path') as HTMLInputElement).value,
                                name: title,
                                tabId: tabId,
                                formatOverride: selectedFormat()
                            }, (response) => {
                                if (response && response.result === "queued") {
                                    document.getElementById('action')!.innerHTML =
                                        "Download queued at position " + response.position + ".";
                                    return;
                                }
                                self.updateProgress(0, title, false);
                            });
                        });
                    }

                    // Right column: the similar-galleries panel. The related
                    // list loads on request; the user then picks which titles
                    // to download and every selection becomes its own archive.
                    const similarPanel = document.getElementById('similarPanel');
                    const loadSimilar = document.getElementById('buttonLoadSimilar');
                    if (similarPanel && loadSimilar) {
                        // The fetched entries back the checkbox list so the
                        // download message carries real titles, not DOM text.
                        let relatedEntries: Array<{ id: string; title: string; pages: number }> = [];
                        const updateSelectedCount = () => {
                            const downloadButton = document.getElementById('buttonSimilar') as HTMLInputElement | null;
                            if (!downloadButton) return;
                            const checked = similarPanel.querySelectorAll<HTMLInputElement>('input.similarItem:checked');
                            downloadButton.value = "Download selected (" + checked.length + ")";
                            downloadButton.disabled = checked.length === 0;
                        };
                        const downloadSelected = async () => {
                            const downloadButton = document.getElementById('buttonSimilar') as HTMLInputElement | null;
                            if (downloadButton) downloadButton.disabled = true;
                            const selected: Record<string, string> = {};
                            similarPanel.querySelectorAll<HTMLInputElement>('input.similarItem:checked').forEach((box) => {
                                const entry = relatedEntries.find((candidate) => candidate.id === box.dataset.id);
                                selected[box.dataset.id || ""] = entry ? entry.title : String(box.dataset.id);
                            });
                            if (Object.keys(selected).length === 0) {
                                updateSelectedCount();
                                return;
                            }
                            const tabId = await getActiveTabId();
                            const finalName = utils.cleanName(title + " - similar", elems.replaceSpaces, id);
                            chrome.runtime.sendMessage({
                                action: "downloadAllDoujinshis",
                                allDoujinshis: selected,
                                galleryMetadata: {},
                                finalName: finalName,
                                tabId: tabId,
                                formatOverride: selectedFormat(),
                                separate: true
                            }, (response: any) => {
                                if (response && response.result === "queued") {
                                    document.getElementById('action')!.innerHTML =
                                        "Similar-gallery download queued at position " + response.position + ".";
                                    return;
                                }
                                self.updateProgress(0, finalName, false);
                            });
                        };
                        const wireSimilarControls = () => {
                            const all = document.getElementById('buttonSimilarAll');
                            const none = document.getElementById('buttonSimilarNone');
                            const downloadButton = document.getElementById('buttonSimilar');
                            if (all) all.addEventListener('click', () => {
                                similarPanel.querySelectorAll<HTMLInputElement>('input.similarItem').forEach((box) => { box.checked = true; });
                                updateSelectedCount();
                            });
                            if (none) none.addEventListener('click', () => {
                                similarPanel.querySelectorAll<HTMLInputElement>('input.similarItem').forEach((box) => { box.checked = false; });
                                updateSelectedCount();
                            });
                            if (downloadButton) downloadButton.addEventListener('click', downloadSelected);
                            similarPanel.querySelectorAll<HTMLInputElement>('input.similarItem').forEach((box) => {
                                box.addEventListener('change', updateSelectedCount);
                            });
                            updateSelectedCount();
                        };
                        loadSimilar.addEventListener('click', async () => {
                            loadSimilar.setAttribute("disabled", "disabled");
                            similarPanel.innerHTML = message.similarLoading();
                            try {
                                const related = await getRelatedGalleries(id);
                                if (related.length === 0) {
                                    throw new Error("No related galleries were returned.");
                                }
                                relatedEntries = related;
                                similarPanel.innerHTML = message.similarList(
                                    related.map((entry) => ({
                                        id: entry.id,
                                        title: escapeHtml(entry.title),
                                        pages: entry.pages
                                    })));
                                wireSimilarControls();
                            } catch (error) {
                                similarPanel.innerHTML = message.similarError(
                                    "Could not load similar galleries: " + escapeHtml(String(error && error.message ? error.message : error)));
                            }
                        });
                    }
                }, 0);
            });
    }
    //#endregion "single download"

    //#region "multiple download"
    // Receives structured gallery cards extracted from the live DOM by
    // js/getGalleries.js (id from the card's own cover link, title from the
    // caption inside the same link). No HTML serialization / regex parsing:
    // quotes, entities, markup changes, or duplicate titles cannot break the
    // id <-> title pairing.
    //
    // List mode is no longer a stripped-down cousin of the single-title popup:
    // it offers the same four formats, an explicit separate-files/batch output
    // mode (separate is the default), an optional master folder, and its own
    // filename template. Every download from here goes through exactly the
    // same pipeline as a single-title download, so the two cannot drift.
    async updatePreviewAll(galleries: Array<{ id: string; title: string }>, currentPage: number, maxPage: number, listSettings: ListModeSettings) {
        let self = Popup.getInstance();

        if (galleries.length === 0) {
            document.getElementById('action')!.innerHTML = message.invalidPage();
            return;
        }

        // Persistent download history (chrome.storage.local): rows already
        // downloaded get a badge and their own "Download anyway" override, and
        // the summary line shows the real counts BEFORE any job is committed.
        let history: DownloadHistory = {};
        try {
            history = await readHistory();
        } catch (_) { /* history is cosmetic; listing still renders without it */ }
        // Gallery ids the user explicitly asked to re-download.
        const forceIds = new Set<string>();

        // Working copy of the list-mode settings: every picker writes here and
        // persists to storage, so the choice survives closing the panel.
        let settings: ListModeSettings = listSettings;

        // Fill the mode badge once the storage read finishes (non-blocking).
        getApiModeState().then((state) => {
            const badgeSlot = document.getElementById('modeBadgeSlot');
            if (badgeSlot) {
                badgeSlot.innerHTML = message.apiModeBadge(state.mode === "keyed");
            }
        }).catch(() => { /* badge is cosmetic; never block the list */ });

        // Keep titles in a plain object keyed by gallery ID instead of the DOM
        // name attribute: a title containing quotes or HTML can no longer break
        // the checkbox markup or the download message.
        const titleById: Record<string, string> = {};
        const allIds: Array<string> = [];
        let finalHtml = "";
        for (const card of galleries) {
            let tmpName;
            if (settings.template === "{pretty}") {
                tmpName = card.title.replace(/\[[^\]]+\]/g, "").replace(/\([^\)]+\)/g, "").replace(/\{[^\}]+\}/g, "").trim();
            } else {
                tmpName = card.title.trim();
            }
            titleById[card.id] = tmpName;
            finalHtml += '<input id="' + card.id + '" type="checkbox"/>' + escapeHtml(tmpName) + '<br/>';
            const rec = history[card.id];
            if (rec) {
                finalHtml += '<small class="nhdwAlready" id="done_' + card.id + '">&#10003; Already downloaded: '
                    + escapeHtml(rec.filename)
                    + ' <a href="#" class="nhdwRedl" id="redl_' + card.id + '">Download anyway</a></small><br/>';
            }
            allIds.push(card.id);
        }

        // Default name for the MERGED archive only. Batch is opt-in, so this
        // page-derived name is no longer what most downloads are called: in
        // separate mode every file is named from the list-mode template and
        // the gallery's own metadata.
        let parts = self.url.split('/')
        let name: string;
        if (parts[parts.length - 1] === "" || parts[parts.length - 1].startsWith("?page=")) name = parts[parts.length - 2];
        else name = parts[parts.length - 1];
        name = name.replace("q=", ""); // Artifact when doing a search

        // Add the HTML
        let nbDownload = 0;
        let currPage = currentPage;
        let html = '<span id="modeBadgeSlot"></span><h3>' + allIds.length + ' doujinshi' + (allIds.length > 1 ? 's' : '') + ' found</h3>'
            + '<div class="listGalleries">' + finalHtml + '</div>'
            + '<div id="downloadedSummary" class="nhdwSummary"></div>'
            + '<input type="button" id="invert" value="Invert all"/><input type="button" id="remove" value="Clear all"/>'
            + message.listDownloadOptions(settings)
            + '<input type="button" id="button" value="Download selected"/>';
        if (maxPage > 0 && currPage > 0) {
            nbDownload = maxPage - currPage + 1;
            html += '<br/><input type="button" id="buttonAll" value="Download all (' + nbDownload + ' pages)"/><br/><input type="text" id="downloadInput"/><input type="button" id="buttonHelp" value="?"/>';
        }
        document.getElementById('action')!.innerHTML = html;
        // Merged re-runs of the same listing would reuse one base name; the
        // date stamp (settings.batchNameDate, default on) tells them apart.
        // The worker adds _part2/_part3 on same-day repeats before saving.
        const pathInput = document.getElementById('path') as HTMLInputElement;
        let defaultBatchName = utils.cleanName(name, settings.replaceSpaces);
        if (effectiveOutputMode(settings.format, settings.outputMode) === "batch" && settings.batchNameDate) {
            defaultBatchName = applyBatchDate(defaultBatchName, Date.now());
        }
        pathInput.value = defaultBatchName;
        if (maxPage > 0 && currPage > 0) {
            (document.getElementById('downloadInput') as HTMLInputElement).value = currPage + "-" + maxPage;
            document.getElementById('buttonHelp')!.addEventListener('click', function() {
                alert("Input the pages you want to download for the \"Download all\" feature\nWrite your pages separated by comma ',', you can also write range of number by separating them by a dash '-'\n"
                + "Example: 2,4,6-10 will download the pages 2, 4 and 6 to 10 (included)");
            });
        }

        // ---- list-mode option pickers -------------------------------------
        // The pickers persist immediately (separate keys from the single-title
        // settings) and re-render the parts of the panel that depend on them:
        // the merged-archive name row only makes sense in batch mode, and the
        // filename preview must always show what the next download produces.
        const sampleTitle = galleries.length > 0 ? (titleById[galleries[0].id] || galleries[0].title) : "Sample Title";
        const sampleId = galleries.length > 0 ? galleries[0].id : "123456";

        // ---- already-downloaded counts -------------------------------------
        // Live summary: "N selected · M already downloaded · K will download",
        // shown BEFORE the job is committed; the download button carries the
        // real count. Batch/merged mode does NOT skip anything (the merged
        // file must contain every selected title), so the wording explains it.
        const refreshDownloadSummary = () => {
            const selectedIds = allIds.filter((id) => {
                const box = document.getElementById(id) as HTMLInputElement | null;
                return !!(box && box.checked);
            });
            const alreadySelected = selectedIds.filter((id) => !!history[id]);
            const skipped = alreadySelected.filter((id) => !forceIds.has(id));
            const summary = document.getElementById('downloadedSummary');
            const mode = effectiveOutputMode(settings.format, settings.outputMode);
            // Merged mode never skips: the one archive needs every selected
            // title, so the button count must be the full selection. Separate
            // mode drops already-downloaded rows (minus overrides).
            const willDownload = mode === "batch" ? selectedIds.length : selectedIds.length - skipped.length;
            if (summary) {
                if (skipped.length > 0) {
                    summary.textContent = mode === "batch"
                        ? selectedIds.length + " selected · " + skipped.length + " already downloaded (merged-file mode re-downloads them into one file)"
                        : selectedIds.length + " selected · " + skipped.length + " already downloaded · " + willDownload + " will download";
                    summary.className = "nhdwSummary nhdwSummaryWarn";
                } else if (selectedIds.length > 0) {
                    summary.textContent = selectedIds.length + " selected";
                    summary.className = "nhdwSummary";
                } else {
                    summary.textContent = "";
                    summary.className = "nhdwSummary";
                }
            }
            const downloadButton = document.getElementById('button') as HTMLInputElement | null;
            if (downloadButton) {
                downloadButton.value = "Download selected (" + willDownload + ")";
                downloadButton.disabled = mode === "batch" ? selectedIds.length === 0 : willDownload === 0;
            }
        };

        const refreshListOptionUi = () => {
            const effective = effectiveOutputMode(settings.format, settings.outputMode);
            const batchRow = document.getElementById('batchNameRow');
            if (batchRow) {
                batchRow.hidden = effective !== "batch";
            }
            const batchExt = document.getElementById('batchExtension');
            if (batchExt) {
                batchExt.textContent = formatExtension(settings.format);
            }
            const rawNote = document.getElementById('listRawNote');
            if (rawNote) {
                rawNote.hidden = settings.format !== "raw";
            }
            const preview = document.getElementById('listNamePreview');
            if (preview) {
                const rendered = utils.getDownloadName(settings.template, sampleTitle, sampleTitle, "", sampleId, []);
                const clean = utils.cleanName(rendered, settings.replaceSpaces, sampleId);
                const folder = settings.masterFolder && settings.masterFolderName !== ""
                    ? settings.masterFolderName + "/"
                    : "";
                preview.textContent = effective === "batch"
                    ? "One merged file: Downloads/" + folder
                        + ((document.getElementById('path') as HTMLInputElement | null)?.value || utils.cleanName(name, settings.replaceSpaces))
                        + formatExtension(settings.format)
                    : (settings.format === "raw"
                        ? "One folder per title: Downloads/" + folder + clean + "/001.jpg"
                        : "One file per title: Downloads/" + folder + clean + formatExtension(settings.format));
            }
            refreshDownloadSummary();
        };

        setTimeout(() => {
            const formatSelect = document.getElementById('listFormat') as HTMLSelectElement | null;
            if (formatSelect) {
                formatSelect.addEventListener('change', () => {
                    settings.format = normalizeFormat(formatSelect.value, settings.format);
                    saveListSettings({ listFormat: settings.format });
                    refreshListOptionUi();
                });
            }
            const outputSelect = document.getElementById('listOutputMode') as HTMLSelectElement | null;
            if (outputSelect) {
                outputSelect.addEventListener('change', () => {
                    settings.outputMode = normalizeOutputMode(outputSelect.value, settings.outputMode);
                    saveListSettings({ listOutputMode: settings.outputMode });
                    refreshListOptionUi();
                });
            }
            const masterBox = document.getElementById('listMasterFolder') as HTMLInputElement | null;
            if (masterBox) {
                masterBox.addEventListener('change', () => {
                    settings.masterFolder = masterBox.checked;
                    saveListSettings({ listMasterFolder: settings.masterFolder });
                    refreshListOptionUi();
                });
            }
            const pathInput = document.getElementById('path') as HTMLInputElement | null;
            if (pathInput) {
                pathInput.addEventListener('input', refreshListOptionUi);
            }
            refreshListOptionUi();
        }, 0);

        // Per-download "download anyway" override: clicking the link on a row
        // that was already downloaded marks it for re-download, keeps its
        // checkbox ticked and updates the counts immediately.
        setTimeout(() => {
            allIds.forEach((id) => {
                const link = document.getElementById('redl_' + id) as HTMLAnchorElement | null;
                if (!link) {
                    return;
                }
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    forceIds.add(id);
                    link.textContent = "will re-download";
                    const box = document.getElementById(id) as HTMLInputElement | null;
                    if (box) {
                        box.checked = true;
                    }
                    chrome.storage.local.get({ allIds: [] }, (elemsLocal) => {
                        chrome.storage.local.set({ allIds: self.#saveIdInLocalStorage(id, elemsLocal.allIds, true) });
                    });
                    executeActiveTabScript("js/updateContent.js");
                    refreshDownloadSummary();
                });
            });
        }, 0);

        // Build the job payload shared by "Download selected" and "Download
        // all (N pages)". Applying the PDF-merge guard here means neither
        // entry point can bypass it.
        const buildJobOptions = async (titleCount: number): Promise<{
            format: DownloadFormat;
            separate: boolean;
            masterFolder: string;
            nameTemplate: string;
        } | null> => {
            let outputMode = effectiveOutputMode(settings.format, settings.outputMode);
            if (shouldWarnPdfMerge(settings.format, outputMode, titleCount) && !settings.pdfMergeWarnDismissed) {
                const answer = await confirmPdfMerge(titleCount);
                if (answer.dismissed) {
                    // Honour "don't warn me again" for the rest of this session
                    // too, not only after the panel is reopened.
                    settings.pdfMergeWarnDismissed = true;
                }
                if (answer.choice === "cancel") {
                    return null;
                }
                if (answer.choice === "separate") {
                    outputMode = "separate";
                    settings.outputMode = "separate";
                    saveListSettings({ listOutputMode: "separate" });
                    const outputSelect = document.getElementById('listOutputMode') as HTMLSelectElement | null;
                    if (outputSelect) {
                        outputSelect.value = "separate";
                    }
                    refreshListOptionUi();
                }
            }
            return {
                format: settings.format,
                separate: outputModeToSeparate(settings.format, outputMode),
                masterFolder: resolveMasterFolder(settings),
                nameTemplate: settings.template
            };
        };

        // Send a list job, handling the merged "you already have this file"
        // answer: the worker refuses to start, the UI warns, then re-sends with
        // existingConfirmed (user chose warn-only for merged re-runs).
        const sendListJob = (message: any) => {
            try {
                chrome.runtime.sendMessage(message, (response: any) => {
                    try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                    if (response && response.result === "existing" && response.filename) {
                        const again = window.confirm(
                            "You already have:\n" + response.filename +
                            "\n\nThis download creates a NEW copy (the name gets _part2, _part3 ...).\n\nContinue?");
                        if (again) {
                            message.existingConfirmed = true;
                            chrome.runtime.sendMessage(message, () => {
                                try { void (chrome.runtime && chrome.runtime.lastError); } catch (_) { /* no runtime */ }
                            });
                        }
                        return;
                    }
                    self.updateProgress(0, message.finalName, false);
                });
            } catch (_) { /* worker unreachable */ }
        };

        // Invert all checkbox - add event listener after updating the HTML content
        setTimeout(() => {
            const invertButton = document.getElementById('invert');
            if (invertButton) {
                invertButton.addEventListener('click', function() {
                    let storageAllIds;
                    chrome.storage.local.get({
                        allIds: []
                    }, function(elemsLocal) {
                        // Iterate on all checkboxs and reverse the value
                        storageAllIds = elemsLocal.allIds;
                        for (let i = 0; i < allIds.length; i++) {
                            let id = allIds[i];
                            let elem = (document.getElementById(id) as HTMLInputElement);
                            elem.checked = !elem.checked;
                            storageAllIds = self.#saveIdInLocalStorage(id, storageAllIds, elem.checked);
                        }
                        chrome.storage.local.set({
                            allIds: storageAllIds
                        });
                        executeActiveTabScript("js/updateContent.js");
                        refreshDownloadSummary();
                    });
                });
            }
        }, 0);

        // Clear all checkboxs - add event listener after updating the HTML content
        setTimeout(() => {
            const removeButton = document.getElementById('remove');
            if (removeButton) {
                removeButton.addEventListener('click', function() {
                    // Just uncheck everything and empty local storage
                    allIds.forEach(function(id) {
                        (document.getElementById(id) as HTMLInputElement).checked = false;
                    });
                    chrome.storage.local.set({
                        allIds: []
                    });
                    executeActiveTabScript("js/updateContent.js");
                    refreshDownloadSummary();
                });
            }
        }, 0);

        // Download button - add event listener after updating the HTML content
        setTimeout(() => {
            const downloadButton = document.getElementById('button');
            if (downloadButton) {
                downloadButton.addEventListener('click', async function() {
                    let allDoujinshis : Record<string, string> = {};
                    allIds.forEach(function(id) {
                        let elem = document.getElementById(id) as HTMLInputElement;
                        if (elem && elem.checked) {
                            allDoujinshis[id] = titleById[id];
                        }
                    });
                    // Hop off the already-downloaded galleries (separate mode),
                    // keeping the per-row "Download anyway" picks — so the
                    // skipped ones cost ZERO metadata/API calls. Merged mode
                    // keeps every title (one file needs them all).
                    if (effectiveOutputMode(settings.format, settings.outputMode) === "separate") {
                        const toDownload = partitionKnown(history, Object.keys(allDoujinshis), Array.from(forceIds)).download;
                        const filtered: Record<string, string> = {};
                        for (const id of toDownload) {
                            filtered[id] = allDoujinshis[id];
                        }
                        allDoujinshis = filtered;
                    }
                    if (Object.keys(allDoujinshis).length > 0) { // There is at least one element selected, we launch download
                        const pathElement = document.getElementById('path') as HTMLInputElement;
                        if (pathElement) {
                            const job = await buildJobOptions(Object.keys(allDoujinshis).length);
                            if (job === null) {
                                return; // user cancelled the PDF-merge warning
                            }
                            let finalName = pathElement.value;
                            document.getElementById('action')!.innerHTML = "Resolving selected galleries...";
                            const tabId = await getActiveTabId();
                            const selectedIds = Object.keys(allDoujinshis);
                            const galleryMetadata = await resolveSelectedGalleries(selectedIds, tabId);
                            if (Object.keys(galleryMetadata).length === 0) {
                                document.getElementById('action')!.innerHTML =
                                    "Could not read gallery metadata from this tab. Keep the NHentai page open after completing any browser verification, then try again.";
                                return;
                            }
                            // Use message passing instead of direct background page access for Firefox private mode compatibility
                            sendListJob({
                                action: "downloadAllDoujinshis",
                                allDoujinshis: allDoujinshis,
                                galleryMetadata: galleryMetadata,
                                finalName: finalName,
                                tabId: tabId,
                                formatOverride: job.format,
                                separate: job.separate,
                                masterFolder: job.masterFolder,
                                nameTemplate: job.nameTemplate,
                                redownloadIds: Array.from(forceIds)
                            });
                        }
                    } else {
                        document.getElementById('action')!.innerHTML = "Every selected gallery is already downloaded. Click <i>Download anyway</i> on a row to re-download it (or Clear history in Settings).";
                    }
                });
            }
        }, 0);

        if (nbDownload > 0) {
            // User input saying how many pages he wants to download - add event listener after updating the HTML content
            setTimeout(() => {
                const downloadInput = document.getElementById('downloadInput');
                if (downloadInput) {
                    downloadInput.addEventListener('change', function() {
                        let pages = self.#parseDownloadAll(maxPage);
                        if (pages.length !== 0) {
                            const buttonAll = document.getElementById("buttonAll") as HTMLInputElement;
                            if (buttonAll) {
                                buttonAll.value = 'Download all (' + pages.length + ' pages)';
                            }
                        }
                    });
                }
            }, 0);

            // Download many pages at once - add event listener after updating the HTML content
            setTimeout(() => {
                const buttonAll = document.getElementById('buttonAll');
                if (buttonAll) {
                    buttonAll.addEventListener('click', async function() {
                        let allDoujinshis : Record<string, string> = {};
                        allIds.forEach(function(id) {
                            let elem = (document.getElementById(id) as HTMLInputElement);
                            if (elem) {
                                allDoujinshis[id] = titleById[id];
                            }
                        });
                        // Separate mode: don't resolve already-downloaded ids on
                        // THIS page (zero API calls; later pages are guarded by
                        // the pipeline using the same recorded set). Merged mode
                        // keeps every title.
                        if (effectiveOutputMode(settings.format, settings.outputMode) === "separate") {
                            const toDownload = partitionKnown(history, Object.keys(allDoujinshis), Array.from(forceIds)).download;
                            const filtered: Record<string, string> = {};
                            for (const id of toDownload) {
                                filtered[id] = allDoujinshis[id];
                            }
                            allDoujinshis = filtered;
                        }
                        let pages = self.#parseDownloadAll(maxPage);
                        if (typeof pages === "string") {
                            alert(pages);
                            const downloadInput = document.getElementById('downloadInput') as HTMLInputElement;
                            if (downloadInput) {
                                downloadInput.value = currPage + "-" + nbDownload;
                            }
                        } else {
                            // The large-batch count warning stays exactly as it
                            // was; the PDF-merge warning is independent and is
                            // shown after it (they can stack).
                            let choice = confirm("You are going to download " + pages.length + " pages of doujinshi. Are you sure you want to continue?");
                            if (choice) {
                                const pathElement = document.getElementById('path') as HTMLInputElement;
                                if (pathElement) {
                                    // A whole-listing walk always covers more
                                    // than one title, so the merge guard uses
                                    // the page count as the lower bound.
                                    const job = await buildJobOptions(Math.max(2, Object.keys(allDoujinshis).length));
                                    if (job === null) {
                                        return; // user cancelled the PDF-merge warning
                                    }
                                    let finalName = pathElement.value;
                                    document.getElementById('action')!.innerHTML = "Resolving selected galleries...";
                                    const tabId = await getActiveTabId();
                                    const selectedIds = Object.keys(allDoujinshis);
                                    // Every card on THIS page may already be
                                    // downloaded and skipped, yet other pages
                                    // still have work: the page walk re-parses
                                    // each page itself, so empty metadata here
                                    // is fine (nothing to resolve).
                                    let galleryMetadata: Record<string, any> = {};
                                    if (selectedIds.length > 0) {
                                        galleryMetadata = await resolveSelectedGalleries(selectedIds, tabId);
                                        if (Object.keys(galleryMetadata).length === 0) {
                                            document.getElementById('action')!.innerHTML =
                                                "Could not read gallery metadata from this tab. Keep the NHentai page open after completing any browser verification, then try again.";
                                            return;
                                        }
                                    }
                                    // Use message passing instead of direct background page access for Firefox private mode compatibility
                                    sendListJob({
                                        action: "downloadAllPages",
                                        allDoujinshis: allDoujinshis,
                                        galleryMetadata: galleryMetadata,
                                        pages: pages,
                                        finalName: finalName,
                                        url: self.url,
                                        tabId: tabId,
                                        formatOverride: job.format,
                                        separate: job.separate,
                                        masterFolder: job.masterFolder,
                                        nameTemplate: job.nameTemplate,
                                        redownloadIds: Array.from(forceIds)
                                    });
                                }
                            }
                        }
                    });
                }
            }, 0);
        }

        // We listen to all checkboxs on the page - add event listeners after updating the HTML content
        setTimeout(() => {
            allIds.forEach(function(id) {
                const checkbox = document.getElementById(id) as HTMLInputElement;
                if (checkbox) {
                    checkbox.addEventListener('change', function() {
                        let checked = this.checked;
                        chrome.storage.local.get({
                            allIds: []
                        }, function(elemsLocal) { // Add the ids in local storage so we can easily find them back from anywhere (even if page is reloaded etc)
                            chrome.storage.local.set({
                                allIds: self.#saveIdInLocalStorage(id, elemsLocal.allIds, checked)
                            });
                        });
                        executeActiveTabScript("js/updateContent.js");
                        refreshDownloadSummary();
                    });

                    chrome.storage.local.get({
                        allIds: []
                    }, function(elemsLocal) {
                        if (elemsLocal.allIds.includes(id)) {
                            checkbox.checked = true;
                        }
                    });
                }
            });
        }, 0);
    }

    #saveIdInLocalStorage(id: string, allIds: Array<string>, checked: boolean) {
        if (checked) {
            allIds.push(id);
        } else {
            let index = allIds.indexOf(id);
            if (index !== -1) {
                allIds.splice(index, 1);
            }
        }
        return allIds;
    }

    #parseDownloadAll(maxPage: number) : Array<number> | string {
        let pages: Array<number> = []
        let pageText = (document.getElementById('downloadInput') as HTMLInputElement).value;
        pageText.split(',').forEach(function(e: string) {
            let elem = e.trim();
            let dash = elem.split('-');
            if (dash.length > 1) { // There is a dash in the number (ex: 1-5)
                let lower = dash[0].trim();
                let upper = dash[1].trim();
                let lowerNb = parseInt(lower);
                let upperNb = parseInt(upper);
                if (lower !== '' + lowerNb || upper !== '' + upperNb) {
                    return message.invalidSyntax();
                }
                if (lowerNb < 0 || upperNb < 0 || lowerNb > maxPage || upperNb > maxPage) {
                    return message.invalidPageNumber(maxPage);
                }
                if (upperNb <= lowerNb) {
                    return message.invalidBounds();
                }
                for (let i = lowerNb; i <= upperNb; i++) {
                    if (!pages.includes(i)) pages.push(i);
                }
            }
            else
            {
                let pageNb = parseInt(elem);
                if (elem !== '' + pageNb) {
                    return message.invalidSyntax();
                }
                if (pageNb < 0 || pageNb > maxPage) {
                    return message.invalidPageNumber(maxPage);
                }
                if (!pages.includes(pageNb)) pages.push(pageNb);
            }
        });
        return pages;
    }
    //#endregion "multiple download"

    url: string;
    parsing: AParsing | null = null
}
