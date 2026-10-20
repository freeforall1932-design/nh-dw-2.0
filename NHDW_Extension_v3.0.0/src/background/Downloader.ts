var JSZip = require("jszip");
import { GallerySource, clearnetSource } from "../sources/GallerySource";
import { getSourceForSite } from "../sources/index";
import { looksLikeGallery } from "../parsing/GalleryEmbed";
import { mirrorFallbackChainFor, buildMirrorSearchUrl, mirrorSearchQueryVariants, parseMirrorSearchResults, pickMirrorTitleMatch } from "../utils/mirrorFallback";
import { decodeTabImageBytes, fetchImageFromTab } from "./tabImageFetch";
import { requestArchiveDownloadUrl, fetchArchiveBytes } from "./ArchiveDownload";
import { buildPdfDocument, jpegInfo, PdfImage } from "../utils/pdfBuilder";
import { startTrackedDownload, normalizeRawConcurrency } from "./downloadControl";
import { errorMessage } from "../utils/utils";
import { sanitizeArtifactFilename } from "../utils/artifactName";
// Re-export so existing tests (`require('../build/test/background/Downloader.js')`)
// keep importing the sanitizer from here.
export { sanitizeArtifactFilename };

export default class Downloader
{
    constructor(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string, zip: typeof JSZip, downloadName: string | null, signal: AbortSignal | null = null, source: GallerySource = clearnetSource, settings: { useZip?: string; maxConcurrentDownloads?: number | string; rawMaxConcurrent?: number | string; archiveLayout?: string; apiKey?: string | null; useServerArchive?: boolean; rawMasterFolder?: string; archiveMasterFolder?: string; mirrorFallback?: boolean } = {})
    {
        this.progressCallback = progressCallback;
        this.#errorCallback = errorCallback;
        this.currentProgress = 0;
        this.#doujinshiName = name;
        this.path = path;
        this.#zip = zip;
        this.downloadName = downloadName;
        this.#abortSignal = signal;
        let effectiveSource = source;
        if (jsonTmp && jsonTmp.site && source === clearnetSource) {
            const resolved = getSourceForSite(jsonTmp.site);
            if (resolved) effectiveSource = resolved;
        }
        this.#source = effectiveSource;
        this.#settings = settings;
        // Relayed/absent settings both end up normalized: undefined means the
        // default master folder, an explicit empty string disables it.
        this.#rawMasterFolder = normalizeRawMasterFolder(settings ? settings.rawMasterFolder : undefined);
        // Optional master folder for finished ARCHIVES (zip/cbz/pdf). Unlike
        // the raw folder this defaults to "" (off): a single file per gallery
        // has never piled up in the download folder the way loose pages do,
        // so it is only used when a caller (list mode) asks for it.
        this.#archiveMasterFolder = normalizeArchiveMasterFolder(settings ? settings.archiveMasterFolder : undefined);

        // @ts-ignore
        if (typeof browser !== "undefined") { // Firefox
            this.#json = JSON.parse(JSON.stringify(jsonTmp));
        } else {
            this.#json = jsonTmp;
        }

        this.#mediaId = this.#json.media_id;
        // Item 72: mirror-network fallback. Reactive only — it runs
        // after this gallery's own mirrors all failed to serve a
        // real image, so a healthy download makes zero extra
        // requests. Default ON (the owner's rule: a passive, static
        // setting that eats no resources while the site is up).
        this.#mirrorFallback = !this.#settings || this.#settings.mirrorFallback !== false;
    }

    // Top-level folder that collects raw (loose image) downloads; "" = off.
    #rawMasterFolder: string = DEFAULT_RAW_MASTER_FOLDER;
    // Top-level folder that collects finished archives (zip/cbz/pdf); "" = off.
    #archiveMasterFolder: string = "";

    isPaused: boolean = false;
    #resumePaused: (() => void) | null = null;

    pause() { this.isPaused = true; }
    resume() {
        this.isPaused = false;
        if (this.#resumePaused) { this.#resumePaused(); this.#resumePaused = null; }
    }
    abort() {
        this.isAwaitingAbort = true;
        this.currentProgress = 100;
        this.resume();
    }
    get galleryId(): string {
        return this.#json && this.#json.id !== undefined ? String(this.#json.id) : "";
    }
    get site(): string {
        return this.#json && this.#json.site ? String(this.#json.site) : "nhentai";
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
        const applySettings = (useZipRaw: string, maxConcurrentDownloads: number | string, rawMaxConcurrent?: number | string) => {
            // Whitelist: a corrupt or legacy value (or undefined from a broken
            // storage read) must fall back to "zip" — an unknown value would
            // otherwise be fetched into the ZIP but never saved (the final
            // step only archives for zip/cbz), silently "succeeding".
            // "folder" is the retired image-folder format: saved settings from
            // older versions map to its replacement, PDF.
            const normalized = useZipRaw === "folder" ? "pdf" : useZipRaw;
            self.useZip = (normalized === "zip" || normalized === "cbz" || normalized === "pdf" || normalized === "raw")
                ? normalized
                : "zip";
            const configuredConcurrency = parseInt(maxConcurrentDownloads as any, 10);
            // Protect the batching loop from corrupt/old sync settings.
            self.maxConcurrentDownloads = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
                ? configuredConcurrency
                : 3;
            if (self.useZip === "raw") {
                // Raw mode hands every page to the browser's download manager
                // and (since 3.6.0) waits for each file to finish, so this
                // batch size is the number of browser downloads running at
                // once. It has its own, smaller cap: the archive-mode fetch
                // concurrency (up to 15) would flood the download shelf.
                self.maxConcurrentDownloads = normalizeRawConcurrency(rawMaxConcurrent);
            }
            // "flat": this Downloader owns the whole archive, so pages sit at
            // the archive ROOT and the archive is named after the gallery —
            // no Title/Title/… double folder. "nested" (the default) is for
            // galleries that share one batch archive: each gallery keeps its
            // own folder inside it.
            self.#archiveLayout = (this.#settings && this.#settings.archiveLayout === "flat") ? "flat" : "nested";
            if (self.useZip === "raw") {
                self.currentProgress = 100;
                try {
                    self.updateProgress(100, self.#doujinshiName, false);
                } catch (e) { } // Dead object
            }
            // Only a shared batch archive needs the per-gallery folder inside;
            // zip/cbz only — PDF and raw never build a zip folder tree.
            if ((self.useZip === "zip" || self.useZip === "cbz") && self.#archiveLayout === "nested") {
                self.#zip.folder(self.path);
            }
        };
        // Callers in contexts without chrome.storage (offscreen documents only
        // expose chrome.runtime) pass the options relayed by the service
        // worker; otherwise fall back to reading chrome.storage.sync.
        if (this.#settings && (this.#settings.useZip !== undefined || this.#settings.maxConcurrentDownloads !== undefined)) {
            applySettings(this.#settings.useZip || "zip", this.#settings.maxConcurrentDownloads || "3", this.#settings.rawMaxConcurrent);
        } else {
            try {
                await new Promise((resolve, _reject) => {
                    resolve(
                        chrome.storage.sync.get({
                            useZip: "zip",
                            maxConcurrentDownloads: "3",
                            rawMaxConcurrent: "3",
                            rawMasterFolder: DEFAULT_RAW_MASTER_FOLDER
                        }, function (elems) {
                            applySettings(elems.useZip, elems.maxConcurrentDownloads, elems.rawMaxConcurrent);
                            // The empty string is meaningful: it disables the
                            // master folder for raw downloads.
                            self.#rawMasterFolder = normalizeRawMasterFolder(elems.rawMasterFolder);
                            // No stored counterpart: the archive master folder
                            // is a per-job choice relayed by the caller.
                        })
                    );
                });
                // API key settings live in chrome.storage.local (a secret is
                // never synced). This branch only runs in contexts WITH
                // storage (the worker / tests) — the offscreen document
                // always receives relayed settings and takes the branch
                // above. Relay callers attach apiKey/useServerArchive
                // themselves; fill anything still missing here.
                if (this.#settings.apiKey === undefined || this.#settings.useServerArchive === undefined) {
                    await new Promise((resolve) => {
                        try {
                            chrome.storage.local.get({ apiKey: "", useServerArchive: false }, (local: any) => {
                                if (this.#settings.apiKey === undefined) {
                                    this.#settings.apiKey = local && local.apiKey ? String(local.apiKey) : null;
                                }
                                if (this.#settings.useServerArchive === undefined) {
                                    this.#settings.useServerArchive = !!(local && local.useServerArchive);
                                }
                                resolve(undefined);
                            });
                        } catch (_) {
                            if (this.#settings.apiKey === undefined) this.#settings.apiKey = null;
                            if (this.#settings.useServerArchive === undefined) this.#settings.useServerArchive = false;
                            resolve(undefined);
                        }
                    });
                }
            } catch (_) {
                // chrome.storage is unavailable in this context; the caller
                // should have relayed settings. Safe defaults keep the job
                // running instead of silently dying before it registers.
                applySettings("zip", "3");
            }
        }
        await self.#downloadAsync();
    }

    // Archive mode (API key mode only, opt-in): ask the official
    // POST /api/v2/galleries/<id>/download endpoint for a ready-made ZIP/CBZ
    // instead of walking every page on the CDN (which the API docs explicitly
    // advise against for full archives). Returns true when the archive was
    // delivered; false sends the caller back to the page-by-page pipeline.
    // Never throws for a plain "unavailable" outcome — only a user abort
    // propagates.
    async #tryServerArchiveAsync(): Promise<boolean> {
        const settings = this.#settings || {};
        const apiKey = settings.apiKey ? String(settings.apiKey) : null;
        if (apiKey === null || settings.useServerArchive !== true) {
            return false;
        }
        const format = this.useZip === "zip" ? "zip" : (this.useZip === "cbz" ? "cbz" : null);
        if (format === null) {
            return false; // raw/folder modes have no server-archive equivalent
        }
        if (this.downloadName === null) {
            // Batch accumulation mode: server archives cannot be merged into
            // the shared ZIP, so page-by-page remains the only route.
            return false;
        }
        try {
            // A server archive replaces the whole output archive. If pages
            // from earlier galleries are already accumulated in the shared
            // ZIP, delivering a per-gallery archive would silently discard
            // them — keep page-by-page for shared batch archives.
            if (this.#zip && Object.keys((this.#zip as any).files || {}).length > 0) {
                return false;
            }
        } catch (_) { /* zip introspection unavailable: be conservative */ }
        const galleryId = this.#json ? this.#json.id : undefined;
        if (galleryId === undefined || galleryId === null) {
            return false;
        }
        try {
            this.updateProgress(1, this.#doujinshiName, false, "requesting server archive");
            let result = await requestArchiveDownloadUrl(galleryId, format, apiKey, { signal: this.#abortSignal || undefined });
            if (result !== null && result.expiresAt !== Number.MAX_SAFE_INTEGER && result.expiresAt * 1000 < Date.now() + 30000) {
                // URL would expire before we can use it; ask once for a fresh one.
                result = await requestArchiveDownloadUrl(galleryId, format, apiKey, { signal: this.#abortSignal || undefined });
            }
            if (result === null) {
                return false;
            }
            if (this.#isAborted()) {
                throw "Download was aborted";
            }
            this.updateProgress(10, this.#doujinshiName, false, "downloading server archive");
            const blob = await fetchArchiveBytes(result.url, { signal: this.#abortSignal || undefined });
            if (this.#isAborted()) {
                throw "Download was aborted";
            }
            this.updateProgress(90, this.#doujinshiName, true, "saving server archive");
            await this.#downloadBlob(blob, this.downloadName + "." + format);
            this.currentProgress = 100;
            try {
                this.updateProgress(100, null, true);
            } catch (e) { } // Dead object
            return true;
        } catch (error) {
            if (this.#isAborted() || error === "Download was aborted" || (error && (error as any).name === "AbortError")) {
                throw error;
            }
            console.warn("Server archive unavailable for gallery " + galleryId + " (" + errorMessage(error) + "); falling back to page-by-page download.");
            return false;
        }
    }

    async #downloadAsync() {
        try
        {
            // Archive mode first when available; otherwise page-by-page.
            if (await this.#tryServerArchiveAsync()) {
                return;
            }

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
                                console.warn("Error while downloading " + this.#doujinshiName + "/" + (i + 1) + ": " + errorMessage(error) + ", tries remaining: " + nbTries);
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
                                    if (self.#zip && typeof (self.#zip as any).cleanup === "function") {
                                        try { await (self.#zip as any).cleanup(); } catch (_) {}
                                    }
                                    self.currentProgress = 100;
                                    try {
                                        self.updateProgress(100, null, true); // Notify popup that we are done
                                    } catch (e) { } // Dead object
                                })
                        );
                    });
                } else if (this.useZip === "pdf") {
                    // PDF: assemble the collected pages (in page order) into a
                    // single document. JPEG pages are embedded as-is
                    // (DCTDecode, no re-encode); others are re-encoded through
                    // an image canvas where the platform provides one.
                    this.updateProgress(0, this.#doujinshiName + ".pdf", true);
                    const pages = this.#pdfPages.slice().sort((a, b) => a.index - b.index);
                    if (pages.length === 0) {
                        throw "No pages were collected for the PDF.";
                    }
                    const images: PdfImage[] = [];
                    for (const page of pages) {
                        images.push(await this.#preparePdfImage(page.bytes, page.contentType));
                    }
                    this.updateProgress(70, this.#doujinshiName + ".pdf", true);
                    const pdf = buildPdfDocument(images);
                    await this.#downloadBlob(new Blob([pdf], { type: "application/pdf" }), this.downloadName + ".pdf");
                    this.currentProgress = 100;
                    try {
                        this.updateProgress(100, null, true); // Notify popup that we are done
                    } catch (e) { } // Dead object
                } else {
                    // "raw" never assembles an archive: raw hands the CDN URLs
                    // to the download manager directly (one numbered file per
                    // page inside a folder named after the gallery).
                    this.currentProgress = 100;
                    this.updateProgress(100, null, true); // Notify popup that we are done
                }
            }
        }
        catch (error)
        {
            this.currentProgress = 100;
            // Cleanup ONLY a writer this Downloader is responsible for
            // finalizing. In a merged batch every intermediate gallery shares
            // ONE StreamingZipWriter (downloadName === null means "contribute
            // pages only") — calling cleanup there wiped pages already
            // collected from earlier galleries while leaving their
            // central-directory records dangling (PR #48 regression: corrupt
            // final archive after a mid-batch failure or cancel). The final
            // save (downloadName set) and separate-mode galleries (each owns
            // its writer) still clean up on failure.
            if (this.downloadName !== null && this.#zip && typeof (this.#zip as any).cleanup === "function") {
                try { await (this.#zip as any).cleanup(); } catch (_) {}
            }
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
        // Last-mile filename hardening: chrome.downloads silently ignores the
        // filename for invalid names (control characters, stray dots/edges),
        // and the file then lands under the blob/CDN URL's own name — random
        // hex or a bare number instead of the gallery title. Sanitize each
        // path segment so the requested name always survives.
        const safeName = sanitizeArtifactFilename(filename, this.#doujinshiName);
        if (this.saveUrl !== null) {
            await this.saveUrl(url, safeName);
            return;
        }
        // startTrackedDownload records the requested name for the
        // onDeterminingFilename guard before starting (see downloadNaming.ts —
        // another extension's listener makes Chrome ignore `filename`
        // entirely), binds the downloadId once known, and then WAITS for the
        // download to reach a terminal state (downloadControl.ts). A page
        // interrupted after it started therefore rejects here and feeds the
        // retry loop instead of counting as saved. uniquify keeps
        // re-downloads of the same gallery from silently overwriting the
        // first one. Because this now waits for completion, the page batch
        // loop above caps how many browser downloads are in flight at once
        // (raw mode: the "raw concurrency" setting). A user cancel stops the
        // wait — and cancels loose raw pages, which are worthless half-done.
        await startTrackedDownload(url, safeName, {
            signal: this.#abortSignal,
            cancelOnAbort: this.useZip === "raw"
        });
    }

    // Finished archives (zip/cbz/pdf) optionally live inside a master folder,
    // mirroring what raw downloads do with their titled folders. One switch in
    // the UI drives both; "" keeps the historical "straight into Downloads".
    #archiveArtifactName(filename: string): string {
        return this.#archiveMasterFolder !== ""
            ? this.#archiveMasterFolder + "/" + filename
            : filename;
    }

    async #downloadBlob(content: Blob, filename: string): Promise<void> {
        const { url, revoke } = await this.#urlForBlob(content);
        filename = this.#archiveArtifactName(filename);
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
    // The per-page extension from its legacy type code. Extracted
    // (item 72) so a gallery that switched to a mirror mid-walk can
    // recompute the address from the MIRROR's own page types — the
    // extension is per-gallery on this network, not per-site.
    #pageFormatCode(page: any): string | null {
        switch (page.t) {
            case "j":
                return ".jpg";
            case "p":
                return ".png";
            case "g":
                return ".gif";
            case "w":
                return ".webp";
            case "b":
                return ".bmp";
            case "a":
                return ".avif";
            case "0": // Invalid page, probably an issue on NHentai side
                return null;
            default:
                throw "Unknown page format " + page.t;
        }
    }

    async #downloadPageInternalAsync(currPage: number, progress: number) {
        let page = this.#json.images.pages[currPage];
        if (page === undefined) { page = { t: "j", w: 0, h: 0 }; }
        const format = this.#pageFormatCode(page);
        if (format === null) {
            return;
        }
        let filenameParsing = (page && page.hash) ? (page.hash + format) : ((currPage + 1) + format); // Name for parsing
        this.updateProgress(progress, this.#doujinshiName + "/" + ((currPage + 1) + format), false);

        let filename = this.#getNumberWithZeros(currPage + 1) + format; // Final file name

        // Try the canonical CDN first, then the numbered mirrors. This is
        // similar to gallery-dl's extractor fallback strategy and avoids making
        // one random mirror failure abort an otherwise valid gallery.
        // Item 72 appends the mirror-network fallbacks (the /033/
        // twin's hosts for the same token) after the site's own mirrors.
        const imageUrls = this.#imageUrlsForPage(filenameParsing);

        if (this.useZip === "raw") {
            // Raw mode cannot inspect the response before Chrome starts the
            // download. Use the canonical original-image URL and report startup
            // errors through the downloads API callback (routed through
            // #saveArtifact so the offscreen document can relay to the worker).
            let lastRawError: any = null;
            const masterPrefix = this.#rawMasterFolder !== "" ? this.#rawMasterFolder + "/" : "";
            // Pages are numbered (001.jpg…) inside a folder named after
            // the gallery, itself inside the master folder (default
            // "NHDW") so hundreds of galleries group tidily. An empty
            // master folder disables the extra level; slashes in the
            // value nest deeper. sanitizeArtifactFilename cleans every
            // segment independently at save time.
            const rawSavePath = masterPrefix + this.path.replace(/[\\:*?"<>|]/g, '') + "/" + filename;
            try {
                await this.#saveArtifact(imageUrls[0], rawSavePath);
                return;
            } catch (error: any) {
                // Startup failures AND downloads interrupted after they
                // started (network drop, disk full, cancelled in the shelf)
                // land here and go through the retry loop; only after the
                // retries are exhausted does the gallery fail.
                lastRawError = error;
            }
            // Item 72: the SIBLING store's URL for the same page is
            // tried when the canonical download fails to start. The
            // site's own numbered mirrors stay untouched here — raw
            // mode has always handed exactly one URL to the download
            // manager, and a failed mirror download still briefly
            // occupies the shelf.
            const fallbackUrls = this.#fallbackUrlsForPage(filenameParsing);
            for (const imageUrl of fallbackUrls) {
                try {
                    await this.#saveArtifact(imageUrl, rawSavePath);
                    return;
                } catch (error: any) {
                    lastRawError = error;
                }
            }
            const switched = await this.#maybeSwitchMirror();
            if (switched) {
                // After a title-match switch the sibling's own
                // canonical URL is the right single target.
                try {
                    await this.#saveArtifact(this.#imageUrlsForPage(filenameParsing)[0], rawSavePath);
                    return;
                } catch (error: any) {
                    lastRawError = error;
                }
            }
            const reason = lastRawError && lastRawError.message !== undefined ? lastRawError.message : lastRawError;
            throw this.#mirrorExhaustedError("Failed to download original image (" + reason + ").");
        }

        // ZIP/CBZ and PDF share the fetch + validation loop; only the payload
        // handling differs (archive entry vs in-memory page list).
        let validated: { blob: Blob; contentType: string | null };
        try {
            validated = await this.#loadValidatedImage(imageUrls);
        } catch (error) {
            // Item 72: every own-mirror URL failed to serve a real
            // image (a throttle, a challenge, an error document).
            // The title-match step of the chain resolves the same
            // gallery on a sibling site — once per gallery, not per
            // page — and this page is re-walked from there.
            const switched = await this.#maybeSwitchMirror();
            if (!switched) {
                throw this.#mirrorExhaustedError(error);
            }
            // The sibling may type its pages differently (jpg vs
            // webp is per-gallery on this network), so recompute
            // the page address from the MIRROR's own metadata.
            const switchedPage = (this.#json.images.pages || [])[currPage];
            if (switchedPage !== undefined) {
                const switchedFormat = this.#pageFormatCode(switchedPage);
                if (switchedFormat !== null) {
                    filenameParsing = (switchedPage && switchedPage.hash)
                        ? (switchedPage.hash + switchedFormat)
                        : ((currPage + 1) + switchedFormat);
                }
            }
            validated = await this.#loadValidatedImage(this.#imageUrlsForPage(filenameParsing));
        }
        if (this.useZip === "pdf") {
            // Keep the raw bytes; encoding decisions happen once, at assembly.
            this.#pdfPages.push({
                index: currPage,
                bytes: new Uint8Array(await validated.blob.arrayBuffer()),
                contentType: validated.contentType
            });
            return;
        }
        await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                resolve(this.#zip.file(this.#archiveEntryName(filename), reader.result as null));
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(validated.blob as Blob);
        });
    }

    // Fetch the first mirror that answers with a real image. A 200 response
    // can still be a Cloudflare challenge page or an error document: only
    // responses that identify as images (and are not suspiciously small) are
    // accepted, otherwise the next mirror is tried so HTML never ends up
    // inside the archive as if it were a page.
    async #loadValidatedImage(imageUrls: string[]): Promise<{ blob: Blob; contentType: string | null }> {
        let lastStatus = "unknown error";
        for (const imageUrl of imageUrls) {
            const loaded = await this.#loadImage(imageUrl);
            if (loaded.blob) {
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
                return { blob: loaded.blob, contentType: contentType };
            }
            lastStatus = loaded.lastStatus;
        }
        throw this.#imageFetchFailureMessage(lastStatus);
    }

    // Entry name inside the archive. Flat layouts (the archive belongs to this
    // gallery alone) put pages at the root so the archive is never
    // Title.zip -> Title/001.jpg (the double-name hassle); shared batch
    // archives keep one folder per gallery.
    #archiveEntryName(filename: string): string {
        return this.#archiveLayout === "flat" ? filename : this.path + "/" + filename;
    }

    // Item 72: the sibling-store URLs for the same media address
    // (the /033/ twin's hosts for the same token — a host swap;
    // the twins share the content store, so the path is identical).
    // Empty for every site outside the token-shared store.
    #fallbackUrlsForPage(filenameParsing: string): string[] {
        if (!this.#mirrorFallback) {
            return [];
        }
        const source = this.#source as any;
        if (typeof source.getFallbackImageUrls !== "function") {
            return [];
        }
        const fallbackUrls = source.getFallbackImageUrls(String(this.#mediaId), filenameParsing);
        return Array.isArray(fallbackUrls) ? fallbackUrls : [];
    }

    // This site's own mirrors first (canonical CDN, then the
    // numbered mirrors — the pre-existing order), then, when
    // mirror fallback is enabled, the sibling store's hosts.
    #imageUrlsForPage(filenameParsing: string): string[] {
        const urls = this.#source.getImageUrls(String(this.#mediaId), filenameParsing);
        for (const url of this.#fallbackUrlsForPage(filenameParsing)) {
            if (urls.indexOf(url) === -1) {
                urls.push(url);
            }
        }
        return urls;
    }

    // Item 72: resolve the title-match step of the fallback chain
    // at most once per gallery (see #mirrorSwitch). Token steps
    // never reach this — they already ride in the page's URL list.
    #maybeSwitchMirror(): Promise<boolean> {
        if (!this.#mirrorFallback) {
            return Promise.resolve(false);
        }
        if (this.#mirrorSwitch === null) {
            this.#mirrorSwitch = this.#resolveMirrorSwitch().catch(() => false);
        }
        return this.#mirrorSwitch;
    }

    // Walk the title-match chain: search each sibling for the
    // gallery's title, refuse anything that is not the same
    // gallery (score threshold + 1:1 page count — the mirror
    // network's copies are page-identical per the owner's
    // byte comparison), and on acceptance switch the walk to
    // the sibling's adapter, token and page types.
    async #resolveMirrorSwitch(): Promise<boolean> {
        const expectedTitle = this.#json && this.#json.title
            ? String(this.#json.title.pretty || this.#json.title.english || "")
            : "";
        if (expectedTitle === "") {
            return false;
        }
        for (const step of mirrorFallbackChainFor(this.site)) {
            if (step.mode !== "title") {
                continue;
            }
            const adapter = getSourceForSite(step.site);
            if (adapter === null || typeof adapter.extractGallery !== "function") {
                continue;
            }
            // Item 73: wording ladder. imhentai and
            // hentaiera search often answer nothing
            // unless the query is worded like the full
            // title — or searched by tags instead — so
            // each rung is tried only when the previous
            // search parses to zero usable cards.
            let match: any = null;
            for (const query of mirrorSearchQueryVariants(
                expectedTitle, this.#json && this.#json.tags)) {
                const searchUrl = buildMirrorSearchUrl(step.site, query);
                if (searchUrl === null) {
                    continue;
                }
                const searchHtml = await this.#fetchMirrorText(searchUrl);
                if (searchHtml === null) {
                    continue;
                }
                const cards = parseMirrorSearchResults(searchHtml, step.site);
                if (cards.length === 0) {
                    continue;
                }
                match = pickMirrorTitleMatch(cards, expectedTitle);
                if (match !== null) {
                    break;
                }
            }
            if (match === null) {
                continue;
            }
            const galleryHtml = await this.#fetchMirrorText(adapter.getGalleryUrl(match.id));
            if (galleryHtml === null) {
                continue;
            }
            const extracted = adapter.extractGallery(galleryHtml);
            if (extracted === null || !looksLikeGallery(extracted)) {
                continue;
            }
            // A sibling reporting a different page count is a
            // different gallery (or a partial mirror) — refuse it.
            if (typeof extracted.num_pages === "number"
                && typeof this.#json.num_pages === "number"
                && extracted.num_pages > 0
                && extracted.num_pages !== this.#json.num_pages) {
                continue;
            }
            if (!extracted.site) {
                extracted.site = adapter.site;
            }
            this.#source = adapter;
            this.#mediaId = extracted.media_id;
            this.#json = extracted;
            this.updateProgress(Number(this.currentProgress), this.#doujinshiName, false, "mirror fallback: " + adapter.site);
            return true;
        }
        return false;
    }

    // One search/gallery fetch for the title-match step.
    // Extension-origin fetch — the same route mirror-site
    // metadata already takes: a Cloudflare challenge page
    // parses to no cards and the chain moves to the next
    // sibling. Never throws; null means "try the next".
    async #fetchMirrorText(url: string): Promise<string | null> {
        if (this.#isAborted()) {
            return null;
        }
        try {
            const resp = await fetch(url, { credentials: "include", cache: "no-store", signal: this.#abortSignal || undefined });
            if (resp && resp.ok && typeof resp.text === "function") {
                return await resp.text();
            }
        } catch (_) {
            // Challenge or network failure: try the next sibling.
        }
        return null;
    }

    // Item 72: when the whole chain is exhausted, the failure
    // must say the siblings were tried — not just that the
    // images failed — so the owner can tell a dead mirror from
    // a gallery nobody else carries.
    #mirrorExhaustedError(error: any): any {
        if (!this.#mirrorFallback || mirrorFallbackChainFor(this.site).length === 0) {
            return error;
        }
        const message = String(error && (error as any).message !== undefined ? (error as any).message : error);
        return message + " Mirror fallback found no copy on the sibling sites.";
    }

    // Prepare one collected page for the PDF. RGB JPEGs are embedded as-is
    // (fast and lossless); grayscale/CMYK JPEGs and PNG/GIF/WebP pages are
    // re-encoded to RGB JPEG through an image canvas when the platform
    // provides one (the offscreen document and MV3 workers both do).
    async #preparePdfImage(bytes: Uint8Array, contentType: string | null): Promise<PdfImage> {
        const info = jpegInfo(bytes);
        if (info !== null && info.components === 3 && info.width > 0 && info.height > 0) {
            return { bytes: bytes, width: info.width, height: info.height };
        }
        const reencoded = await this.#reencodeImageToJpeg(bytes, contentType);
        if (reencoded === null) {
            throw "PDF export cannot encode a page (no image canvas available in this context).";
        }
        return reencoded;
    }

    async #reencodeImageToJpeg(bytes: Uint8Array, contentType: string | null): Promise<PdfImage | null> {
        const createImageBitmapFn = (globalThis as any).createImageBitmap;
        const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas;
        if (typeof createImageBitmapFn !== "function" || typeof OffscreenCanvasCtor !== "function") {
            return null;
        }
        try {
            const bitmap = await createImageBitmapFn(new Blob([bytes], { type: contentType || "image/jpeg" }));
            try {
                const canvas = new OffscreenCanvasCtor(bitmap.width, bitmap.height);
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    return null;
                }
                // JPEG has no alpha channel: flatten transparency onto white
                // instead of letting transparent pages turn black.
                ctx.fillStyle = "#FFFFFF";
                ctx.fillRect(0, 0, bitmap.width, bitmap.height);
                ctx.drawImage(bitmap, 0, 0);
                const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
                return {
                    bytes: new Uint8Array(await blob.arrayBuffer()),
                    width: bitmap.width,
                    height: bitmap.height
                };
            } finally {
                if (bitmap && typeof bitmap.close === "function") {
                    bitmap.close();
                }
            }
        } catch (_) {
            return null;
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
    // When set, artifacts (zip/pdf blobs, raw CDN URLs) are saved through this
    // function instead of chrome.downloads. The offscreen document sets it to
    // a relay, because chrome.downloads is not exposed in offscreen documents
    // (only chrome.runtime is).
    saveUrl: ((url: string, filename: string) => Promise<void>) | null = null;
    #settings: { useZip?: string; maxConcurrentDownloads?: number | string; rawMaxConcurrent?: number | string; archiveLayout?: string; apiKey?: string | null; useServerArchive?: boolean; archiveMasterFolder?: string; mirrorFallback?: boolean };
    // "flat" = this gallery owns the whole archive (pages at the root);
    // "nested" = shared batch archive (one folder per gallery inside).
    #archiveLayout: string = "nested";
    // Item 72: mirror-network fallback (reactive — see the
    // constructor). False turns the whole chain off.
    #mirrorFallback: boolean = true;
    // Item 72: the title-match switch resolves at most once per
    // gallery; every concurrently failing page awaits this one
    // promise, so one throttle costs one search per sibling.
    #mirrorSwitch: Promise<boolean> | null = null;
    // Pages collected for PDF assembly, filled in page order at the end.
    #pdfPages: Array<{ index: number; bytes: Uint8Array; contentType: string | null }> = [];

    // Progress info
    #progressPercent: number;
    #progressName: string | null;
    #progressZipping: boolean;
    #progressRetry: string | null = null;
}

// Master folder for raw (loose image) downloads: every gallery's titled
// folder of pages lands inside it (NHDW/<Title>/001.jpg…), keeping the
// download directory tidy once hundreds of titles pile up. An explicit empty
// or whitespace-only setting disables it (the historical behavior);
// undefined means "use the default". Relayed through the settings bag so the
// offscreen document never needs chrome.storage.
export const DEFAULT_RAW_MASTER_FOLDER = "NHDW";

// Master folder for finished archives. Unlike the raw folder this is OFF by
// default: it only applies when a caller explicitly asks for the wrap.
export function normalizeArchiveMasterFolder(value: any): string {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

export function normalizeRawMasterFolder(value: any): string {
    if (value === undefined || value === null) {
        return DEFAULT_RAW_MASTER_FOLDER;
    }
    return String(value).trim();
}
