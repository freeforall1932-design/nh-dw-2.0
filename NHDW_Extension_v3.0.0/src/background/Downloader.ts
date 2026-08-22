var JSZip = require("jszip");
import { GallerySource, clearnetSource } from "../sources/GallerySource";
import { decodeTabImageBytes, fetchImageFromTab } from "./tabImageFetch";

export default class Downloader
{
    constructor(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string, zip: typeof JSZip, downloadName: string | null, signal: AbortSignal | null = null, source: GallerySource = clearnetSource, settings: { useZip?: string; maxConcurrentDownloads?: number | string } = {})
    {
        this.progressCallback = progressCallback;
        this.#errorCallback = errorCallback;
        this.currentProgress = 0;
        this.#doujinshiName = name;
        this.path = path;
        this.#zip = zip;
        this.downloadName = downloadName;
        this.#abortSignal = signal;
        this.#source = source;
        this.#settings = settings;

        // @ts-ignore
        if (typeof browser !== "undefined") { // Firefox
            this.#json = JSON.parse(JSON.stringify(jsonTmp));
        } else {
            this.#json = jsonTmp;
        }

        this.#mediaId = this.#json.media_id;
    }

    isPaused: boolean = false;
    #resumePaused: (() => void) | null = null;

    pause() { this.isPaused = true; }
    resume() {
        this.isPaused = false;
        if (this.#resumePaused) { this.#resumePaused(); this.#resumePaused = null; }
    }
    async #waitIfPaused() {
        while (this.isPaused && !this.#isAborted()) {
            await new Promise<void>((resolve) => { this.#resumePaused = resolve; });
        }
    }

    updateProgress(progress: number, name: string | null, isZipping: boolean, retry: string | null = null) {
        try {
            this.progressCallback(progress, name, isZipping, retry);
        } catch (e) { } // Dead object
        this.#progressPercent = progress;
        this.#progressName = name;
        this.#progressZipping = isZipping;
        this.#progressRetry = retry;
    }

    updateProgressLatest(updateCallback: Function) {
        this.progressCallback = updateCallback;
        this.progressCallback(this.#progressPercent, this.#progressName, this.#progressZipping, this.#progressRetry);
    }

    async startAsync() {
        let self = this;
        const applySettings = (useZipRaw: string, maxConcurrentDownloads: number | string) => {
            // Whitelist: a corrupt or legacy value (or undefined from a broken
            // storage read) must fall back to "zip" — an unknown value would
            // otherwise be fetched into the ZIP but never saved (the final
            // step only archives for zip/cbz), silently "succeeding".
            self.useZip = (useZipRaw === "zip" || useZipRaw === "cbz" || useZipRaw === "folder" || useZipRaw === "raw")
                ? useZipRaw
                : "zip";
            const configuredConcurrency = parseInt(maxConcurrentDownloads as any, 10);
            // Protect the batching loop from corrupt/old sync settings.
            self.maxConcurrentDownloads = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
                ? configuredConcurrency
                : 3;
            if (self.useZip === "raw") {
                self.currentProgress = 100;
                try {
                    self.updateProgress(100, self.#doujinshiName, false);
                } catch (e) { } // Dead object
            }
            // Folder mode never assembles an archive, so it must not create
            // (or fill) the zip folder either.
            if (self.useZip === "zip" || self.useZip === "cbz") {
                self.#zip.folder(self.path);
            }
        };
        // Callers in contexts without chrome.storage (offscreen documents only
        // expose chrome.runtime) pass the options relayed by the service
        // worker; otherwise fall back to reading chrome.storage.sync.
        if (this.#settings && (this.#settings.useZip !== undefined || this.#settings.maxConcurrentDownloads !== undefined)) {
            applySettings(this.#settings.useZip || "zip", this.#settings.maxConcurrentDownloads || "3");
        } else {
            try {
                await new Promise((resolve, _reject) => {
                    resolve(
                        chrome.storage.sync.get({
                            useZip: "zip",
                            maxConcurrentDownloads: "3"
                        }, function (elems) {
                            applySettings(elems.useZip, elems.maxConcurrentDownloads);
                        })
                    );
                });
            } catch (_) {
                // chrome.storage is unavailable in this context; the caller
                // should have relayed settings. Safe defaults keep the job
                // running instead of silently dying before it registers.
                applySettings("zip", "3");
            }
        }
        await self.#downloadAsync();
    }

    async #downloadAsync() {
        try
        {
            // Downloading
            let maxNbOfPage = this.#json.images.pages.length;

            // Use concurrent downloads based on the maxConcurrentDownloads setting
            const downloadPage = async (i: number) => {
                let nbTries = 5;
                while (true) {
                    try {
                        await this.#downloadPageInternalAsync(i, i * 100 / maxNbOfPage);
                        break;
                    } catch (error: any) {
                        // A user cancellation aborts the fetch signal, so the
                        // thrown error is an AbortError (or the signal is simply
                        // marked aborted). Bail out immediately instead of
                        // retrying the aborted request five more times.
                        if (this.#isAborted() || (error && error.name === "AbortError")) {
                            throw "Download was aborted";
                        }
                        if (nbTries > 0) {
                            // Retry warnings help diagnose real downloads, but
                            // deterministic failure fixtures opt out to keep
                            // test output focused on assertion failures.
                            if (!(globalThis as any).__NHDW_SILENT_RETRY_LOGS__) {
                                console.warn("Error while downloading " + this.#doujinshiName + "/" + (i + 1) + ": " + error + ", tries remaining: " + nbTries);
                            }
                            nbTries--;
                            // Surface the retry in the progress UI so the user can
                            // see the download is recovering rather than stuck.
                            this.updateProgress(i * 100 / maxNbOfPage, this.#doujinshiName + "/" + (i + 1), false, "retry " + (5 - nbTries) + "/5");
                            // Exponential backoff: each successive retry waits
                            // longer so the server has time to recover and we
                            // reduce the chance of hitting rate limits.
                            // The first retry waits Ms, the last ~16× Ms.
                            if (this.retryBackoffMs > 0) {
                                const backoffDelay = this.retryBackoffMs * Math.pow(2, 5 - nbTries - 1);
                                await new Promise(r => setTimeout(r, backoffDelay));
                            }
                        } else {
                            throw error;
                        }
                    }
                }
                if (this.#isAborted()) {
                    throw "Download was aborted";
                }
            };

            // Process pages in batches based on maxConcurrentDownloads
            for (let i = 0; i < maxNbOfPage; i += this.maxConcurrentDownloads) {
                await this.#waitIfPaused();
                const downloadPromises = [];

                // Create a batch of download promises
                for (let j = 0; j < this.maxConcurrentDownloads && i + j < maxNbOfPage; j++) {
                    downloadPromises.push(downloadPage(i + j));
                }

                // Wait for all downloads in this batch to complete
                await Promise.all(downloadPromises);

                if (this.#isAborted()) {
                    throw "Download was aborted";
                }
            }

            // For multiple download, we want to skip the "zipping" part
            if (this.downloadName !== null) {
                // Zipping
                if (this.useZip === "zip" || this.useZip === "cbz") {
                    this.updateProgress(0, "in progress...", true);

                    let self = this;
                    await new Promise((resolve, _reject) => {
                        // Use web workers for faster zipping if available
                        const zipOptions = {
                            type: "blob",
                            // Use web workers for better performance if supported
                            streamFiles: false,
                            compression: "DEFLATE",
                            compressionOptions: { level: 5 }, // Balance between speed and compression
                            // In the service worker there is no DOM thread to block, so
                            // parallel workers are used. The offscreen document zips on
                            // its own thread and disables workers so it only needs the
                            // BLOBS offscreen reason.
                            worker: typeof document === "undefined"
                        };

                        resolve(
                            this.#zip.generateAsync(zipOptions, function (elem: any) {
                                try {
                                    self.updateProgress(elem.percent, elem.currentFile == null ? self.path : elem.currentFile, true);
                                } catch (e) { } // Dead object
                            })
                                .then(async function (content: any) { // Zipping done
                                    await self.#downloadBlob(content, self.downloadName + "." + self.useZip);
                                    self.currentProgress = 100;
                                    try {
                                        self.updateProgress(100, null, true); // Notify popup that we are done
                                    } catch (e) { } // Dead object
                                })
                        );
                    });
                } else {
                    // "raw" and "folder" never assemble an archive: raw hands
                    // the CDN URLs to the download manager directly, and folder
                    // already saved one file per page while fetching.
                    this.currentProgress = 100;
                    this.updateProgress(100, null, true); // Notify popup that we are done
                }
            }
        }
        catch (error)
        {
            this.currentProgress = 100;
            // A user cancellation is not an error: the popup already reset the
            // UI when the user pressed Cancel, so do not surface "Download was
            // aborted" as if the download had failed.
            if (!this.#isAborted() && !(error && error.name === "AbortError")) {
                this.#errorCallback(error);
            }
            throw error;
        }
    }

    // True when the user has asked to cancel, either through the legacy
    // isAwaitingAbort flag or (preferred) through an aborted AbortSignal.
    #isAborted(): boolean {
        return this.isAwaitingAbort || (this.#abortSignal !== null && this.#abortSignal.aborted);
    }

    // In a DOM context (the offscreen document) the archive is exposed through
    // a real object URL, which avoids the ~2-3x peak memory of the base64
    // round-trip and lets large galleries download without service-worker OOM.
    // Service workers have no URL.createObjectURL, so there we fall back to a
    // base64 data URL handed to the Downloads API.
    async #urlForBlob(content: Blob): Promise<{ url: string; revoke: (() => void) | null }> {
        if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
            const url = URL.createObjectURL(content);
            return { url: url, revoke: () => URL.revokeObjectURL(url) };
        }
        const bytes = new Uint8Array(await content.arrayBuffer());
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
        }
        const mime = content.type && content.type.length > 0 ? content.type : "application/octet-stream";
        return { url: "data:" + mime + ";base64," + btoa(binary), revoke: null };
    }

    // Hand a URL to the browser's download manager. In the service worker
    // fallback that is chrome.downloads directly; in the offscreen document
    // chrome.downloads is not exposed (only chrome.runtime is), so the caller
    // sets saveUrl to a relay that asks the service worker to download.
    async #saveArtifact(url: string, filename: string): Promise<void> {
        if (this.saveUrl !== null) {
            await this.saveUrl(url, filename);
            return;
        }
        await new Promise<void>((resolve, reject) => {
            chrome.downloads.download({ url: url, filename: filename }, function(downloadId) {
                if (downloadId === undefined) {
                    reject(new Error(String(chrome.runtime.lastError || "Unable to start download")));
                } else {
                    resolve();
                }
            });
        });
    }

    async #downloadBlob(content: Blob, filename: string): Promise<void> {
        const { url, revoke } = await this.#urlForBlob(content);
        try {
            await this.#saveArtifact(url, filename);
        } catch (error) {
            if (revoke !== null) revoke();
            throw error;
        }
        // Keep the object URL alive while Chrome's download manager reads the
        // blob, then release it.
        if (revoke !== null) {
            setTimeout(revoke, this.revokeObjectUrlDelayMs);
        }
    }

    // Number to string but ensure there are always 3 digits
    #getNumberWithZeros(nb: number) {
        if (nb < 10) return '00' + nb;
        else if (nb < 100) return '0' + nb;
        return nb;
    }

    // Download a page
    async #downloadPageInternalAsync(currPage: number, progress: number) {
        let page = this.#json.images.pages[currPage];
        let format;
        switch (page.t)
        {
            case "j":
                format = ".jpg";
                break;
            case "p":
                format = ".png";
                break;
            case "g":
                format = ".gif";
                break;
            case "w":
                format = ".webp";
                break;
            case "0": // Invalid page, probably an issue on NHentai side
                return;
            default:
                throw "Unknown page format " + page.t;
        }
        let filenameParsing = (currPage + 1) + format; // Name for parsing
        this.updateProgress(progress, this.#doujinshiName + "/" + filenameParsing, false);

        let filename = this.#getNumberWithZeros(currPage + 1) + format; // Final file name

        // Try the canonical CDN first, then the numbered mirrors. This is
        // similar to gallery-dl's extractor fallback strategy and avoids making
        // one random mirror failure abort an otherwise valid gallery.
        const imageUrls = this.#source.getImageUrls(String(this.#mediaId), filenameParsing);

        if (this.useZip !== "raw") { // ZIP (or equivalent) format
            let lastStatus = "unknown error";
            for (const imageUrl of imageUrls) {
                const loaded = await this.#loadImage(imageUrl);
                if (loaded.blob) {
                    // A 200 response can still be a Cloudflare challenge page or
                    // an error document. Only accept responses that identify as
                    // images, otherwise try the next mirror so HTML never ends
                    // up inside the ZIP as if it were a page.
                    const contentType = loaded.contentType;
                    if (contentType !== null && !contentType.toLowerCase().startsWith("image/")) {
                        lastStatus = "unexpected content-type \"" + contentType + "\"";
                        continue;
                    }
                    // Reject suspiciously small responses that are unlikely to
                    // be valid images (e.g. a 1x1 pixel placeholder, an empty
                    // error page, or a "blocked" icon). The vast majority of
                    // nhentai pages are well over 1 KB; anything below this
                    // threshold is almost certainly not a real image.
                    if (loaded.blob.size < this.minImageBytes) {
                        lastStatus = "response too small (" + loaded.blob.size + " bytes)";
                        continue;
                    }
                    if (this.useZip === "folder") {
                        // Old-school output: no archive at all — one image
                        // file per page, directly inside the gallery folder in
                        // the browser's download directory (the download
                        // manager creates the subfolder from the filename).
                        const { url, revoke } = await this.#urlForBlob(loaded.blob as Blob);
                        try {
                            await this.#saveArtifact(url, this.path + "/" + filename);
                        } catch (error) {
                            if (revoke !== null) revoke();
                            throw "Failed to save image to " + filename + " (" + error + ").";
                        }
                        if (revoke !== null) {
                            setTimeout(revoke, this.revokeObjectUrlDelayMs);
                        }
                        return;
                    }
                    await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            resolve(this.#zip.file(this.path + '/' + filename, reader.result as null));
                        };
                        reader.onerror = reject;
                        reader.readAsArrayBuffer(loaded.blob as Blob);
                    });
                    return;
                }
                lastStatus = loaded.lastStatus;
            }
            throw this.#imageFetchFailureMessage(lastStatus);
        } else { // We don't need to update progress here because it goes too fast anyway
            // Raw mode cannot inspect the response before Chrome starts the
            // download. Use the canonical original-image URL and report startup
            // errors through the downloads API callback (routed through
            // #saveArtifact so the offscreen document can relay to the worker).
            const imageUrl = imageUrls[0];
            try {
                await this.#saveArtifact(imageUrl, this.path.replace(/[\\:*?"<>|]/g, '') + "-" + filename);
            } catch (error) {
                throw "Failed to download original image (" + error + ").";
            }
        }
    }

    // Try the open gallery tab first (page origin + cookies), then the
    // extension-origin fetch. Tab HTTP errors skip the extension fetch for
    // that URL; CORS / injection failures fall through.
    async #loadImage(imageUrl: string): Promise<{ blob: Blob | null; contentType: string | null; lastStatus: string }> {
        if (this.#isAborted()) {
            throw "Download was aborted";
        }
        if (this.sourceTabId !== null) {
            const fromTab = await fetchImageFromTab(this.sourceTabId, imageUrl);
            if (fromTab && fromTab.ok && fromTab.b64) {
                const bytes = decodeTabImageBytes(fromTab.b64);
                return {
                    blob: new Blob([bytes], { type: fromTab.contentType || "application/octet-stream" }),
                    contentType: fromTab.contentType,
                    lastStatus: ""
                };
            }
            if (fromTab && fromTab.status > 0) {
                return {
                    blob: null,
                    contentType: fromTab.contentType,
                    lastStatus: fromTab.status + ": " + fromTab.statusText
                };
            }
        }
        const resp = await fetch(imageUrl, { credentials: "include", cache: "no-store", signal: this.#abortSignal });
        if (resp.ok) {
            return {
                blob: await resp.blob(),
                contentType: resp.headers.get("content-type"),
                lastStatus: ""
            };
        }
        return {
            blob: null,
            contentType: resp.headers.get("content-type"),
            lastStatus: resp.status + ": " + resp.statusText
        };
    }

    #imageFetchFailureMessage(lastStatus: string): string {
        const blocked = /403|503|unexpected content-type|text\/html/i.test(lastStatus);
        let message = "Failed to fetch original image from all image servers (" + lastStatus + ").";
        if (blocked) {
            message += " Gallery metadata was read; keep the gallery tab open after any browser challenge and try again.";
        }
        return message;
    }

    isDone(): boolean
    {
        return this.currentProgress === 100;
    }

    useZip: string; // How data must be downloaded
    maxConcurrentDownloads: number = 3; // Number of concurrent downloads
    revokeObjectUrlDelayMs: number = 60000; // How long an object URL stays alive after a successful download
    minImageBytes: number = 1024; // Minimum acceptable image response size (bytes)
    retryBackoffMs: number = 200; // Base delay (ms) for exponential backoff between retries (last retry waits ~3.2s)
    #json: any; // JSON containing all data
    #zip: typeof JSZip; // ZIP data that will be downloaded at the end
    #abortSignal: AbortSignal | null; // Cancels in-flight image fetches when the user aborts
    #source: GallerySource;
    downloadName: string | null; // Name of the ZIP, null if should not download
    path: string; // Save path
    progressCallback: Function; // Function to call when progress is made
    #errorCallback: Function; // Function to call if an error occured
    currentProgress: Number; // Current progress of the download
    #doujinshiName: string; // Name of the doujinshi
    #mediaId: number; // Id of the media

    isAwaitingAbort: boolean = false;
    // When set, ZIP image fetches run in this tab's page context first.
    sourceTabId: number | null = null;
    // When set, artifacts (zip blobs, folder-mode images, raw CDN URLs) are
    // saved through this function instead of chrome.downloads. The offscreen
    // document sets it to a relay, because chrome.downloads is not exposed in
    // offscreen documents (only chrome.runtime is).
    saveUrl: ((url: string, filename: string) => Promise<void>) | null = null;
    #settings: { useZip?: string; maxConcurrentDownloads?: number | string };

    // Progress info
    #progressPercent: number;
    #progressName: string | null;
    #progressZipping: boolean;
    #progressRetry: string | null = null;
}