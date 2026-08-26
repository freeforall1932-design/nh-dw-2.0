import Popup from "./popup"
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { message } from "./message";

let popup = Popup.getInstance();

chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.storage.sync.get({
        darkMode: false,
        htmlParsing: false
    }, function(elems) {
        if (popup.parsing === null) {
            popup.parsing = elems.htmlParsing ? new HtmlParsing() : new ApiParsing();
        }
        if (elems.darkMode) {
            document.getElementById('htmlLight')!.id = 'htmlDark';
        }

        let currUrl = tabs[0].url as string;
        popup.url = currUrl;
        chrome.storage.local.get({
            lastUrl: ""
        }, function(elemsLocal) {
            if (elemsLocal.lastUrl !== currUrl) {
                // Reset ONLY the checkbox selection when moving between pages.
                // Never use storage.local.clear() here: it would also destroy
                // the stored API key, the gate decision and the archive
                // toggle, which must survive URL changes, browser restarts
                // and disabling/re-enabling the extension. The content script
                // resets allIds in the same targeted way.
                chrome.storage.local.remove("allIds", function() {
                    chrome.storage.local.set({
                        lastUrl: currUrl
                    });
                });
            }
            // Use message passing instead of direct background page access for Firefox private mode compatibility
            chrome.runtime.sendMessage({ action: "isDownloadFinished" }, function(response) {
                // Guard against a missing response (service worker still waking up
                // or failed to load): treat it as "no download in progress" instead
                // of throwing a TypeError before the popup renders.
                if (!response || !response.result) {
                    chrome.runtime.sendMessage({ action: "updateProgress" });
                    return;
                }
                if (response.interrupted) {
                    // A previous download died with the service worker /
                    // offscreen document. Tell the user instead of silently
                    // forgetting it, and let them dismiss the notice.
                    document.getElementById('action')!.innerHTML = message.downloadInterrupted();
                    setTimeout(() => {
                        const buttonDismiss = document.getElementById('buttonDismiss');
                        if (buttonDismiss) {
                            buttonDismiss.addEventListener('click', function() {
                                chrome.runtime.sendMessage({ action: "clearJobMarker" }, function() {
                                    popup.updatePreviewAsync(popup.url);
                                });
                            });
                        }
                    }, 0);
                    return;
                }
                // Two-mode gate: ask once for an API key (Submit key /
                // Continue without API key) before the preview renders. After
                // a decision this is a pass-through.
                popup.ensureApiGateThen(() => popup.updatePreviewAsync(currUrl));
            });
            return; // Early return as we're handling the async response above
        });
    });
});

// Display popup for many doujinshis
chrome.runtime.onMessage.addListener(function(request, _) {
    if (request.action == "getGalleries") {
        chrome.storage.sync.get({
            useZip: "zip",
            downloadName: "{pretty}",
            replaceSpaces: true
        }, function(elems) {
            popup.updatePreviewAll(
                request.galleries || [],
                request.currentPage || 0,
                request.maxPage || 0,
                elems.downloadName,
                elems.useZip,
                elems.replaceSpaces
            );
        });
    }
});