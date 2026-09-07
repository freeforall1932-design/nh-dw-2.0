// Worker-side owner of the persistent bookmark queue.
//
// The content script and the panel both mutate the bookmark list, so the
// service worker is the single writer: every mutation arrives as a message,
// is applied to the stored state through src/utils/bookmarkQueue.ts, and is
// broadcast back as `bookmarkChanged`. Two independent read-modify-write
// owners would clobber each other.
//
// Everything here is bookkeeping. A storage failure must never fail a
// download, so no function in this file is allowed to reject.

import {
    BookmarkCandidate,
    BookmarkState,
    addBookmarks,
    clearBookmarks,
    mutateBookmarks,
    patchBookmark,
    readBookmarks,
    reconcileBookmarksAfterRestart,
    removeBookmarks,
    setAllBookmarksSelected,
    setBookmarkSelected,
    setBookmarksCollapsed,
    thumbnailUrlFromGallery,
    titleFromGallery,
    pagesFromGallery
} from "../utils/bookmarkQueue";
import { historyIds, readHistory } from "../utils/downloadHistory";
import { fetchGalleryViaTab, getActiveNhentaiTabId } from "../preview/activeTabGallery";

// Reconciliation runs once per worker lifetime, exactly like getQueueState()
// in the sibling Twitter repo. While this worker is alive the offscreen
// document may legitimately be mid-download, so a "downloading" row must not
// be reset on every read — only when the worker has just come back and the
// document that was running the job is certainly gone.
let reconciled = false;

export async function getBookmarkState(): Promise<BookmarkState> {
    if (!reconciled) {
        reconciled = true;
        let knownIds: string[] | undefined;
        try {
            knownIds = historyIds(await readHistory());
        } catch (_) {
            knownIds = undefined;
        }
        // Applied as a function of the freshly-read state, never as a captured
        // snapshot: a mutation landing between the read and the write (a card
        // bookmarked while the worker was waking) must not be clobbered.
        return mutateBookmarks((state) => reconcileBookmarksAfterRestart(state, knownIds));
    }
    return readBookmarks();
}

export function broadcastBookmarkChanged(state: BookmarkState): void {
    try {
        chrome.runtime.sendMessage({ action: "bookmarkChanged", state: state });
    } catch (_) { /* no receiver: the panel is closed */ }
}

// ---- download bookkeeping ------------------------------------------------
//
// Hooked into the two broadcast sites the download pipeline already has, so a
// bookmark row reflects a download started from ANY entry point (queue, card
// button, panel preview). That is deliberate: the row means "I want this
// title", and the history is the authority on whether it arrived.

export function markBookmarksDownloaded(records: Array<{ id: string | number; filename: string }>): Promise<void> {
    if (!Array.isArray(records) || records.length === 0) {
        return Promise.resolve();
    }
    return mutateBookmarks((state) => {
        let next = state;
        for (const record of records) {
            next = patchBookmark(next, record.id, {
                status: "done",
                error: "",
                filename: String(record.filename || "")
            });
        }
        return next;
    }).then(broadcastBookmarkChanged).catch(() => { /* bookkeeping only */ });
}

export function markBookmarksFailed(failed: Array<{ id: string | number; name?: string; error?: string }>): Promise<void> {
    if (!Array.isArray(failed) || failed.length === 0) {
        return Promise.resolve();
    }
    return mutateBookmarks((state) => {
        let next = state;
        for (const entry of failed) {
            next = patchBookmark(next, entry.id, {
                status: "failed",
                error: String(entry.error || "Download failed")
            });
        }
        return next;
    }).then(broadcastBookmarkChanged).catch(() => { /* bookkeeping only */ });
}

export function markBookmarksDownloading(ids: Array<string | number>): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) {
        return Promise.resolve();
    }
    return mutateBookmarks((state) => {
        let next = state;
        for (const id of ids) {
            next = patchBookmark(next, id, { status: "downloading", error: "" });
        }
        return next;
    }).then(broadcastBookmarkChanged).catch(() => { /* bookkeeping only */ });
}

// ---- enrichment ----------------------------------------------------------
//
// A pasted id arrives with no title and no thumbnail. Resolve it through the
// user's open nhentai tab — the same Cloudflare-safe route the panel's own
// resolver uses (src/preview/selectedGalleryResolver.ts). A failure leaves the
// row alone: an unresolved row is still downloadable, it just shows its id.

export async function enrichBookmarks(ids: Array<string | number>): Promise<{ state: BookmarkState; resolved: number; skipped: boolean }> {
    const wanted = (ids || []).map((id) => String(id)).filter((id) => /^[0-9]+$/.test(id));
    if (wanted.length === 0) {
        return { state: await getBookmarkState(), resolved: 0, skipped: false };
    }
    // Guarded on purpose: the Queue tab can be opened on any website, and
    // fetchGalleryViaTab injects into whatever tab it is given. With no
    // nhentai tab open there is nothing to resolve through, and saying so is
    // better than injecting into the user's banking tab and failing there.
    const tabId = await getActiveNhentaiTabId();
    if (typeof tabId !== "number") {
        return { state: await getBookmarkState(), resolved: 0, skipped: true };
    }
    let resolved = 0;
    for (const id of wanted) {
        let gallery: any = null;
        try {
            gallery = await fetchGalleryViaTab(tabId, id);
        } catch (_) {
            gallery = null;
        }
        if (!gallery) {
            continue;
        }
        const patch = {
            title: titleFromGallery(gallery, id),
            thumbnail: thumbnailUrlFromGallery(gallery),
            pages: pagesFromGallery(gallery)
        };
        await mutateBookmarks((state) => patchBookmark(state, id, patch));
        resolved++;
    }
    const state = await getBookmarkState();
    broadcastBookmarkChanged(state);
    return { state: state, resolved: resolved, skipped: false };
}

// ---- message handling ----------------------------------------------------

/**
 * Handle a bookmark* message. Returns true when the message was handled (the
 * listener must then return true to keep the channel open for the async
 * response), false when it is not a bookmark message at all.
 */
export function handleBookmarkMessage(request: any, sendResponse: (response: any) => void): boolean {
    const action = request && typeof request.action === "string" ? request.action : "";
    if (action.indexOf("bookmark") !== 0) {
        return false;
    }

    if (action === "bookmarkGet") {
        getBookmarkState().then((state) => sendResponse({ result: "success", state: state }));
        return true;
    }

    if (action === "bookmarkAdd") {
        const candidates: BookmarkCandidate[] = Array.isArray(request.items) ? request.items : [];
        mutateBookmarks((state) => addBookmarks(state, candidates).state)
            .then((state) => {
                broadcastBookmarkChanged(state);
                sendResponse({ result: "success", state: state });
            })
            .catch(() => sendResponse({ result: "error", error: "Could not save the bookmark list." }));
        return true;
    }

    if (action === "bookmarkRemove") {
        const ids = Array.isArray(request.ids) ? request.ids : (request.id === undefined ? [] : [request.id]);
        mutateBookmarks((state) => removeBookmarks(state, ids))
            .then((state) => {
                broadcastBookmarkChanged(state);
                sendResponse({ result: "success", state: state });
            });
        return true;
    }

    if (action === "bookmarkClear") {
        mutateBookmarks((state) => clearBookmarks(state))
            .then((state) => {
                broadcastBookmarkChanged(state);
                sendResponse({ result: "success", state: state });
            });
        return true;
    }

    if (action === "bookmarkSelect") {
        const selected = !!request.selected;
        mutateBookmarks((state) => request.all === true
            ? setAllBookmarksSelected(state, selected)
            : setBookmarkSelected(state, Array.isArray(request.ids) ? request.ids : [], selected))
            .then((state) => {
                broadcastBookmarkChanged(state);
                sendResponse({ result: "success", state: state });
            });
        return true;
    }

    if (action === "bookmarkCollapse") {
        mutateBookmarks((state) => setBookmarksCollapsed(state, !!request.collapsed))
            .then((state) => {
                broadcastBookmarkChanged(state);
                sendResponse({ result: "success", state: state });
            });
        return true;
    }

    if (action === "bookmarkMarkDownloading") {
        // Sent by the panel the moment it hands a selection to the download
        // pipeline, so the rows read "downloading" before the first byte
        // arrives rather than after the first broadcast.
        markBookmarksDownloading(Array.isArray(request.ids) ? request.ids : [])
            .then(() => getBookmarkState())
            .then((state) => sendResponse({ result: "success", state: state }));
        return true;
    }

    if (action === "bookmarkEnrich") {
        enrichBookmarks(Array.isArray(request.ids) ? request.ids : [])
            .then((outcome) => sendResponse({
                result: "success",
                state: outcome.state,
                resolved: outcome.resolved,
                // True when there was no nhentai tab to resolve through, so the
                // panel can say that instead of a vague "resolving...".
                skipped: outcome.skipped
            }))
            .catch(() => sendResponse({ result: "error" }));
        return true;
    }

    // Unknown bookmark* action: answer instead of leaving the channel open.
    sendResponse({ result: "error", error: "Unknown bookmark action: " + action });
    return true;
}
