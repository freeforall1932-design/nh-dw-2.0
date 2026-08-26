var JSZip = require("jszip");
import { GallerySource, clearnetSource } from "../sources/GallerySource";
import { decodeTabImageBytes, fetchImageFromTab } from "./tabImageFetch";
import { requestArchiveDownloadUrl, fetchArchiveBytes } from "./ArchiveDownload";
import { buildPdfDocument, jpegInfo, PdfImage } from "../utils/pdfBuilder";

export default class Downloader
{
    constructor(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string, zip: typeof JSZip, downloadName: string | null, signal: AbortSignal | null = null, source: GallerySource = clearnetSource, settings: { useZip?: string; maxConcurrentDownloads?: number | string; archiveLayout?: string; apiKey?: string | null; useServerArchive?: boolean } = {})
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
            console.warn("Server archive unavailable for gallery " + galleryId + " (" + error + "); falling back to page-by-page download.");
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
        await new Promise<void>((resolve, reject) => {
            chrome.downloads.download({ url: url, filename: safeName }, function(downloadId) {
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

        if (this.useZip === "raw") {
            // Raw mode cannot inspect the response before Chrome starts the
            // download. Use the canonical original-image URL and report startup
            // errors through the downloads API callback (routed through
            // #saveArtifact so the offscreen document can relay to the worker).
            // Pages are numbered (001.jpg…) inside a folder named after the
            // gallery so the download manager groups them like every other
            // format does.
            const imageUrl = imageUrls[0];
            try {
                await this.#saveArtifact(imageUrl, this.path.replace(/[\\:*?"<>|]/g, '') + "/" + filename);
            } catch (error) {
                throw "Failed to download original image (" + error + ").";
            }
            return;
        }

        // ZIP/CBZ and PDF share the fetch + validation loop; only the payload
        // handling differs (archive entry vs in-memory page list).
        const validated = await this.#loadValidatedImage(imageUrls);
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
    #settings: { useZip?: string; maxConcurrentDownloads?: number | string; archiveLayout?: string; apiKey?: string | null; useServerArchive?: boolean };
    // "flat" = this gallery owns the whole archive (pages at the root);
    // "nested" = shared batch archive (one folder per gallery inside).
    #archiveLayout: string = "nested";
    // Pages collected for PDF assembly, filled in page order at the end.
    #pdfPages: Array<{ index: number; bytes: Uint8Array; contentType: string | null }> = [];

    // Progress info
    #progressPercent: number;
    #progressName: string | null;
    #progressZipping: boolean;
    #progressRetry: string | null = null;
}
// Make a downloads-API filename safe enough that Chrome never discards it:
// keep the subfolder structure (a/b/c.jpg), strip control and reserved
// characters per segment, drop leading dots and trailing dots/spaces (Windows
// rejects those), bound segment length, and fall back to the gallery name when
// nothing usable is left. This runs right before chrome.downloads.download for
// every artifact (archives, PDFs, raw pages).
export function sanitizeArtifactFilename(filename: string, fallbackStem: string): string {
    const segments = String(filename).split("/");
    const cleanedSegments: string[] = [];
    for (const segment of segments) {
        let cleaned = segment
            .replace(/[\x00-\x1f\x7f]/g, "")
            .replace(/[\\:*?"<>|]/g, "")
            .replace(/^\.+/, "")
            .replace(/[. ]+$/g, "");
        if (cleaned.length > 120) {
            cleaned = cleaned.slice(0, 120).replace(/[. ]+$/g, "");
        }
        if (cleaned !== "") {
            cleanedSegments.push(cleaned);
        }
    }
    let joined = cleanedSegments.join("/");
    if (joined === "" || joined === "/") {
        joined = sanitizeArtifactFilename(String(fallbackStem || "download"), "download");
    }
    return joined;
}
