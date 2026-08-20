chrome.storage.sync.get({
    displayCheckbox: true
}, function(elems) {
    chrome.storage.local.get({
        allIds: []
    }, function(elemsLocal) {
        if (!elems.displayCheckbox) return;

        const captions = document.getElementsByClassName("caption");
        if (captions.length === 0) return; // Nothing to re-check on a single-gallery page

        // Walk each caption card and update the matching checkbox by gallery ID,
        // scoped to the card's own gallery link. The caption sits INSIDE the
        // link on nhentai, so the link is found with closest(), not querySelector().
        for (let i = 0; i < captions.length; i++) {
            const link = captions[i].closest('a[href*="/g/"]');
            if (link === null) continue;
            const match = /\/g\/([0-9]+)\//.exec(link.getAttribute("href") || "");
            if (match === null) continue;
            const checkbox = document.getElementById(match[1]);
            if (checkbox !== null) {
                (checkbox as HTMLInputElement).checked = elemsLocal.allIds.includes(match[1]);
            }
        }
    });
});
