// Single shared registry for the download output formats and the
// separate-vs-batch output mode.
//
// Why this file exists: list mode (homepage / search / artist / tag / genre
// windows) used to hard-code "zip" and had no way to pick an output shape,
// while the single-title popup had its own private picker. Two code paths for
// the same concept drift. Everything that offers a format or an output mode -
// the single-title popup, the list panel, the in-page card controls, the
// options page, the service worker and the offscreen document - now agrees on
// the definitions below.
//
// This module is intentionally dependency-free (no chrome.*, no DOM) so it can
// be imported from every context, including the offscreen document and the
// content scripts, and unit-tested without a browser.

export type DownloadFormat = "zip" | "cbz" | "pdf" | "raw";
export type OutputMode = "separate" | "batch";

export const DOWNLOAD_FORMATS: ReadonlyArray<DownloadFormat> = ["zip", "cbz", "pdf", "raw"];
export const OUTPUT_MODES: ReadonlyArray<OutputMode> = ["separate", "batch"];

// Short labels for pickers.
export const FORMAT_LABELS: Record<DownloadFormat, string> = {
    zip: "ZIP",
    cbz: "CBZ",
    pdf: "PDF",
    raw: "Raw images"
};

// Longer, self-explaining labels used where there is room (settings pages).
export const FORMAT_DESCRIPTIONS: Record<DownloadFormat, string> = {
    zip: "ZIP archive of the original images",
    cbz: "CBZ archive (comic reader format)",
    pdf: "PDF document, one image per page",
    raw: "Raw images in a folder per title (no archive)"
};

// Raw is still being validated on real browsers (see the open items in
// SESSION_HANDOFF.md). It is shipped enabled but labelled, so the user knows
// which option is the one under test instead of finding it silently missing.
export const RAW_IS_EXPERIMENTAL = true;

export function formatLabel(format: DownloadFormat): string {
    const label = FORMAT_LABELS[format];
    if (format === "raw" && RAW_IS_EXPERIMENTAL) {
        return label + " (testing)";
    }
    return label;
}

// "folder" was the retired image-folder mode; PDF replaced it. Every stored
// setting, relayed job option and popup override maps it across here so the
// mapping can never be forgotten in one of the call sites.
export function normalizeFormat(value: any, fallback: DownloadFormat = "zip"): DownloadFormat {
    const text = value === "folder" ? "pdf" : String(value === undefined || value === null ? "" : value);
    return (DOWNLOAD_FORMATS as ReadonlyArray<string>).indexOf(text) !== -1
        ? (text as DownloadFormat)
        : fallback;
}

// A per-job format override (popup picker, list-mode bar, in-page card
// controls, retry job). An unrecognized value must stay undefined so the
// stored default wins, rather than silently becoming zip.
export function normalizeFormatOverride(value: any): DownloadFormat | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const normalized = normalizeFormat(value, "zip");
    return (value === "folder" || normalized === value) ? normalized : undefined;
}

// THE ONE PLACE a job's output format is decided: a per-job override wins,
// then the stored default, then zip.
//
// Why this exists (backlog item 33): the batch record/retry format and the
// format the Downloader actually used were derived at different points from
// different inputs, so a caller that omits `formatOverride` could get a
// history record saying `.zip` while the file on disk is `.cbz`/`.pdf`/a raw
// folder - which then makes "verify before skip" search for a file that does
// not exist and re-download the gallery on every listing run.
//
// Rule: resolve ONCE at job start, then hand the SAME normalized value to
// every consumer (history records, retry jobs, merged artifact names,
// Downloader settings). Never re-derive it downstream.
export function resolveJobFormat(override: any, stored?: any): DownloadFormat {
    const resolvedOverride = normalizeFormatOverride(override);
    if (resolvedOverride !== undefined) {
        return resolvedOverride;
    }
    return normalizeFormat(stored, "zip");
}

export function normalizeOutputMode(value: any, fallback: OutputMode = "separate"): OutputMode {
    const text = String(value === undefined || value === null ? "" : value);
    return (OUTPUT_MODES as ReadonlyArray<string>).indexOf(text) !== -1
        ? (text as OutputMode)
        : fallback;
}

// File extension appended to the produced artifact. Raw mode writes loose
// image files into a folder, so it contributes no extension of its own.
export function formatExtension(format: DownloadFormat): string {
    return format === "raw" ? "" : "." + format;
}

// Raw mode cannot be merged: there is no container to merge into. A "batch"
// request for raw therefore resolves to one folder per title, which is what
// the user asked for anyway.
export function supportsBatchMerge(format: DownloadFormat): boolean {
    return format !== "raw";
}

// The output mode actually used by the download pipeline once the format's own
// constraints are applied. Call this instead of reading the stored value
// directly, so raw can never be routed into the shared-archive branch.
export function effectiveOutputMode(format: DownloadFormat, mode: OutputMode): OutputMode {
    return supportsBatchMerge(format) ? mode : "separate";
}

// The pipeline speaks "downloadSeparately"; the UI speaks "output mode".
export function outputModeToSeparate(format: DownloadFormat, mode: OutputMode): boolean {
    return effectiveOutputMode(format, mode) === "separate";
}

// Hard requirement: never merge DIFFERENT titles into one PDF by accident.
// Batch PDF concatenates every selected gallery into one continuous document
// (a tankoubon of unrelated works) and the titles cannot be split afterwards.
export function shouldWarnPdfMerge(format: DownloadFormat, mode: OutputMode, titleCount: number): boolean {
    return format === "pdf"
        && effectiveOutputMode(format, mode) === "batch"
        && Number(titleCount) > 1;
}

// The "don't warn me again" checkbox is scoped to THIS combination only
// (pdf + batch + more than one title), never to warnings in general.
export const PDF_MERGE_WARNING_KEY = "pdfMergeWarnDismissed";

// ---- list-mode name template ------------------------------------------
// List mode gets its own filename template, pre-filled with (and by default
// following) the single-title template. The sentinel keeps "follow the
// single-title template" distinguishable from the legitimately empty template
// ("nothing ticked" -> fall back to the gallery id).
export const LIST_TEMPLATE_INHERIT = "@inherit";

export function isInheritedListTemplate(value: any): boolean {
    return value === undefined || value === null || value === LIST_TEMPLATE_INHERIT;
}

export function resolveListTemplate(listTemplate: any, singleTemplate: string): string {
    return isInheritedListTemplate(listTemplate) ? String(singleTemplate) : String(listTemplate);
}

// ---- storage defaults --------------------------------------------------
// List-mode settings live under their own keys so changing them can never
// alter the single-title defaults (and vice versa).
export const LIST_MODE_DEFAULTS = {
    listFormat: "zip",
    listOutputMode: "separate",
    listMasterFolder: true,
    listDownloadName: LIST_TEMPLATE_INHERIT
};
