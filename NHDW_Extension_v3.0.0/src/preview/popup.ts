import AParsing from "../parsing/AParsing";
import { utils, classifyError } from "../utils/utils";
import { message } from "./message"
import { resolveSelectedGalleries } from "./selectedGalleryResolver"
import { getSourceForUrl } from "../sources"
import { getActiveTabId, readGalleryFromTab } from "./activeTabGallery"

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

// Escape text before embedding it in the popup's innerHTML so a gallery title
// containing quotes or HTML cannot break the markup (or inject content).
function escapeHtml(text: string): string {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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

async function getRelatedGalleries(galleryId: string): Promise<Record<string, string>> {
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
    const galleries: Record<string, string> = {};
    for (const gallery of payload.result) {
        if (!gallery || !Number.isFinite(Number(gallery.id))) {
            continue;
        }
        const relatedId = String(gallery.id);
        galleries[relatedId] = String(gallery.english_title || gallery.japanese_title || relatedId);
    }
    return galleries;
}

// Add message listener for progress updates and error messages
// NOTE: This listener is fire-and-forget — it never calls sendResponse, so it
// must return false. Returning true kept the message channel open and made
// Chrome log "A listener indicated an asynchronous response by returning true,
// but the message channel closed before a response was received" for every
// progress tick, with offscreen.html as the sender.
chrome.runtime.onMessage.addListener(function(request) {
    if (request.action === "updateProgress") {
        Popup.getInstance().updateProgress(request.progress, request.doujinshiName, request.isZipping, request.retry);
    } else if (request.action === "downloadError") {
        // Label the failure kind (metadata / Cloudflare / image / archive /
        // cancellation) so the user understands what went wrong at a glance.
        const { label } = classifyError(request.error);
        document.getElementById('action')!.innerHTML = 'An error occured: <b>' + label + '.</b> ' + escapeHtml(String(request.error));
    } else if (request.action === "batchProgress") {
        // Per-gallery progress while a batch download is running
        document.getElementById('action')!.innerHTML = message.batchProgress(
            request.current, request.total, request.galleryName, request.stage || "Downloading");
    } else if (request.action === "batchSummary") {
        // End-of-batch success/failure summary
        document.getElementById('action')!.innerHTML = message.batchSummary(
            request.succeeded, request.failed, request.total, request.failedKinds);
        setTimeout(() => {
            const buttonBack = document.getElementById('buttonBack');
            if (buttonBack) {
                buttonBack.addEventListener('click', function() {
                    let popup = Popup.getInstance();
                    chrome.runtime.sendMessage({ action: "goBack" }, function() {
                        popup.updatePreviewAsync(popup.url);
                    });
                });
            }
        }, 0);
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
    updateProgress(progress: number, doujinshiName: string, isZipping: boolean, retry?: string) {
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
            document.getElementById('action')!.innerHTML = message.downloadProgress(isZipping ? "Zipping" : "Downloading", doujinshiName, progress, retry);
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
        }
    }

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

        // Read the open gallery tab first. Extension-origin fetches to
        // /api/gallery/<id> are what Cloudflare 403s; the rendered page already
        // has window._gallery once the challenge is done.
        json = await getGalleryFromActiveTab(id);

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
                statusText = String(error);
            }
        }
        if (json === null) {
            document.getElementById('action')!.innerHTML = status === 404
                ? message.errorOther(status, statusText)
                : message.cloudflareMetadata();
            return;
        }

        let self = this;
        chrome.storage.sync.get({
                useZip: "zip",
                downloadName: "{pretty}",
                replaceSpaces: true
            }, function(elems) {
                let extension = "";
                if (elems.useZip == "zip")
                    extension = ".zip";
                else if (elems.useZip == "cbz")
                    extension = ".cbz";
                else if (elems.useZip == "folder")
                    extension = " (images folder)";

                let title = utils.getDownloadName(elems.downloadName, json.title.pretty === "" ?
                    json.title.english.replace(/\[[^\]]+\]/g, '').replace(/\([^\)]+\)/g, '') : json.title.pretty,
                    json.title.english, json.title.japanese, id, json.tags);
                document.getElementById('action')!.innerHTML = message.downloadInfo(escapeHtml(title), json.images.pages.length, extension, elems.useZip);
                (document.getElementById('path') as HTMLInputElement).value = utils.cleanName(title, elems.replaceSpaces, id);

                // Add event listeners after updating the HTML content.
                setTimeout(() => {
                    const selectedFormat = () => {
                        const value = (document.getElementById('downloadFormat') as HTMLSelectElement | null)?.value;
                        return value === 'cbz' || value === 'folder' || value === 'raw' ? value : 'zip';
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

                    const similarButton = document.getElementById('buttonSimilar');
                    if (similarButton) {
                        similarButton.addEventListener('click', async function() {
                            similarButton.setAttribute("disabled", "disabled");
                            document.getElementById('action')!.innerHTML = "Finding similar galleries...";
                            try {
                                const related = await getRelatedGalleries(id);
                                if (Object.keys(related).length === 0) {
                                    throw new Error("No related galleries were returned.");
                                }
                                const tabId = await getActiveTabId();
                                const finalName = utils.cleanName(title + " - similar", elems.replaceSpaces, id);
                                chrome.runtime.sendMessage({
                                    action: "downloadAllDoujinshis",
                                    allDoujinshis: related,
                                    galleryMetadata: {},
                                    finalName: finalName,
                                    tabId: tabId,
                                    formatOverride: selectedFormat()
                                }, (response) => {
                                    if (response && response.result === "queued") {
                                        document.getElementById('action')!.innerHTML =
                                            "Similar-gallery download queued at position " + response.position + ".";
                                        return;
                                    }
                                    self.updateProgress(0, finalName, false);
                                });
                            } catch (error) {
                                document.getElementById('action')!.innerHTML =
                                    "Could not load similar galleries: " + escapeHtml(String(error));
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
    updatePreviewAll(galleries: Array<{ id: string; title: string }>, currentPage: number, maxPage: number, downloadName: string, useZip: string, replaceSpaces: boolean) {
        let self = Popup.getInstance();

        if (galleries.length === 0) {
            document.getElementById('action')!.innerHTML = message.invalidPage();
            return;
        }

        // Keep titles in a plain object keyed by gallery ID instead of the DOM
        // name attribute: a title containing quotes or HTML can no longer break
        // the checkbox markup or the download message.
        const titleById: Record<string, string> = {};
        const allIds: Array<string> = [];
        let finalHtml = "";
        for (const card of galleries) {
            let tmpName;
            if (downloadName === "{pretty}") {
                tmpName = card.title.replace(/\[[^\]]+\]/g, "").replace(/\([^\)]+\)/g, "").replace(/\{[^\}]+\}/g, "").trim();
            } else {
                tmpName = card.title.trim();
            }
            titleById[card.id] = tmpName;
            finalHtml += '<input id="' + card.id + '" type="checkbox"/>' + escapeHtml(tmpName) + '<br/>';
            allIds.push(card.id);
        }

        // Use URL for default download name
        let parts = self.url.split('/')
        let name;
        if (parts[parts.length - 1] === "" || parts[parts.length - 1].startsWith("?page=")) name = parts[parts.length - 2];
        else name = parts[parts.length - 1];
        name = name.replace("q=", ""); // Artifact when doing a search

        // Appends the extension (none is raw download; folder mode produces
        // one images folder per gallery instead of a single archive)
        let extension = "";
        if (useZip != "raw" && useZip != "folder")
        {
            extension = "." + useZip;
        }

        // Add the HTML
        let nbDownload = 0;
        let currPage = currentPage;
        let html =  '<h3>' + allIds.length + ' doujinshi' + (allIds.length > 1 ? 's' : '') + ' found</h3>' + finalHtml
        + '<input type="button" id="invert" value="Invert all"/><input type="button" id="remove" value="Clear all"/><br/><br/><input type="button" id="button" value="Download"/>';
        if (maxPage > 0 && currPage > 0) {
            nbDownload = maxPage - currPage + 1;
            html += '<br/><input type="button" id="buttonAll" value="Download all (' + nbDownload + ' pages)"/><br/><input type="text" id="downloadInput"/><input type="button" id="buttonHelp" value="?"/>';
        }
        html += '<br/><br/>Downloads/<input type="text" id="path"/>' + extension;
        document.getElementById('action')!.innerHTML = html;
        (document.getElementById('path') as HTMLInputElement).value = utils.cleanName(name, replaceSpaces);
        if (maxPage > 0 && currPage > 0) {
            (document.getElementById('downloadInput') as HTMLInputElement).value = currPage + "-" + maxPage;
            document.getElementById('buttonHelp')!.addEventListener('click', function() {
                alert("Input the pages you want to download for the \"Download all\" feature\nWrite your pages separated by comma ',', you can also write range of number by separating them by a dash '-'\n"
                + "Example: 2,4,6-10 will download the pages 2, 4 and 6 to 10 (included)");
            });
        }

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
                    if (Object.keys(allDoujinshis).length > 0) { // There is at least one element selected, we launch download
                        const pathElement = document.getElementById('path') as HTMLInputElement;
                        if (pathElement) {
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
                            chrome.runtime.sendMessage({
                                action: "downloadAllDoujinshis",
                                allDoujinshis: allDoujinshis,
                                galleryMetadata: galleryMetadata,
                                finalName: finalName,
                                tabId: tabId
                            });
                            self.updateProgress(0, finalName, false);
                        }
                    } else {
                        document.getElementById('action')!.innerHTML = "You must select at least one element to download.";
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
                        let pages = self.#parseDownloadAll(maxPage);
                        if (typeof pages === "string") {
                            alert(pages);
                            const downloadInput = document.getElementById('downloadInput') as HTMLInputElement;
                            if (downloadInput) {
                                downloadInput.value = currPage + "-" + nbDownload;
                            }
                        } else {
                            let choice = confirm("You are going to download " + pages.length + " pages of doujinshi. Are you sure you want to continue?");
                            if (choice) {
                                const pathElement = document.getElementById('path') as HTMLInputElement;
                                if (pathElement) {
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
                                    chrome.runtime.sendMessage({
                                        action: "downloadAllPages",
                                        allDoujinshis: allDoujinshis,
                                        galleryMetadata: galleryMetadata,
                                        pages: pages,
                                        finalName: finalName,
                                        url: self.url,
                                        tabId: tabId
                                    });
                                    self.updateProgress(0, finalName, false);
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
