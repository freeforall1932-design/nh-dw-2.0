import { getSourceForUrl } from "../sources/index";

let tmpIds: Array<string> = [];

// `allIds` is a transient selection shared by the page, panel and title-page
// controls. Keep it while navigating within one site so a user can select on a
// listing, open a title, and continue; wipe it only when the site namespace
// changes. The old URL-only wipe erased a perfectly valid same-site selection
// as soon as the user followed a gallery link.
let pageSite = "";
try {
    const source = getSourceForUrl(typeof location === "undefined" ? "" : location.href);
    pageSite = source ? source.site : "";
} catch (_) { /* unsupported pages simply get an empty namespace */ }

chrome.storage.local.get({
    allIds: [],
    lastUrl: "",
    allIdsSite: ""
}, function(elemsLocal: any) {
    const storedSite = String(elemsLocal && elemsLocal.allIdsSite ? elemsLocal.allIdsSite : "nhentai");
    const sameSite = storedSite === pageSite;
    chrome.storage.local.set({
        allIds: sameSite && Array.isArray(elemsLocal.allIds) ? elemsLocal.allIds : [],
        lastUrl: typeof location === "undefined" ? "" : location.href,
        allIdsSite: pageSite
    });
});

// Add the legacy caption checkboxes on nhentai listing pages. The modern
// listControls bundle is the primary UI; this remains available when the user
// turns in-page controls off and also supplies the old allIds compatibility
// path used by the panel.
chrome.storage.sync.get({
    displayCheckbox: true
}, function(elems: any) {
    chrome.storage.local.get({
        allIds: [],
        allIdsSite: pageSite
    }, function(elemsLocal: any) {
        if (!elems.displayCheckbox || String(elemsLocal.allIdsSite || pageSite) !== pageSite) return;

        const captions = document.getElementsByClassName("caption");
        if (captions.length === 0) return;

        // Extract each gallery ID from its own caption card instead of running a
        // document-wide regex matched by index against the live DOM collection.
        // On nhentai the caption sits INSIDE the gallery link.
        for (let i = 0; i < captions.length; i++) {
            const link = captions[i].closest('a[href*="/g/"]');
            if (link === null) continue;
            const match = /\/g\/([0-9]+)\//.exec(link.getAttribute("href") || "");
            if (match === null) continue;
            const id = match[1];
            if (tmpIds.includes(id)) continue;
            tmpIds.push(id);
            captions[i].innerHTML += '<span class="nhdw-legacy-check"><br/><br/><input id="' + id + '" type="checkbox" ' + (Array.isArray(elemsLocal.allIds) && elemsLocal.allIds.includes(id) ? "checked" : "") + '> NHentai Downloader:<br/>Add to downloads<br/>&nbsp;</span>';
        }

        for (let i = 0; i < tmpIds.length; i++) {
            const id = tmpIds[i];
            const checkbox = document.getElementById(id);
            if (checkbox === null) continue;
            checkbox.addEventListener("change", function() {
                chrome.storage.local.get({ allIds: [], allIdsSite: pageSite }, function(current: any) {
                    const storageAllIds: string[] = Array.isArray(current.allIds) && String(current.allIdsSite || pageSite) === pageSite
                        ? current.allIds.map(String) : [];
                    const input = document.getElementById(id) as HTMLInputElement;
                    if (input.checked) {
                        if (!storageAllIds.includes(id)) storageAllIds.push(id);
                    } else {
                        const index = storageAllIds.indexOf(id);
                        if (index !== -1) storageAllIds.splice(index, 1);
                    }
                    chrome.storage.local.set({ allIds: storageAllIds, allIdsSite: pageSite });
                });
            });
        }
    });
});
