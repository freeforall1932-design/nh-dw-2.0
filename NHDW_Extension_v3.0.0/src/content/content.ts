let tmpIds : Array<string> = [];

chrome.storage.local.get({
    allIds: [],
    lastUrl: ""
}, function(elemsLocal) {
    if (elemsLocal.lastUrl != location.href)
    {
        chrome.storage.local.set({
            allIds: [],
            lastUrl: location.href
        });
    }
});

// Add checkboxes on listing pages so galleries can be queued from the popup.
chrome.storage.sync.get({
    displayCheckbox: true
}, function(elems) {
    chrome.storage.local.get({
        allIds: []
    }, function(elemsLocal) {
        if (!elems.displayCheckbox) return;

        // Single-gallery pages have no caption cards; nothing to do there.
        const captions = document.getElementsByClassName("caption");
        if (captions.length === 0) return;

        // Extract each gallery ID from its own caption card instead of running a
        // document-wide regex matched by index against the live DOM collection.
        // On nhentai the caption sits INSIDE the gallery link
        // (<a class="cover" href="/g/123/"><div class="caption">...), so the
        // link is found with closest() (ancestor walk), not querySelector().
        for (let i = 0; i < captions.length; i++) {
            const link = captions[i].closest('a[href*="/g/"]');
            if (link === null) continue;
            const match = /\/g\/([0-9]+)\//.exec(link.getAttribute("href") || "");
            if (match === null) continue;
            const id = match[1];
            if (tmpIds.includes(id)) continue; // The same gallery can appear on several cards
            tmpIds.push(id);
            // Wrapped in .nhdw-legacy-check so the newer in-page card
            // controls (js/listControls.js) can hide this duplicate selection
            // affordance while they are enabled, without removing it for users
            // who turn those controls off.
            captions[i].innerHTML += '<span class="nhdw-legacy-check"><br/><br/><input id="' + id + '" type="checkbox" ' + (elemsLocal.allIds.includes(id) ? "checked" : "") + '> NHentai Downloader:<br/>Add to downloads<br/>&nbsp;</span>';
        }

        // Foreach popups we listen for change
        for (let i = 0; i < tmpIds.length; i++) {
            let id = tmpIds[i];
            const checkbox = document.getElementById(id);
            if (checkbox === null) continue;
            checkbox.addEventListener('change', function() {
                chrome.storage.local.get({
                    allIds: []
                }, function(elemsLocal) {
                    let storageAllIds = elemsLocal.allIds;
                    if ((document.getElementById(id) as HTMLInputElement).checked) {
                        if (!storageAllIds.includes(id)) {
                            storageAllIds.push(id);
                        }
                    } else {
                        let index = storageAllIds.indexOf(id);
                        if (index !== -1) {
                            storageAllIds.splice(index, 1);
                        }
                    }
                    chrome.storage.local.set({
                        allIds: storageAllIds
                    });
                });
            });
        }
    });
});
