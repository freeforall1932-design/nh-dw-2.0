import CheckBox from "./CheckBox";
import InputField from "./InputField";
import Select from "./Select";
import { verifyAndSaveApiKey, removeApiKey } from "./apiKey";
import { TEMPLATE_TOKENS, templateTokensInUse, isTokenOnlyTemplate, buildTemplate } from "./nameTemplate";

// downloadName is handled below by the template checkboxes (with a manual
// fallback for custom templates), so it is NOT in this generic list.
let options = [
    new Select("useZip"),
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
    initNameTemplate(elems.downloadName);
})

// ---- name template: checkboxes instead of manual typing --------------------
// The stored value stays a placeholder string ("{pretty} - {id}"), so the
// download engine and previously saved templates are unaffected.
const TEMPLATE_LABELS: Record<string, string> = {
    pretty: "Pretty title (short)",
    english: "English title",
    japanese: "Japanese title",
    id: "Gallery ID",
    group: "Group / circle",
    artist: "Artist",
    character: "Characters",
    language: "Language"
};

function initNameTemplate(storedTemplate: string) {
    const checksBox = document.getElementById("downloadNameChecks");
    const preview = document.getElementById("downloadNamePreview");
    const advancedBox = document.getElementById("downloadNameAdvanced");
    const advancedInput = document.getElementById("downloadName") as HTMLInputElement | null;
    if (!checksBox || !preview || !advancedBox || !advancedInput) {
        return;
    }

    const saveTemplate = (template: string) => {
        chrome.storage.sync.set({ downloadName: template });
        preview.textContent = template !== ""
            ? "File name will use: " + template
            : "Nothing checked \u2014 the file name falls back to the gallery ID.";
    };

    if (!isTokenOnlyTemplate(storedTemplate)) {
        // A custom template the checkboxes cannot represent: keep the manual
        // input so nothing is lost.
        checksBox.style.display = "none";
        advancedBox.style.display = "";
        advancedInput.value = storedTemplate;
        preview.textContent = "Custom template in use: " + storedTemplate;
        advancedInput.addEventListener("change", function() {
            saveTemplate(advancedInput.value);
            preview.textContent = advancedInput.value.trim() !== ""
                ? "Custom template in use: " + advancedInput.value
                : "Nothing checked \u2014 the file name falls back to the gallery ID.";
        });
        return;
    }

    advancedBox.style.display = "none";
    const inUse = templateTokensInUse(storedTemplate);
    for (const token of TEMPLATE_TOKENS) {
        const id = "template_" + token;
        const wrapper = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.id = id;
        box.checked = !!inUse[token];
        wrapper.appendChild(box);
        wrapper.appendChild(document.createTextNode(" " + TEMPLATE_LABELS[token]));
        checksBox.appendChild(wrapper);
        checksBox.appendChild(document.createElement("br"));
        box.addEventListener("change", function() {
            const checked: Record<string, boolean> = {};
            for (const t of TEMPLATE_TOKENS) {
                const el = document.getElementById("template_" + t) as HTMLInputElement | null;
                checked[t] = !!(el && el.checked);
            }
            saveTemplate(buildTemplate(checked));
        });
    }
    saveTemplate(storedTemplate); // renders the preview line
}

// ---- API key ---------------------------------------------------------------
// API keys are optional credentials, user-pasted only, and must not follow
// browser profile sync. We never display a saved key back into the page.
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const apiKeyStatus = document.getElementById("apiKeyStatus") as HTMLElement;
const saveApiKeyButton = document.getElementById("saveApiKey") as HTMLButtonElement;
const removeApiKeyButton = document.getElementById("removeApiKey") as HTMLButtonElement;

// Some browsers do not offer a right-click menu on extension pages, which
// made pasting a long random key impossible for users who type slowly.
// Intercept paste explicitly and fill the field from the clipboard text.
function allowPaste(input: HTMLInputElement) {
    input.addEventListener("paste", function(event: ClipboardEvent) {
        const data = event.clipboardData ? event.clipboardData.getData("text") : "";
        if (data && data.trim().length > 0) {
            event.preventDefault();
            input.value = data.trim();
            input.dispatchEvent(new Event("change"));
        }
    });
}
allowPaste(apiKeyInput);

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
    setApiKeyStatus("Verifying API key\u2026");
    // User-Agent is a forbidden browser fetch header, so Chrome supplies its
    // own. Authorization is the documented third-party API mechanism.
    const result = await verifyAndSaveApiKey(apiKey, chrome.storage.local);
    if (result.ok) {
        // A saved key enters API key mode: withdraw any earlier
        // "continue without API key" gate decision.
        chrome.storage.local.remove("apiKeyGate");
        apiKeyInput.value = "";
        setApiKeyStatus("Key verified for " + result.username + ".");
    } else {
        setApiKeyStatus("Could not verify this key (" + result.error + "). It was not saved.");
    }
    saveApiKeyButton.disabled = false;
});

removeApiKeyButton.addEventListener("click", async () => {
    await removeApiKey(chrome.storage.local);
    // Removing the key returns to open tab mode and re-arms the popup gate.
    chrome.storage.local.remove("apiKeyGate");
    apiKeyInput.value = "";
    setApiKeyStatus("API key removed from this browser profile.");
});

// One-shot server archive downloads (optional, keyed mode only).
const archiveToggle = document.getElementById("useServerArchive") as HTMLInputElement | null;
if (archiveToggle) {
    chrome.storage.local.get({ useServerArchive: false }, (localElems: any) => {
        archiveToggle.checked = !!localElems.useServerArchive;
    });
    archiveToggle.addEventListener("change", function() {
        chrome.storage.local.set({ useServerArchive: archiveToggle.checked });
    });
}
