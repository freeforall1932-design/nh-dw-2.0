/*
 * Storage- and network-free planning for chapter-based titles.
 *
 * This is not a site adapter or a download authorization check. A caller must
 * establish the chapter list, its ordering, batch evidence and ordinary reader
 * access; validate URL/redirect targets and image bytes at transfer time; and
 * never treat an unavailable, blocked or unobserved batch as expired.
 */

export interface ChapterReference {
    /** Stable within this source and series; do not derive it from a title. */
    id: string;
    label: string;
    /** Opaque reader locator. This planner does not validate or fetch it. */
    readerUrl: string;
}

export interface ChapterSeries {
    source: string;
    id: string;
    /** The order is an explicit observation, never inferred from labels. */
    order: "oldest-first" | "newest-first";
    chapters: readonly ChapterReference[];
}

export type ChapterSelection =
    | { kind: "all" }
    | { kind: "selected"; chapterIds: readonly string[] };

export type BatchEvidence =
    | { status: "not-observed" | "unverified" | "blocked" | "not-offered" }
    | {
        status: "available";
        source: string;
        seriesId: string;
        /** Opaque, non-secret candidate identity; not a signed delivery URL. */
        candidateId: string;
        /** Exactly covered chapter IDs, or null if coverage is unknown. */
        chapterIds: readonly string[] | null;
    }
    | { status: "expired"; source: string; seriesId: string };

/** Alternatives are explicitly selected; IDs are local, non-secret labels. */
export interface BatchOption {
    candidateId: string;
    evidence: BatchEvidence;
}

/** The caller must establish that options represents the complete offered set. */
export interface BatchChoices {
    status: "choices";
    options: readonly BatchOption[];
    selectedCandidateId?: string | null;
}

export type BatchReviewReason =
    | "batch-choice-required"
    | "batch-choice-not-found"
    | "batch-alternatives-unresolved"
    | "batch-not-observed"
    | "batch-unverified"
    | "batch-blocked"
    | "batch-not-offered"
    | "different-series"
    | "coverage-unknown"
    | "coverage-has-unknown-chapters"
    | "missing-selected-chapters"
    | "includes-unselected-chapters";

interface PlanBase {
    source: string;
    seriesId: string;
    /** Selected chapters in the explicitly supplied reading order. */
    chapters: ChapterReference[];
}

export type ChapterPlan =
    | (PlanBase & { kind: "use-batch"; candidateId: string })
    | (PlanBase & { kind: "separate-chapter-archives" })
    | (PlanBase & { kind: "review"; reason: BatchReviewReason; batchOptionIds?: string[] });

export interface ReaderPageReference {
    /** Unique for this observed chapter page, not a filename or title. */
    id: string;
    /** Opaque locator; no authorization, URL or image-byte validation here. */
    url: string;
    /** The caller's identity for the single page list, not an inferred mirror. */
    serverId: string;
    /** Optional observation, not a reason to discard an item automatically. */
    annotation?: string;
}

export interface ReaderPageList {
    source: string;
    seriesId: string;
    chapterId: string;
    serverId: string;
    advertisedPageCount?: number | null;
    /** Ordered by the reader or adapter, including ambiguous items. */
    pages: readonly ReaderPageReference[];
}

export interface ReaderPagePlan {
    source: string;
    seriesId: string;
    chapterId: string;
    serverId: string;
    advertisedPageCount: number | null;
    referenceCount: number;
    advertisedCountMatchesReferences: boolean | null;
    pages: ReaderPageReference[];
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function validIdentity(value: unknown): value is string {
    return nonEmptyString(value) && value === value.trim();
}

function validCandidateId(value: unknown): value is string {
    return validIdentity(value) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/**
 * Select chapters in reading order and recommend a route without doing I/O.
 *
 * Batch state and coverage must be established independently by the caller;
 * a related series' batch, an unknown/blocked host, and an unobserved batch
 * never authorize fallback. Only an explicitly expired batch belonging to the
 * same series yields the selected per-chapter route. A direct BatchEvidence
 * value represents an established sole option; use BatchChoices for an
 * independently established complete set of alternatives. Reader access remains
 * to be checked by the eventual executor. A batch that includes unselected
 * chapters, omits selected ones, or has unknown coverage needs explicit review.
 */
export function planChapterSelection(
    series: ChapterSeries,
    selection: ChapterSelection,
    batch: BatchEvidence | BatchChoices
): ChapterPlan {
    if (!series || !validIdentity(series.source) || !validIdentity(series.id)) {
        throw new Error("A source and series identity are required");
    }
    if (series.order !== "oldest-first" && series.order !== "newest-first") {
        throw new Error("Chapter ordering must be explicitly supplied");
    }
    if (!Array.isArray(series.chapters) || series.chapters.length === 0) {
        throw new Error("A non-empty chapter list is required");
    }

    const knownIds = new Set<string>();
    for (const chapter of series.chapters) {
        if (!chapter || !validIdentity(chapter.id) ||
            !nonEmptyString(chapter.label) || !nonEmptyString(chapter.readerUrl)) {
            throw new Error("Each chapter requires an identity, label and reader locator");
        }
        if (knownIds.has(chapter.id)) throw new Error("Duplicate chapter identity");
        knownIds.add(chapter.id);
    }

    let selectedIds: Set<string>;
    if (selection && selection.kind === "all") {
        selectedIds = knownIds;
    } else if (selection && selection.kind === "selected" && Array.isArray(selection.chapterIds)) {
        if (selection.chapterIds.length === 0) throw new Error("No chapters selected");
        selectedIds = new Set<string>();
        for (const id of selection.chapterIds) {
            if (!knownIds.has(id)) throw new Error("Selected chapter is not in this series");
            if (selectedIds.has(id)) throw new Error("Duplicate selected chapter");
            selectedIds.add(id);
        }
    } else {
        throw new Error("A valid chapter selection is required");
    }

    const ordered = series.chapters.slice();
    if (series.order === "newest-first") ordered.reverse();
    const chapters = ordered.filter((chapter) => selectedIds.has(chapter.id)).map((chapter) => ({
        id: chapter.id,
        label: chapter.label,
        readerUrl: chapter.readerUrl
    }));
    const base: PlanBase = { source: series.source, seriesId: series.id, chapters };

    if (!batch || typeof batch.status !== "string") throw new Error("Batch evidence is required");
    if (batch.status === "choices") {
        if (!Array.isArray(batch.options) || batch.options.length === 0) {
            throw new Error("A non-empty list of batch options is required");
        }
        const ids: string[] = [];
        for (const option of batch.options) {
            if (!option || !validCandidateId(option.candidateId) || ids.indexOf(option.candidateId) !== -1) {
                throw new Error("Batch option IDs must be unique local, non-URL identities");
            }
            ids.push(option.candidateId);
            const evidence = option.evidence;
            if (!evidence || ["not-observed", "unverified", "blocked", "not-offered", "available", "expired"].indexOf(evidence.status) === -1) {
                throw new Error("Invalid batch option evidence");
            }
            if (evidence.status === "available" && evidence.candidateId !== option.candidateId) {
                throw new Error("Batch option ID conflicts with its evidence");
            }
            // Related-series links must never become choices for this title.
            if ((evidence.status === "available" || evidence.status === "expired") &&
                (evidence.source !== series.source || evidence.seriesId !== series.id)) {
                return { ...base, kind: "review", reason: "different-series" };
            }
        }
        if (!batch.selectedCandidateId) {
            return { ...base, kind: "review", reason: "batch-choice-required", batchOptionIds: ids };
        }
        const selected = batch.options.find(option => option.candidateId === batch.selectedCandidateId);
        if (!selected) {
            // The options may have rotated since the user selected one.
            return { ...base, kind: "review", reason: "batch-choice-not-found", batchOptionIds: ids };
        }
        if (selected.evidence.status === "expired" && batch.options.some(option =>
            option.candidateId !== selected.candidateId && option.evidence.status !== "expired"
        )) {
            // One expired host does not establish that its alternatives are
            // expired. Blocked/unobserved is not expired, and an available
            // batch still has priority over separate chapter archives.
            return { ...base, kind: "review", reason: "batch-alternatives-unresolved", batchOptionIds: ids };
        }
        return planChapterSelection(series, selection, selected.evidence);
    }
    if (batch.status === "not-observed") return { ...base, kind: "review", reason: "batch-not-observed" };
    if (batch.status === "unverified") return { ...base, kind: "review", reason: "batch-unverified" };
    if (batch.status === "blocked") return { ...base, kind: "review", reason: "batch-blocked" };
    if (batch.status === "not-offered") return { ...base, kind: "review", reason: "batch-not-offered" };
    if (batch.status !== "available" && batch.status !== "expired") throw new Error("Invalid batch evidence");
    if (batch.source !== series.source || batch.seriesId !== series.id) {
        return { ...base, kind: "review", reason: "different-series" };
    }
    if (batch.status === "expired") return { ...base, kind: "separate-chapter-archives" };

    if (!validCandidateId(batch.candidateId)) {
        throw new Error("Available batch needs a local, non-URL candidate identity");
    }
    if (batch.chapterIds === null) return { ...base, kind: "review", reason: "coverage-unknown" };
    if (!Array.isArray(batch.chapterIds) || batch.chapterIds.length === 0) {
        throw new Error("Available batch coverage must be unknown or a non-empty list");
    }
    const coveredIds = new Set<string>();
    for (const id of batch.chapterIds) {
        if (!nonEmptyString(id) || coveredIds.has(id)) throw new Error("Invalid batch chapter coverage");
        coveredIds.add(id);
    }
    for (const id of coveredIds) {
        if (!knownIds.has(id)) return { ...base, kind: "review", reason: "coverage-has-unknown-chapters" };
    }
    for (const id of selectedIds) {
        if (!coveredIds.has(id)) return { ...base, kind: "review", reason: "missing-selected-chapters" };
    }
    if (coveredIds.size > selectedIds.size) {
        return { ...base, kind: "review", reason: "includes-unselected-chapters" };
    }
    return { ...base, kind: "use-batch", candidateId: batch.candidateId };
}

/**
 * Retain one caller-identified reader list in its supplied order. This does
 * not establish that a reference is an image, accessible, or complete. An
 * advertised-count mismatch is surfaced, never used to truncate the list or
 * silently classify and discard potential inserts. Reject mixed servers.
 */
export function planReaderPages(list: ReaderPageList): ReaderPagePlan {
    if (!list || !validIdentity(list.source) || !validIdentity(list.seriesId) ||
        !validIdentity(list.chapterId) || !validIdentity(list.serverId)) {
        throw new Error("Reader list requires source, series, chapter and server identities");
    }
    if (!Array.isArray(list.pages) || list.pages.length === 0) {
        throw new Error("A non-empty reader page list is required");
    }
    const advertised = list.advertisedPageCount == null ? null : list.advertisedPageCount;
    if (advertised !== null && (!Number.isSafeInteger(advertised) || advertised < 0)) {
        throw new Error("Invalid advertised page count");
    }
    const seen = new Set<string>();
    const pages: ReaderPageReference[] = [];
    for (const page of list.pages) {
        if (!page || !validIdentity(page.id) || !nonEmptyString(page.url)) {
            throw new Error("Every reader page requires an identity and locator");
        }
        if (page.serverId !== list.serverId) throw new Error("Reader page list mixes servers");
        if (seen.has(page.id)) throw new Error("Duplicate reader page identity");
        if (page.annotation !== undefined && typeof page.annotation !== "string") {
            throw new Error("Invalid reader page annotation");
        }
        seen.add(page.id);
        const copy: ReaderPageReference = { id: page.id, url: page.url, serverId: page.serverId };
        if (page.annotation !== undefined) copy.annotation = page.annotation;
        pages.push(copy);
    }
    return {
        source: list.source,
        seriesId: list.seriesId,
        chapterId: list.chapterId,
        serverId: list.serverId,
        advertisedPageCount: advertised,
        referenceCount: pages.length,
        advertisedCountMatchesReferences: advertised === null ? null : advertised === pages.length,
        pages
    };
}
