import { runUniversalChapterBatch, InspectedUniversalChapter, UniversalPagePayload, UniversalBatchResult } from "../utils/universalChapterBatch";
import { pauseBetweenChapterRequests } from "../utils/universalChapter";
import { approvedHostsFor, rememberHosts, forgetOrigin, HostApprovalMap } from "../utils/hostApprovals";
import { progressTitleKey, partitionSaved, recordSaved, forgetSaved, ChapterProgressMap } from "../utils/chapterProgress";
import { makeLogEntry, appendLog, formatLog, summarizeError, LogEntry, LOG_CAP, LOG_STORAGE_KEY } from "../utils/extensionLog";
import {
    selfTestPlan, skippedForReview, summarizeSelfTest, formatSelfTest, alternateSelectValue, markerValue,
    SelfTestResult
} from "../utils/uiSelfTest";

const COMPLETION_MAX_WAIT_MS = 30 * 60 * 1000;

interface Candidate { id: string; label: string; url: string; current: boolean; selected: boolean; }
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const tabId = Number(new URL(location.href).searchParams.get("tab"));
const sourceStatus = el<HTMLElement>("sourceStatus");
const status = el<HTMLElement>("status");
const list = el<HTMLElement>("chapterList");
const review = el<HTMLElement>("review");
const titleInput = el<HTMLInputElement>("titleName");
const order = el<HTMLSelectElement>("order");
const confirm = el<HTMLInputElement>("confirm");
const downloadButton = el<HTMLButtonElement>("download");
const cancelButton = el<HTMLButtonElement>("cancel");
let origin = "";
let sourcePath = "";
let mode: "title" | "current" | "" = "";
let candidates: Candidate[] = [];
type ReviewedChapter = InspectedUniversalChapter & { orderNote?: string; advertised?: number | null; url: string; skipped?: boolean };
let inspected: ReviewedChapter[] = [];
let approvedHosts: string[] = [];
let isBusy = false;
let runController: AbortController | null = null;
let savedCount = 0;
const HOSTS_KEY = "nhdwHostApprovals";
const PROGRESS_KEY = "nhdwChapterProgress";
let hostMap: HostApprovalMap = {};
let progressMap: ChapterProgressMap = {};
let logBuffer: LogEntry[] = [];
let logFlushTimer: any = null;

function setStatus(text: string): void { status.textContent = text; }

// ---- log ---------------------------------------------------------------
// Every entry is redacted on the way in (see extensionLog.ts): URLs lose their
// query/fragment, secrets and payloads are replaced, and nothing media-sized is
// ever stored. The file can be saved from the panel for a bug report.
function log(level: "info" | "warn" | "error", area: string, message: string, data?: any): void {
    logBuffer = appendLog(logBuffer, makeLogEntry(level, area, message, data), LOG_CAP);
    try {
        if (logFlushTimer === null) {
            logFlushTimer = setTimeout(() => {
                logFlushTimer = null;
                try { chrome.storage.local.set({ [LOG_STORAGE_KEY]: logBuffer }); } catch (_) { /* storage gone */ }
            }, 800);
        }
    } catch (_) { /* logging must never break the tool */ }
}
function logError(area: string, message: string, error: any): void {
    log("error", area, message, summarizeError(error));
}
function readLocal(defaults: Record<string, any>): Promise<any> {
    return new Promise(resolve => {
        try { chrome.storage.local.get(defaults, (value: any) => resolve(value || defaults)); }
        catch (_) { resolve(defaults); }
    });
}
function writeLocal(value: Record<string, any>): void {
    try { chrome.storage.local.set(value); } catch (_) { /* storage unavailable */ }
}
function extensionVersion(): string {
    try { return chrome.runtime.getManifest().version; } catch (_) { return "unknown"; }
}
function logHeader(): Record<string, string> {
    return {
        extension: extensionVersion(),
        page: String(location.href).split("?")[0],
        userAgent: navigator.userAgent,
        rememberedApprovalOrigins: String(Object.keys(hostMap).length),
        recordedTitles: String(Object.keys(progressMap).length)
    };
}
function saveLogFile(): void {
    const text = formatLog(logBuffer, logHeader());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    try {
        chrome.downloads.download({ url: url, filename: "nhdw-log-" + stamp + ".txt", conflictAction: "uniquify" }, () => {
            void chrome.runtime.lastError;
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        });
        setStatus("Log saved to your downloads (nhdw-log-" + stamp + ".txt, " + logBuffer.length + " entries).");
    } catch (error) {
        logError("log", "Could not save the log file", error);
        setStatus("Could not save the log file.");
    }
}
function invalidateReview(): void {
    inspected = [];
    approvedHosts = [];
    confirm.checked = false;
    downloadButton.disabled = true;
    review.textContent = "";
}
function setBusy(busy: boolean): void {
    isBusy = busy;
    for (const node of Array.from(document.querySelectorAll("button, input, select"))) {
        (node as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled = busy;
    }
    cancelButton.disabled = !busy;
    if (!busy) downloadButton.disabled = inspected.length === 0;
}
function send(op: string, fields: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        try {
            chrome.tabs.sendMessage(tabId, Object.assign({ action: "nhdwUniversalChapter", op: op }, fields), (response: any) => {
                if (chrome.runtime.lastError || !response) {
                    reject(new Error("Cannot reach the source tab. Keep it open on the same site and scan again."));
                } else if (response.ok !== true) {
                    const error = new Error(String(response.error || "The chapter operation failed."));
                    (error as any).code = String(response.code || "");
                    reject(error);
                } else resolve(response);
            });
        } catch (_) { reject(new Error("Cannot reach the source tab.")); }
    });
}
function inject(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!Number.isSafeInteger(tabId) || tabId < 0) { reject(new Error("No source tab was selected. Open this tool from the extension on a website.")); return; }
        try {
            chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["js/universalChapterProbe.js"] }, () => {
                if (chrome.runtime.lastError) reject(new Error("The source tab is unavailable or permission expired. Reopen the extension on the site."));
                else resolve();
            });
        } catch (_) { reject(new Error("The source tab cannot be inspected.")); }
    });
}
function renderList(): void {
    list.textContent = "";
    if (!candidates.length) { list.textContent = "No chapters collected yet."; return; }
    const summary = document.createElement("p");
    summary.textContent = candidates.length + " candidate(s) collected. Select only chapters belonging to this title.";
    list.appendChild(summary);
    for (const chapter of candidates) {
        const label = document.createElement("label"); label.className = "check";
        const box = document.createElement("input"); box.type = "checkbox"; box.checked = chapter.selected;
        box.addEventListener("change", () => { chapter.selected = box.checked; invalidateReview(); });
        const text = document.createElement("span"); text.textContent = chapter.label;
        label.appendChild(box); label.appendChild(text); list.appendChild(label);
    }
}
async function scan(which: "title" | "current"): Promise<void> {
    if (isBusy) return;
    if (mode && (mode !== which || which === "current")) { setStatus("Clear the existing selection before switching modes."); return; }
    const controller = new AbortController();
    runController = controller; setBusy(true); setStatus("Scanning the source tab…");
    try {
        await inject();
        if (controller.signal.aborted) throw new Error("Cancelled.");
        const result = await send("scan", {
            mode: which,
            selector: el<HTMLInputElement>("linkSelector").value,
            includeOutsideTitlePath: el<HTMLInputElement>("outsideLinks").checked,
            filterChapterLabels: el<HTMLInputElement>("chapterFilter").checked
        });
        if (controller.signal.aborted) throw new Error("Cancelled.");
        if (origin && result.origin !== origin) throw new Error("The tab is on another site. Clear the selection before starting a new title.");
        if (sourcePath && sourcePath !== result.sourcePath && !el<HTMLInputElement>("otherListPages").checked) {
            throw new Error("This list page has a different path. Verify it belongs to the same title before allowing other list pages.");
        }
        if (!origin) { origin = result.origin; sourcePath = result.sourcePath; titleInput.value = String(result.title || "Title"); }
        mode = which;
        for (const item of result.chapters || []) {
            if (!item || typeof item.url !== "string" || typeof item.label !== "string" || candidates.some(c => c.url === item.url)) continue;
            if (candidates.length >= 200) break;
            candidates.push({ id: "chapter-" + candidates.length, label: item.label, url: item.url, current: which === "current", selected: false });
        }
        invalidateReview(); renderList();
        sourceStatus.textContent = "Source: " + origin + ". Keep its tab open.";
        setStatus((result.truncated || candidates.length >= 200 ? "List limit reached; results may be incomplete. " : "") +
            "Collected " + candidates.length + " candidate(s). Select chapters and confirm their order.");
    } catch (error: any) { setStatus(error && error.message ? error.message : "Unable to scan the source tab."); }
    finally { runController = null; setBusy(false); }
}
function selectedInOrder(): Candidate[] {
    if (order.value !== "oldest" && order.value !== "newest") throw new Error("Choose the order of the collected list first.");
    const selection = candidates.filter(c => c.selected);
    if (!selection.length) throw new Error("Select at least one chapter.");
    return order.value === "newest" ? selection.reverse() : selection;
}
function renderReview(): void {
    review.textContent = "";
    const heading = document.createElement("p");
    heading.textContent = "Review " + inspected.length + " chapter(s), in save order:";
    review.appendChild(heading);
    const ul = document.createElement("ul");
    for (const chapter of inspected) {
        const li = document.createElement("li");
        let text = chapter.label + " — " + chapter.count + " image reference(s)";
        if (chapter.orderNote) text += " · " + chapter.orderNote;
        if (chapter.skipped) text += " · already saved, will be skipped";
        li.textContent = text;
        ul.appendChild(li);
    }
    review.appendChild(ul);
    const missing = inspected.filter(chapter => chapter.advertised !== null && chapter.advertised !== undefined &&
        chapter.advertised !== chapter.count);
    if (missing.length) {
        const warning = document.createElement("p");
        warning.className = "warning";
        warning.textContent = "Page count does not match what the reader advertises: " + missing
            .map(chapter => chapter.label + " (found " + chapter.count + " of " + chapter.advertised + ")").join(", ") +
            ". A top-down reader may not have loaded every page yet — open the chapter, press “Load all pages (top-down)”, then inspect again.";
        review.appendChild(warning);
    }
    const remembered = approvedHostsFor(hostMap, origin);
    const hostHeader = document.createElement("p");
    hostHeader.textContent = "Approve every image host to be contacted" + (remembered.length ? " (remembered hosts are pre-ticked):" : ":");
    review.appendChild(hostHeader);
    for (const host of approvedHosts) {
        const label = document.createElement("label"); label.className = "check";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.host = host;
        // A remembered approval for this exact site pre-ticks the box; it still
        // appears in the list so it can be unchecked for this run.
        checkbox.checked = remembered.indexOf(host) !== -1;
        const text = document.createElement("span");
        text.textContent = host + (remembered.indexOf(host) !== -1 ? " (remembered)" : "");
        label.appendChild(checkbox); label.appendChild(text); review.appendChild(label);
    }
}
function refreshApprovalHint(): void {
    const hint = document.getElementById("approvalHint");
    if (!hint) return;
    const remembered = approvedHostsFor(hostMap, origin);
    hint.textContent = !origin ? "No source site selected yet."
        : remembered.length
            ? remembered.length + " host(s) remembered for " + origin + "."
            : "No hosts remembered for " + origin + " yet.";
}
async function inspectSelected(): Promise<void> {
    if (isBusy) return;
    let selection: Candidate[];
    try { selection = selectedInOrder(); } catch (error: any) { setStatus(error.message); return; }
    const controller = new AbortController();
    runController = controller; invalidateReview(); setBusy(true); setStatus("Inspecting selected readers…");
    try {
        await inject();
        const results: ReviewedChapter[] = [];
        const hosts = new Set<string>();
        for (let i = 0; i < selection.length; i++) {
            if (controller.signal.aborted) throw new Error("Cancelled.");
            if (i > 0) await pauseBetweenChapterRequests(controller.signal);
            setStatus("Inspecting chapter " + (i + 1) + "/" + selection.length + "…");
            const chapter = selection[i];
            const result = await send("inspect", {
                origin: origin, id: chapter.id, chapterUrl: chapter.url, current: chapter.current,
                selector: el<HTMLInputElement>("imageSelector").value,
                attribute: el<HTMLSelectElement>("imageAttribute").value,
                order: el<HTMLSelectElement>("pageOrder").value
            });
            if (controller.signal.aborted) throw new Error("Cancelled.");
            if (!Number.isInteger(result.count) || !Array.isArray(result.hosts)) throw new Error("The reader inspection was incomplete.");
            const orderLabels: Record<string, string> = { "reader": "reader order", "link-index": "sorted by page links", "name-natural": "sorted by image numbers" };
            let orderNote = orderLabels[String(result.order)] || "reader order";
            // A page list recovered from the reader's embedded script is the
            // site's own list; say so, because no <img> element was involved.
            if (result.source === "reader-script") orderNote = "read from the reader's own embedded page list";
            if (result.order !== "reader" && result.readerOrderDiffers) orderNote += " (differs from reader order — verify)";
            if (Array.isArray(result.preview) && result.preview.length) orderNote += ": " + result.preview.join(", ");
            const advertised = Number.isInteger(result.advertised) ? Number(result.advertised) : null;
            results.push({ id: chapter.id, label: chapter.label, count: result.count, hosts: result.hosts,
                orderNote: orderNote, advertised: advertised, url: chapter.url });
            if (result.source === "reader-script") {
                log("info", "inspect", "Page list recovered from the site's embedded reader script", {
                    label: chapter.label, pages: result.count, hosts: result.hosts
                });
            }
            log("info", "inspect", "Chapter inspected", {
                label: chapter.label, chapter: chapter.url, pages: result.count, hosts: result.hosts,
                order: result.order, differs: !!result.readerOrderDiffers, advertised: advertised
            });
            for (const host of result.hosts) hosts.add(String(host));
        }
        // Chapters already recorded as saved can be skipped; the checkbox only
        // changes what is downloaded, never what was found (counts stay visible).
        const skipSaved = el<HTMLInputElement>("skipSaved").checked;
        const titleKey = progressTitleKey(origin, titleInput.value || "Title");
        let skipped = 0;
        if (skipSaved && titleKey) {
            for (const chapter of results) {
                const split = partitionSaved(progressMap, titleKey, [{ chapterUrl: chapter.url }]);
                chapter.skipped = split.alreadySaved.length === 1;
                if (chapter.skipped) skipped++;
            }
        }
        inspected = results;
        approvedHosts = Array.from(hosts).sort();
        renderReview();
        setStatus("Inspection finished" + (skipped ? " (" + skipped + " chapter(s) already saved will be skipped)" : "") +
            ". Review chapter order, page counts and image hosts before saving.");
    } catch (error: any) {
        logError("inspect", "Inspection failed", error);
        invalidateReview(); setStatus(error && error.message ? error.message : "Inspection failed.");
    } finally { runController = null; setBusy(false); }
}
function askWorker(fields: any): Promise<any> {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(Object.assign({ from: "chapters" }, fields), (response: any) => {
                if (chrome.runtime.lastError || !response) reject(new Error("Unable to reach the download service."));
                else resolve(response);
            });
        } catch (_) { reject(new Error("Unable to reach the download service.")); }
    });
}
async function saveBlob(blob: Blob, filename: string, signal?: AbortSignal): Promise<void> {
    const objectUrl = URL.createObjectURL(blob);
    let downloadId: number | null = null;
    const cancel = () => { if (downloadId !== null) void askWorker({ action: "cancelDownload", downloadId: downloadId }).catch(() => {}); };
    if (signal) signal.addEventListener("abort", cancel, { once: true });
    try {
        if (signal && signal.aborted) throw new Error("Cancelled.");
        const started = await askWorker({ action: "saveDownload", url: objectUrl, filename: filename, requireCompletion: true });
        if (!Number.isInteger(started.result) || started.result < 0) throw new Error(String(started.error || "Unable to start the browser download."));
        downloadId = started.result;
        const began = Date.now();
        while (true) {
            if (signal && signal.aborted) { cancel(); throw new Error("Cancelled."); }
            if (Date.now() - began >= COMPLETION_MAX_WAIT_MS) { cancel(); throw new Error("Browser download did not finish in time."); }
            const outcome = await askWorker({ action: "awaitDownload", downloadId: downloadId });
            if (signal && signal.aborted) { cancel(); throw new Error("Cancelled."); }
            if (outcome.result !== true) { cancel(); throw new Error("Browser download completion could not be confirmed."); }
            if (outcome.state === "pending") continue;
            if (outcome.ok === true && outcome.state === "complete") break;
            cancel();
            throw new Error(String(outcome.error || "Browser download completion could not be confirmed."));
        }
        savedCount++;
    } catch (error) {
        cancel();
        throw error;
    } finally {
        if (signal) signal.removeEventListener("abort", cancel);
        // The browser may still be releasing its reference even after complete.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    }
}
async function download(): Promise<void> {
    if (isBusy || !inspected.length) return;
    const boxes = Array.from(review.querySelectorAll("input[data-host]")) as HTMLInputElement[];
    if (!confirm.checked || boxes.length !== approvedHosts.length || boxes.some(box => !box.checked)) {
        setStatus("Approve every listed image host and confirm your selection first."); return;
    }
    const format = el<HTMLSelectElement>("format").value === "zip" ? "zip" : "cbz";
    const salvagePartial = el<HTMLInputElement>("salvage").checked;
    const retry = el<HTMLInputElement>("retry").checked;
    const remember = el<HTMLInputElement>("rememberHosts").checked;
    const hostCopy = approvedHosts.slice();
    const title = titleInput.value || "Title";
    const titleKey = progressTitleKey(origin, title);
    const chapters = inspected.filter(chapter => !chapter.skipped);
    if (!chapters.length) { setStatus("Every selected chapter is already saved. Clear “Skip chapters already saved” to download them again."); return; }
    if (remember && origin) {
        hostMap = rememberHosts(hostMap, origin, hostCopy);
        writeLocal({ [HOSTS_KEY]: hostMap });
        refreshApprovalHint();
    }
    log("info", "download", "Batch started", {
        origin: origin, title: title, chapters: chapters.length, format: format,
        salvage: salvagePartial, retry: retry, hosts: hostCopy, remembered: remember
    });
    const controller = new AbortController();
    runController = controller; savedCount = 0; setBusy(true);
    try {
        const result: UniversalBatchResult = await runUniversalChapterBatch(chapters, title, format, {
            getPage: async (id, index): Promise<UniversalPagePayload> => {
                const answer = await send("page", { origin: origin, id: id, index: index, approvedHosts: hostCopy });
                return { base64: answer.base64, extension: answer.extension, size: answer.size };
            },
            save: saveBlob,
            progress: setStatus
        }, controller.signal, { salvagePartial: salvagePartial, retry: retry });
        let text = "Saved " + result.completed + " complete chapter archive(s)";
        if (result.incomplete.length) {
            text += "; " + result.incomplete.length + " incomplete: " + result.incomplete
                .map(item => item.label + " (" + item.savedPages + " of " + item.expectedPages + ")").join(", ");
        }
        if (result.failed.length) {
            text += "; " + result.failed.length + " failed: " + result.failed
                .map(item => item.label + " — " + item.reason).join(", ");
        }
        // Record what actually reached disk so the next run can skip it. Only
        // complete archives are recorded: a partial one should be retried.
        if (titleKey && Array.isArray(result.savedFiles)) {
            const complete = result.savedFiles.filter(file => file.complete);
            if (complete.length) {
                progressMap = recordSaved(progressMap, titleKey, complete.map(file => ({
                    chapterUrl: chapters.filter(chapter => chapter.id === file.id)[0]?.url || file.id,
                    filename: file.filename, pages: file.pages
                })));
                writeLocal({ [PROGRESS_KEY]: progressMap });
            }
        }
        log(result.failed.length || result.incomplete.length ? "warn" : "info", "download", "Batch finished", {
            completed: result.completed, incomplete: result.incomplete.map(item => ({ label: item.label, saved: item.savedPages, expected: item.expectedPages })),
            failed: result.failed.map(item => ({ label: item.label, reason: item.reason })),
            savedFiles: result.savedFiles
        });
        setStatus(text + ". Check browser downloads for the actual filenames.");
    } catch (error: any) {
        logError("download", "Batch stopped after " + savedCount + " archive(s)", error);
        setStatus("Stopped after " + savedCount + " saved archive(s): " + (error && error.message ? error.message : "download failed."));
    } finally { runController = null; setBusy(false); }
}

el<HTMLButtonElement>("scanTitle").addEventListener("click", () => { void scan("title"); });
el<HTMLButtonElement>("scanCurrent").addEventListener("click", () => { void scan("current"); });
el<HTMLButtonElement>("reset").addEventListener("click", () => {
    if (isBusy) return;
    origin = ""; sourcePath = ""; mode = ""; candidates = []; invalidateReview(); renderList(); sourceStatus.textContent = "Selection cleared."; setStatus("");
});
el<HTMLButtonElement>("selectAll").addEventListener("click", () => { for (const c of candidates) c.selected = true; invalidateReview(); renderList(); });
el<HTMLButtonElement>("selectNone").addEventListener("click", () => { for (const c of candidates) c.selected = false; invalidateReview(); renderList(); });
order.addEventListener("change", invalidateReview);
el<HTMLInputElement>("imageSelector").addEventListener("input", invalidateReview);
el<HTMLSelectElement>("imageAttribute").addEventListener("change", invalidateReview);
el<HTMLSelectElement>("pageOrder").addEventListener("change", invalidateReview);
el<HTMLButtonElement>("inspect").addEventListener("click", () => { void inspectSelected(); });
downloadButton.addEventListener("click", () => { void download(); });
cancelButton.addEventListener("click", () => {
    if (runController) runController.abort();
    void send("cancel").catch(() => {});
    setStatus("Cancelling…");
});
function addChapterUrls(): void {
    if (isBusy) return;
    const raw = el<HTMLTextAreaElement>("chapterUrls").value;
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "");
    if (!lines.length) { setStatus("Paste one chapter URL per line first."); return; }
    if (mode && mode !== "title" && mode !== "current") { setStatus("Clear the selection before adding chapter URLs."); return; }
    let added = 0;
    for (const line of lines) {
        let url: URL;
        try { url = new URL(line); } catch (_) { setStatus("Not a valid URL: " + line.slice(0, 80)); return; }
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
            setStatus("Only plain public HTTPS chapter URLs are accepted: " + line.slice(0, 80)); return;
        }
        if (origin && url.origin !== origin) {
            setStatus("Chapter URLs must be on the same site as the source tab (" + origin + ").");
            return;
        }
        const href = url.href;
        if (candidates.some(candidate => candidate.url === href) || candidates.length >= 200) continue;
        const label = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname).slice(0, 120);
        candidates.push({ id: "url-" + candidates.length, label: label, url: href, current: false, selected: true });
        added++;
    }
    if (!origin && lines.length) {
        // Bind the tool to this site so the probe can reach the chapters.
        try { origin = new URL(lines[0]).origin; sourceStatus.textContent = "Source: " + origin + " (from pasted URLs). Keep the source tab on this site."; } catch (_) { /* validated above */ }
    }
    mode = "title";
    el<HTMLTextAreaElement>("chapterUrls").value = "";
    invalidateReview(); renderList();
    setStatus(added ? "Added " + added + " chapter URL(s). Inspect them next." : "Those chapter URLs were already collected.");
}
el<HTMLButtonElement>("addUrls").addEventListener("click", addChapterUrls);

// Lazy top-down readers only materialize the images near the viewport. Walking
// the page forces the rest in, and the reader order of the resulting DOM is the
// page order even when every file name is a random hash.
function loadAllPages(): void {
    if (isBusy) return;
    const current = candidates.find(candidate => candidate.current) || (candidates.length === 1 ? candidates[0] : null);
    if (!current) { setStatus("Use “Use open chapter” first so the tool knows which chapter is open."); return; }
    if (!origin) { setStatus("Open the chapter in the source tab and scan it first."); return; }
    const controller = new AbortController();
    runController = controller; setBusy(true); setStatus("Scrolling the reader from top to bottom to load every page…");
    inject().then(() => send("loadall", { origin: origin, chapterUrl: current.url, maxSteps: 80 }))
        .then((result: any) => {
            if (controller.signal.aborted) return;
            if (!result.steps) { setStatus("The page did not scroll. Use “Use open chapter”, or select the images manually."); return; }
            setStatus("Scrolled " + result.steps + " step(s)" + (result.reachedBottom === false ? " (the bottom was not reached)" : "") +
                ", " + result.images + " image element(s) present" +
                (Number.isInteger(result.advertised) ? ", reader advertises " + result.advertised + " page(s)" : "") +
                ". Now press “Inspect selected chapters”.");
        })
        .catch((error: any) => { if (!controller.signal.aborted) setStatus(error && error.message ? error.message : "Unable to scroll the reader."); })
        .then(() => { runController = null; setBusy(false); });
}
el<HTMLButtonElement>("loadAll").addEventListener("click", loadAllPages);

// ---- remembered approvals / saved chapters ------------------------------
function forgetHostsHere(): void {
    if (!origin) { setStatus("Scan a source site first, so the tool knows which site to forget."); return; }
    if (!approvedHostsFor(hostMap, origin).length) { setStatus("No hosts are remembered for " + origin + "."); return; }
    hostMap = forgetOrigin(hostMap, origin);
    writeLocal({ [HOSTS_KEY]: hostMap });
    refreshApprovalHint();
    log("info", "approvals", "Forgot remembered hosts for this site", { origin: origin });
    setStatus("Remembered hosts cleared for " + origin + ". The next inspection asks for every host again.");
}
function forgetTitleProgress(): void {
    if (!origin) { setStatus("Scan a source site and set the title folder first."); return; }
    const key = progressTitleKey(origin, titleInput.value || "Title");
    if (!key || !progressMap[key]) { setStatus("No saved chapters are recorded for this title."); return; }
    const count = Object.keys(progressMap[key]).length;
    progressMap = forgetSaved(progressMap, key);
    writeLocal({ [PROGRESS_KEY]: progressMap });
    log("info", "progress", "Forgot saved-chapter records for this title", { origin: origin, title: titleInput.value, chapters: count });
    setStatus("Cleared " + count + " saved-chapter record(s) for this title. Chapters will no longer be skipped.");
}
el<HTMLButtonElement>("forgetSite").addEventListener("click", forgetHostsHere);
el<HTMLButtonElement>("forgetTitle").addEventListener("click", forgetTitleProgress);
el<HTMLButtonElement>("saveLog").addEventListener("click", saveLogFile);

// ---- benchmark ----------------------------------------------------------
function benchStatus(text: string): void {
    const node = document.getElementById("benchmarkStatus");
    if (node) node.textContent = text;
}
function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + " did not finish within " + Math.round(ms / 1000) + " s.")), ms);
        work.then(value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); });
    });
}
function timed(): () => number {
    const began = Date.now();
    return () => Date.now() - began;
}
/**
 * Read-only self-check, driven from whatever page the source tab is on.
 * Nothing here starts an archive or a download; the only network request is one
 * page image from a host the user has already approved for this exact site.
 */
/**
 * Press the page's own controls the way a user would, then put them back.
 *
 * Read-only with respect to the network and to the user's settings: checkboxes
 * are clicked twice, selects and text fields are set to a marker and restored,
 * and buttons are only inspected (never pressed — Scan, Inspect, Save, Cancel,
 * Load all pages, Forget and Benchmark all have side effects).
 */
async function runSelfTest(): Promise<{ results: SelfTestResult[]; skipped: number }> {
    const results: SelfTestResult[] = [];
    const hasReview = inspected.length > 0;
    const fail = (id: string, kind: SelfTestResult["kind"], action: string, note: string) => {
        results.push({ id: id, kind: kind, action: action, before: "", after: "", restored: false, ok: false, note: note });
    };
    for (const target of selfTestPlan(hasReview)) {
        const node: any = document.getElementById(target.id);
        if (!node) { fail(target.id, target.kind, "found", "control is missing from the page"); continue; }
        try {
            if (target.kind === "checkbox") {
                const before = !!node.checked;
                node.click(); const flipped = !!node.checked;
                node.click(); const restored = !!node.checked === before;
                results.push({
                    id: target.id, kind: target.kind, action: "click, then click again",
                    before: String(before), after: String(flipped), restored: restored,
                    ok: flipped !== before && restored,
                    note: flipped === before ? "the box ignored the click" : (restored ? undefined : "the box did not return to its value")
                });
            } else if (target.kind === "select") {
                const before = String(node.value);
                const options = Array.from(node.options as any[]).map((option: any) => String(option.value));
                const alternate = alternateSelectValue(options, before);
                if (alternate === null) { fail(target.id, target.kind, "pick another option", "the control has only one option"); continue; }
                node.value = alternate; node.dispatchEvent(new Event("change"));
                const after = String(node.value);
                node.value = before; node.dispatchEvent(new Event("change"));
                const restored = String(node.value) === before;
                results.push({
                    id: target.id, kind: target.kind, action: "select another option, then restore",
                    before: before, after: after, restored: restored, ok: after === alternate && restored,
                    note: after !== alternate ? "the control rejected the new option" : (restored ? undefined : "the control did not return to its value")
                });
            } else {
                const before = String(node.value);
                const marker = markerValue(before);
                node.value = marker; node.dispatchEvent(new Event("input"));
                const after = String(node.value);
                node.value = before; node.dispatchEvent(new Event("input"));
                const restored = String(node.value) === before;
                results.push({
                    id: target.id, kind: target.kind, action: "type a marker, then restore",
                    before: before, after: after, restored: restored, ok: after === marker && restored,
                    note: after !== marker ? "the field rejected the text" : (restored ? undefined : "the field did not return to its value")
                });
            }
        } catch (error: any) {
            fail(target.id, target.kind, "drive the control", String(error && error.message ? error.message : error));
        }
    }
    // Resting state of the buttons: a wrong disabled flag is exactly the kind of
    // breakage that makes the page feel dead, and reading it changes nothing.
    const stateCheck = (id: string, expectedDisabled: boolean, why: string) => {
        const node = document.getElementById(id) as HTMLButtonElement | null;
        if (!node) { fail(id, "state", "read the button state", "button is missing from the page"); return; }
        const disabled = !!node.disabled;
        results.push({
            id: id, kind: "state", action: "read the resting disabled state",
            before: String(disabled), after: String(expectedDisabled), restored: true,
            ok: disabled === expectedDisabled, note: disabled === expectedDisabled ? why : "expected disabled=" + expectedDisabled
        });
    };
    stateCheck("cancel", true, "Cancel is only enabled while a run is in progress");
    stateCheck("download", inspected.length === 0, inspected.length === 0
        ? "Save stays disabled until a review exists" : "Save is enabled because a review exists");
    stateCheck("inspect", false, "Inspect is always available");
    stateCheck("benchmark", false, "the benchmark itself is always available");
    // The worker is the only path to a browser save, so prove it answers.
    try {
        const pong: any = await within(askWorker({ action: "ping" }), 10000, "Asking the download service");
        const answered = pong && pong.result === true;
        results.push({
            id: "download service", kind: "message", action: "round-trip to the extension worker",
            before: "", after: answered ? "version " + String(pong.version || "?") : String(pong && pong.error || "no answer"),
            restored: true, ok: answered, note: answered ? undefined : "the worker did not answer the ping"
        });
    } catch (error: any) {
        fail("download service", "message", "round-trip to the extension worker",
            String(error && error.message ? error.message : error));
    }
    return { results: results, skipped: skippedForReview(hasReview).length };
}
/**
 * Read-only self-check, driven from whatever page the source tab is on.
 * Nothing here starts an archive or a download; the only network request is one
 * page image from a host the user has already approved for this exact site.
 */
async function runBenchmark(): Promise<void> {
    if (isBusy) { benchStatus("Wait for the current operation to finish."); return; }
    const notes: string[] = [];
    let failures = 0;
    const note = (text: string) => { notes.push(text); benchStatus(text); };
    benchStatus("Step 1 of 6: testing this page's own controls…");
    log("info", "benchmark", "Benchmark started", { step: "start", tabId: tabId });
    // The self-test drives the real controls, so it must run before the page is
    // put into its busy state (which disables every control).
    let selfTest: { results: SelfTestResult[]; skipped: number } = { results: [], skipped: 0 };
    try {
        selfTest = await runSelfTest();
        const summary = summarizeSelfTest(selfTest.results, selfTest.skipped);
        failures += summary.failed;
        note("Controls: " + summary.checked + " check(s), " + summary.failed + " failed" +
            (summary.skipped ? ", " + summary.skipped + " skipped to keep the current review" : "") + ".");
        log(summary.failed ? "warn" : "info", "selftest", "Controls exercised", {
            checked: summary.checked, failed: summary.failed, skipped: summary.skipped,
            checks: selfTest.results.map(result => ({
                id: result.id, kind: result.kind, ok: result.ok, note: result.note || null,
                before: result.before, after: result.after, restored: result.restored
            }))
        });
    } catch (error: any) {
        failures++;
        logError("selftest", "The control self-test could not run", error);
        note("Controls: the self-test could not run (" + (error && error.message ? error.message : "unknown reason") + ").");
    }
    const controller = new AbortController();
    runController = controller; setBusy(true);
    try {
        benchStatus("Step 2 of 6: reaching the source tab…");
        await within(inject(), 15000, "Reaching the source tab");
        let elapsed = timed();
        const here: any = await within(send("scan", { mode: "current" }), 15000, "Reading the open page");
        const pageOrigin = String(here.origin || "");
        const pageUrl = here.chapters && here.chapters[0] ? String(here.chapters[0].url) : "";
        note("Tab reached in " + elapsed() + " ms — " + pageOrigin + ".");
        log("info", "benchmark", "Source tab reached", { ms: elapsed(), origin: pageOrigin, page: pageUrl, title: here.title });

        benchStatus("Step 3 of 6: counting chapter links on this page…");
        elapsed = timed();
        const listing: any = await within(send("scan", {
            selector: el<HTMLInputElement>("linkSelector").value,
            includeOutsideTitlePath: el<HTMLInputElement>("outsideLinks").checked,
            filterChapterLabels: el<HTMLInputElement>("chapterFilter").checked
        }), 20000, "Scanning chapter links");
        const linkCount = Array.isArray(listing.chapters) ? listing.chapters.length : 0;
        note(linkCount
            ? "Found " + linkCount + " chapter link(s) here in " + elapsed() + " ms" + (listing.truncated ? " (list limit reached)" : "") + "."
            : "No chapter links on this page (normal on a chapter page) — " + elapsed() + " ms.");
        log("info", "benchmark", "Chapter links scanned", {
            ms: elapsed(), count: linkCount, truncated: !!listing.truncated,
            first: linkCount ? listing.chapters[0].url : null
        });

        benchStatus("Step 4 of 6: reading page images from the open page…");
        elapsed = timed();
        let reader: any = null;
        try {
            reader = await within(send("inspect", {
                origin: pageOrigin, id: "benchmark", chapterUrl: pageUrl, current: true,
                selector: el<HTMLInputElement>("imageSelector").value,
                attribute: el<HTMLSelectElement>("imageAttribute").value,
                order: el<HTMLSelectElement>("pageOrder").value
            }), 20000, "Reading page images");
            const hosts = Array.isArray(reader.hosts) ? reader.hosts : [];
            const advertised = Number.isInteger(reader.advertised) ? " of " + reader.advertised + " advertised" : "";
            note("Reader: " + reader.count + " page image(s)" + advertised + " on " + hosts.length + " host(s) in " + elapsed() + " ms.");
            log("info", "benchmark", "Reader inspected", {
                ms: elapsed(), pages: reader.count, advertised: reader.advertised, hosts: hosts,
                order: reader.order, differs: !!reader.readerOrderDiffers, preview: reader.preview
            });
        } catch (error: any) {
            note("Reader: no usable page images on this page (" + (error && error.message ? error.message : "unknown reason") + ").");
            logError("benchmark", "Reader inspection found nothing usable", error);
        }

        benchStatus("Step 5 of 6: checking a page image and the scroll container…");
        const approved = approvedHostsFor(hostMap, pageOrigin);
        const pageHosts: string[] = reader && Array.isArray(reader.pageHosts) ? reader.pageHosts : [];
        const index = pageHosts.findIndex(host => approved.indexOf(host) !== -1);
        if (!reader || !reader.count) {
            note("Page image: skipped, no page images to fetch.");
        } else if (index === -1) {
            note(approved.length
                ? "Page image: skipped, no page image is on a host already approved for this site."
                : "Page image: skipped, no host is remembered for this site yet. Approve hosts once in a normal save, then re-run.");
            log("info", "benchmark", "Page fetch skipped", { approved: approved.length, hosts: reader.hosts });
        } else {
            const fetchBegan = timed();
            try {
                const page: any = await within(send("page", { origin: pageOrigin, id: "benchmark", index: index, approvedHosts: approved }),
                    45000, "Fetching one page image");
                note("Page image: " + Math.round(Number(page.size || 0) / 1024) + " KB, " + page.width + "×" + page.height + ", " +
                    page.extension + " from " + page.pageHost + " in " + fetchBegan() + " ms.");
                log("info", "benchmark", "Page image fetched", {
                    ms: fetchBegan(), bytes: page.size, width: page.width, height: page.height,
                    extension: page.extension, host: page.pageHost
                });
            } catch (error: any) {
                failures++;
                note("Page image: failed (" + (error && error.message ? error.message : "unknown reason") + ").");
                logError("benchmark", "Page image fetch failed", error);
            }
        }
        if (reader && reader.count) {
            const scrollBegan = timed();
            try {
                const sweep: any = await within(send("loadall", { origin: pageOrigin, chapterUrl: pageUrl, maxSteps: 20 }),
                    90000, "Scrolling the open reader");
                note("Scroll: " + sweep.steps + " step(s) on " + sweep.scrolledElement + ", " + sweep.images + " image(s), " +
                    sweep.iframes + " iframe(s), " + (sweep.reachedBottom ? "reached the bottom" : "did not reach the bottom") + " in " + scrollBegan() + " ms.");
                log("info", "benchmark", "Scroll container measured", {
                    ms: scrollBegan(), steps: sweep.steps, reachedBottom: !!sweep.reachedBottom,
                    scrolledElement: sweep.scrolledElement, images: sweep.images, iframes: sweep.iframes, advertised: sweep.advertised
                });
            } catch (error: any) {
                failures++;
                note("Scroll: could not be measured (" + (error && error.message ? error.message : "unknown reason") + ").");
                logError("benchmark", "Scroll measurement failed", error);
            }
        }

        benchStatus("Step 6 of 6: checking extension storage…");
        const storeBegan = timed();
        try {
            const probeKey = "nhdwBenchmarkProbe";
            const stamp = Date.now();
            writeLocal({ [probeKey]: stamp });
            const back: any = await readLocal({ [probeKey]: 0 });
            try { chrome.storage.local.remove(probeKey); } catch (_) { /* nothing to clean */ }
            const roundTrip = Number(back[probeKey]) === stamp;
            note("Storage: " + (roundTrip ? "round-trip ok" : "round-trip returned another value") + " in " + storeBegan() + " ms.");
            log(roundTrip ? "info" : "warn", "benchmark", "Storage round-trip", { ms: storeBegan(), ok: roundTrip });
            if (!roundTrip) failures++;
        } catch (error: any) {
            failures++;
            note("Storage: failed (" + (error && error.message ? error.message : "unknown reason") + ").");
            logError("benchmark", "Storage round-trip failed", error);
        }

        const selfTestLines = formatSelfTest(selfTest.results);
        log(failures ? "warn" : "info", "benchmark", "Benchmark finished", {
            steps: notes, failures: failures, selfTest: selfTestLines, skippedControls: selfTest.skipped
        });
        setStatus("Benchmark finished with " + failures + " problem(s). " + (notes.length ? notes[notes.length - 1] : ""));
        saveLogFile();
    } catch (error: any) {
        failures++;
        logError("benchmark", "Benchmark could not run", error);
        note("Benchmark stopped: " + (error && error.message ? error.message : "unknown reason") + ".");
        saveLogFile();
    } finally {
        runController = null; setBusy(false);
    }
}
el<HTMLButtonElement>("benchmark").addEventListener("click", runBenchmark);

readLocal({ [HOSTS_KEY]: {}, [PROGRESS_KEY]: {}, [LOG_STORAGE_KEY]: [] }).then((stored: any) => {
    hostMap = stored[HOSTS_KEY] && typeof stored[HOSTS_KEY] === "object" ? stored[HOSTS_KEY] : {};
    progressMap = stored[PROGRESS_KEY] && typeof stored[PROGRESS_KEY] === "object" ? stored[PROGRESS_KEY] : {};
    logBuffer = Array.isArray(stored[LOG_STORAGE_KEY]) ? stored[LOG_STORAGE_KEY].slice(-LOG_CAP) : [];
    log("info", "start", "Chapter tool opened", { tabId: tabId, version: extensionVersion() });
    if (origin) refreshApprovalHint();
});

renderList();
if (!Number.isSafeInteger(tabId) || tabId < 0 || !new URL(location.href).searchParams.has("tab")) {
    sourceStatus.textContent = "No source tab selected. Open this tool from the extension on a website.";
} else {
    sourceStatus.textContent = "Source tab selected. Open a title or chapter there, then scan.";
}
