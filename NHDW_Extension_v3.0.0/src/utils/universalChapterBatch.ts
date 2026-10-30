/* Sequential, explicit chapter-to-archive executor. IO is injected so it can
 * be tested without a browser or any live site.
 *
 * Each chapter is normally all-or-nothing, because a silently short archive
 * looks like a complete chapter. With salvagePartial the pages that succeeded
 * are still saved, but the filename and the returned result say plainly that
 * the archive is incomplete. Throttling and access denial are never salvaged:
 * those stop the whole run so the site is not hammered. */
import { UNIVERSAL_MAX_CHAPTER_BYTES, UNIVERSAL_MAX_IMAGE_BYTES, UNIVERSAL_MAX_PAGES, identifyImage, assertUsablePage, pauseBetweenChapterRequests, retryDelay, UniversalChapterError } from "./universalChapter";
import { sanitizeArtifactFilename } from "./artifactName";

var JSZip = require("jszip");

export interface InspectedUniversalChapter {
    id: string;
    label: string;
    count: number;
    hosts: string[];
}
export interface UniversalPagePayload { base64: string; extension: string; size: number; }
export interface UniversalBatchIO {
    getPage(chapterId: string, page: number): Promise<UniversalPagePayload>;
    save(blob: Blob, filename: string, signal?: AbortSignal): Promise<void>;
    progress?(text: string): void;
}
export interface UniversalBatchOptions {
    /** Save the pages collected before a recoverable failure, clearly marked. */
    salvagePartial?: boolean;
    /** Ask again after a transient failure (never after 429/403/cancel). */
    retry?: boolean;
}

export interface ComicInfoMeta {
    series: string;
    title: string;
    number?: string | null;
    pageCount: number;
    notes?: string;
}
export interface IncompleteChapter {
    label: string;
    savedPages: number;
    expectedPages: number;
    reason: string;
}
export interface UniversalBatchResult {
    /** Archives saved after the browser confirmed completion, all pages present. */
    completed: number;
    /** Archives saved with some pages missing; the file name says so. */
    incomplete: IncompleteChapter[];
    /** Chapters dropped entirely; later chapters are still attempted. */
    failed: IncompleteChapter[];
    /** Exactly what was handed to the browser and confirmed, for progress records. */
    savedFiles: { id: string; filename: string; pages: number; complete: boolean }[];
}

// A throttled or refused site must stop the run, not be retried chapter after
// chapter. These codes come from the probe (see universalChapter.checkResponse).
const FATAL_CODES = ["rate-limit", "blocked", "cancelled"];

function errorCode(error: any): string {
    return error && typeof error.code === "string" ? error.code : "";
}

function errorText(error: any): string {
    return error && typeof error.message === "string" && error.message !== "" ? error.message : "Unknown failure";
}

function xmlEscape(value: string): string {
    return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
        // XML 1.0 forbids most control characters outright.
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** First number in a chapter label, e.g. "Chapter 36.10" -> "36.10". */
export function chapterNumberFromLabel(label: string): string | null {
    const match = /(\d+(?:\.\d+)?)/.exec(String(label || ""));
    return match ? match[1] : null;
}

/**
 * Minimal ComicInfo.xml (ComicRack schema), the file comic readers look for.
 * Only values this tool actually knows are written: no invented writer, artist,
 * genre or summary. Readers that do not understand it ignore it harmlessly.
 */
export function buildComicInfoXml(meta: ComicInfoMeta): string {
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'];
    const add = (tag: string, value: string | null | undefined): void => {
        if (value === null || value === undefined) return;
        const text = String(value).trim();
        if (text === "") return;
        lines.push("  <" + tag + ">" + xmlEscape(text) + "</" + tag + ">");
    };
    add("Title", meta.title);
    add("Series", meta.series);
    add("Number", meta.number);
    add("PageCount", String(meta.pageCount));
    add("Notes", meta.notes);
    lines.push("</ComicInfo>");
    return lines.join("\n") + "\n";
}

function safeSegment(text: string, fallback: string): string {
    const trimmed = String(text || "").replace(/[\/\\]/g, "_").slice(0, 80).trim();
    let name = sanitizeArtifactFilename(trimmed, fallback);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
    return name;
}

function aborted(signal?: AbortSignal): void {
    if (signal && signal.aborted) throw new UniversalChapterError("cancelled", "Cancelled.");
}

function decodePage(page: UniversalPagePayload): Uint8Array {
    if (!page || typeof page.base64 !== "string" || !Number.isSafeInteger(page.size) || page.size <= 0 ||
        page.size > UNIVERSAL_MAX_IMAGE_BYTES || page.base64.length > Math.ceil(UNIVERSAL_MAX_IMAGE_BYTES / 3) * 4 + 4) {
        throw new UniversalChapterError("format", "Invalid page data.");
    }
    let decoded: string;
    try { decoded = atob(page.base64); } catch (_) { throw new UniversalChapterError("format", "Invalid page data."); }
    if (decoded.length !== page.size) throw new UniversalChapterError("format", "Page size did not match the received data.");
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    if (!identifyImage(bytes) || identifyImage(bytes) !== page.extension) {
        throw new UniversalChapterError("format", "Page data has an invalid image signature.");
    }
    // Second gate: a spacer or placeholder that slipped through must not pad
    // the archive to the right page count with unusable images.
    assertUsablePage(bytes);
    return bytes;
}

/**
 * One page, with a bounded number of extra attempts for transient failures.
 * Retry is opt-in and never applies to throttling, refusal, cancellation, a
 * changed tab, an unapproved host or a stale inspection (see retryDelay).
 */
async function fetchPageWithRetry(
    io: UniversalBatchIO, chapterId: string, page: number, options: UniversalBatchOptions, signal?: AbortSignal
): Promise<UniversalPagePayload> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await io.getPage(chapterId, page);
        } catch (error) {
            aborted(signal);
            const delay = options.retry === true ? retryDelay(errorCode(error), attempt) : null;
            if (delay === null) throw error;
            if (io.progress) io.progress("Retrying page " + (page + 1) + " after " + delay + " ms");
            await pauseBetweenChapterRequests(signal, delay);
        }
    }
}

/** Returns only after each archive is confirmed saved by the supplied IO. */
export async function runUniversalChapterBatch(
    chapters: InspectedUniversalChapter[], title: string, format: "zip" | "cbz",
    io: UniversalBatchIO, signal?: AbortSignal, options: UniversalBatchOptions = {}
): Promise<UniversalBatchResult> {
    if (!Array.isArray(chapters) || chapters.length === 0 || chapters.length > 200 || (format !== "zip" && format !== "cbz")) {
        throw new UniversalChapterError("selection", "Choose one or more inspected chapters.");
    }
    const ids = new Set<string>();
    for (const chapter of chapters) {
        if (!chapter || !/^[a-z0-9-]{1,64}$/.test(chapter.id) || ids.has(chapter.id) || !chapter.label ||
            !Number.isInteger(chapter.count) || chapter.count < 1 || chapter.count > UNIVERSAL_MAX_PAGES ||
            !Array.isArray(chapter.hosts) || chapter.hosts.length === 0) {
            throw new UniversalChapterError("selection", "A chapter selection is invalid or ambiguous.");
        }
        ids.add(chapter.id);
    }
    const result: UniversalBatchResult = { completed: 0, incomplete: [], failed: [], savedFiles: [] };
    let fetchedPage = false;
    const directory = safeSegment(title, "Title");
    for (let i = 0; i < chapters.length; i++) {
        aborted(signal);
        const chapter = chapters[i];
        const zip = new JSZip();
        let total = 0;
        let savedPages = 0;
        let failure: any = null;
        for (let j = 0; j < chapter.count; j++) {
            aborted(signal);
            try {
                if (fetchedPage) await pauseBetweenChapterRequests(signal);
                if (io.progress) io.progress("Chapter " + (i + 1) + "/" + chapters.length + ", page " + (j + 1) + "/" + chapter.count);
                const page = await fetchPageWithRetry(io, chapter.id, j, options, signal);
                fetchedPage = true;
                aborted(signal);
                const bytes = decodePage(page);
                total += bytes.length;
                if (total > UNIVERSAL_MAX_CHAPTER_BYTES) throw new UniversalChapterError("limit", "The chapter exceeds the archive size limit.");
                zip.file(String(j + 1).padStart(3, "0") + "." + page.extension, bytes);
                savedPages++;
            } catch (error) {
                aborted(signal);
                const code = errorCode(error);
                // Throttling, refusal and cancellation stop everything; the
                // user's cancel must never be "salvaged" into a file.
                if (FATAL_CODES.indexOf(code) !== -1) throw error;
                failure = error;
                break;
            }
        }
        const stem = String(i + 1).padStart(3, "0") + " - " + safeSegment(chapter.label, "Chapter");
        if (format === "cbz" && (failure === null || options.salvagePartial === true && savedPages > 0)) {
            // ComicRack's ComicInfo.xml: readers show the series/chapter/page
            // count instead of "unknown". Only facts this tool knows are written.
            zip.file("ComicInfo.xml", buildComicInfoXml({
                series: title,
                title: chapter.label,
                number: chapterNumberFromLabel(chapter.label),
                pageCount: savedPages,
                notes: failure === null ? undefined : "Incomplete archive: " + savedPages + " of " + chapter.count + " pages."
            }));
        }
        if (failure === null) {
            aborted(signal);
            const blob: Blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
            aborted(signal);
            await io.save(blob, directory + "/" + stem + "." + format, signal);
            result.completed++;
            result.savedFiles.push({ id: chapter.id, filename: directory + "/" + stem + "." + format, pages: savedPages, complete: true });
            continue;
        }
        const entry: IncompleteChapter = {
            label: chapter.label,
            savedPages: savedPages,
            expectedPages: chapter.count,
            reason: errorText(failure)
        };
        if (!options.salvagePartial || savedPages === 0) {
            // Nothing usable was collected (or the user chose strict chapters):
            // report this chapter and keep going with the rest of the batch.
            result.failed.push(entry);
            if (io.progress) {
                io.progress("Chapter " + (i + 1) + "/" + chapters.length + " failed and was skipped: " + entry.reason);
            }
            continue;
        }
        aborted(signal);
        const blob: Blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        aborted(signal);
        const marker = " (incomplete " + savedPages + " of " + chapter.count + " pages)";
        await io.save(blob, directory + "/" + stem + marker + "." + format, signal);
        result.savedFiles.push({ id: chapter.id, filename: directory + "/" + stem + marker + "." + format, pages: savedPages, complete: false });
        result.incomplete.push(entry);
        if (io.progress) {
            io.progress("Chapter " + (i + 1) + "/" + chapters.length + " saved incomplete: " + savedPages + " of " + chapter.count + " pages.");
        }
    }
    return result;
}
