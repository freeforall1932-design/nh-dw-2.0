/* Sequential, explicit chapter-to-archive executor. IO is injected so it can
 * be tested without a browser or any live site. Each chapter is all-or-nothing. */
import { UNIVERSAL_MAX_CHAPTER_BYTES, UNIVERSAL_MAX_IMAGE_BYTES, UNIVERSAL_MAX_PAGES, identifyImage, pauseBetweenChapterRequests, UniversalChapterError } from "./universalChapter";
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
    return bytes;
}

/** Returns only after each archive is confirmed saved by the supplied IO. */
export async function runUniversalChapterBatch(
    chapters: InspectedUniversalChapter[], title: string, format: "zip" | "cbz", io: UniversalBatchIO, signal?: AbortSignal
): Promise<number> {
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
    let completed = 0;
    let fetchedPage = false;
    const directory = safeSegment(title, "Title");
    for (let i = 0; i < chapters.length; i++) {
        aborted(signal);
        const chapter = chapters[i];
        const zip = new JSZip();
        let total = 0;
        for (let j = 0; j < chapter.count; j++) {
            aborted(signal);
            if (fetchedPage) await pauseBetweenChapterRequests(signal);
            if (io.progress) io.progress("Chapter " + (i + 1) + "/" + chapters.length + ", page " + (j + 1) + "/" + chapter.count);
            const page = await io.getPage(chapter.id, j);
            fetchedPage = true;
            aborted(signal);
            const bytes = decodePage(page);
            total += bytes.length;
            if (total > UNIVERSAL_MAX_CHAPTER_BYTES) throw new UniversalChapterError("limit", "The chapter exceeds the archive size limit.");
            zip.file(String(j + 1).padStart(3, "0") + "." + page.extension, bytes);
        }
        aborted(signal);
        const blob: Blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        aborted(signal);
        const stem = String(i + 1).padStart(3, "0") + " - " + safeSegment(chapter.label, "Chapter");
        const filename = directory + "/" + stem + "." + format;
        await io.save(blob, filename, signal);
        completed++;
    }
    return completed;
}
