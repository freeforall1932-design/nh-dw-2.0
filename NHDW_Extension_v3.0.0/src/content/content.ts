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

// Add checkbox on pages that have multiple doujins so we can tick them here and then download everything
// TODO: going on another doujin page and coming back will let the checked box on the page even if they aren't on the extension
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
            captions[i].innerHTML += '<br/><br/><input id="' + id + '" type="checkbox" ' + (elemsLocal.allIds.includes(id) ? "checked" : "") + '> NHentai Downloader:<br/>Add to downloads<br/>&nbsp;';
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
