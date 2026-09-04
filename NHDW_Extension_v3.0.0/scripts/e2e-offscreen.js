// End-to-end offscreen document test: load the built js/offscreen.js in a
// window-less-but-DOM-stubbed VM context (like an offscreen document) and
// drive a downloadDoujinshi command through the full pipeline:
// metadata -> image fetch (mocked CDN) -> JSZip -> object URL -> save relay.
//
// This harness mirrors REAL Chrome: per the Chrome docs, "The runtime API is
// the only extensions API supported by offscreen documents", so the chrome
// stub here has NO chrome.storage, NO chrome.downloads and NO
// chrome.scripting — the service worker (simulated in the sendMessage stub)
// performs chrome.downloads.download (saveDownload), chrome.scripting
// injections (fetchInTab / fetchUrlInTab), and owns the job marker.
//
// This proves the large-gallery fix (ZIP delivered via a real object URL,
// never the base64 round-trip) AND the offscreen API-surface fix (the bundle
// must not touch forbidden APIs at all).
//
// Usage:  node scripts/e2e-offscreen.js [path/to/js/offscreen.js]
// Exit code 0 = object-URL pipeline works end to end.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const JSZip = require("jszip");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "offscreen.js");
const code = fs.readFileSync(bundlePath, "utf8");

// --- chrome stub (offscreen document: chrome.runtime ONLY) ------------------
let onMessageHandler = null;
const sentMessages = [];
const downloads = [];                 // what the (simulated) worker downloaded
const tabFetches = [];                 // fetchInTab / fetchUrlInTab relays

// Options exactly as the service worker relays them (it reads
// chrome.storage.sync on the document's behalf).
const relayedOptions = {
    useZip: "zip",
    downloadName: "{pretty}",
    duplicateBehaviour: "rename",
    replaceSpaces: true,
    downloadSeparately: false,
    maxConcurrentDownloads: "3",
    htmlParsing: false
};

const chromeCore = {
    tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} }, query() {} },
    action: { setIcon() {} },
    runtime: {
        onMessage: { addListener(fn) { onMessageHandler = fn; } },
        sendMessage(msg, cb) {
            sentMessages.push(msg);
            if (!msg || msg.from !== "offscreen") return;
            if (msg.action === "saveDownload") {
                // The service worker calls chrome.downloads.download here.
                downloads.push({ url: msg.url, filename: msg.filename });
                if (cb) setTimeout(() => cb({ result: 7 }), 0);
            } else if (msg.action === "fetchInTab") {
                // The service worker injects fetchImageInPage into the tab.
                tabFetches.push({ kind: "image", url: msg.url, world: msg.world });
                const bytes = tabImageBytesFor(msg.url);
                const resp = bytes
                    ? { ok: true, status: 200, statusText: "OK", contentType: "image/jpeg", b64: Buffer.from(bytes).toString("base64"), error: null }
                    : { ok: false, status: 404, statusText: "Not Found", contentType: null, b64: null, error: null };
                if (cb) setTimeout(() => cb(resp), 0);
            } else if (msg.action === "fetchUrlInTab") {
                // The service worker injects fetchUrlInPage into the tab.
                tabFetches.push({ kind: "url", url: msg.url });
                const text = tabUrlTextFor(msg.url);
                const resp = text !== null
                    ? { ok: true, status: 200, statusText: "OK", contentType: "application/json", text: text, error: null }
                    : { ok: false, status: 404, statusText: "Not Found", contentType: null, text: null, error: null };
                if (cb) setTimeout(() => cb(resp), 0);
            }
            // updateProgress/downloadError/batchProgress/batchSummary/
            // offscreenIdle are fire-and-forget; the real worker answers none
            // of them (its listener returns false).
        },
        lastError: null
    }
};

// Count accesses to APIs that must NOT exist in an offscreen document. The
// bundle may CHECK for chrome.scripting (it falls back to relaying), but it
// must never use chrome.storage or chrome.downloads.
const forbidden = { storage: 0, downloads: 0, scripting: 0 };
const chromeStub = new Proxy(chromeCore, {
    get(target, prop) {
        if (prop === "storage" || prop === "downloads" || prop === "scripting") {
            forbidden[prop]++;
            return undefined; // exactly like real Chrome offscreen documents
        }
        return target[prop];
    }
});

// --- object URL stub (the reason the offscreen document exists) -------------
const objectBlobs = {};   // blobUrl -> Blob
const revokedUrls = [];
let blobCounter = 0;
const URLStub = {
    createObjectURL(blob) {
        blobCounter++;
        const url = "blob:nhtest/" + blobCounter;
        objectBlobs[url] = blob;
        return url;
    },
    revokeObjectURL(url) {
        revokedUrls.push(url);
    }
};

// --- fetch stub: nhentai API + image CDN ------------------------------------
const GALLERY_ID = 123456;
const MEDIA_ID = 987654;
const GALLERY_ID2 = 654321;
const MEDIA_ID2 = 456789;

const galleryJson = {
    id: GALLERY_ID,
    media_id: MEDIA_ID,
    title: { english: "Test", japanese: "", pretty: "Test" },
    images: { pages: [{ t: "j" }, { t: "p" }, { t: "j" }] },
    tags: []
};

const galleryJson2 = {
    id: GALLERY_ID2,
    media_id: MEDIA_ID2,
    title: { english: "Test Two", japanese: "", pretty: "Test Two" },
    images: { pages: [{ t: "j" }, { t: "j" }, { t: "j" }] },
    tags: []
};

const galleryById = {
    [GALLERY_ID]: galleryJson,
    [GALLERY_ID2]: galleryJson2
};

// Minimal JPEGs with real SOF0 frames (distinct dimensions) so the PDF path
// can parse dimensions and embed the bytes verbatim.
function jpegPage(width, height) {
    const b = new Uint8Array(2000);
    b.set([
        0xff, 0xd8,                          // SOI
        0xff, 0xc0, 0x00, 0x11, 0x08,        // SOF0, length 17, precision 8
        (height >> 8) & 0xff, height & 0xff, // height
        (width >> 8) & 0xff, width & 0xff,   // width
        0x03,                                // 3 components (RGB)
        0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
    ]);
    b[b.length - 2] = 0xff;
    b[b.length - 1] = 0xd9;                  // EOI
    return b;
}
const pageBytes = [jpegPage(1280, 1808), jpegPage(1280, 1700), jpegPage(1280, 1600)];

let failImages = false;
const failMediaIds = new Set();

function imageBytesFor(url) {
    const imgMatch = /nhentai\.net\/galleries\/([0-9]+)\/([0-9]+)\.(jpg|png)/.exec(String(url));
    if (!imgMatch) return null;
    const mediaId = imgMatch[1];
    const pageNo = parseInt(imgMatch[2], 10);
    if (failImages || failMediaIds.has(mediaId)) return null;
    return pageBytes[(pageNo - 1) % pageBytes.length];
}

// All URLs the offscreen document fetched directly (no source tab): used to
// prove which CDN host URL generation actually used.
const fetchedUrls = [];

function fetchStub(url) {
    const u = String(url);
    fetchedUrls.push(u);
    const apiMatch = /\/api\/(?:v2\/galleries|gallery)\/([0-9]+)/.exec(u);
    if (apiMatch) {
        const gallery = galleryById[apiMatch[1]];
        if (gallery) return Promise.resolve(new Response(JSON.stringify(gallery), { status: 200 }));
    }
    const imgMatch = /nhentai\.net\/galleries\/([0-9]+)\/([0-9]+)\.(jpg|png)/.exec(u);
    if (imgMatch) {
        if (failImages || failMediaIds.has(imgMatch[1])) {
            return Promise.resolve(new Response("nope", { status: 404 }));
        }
        return Promise.resolve(new Response(pageBytes[(parseInt(imgMatch[2], 10) - 1) % pageBytes.length], { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
}

// The simulated tab's view of the world (what chrome.scripting injections in
// the real worker would fetch with the tab's session).
function tabImageBytesFor(url) {
    return imageBytesFor(url);
}

function tabUrlTextFor(url) {
    const apiMatch = /\/api\/(?:v2\/galleries|gallery)\/([0-9]+)/.exec(String(url));
    if (apiMatch) {
        const gallery = galleryById[apiMatch[1]];
        return gallery ? JSON.stringify(gallery) : null;
    }
    return null;
}

// --- anchor download stub (blob artifacts save via a same-context <a> click) --
// The offscreen document saves zip/cbz/pdf blobs through an anchor whose
// download attribute carries the name (chrome.downloads.download ignores the
// filename for blob: URLs on some Chromium builds). Capture the clicked
// anchors so the test can assert the requested URL + filename.
const anchorDownloads = []; // { href, download }
const documentStub = {
    createElement(tag) {
        return {
            tagName: String(tag).toUpperCase(),
            href: "",
            download: "",
            style: {},
            click() {
                if (this.href) {
                    anchorDownloads.push({ href: this.href, download: this.download });
                }
            }
        };
    },
    body: {
        appendChild(_node) { /* no-op */ },
        removeChild(_node) { /* no-op */ }
    }
};

// --- sandbox (single VM realm; document defined like an offscreen page) -----
const sandbox = {
    chrome: chromeStub,
    console,
    __NHDW_SILENT_RETRY_LOGS__: true,
    setTimeout,
    clearTimeout,
    fetch: fetchStub,
    Response,
    Blob,   // jszip needs a Blob constructor for generateAsync({type:"blob"})
    URL: URLStub,
    AbortController,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    document: documentStub // offscreen documents have a DOM; Downloader then zips without web workers
    // NOTE: do not inject host Uint8Array/ArrayBuffer/Promise built-ins; they
    // would shadow the VM's own intrinsics and break instanceof checks.
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const vmCtx = vm.createContext(sandbox);

// Minimal FileReader (Node has none): copies the host ArrayBuffer into a
// VM-native one from the SAME realm the bundle runs in.
class FileReaderStub {
    readAsArrayBuffer(blob) {
        blob.arrayBuffer().then(
            (buf) => {
                const bytes = Array.from(new Uint8Array(buf));
                this.result = vm.runInContext("(b) => new Uint8Array(b).buffer", vmCtx)(bytes);
                if (this.onload) this.onload();
            },
            (err) => { this.error = err; if (this.onerror) this.onerror(err); }
        );
    }
}
sandbox.FileReader = FileReaderStub;

function fail(msg) {
    console.error("FAIL: " + msg);
    process.exit(1);
}

process.on("unhandledRejection", (reason) => {
    fail("unhandled rejection: " + (reason && reason.stack ? reason.stack : reason));
});
process.on("uncaughtException", (err) => {
    fail("uncaught exception: " + (err && err.stack ? err.stack : err));
});

async function waitFor(predicate, what, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    if (!predicate()) fail(what + " (timeout after " + timeoutMs + "ms)");
}

function askOffscreen(message) {
    return new Promise((resolve, reject) => {
        onMessageHandler(
            Object.assign({ target: "offscreen" }, message),
            {},
            (response) => resolve(response)
        );
    });
}

(async () => {
    try {
        vm.runInContext(code, vmCtx, { filename: bundlePath });
    } catch (err) {
        fail("bundle threw while loading: " + err.name + ": " + err.message +
            " (an offscreen document without chrome.storage must still load)");
    }
    if (!onMessageHandler) fail("onMessage listener was never registered");

    // Idle state before any work.
    const idleAnswer = await askOffscreen({ action: "isDownloadFinished" });
    if (!idleAnswer || idleAnswer.result !== true) {
        fail("isDownloadFinished should be true while idle, got " + JSON.stringify(idleAnswer));
    }

    // Start a download the way the service worker would relay it (with the
    // options the worker read from chrome.storage.sync on the document's
    // behalf — the document itself has no storage access). Run the start and
    // the isDownloadFinished probe back-to-back synchronously so the download
    // cannot complete in between: while the job is running, isDownloadFinished
    // must answer false (the jobRunning flag) rather than the per-gallery
    // isDone() that used to flip true between galleries and mislead the worker.
    let startAnswer = null;
    onMessageHandler({
        target: "offscreen",
        action: "downloadDoujinshi",
        json: galleryJson,
        path: "Downloads/Test",
        name: "Test",
        options: relayedOptions
    }, {}, (r) => { startAnswer = r; });
    if (!startAnswer || startAnswer.result !== "started") {
        fail("downloadDoujinshi did not answer {result:'started'}, got " + JSON.stringify(startAnswer));
    }
    let busyAnswer = null;
    onMessageHandler({ target: "offscreen", action: "isDownloadFinished" }, {}, (r) => { busyAnswer = r; });
    if (!busyAnswer || busyAnswer.result !== false) {
        fail("isDownloadFinished must be false while a job is running, got " + JSON.stringify(busyAnswer));
    }

    const progressAnswer = await askOffscreen({ action: "getProgress" });
    if (!progressAnswer || progressAnswer.result !== "success") {
        fail("getProgress did not answer success, got " + JSON.stringify(progressAnswer));
    }

    // Wait for the ZIP to reach the download manager. Blob artifacts are saved
    // via a same-context anchor click (chrome.downloads.download ignores the
    // filename for blob: URLs on some Chromium builds), so the delivery shows
    // up as a clicked anchor carrying the blob URL + requested name.
    await waitFor(() => anchorDownloads.length === 1, "no blob artifact reached the download anchor");
    const download = anchorDownloads[0];

    if (!/^blob:/.test(download.href)) {
        fail("anchor URL is not an object URL: " + String(download.href).slice(0, 60) +
            " (the base64 data-URL round-trip must not be used in the offscreen document)");
    }
    if (download.download !== "Downloads/Test.zip") {
        fail("unexpected download filename: " + download.download);
    }

    const blob = objectBlobs[download.href];
    if (!blob) fail("object URL was not created through URL.createObjectURL");

    // The popup must have received progress broadcasts marked from:"offscreen".
    const progressMessages = sentMessages.filter((m) => m.action === "updateProgress" && m.from === "offscreen");
    if (progressMessages.length === 0) {
        fail("no updateProgress broadcasts were sent to the popup");
    }

    // Decode the ZIP handed to the download manager.
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length < 4 || buf.toString("latin1", 0, 2) !== "PK") {
        fail("blob handed to the download manager is not a ZIP (missing PK header)");
    }
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    // Single-gallery archives are flat: pages at the root, archive named
    // after the gallery (no Title/Title double folder).
    const expected = ["001.jpg", "002.png", "003.jpg"];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
        fail("ZIP entries mismatch. Expected " + JSON.stringify(expected) + " got " + JSON.stringify(names));
    }
    for (let i = 0; i < expected.length; i++) {
        const content = new Uint8Array(await zip.file(expected[i]).async("uint8array"));
        const want = pageBytes[i];
        if (content.length !== want.length || !want.every((b, j) => b === content[j])) {
            fail("ZIP entry " + expected[i] + " content does not match the fetched page bytes");
        }
    }

    // goBack must succeed and the finished flag must be true.
    const goBackAnswer = await askOffscreen({ action: "goBack" });
    if (!goBackAnswer || goBackAnswer.result !== "success") {
        fail("goBack did not answer success, got " + JSON.stringify(goBackAnswer));
    }
    const doneAnswer = await askOffscreen({ action: "isDownloadFinished" });
    if (!doneAnswer || doneAnswer.result !== true) {
        fail("isDownloadFinished should be true after completion, got " + JSON.stringify(doneAnswer));
    }

    // The document must tell the worker the job finished (jobFinished) so the
    // worker clears its active-job marker promptly instead of waiting for the
    // 60s idle close (which left the marker set and made the popup misreport a
    // successful download as "interrupted").
    await waitFor(
        () => sentMessages.some((m) => m.action === "jobFinished" && m.from === "offscreen"),
        "the offscreen document did not send jobFinished after the download completed"
    );

    console.log("PASS: ZIP (" + buf.length + " bytes) delivered via object URL " + download.url);
    console.log("PASS: entries: " + names.join(", ") + "; " + progressMessages.length + " progress broadcasts");

    // ---- Tab-first image fetches must be relayed to the service worker ----
    // With a sourceTabId, the document cannot use chrome.scripting itself; it
    // must ask the worker to inject the fetch into the tab (ISOLATED first,
    // then MAIN on failure), and must NOT fall back to an extension fetch.
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    tabFetches.length = 0;
    const tabStart = await askOffscreen({
        action: "downloadDoujinshi",
        json: galleryJson,
        path: "Downloads/TabTest",
        name: "TabTest",
        tabId: 42,
        options: relayedOptions
    });
    if (!tabStart || tabStart.result !== "started") {
        fail("tab downloadDoujinshi did not answer {result:'started'}, got " + JSON.stringify(tabStart));
    }
    await waitFor(() => anchorDownloads.length === 1, "tab download did not reach the download anchor");
    const tabImageFetches = tabFetches.filter((t) => t.kind === "image");
    if (tabImageFetches.length === 0) {
        fail("tab image fetches were not relayed to the service worker (fetchInTab)");
    }
    if (tabImageFetches[0].world !== "ISOLATED") {
        fail("the first tab image fetch relay must use the ISOLATED world, got " + tabImageFetches[0].world);
    }
    const tabDownload = anchorDownloads[0];
    if (tabDownload.download !== "Downloads/TabTest.zip") {
        fail("unexpected tab download filename: " + tabDownload.download);
    }
    const tabZip = await JSZip.loadAsync(Buffer.from(await objectBlobs[tabDownload.href].arrayBuffer()));
    if (Object.keys(tabZip.files).filter((n) => !tabZip.files[n].dir).length !== 3) {
        fail("tab-fetched ZIP must contain 3 pages, got " + JSON.stringify(Object.keys(tabZip.files)));
    }
    console.log("PASS: tab image fetches relayed to the worker (ISOLATED first) and the ZIP is complete");

    // ---- Batch download with a failing gallery must report exactly once ----
    // Regression guard: the Downloader surfaces a gallery failure through
    // errorCallback and then re-throws; the batch loop must swallow that
    // re-throw so the outer catch does not report the same failure twice.
    // A batchSummary must still be emitted with the failure counted.
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    failImages = true;
    const batchStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "Test" },
        finalName: "Downloads/Batch",
        options: relayedOptions
    });
    if (!batchStart || batchStart.result !== "started") {
        fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(batchStart));
    }
    await waitFor(
        () => sentMessages.filter((m) => m.action === "downloadError").length >= 1,
        "no downloadError was sent for the failing batch gallery"
    );
    const errorCount = sentMessages.filter((m) => m.action === "downloadError").length;
    if (errorCount !== 1) {
        fail("batch gallery failure must be reported exactly once, got " + errorCount +
            ": " + JSON.stringify(sentMessages.filter((m) => m.action === "downloadError")));
    }
    if (anchorDownloads.length !== 0) {
        fail("no ZIP must be delivered when the batch gallery fails, got " + anchorDownloads.length);
    }
    const failSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!failSummary || failSummary.succeeded !== 0 || failSummary.failed !== 1 || failSummary.total !== 1 || failSummary.skipped !== 0) {
        fail("batchSummary must report 0/1/1 skipped:0 for a single failing gallery, got " + JSON.stringify(failSummary));
    }
    if (!failSummary.failedKinds || failSummary.failedKinds.image !== 1) {
        fail("the failing gallery is an image failure; failedKinds must be {image:1}, got " + JSON.stringify(failSummary.failedKinds));
    }
    console.log("PASS: batch gallery failure reported exactly once (no double report)");

    // ---- Mixed batch: a failure must not stop the remaining galleries ------
    // The unknown gallery (metadata 404) is tallied as a failure; the known
    // gallery after it still downloads and the summary reports 1/1/2.
    // NOTE: JS orders integer-like object keys ascending, so the failing
    // gallery must have a smaller key than the successful one for the
    // successful gallery to be processed last (the ZIP is emitted on the
    // last gallery when downloadAtEnd is true).
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    failImages = false;
    const mixedStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { "1": "Missing", [GALLERY_ID]: "Test" },
        finalName: "Downloads/Mixed",
        options: relayedOptions
    });
    if (!mixedStart || mixedStart.result !== "started") {
        fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(mixedStart));
    }
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the mixed batch"
    );
    const mixedSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!mixedSummary || mixedSummary.succeeded !== 1 || mixedSummary.failed !== 1 || mixedSummary.total !== 2 || mixedSummary.skipped !== 0) {
        fail("mixed batch summary must report 1/1/2 skipped:0, got " + JSON.stringify(mixedSummary));
    }
    if (!mixedSummary.failedKinds || mixedSummary.failedKinds.metadata !== 1) {
        fail("the missing gallery is a metadata failure; failedKinds must be {metadata:1}, got " + JSON.stringify(mixedSummary.failedKinds));
    }
    if (anchorDownloads.length !== 1) {
        fail("the successful gallery in the mixed batch must deliver a ZIP, got " + anchorDownloads.length);
    }
    if (sentMessages.filter((m) => m.action === "batchProgress").length < 2) {
        fail("batchProgress must be sent before each gallery");
    }
    console.log("PASS: batch continues after a gallery failure and reports 1/1/2");

    // ---- Persistent history: already-downloaded ids are skipped, zero API ---
    // The worker relays the recorded ID list with the job (the offscreen
    // document has no chrome.storage). A recorded gallery in SEPARATE mode is
    // not fetched at all (no API call, no progress broadcast) unless it is in
    // the user's redownloadIds. A merged batch keeps every title.
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    fetchedUrls.length = 0;
    const skipStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
        finalName: "Downloads/Skip",
        options: Object.assign({}, relayedOptions, { downloadSeparately: true, alreadyDownloadedIds: [GALLERY_ID2], redownloadIds: [] })
    });
    if (!skipStart || skipStart.result !== "started") {
        fail("history-skip batch did not answer {result:'started'}, got " + JSON.stringify(skipStart));
    }
    await waitFor(() => sentMessages.some((m) => m.action === "batchSummary"), "history-skip batch must finish");
    const skipSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!skipSummary || skipSummary.succeeded !== 1 || skipSummary.failed !== 0 || skipSummary.total !== 2 || skipSummary.skipped !== 1) {
        fail("history-skip batchSummary must report 1/0/2 skipped:1, got " + JSON.stringify(skipSummary));
    }
    if (anchorDownloads.length !== 1 || anchorDownloads[0].download !== "Test.zip") {
        fail("only the un-recorded gallery must download, got " + JSON.stringify(anchorDownloads));
    }
    if (fetchedUrls.some(
        (u) => u.includes("/api/v2/galleries/" + GALLERY_ID2) || u.includes("/galleries/" + MEDIA_ID2 + "/")
    )) {
        fail("a recorded gallery must not be fetched at all (zero API calls): " + JSON.stringify(fetchedUrls));
    }
    const skipProgress = sentMessages.filter((m) => m.action === "batchProgress");
    if (skipProgress.length !== 1 || skipProgress[0].galleryName !== "One") {
        fail("no batchProgress may be sent for a skipped gallery, got " + JSON.stringify(skipProgress));
    }
    const skipRecords = sentMessages.filter((m) => m.action === "jobFinished").map((m) => m.records).pop();
    if (!skipRecords || skipRecords.length !== 1 || String(skipRecords[0].id) !== String(GALLERY_ID)) {
        fail("jobFinished must carry exactly the newly-downloaded record, got " + JSON.stringify(skipRecords));
    }
    console.log("PASS: recorded gallery skipped without API calls; redownload override still works");

    // ---- Download anyway: redownloadIds re-fetch recorded galleries ---------
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    fetchedUrls.length = 0;
    const overrideStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID2]: "Two" },
        finalName: "Downloads/Override",
        options: Object.assign({}, relayedOptions, { downloadSeparately: true, alreadyDownloadedIds: [GALLERY_ID2], redownloadIds: [GALLERY_ID2] })
    });
    if (!overrideStart || overrideStart.result !== "started") {
        fail("override batch did not answer {result:'started'}, got " + JSON.stringify(overrideStart));
    }
    await waitFor(() => anchorDownloads.length === 1, "override must re-download the recorded gallery");
    const overrideFetches = fetchedUrls.filter(
        (u) => u.includes("/api/v2/galleries/" + GALLERY_ID2) || u.includes("/galleries/" + MEDIA_ID2 + "/")
    );
    if (overrideFetches.length === 0) {
        fail("redownloadIds must make the recorded gallery fetch metadata+images, got " + JSON.stringify(fetchedUrls));
    }
    console.log("PASS: redownloadIds overrides the history guard");

    // ---- Merged batch never skips: every title is needed in one archive -----
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    fetchedUrls.length = 0;
    const mergedStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
        finalName: "Downloads/MergedHistory",
        options: Object.assign({}, relayedOptions, { alreadyDownloadedIds: [GALLERY_ID2], redownloadIds: [] })
    });
    if (!mergedStart || mergedStart.result !== "started") {
        fail("merged history batch did not answer {result:'started'}, got " + JSON.stringify(mergedStart));
    }
    await waitFor(() => anchorDownloads.length === 1, "merged batch must still deliver the one archive");
    const mergedSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!mergedSummary || mergedSummary.skipped !== 0 || mergedSummary.succeeded !== 2) {
        fail("merged batch must not skip recorded titles, got " + JSON.stringify(mergedSummary));
    }
    console.log("PASS: merged batch keeps every title (one archive needs them all)");

    // ---- Batch metadata for unresolved ids reuses the user tab's session ---
    // Without galleryMetadata and WITH a sourceTabId, the document must fetch
    // the gallery API through the tab (fetchUrlInTab relay) instead of the
    // extension-origin fetch that Cloudflare 403s.
    sentMessages.length = 0;
    downloads.length = 0;
    tabFetches.length = 0;
    const tabMetaStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "Test" },
        finalName: "Downloads/TabMeta",
        tabId: 42,
        options: relayedOptions
    });
    if (!tabMetaStart || tabMetaStart.result !== "started") {
        fail("tab metadata batch did not answer {result:'started'}, got " + JSON.stringify(tabMetaStart));
    }
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the tab-metadata batch"
    );
    const tabMetaSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!tabMetaSummary || tabMetaSummary.succeeded !== 1 || tabMetaSummary.failed !== 0) {
        fail("tab metadata batch must succeed 1/1, got " + JSON.stringify(tabMetaSummary));
    }
    const tabUrlFetches = tabFetches.filter((t) => t.kind === "url" && /\/api\/(?:v2\/galleries|gallery)\//.test(t.url));
    if (tabUrlFetches.length === 0) {
        fail("unresolved batch metadata was not fetched through the user tab (fetchUrlInTab)");
    }
    console.log("PASS: unresolved batch metadata fetched through the user tab's session");

    // ---- Three-gallery queue with mixed failures ----------------------------
    // Same queue guarantees as the worker suite: per-gallery progress, the loop
    // continues past a metadata failure AND an image failure, the last gallery
    // still emits the single final ZIP, and the summary carries per-kind counts.
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    tabFetches.length = 0;
    failMediaIds.clear();
    failMediaIds.add(String(MEDIA_ID));
    const queueStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { "1": "Missing", [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
        finalName: "Downloads/Queue",
        options: relayedOptions
    });
    if (!queueStart || queueStart.result !== "started") {
        fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(queueStart));
    }
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the queue batch"
    );
    const queueSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!queueSummary || queueSummary.succeeded !== 1 || queueSummary.failed !== 2 || queueSummary.total !== 3) {
        fail("queue batch summary must report 1/2/3, got " + JSON.stringify(queueSummary));
    }
    if (!queueSummary.failedKinds
        || queueSummary.failedKinds.metadata !== 1
        || queueSummary.failedKinds.image !== 1) {
        fail("queue batch failedKinds must be {metadata:1, image:1}, got " + JSON.stringify(queueSummary.failedKinds));
    }
    if (anchorDownloads.length !== 1) {
        fail("exactly one ZIP must be delivered (from the last gallery), got " + anchorDownloads.length);
    }
    if (sentMessages.filter((m) => m.action === "downloadError").length !== 2) {
        fail("both failing galleries must report exactly one error each");
    }
    if (sentMessages.filter((m) => m.action === "batchProgress").length !== 3) {
        fail("batchProgress must be sent for all 3 queued galleries");
    }
    console.log("PASS: three-gallery queue continues past metadata+image failures and reports 1/2/3");

    // ---- Separate-files batch: one archive per gallery, no false notice -----
    // The user's worst real-browser symptom: with "separate files per title",
    // only the first gallery downloaded and the rest looked "interrupted".
    // That came from the stale job marker + per-gallery isDone() misreporting
    // between galleries. Here we prove the loop itself is sound: each gallery
    // emits its OWN archive with its OWN name, and the whole job is reported
    // finished exactly once at the end (so the worker clears its marker).
    sentMessages.length = 0;
    downloads.length = 0;
    anchorDownloads.length = 0;
    tabFetches.length = 0;
    failMediaIds.clear();
    const separateOptions = Object.assign({}, relayedOptions, { downloadSeparately: true });
    const separateStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
        finalName: "Downloads/Separate",
        options: separateOptions
    });
    if (!separateStart || separateStart.result !== "started") {
        fail("separate-files batch did not answer {result:'started'}, got " + JSON.stringify(separateStart));
    }
    const queuedStart = await askOffscreen({
        action: "downloadDoujinshi",
        json: galleryJson,
        path: "Downloads/Queued",
        name: "Queued",
        options: relayedOptions
    });
    if (!queuedStart || queuedStart.result !== "queued" || queuedStart.position !== 1) {
        fail("second job must be queued at position 1, got " + JSON.stringify(queuedStart));
    }
    await waitFor(
        () => anchorDownloads.length === 3,
        "separate-files batch followed by a queued gallery must emit three archives"
    );
    const separateFilenames = anchorDownloads.map((d) => d.download).sort();
    // Separate-file names now go through utils.cleanName exactly like a
    // single-title download (relayedOptions has replaceSpaces: true), so
    // "Test Two" becomes "Test_Two" instead of keeping the raw title. Before
    // 3.4.0 the batch used the raw title here while single titles were
    // cleaned - the two paths disagreed.
    const expectedSeparate = ["Test.zip", "Test_Two.zip", "Downloads/Queued.zip"].sort();
    if (JSON.stringify(separateFilenames) !== JSON.stringify(expectedSeparate)) {
        fail("separate-files filenames mismatch. Expected " + JSON.stringify(expectedSeparate) +
            " got " + JSON.stringify(separateFilenames));
    }
    // Each archive must be a real ZIP with its own 3 pages inside.
    for (const d of anchorDownloads) {
        const b = Buffer.from(await objectBlobs[d.href].arrayBuffer());
        if (b.length < 4 || b.toString("latin1", 0, 2) !== "PK") {
            fail("separate-files archive is not a ZIP: " + d.download);
        }
        const z = await JSZip.loadAsync(b);
        const entries = Object.keys(z.files).filter((n) => !z.files[n].dir);
        if (entries.length !== 3) {
            fail("separate-files archive " + d.download + " must contain 3 pages, got " + JSON.stringify(entries));
        }
    }
    // Exactly one jobFinished at the end (not one per gallery, not none).
    await waitFor(
        () => sentMessages.filter((m) => m.action === "jobFinished").length === 1,
        "separate-files batch must send exactly one jobFinished at the end"
    );
    const separateSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!separateSummary || separateSummary.succeeded !== 2 || separateSummary.failed !== 0) {
        fail("separate-files batchSummary must report 2/0/2, got " + JSON.stringify(separateSummary));
    }
    console.log("PASS: separate-files batch emits one archive per gallery (no interruption false positive)");

    // ---- Relayed CDN image servers drive URL generation --------------------
    // The worker resolved GET /api/v2/cdn, validated the hosts, and relayed
    // the list with the job options. A runtime-reported mirror (i7, outside
    // the hardcoded set) must be used for the page URLs; a hostile entry the
    // worker would never relay is still dropped by the shared sanitizer.
    downloads.length = 0;
    anchorDownloads.length = 0;
    sentMessages.length = 0;
    fetchedUrls.length = 0;
    let cdnStartAnswer = null;
    onMessageHandler({
        target: "offscreen",
        action: "downloadDoujinshi",
        json: galleryJson,
        path: "Downloads/CdnTest",
        name: "CdnTest",
        options: Object.assign({}, relayedOptions, {
            imageServers: ["https://i7.nhentai.net", "https://evil.example", "not a server"]
        })
    }, {}, (r) => { cdnStartAnswer = r; });
    if (!cdnStartAnswer || cdnStartAnswer.result !== "started") {
        fail("relayed-CDN downloadDoujinshi did not answer {result:'started'}, got " + JSON.stringify(cdnStartAnswer));
    }
    await waitFor(() => anchorDownloads.length === 1, "relayed-CDN job did not deliver its ZIP");
    const cdnPageFetches = fetchedUrls.filter((u) => u.includes("/galleries/987654/"));
    if (cdnPageFetches.length !== 3 || !cdnPageFetches.every((u) => u.startsWith("https://i7.nhentai.net/"))) {
        fail("page URLs must be generated from the relayed runtime server (i7) only, got: "
            + JSON.stringify(cdnPageFetches));
    }
    if (fetchedUrls.some((u) => u.includes("evil.example"))) {
        fail("an invalid relayed server must never be contacted: " + JSON.stringify(fetchedUrls));
    }
    console.log("PASS: relayed CDN image servers drive URL generation (runtime mirror first, invalid entries dropped)");

    // ---- PDF mode: one titled PDF file per gallery --------------------------
    downloads.length = 0;
    anchorDownloads.length = 0;
    sentMessages.length = 0;
    fetchedUrls.length = 0;
    const pdfStart = await askOffscreen({
        action: "downloadDoujinshi",
        json: galleryJson,
        path: "Downloads/PdfTest",
        name: "PdfTest",
        options: Object.assign({}, relayedOptions, { useZip: "pdf" })
    });
    if (!pdfStart || pdfStart.result !== "started") {
        fail("PDF downloadDoujinshi did not answer {result:'started'}, got " + JSON.stringify(pdfStart));
    }
    await waitFor(() => anchorDownloads.length === 1, "PDF job did not deliver its file");
    const pdfDownload = anchorDownloads[0];
    if (pdfDownload.download !== "Downloads/PdfTest.pdf") {
        fail("PDF filename must be the gallery name, got " + pdfDownload.download);
    }
    const pdfBytes = Buffer.from(await objectBlobs[pdfDownload.href].arrayBuffer());
    const pdfText = pdfBytes.toString("latin1");
    if (!pdfText.startsWith("%PDF-1.4") || !pdfText.endsWith("%%EOF\n")) {
        fail("PDF structure invalid (header/trailer)");
    }
    if (!pdfText.includes("/Count 3") || pdfText.split("/Filter /DCTDecode").length - 1 !== 3) {
        fail("PDF must embed one JPEG per page (3 pages)");
    }
    if (!pdfText.includes("/MediaBox [0 0 1280 1808]")) {
        fail("PDF page 1 must use the image dimensions");
    }
    console.log("PASS: PDF mode delivered " + pdfBytes.length + " bytes as " + pdfDownload.download);

    // ---- The document must have stayed inside its API surface --------------
    if (forbidden.storage !== 0 || forbidden.downloads !== 0) {
        fail("offscreen document touched forbidden APIs: storage=" + forbidden.storage +
            " downloads=" + forbidden.downloads +
            " (only chrome.runtime is available in offscreen documents)");
    }
    console.log("PASS: offscreen document used chrome.runtime only (no storage/downloads access)");

    console.log("PASS: offscreen document pipeline works with no base64 round-trip.");
    process.exit(0);
})();
