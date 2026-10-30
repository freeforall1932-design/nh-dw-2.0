import { runUniversalChapterBatch, InspectedUniversalChapter, UniversalPagePayload, UniversalBatchResult } from "../utils/universalChapterBatch";
import { pauseBetweenChapterRequests } from "../utils/universalChapter";

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
type ReviewedChapter = InspectedUniversalChapter & { orderNote?: string; advertised?: number | null };
let inspected: ReviewedChapter[] = [];
let approvedHosts: string[] = [];
let isBusy = false;
let runController: AbortController | null = null;
let savedCount = 0;

function setStatus(text: string): void { status.textContent = text; }
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
    const hostHeader = document.createElement("p"); hostHeader.textContent = "Approve every image host to be contacted:"; review.appendChild(hostHeader);
    for (const host of approvedHosts) {
        const label = document.createElement("label"); label.className = "check";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.host = host;
        const text = document.createElement("span"); text.textContent = host;
        label.appendChild(checkbox); label.appendChild(text); review.appendChild(label);
    }
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
            if (result.order !== "reader" && result.readerOrderDiffers) orderNote += " (differs from reader order — verify)";
            if (Array.isArray(result.preview) && result.preview.length) orderNote += ": " + result.preview.join(", ");
            const advertised = Number.isInteger(result.advertised) ? Number(result.advertised) : null;
            results.push({ id: chapter.id, label: chapter.label, count: result.count, hosts: result.hosts,
                orderNote: orderNote, advertised: advertised });
            for (const host of result.hosts) hosts.add(String(host));
        }
        inspected = results;
        approvedHosts = Array.from(hosts).sort();
        renderReview();
        setStatus("Inspection finished. Review chapter order, page counts and image hosts before saving.");
    } catch (error: any) {
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
    const hostCopy = approvedHosts.slice();
    const chapters = inspected.slice();
    const controller = new AbortController();
    runController = controller; savedCount = 0; setBusy(true);
    try {
        const result: UniversalBatchResult = await runUniversalChapterBatch(chapters, titleInput.value || "Title", format, {
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
        setStatus(text + ". Check browser downloads for the actual filenames.");
    } catch (error: any) {
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

renderList();
if (!Number.isSafeInteger(tabId) || tabId < 0 || !new URL(location.href).searchParams.has("tab")) {
    sourceStatus.textContent = "No source tab selected. Open this tool from the extension on a website.";
} else {
    sourceStatus.textContent = "Source tab selected. Open a title or chapter there, then scan.";
}
