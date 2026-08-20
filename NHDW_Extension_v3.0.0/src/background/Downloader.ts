var JSZip = require("jszip");

export default class Downloader
{
    constructor(jsonTmp: any, path: string, errorCallback: Function, progressCallback: Function, name: string, zip: typeof JSZip, downloadName: string | null, signal: AbortSignal | null = null)
    {
        this.progressCallback = progressCallback;
        this.#errorCallback = errorCallback;
        this.currentProgress = 0;
        this.#doujinshiName = name;
        this.path = path;
        this.#zip = zip;
        this.downloadName = downloadName;
        this.#abortSignal = signal;

        // @ts-ignore
        if (typeof browser !== "undefined") { // Firefox
            this.#json = JSON.parse(JSON.stringify(jsonTmp));
        } else {
            this.#json = jsonTmp;
        }

        this.#mediaId = this.#json.media_id;
    }

    updateProgress(progress: number, name: string | null, isZipping: boolean) {
        try {
            this.progressCallback(progress, name, isZipping);
        } catch (e) { } // Dead object
        this.#progressPercent = progress;
        this.#progressName = name;
        this.#progressZipping = isZipping;
    }

    updateProgressLatest(updateCallback: Function) {
        this.progressCallback = updateCallback;
        this.progressCallback(this.#progressPercent, this.#progressName, this.#progressZipping);
    }

    async startAsync() {
        let self = this;
        await new Promise((resolve, _reject) => {
            resolve(
                chrome.storage.sync.get({
                    useZip: "zip",
                    maxConcurrentDownloads: "3"
                }, function(elems) {
                    self.useZip = elems.useZip;
                    const configuredConcurrency = parseInt(elems.maxConcurrentDownloads, 10);
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
                    self.#zip.folder(self.path);
                })
            );
        });
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
                            console.warn("Error while downloading " + this.#doujinshiName + "/" + (i + 1) + ": " + error + ", tries remaining: " + nbTries);
                            nbTries--;
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
                if (this.useZip !== "raw") { // Raw download doesn't need zipping
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
    // (Using chrome.downloads also avoids the download silently doing nothing.)
    async #downloadBlob(content: Blob, filename: string): Promise<void> {
        let url: string;
        let revokeObjectUrl: (() => void) | null = null;
        if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
            url = URL.createObjectURL(content);
            revokeObjectUrl = () => URL.revokeObjectURL(url);
        } else {
            const bytes = new Uint8Array(await content.arrayBuffer());
            let binary = "";
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
            }
            url = "data:application/zip;base64," + btoa(binary);
        }
        try {
            await new Promise<void>((resolve, reject) => {
                chrome.downloads.download({ url: url, filename: filename }, function(downloadId) {
                    if (downloadId === undefined) {
                        reject(new Error(String(chrome.runtime.lastError || "Unable to start download")));
                    } else {
                        resolve();
                    }
                });
            });
        } catch (error) {
            if (revokeObjectUrl !== null) revokeObjectUrl();
            throw error;
        }
        // Keep the object URL alive while Chrome's download manager reads the
        // blob, then release it.
        if (revokeObjectUrl !== null) {
            setTimeout(revokeObjectUrl, this.revokeObjectUrlDelayMs);
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
        const imageUrls = [
            `https://i.nhentai.net/galleries/${this.#mediaId}/${filenameParsing}`,
            ...[1, 2, 3, 4].map(server =>
                `https://i${server}.nhentai.net/galleries/${this.#mediaId}/${filenameParsing}`)
        ];

        if (this.useZip !== "raw") { // ZIP (or equivalent) format
            let lastStatus = "unknown error";
            for (const imageUrl of imageUrls) {
                const resp = await fetch(imageUrl, { credentials: "include", cache: "no-store", signal: this.#abortSignal });
                if (resp.ok) {
                    // A 200 response can still be a Cloudflare challenge page or
                    // an error document. Only accept responses that identify as
                    // images, otherwise try the next mirror so HTML never ends
                    // up inside the ZIP as if it were a page.
                    const contentType = resp.headers.get("content-type");
                    if (contentType !== null && !contentType.toLowerCase().startsWith("image/")) {
                        lastStatus = "unexpected content-type \"" + contentType + "\"";
                        continue;
                    }
                    const blob = await resp.blob();
                    await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            resolve(this.#zip.file(this.path + '/' + filename, reader.result as null));
                        };
                        reader.onerror = reject;
                        reader.readAsArrayBuffer(blob);
                    });
                    return;
                }
                lastStatus = resp.status + ": " + resp.statusText;
            }
            throw "Failed to fetch original image from all image servers (" + lastStatus + ").";
        } else { // We don't need to update progress here because it goes too fast anyway
            // Raw mode cannot inspect the response before Chrome starts the
            // download. Use the canonical original-image URL and report startup
            // errors through the downloads API callback.
            const imageUrl = imageUrls[0];
            await new Promise<void>((resolve, reject) => {
                chrome.downloads.download({
                    url: imageUrl,
                    // Keep "/" so the configured folder structure is preserved;
                    // strip only characters Chrome rejects in download filenames.
                    filename: this.path.replace(/[\\:*?"<>|]/g, '') + "-" + filename
                }, function(downloadId) {
                    if (downloadId === undefined) {
                        reject("Failed to download original image (" + chrome.runtime.lastError + ").");
                    } else {
                        resolve();
                    }
                });
            });
        }
    }

    isDone(): boolean
    {
        return this.currentProgress === 100;
    }

    useZip: string; // How data must be downloaded
    maxConcurrentDownloads: number = 3; // Number of concurrent downloads
    revokeObjectUrlDelayMs: number = 60000; // How long an object URL stays alive after a successful download
    #json: any; // JSON containing all data
    #zip: typeof JSZip; // ZIP data that will be downloaded at the end
    #abortSignal: AbortSignal | null; // Cancels in-flight image fetches when the user aborts
    downloadName: string | null; // Name of the ZIP, null if should not download
    path: string; // Save path
    progressCallback: Function; // Function to call when progress is made
    #errorCallback: Function; // Function to call if an error occured
    currentProgress: Number; // Current progress of the download
    #doujinshiName: string; // Name of the doujinshi
    #mediaId: number; // Id of the media

    isAwaitingAbort: boolean = false;

    // Progress info
    #progressPercent: number;
    #progressName: string | null;
    #progressZipping: boolean;
}