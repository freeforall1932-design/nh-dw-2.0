import CheckBox from "./CheckBox";
import InputField from "./InputField";
import Select from "./Select";
import { verifyAndSaveApiKey, removeApiKey } from "./apiKey";
import { TEMPLATE_TOKENS, templateTokensInUse, isTokenOnlyTemplate, buildTemplate } from "./nameTemplate";
import { utils } from "../utils/utils";
import { clearHistory, countHistory, readHistory } from "../utils/downloadHistory";
import {
    formatExtension,
    isInheritedListTemplate,
    LIST_TEMPLATE_INHERIT,
    normalizeFormat,
    normalizeOutputMode,
    resolveListFormat
} from "../utils/downloadFormats";

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
    new Select("maxConcurrentDownloads"),
    new Select("rawMaxConcurrent"),
    // List mode keeps its own keys so it can never overwrite the
    // single-title defaults above.
    new Select("listFormat"),
    new Select("listOutputMode"),
    new CheckBox("listMasterFolder"),
    new Select("uiMode"),
    new CheckBox("inPageControls")
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
    maxConcurrentDownloads: "3",
    rawMaxConcurrent: "3",
    rawMasterFolder: "NHDW",
    // listFormat has NO default here on purpose: an unset key means "follow
    // the single-title format", and a "zip" default would hide that (the panel
    // would then show ZIP while list downloads used e.g. CBZ).
    listOutputMode: "separate",
    listMasterFolder: true,
    listDownloadName: LIST_TEMPLATE_INHERIT,
    uiMode: "sidepanel",
    inPageControls: true
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
    // Show the inherited list format before anything reads the select.
    const listFormatSelect = document.getElementById("listFormat") as HTMLSelectElement | null;
    if (listFormatSelect) {
        listFormatSelect.value = resolveListFormat((elems as any).listFormat, (elems as any).useZip);
    }

    initNameTemplate(elems.downloadName);

    // Master folder for raw downloads. Saved verbatim — the empty string is
    // meaningful ("no master folder"), so this cannot ride the generic
    // InputField wiring (which treats an empty field as "no change").
    const rawMasterInput = document.getElementById("rawMasterFolder") as HTMLInputElement | null;
    if (rawMasterInput) {
        rawMasterInput.value = String((elems as any).rawMasterFolder);
        rawMasterInput.addEventListener("change", () => {
            chrome.storage.sync.set({ rawMasterFolder: rawMasterInput.value.trim() });
        });
    }

    initListTemplate(elems);
})

// ---- list-mode file name ------------------------------------------------
// A separate template for list mode, defaulting to (and prefilled with) the
// single-title template. An empty field means "follow the single-title
// template"; the sentinel keeps that distinguishable from a deliberately empty
// template, which falls back to the gallery id.
function initListTemplate(elems: any) {
    const input = document.getElementById("listDownloadName") as HTMLInputElement | null;
    const previewBox = document.getElementById("listDownloadNamePreview");
    if (input === null) {
        return;
    }
    const singleTemplate = String(elems.downloadName || "{pretty}");
    const inherited = isInheritedListTemplate(elems.listDownloadName);
    input.value = inherited ? "" : String(elems.listDownloadName);
    input.placeholder = "Same as single title (" + singleTemplate + ")";

    const renderPreview = () => {
        if (previewBox === null) {
            return;
        }
        const template = input.value.trim() === "" ? singleTemplate : input.value;
        const format = normalizeFormat(
            (document.getElementById("listFormat") as HTMLSelectElement | null)?.value, "zip");
        const mode = normalizeOutputMode(
            (document.getElementById("listOutputMode") as HTMLSelectElement | null)?.value, "separate");
        const masterOn = !!(document.getElementById("listMasterFolder") as HTMLInputElement | null)?.checked;
        const masterName = String((document.getElementById("rawMasterFolder") as HTMLInputElement | null)?.value || "").trim();
        const folder = masterOn && masterName !== "" ? masterName + "/" : "";
        const rendered = utils.getDownloadName(template, "Sample Title", "Sample Title", "", "123456", []);
        const clean = utils.cleanName(rendered, !!elems.replaceSpaces, "123456");
        let text: string;
        if (mode === "batch" && format !== "raw") {
            text = "Example: Downloads/" + folder + "<listing name>" + formatExtension(format)
                + " - every selected title merged into one file";
        } else if (format === "raw") {
            text = "Example: Downloads/" + folder + clean + "/001.jpg";
        } else {
            text = "Example: Downloads/" + folder + clean + formatExtension(format);
        }
        previewBox.textContent = text;
    };

    const persist = () => {
        chrome.storage.sync.set({
            listDownloadName: input.value.trim() === "" ? LIST_TEMPLATE_INHERIT : input.value
        });
        renderPreview();
    };
    input.addEventListener("change", persist);
    input.addEventListener("input", renderPreview);
    for (const id of ["listFormat", "listOutputMode", "listMasterFolder", "rawMasterFolder"]) {
        const control = document.getElementById(id);
        if (control) {
            control.addEventListener("change", renderPreview);
        }
    }
    renderPreview();
}

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

    const renderTemplatePreview = (template: string) => {
        preview.textContent = template !== ""
            ? "File name will use: " + template
            : "Nothing checked - the file name falls back to the gallery ID.";
    };
    const saveTemplate = (template: string) => {
        chrome.storage.sync.set({ downloadName: template });
        renderTemplatePreview(template);
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
                : "Nothing checked - the file name falls back to the gallery ID.";
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
    // Preview only: opening this page must not write the template back (it
    // would fire storage.onChanged with a value nobody changed).
    renderTemplatePreview(storedTemplate);
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
    setApiKeyStatus("Verifying API key...");
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

// ---- download history ------------------------------------------------------
// The persistent "already downloaded" list lives in chrome.storage.local (see
// utils/downloadHistory.ts). Listing pages skip recorded galleries; this is
// the escape hatch that forgets everything.
const historyStatus = document.getElementById("historyStatus") as HTMLElement | null;
const clearHistoryButton = document.getElementById("clearHistory") as HTMLButtonElement | null;
if (clearHistoryButton) {
    const refreshHistoryStatus = () => {
        readHistory().then((history) => {
            if (historyStatus) {
                const n = countHistory(history);
                historyStatus.textContent = n === 0
                    ? "No downloads recorded yet."
                    : n + " gallery" + (n === 1 ? "" : "s") + " recorded in this browser.";
            }
        });
    };
    clearHistoryButton.addEventListener("click", async () => {
        if (!confirm("Clear the download history?\n\nEvery gallery will be downloaded again from the next listing, including ones you still have.")) {
            return;
        }
        clearHistoryButton.disabled = true;
        await clearHistory();
        if (historyStatus) {
            historyStatus.textContent = "Download history cleared.";
        }
        clearHistoryButton.disabled = false;
    });
    refreshHistoryStatus();
}

// Verify-before-skip + merged-name date stamp (same keys the worker reads).
const verifyBox = document.getElementById("verifyDownloadedFiles") as HTMLInputElement | null;
const dateBox = document.getElementById("batchNameDate") as HTMLInputElement | null;
if (verifyBox || dateBox) {
    chrome.storage.sync.get({ verifyDownloadedFiles: true, batchNameDate: true }, (stored: any) => {
        if (verifyBox) {
            verifyBox.checked = !stored || stored.verifyDownloadedFiles !== false;
        }
        if (dateBox) {
            dateBox.checked = !stored || stored.batchNameDate !== false;
        }
    });
    if (verifyBox) {
        verifyBox.addEventListener("change", () => {
            chrome.storage.sync.set({ verifyDownloadedFiles: verifyBox.checked });
        });
    }
    if (dateBox) {
        dateBox.addEventListener("change", () => {
            chrome.storage.sync.set({ batchNameDate: dateBox.checked });
        });
    }
}
