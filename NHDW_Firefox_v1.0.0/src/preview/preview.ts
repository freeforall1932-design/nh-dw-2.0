import Popup from "./popup"
import ApiParsing from "../parsing/ApiParsing";
import HtmlParsing from "../parsing/HtmlParsing";
import { message } from "./message";
import { renderSettings } from "./popupSettings";

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

// ---- mobile bottom action bar (coarse-pointer devices ONLY) ---------------
// Desktop/mobile separation rule: the desktop popup DOM must stay
// byte-identical to the classic layout, so no markup restructuring happens
// for fine-pointer environments. On phone-width touch devices (Firefox for
// Android opens this document in a full tab) the primary buttons of the
// CURRENT popup state are relocated at runtime into a fixed bottom footer —
// the same idiom as the in-page .nhdw-action-bar — and a MutationObserver
// reapplies the relocation after every innerHTML swap of a popup state.
const MOBILE_BAR_MEDIA = "(max-width: 640px) and (pointer: coarse)";
const MOBILE_BAR_BUTTON_IDS: string[] = [
    "button", "buttonAll", "buttonBack", "buttonPause", "buttonResume",
    "buttonClearQueue", "buttonDismiss", "apiKeySubmit", "apiKeySkip",
    "buttonGrantCdn", "buttonGrantHosts"
];

function mobileLayoutMatches(): boolean {
    try {
        return typeof window.matchMedia === "function"
            && window.matchMedia(MOBILE_BAR_MEDIA).matches;
    } catch (_) {
        return false;
    }
}

let barObserver: MutationObserver | null = null;

function relocateMobileActions() {
    if (!mobileLayoutMatches()) {
        return; // desktop / fine pointer: DOM stays exactly as rendered
    }
    let bar = document.getElementById("nhdwMobileBar") as HTMLElement | null;
    const outside: HTMLElement[] = [];
    for (const id of MOBILE_BAR_BUTTON_IDS) {
        const el = document.getElementById(id) as HTMLElement | null;
        if (el && (!bar || (el !== bar && !bar.contains(el)))) {
            outside.push(el);
        }
    }
    if (!bar) {
        if (outside.length === 0) {
            return; // nothing to dock; do not create an empty footer
        }
        bar = document.createElement("div");
        bar.id = "nhdwMobileBar";
        document.body.appendChild(bar);
    }
    // Suspend the observer around our own mutations so re-docking cannot
    // retrigger it in a loop.
    if (barObserver) {
        barObserver.disconnect();
    }
    bar.textContent = "";
    for (const el of outside) {
        bar.appendChild(el);
    }
    bar.style.display = bar.children.length > 0 ? "" : "none";
    if (barObserver) {
        barObserver.observe(document.body, { childList: true, subtree: true });
    }
}

let mobileBarScheduled = false;
function scheduleMobileBarRelocation() {
    if (mobileBarScheduled) {
        return;
    }
    mobileBarScheduled = true;
    setTimeout(() => {
        mobileBarScheduled = false;
        relocateMobileActions();
    }, 0);
}

function installMobileActionBar() {
    if (typeof MutationObserver === "undefined") {
        return;
    }
    barObserver = new MutationObserver(scheduleMobileBarRelocation);
    barObserver.observe(document.body, { childList: true, subtree: true });
    try {
        window.matchMedia(MOBILE_BAR_MEDIA).addEventListener("change", () => {
            // Rebuild the whole document for the new layout class instead of
            // trying to un-dock buttons into positions a re-render owns.
            window.location.reload();
        });
    } catch (_) { /* ancient matchMedia without addEventListener: ignore */ }
    scheduleMobileBarRelocation();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installMobileActionBar);
} else {
    installMobileActionBar();
}

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

// Firefox MV3 does NOT grant host_permissions at install time — they behave
// like optional permissions until the user approves them (on Firefox for
// Android the grant prompt appears only when requested). Without the base
// nhentai.net grant nothing works, so show a one-tap grant notice on first
// runs. No-op on Chrome / already-granted installs (contains() is true).
const BASE_HOST_ORIGINS: string[] = [
    "https://nhentai.net/*",
    "https://i.nhentai.net/*",
    "https://i1.nhentai.net/*",
    "https://i2.nhentai.net/*",
    "https://i3.nhentai.net/*",
    "https://i4.nhentai.net/*"
];

function refreshHostNotice() {
    try {
        const permissions: any = (chrome as any).permissions;
        if (!permissions || typeof permissions.contains !== "function") {
            return;
        }
        permissions.contains({ origins: BASE_HOST_ORIGINS }, (hasHosts: boolean) => {
            if (chrome.runtime.lastError || hasHosts === true) {
                return;
            }
            const notice = document.getElementById("hostNotice");
            if (!notice) {
                return;
            }
            notice.innerHTML = message.hostGrantNotice(BASE_HOST_ORIGINS);
            notice.hidden = false;
            const grantButton = document.getElementById("buttonGrantHosts");
            if (!grantButton) {
                return;
            }
            grantButton.addEventListener("click", function() {
                const granted = (ok: boolean) => {
                    if (ok) {
                        // Re-run the whole popup flow with hosts now granted
                        // (metadata fetches go through the tab + host perms).
                        window.location.reload();
                    }
                };
                try {
                    const result: any = permissions.request({ origins: BASE_HOST_ORIGINS }, (ok: boolean) => {
                        granted(!!ok && !chrome.runtime.lastError);
                    });
                    if (result && typeof result.then === "function") {
                        result.then(granted).catch(() => { /* user dismissed the prompt */ });
                    }
                } catch (_) { /* permissions API unavailable: notice stays visible */ }
            });
        });
    } catch (_) { /* best effort only */ }
}

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
        // Independent of the download state: surface the optional host grant
        // when nhentai's CDN config reports hosts we have no permission for.
        refreshCdnNotice();
        refreshHostNotice();
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