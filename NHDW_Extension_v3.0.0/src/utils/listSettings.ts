// Reading and persisting the list-mode download settings.
//
// List mode = every listing window (homepage, search, artist, tag, group,
// character, language, favourites...). It now has its own format, its own
// output mode (separate files vs one merged file), its own optional master
// folder and its own filename template, stored under dedicated keys so the
// single-title settings are never touched.
//
// Used by the popup / side panel, the in-page card controls and the options
// page, so all three always agree.

import {
    DownloadFormat,
    OutputMode,
    LIST_MODE_DEFAULTS,
    normalizeOutputMode,
    resolveListFormat,
    resolveListTemplate,
    PDF_MERGE_WARNING_KEY
} from "./downloadFormats";

export interface ListModeSettings {
    format: DownloadFormat;
    outputMode: OutputMode;
    /** Wrap every produced file/folder in the master folder (optional, not forced). */
    masterFolder: boolean;
    /** Name of the master folder, shared with the raw-download setting. */
    masterFolderName: string;
    /** Raw stored value; LIST_TEMPLATE_INHERIT means "follow the single-title template". */
    storedTemplate: string;
    /** The template actually used to name list-mode files. */
    template: string;
    /** The single-title template, for the "same as single title" UI state. */
    singleTemplate: string;
    replaceSpaces: boolean;
    /** "don't warn me again" for pdf + batch + several titles ONLY. */
    pdfMergeWarnDismissed: boolean;
    /** Verify the recorded file still exists before skipping (default on). */
    verifyDownloadedFiles: boolean;
    /** Add _DDMMYYYY to merged/batch names (default on). */
    batchNameDate: boolean;
}

const SYNC_DEFAULTS = Object.assign({
    // Single-title settings we need for inheritance / preview only.
    useZip: "zip",
    downloadName: "{pretty}",
    replaceSpaces: true,
    rawMasterFolder: "NHDW",
    // History verification + merged-name date stamp (see downloadHistory.ts).
    verifyDownloadedFiles: true,
    batchNameDate: true
}, LIST_MODE_DEFAULTS);

// Pure mapper: stored values -> resolved list-mode settings. Exported for the
// unit tests (no chrome.* involved).
export function buildListSettings(stored: any, pdfMergeWarnDismissed: boolean = false): ListModeSettings {
    const source = stored || {};
    const storedTemplate = source.listDownloadName === undefined
        ? LIST_MODE_DEFAULTS.listDownloadName
        : String(source.listDownloadName);
    const singleTemplate = String(source.downloadName === undefined ? "{pretty}" : source.downloadName);
    return {
        // The list format defaults to the single-title format the first time,
        // then remembers its own value under its own key.
        format: resolveListFormat(source.listFormat, source.useZip),
        // Separate files is the DEFAULT in list mode; batch is the opt-in.
        outputMode: normalizeOutputMode(source.listOutputMode, "separate"),
        masterFolder: source.listMasterFolder === undefined ? true : !!source.listMasterFolder,
        masterFolderName: String(source.rawMasterFolder === undefined ? "NHDW" : source.rawMasterFolder),
        storedTemplate: storedTemplate,
        template: resolveListTemplate(storedTemplate, singleTemplate),
        singleTemplate: singleTemplate,
        replaceSpaces: source.replaceSpaces === undefined ? true : !!source.replaceSpaces,
        pdfMergeWarnDismissed: !!pdfMergeWarnDismissed,
        verifyDownloadedFiles: source.verifyDownloadedFiles === undefined ? true : !!source.verifyDownloadedFiles,
        batchNameDate: source.batchNameDate === undefined ? true : !!source.batchNameDate
    };
}

export function readListSettings(): Promise<ListModeSettings> {
    return new Promise((resolve) => {
        let synced: any = SYNC_DEFAULTS;
        const done = (dismissed: boolean) => resolve(buildListSettings(synced, dismissed));
        try {
            chrome.storage.sync.get(SYNC_DEFAULTS, (elems: any) => {
                synced = elems || SYNC_DEFAULTS;
                try {
                    // The dismissal flag is a local UI preference, not a synced
                    // download setting.
                    const localDefaults: any = {};
                    localDefaults[PDF_MERGE_WARNING_KEY] = false;
                    chrome.storage.local.get(localDefaults, (localElems: any) => {
                        done(!!(localElems && localElems[PDF_MERGE_WARNING_KEY]));
                    });
                } catch (_) {
                    done(false);
                }
            });
        } catch (_) {
            done(false);
        }
    });
}

// Persist the last-used list-mode choices. Only the given keys are written, so
// this never disturbs the single-title settings.
export function saveListSettings(patch: Partial<{
    listFormat: DownloadFormat;
    listOutputMode: OutputMode;
    listMasterFolder: boolean;
    listDownloadName: string;
    verifyDownloadedFiles: boolean;
    batchNameDate: boolean;
}>): void {
    try {
        chrome.storage.sync.set(patch as any);
    } catch (_) { /* settings are best-effort; a failed write must not block a download */ }
}

export function setPdfMergeWarningDismissed(dismissed: boolean): void {
    try {
        const patch: any = {};
        patch[PDF_MERGE_WARNING_KEY] = !!dismissed;
        chrome.storage.local.set(patch);
    } catch (_) { /* best effort */ }
}

// The master folder the job should use, or "" when the user unticked the
// optional wrap. Shared by archives and raw downloads so both obey one switch.
export function resolveMasterFolder(settings: ListModeSettings): string {
    return settings.masterFolder ? settings.masterFolderName : "";
}
