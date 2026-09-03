// Folder/filename guard for the browser download manager.
//
// Why this exists (found by studying the deprecated 2.x sources in
// "old deprecated source code" and the Chromium documentation/bug tracker):
// the `filename` field of chrome.downloads.download() is only a *suggestion*.
// The Chrome docs state it plainly: "filename is ignored if there are any
// onDeterminingFilename listeners registered by any extensions" — Chromium
// bug 579563, open since 2016. Any installed download manager / helper
// extension (IDM, FDM, JDownloader connectors, ...) that merely registers a
// listener makes Chrome silently discard every name and folder we request:
// raw pages then land in the root of Downloads as "1.jpg", "2.jpg", ... and
// archives appear under blob UUIDs — the classic "the folder naming system
// doesn't work" report.
//
// The established workaround (same sources) is to register our own
// onDeterminingFilename listener and re-suggest the requested filename for
// the downloads this extension started. The listener must be registered
// synchronously at the top level of the service worker (MV3 requirement),
// which installDownloadFilenameGuard() is for: background.ts calls it during
// module evaluation. Firefox does not implement onDeterminingFilename at all
// and does not have the suppression bug, so the guard is a no-op there.
//
// Downloads whose filename we re-assert are tracked two ways, because
// onDeterminingFilename can fire BEFORE chrome.downloads.download's callback
// hands us the downloadId:
//   byUrl — recorded before download() is called (URLs are unique per page /
//           blob, so this is collision-free for our own artifacts);
//   byId  — filled in the download() callback for exact matching afterwards.
// The maps are mirrored into chrome.storage.session (survives MV3 service
// worker restarts mid-gallery; the browser keeps downloading even while the
// worker is dead) and pruned on completion and at a FIFO cap.

const STORAGE_KEY = "nhdwDownloadNames";

// The extension id is only known at runtime; kept as a function so tests can
// swap chrome.runtime freely.
function ownExtensionId(): string | null {
    try {
        return chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : null;
    } catch (_) {
        return null;
    }
}

let namesById: Record<string, string> = {};
let namesByUrl: Record<string, string> = {};
let sessionLoaded = false;
let installed = false;

// Bounded FIFO so a very long session cannot grow the maps (and the session
// storage mirror) without limit.
const MAX_TRACKED = 600;
let insertionOrder: Array<{ id?: string; url?: string }> = [];

function truncateMaps() {
    while (insertionOrder.length > MAX_TRACKED) {
        const oldest = insertionOrder.shift();
        if (!oldest) break;
        if (oldest.id !== undefined && namesById[oldest.id] !== undefined) {
            delete namesById[oldest.id];
        }
        if (oldest.url !== undefined && namesByUrl[oldest.url] !== undefined) {
            delete namesByUrl[oldest.url];
        }
    }
}

function persistSession() {
    try {
        // @types/chrome is pinned old (0.0.154) and does not know
        // storage.session (Chrome 102+); access it defensively instead of
        // bumping the pinned dependency.
        const session = typeof chrome === "undefined" ? undefined : (chrome.storage as any).session;
        if (!session || typeof session.set !== "function") return;
        session.set({ [STORAGE_KEY]: { byId: namesById, byUrl: namesByUrl } }, () => {
            void chrome.runtime.lastError; // best effort; ignore quota/errors
        });
    } catch (_) { /* storage unavailable in this context */ }
}

function loadSession(callback: () => void) {
    if (sessionLoaded) {
        callback();
        return;
    }
    try {
        const session = typeof chrome === "undefined" ? undefined : (chrome.storage as any).session;
        if (!session || typeof session.get !== "function") {
            sessionLoaded = true;
            callback();
            return;
        }
        session.get([STORAGE_KEY], (elems: any) => {
            try {
                const stored = elems && elems[STORAGE_KEY];
                if (stored && typeof stored === "object") {
                    if (stored.byId && typeof stored.byId === "object") {
                        namesById = Object.assign({}, stored.byId, namesById);
                    }
                    if (stored.byUrl && typeof stored.byUrl === "object") {
                        namesByUrl = Object.assign({}, stored.byUrl, namesByUrl);
                    }
                }
            } catch (_) { /* malformed mirror: start fresh */ }
            sessionLoaded = true;
            callback();
        });
    } catch (_) {
        sessionLoaded = true;
        callback();
    }
}

// Record the filename we are about to request for `url`. Call BEFORE
// chrome.downloads.download() so a filename-determination event that fires
// before the downloadId callback still finds the name.
export function recordDownloadRequest(url: string, filename: string): void {
    if (typeof url !== "string" || url === "" || typeof filename !== "string" || filename === "") return;
    namesByUrl[url] = filename;
    insertionOrder.push({ url: url });
    truncateMaps();
    persistSession();
}

// Attach the downloadId once chrome.downloads.download's callback resolves it.
export function bindDownloadId(url: string, downloadId: number): void {
    if (typeof downloadId !== "number" || downloadId < 0) return;
    const filename = namesByUrl[url];
    if (filename === undefined) return;
    namesById[String(downloadId)] = filename;
    insertionOrder.push({ id: String(downloadId), url: url });
    truncateMaps();
    persistSession();
}

// Called when a tracked download reaches a terminal state so finished
// artifacts stop occupying the maps.
export function forgetDownload(downloadId: number): void {
    const key = String(downloadId);
    if (namesById[key] === undefined) return;
    delete namesById[key];
    // Drop the URL twin recorded alongside this id (same insertion pair).
    let twinUrl: string | undefined = undefined;
    insertionOrder = insertionOrder.filter((e) => {
        if (e.id === key) {
            twinUrl = e.url;
            return false; // remove
        }
        return true;
    });
    if (twinUrl !== undefined && namesByUrl[twinUrl] !== undefined) {
        delete namesByUrl[twinUrl];
    }
    truncateMaps();
    persistSession();
}

// Test/helper visibility only.
export function resetTrackedNamesForTests(): void {
    namesById = {};
    namesByUrl = {};
    insertionOrder = [];
    sessionLoaded = false;
    installed = false;
}

// Decide which filename (if any) to re-assert for a download item. Returns
// null when the download is not one of ours or nothing was recorded.
export function lookupSuggestion(item: { id?: number; url?: string; byExtensionId?: string }): string | null {
    const ownId = ownExtensionId();
    const attributedToForeign = item && typeof item.byExtensionId === "string" && ownId !== null && item.byExtensionId !== ownId;
    if (attributedToForeign) return null; // never fight over other extensions' downloads
    if (item && typeof item.id === "number" && namesById[String(item.id)] !== undefined) {
        return namesById[String(item.id)];
    }
    const url = item ? String(item.url || "") : "";
    const recorded = url !== "" ? namesByUrl[url] : undefined;
    if (recorded === undefined) return null;
    // Only URLs we recorded ourselves are in the map: every entry was put
    // there by a chrome.downloads.download() call from this extension (raw
    // CDN page, blob artifact) or by its offscreen anchor save. Downloads
    // another extension started are already excluded above, so a URL match
    // is ours. The only theoretical overlap — the user manually saving the
    // exact same image while our download of it is still in flight — is
    // resolved harmlessly: the name we assert is a valid, uniquely-named
    // artifact name (conflictAction: uniquify prevents overwrites), and the
    // map entry is dropped as soon as our download completes.
    return recorded;
}

// Register the guard. Must be called synchronously during service worker
// (module) evaluation; safe to call more than once and harmless in contexts
// without the downloads API (tests, Firefox which lacks the event).
export function installDownloadFilenameGuard(): void {
    if (installed) return;
    try {
        if (typeof chrome === "undefined" || !chrome.downloads || !(chrome.downloads as any).onDeterminingFilename) {
            return; // Firefox: no event, no suppression bug — nothing to do.
        }
        installed = true;
        (chrome.downloads as any).onDeterminingFilename.addListener((item: any, suggest: (suggestion?: any) => void): boolean => {
            const finish = (filename: string | null) => {
                try {
                    if (filename === null) suggest();
                    else suggest({ filename: filename, conflictAction: "uniquify" });
                } catch (_) { /* suggest after channel closed */ }
            };
            const direct = lookupSuggestion(item);
            if (direct !== null) {
                finish(direct);
                return false; // answered synchronously
            }
            // The worker may have restarted since the request was recorded
            // (memory maps empty, session mirror intact). One async session
            // read before giving up keeps names stable across restarts.
            loadSession(() => {
                finish(lookupSuggestion(item));
            });
            return true; // suggest() will be called asynchronously
        });
        // Map hygiene: forget names once a download leaves the queue.
        if (chrome.downloads.onChanged) {
            chrome.downloads.onChanged.addListener((delta: any) => {
                try {
                    if (delta && delta.id !== undefined && delta.state && delta.state.current
                        && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
                        forgetDownload(delta.id);
                    }
                } catch (_) { /* never break the event */ }
            });
        }
    } catch (_) { /* API missing in this context */ }
}
