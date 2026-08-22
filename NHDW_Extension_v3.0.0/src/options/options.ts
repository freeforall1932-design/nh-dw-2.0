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

// API keys are deliberately stored separately from normal synced preferences:
// they are optional credentials, user-pasted only, and must not follow browser
// profile sync. We never display a saved key back into the page.
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const apiKeyStatus = document.getElementById("apiKeyStatus") as HTMLElement;
const saveApiKeyButton = document.getElementById("saveApiKey") as HTMLButtonElement;
const removeApiKeyButton = document.getElementById("removeApiKey") as HTMLButtonElement;

function setApiKeyStatus(message: string) {
    apiKeyStatus.textContent = message;
}

chrome.storage.local.get({ apiKey: "" }, (stored) => {
    if (stored.apiKey) {
        setApiKeyStatus("A key is saved in this browser profile.");
    } else {
        setApiKeyStatus("No API key saved. This is optional.");
    }
});

saveApiKeyButton.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        setApiKeyStatus("Paste an API key before saving.");
        return;
    }

    saveApiKeyButton.disabled = true;
    setApiKeyStatus("Verifying API key…");
    try {
        // User-Agent is a forbidden browser fetch header, so Chrome supplies
        // its own. Authorization is the documented third-party API mechanism.
        const response = await fetch("https://nhentai.net/api/v2/user", {
            headers: { "Authorization": "Key " + apiKey },
            cache: "no-store"
        });
        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }
        const profile = await response.json();
        if (!profile || typeof profile.username !== "string" || !profile.username) {
            throw new Error("The API did not return a user profile");
        }
        chrome.storage.local.set({ apiKey: apiKey }, () => {
            apiKeyInput.value = "";
            setApiKeyStatus("Key verified for " + profile.username + ".");
        });
    } catch (error) {
        setApiKeyStatus("Could not verify this key (" + String(error) + "). It was not saved.");
    } finally {
        saveApiKeyButton.disabled = false;
    }
});

removeApiKeyButton.addEventListener("click", () => {
    chrome.storage.local.remove("apiKey", () => {
        apiKeyInput.value = "";
        setApiKeyStatus("API key removed from this browser profile.");
    });
});