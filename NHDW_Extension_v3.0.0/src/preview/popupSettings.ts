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
import { clearHistory, countHistory, readHistory } from "../utils/downloadHistory";
import {
    DOWNLOAD_FORMATS,
    formatExtension,
    formatLabel,
    isInheritedListTemplate,
    LIST_TEMPLATE_INHERIT,
    normalizeFormat,
    resolveListFormat,
    normalizeOutputMode
} from "../utils/downloadFormats";

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
                ? "A key is saved - API key mode is active."
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
        keyStatus.textContent = "Verifying API key...";
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
        // persist=false is for the first paint only. buildTemplate always emits
        // the canonical order with " - " separators, so saving on render would
        // silently rewrite a template the user ordered themselves
        // ("{id} - {pretty}" -> "{pretty} - {id}") merely because they opened
        // this tab. Only an explicit checkbox change may write.
        const renderNamePreview = (persist: boolean = true) => {
            const checked: Record<string, boolean> = {};
            for (const t of TEMPLATE_TOKENS) {
                const box = document.getElementById("psTpl_" + t) as HTMLInputElement | null;
                checked[t] = !!(box && box.checked);
            }
            const template = buildTemplate(checked);
            if (persist) {
                chrome.storage.sync.set({ downloadName: template });
            }
            // Show a concrete example of the resulting file name.
            const rendered = utils.getDownloadName(template, "Sample Title", "Sample Title", "", "123456", []);
            const clean = utils.cleanName(rendered, spacesBox.checked, "123456");
            namePreview.textContent = template === ""
                ? "Nothing ticked - file name falls back to the gallery ID."
                : "Example file name: " + clean + ".zip";
        };

        for (const token of TEMPLATE_TOKENS) {
            const label = el("label");
            label.className = "psInline";
            const box = el("input");
            box.type = "checkbox";
            box.id = "psTpl_" + token;
            box.checked = !!inUse[token];
            // Explicit user action - this is the only write in this section.
            box.addEventListener("change", () => renderNamePreview(true));
            label.appendChild(box);
            label.appendChild(document.createTextNode(" " + TEMPLATE_LABELS[token]));
            checksBox.appendChild(label);
        }
        renderNamePreview(false);
    });

    renderHistorySection(container);
    renderListModeSection(container);
    renderInterfaceSection(container);
}

// ---- download history ---------------------------------------------------
// The extension remembers every gallery it downloaded successfully (in this
// browser only — never synced) so listing pages skip them on re-runs. The
// only way to re-fetch a gallery without it is the per-row "Download anyway"
// override or clearing this history.
function renderHistorySection(container: HTMLElement): void {
    const section = el("div");
    section.className = "psSection";

    const heading = el("h4");
    heading.textContent = "Download history";
    section.appendChild(heading);

    const status = el("div");
    status.className = "psStatus";
    status.id = "psHistoryStatus";
    section.appendChild(status);

    const hint = el("small");
    hint.textContent = "Galleries downloaded successfully are remembered in this browser and skipped on listing pages, so re-running a search does not download everything a second time. Each already-downloaded row has its own \"Download anyway\" link; this button forgets the whole list.";
    section.appendChild(hint);

    // Verify before skip (default on): a record alone is not proof the file
    // survived, so the worker checks chrome.downloads and re-downloads the
    // galleries whose file is gone. Off = record-only skip (fastest).
    const verifyRow = el("label");
    verifyRow.className = "psOptionRow";
    const verifyBox = el("input");
    verifyBox.type = "checkbox";
    verifyBox.id = "psVerifyDownloaded";
    verifyRow.appendChild(verifyBox);
    verifyRow.appendChild(document.createTextNode(" Check the file still exists before skipping (re-download if deleted)"));
    section.appendChild(verifyRow);

    // Date stamp for merged/batch names (default on): re-runs of the same
    // listing get search_31082026.zip instead of the same plain name; same-day
    // repeats become _part2, _part3 ...
    const dateRow = el("label");
    dateRow.className = "psOptionRow";
    const dateBox = el("input");
    dateBox.type = "checkbox";
    dateBox.id = "psBatchNameDate";
    dateRow.appendChild(dateBox);
    dateRow.appendChild(document.createTextNode(" Add the download date to merged file names (search_31082026.zip, _part2, _part3...)"));
    section.appendChild(dateRow);

    const buttonRow = el("div");
    buttonRow.className = "psButtonRow";
    const clearButton = el("button");
    clearButton.type = "button";
    clearButton.id = "psHistoryClear";
    clearButton.textContent = "Clear history";
    buttonRow.appendChild(clearButton);
    section.appendChild(buttonRow);

    container.appendChild(section);

    chrome.storage.sync.get({ verifyDownloadedFiles: true, batchNameDate: true }, (stored: any) => {
        verifyBox.checked = !stored || stored.verifyDownloadedFiles !== false;
        dateBox.checked = !stored || stored.batchNameDate !== false;
    });
    verifyBox.addEventListener("change", () => {
        chrome.storage.sync.set({ verifyDownloadedFiles: verifyBox.checked });
    });
    dateBox.addEventListener("change", () => {
        chrome.storage.sync.set({ batchNameDate: dateBox.checked });
    });

    const refreshStatus = () => {
        readHistory().then((history) => {
            const n = countHistory(history);
            status.textContent = n === 0
                ? "No downloads recorded yet."
                : n + " gallery" + (n === 1 ? "" : "s") + " recorded in this browser.";
            status.className = "psStatus " + (n === 0 ? "psStatusOff" : "psStatusOn");
        });
    };

    clearButton.addEventListener("click", async () => {
        if (!window.confirm("Clear the download history?\n\nEvery gallery will be downloaded again from the next listing, including ones you still have.")) {
            return;
        }
        clearButton.disabled = true;
        await clearHistory();
        status.textContent = "Download history cleared.";
        status.className = "psStatus psStatusOff";
        clearButton.disabled = false;
    });

    refreshStatus();
}

// ---- list mode (homepage / search / artist / tag / genre windows) -------
// List mode has its OWN format, output mode, master-folder switch and file-name
// template, stored under separate keys so changing them never touches the
// single-title settings. The template defaults to following the single-title
// one, which is what "Same as single title" expresses.
function renderListModeSection(container: HTMLElement): void {
    const section = el("div");
    section.className = "psSection";

    const heading = el("h4");
    heading.textContent = "List mode (homepage, search, artist, tag)";
    section.appendChild(heading);

    const hint = el("small");
    hint.textContent = "Defaults used when downloading from a listing page, from the in-page card buttons, or with Download all.";
    section.appendChild(hint);

    const formatRow = el("label");
    formatRow.className = "psInline";
    formatRow.appendChild(document.createTextNode("Format "));
    const formatSelect = el("select");
    formatSelect.id = "psListFormat";
    for (const format of DOWNLOAD_FORMATS) {
        const option = el("option");
        option.value = format;
        option.textContent = formatLabel(format);
        formatSelect.appendChild(option);
    }
    formatRow.appendChild(formatSelect);
    section.appendChild(formatRow);

    const modeRow = el("label");
    modeRow.className = "psInline";
    modeRow.appendChild(document.createTextNode("Output "));
    const modeSelect = el("select");
    modeSelect.id = "psListOutputMode";
    const modes = [
        { value: "separate", label: "Separate files (one per title)" },
        { value: "batch", label: "Single merged file (all titles)" }
    ];
    for (const mode of modes) {
        const option = el("option");
        option.value = mode.value;
        option.textContent = mode.label;
        modeSelect.appendChild(option);
    }
    modeRow.appendChild(modeSelect);
    section.appendChild(modeRow);

    const masterLabel = el("label");
    masterLabel.className = "psInline";
    const masterBox = el("input");
    masterBox.type = "checkbox";
    masterBox.id = "psListMasterFolder";
    masterLabel.appendChild(masterBox);
    masterLabel.appendChild(document.createTextNode(" Put list downloads in the master folder"));
    section.appendChild(masterLabel);

    const sameLabel = el("label");
    sameLabel.className = "psInline";
    const sameBox = el("input");
    sameBox.type = "checkbox";
    sameBox.id = "psListSameTemplate";
    sameLabel.appendChild(sameBox);
    sameLabel.appendChild(document.createTextNode(" File name: same as single title"));
    section.appendChild(sameLabel);

    const checksBox = el("div");
    checksBox.id = "psListTemplateChecks";
    checksBox.className = "psChecks";
    section.appendChild(checksBox);

    const preview = el("div");
    preview.className = "psStatus";
    preview.id = "psListTemplatePreview";
    section.appendChild(preview);

    container.appendChild(section);

    chrome.storage.sync.get({
        useZip: "zip",
        downloadName: "{pretty}",
        replaceSpaces: true,
        rawMasterFolder: "NHDW",
        // listFormat has NO default here on purpose: an unset key means
        // "follow the single-title format", and a "zip" default would hide that.
        listOutputMode: "separate",
        listMasterFolder: true,
        listDownloadName: LIST_TEMPLATE_INHERIT
    }, (elems: any) => {
        const singleTemplate = String(elems.downloadName || "{pretty}");
        formatSelect.value = resolveListFormat(elems.listFormat, elems.useZip);
        modeSelect.value = normalizeOutputMode(elems.listOutputMode, "separate");
        masterBox.checked = elems.listMasterFolder === undefined ? true : !!elems.listMasterFolder;
        const inherited = isInheritedListTemplate(elems.listDownloadName);
        sameBox.checked = inherited;

        const currentTemplate = () => {
            if (sameBox.checked) {
                return singleTemplate;
            }
            const checked: Record<string, boolean> = {};
            for (const token of TEMPLATE_TOKENS) {
                const box = document.getElementById("psListTpl_" + token) as HTMLInputElement | null;
                checked[token] = !!(box && box.checked);
            }
            return buildTemplate(checked);
        };

        const renderPreview = () => {
            const template = currentTemplate();
            const format = normalizeFormat(formatSelect.value, "zip");
            const rendered = utils.getDownloadName(template, "Sample Title", "Sample Title", "", "123456", []);
            const clean = utils.cleanName(rendered, !!elems.replaceSpaces, "123456");
            const folder = masterBox.checked && String(elems.rawMasterFolder || "") !== ""
                ? String(elems.rawMasterFolder) + "/"
                : "";
            if (modeSelect.value === "batch" && format !== "raw") {
                preview.textContent = "Example: Downloads/" + folder + "<listing name>" + formatExtension(format)
                    + " (every title merged into one file)";
                return;
            }
            preview.textContent = format === "raw"
                ? "Example: Downloads/" + folder + clean + "/001.jpg"
                : "Example: Downloads/" + folder + clean + formatExtension(format);
        };

        const setChecksVisible = () => {
            checksBox.hidden = sameBox.checked;
        };

        // Token checkboxes for the list-mode template, pre-filled with the
        // single-title template's tokens so the field starts where the user
        // expects it to.
        const inUse = templateTokensInUse(inherited ? singleTemplate : String(elems.listDownloadName));
        for (const token of TEMPLATE_TOKENS) {
            const label = el("label");
            label.className = "psInline";
            const box = el("input");
            box.type = "checkbox";
            box.id = "psListTpl_" + token;
            box.checked = !!inUse[token];
            box.addEventListener("change", () => {
                chrome.storage.sync.set({ listDownloadName: currentTemplate() });
                renderPreview();
            });
            label.appendChild(box);
            label.appendChild(document.createTextNode(" " + TEMPLATE_LABELS[token]));
            checksBox.appendChild(label);
        }

        formatSelect.addEventListener("change", () => {
            chrome.storage.sync.set({ listFormat: normalizeFormat(formatSelect.value, "zip") });
            renderPreview();
        });
        modeSelect.addEventListener("change", () => {
            chrome.storage.sync.set({ listOutputMode: normalizeOutputMode(modeSelect.value, "separate") });
            renderPreview();
        });
        masterBox.addEventListener("change", () => {
            chrome.storage.sync.set({ listMasterFolder: masterBox.checked });
            renderPreview();
        });
        sameBox.addEventListener("change", () => {
            chrome.storage.sync.set({
                listDownloadName: sameBox.checked ? LIST_TEMPLATE_INHERIT : currentTemplate()
            });
            setChecksVisible();
            renderPreview();
        });

        setChecksVisible();
        renderPreview();
    });
}

// ---- interface ---------------------------------------------------------
// The toolbar click either opens the hovering popup or the side panel. Both
// render THIS document, so the toggle only changes where it appears.
function renderInterfaceSection(container: HTMLElement): void {
    const section = el("div");
    section.className = "psSection";

    const heading = el("h4");
    heading.textContent = "Interface";
    section.appendChild(heading);

    const panelLabel = el("label");
    panelLabel.className = "psInline";
    panelLabel.appendChild(document.createTextNode("Toolbar click opens "));
    const panelSelect = el("select");
    panelSelect.id = "psUiMode";
    for (const mode of [
        { value: "sidepanel", label: "Side panel (dockable)" },
        { value: "popup", label: "Popup (hovering)" }
    ]) {
        const option = el("option");
        option.value = mode.value;
        option.textContent = mode.label;
        panelSelect.appendChild(option);
    }
    panelLabel.appendChild(panelSelect);
    section.appendChild(panelLabel);

    const panelHint = el("small");
    panelHint.textContent = "The side panel stays docked next to the page and can be resized; the popup closes as soon as it loses focus. Reopen the extension after changing this.";
    section.appendChild(panelHint);

    const controlsLabel = el("label");
    controlsLabel.className = "psInline";
    const controlsBox = el("input");
    controlsBox.type = "checkbox";
    controlsBox.id = "psInPageControls";
    controlsLabel.appendChild(controlsBox);
    controlsLabel.appendChild(document.createTextNode(" Download / Select buttons on listing cards"));
    section.appendChild(controlsLabel);

    const controlsHint = el("small");
    controlsHint.textContent = "Adds a Download button and a Select box to every gallery card, plus a floating bar with the selection count, so you never have to open this panel. Reload the page after changing this.";
    section.appendChild(controlsHint);

    container.appendChild(section);

    chrome.storage.sync.get({ uiMode: "sidepanel", inPageControls: true }, (elems: any) => {
        panelSelect.value = elems.uiMode === "popup" ? "popup" : "sidepanel";
        controlsBox.checked = elems.inPageControls === undefined ? true : !!elems.inPageControls;
        panelSelect.addEventListener("change", () => {
            chrome.storage.sync.set({ uiMode: panelSelect.value === "popup" ? "popup" : "sidepanel" });
        });
        controlsBox.addEventListener("change", () => {
            chrome.storage.sync.set({ inPageControls: controlsBox.checked });
        });
    });
}
