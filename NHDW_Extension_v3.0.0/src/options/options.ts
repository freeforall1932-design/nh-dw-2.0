import CheckBox from "./CheckBox";
import InputField from "./InputField";
import Select from "./Select";

let options = [
    new Select("useZip"),
    new InputField("downloadName"),
    new CheckBox("displayCheckbox"),
    new CheckBox("darkMode"),
    new Select("duplicateBehaviour"),
    new CheckBox("downloadSeparately"),
    new CheckBox("replaceSpaces"),
    new CheckBox("htmlParsing"),
    new Select("maxConcurrentDownloads")
]

chrome.storage.sync.get({
    useZip: "zip",
    downloadName: "{pretty}",
    displayCheckbox: true,
    duplicateBehaviour: "rename",
    darkMode: false,
    replaceSpaces: true,
    htmlParsing: false,
    downloadSeparately: false,
    maxConcurrentDownloads: "3"
}, function(elems) {
    options.forEach(o => {
        o.init(elems);
        document.getElementById(o.getId())!.addEventListener("change", function() {
            let value = o.update(this);
            if (value !== null) {
                let obj: Record<string, any> = {};
                obj[o.getId()] = value;
                chrome.storage.sync.set(obj);
            }
        })
    })
})

// ---- API access (optional) -------------------------------------------------
// The API key and the server-archive toggle live in chrome.storage.local:
// a secret must never sync to other devices. The same values feed the popup
// gate and the download pipeline (apiAuth.ts). An empty key field means
// open-tab mode; storing a key enters API key mode and withdraws any earlier
// "continue without API key" decision.
function setApiKeyStatus(hasKey: boolean) {
    const status = document.getElementById("apiKeyStatus");
    if (status) {
        status.textContent = hasKey
            ? "Key saved \u2014 API key mode active (official API)."
            : "No key \u2014 open tab mode (metadata is read from your open NHentai tab).";
    }
}

chrome.storage.local.get({ apiKey: "", useServerArchive: false }, function(localElems: any) {
    const keyInput = document.getElementById("apiKey") as HTMLInputElement | null;
    const clearButton = document.getElementById("apiKeyClear");
    const archiveToggle = document.getElementById("useServerArchive") as HTMLInputElement | null;

    if (keyInput) {
        keyInput.value = localElems.apiKey || "";
        keyInput.addEventListener("change", function() {
            const value = keyInput.value.trim();
            chrome.storage.local.set({ apiKey: value }, function() {
                if (value.length > 0) {
                    chrome.storage.local.remove("apiKeyGate");
                }
                setApiKeyStatus(value.length > 0);
            });
        });
    }
    if (clearButton && keyInput) {
        clearButton.addEventListener("click", function() {
            keyInput.value = "";
            chrome.storage.local.remove(["apiKey", "apiKeyGate"], function() {
                setApiKeyStatus(false);
            });
        });
    }
    if (archiveToggle) {
        archiveToggle.checked = !!localElems.useServerArchive;
        archiveToggle.addEventListener("change", function() {
            chrome.storage.local.set({ useServerArchive: archiveToggle.checked });
        });
    }
    setApiKeyStatus(!!(localElems.apiKey && String(localElems.apiKey).trim().length > 0));
});