// Settings rendered INSIDE the toolbar popup (the "Settings" tab), so the
// user never has to open a separate options page to paste an API key or
// change the file-name template.
//
// This reuses the exact same helpers as the full options page
// (options/apiKey.ts for verify/save/remove, options/nameTemplate.ts for the
// template checkboxes), so behaviour is identical; only the location differs.
// Everything is built with createElement/textContent (never innerHTML with
// dynamic values) so a malicious title or username cannot inject markup.

import { verifyAndSaveApiKey, removeApiKey } from "../options/apiKey";
import { TEMPLATE_TOKENS, templateTokensInUse, isTokenOnlyTemplate, buildTemplate } from "../options/nameTemplate";
import { utils } from "../utils/utils";

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return document.createElement(tag);
}

// Intercept paste: some browsers offer no right-click menu on extension pages,
// which made pasting a long random key impossible.
function allowPaste(input: HTMLInputElement) {
    input.addEventListener("paste", function(event: ClipboardEvent) {
        const data = event.clipboardData ? event.clipboardData.getData("text") : "";
        if (data && data.trim().length > 0) {
            event.preventDefault();
            input.value = data.trim();
        }
    });
}

export function renderSettings(container: HTMLElement): void {
    container.textContent = ""; // clear previous render

    // ---- API key section ---------------------------------------------------
    const keySection = el("div");
    keySection.className = "psSection";

    const keyHeading = el("h4");
    keyHeading.textContent = "nhentai API key (optional)";
    keySection.appendChild(keyHeading);

    const keyStatus = el("div");
    keyStatus.className = "psStatus";
    keyStatus.id = "psApiKeyStatus";
    keySection.appendChild(keyStatus);

    const keyInput = el("input");
    keyInput.type = "password";
    keyInput.id = "psApiKeyInput";
    keyInput.placeholder = "Paste API key here (Ctrl+V)";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    allowPaste(keyInput);
    keySection.appendChild(keyInput);

    const keyButtons = el("div");
    keyButtons.className = "psButtonRow";
    const saveBtn = el("button");
    saveBtn.type = "button";
    saveBtn.id = "psApiKeySave";
    saveBtn.textContent = "Save & verify";
    const removeBtn = el("button");
    removeBtn.type = "button";
    removeBtn.id = "psApiKeyRemove";
    removeBtn.textContent = "Remove key";
    keyButtons.appendChild(saveBtn);
    keyButtons.appendChild(removeBtn);
    keySection.appendChild(keyButtons);

    const keyHint = el("small");
    keyHint.textContent = "Paste with Ctrl+V. The key is stored in this browser only and never synced. Downloads work without a key.";
    keySection.appendChild(keyHint);

    container.appendChild(keySection);

    const refreshKeyStatus = () => {
        chrome.storage.local.get({ apiKey: "" }, (stored: any) => {
            keyStatus.textContent = stored.apiKey
                ? "A key is saved \u2014 API key mode is active."
                : "No key saved. This is optional.";
            keyStatus.className = "psStatus " + (stored.apiKey ? "psStatusOn" : "psStatusOff");
        });
    };

    saveBtn.addEventListener("click", async () => {
        const apiKey = keyInput.value.trim();
        if (!apiKey) {
            keyStatus.textContent = "Paste an API key before saving.";
            keyStatus.className = "psStatus psStatusOff";
            return;
        }
        saveBtn.disabled = true;
        keyStatus.textContent = "Verifying API key\u2026";
        keyStatus.className = "psStatus";
        const result = await verifyAndSaveApiKey(apiKey, chrome.storage.local);
        if (result.ok) {
            // A saved key enters API key mode: withdraw any earlier "continue
            // without API key" gate decision.
            chrome.storage.local.remove("apiKeyGate");
            keyInput.value = "";
            keyStatus.textContent = "Key verified for " + result.username + ". Saved.";
            keyStatus.className = "psStatus psStatusOn";
        } else {
            keyStatus.textContent = "Could not verify this key (" + result.error + "). It was not saved.";
            keyStatus.className = "psStatus psStatusOff";
        }
        saveBtn.disabled = false;
    });

    removeBtn.addEventListener("click", async () => {
        await removeApiKey(chrome.storage.local);
        // Removing the key returns to open tab mode and re-arms the popup gate.
        chrome.storage.local.remove("apiKeyGate");
        keyInput.value = "";
        keyStatus.textContent = "API key removed. Back to open-tab mode.";
        keyStatus.className = "psStatus psStatusOff";
    });

    refreshKeyStatus();

    // ---- File-name template section ----------------------------------------
    const nameSection = el("div");
    nameSection.className = "psSection";

    const nameHeading = el("h4");
    nameHeading.textContent = "File name";
    nameSection.appendChild(nameHeading);

    const nameHint = el("small");
    nameHint.textContent = "Tick what the downloaded file name should contain.";
    nameSection.appendChild(nameHint);

    const checksBox = el("div");
    checksBox.id = "psTemplateChecks";
    checksBox.className = "psChecks";
    nameSection.appendChild(checksBox);

    const namePreview = el("div");
    namePreview.className = "psStatus";
    namePreview.id = "psTemplatePreview";
    nameSection.appendChild(namePreview);

    const spacesLabel = el("label");
    spacesLabel.className = "psInline";
    const spacesBox = el("input");
    spacesBox.type = "checkbox";
    spacesBox.id = "psReplaceSpaces";
    spacesLabel.appendChild(spacesBox);
    spacesLabel.appendChild(document.createTextNode(" Replace spaces with underscores"));
    nameSection.appendChild(spacesLabel);

    container.appendChild(nameSection);

    chrome.storage.sync.get({ downloadName: "{pretty}", replaceSpaces: true }, (elems: any) => {
        spacesBox.checked = !!elems.replaceSpaces;
        spacesBox.addEventListener("change", () => {
            chrome.storage.sync.set({ replaceSpaces: spacesBox.checked });
            renderNamePreview();
        });

        const storedTemplate: string = elems.downloadName;
        if (!isTokenOnlyTemplate(storedTemplate)) {
            // A custom template the checkboxes cannot represent: show it as text.
            namePreview.textContent = "Custom template in use: " + storedTemplate +
                " (edit it in the full options page)";
            return;
        }

        const inUse = templateTokensInUse(storedTemplate);
        const renderNamePreview = () => {
            const checked: Record<string, boolean> = {};
            for (const t of TEMPLATE_TOKENS) {
                const box = document.getElementById("psTpl_" + t) as HTMLInputElement | null;
                checked[t] = !!(box && box.checked);
            }
            const template = buildTemplate(checked);
            chrome.storage.sync.set({ downloadName: template });
            // Show a concrete example of the resulting file name.
            const rendered = utils.getDownloadName(template, "Sample Title", "Sample Title", "", "123456", []);
            const clean = utils.cleanName(rendered, spacesBox.checked, "123456");
            namePreview.textContent = template === ""
                ? "Nothing ticked \u2014 file name falls back to the gallery ID."
                : "Example file name: " + clean + ".zip";
        };

        for (const token of TEMPLATE_TOKENS) {
            const label = el("label");
            label.className = "psInline";
            const box = el("input");
            box.type = "checkbox";
            box.id = "psTpl_" + token;
            box.checked = !!inUse[token];
            box.addEventListener("change", renderNamePreview);
            label.appendChild(box);
            label.appendChild(document.createTextNode(" " + TEMPLATE_LABELS[token]));
            checksBox.appendChild(label);
        }
        renderNamePreview();
    });
}
