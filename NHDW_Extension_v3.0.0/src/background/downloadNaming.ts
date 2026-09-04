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
// The established workaround is to register our own onDeterminingFilename
// listener and re-suggest the requested filename for the downloads this
// extension started.
//
// ---------------------------------------------------------------------------
// LISTENER LIFETIME — read before changing anything here.
//
// onDeterminingFilename is a GLOBAL naming-decision event. Registering it puts
// this extension into the filename chain for EVERY download in the profile,
// not just ours. host_permissions and content-script matches do not scope it,
// and returning early for a foreign download does NOT remove us from the
// chain. A permanently registered listener makes Chrome able to blame this
// extension for unrelated downloads:
//
//   This extension failed to name the download "<name>" because another
//   extension determined a different filename ""
//
// Until 3.4.1 the guard registered at worker startup and never unregistered,
// which is exactly that footgun. It is now REFERENCE-COUNTED against our own
// pending work:
//
//   * the listener is attached the moment the first own filename is recorded;
//   * it is detached as soon as the pending map drains — on consumption,
//     completion, interruption, cancellation, failed download creation, TTL
//     expiry, or FIFO eviction;
//   * while attached, a download we did not start gets a bare suggest() —
//     never a filename, never "";
//   * when idle, this extension is not in the naming chain at all, so it
//     cannot be blamed for, delay, or compete over anything.
//
// Registration therefore does NOT happen at module evaluation.
// installDownloadFilenameGuard() only installs the cheap onChanged bookkeeping
// listener (which has no naming authority) and re-attaches the naming listener
// after a service-worker restart if the session mirror shows work still in
// flight. The MV3 "register events synchronously at top level" rule concerns
// waking a dormant worker; the naming listener is only ever needed while this
// worker is already alive and downloading, so attaching it on demand is safe.
//
// Firefox does not implement onDeterminingFilename at all and does not have
// the suppression bug, so the whole guard is a no-op there.
// ---------------------------------------------------------------------------
//
// Downloads whose filename we re-assert are tracked by URL, because
// onDeterminingFilename can fire BEFORE chrome.downloads.download's callback
// hands us the downloadId. The downloadId is bound afterwards as an alias so
// completion events can clear the entry. The maps are mirrored into
// chrome.storage.session (survives MV3 service worker restarts mid-gallery;
// the browser keeps downloading even while the worker is dead), pruned on
// completion, at a TTL, and at a FIFO cap.

const STORAGE_KEY = "nhdwDownloadNames";

// Bounded FIFO so a very long session cannot grow the maps (and the session
// storage mirror) without limit.
const MAX_TRACKED = 600;

// Nothing we start should stay unresolved for half an hour. Without a TTL a
// download that never reaches a terminal state (creation failed silently,
// worker died between record and bind, user cleared the download shelf) would
// pin the entry — and therefore the global listener — forever.
const ENTRY_TTL_MS = 30 * 60 * 1000;

interface PendingName {
    filename: string;
    at: number;
}

let pending: Record<string, PendingName> = {}; // url -> requested name
let idToUrl: Record<string, string> = {};      // downloadId -> url
let order: string[] = [];                      // urls, insertion order (FIFO cap)
let sessionLoaded = false;
let hygieneInstalled = false;
let activeListener: ((item: any, suggest: (suggestion?: any) => void) => boolean) | null = null;

// The extension id is only known at runtime; kept as a function so tests can
// swap chrome.runtime freely.
function ownExtensionId(): string | null {
    try {
        return chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : null;
    } catch (_) {
        return null;
    }
}

function downloadsApi(): any {
    try {
        if (typeof chrome === "undefined" || !chrome.downloads) return null;
        return chrome.downloads as any;
    } catch (_) {
        return null;
    }
}

function nowMs(): number {
    try {
        return Date.now();
    } catch (_) {
        return 0;
    }
}

function pendingCount(): number {
    return Object.keys(pending).length;
}

// ---- map maintenance -----------------------------------------------------

function dropUrl(url: string): void {
    if (pending[url] === undefined) return;
    delete pending[url];
    order = order.filter((entry) => entry !== url);
    for (const id of Object.keys(idToUrl)) {
        if (idToUrl[id] === url) delete idToUrl[id];
    }
}

function pruneExpired(): void {
    const cutoff = nowMs() - ENTRY_TTL_MS;
    for (const url of Object.keys(pending)) {
        if (pending[url].at < cutoff) dropUrl(url);
    }
}

function enforceCap(): void {
    while (order.length > MAX_TRACKED) {
        const oldest = order[0];
        if (oldest === undefined) break;
        dropUrl(oldest);
        // dropUrl already removed it from `order`; guard against a desync.
        if (order.length > 0 && order[0] === oldest) order.shift();
    }
}

function persistSession(): void {
    try {
        // @types/chrome is pinned old (0.0.154) and does not know
        // storage.session (Chrome 102+); access it defensively instead of
        // bumping the pinned dependency.
        const session = typeof chrome === "undefined" ? undefined : (chrome.storage as any).session;
        if (!session || typeof session.set !== "function") return;
        session.set({ [STORAGE_KEY]: { v: 2, pending: pending, idToUrl: idToUrl, order: order } }, () => {
            void chrome.runtime.lastError; // best effort; ignore quota/errors
        });
    } catch (_) { /* storage unavailable in this context */ }
}

function adoptLegacyMirror(stored: any): void {
    // 3.3.1/3.4.0 shape: { byId: {id: name}, byUrl: {url: name} } with bare
    // string values and no timestamps. Treat them as freshly seen so they get
    // a full TTL rather than being pruned instantly.
    const stamp = nowMs();
    if (stored.byUrl && typeof stored.byUrl === "object") {
        for (const url of Object.keys(stored.byUrl)) {
            const name = stored.byUrl[url];
            if (typeof name !== "string" || name === "") continue;
            if (pending[url] !== undefined) continue;
            pending[url] = { filename: name, at: stamp };
            order.push(url);
        }
    }
}

function adoptMirror(stored: any): void {
    if (!stored || typeof stored !== "object") return;
    if (stored.pending && typeof stored.pending === "object") {
        for (const url of Object.keys(stored.pending)) {
            const entry = stored.pending[url];
            if (!entry || typeof entry.filename !== "string" || entry.filename === "") continue;
            if (pending[url] !== undefined) continue; // in-memory wins
            pending[url] = { filename: entry.filename, at: typeof entry.at === "number" ? entry.at : nowMs() };
            if (order.indexOf(url) === -1) order.push(url);
        }
        if (stored.idToUrl && typeof stored.idToUrl === "object") {
            for (const id of Object.keys(stored.idToUrl)) {
                if (idToUrl[id] === undefined && typeof stored.idToUrl[id] === "string") {
                    idToUrl[id] = stored.idToUrl[id];
                }
            }
        }
        return;
    }
    adoptLegacyMirror(stored);
}

function loadSession(callback: () => void): void {
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
                adoptMirror(elems && elems[STORAGE_KEY]);
            } catch (_) { /* malformed mirror: start fresh */ }
            sessionLoaded = true;
            callback();
        });
    } catch (_) {
        sessionLoaded = true;
        callback();
    }
}

// ---- listener attach / detach -------------------------------------------

function handleDeterminingFilename(item: any, suggest: (suggestion?: any) => void): boolean {
    let answered = false;
    const finish = (url: string | null, filename: string | null) => {
        if (answered) return; // suggest() must be called exactly once
        answered = true;
        try {
            if (filename === null || filename === "") {
                suggest(); // foreign or unknown: keep the browser's own name
            } else {
                suggest({ filename: filename, conflictAction: "uniquify" });
                if (url !== null) {
                    dropUrl(url); // consumed — stop competing for it
                    persistSession();
                }
            }
        } catch (_) { /* suggest after channel closed */ }
        syncListener();
    };

    const url = resolveOwnUrl(item);
    if (url !== null) {
        finish(url, pending[url].filename);
        return false; // answered synchronously
    }
    if (sessionLoaded) {
        finish(null, null);
        return false;
    }
    // The worker may have restarted since the request was recorded (memory
    // maps empty, session mirror intact). One async session read before
    // giving up keeps names stable across restarts.
    loadSession(() => {
        const recovered = resolveOwnUrl(item);
        finish(recovered, recovered === null ? null : pending[recovered].filename);
    });
    return true; // suggest() will be called asynchronously
}

function attachListener(): void {
    if (activeListener !== null) return;
    const api = downloadsApi();
    if (!api || !api.onDeterminingFilename || typeof api.onDeterminingFilename.addListener !== "function") {
        return; // Firefox: no event, no suppression bug — nothing to do.
    }
    activeListener = handleDeterminingFilename;
    api.onDeterminingFilename.addListener(activeListener);
}

function detachListener(): void {
    if (activeListener === null) return;
    const api = downloadsApi();
    const listener = activeListener;
    activeListener = null;
    try {
        if (api && api.onDeterminingFilename && typeof api.onDeterminingFilename.removeListener === "function") {
            api.onDeterminingFilename.removeListener(listener);
        }
    } catch (_) { /* event vanished with the context */ }
}

// The single place that decides whether this extension sits in the global
// filename chain: in it only while we have our own names outstanding.
function syncListener(): void {
    pruneExpired();
    if (pendingCount() > 0) attachListener();
    else detachListener();
}

// ---- public API ----------------------------------------------------------

// Record the filename we are about to request for `url`. Call BEFORE
// chrome.downloads.download() so a filename-determination event that fires
// before the downloadId callback still finds the name. This is what arms the
// global listener.
export function recordDownloadRequest(url: string, filename: string): void {
    if (typeof url !== "string" || url === "" || typeof filename !== "string" || filename === "") return;
    if (pending[url] === undefined) order.push(url);
    pending[url] = { filename: filename, at: nowMs() };
    enforceCap();
    persistSession();
    syncListener();
}

// Attach the downloadId once chrome.downloads.download's callback resolves it.
export function bindDownloadId(url: string, downloadId: number): void {
    if (typeof downloadId !== "number" || downloadId < 0) return;
    if (pending[url] === undefined) return;
    idToUrl[String(downloadId)] = url;
    persistSession();
}

// The download never started (creation failed, job aborted before dispatch).
// Without this the entry would pin the listener until the TTL.
export function discardDownloadRequest(url: string): void {
    if (typeof url !== "string" || url === "") return;
    dropUrl(url);
    persistSession();
    syncListener();
}

// Called when a tracked download reaches a terminal state so finished
// artifacts stop occupying the maps — and so the listener can stand down.
export function forgetDownload(downloadId: number): void {
    const key = String(downloadId);
    const url = idToUrl[key];
    delete idToUrl[key];
    if (url !== undefined) dropUrl(url);
    persistSession();
    syncListener();
}

// Test/helper visibility only.
export function resetTrackedNamesForTests(): void {
    detachListener();
    pending = {};
    idToUrl = {};
    order = [];
    sessionLoaded = false;
    hygieneInstalled = false;
}

// Test/diagnostic visibility: is this extension currently a participant in the
// browser-wide filename chain?
export function isFilenameListenerRegistered(): boolean {
    return activeListener !== null;
}

// Test/diagnostic visibility: how many of our own downloads are outstanding.
export function pendingDownloadNameCount(): number {
    return pendingCount();
}

// Resolve a determining-filename event to one of OUR recorded URLs, or null.
function resolveOwnUrl(item: { id?: number; url?: string; byExtensionId?: string } | null): string | null {
    if (!item) return null;
    const ownId = ownExtensionId();
    const attributedToForeign = typeof item.byExtensionId === "string" && ownId !== null && item.byExtensionId !== ownId;
    if (attributedToForeign) return null; // never fight over other extensions' downloads
    if (typeof item.id === "number") {
        const mapped = idToUrl[String(item.id)];
        if (mapped !== undefined && pending[mapped] !== undefined) return mapped;
    }
    const url = String(item.url || "");
    if (url === "" || pending[url] === undefined) return null;
    // Only URLs we recorded ourselves are in the map: every entry was put
    // there by a chrome.downloads.download() call from this extension (raw
    // CDN page, blob artifact) or by its offscreen anchor save. Downloads
    // another extension started are already excluded above, so a URL match
    // is ours. The only theoretical overlap — the user manually saving the
    // exact same image while our download of it is still in flight — is
    // resolved harmlessly: the name we assert is a valid, uniquely-named
    // artifact name (conflictAction: uniquify prevents overwrites), and the
    // map entry is dropped as soon as our download completes.
    return url;
}

// Decide which filename (if any) to re-assert for a download item. Returns
// null when the download is not one of ours or nothing was recorded. Never
// returns "" — an empty suggestion is what makes Chrome blame an extension.
export function lookupSuggestion(item: { id?: number; url?: string; byExtensionId?: string }): string | null {
    const url = resolveOwnUrl(item);
    if (url === null) return null;
    const filename = pending[url].filename;
    return filename === "" ? null : filename;
}

// Install the bookkeeping half of the guard. Safe to call more than once and
// harmless in contexts without the downloads API (tests, Firefox).
//
// This deliberately does NOT register onDeterminingFilename: that happens on
// demand in recordDownloadRequest, so an idle worker is not a participant in
// the browser-wide naming chain. The only exception is worker recovery — if
// the session mirror still lists downloads in flight, the listener is
// re-attached after the async read.
export function installDownloadFilenameGuard(): void {
    const api = downloadsApi();
    if (!api) return;
    if (!hygieneInstalled && api.onChanged && typeof api.onChanged.addListener === "function") {
        hygieneInstalled = true;
        // Map hygiene: forget names once a download leaves the queue. This
        // event carries no naming authority, so keeping it registered cannot
        // make Chrome blame us for anything.
        api.onChanged.addListener((delta: any) => {
            try {
                if (delta && delta.id !== undefined && delta.state && delta.state.current
                    && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
                    forgetDownload(delta.id);
                }
            } catch (_) { /* never break the event */ }
        });
    }
    // Worker-restart recovery: re-arm only if work is genuinely outstanding.
    try {
        loadSession(() => {
            syncListener();
        });
    } catch (_) { /* storage unavailable */ }
}
