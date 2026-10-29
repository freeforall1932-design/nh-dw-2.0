import { runUniversalChapterBatch, InspectedUniversalChapter, UniversalPagePayload } from "../utils/universalChapterBatch";
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
let inspected: InspectedUniversalChapter[] = [];
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
                    reject(new Error(String(response.error || "The chapter operation failed.")));
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
        const li = document.createElement("li"); li.textContent = chapter.label + " — " + chapter.count + " image reference(s)"; ul.appendChild(li);
    }
    review.appendChild(ul);
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
        const results: InspectedUniversalChapter[] = [];
        const hosts = new Set<string>();
        for (let i = 0; i < selection.length; i++) {
            if (controller.signal.aborted) throw new Error("Cancelled.");
            if (i > 0) await pauseBetweenChapterRequests(controller.signal);
            setStatus("Inspecting chapter " + (i + 1) + "/" + selection.length + "…");
            const chapter = selection[i];
            const result = await send("inspect", {
                origin: origin, id: chapter.id, chapterUrl: chapter.url, current: chapter.current,
                selector: el<HTMLInputElement>("imageSelector").value,
                attribute: el<HTMLSelectElement>("imageAttribute").value
            });
            if (controller.signal.aborted) throw new Error("Cancelled.");
            if (!Number.isInteger(result.count) || !Array.isArray(result.hosts)) throw new Error("The reader inspection was incomplete.");
            results.push({ id: chapter.id, label: chapter.label, count: result.count, hosts: result.hosts });
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
    const hostCopy = approvedHosts.slice();
    const chapters = inspected.slice();
    const controller = new AbortController();
    runController = controller; savedCount = 0; setBusy(true);
    try {
        const count = await runUniversalChapterBatch(chapters, titleInput.value || "Title", format, {
            getPage: async (id, index): Promise<UniversalPagePayload> => {
                const result = await send("page", { origin: origin, id: id, index: index, approvedHosts: hostCopy });
                return { base64: result.base64, extension: result.extension, size: result.size };
            },
            save: saveBlob,
            progress: setStatus
        }, controller.signal);
        setStatus("Saved " + count + " chapter archive(s). Check browser downloads for the actual filenames.");
    } catch (error: any) {
        setStatus("Stopped after " + savedCount + " completed archive(s): " + (error && error.message ? error.message : "download failed."));
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
el<HTMLButtonElement>("inspect").addEventListener("click", () => { void inspectSelected(); });
downloadButton.addEventListener("click", () => { void download(); });
cancelButton.addEventListener("click", () => {
    if (runController) runController.abort();
    void send("cancel").catch(() => {});
    setStatus("Cancelling…");
});
renderList();
if (!Number.isSafeInteger(tabId) || tabId < 0 || !new URL(location.href).searchParams.has("tab")) {
    sourceStatus.textContent = "No source tab selected. Open this tool from the extension on a website.";
} else {
    sourceStatus.textContent = "Source tab selected. Open a title or chapter there, then scan.";
}
