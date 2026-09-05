import Popup, { refreshFailedNotice } from "./popup"
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { message } from "./message";
import { renderSettings } from "./popupSettings";
import { readListSettings } from "../utils/listSettings";

let popup = Popup.getInstance();

// Popup tabs: "Download" (the preview/batch/progress UI rendered into #action)
// and "Settings" (API key + file-name template, editable on the fly without
// opening the separate options page). Switching only toggles visibility, so an
// in-progress download keeps updating #action in the background.
function initPopupTabs() {
    const tabDownload = document.getElementById("tabDownload");
    const tabSettings = document.getElementById("tabSettings");
    const actionPane = document.getElementById("action");
    const settingsPane = document.getElementById("settingsPane");
    if (!tabDownload || !tabSettings || !actionPane || !settingsPane) {
        return;
    }
    const show = (which: "download" | "settings") => {
        const isSettings = which === "settings";
        actionPane.hidden = isSettings;
        settingsPane.hidden = !isSettings;
        tabDownload.classList.toggle("active", !isSettings);
        tabSettings.classList.toggle("active", isSettings);
        if (isSettings) {
            // Re-render on every open so the saved key state and template are
            // always reflected accurately.
            renderSettings(settingsPane);
        }
    };
    tabDownload.addEventListener("click", () => show("download"));
    tabSettings.addEventListener("click", () => show("settings"));
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPopupTabs);
} else {
    initPopupTabs();
}

// index.html is rendered BOTH as the toolbar popup and as the chrome.sidePanel
// view (one document, no duplicated markup). A popup needs the fixed 500px
// width from style.css; a side panel is resized by the user, so the fixed
// width is dropped there. The active UI mode is the source of truth: when it
// is "sidepanel" the toolbar click opens the panel, so this document is one.
function applyUiModeClass() {
    try {
        chrome.storage.sync.get({ uiMode: "sidepanel" }, (elems: any) => {
            const root = document.documentElement;
            if (!root) {
                return;
            }
            if (elems && elems.uiMode === "sidepanel") {
                root.classList.add("nhdwPanel");
            } else {
                root.classList.remove("nhdwPanel");
            }
        });
    } catch (_) { /* cosmetic only */ }
}
applyUiModeClass();

// Ask the service worker (which owns the CDN config and chrome.permissions)
// whether nhentai reported image hosts the extension has no host permission
// for. If so, offer the optional https://*.nhentai.net grant from here —
// permissions.request requires a user gesture, which only this click gives.
// Downloads are never blocked by this: the worker only uses permitted hosts.
function refreshCdnNotice() {
    try {
        chrome.runtime.sendMessage({ action: "getCdnStatus" }, (status: any) => {
            const notice = document.getElementById("cdnNotice");
            if (!notice || !status || status.result !== "success"
                || !Array.isArray(status.missingOrigins) || status.missingOrigins.length === 0) {
                return;
            }
            const missingOrigins: string[] = status.missingOrigins;
            notice.innerHTML = message.cdnNotice(missingOrigins);
            notice.hidden = false;
            const grantButton = document.getElementById("buttonGrantCdn");
            if (!grantButton) {
                return;
            }
            grantButton.addEventListener("click", function() {
                const granted = (ok: boolean) => {
                    if (ok) {
                        notice.hidden = true;
                    }
                };
                try {
                    const result: any = (chrome as any).permissions.request({ origins: missingOrigins }, (ok: boolean) => {
                        granted(!!ok && !chrome.runtime.lastError);
                    });
                    if (result && typeof result.then === "function") {
                        result.then(granted).catch(() => { /* user dismissed the prompt */ });
                    }
                } catch (_) { /* permissions API unavailable: notice stays visible */ }
            });
        });
    } catch (_) { /* worker unreachable: no notice */ }
}

// Last URL the view was rendered for (side-panel mode re-renders on change).
let lastBootstrappedUrl: string | null = null;

function bootstrapForActiveTab() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if (!tabs || !tabs[0]) {
        return;
    }
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
        lastBootstrappedUrl = currUrl;
        // Independent of the download state: surface the optional host grant
        // when nhentai's CDN config reports hosts we have no permission for.
        refreshCdnNotice();
        // Galleries that failed earlier in this session (named, retryable).
        refreshFailedNotice();
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
}

bootstrapForActiveTab();

// Side-panel mode: the same document stays open while the user switches tabs
// and navigates, so the view must follow the active tab instead of rendering
// once at open time. In popup mode these events effectively never fire (the
// popup is destroyed as soon as focus leaves it), so registering them is free.
function rebootstrapIfUrlChanged() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        const url = tabs && tabs[0] ? String(tabs[0].url || "") : "";
        if (url === "" || url === lastBootstrappedUrl) {
            return;
        }
        lastBootstrappedUrl = url;
        bootstrapForActiveTab();
    });
}
try {
    chrome.tabs.onActivated.addListener(() => rebootstrapIfUrlChanged());
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.status === "complete" || changeInfo.url !== undefined) {
            if (tab && tab.active) {
                rebootstrapIfUrlChanged();
            }
        }
    });
} catch (_) { /* chrome.tabs events unavailable: single-shot popup behaviour */ }

// Display popup for many doujinshis
chrome.runtime.onMessage.addListener(function(request, _) {
    if (request.action == "getGalleries") {
        readListSettings().then((listSettings) => {
            popup.updatePreviewAll(
                request.galleries || [],
                request.currentPage || 0,
                request.maxPage || 0,
                listSettings
            );
        });
    }
});