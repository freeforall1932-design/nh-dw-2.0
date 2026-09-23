// Export / import of the two local stores that make this extension feel
// personal: the bookmark queue and the download history.
//
// Why a separate, pure module: the file format is the one thing here that must
// stay readable and stable for years, and it has to be validated on the way IN
// (that JSON may come from any file the user picks). Both directions are pure
// functions over plain data — no chrome, no DOM, no storage — so the contract
// is unit-testable in Node:
//
//   buildTransferPayload(...)   state -> the exact JSON text we write out
//   parseTransferPayload(...)   text  -> validated pieces, or a reason why not
//   mergeImportedBookmarks(...) policy: union, local wins
//   mergeImportedHistory(...)   policy: union, local wins
//
// The merge rules matter more than the format:
//   * Bookmarks: rows only the file has are added; rows that exist locally keep
//     their status, filename, error and selection. Importing a file must never
//     turn a finished row back into "saved", and never lose the file name this
//     machine already recorded. Order: imported rows the user has never seen are
//     APPENDED, so the current queue order (which is the download order) is not
//     rearranged by an import.
//   * History: same idea, local record wins, so a machine that really has the
//     file keeps saying so.
//   * Nothing is ever deleted by an import. There is no "replace" mode on
//     purpose: a wrong file must not be able to wipe the list.

import { BookmarkState, normalizeBookmarkState } from "./bookmarkQueue";
import { toGalleryKey } from "./siteKeys";
import { DownloadHistory, DownloadRecord, normalizeHistory } from "./downloadHistory";

/** Marker so a wrong JSON file is rejected with a useful message. */
export const TRANSFER_APP_ID = "nh-downloader-transfer";
export const TRANSFER_VERSION = 1;

export interface TransferPayload {
    app: string;
    version: number;
    exportedAt: string;
    bookmarkCount: number;
    historyCount: number;
    bookmarks: BookmarkState;
    history: DownloadHistory;
}

export interface ParsedTransfer {
    ok: boolean;
    /** Human-readable reason when ok is false. */
    error?: string;
    bookmarks?: BookmarkState;
    history?: DownloadHistory;
}

export function buildTransferPayload(bookmarks: BookmarkState, history: DownloadHistory, now: Date = new Date()): TransferPayload {
    const safeBookmarks = normalizeBookmarkState(bookmarks);
    const safeHistory = normalizeHistory(history);
    return {
        app: TRANSFER_APP_ID,
        version: TRANSFER_VERSION,
        exportedAt: isFinite(now.getTime()) ? now.toISOString() : new Date(0).toISOString(),
        bookmarkCount: safeBookmarks.items.length,
        historyCount: Object.keys(safeHistory).length,
        bookmarks: safeBookmarks,
        history: safeHistory
    };
}

export function serializeTransfer(payload: TransferPayload): string {
    // Two-space indent on purpose: this is a file a human may open, diff or fix
    // by hand, and the sizes involved (a few hundred rows) do not care.
    return JSON.stringify(payload, null, 2);
}

/**
 * Validate imported text.
 *
 * Deliberately tolerant about WHERE the two parts are (top level, or nested
 * under `bookmarks` / `downloadHistory`), because an exported file from an
 * older or hand-edited build should still work; deliberately strict about the
 * row shapes, which `normalizeBookmarkState` / `normalizeHistory` already
 * enforce (they drop unusable rows instead of failing the whole import).
 */
export function parseTransferPayload(text: string): ParsedTransfer {
    const raw = String(text === undefined || text === null ? "" : text).trim();
    if (raw === "") {
        return { ok: false, error: "The file is empty." };
    }
    let payload: any;
    try {
        payload = JSON.parse(raw);
    } catch (_) {
        return { ok: false, error: "That file is not valid JSON." };
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, error: "That JSON is not an export file (expected an object)." };
    }
    if (payload.app !== undefined && payload.app !== TRANSFER_APP_ID) {
        return { ok: false, error: "That file belongs to a different app." };
    }
    if (payload.version !== undefined && Number(payload.version) > TRANSFER_VERSION) {
        return { ok: false, error: "That export was written by a newer version of the extension." };
    }

    const bookmarkPart = payload.bookmarks !== undefined ? payload.bookmarks : payload.bookmarkQueue;
    const historyPart = payload.history !== undefined ? payload.history : payload.downloadHistory;

    const looksLikeBookmarkState = bookmarkPart !== undefined || Array.isArray(payload.items) || payload.v !== undefined;
    const bookmarks = normalizeBookmarkState(
        bookmarkPart !== undefined ? bookmarkPart : (looksLikeBookmarkState ? payload : null)
    );
    const history = normalizeHistory(historyPart !== undefined ? historyPart : null);

    if (!looksLikeBookmarkState && historyPart === undefined) {
        return { ok: false, error: "No bookmark queue or download history found in that file." };
    }
    if (bookmarks.items.length === 0 && Object.keys(history).length === 0) {
        return { ok: false, error: "That file has no bookmarks and no download history in it." };
    }
    return { ok: true, bookmarks: bookmarks, history: history };
}

/**
 * Union of two bookmark lists: local state wins for rows that exist in both.
 * Imported rows the list does not have yet are appended (see the header).
 */
export function mergeImportedBookmarks(local: BookmarkState, imported: BookmarkState): BookmarkState {
    const current = normalizeBookmarkState(local);
    const incoming = normalizeBookmarkState(imported);
    const known: Record<string, boolean> = {};
    for (const item of current.items) {
        known[toGalleryKey(item.id, item.site)] = true;
    }
    const added = incoming.items.filter((item) => known[toGalleryKey(item.id, item.site)] !== true);
    if (added.length === 0) {
        return current;
    }
    return {
        v: current.v,
        items: current.items.concat(added),
        collapsed: current.collapsed
    };
}

/** Union of two histories: the local record for a key always wins. */
export function mergeImportedHistory(local: DownloadHistory, imported: DownloadHistory): DownloadHistory {
    const current = normalizeHistory(local);
    const incoming = normalizeHistory(imported);
    const merged: DownloadHistory = {};
    for (const key of Object.keys(current)) {
        merged[key] = current[key];
    }
    for (const key of Object.keys(incoming)) {
        if (merged[key] === undefined) {
            merged[key] = incoming[key] as DownloadRecord;
        }
    }
    return merged;
}
