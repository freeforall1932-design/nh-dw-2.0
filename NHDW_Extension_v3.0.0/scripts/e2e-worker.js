// End-to-end worker test: load the built background.js in a window-less
// context and drive real downloadDoujinshi messages through the entire
// pipeline: metadata -> image fetch (mocked CDN) -> JSZip -> chrome.downloads.
//
// Phases:
//   1. ZIP mode: a valid ZIP with the expected entries reaches chrome.downloads.
//   2. Raw mode: each page is handed to chrome.downloads as a plain image URL.
//   3. Raw mode with failing downloads: the error is reported to the popup
//      (Promise-wrapped callback), not silently dropped.
//   8. CDN configuration hardening: fetched once, cached in the session,
//      merged with fallback mirrors.
//   9. API key mode: a keyed batch resolves metadata through the official API
//      with an Authorization: Key header.
//   10. Keyless mode: batch metadata requests carry no Authorization header.
//
// Usage:  node test/e2e-worker.js [path/to/js/background.js]
// Exit code 0 = all phases passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const JSZip = require("jszip");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "background.js");
const code = fs.readFileSync(bundlePath, "utf8");

// --- chrome stub ---------------------------------------------------------
let onMessageHandler = null;
const sentMessages = [];
const downloads = [];

let syncSettings = { useZip: "zip", maxConcurrentDownloads: "3" };
let localSettings = {}; // chrome.storage.local (API key mode lives here)
let downloadFails = false;
let expectedWorkerRejection = false;

// Every request the worker makes to an /api/ route, with the Authorization
// header it carried (null when none). Phases 8/9 assert the mode boundary.
const apiRequestLog = [];

const sessionStore = {};   // chrome.storage.session (survives worker restarts in the test)

// GET /api/v2/cdn fixture: reports a mirror OUTSIDE the hardcoded set so the
// phase asserts prove the worker actually resolved runtime CDN config.
const CDN_CONFIG_FIXTURE = JSON.stringify({
    image_servers: ["https://i5.nhentai.net"],
    thumb_servers: ["https://t.nhentai.net"]
});
let cdnConfigFetches = 0;

const chromeStub = {
    tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query(_query, cb) { cb([{ url: "https://nhentai.net/g/123456/" }]); }
    },
    action: { setIcon() {} },
    permissions: {
        // The manifest's optional_host_permissions grant check.
        contains(_permissions, cb) { cb(true); }
    },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults, syncSettings)); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults, localSettings)); } },
        session: {
            get(key, cb) {
                cb(typeof key === "string" ? { [key]: sessionStore[key] } : Object.assign({}, sessionStore));
            },
            set(items, cb) { Object.assign(sessionStore, items); if (cb) cb(); },
            remove(key, cb) { delete sessionStore[key]; if (cb) cb(); }
        }
    },
    runtime: {
        onMessage: { addListener(fn) { onMessageHandler = fn; } },
        sendMessage(msg) { sentMessages.push(msg); },
        lastError: null
    },
    downloads: {
        download(opts, cb) {
            downloads.push(opts);
            if (downloadFails) {
                chromeStub.runtime.lastError = { message: "download failed (test)" };
                if (cb) cb(undefined);
            } else if (cb) {
                cb(1); // success, downloadId = 1
            }
        }
    }
};

// --- fetch stub: nhentai API + image CDN --------------------------------
const GALLERY_ID = 123456;
const MEDIA_ID = 987654;
const GALLERY_ID2 = 654321;
const MEDIA_ID2 = 456789;

const galleryJson = {
    id: GALLERY_ID,
    media_id: MEDIA_ID,
    title: { english: "Test", japanese: "", pretty: "Test" },
    images: {
        pages: [
            { t: "j", w: 1280, h: 1800 },
            { t: "p", w: 1280, h: 1800 },
            { t: "j", w: 1280, h: 1800 }
        ]
    },
    tags: []
};

const galleryJson2 = {
    id: GALLERY_ID2,
    media_id: MEDIA_ID2,
    title: { english: "Test Two", japanese: "", pretty: "Test Two" },
    images: {
        pages: [
            { t: "j", w: 1280, h: 1800 },
            { t: "j", w: 1280, h: 1800 },
            { t: "j", w: 1280, h: 1800 }
        ]
    },
    tags: []
};

const galleryById = {
    [GALLERY_ID]: galleryJson,
    [GALLERY_ID2]: galleryJson2
};

// Distinct fake "image" bytes so we can confirm the ZIP has 3 different files.
// Each is a minimal JPEG with a real SOF0 frame (distinct dimensions per page)
// so the PDF output path can parse dimensions and embed the bytes verbatim.
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

function fetchStub(url, init) {
    const u = String(url);
    if (u.includes("/api/v2/cdn")) {
        cdnConfigFetches++;
        return Promise.resolve(new Response(CDN_CONFIG_FIXTURE, { status: 200 }));
    }
    const apiMatch = /\/api\/(?:v2\/galleries|gallery)\/([0-9]+)/.exec(u);
    if (apiMatch) {
        const headers = (init && init.headers) || {};
        apiRequestLog.push({
            url: u,
            auth: headers["Authorization"] || headers["authorization"] || null
        });
        const gallery = galleryById[apiMatch[1]];
        if (gallery) return Promise.resolve(new Response(JSON.stringify(gallery), { status: 200 }));
    }
    const imgMatch = /nhentai\.net\/galleries\/([0-9]+)\/([0-9]+)\.(jpg|png)/.exec(u);
    if (imgMatch) {
        const mediaId = imgMatch[1];
        const pageNo = parseInt(imgMatch[2], 10);
        if (failImages || failMediaIds.has(mediaId)) {
            return Promise.resolve(new Response("nope", { status: 404 }));
        }
        return Promise.resolve(new Response(pageBytes[(pageNo - 1) % pageBytes.length], { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
}

// --- sandbox (single VM realm, like a real service worker) ---------------
const sandbox = {
    chrome: chromeStub,
    console,
    __NHDW_SILENT_RETRY_LOGS__: true,
    setTimeout,
    clearTimeout,
    fetch: fetchStub,
    Response,
    Blob, // jszip needs a Blob constructor for generateAsync({type:"blob"})
    btoa,
    AbortController
    // NOTE: do not inject host built-ins like Uint8Array/ArrayBuffer/Promise:
    // they would shadow the VM's own intrinsics and break instanceof checks
    // inside the bundle (a real service worker uses a single realm).
};
sandbox.self = sandbox;      // MV3 service workers expose self, not window
sandbox.globalThis = sandbox;
const vmCtx = vm.createContext(sandbox);

// Minimal FileReader for the worker context (Node has no FileReader).
// It copies the host ArrayBuffer into a VM-native one from the SAME realm the
// bundle runs in, so `instanceof` checks inside the bundle (jszip's getTypeOf)
// behave like a real service worker.
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

// Promise rejections from inside the VM surface here; print them cleanly
// instead of dumping the minified bundle line. background.downloadDoujinshi
// intentionally fire-and-forgets startAsync(), so a download error surfaces
// as an unhandled rejection after the errorCallback has run.
process.on("unhandledRejection", (reason) => {
    if (expectedWorkerRejection) {
        console.log("(expected worker rejection after error callback: " +
            (reason && reason.message ? reason.message : reason) + ")");
        return;
    }
    fail("unhandled rejection: " + (reason && reason.stack ? reason.stack : reason));
});
process.on("uncaughtException", (err) => {
    fail("uncaught exception: " + (err && err.stack ? err.stack : err));
});

function fireDownload(path, name) {
    onMessageHandler(
        { action: "downloadDoujinshi", json: galleryJson, path, name },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("downloadDoujinshi did not answer {result: 'started'}, got " + JSON.stringify(result));
            }
        }
    );
}

async function waitFor(predicate, what, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    if (!predicate()) fail(what + " (timeout after " + timeoutMs + "ms)");
}

(async () => {
    try {
        vm.runInContext(code, vmCtx, { filename: bundlePath });
    } catch (err) {
        fail("bundle threw while loading: " + err.name + ": " + err.message);
    }
    if (!onMessageHandler) fail("onMessage listener was never registered");

    // ---- Phase 1: ZIP mode ------------------------------------------------
    syncSettings = { useZip: "zip", maxConcurrentDownloads: "3" };
    fireDownload("Downloads/Test", "Test");
    // The active-job marker must be set as soon as the job starts. The worker
    // resolves the CDN config first (one small fixture request), so the marker
    // appears within the resolution microtask chain rather than synchronously.
    await waitFor(
        () => sessionStore.downloadJob && sessionStore.downloadJob.active === true,
        "job marker must be active while a download runs"
    );
    await waitFor(() => downloads.length === 1, "no ZIP download reached chrome.downloads");
    await waitFor(() => sessionStore.downloadJob === undefined,
        "job marker must be cleared after the download completes");

    const download = downloads[0];
    if (!/^data:application\/zip;base64,/.test(download.url)) {
        fail("download URL is not a zip data URL: " + download.url.slice(0, 60) + "...");
    }
    const buf = Buffer.from(download.url.split(",")[1], "base64");
    if (buf.length < 4 || buf.toString("latin1", 0, 2) !== "PK") {
        fail("downloaded data is not a ZIP (missing PK header)");
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
    const zipProgress = sentMessages.filter((m) => m.action === "updateProgress").length;
    console.log("PASS phase 1: ZIP (" + buf.length + " bytes) delivered as " + download.filename +
        " with entries " + names.join(", ") + " (" + zipProgress + " progress messages)");

    // ---- Phase 2: raw mode (per-page downloads) ---------------------------
    downloads.length = 0;
    syncSettings = { useZip: "raw", maxConcurrentDownloads: "3", rawMasterFolder: "NHDW" };
    fireDownload("Downloads/RawTest", "RawTest");
    await waitFor(() => downloads.length === 3, "raw mode did not issue 3 per-page downloads");

    const rawUrls = downloads.map((d) => d.url).sort();
    // Raw mode hands the FIRST configured server to chrome.downloads: with the
    // /api/v2/cdn fixture active that is the runtime-reported i5 mirror, which
    // proves the CDN config flowed through validation into URL generation.
    const expectedRaw = [
        "https://i5.nhentai.net/galleries/987654/1.jpg",
        "https://i5.nhentai.net/galleries/987654/2.png",
        "https://i5.nhentai.net/galleries/987654/3.jpg"
    ];
    if (JSON.stringify(rawUrls) !== JSON.stringify(expectedRaw)) {
        fail("raw mode URLs mismatch. Expected " + JSON.stringify(expectedRaw) + " got " + JSON.stringify(rawUrls));
    }
    const rawNames = downloads.map((d) => d.filename).sort();
    const expectedRawNames = ["NHDW/Downloads/RawTest/001.jpg", "NHDW/Downloads/RawTest/002.png", "NHDW/Downloads/RawTest/003.jpg"];
    if (JSON.stringify(rawNames) !== JSON.stringify(expectedRawNames)) {
        fail("raw mode filenames must be a titled folder of numbered pages inside the master folder, expected " +
            JSON.stringify(expectedRawNames) + " got " + JSON.stringify(rawNames));
    }
    console.log("PASS phase 2: raw mode issued 3 per-page downloads to the runtime-configured image CDN (master-folder paths)");

    // ---- Phase 2b: PDF mode (one titled file per gallery) ------------------
    downloads.length = 0;
    syncSettings = { useZip: "pdf", maxConcurrentDownloads: "3" };
    fireDownload("Downloads/PdfTest", "PdfTest");
    await waitFor(() => downloads.length === 1, "PDF mode did not deliver a file");
    const pdfDownload = downloads[0];
    if (pdfDownload.filename !== "Downloads/PdfTest.pdf") {
        fail("PDF filename must be the gallery name, got " + pdfDownload.filename);
    }
    if (!/^data:application\/pdf;base64,/.test(pdfDownload.url)) {
        fail("PDF download URL must be an application/pdf data URL, got " + pdfDownload.url.slice(0, 50));
    }
    const pdfBytes = Buffer.from(pdfDownload.url.split(",")[1], "base64");
    const pdfText = pdfBytes.toString("latin1");
    if (!pdfText.startsWith("%PDF-1.4")) {
        fail("PDF header missing");
    }
    if (!pdfText.includes("/Count 3") || pdfText.split("/Filter /DCTDecode").length - 1 !== 3) {
        fail("PDF must embed one JPEG per page (3 pages)");
    }
    if (!pdfText.includes("/MediaBox [0 0 1280 1808]")) {
        fail("PDF page 1 must use the image dimensions");
    }
    if (!pdfText.endsWith("%%EOF\n")) {
        fail("PDF trailer missing");
    }
    console.log("PASS phase 2b: PDF mode delivered " + pdfBytes.length + " bytes as " + pdfDownload.filename);

    // ---- Phase 3: raw mode with failing downloads -------------------------
    sentMessages.length = 0;
    downloads.length = 0;
    downloadFails = true;
    expectedWorkerRejection = true; // startAsync() re-throws after errorCallback
    // Empty rawMasterFolder disables the master folder (pre-3.3.0 layout): the
    // retry/error path must behave identically with the master folder off.
    syncSettings = { useZip: "raw", maxConcurrentDownloads: "3", rawMasterFolder: "" };
    fireDownload("Downloads/FailTest", "FailTest");
    await waitFor(
        () => sentMessages.some((m) => m.action === "downloadError"),
        "no downloadError was sent to the popup"
    );
    const error = sentMessages.find((m) => m.action === "downloadError");
    if (!/Failed to download original image/.test(error.error)) {
        fail("downloadError has unexpected content: " + error.error);
    }
    // 3 pages x (1 initial attempt + 5 retries) each: the Promise-wrapped
    // callback must feed the retry loop instead of silently dropping errors.
    if (downloads.length !== 18) {
        fail("expected 18 raw download attempts (3 pages x (1 + 5 retries)), got " + downloads.length);
    }
    // Each retry must surface in the progress messages (retry "1/5" .. "5/5").
    const retryMsgs = sentMessages.filter((m) => m.action === "updateProgress" && m.retry);
    if (retryMsgs.length < 15) {
        fail("expected >=15 retry progress messages (3 pages x 5 retries), got " + retryMsgs.length);
    }
    if (!/retry 1\/5/.test(retryMsgs[0].retry)) {
        fail("first retry message should read 'retry 1/5', got " + retryMsgs[0].retry);
    }
    console.log("PASS phase 3: failing raw downloads were retried (" + downloads.length +
        " attempts), retries surfaced in progress (" + retryMsgs.length + " retry messages) and the error reached the popup: " + error.error);

    // ---- Phase 4: batch with a failing gallery reports exactly once -------
    // Regression guard: the Downloader surfaces a gallery failure through
    // errorCallback and then re-throws; the batch loop must swallow that
    // re-throw so the outer catch does not report the same failure twice.
    // A batchSummary must still be emitted with the failure counted.
    sentMessages.length = 0;
    downloads.length = 0;
    downloadFails = false;
    expectedWorkerRejection = false; // batch wrapper catches its own errors
    failImages = true;
    syncSettings = { useZip: "zip", maxConcurrentDownloads: "3" };
    onMessageHandler(
        { action: "downloadAllDoujinshis", allDoujinshis: { [GALLERY_ID]: "Test" }, finalName: "Downloads/Batch" },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.filter((m) => m.action === "downloadError").length >= 1,
        "no downloadError was sent for the failing batch gallery"
    );
    const batchErrors = sentMessages.filter((m) => m.action === "downloadError");
    if (batchErrors.length !== 1) {
        fail("batch gallery failure must be reported exactly once, got " + batchErrors.length +
            ": " + JSON.stringify(batchErrors));
    }
    if (downloads.length !== 0) {
        fail("no ZIP must be delivered when the batch gallery fails, got " + downloads.length);
    }
    const failSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!failSummary || failSummary.succeeded !== 0 || failSummary.failed !== 1 || failSummary.total !== 1) {
        fail("batchSummary must report 0/1/1 for a single failing gallery, got " + JSON.stringify(failSummary));
    }
    if (!failSummary.failedKinds || failSummary.failedKinds.image !== 1) {
        fail("the failing gallery is an image failure; failedKinds must be {image:1}, got " + JSON.stringify(failSummary.failedKinds));
    }
    console.log("PASS phase 4: batch gallery failure reported exactly once (no double report)");

    // ---- Phase 5: a failing gallery does not stop the batch ----------------
    // A metadata failure (404 for an unknown gallery) must be tallied and the
    // loop must continue to the next gallery, which succeeds and produces the
    // final ZIP. The batchSummary reports 1 success + 1 failure.
    // NOTE: JS orders integer-like object keys ascending, so the failing
    // gallery must have a smaller key than the successful one for the
    // successful gallery to be processed last (the ZIP is emitted on the
    // last gallery when downloadAtEnd is true).
    sentMessages.length = 0;
    downloads.length = 0;
    failImages = false;
    onMessageHandler(
        { action: "downloadAllDoujinshis", allDoujinshis: { "1": "Missing", [GALLERY_ID]: "Test" }, finalName: "Downloads/Mixed" },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the mixed batch"
    );
    const mixedErrors = sentMessages.filter((m) => m.action === "downloadError");
    if (mixedErrors.length !== 1) {
        fail("the missing gallery must produce exactly one downloadError, got " + mixedErrors.length);
    }
    const mixedSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!mixedSummary || mixedSummary.succeeded !== 1 || mixedSummary.failed !== 1 || mixedSummary.total !== 2) {
        fail("mixed batch summary must report 1/1/2, got " + JSON.stringify(mixedSummary));
    }
    if (!mixedSummary.failedKinds || mixedSummary.failedKinds.metadata !== 1) {
        fail("the missing gallery is a metadata failure; failedKinds must be {metadata:1}, got " + JSON.stringify(mixedSummary.failedKinds));
    }
    // The successful (last) gallery must still deliver its ZIP.
    if (downloads.length !== 1) {
        fail("the successful gallery in the mixed batch must deliver a ZIP, got " + downloads.length);
    }
    const progressMsgs = sentMessages.filter((m) => m.action === "batchProgress");
    if (progressMsgs.length < 2) {
        fail("batchProgress must be sent before each gallery, got " + progressMsgs.length);
    }
    console.log("PASS phase 5: batch continues after a gallery failure and reports 1/1/2");

    // ---- Phase 6: interrupted-job detection --------------------------------
    // A job marker without an active downloader means a previous download died
    // with the worker/document; isDownloadFinished must report interrupted so
    // the popup can tell the user (and let them dismiss the notice).
    sessionStore.downloadJob = { active: true, startedAt: Date.now() };
    let interruptedAnswer = null;
    onMessageHandler({ action: "isDownloadFinished" }, {}, (r) => { interruptedAnswer = r; });
    await waitFor(() => interruptedAnswer !== null, "isDownloadFinished did not answer with a stale marker");
    if (!interruptedAnswer.result || interruptedAnswer.interrupted !== true) {
        fail("isDownloadFinished must report interrupted=true with a stale marker, got " + JSON.stringify(interruptedAnswer));
    }

    // Dismissing clears the marker.
    let clearAnswer = null;
    onMessageHandler({ action: "clearJobMarker" }, {}, (r) => { clearAnswer = r; });
    if (!clearAnswer || clearAnswer.result !== "success") {
        fail("clearJobMarker did not answer success, got " + JSON.stringify(clearAnswer));
    }
    if (sessionStore.downloadJob !== undefined) {
        fail("clearJobMarker must remove the job marker, got " + JSON.stringify(sessionStore.downloadJob));
    }

    // After clearing, isDownloadFinished reports not-interrupted.
    let cleanAnswer = null;
    onMessageHandler({ action: "isDownloadFinished" }, {}, (r) => { cleanAnswer = r; });
    await waitFor(() => cleanAnswer !== null, "isDownloadFinished did not answer after clearing");
    if (!cleanAnswer.result || cleanAnswer.interrupted !== false) {
        fail("isDownloadFinished must report interrupted=false after clearing, got " + JSON.stringify(cleanAnswer));
    }
    console.log("PASS phase 6: interrupted-job marker is detected and dismissible");

    // ---- Phase 7: selected-gallery queue (mixed failures) ------------------
    // Proves the queue behavior end to end: per-gallery batchProgress, the loop
    // continues past BOTH a metadata failure and an image failure, the last
    // gallery still emits the single final ZIP, and the summary carries the
    // per-kind failure counts. Keys of the Record are unique by construction
    // (no duplicate queue entries possible).
    sentMessages.length = 0;
    downloads.length = 0;
    failImages = false;
    failMediaIds.clear();
    failMediaIds.add(String(MEDIA_ID));
    onMessageHandler(
        { action: "downloadAllDoujinshis",
          allDoujinshis: { "1": "Missing", [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
          finalName: "Downloads/Queue" },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
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
    if (downloads.length !== 1) {
        fail("exactly one ZIP must be delivered (from the last gallery), got " + downloads.length);
    }
    const queueErrors = sentMessages.filter((m) => m.action === "downloadError");
    if (queueErrors.length !== 2) {
        fail("both failing galleries must report exactly one error each, got " + queueErrors.length);
    }
    const queueProgress = sentMessages.filter((m) => m.action === "batchProgress");
    if (queueProgress.length !== 3) {
        fail("batchProgress must be sent for all 3 queued galleries, got " + queueProgress.length);
    }
    console.log("PASS phase 7: three-gallery queue continues past metadata+image failures and reports 1/2/3");

    // ---- Phase 8: CDN configuration hardening ------------------------------
    // Every job above resolved its image servers through the worker: the
    // /api/v2/cdn fixture was fetched exactly ONCE (session cache + in-memory
    // cache cover the rest), the cache was persisted to storage.session, and
    // getCdnStatus reports the merged list with no missing host grants.
    if (cdnConfigFetches !== 1) {
        fail("the CDN config must be fetched once and then cached, got " + cdnConfigFetches + " fetches");
    }
    if (!sessionStore.cdnConfig || !Array.isArray(sessionStore.cdnConfig.servers)
        || sessionStore.cdnConfig.servers[0] !== "https://i5.nhentai.net") {
        fail("the resolved CDN config must be cached in storage.session, got " + JSON.stringify(sessionStore.cdnConfig));
    }
    let cdnStatusAnswer = null;
    onMessageHandler({ action: "getCdnStatus" }, {}, (r) => { cdnStatusAnswer = r; });
    await waitFor(() => cdnStatusAnswer !== null, "getCdnStatus did not answer");
    if (!cdnStatusAnswer || cdnStatusAnswer.result !== "success"
        || !Array.isArray(cdnStatusAnswer.imageServers)
        || cdnStatusAnswer.imageServers[0] !== "https://i5.nhentai.net"
        || !cdnStatusAnswer.imageServers.includes("https://i.nhentai.net")) {
        fail("getCdnStatus must report the merged server list (runtime first, fallback after), got "
            + JSON.stringify(cdnStatusAnswer));
    }
    if (!Array.isArray(cdnStatusAnswer.missingOrigins) || cdnStatusAnswer.missingOrigins.length !== 0) {
        fail("getCdnStatus must report no missing grants when everything is permitted, got "
            + JSON.stringify(cdnStatusAnswer.missingOrigins));
    }
    console.log("PASS phase 8: CDN config fetched once, cached for the session, merged with fallback mirrors");

    // ---- Phase 9: API key mode resolves batch metadata via the keyed API ---
    // With a stored key (chrome.storage.local), the batch must hit the
    // official /api/v2/galleries/<id> endpoint carrying
    // `Authorization: Key <key>` — the API key mode boundary.
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    failImages = false;
    failMediaIds.clear();
    localSettings = { apiKey: "test-key-123" };
    onMessageHandler(
        { action: "downloadAllDoujinshis", allDoujinshis: { [GALLERY_ID2]: "Two" }, finalName: "Downloads/Keyed" },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the keyed batch"
    );
    const keyedSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!keyedSummary || keyedSummary.succeeded !== 1 || keyedSummary.failed !== 0 || keyedSummary.total !== 1) {
        fail("keyed batch summary must report 1/0/1, got " + JSON.stringify(keyedSummary));
    }
    const keyedApiCalls = apiRequestLog.filter((c) => c.url.indexOf("/api/v2/galleries/" + GALLERY_ID2) !== -1);
    if (keyedApiCalls.length === 0) {
        fail("keyed batch never called the official API for the gallery");
    }
    if (keyedApiCalls[0].auth !== "Key test-key-123") {
        fail("keyed metadata request must carry Authorization: Key <key>, got " + JSON.stringify(keyedApiCalls[0]));
    }
    if (downloads.length !== 1) {
        fail("keyed batch must deliver the ZIP, got " + downloads.length + " downloads");
    }
    console.log("PASS phase 9: API key mode resolves batch metadata via the keyed official API (" +
        keyedApiCalls[0].auth + ")");

    // ---- Phase 10: keyless mode never sends an Authorization header -------
    // Same batch without a stored key: metadata goes through the plain
    // extension-origin route and must not leak any Authorization header.
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    localSettings = {};
    onMessageHandler(
        { action: "downloadAllDoujinshis", allDoujinshis: { [GALLERY_ID]: "One" }, finalName: "Downloads/Keyless" },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the keyless batch"
    );
    const keylessSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!keylessSummary || keylessSummary.succeeded !== 1 || keylessSummary.failed !== 0 || keylessSummary.total !== 1) {
        fail("keyless batch summary must report 1/0/1, got " + JSON.stringify(keylessSummary));
    }
    const keylessApiCalls = apiRequestLog.filter((c) => c.url.indexOf("/api/v2/galleries/" + GALLERY_ID) !== -1);
    if (keylessApiCalls.length === 0) {
        fail("keyless batch never attempted the metadata API");
    }
    if (keylessApiCalls.some((c) => c.auth !== null)) {
        fail("keyless mode must never send an Authorization header, got " + JSON.stringify(keylessApiCalls));
    }
    console.log("PASS phase 10: keyless batch sends no Authorization header");

    console.log("PASS: full worker pipeline works in a window-less MV3 context.");
    process.exit(0);
})();
