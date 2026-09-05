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
// Files chrome.downloads.search sees on the fake disk: saved filename -> exists.
const diskFiles = new Map();

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
        local: {
            get(defaults, cb) { cb(Object.assign({}, defaults, localSettings)); },
            set(items, cb) { Object.assign(localSettings, items); if (cb) cb(); },
            remove(key, cb) { delete localSettings[key]; if (cb) cb(); }
        },
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
            } else {
                diskFiles.set(String(opts.filename), true);
                if (cb) cb(1); // success, downloadId = 1
            }
        },
        // Verify-before-skip + merged part-numbering ask chrome.downloads
        // whether a recorded artifact still exists.
        search(query, cb) {
            const queries = Array.isArray(query) ? query : [query || {}];
            const items = [];
            for (const filename of diskFiles.keys()) {
                for (const q of queries) {
                    if (q && q.filenameRegex && new RegExp(String(q.filenameRegex)).test(filename)) {
                        items.push({ filename: filename, exists: diskFiles.get(filename) === true });
                        break;
                    }
                }
            }
            if (cb) cb(items);
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
    // Listing-page HTML for the multi-page merged-naming phase: page 1 shows
    // gallery 123456, page 2 shows 654321, in nhentai's card markup.
    const pageMatch = /[?&]page=([0-9]+)/.exec(u);
    if (pageMatch && u.includes("nhentai.net/search/")) {
        const pageNo = parseInt(pageMatch[1], 10);
        const id = pageNo === 1 ? GALLERY_ID : pageNo === 2 ? GALLERY_ID2 : 0;
        const title = pageNo === 1 ? "One" : pageNo === 2 ? "Two" : "Unknown";
        if (id !== 0) {
            return Promise.resolve(new Response(
                '<a href="/g/' + id + '/1/"><div class="caption">' + title + '<br>language 1</div></a>',
                { status: 200 }
            ));
        }
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

    // ---- Phase 1b: successful download is recorded into the persistent history
    await waitFor(
        () => localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)],
        "a successful download must be recorded in the downloaded-history list"
    );
    const historyRecord = localSettings.downloadHistory[String(GALLERY_ID)];
    if (historyRecord.filename !== "Downloads/Test.zip") {
        fail("history record filename must be the artifact name, got " + JSON.stringify(historyRecord));
    }
    if (typeof historyRecord.when !== "number" || historyRecord.when > Date.now()) {
        fail("history record must carry a sane timestamp, got " + JSON.stringify(historyRecord));
    }
    console.log("PASS phase 1b: successful ZIP recorded as " + historyRecord.filename +
        " in chrome.storage.local");

    // ---- Phase 1c: a gallery that fails to download is NEVER recorded -------
    // (a partial download cannot be proven byte-identical, so re-runs re-fetch it)
    downloadFails = true;
    expectedWorkerRejection = true;
    const historyBefore = Object.keys(localSettings.downloadHistory || {}).length;
    fireDownload("Downloads/FailRecord", "FailRecord");
    await waitFor(
        () => sentMessages.some((m) => m.action === "downloadError"),
        "the failing gallery must send a downloadError"
    );
    await new Promise((r) => setTimeout(r, 150));
    if (localSettings.downloadHistory && Object.keys(localSettings.downloadHistory).length !== historyBefore) {
        fail("a failed download must never be recorded in the history");
    }
    downloadFails = false;
    expectedWorkerRejection = false;
    console.log("PASS phase 1c: failed download adds nothing to the history");

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
    // The failure must NAME the gallery and carry the settings a retry needs
    // (the user saw "2 galleries failed" with no names and no retry button).
    if (String(error.galleryId) !== String(GALLERY_ID) || error.galleryName !== "FailTest") {
        fail("downloadError must name the failed gallery (id + name), got " + JSON.stringify(error));
    }
    if (!error.retryJob || error.retryJob.formatOverride !== "raw") {
        fail("downloadError must carry the retry settings, got " + JSON.stringify(error.retryJob));
    }
    await waitFor(
        () => Array.isArray(sessionStore.nhdwFailedGalleries) && sessionStore.nhdwFailedGalleries.some((f) => String(f.id) === String(GALLERY_ID)),
        "the failed gallery must be remembered in chrome.storage.session"
    );
    if (localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)] &&
        /FailTest/.test(localSettings.downloadHistory[String(GALLERY_ID)].filename)) {
        fail("a raw gallery whose pages failed must never be recorded as downloaded");
    }
    console.log("PASS phase 3: failing raw downloads were retried (" + downloads.length +
        " attempts), retries surfaced in progress (" + retryMsgs.length + " retry messages) and the error reached the popup by name: " + error.error);

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
    if (!Array.isArray(mixedSummary.failedGalleries) || mixedSummary.failedGalleries.length !== 1 ||
        mixedSummary.failedGalleries[0].id !== "1" || mixedSummary.failedGalleries[0].name !== "Missing" ||
        !/404/.test(mixedSummary.failedGalleries[0].error)) {
        fail("batchSummary must list the failed gallery by id, name and reason, got " + JSON.stringify(mixedSummary.failedGalleries));
    }
    if (!mixedSummary.retryJob || typeof mixedSummary.retryJob !== "object") {
        fail("batchSummary must carry the retry settings, got " + JSON.stringify(mixedSummary.retryJob));
    }
    await waitFor(
        () => Array.isArray(sessionStore.nhdwFailedGalleries) && sessionStore.nhdwFailedGalleries.some((f) => f.id === "1" && f.name === "Missing"),
        "the failed batch gallery must be remembered for the session"
    );
    // The popup can list and retry them later.
    const failedList = await new Promise((resolve) => onMessageHandler({ action: "getFailedGalleries" }, {}, resolve));
    if (!failedList || failedList.result !== "success" || !failedList.failed.some((f) => f.id === "1" && f.name === "Missing")) {
        fail("getFailedGalleries must list the remembered failure, got " + JSON.stringify(failedList));
    }
    console.log("PASS phase 5: batch continues after a gallery failure, reports 1/1/2 and names the failed title");

    // ---- Phase 5a: retrying the failed title re-downloads it and clears it --
    // The popup's "Retry failed" re-sends downloadAllDoujinshis with the
    // remembered ids (separate files, redownload override). The metadata
    // 404 was permanent for id 1, so here the retry targets a title that
    // failed for a transient reason: seed it as failed, retry, expect it to
    // succeed, be recorded and leave the failed list.
    sentMessages.length = 0;
    downloads.length = 0;
    sessionStore.nhdwFailedGalleries = [{ id: String(GALLERY_ID), name: "Test", error: "transient", retryJob: { formatOverride: "zip" }, at: Date.now() }];
    onMessageHandler(
        {
            action: "downloadAllDoujinshis", allDoujinshis: { [GALLERY_ID]: "Test" }, galleryMetadata: {},
            finalName: "Retry", separate: true, redownloadIds: [String(GALLERY_ID)], formatOverride: "zip"
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("retry batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(() => sentMessages.some((m) => m.action === "batchSummary"), "no batchSummary for the retry batch");
    const retrySummary = sentMessages.find((m) => m.action === "batchSummary");
    if (retrySummary.succeeded !== 1 || retrySummary.failed !== 0) {
        fail("retry batch must succeed 1/0/1, got " + JSON.stringify(retrySummary));
    }
    if (downloads.length !== 1 || !/\.zip$/.test(String(downloads[0].filename))) {
        fail("the retried title must be delivered again, got " + JSON.stringify(downloads));
    }
    await waitFor(
        () => !(sessionStore.nhdwFailedGalleries || []).some((f) => String(f.id) === String(GALLERY_ID)),
        "a retried gallery that succeeded must leave the failed list"
    );
    console.log("PASS phase 5a: retrying a remembered failure re-downloads it and clears it from the failed list");

    // ---- Phase 5b: a failed MERGED batch records nothing (all-or-nothing) --
    // Settled decision: a merged archive records ALL of its gallery ids
    // together ONLY if the whole job succeeded. Phase 5 ended 1/1, so even
    // though gallery 123456's page data was fetched inside the shared
    // archive, it must NOT be recorded as done.
    await waitFor(() => sessionStore.downloadJob === undefined,
        "worker marker must clear after the mixed batch");
    await new Promise((r) => setTimeout(r, 150));
    if (!localSettings.downloadHistory || localSettings.downloadHistory["1"] !== undefined) {
        fail("the failed merged batch must not record the missing gallery (id '1')");
    }
    if (localSettings.downloadHistory[String(GALLERY_ID)] === undefined) {
        fail("gallery 123456 must still carry its phase-1 record");
    }
    console.log("PASS phase 5b: an unclean merged batch records NO ids (the merge can be re-run)");

    // ---- Phase 5c: a fully clean merged batch records every id ONCE --------
    // Date stamp and disk verification are exercised in phases 5f/5g; keep this
    // phase deterministic on the plain name.
    syncSettings.verifyDownloadedFiles = false;
    syncSettings.batchNameDate = false;
    localSettings.downloadHistory = {};
    sentMessages.length = 0;
    downloads.length = 0;
    failImages = false;
    onMessageHandler(
        { action: "downloadAllDoujinshis", allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" }, finalName: "Downloads/MergedClean" },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("clean merged batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary" && m.failed === 0),
        "no clean batchSummary was sent"
    );
    await waitFor(() => sessionStore.downloadJob === undefined,
        "worker marker must clear after the clean merged batch");
    await waitFor(
        () => localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)] && localSettings.downloadHistory[String(GALLERY_ID2)],
        "a clean merged batch must record BOTH galleries"
    );
    const mergedRecord = localSettings.downloadHistory[String(GALLERY_ID)];
    if (mergedRecord.filename !== "Downloads/MergedClean.zip") {
        fail("merged records must carry the merged artifact name, got " + JSON.stringify(mergedRecord));
    }
    if (localSettings.downloadHistory[String(GALLERY_ID2)].filename !== "Downloads/MergedClean.zip") {
        fail("both merged ids must point at the same artifact, got " + JSON.stringify(localSettings.downloadHistory));
    }
    console.log("PASS phase 5c: clean merged batch recorded both ids under " + mergedRecord.filename);

    // ---- Phase 5d: recorded galleries are skipped unless re-downloaded -----
    localSettings.downloadHistory = { [String(GALLERY_ID)]: { filename: "One.zip", when: 1 } };
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    onMessageHandler(
        {
            action: "downloadAllDoujinshis",
            allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
            finalName: "Downloads/Skip",
            separate: true
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("skip batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary" && m.skipped === 1),
        "the skip batch must report skipped:1"
    );
    await waitFor(() => sessionStore.downloadJob === undefined, "skip batch marker must clear");
    if (downloads.length !== 1 || !/Two\.zip/.test(downloads[0].filename)) {
        fail("only the un-recorded gallery must download, got " + JSON.stringify(downloads.map((d) => d.filename)));
    }
    if (apiRequestLog.some((r) => r.url.includes("/galleries/" + GALLERY_ID + "/"))) {
        fail("a recorded gallery must not hit the API: " + JSON.stringify(apiRequestLog));
    }
    console.log("PASS phase 5d: recorded gallery skipped with zero API calls (separate mode)");

    // ---- Phase 5e: redownloadIds re-fetch a recorded gallery ----------------
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    onMessageHandler(
        {
            action: "downloadAllDoujinshis",
            allDoujinshis: { [GALLERY_ID]: "One" },
            finalName: "Downloads/Override",
            separate: true,
            redownloadIds: [String(GALLERY_ID)]
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("override batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(() => downloads.length === 1, "redownloadIds must deliver the gallery again");
    await waitFor(
        () => sessionStore.downloadJob === undefined && localSettings.downloadHistory[String(GALLERY_ID)] &&
            // The gallery fixture's title is "Test", so the new artifact is Test.zip.
            localSettings.downloadHistory[String(GALLERY_ID)].filename === "Test.zip",
        "the re-downloaded gallery must be recorded again"
    );
    console.log("PASS phase 5e: redownloadIds overrides the history guard and re-records");

    // ---- Phase 5f: verify-before-skip re-downloads a DELETED file ----------
    // The history record is not proof the file survived: with the verify
    // setting on, the worker checks chrome.downloads.search and only skips
    // records whose artifact is still on disk. 123456 (Test.zip) is still
    // there from phase 1; 654321 points at NHDW/Gone.zip which is not.
    syncSettings.verifyDownloadedFiles = true;
    syncSettings.batchNameDate = false;
    localSettings.downloadHistory = {
        [String(GALLERY_ID)]: { filename: "Downloads/Test.zip", when: 1 },
        [String(GALLERY_ID2)]: { filename: "NHDW/Gone.zip", when: 1 }
    };
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    onMessageHandler(
        {
            action: "downloadAllDoujinshis",
            allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
            finalName: "Downloads/Verify",
            separate: true
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("verify batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary" && m.skipped === 1),
        "verify batch must report skipped:1 (the present file), not 2"
    );
    await waitFor(() => sessionStore.downloadJob === undefined, "verify batch marker must clear");
    if (downloads.length !== 1 || downloads[0].filename !== "Test_Two.zip") {
        fail("only the deleted gallery must be re-downloaded, got " + JSON.stringify(downloads.map((d) => d.filename)));
    }
    if (apiRequestLog.some((r) => r.url.includes("/galleries/" + GALLERY_ID))) {
        fail("a file still on disk must not be re-fetched: " + JSON.stringify(apiRequestLog));
    }
    if (!apiRequestLog.some((r) => r.url.includes("/galleries/" + GALLERY_ID2))) {
        fail("a deleted file must be fetched again: " + JSON.stringify(apiRequestLog));
    }
    console.log("PASS phase 5f: verify-before-skip keeps the file that exists and re-downloads the deleted one");

    // ---- Phase 5g: merged date stamp + part numbering + warn-first ---------
    // Listing re-runs get search_31082026.zip; the same title+date again warns
    // ("existing") and, once confirmed, saves search_31082026_part2.zip. Both
    // ids are recorded under the EXACT dated artifact name.
    syncSettings.batchNameDate = true;
    syncSettings.verifyDownloadedFiles = true;
    const now = new Date();
    const today = String(now.getDate()).padStart(2, "0")
        + String(now.getMonth() + 1).padStart(2, "0")
        + String(now.getFullYear());
    const datedName = "Downloads/DateRun_" + today + ".zip";
    const part2Name = "Downloads/DateRun_" + today + "_part2.zip";
    localSettings.downloadHistory = {};
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    const dateRun = {
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
        finalName: "Downloads/DateRun"
    };
    onMessageHandler(dateRun, {}, (result) => {
        if (!result || result.result !== "started") {
            fail("dated merge did not answer {result:'started'}, got " + JSON.stringify(result));
        }
    });
    await waitFor(() => downloads.length === 1, "dated merge must deliver one archive");
    if (downloads[0].filename !== datedName) {
        fail("merged name must carry the date stamp, got " + downloads[0].filename + " (expected " + datedName + ")");
    }
    await waitFor(() => sessionStore.downloadJob === undefined, "dated merge marker must clear");
    await waitFor(
        () => localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)] &&
            localSettings.downloadHistory[String(GALLERY_ID)].filename === datedName,
        "the dated merge must record both ids under the dated name"
    );
    // Same batch again WITHOUT confirmation: warn-only answer, no job started.
    const existingAnswer = await new Promise((resolve) => {
        onMessageHandler(dateRun, {}, resolve);
    });
    if (!existingAnswer || existingAnswer.result !== "existing" || existingAnswer.filename !== datedName) {
        fail("a re-run of the same merged name must answer existing, got " + JSON.stringify(existingAnswer));
    }
    if (sessionStore.downloadJob && sessionStore.downloadJob.active) {
        fail("the existing answer must NOT start a job");
    }
    // Confirmed -> part 2, recorded under part 2.
    downloads.length = 0;
    const confirmedAnswer = await new Promise((resolve) => {
        onMessageHandler(Object.assign({}, dateRun, { existingConfirmed: true }), {}, resolve);
    });
    if (!confirmedAnswer || confirmedAnswer.result !== "started") {
        fail("confirmed re-run must start, got " + JSON.stringify(confirmedAnswer));
    }
    await waitFor(() => downloads.length === 1 && downloads[0].filename === part2Name,
        "confirmed re-run must save the part-2 name, got " + JSON.stringify(downloads.map((d) => d.filename)));
    await waitFor(() => sessionStore.downloadJob === undefined, "part-2 merge marker must clear");
    await waitFor(
        () => localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)] &&
            localSettings.downloadHistory[String(GALLERY_ID)].filename === part2Name,
        "confirmed re-run must re-record both ids under the part-2 name"
    );
    console.log("PASS phase 5g: merged date stamp + part-2 numbering + warn-first, recorded under the exact name");

    // ---- Phase 5h: multi-page merged naming keeps part numbers on the base --
    // downloadAllPages appends " (lastPage)" itself, so the resolved base must
    // be "<name>_DDMMYYYY[_partN]" and the artifact lands as
    // "<base> (2).zip"; the disk candidates and history records must use THAT
    // exact spelling, or a re-run would never detect the existing file.
    syncSettings.verifyDownloadedFiles = true;
    syncSettings.batchNameDate = true;
    const pageRunName = "Downloads/PageRun_" + today + " (2).zip";
    const pageRunPart2 = "Downloads/PageRun_" + today + "_part2 (2).zip";
    localSettings.downloadHistory = {};
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    const pageRun = {
        action: "downloadAllPages",
        allDoujinshis: {},
        pages: [1, 2],
        finalName: "Downloads/PageRun",
        url: "https://nhentai.net/search/?q=test"
    };
    onMessageHandler(pageRun, {}, (result) => {
        if (!result || result.result !== "started") {
            fail("multi-page merged run did not answer {result:'started'}, got " + JSON.stringify(result));
        }
    });
    await waitFor(() => downloads.length === 1 && downloads[0].filename === pageRunName,
        "multi-page merge must save the dated name with the page marker, got " +
        JSON.stringify(downloads.map((d) => d.filename)));
    await waitFor(() => sessionStore.downloadJob === undefined, "multi-page merge marker must clear");
    await waitFor(
        () => localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)] &&
            localSettings.downloadHistory[String(GALLERY_ID)].filename === pageRunName,
        "the multi-page merge must record both ids under the dated artifact name"
    );
    const pageExistingAnswer = await new Promise((resolve) => {
        onMessageHandler(pageRun, {}, resolve);
    });
    if (!pageExistingAnswer || pageExistingAnswer.result !== "existing" || pageExistingAnswer.filename !== pageRunName) {
        fail("a re-run of the same multi-page merge must answer existing, got " + JSON.stringify(pageExistingAnswer));
    }
    downloads.length = 0;
    const pageConfirmedAnswer = await new Promise((resolve) => {
        onMessageHandler(Object.assign({}, pageRun, { existingConfirmed: true }), {}, resolve);
    });
    if (!pageConfirmedAnswer || pageConfirmedAnswer.result !== "started") {
        fail("confirmed multi-page re-run must start, got " + JSON.stringify(pageConfirmedAnswer));
    }
    await waitFor(() => downloads.length === 1 && downloads[0].filename === pageRunPart2,
        "confirmed multi-page re-run must keep _part2 on the base, got " +
        JSON.stringify(downloads.map((d) => d.filename)));
    await waitFor(() => sessionStore.downloadJob === undefined, "multi-page part-2 marker must clear");
    await waitFor(
        () => localSettings.downloadHistory && localSettings.downloadHistory[String(GALLERY_ID)] &&
            localSettings.downloadHistory[String(GALLERY_ID)].filename === pageRunPart2,
        "the multi-page part-2 merge must re-record both ids under the part-2 artifact name"
    );
    console.log("PASS phase 5h: multi-page merged naming keeps _part2 on the base (artifact + record + warn)");
    // Keep the remaining phases deterministic.
    syncSettings.verifyDownloadedFiles = false;
    syncSettings.batchNameDate = false;

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

    // ---- Phase 11: non-gallery JSON fails ONE gallery, not the whole batch --
    // A metadata route that returns 200 with `{}` used to throw at
    // json.title.pretty outside the per-gallery try, rejecting the entire
    // downloadAllDoujinshisAsync: remaining titles skipped, no batchSummary,
    // failures never remembered (item 28).
    sentMessages.length = 0;
    downloads.length = 0;
    apiRequestLog.length = 0;
    failImages = false;
    failMediaIds.clear();
    localSettings = {};
    syncSettings = { useZip: "zip", maxConcurrentDownloads: "3", duplicateBehaviour: "rename", verifyDownloadedFiles: false, batchNameDate: false };
    onMessageHandler(
        {
            action: "downloadAllDoujinshis",
            allDoujinshis: { "9": "EmptyJson", [GALLERY_ID]: "Test" },
            galleryMetadata: { "9": {} },
            finalName: "Downloads/EmptyJsonBatch"
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("empty-json batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "non-gallery JSON must not kill the batch: no batchSummary was sent"
    );
    const emptyJsonSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!emptyJsonSummary || emptyJsonSummary.succeeded !== 1 || emptyJsonSummary.failed !== 1 || emptyJsonSummary.total !== 2) {
        fail("empty-json batch must report 1/1/2, got " + JSON.stringify(emptyJsonSummary));
    }
    if (!emptyJsonSummary.failedKinds || emptyJsonSummary.failedKinds.metadata !== 1) {
        fail("non-gallery JSON is a metadata failure, got " + JSON.stringify(emptyJsonSummary.failedKinds));
    }
    if (!Array.isArray(emptyJsonSummary.failedGalleries) || emptyJsonSummary.failedGalleries.length !== 1
        || emptyJsonSummary.failedGalleries[0].id !== "9" || emptyJsonSummary.failedGalleries[0].name !== "EmptyJson"
        || !/not gallery metadata/.test(emptyJsonSummary.failedGalleries[0].error)) {
        fail("empty-json batch must name the failed gallery, got " + JSON.stringify(emptyJsonSummary.failedGalleries));
    }
    if (downloads.length !== 1) {
        fail("the remaining gallery must still deliver a ZIP, got " + downloads.length);
    }
    await waitFor(() => sessionStore.downloadJob === undefined, "empty-json batch marker must clear");
    if (localSettings.downloadHistory && localSettings.downloadHistory["9"]) {
        fail("the non-gallery title must not be recorded");
    }
    console.log("PASS phase 11: non-gallery JSON fails one gallery by name; the batch continues and records nothing for it");

    // ---- Phase 12: merged "ignore" must not silently drop a duplicate title --
    // Two different galleries sharing pretty title "Test", duplicateBehaviour
    // ignore: merged mode used to `continue` uncounted and could record the
    // archive as clean while missing a gallery (item 31). Now the second is
    // id-suffixed and both land in the ZIP. Separate mode counts the skip.
    const savedTitle2 = galleryJson2.title;
    galleryJson2.title = { english: "Test", japanese: "", pretty: "Test" };
    sentMessages.length = 0;
    downloads.length = 0;
    localSettings = {};
    syncSettings.duplicateBehaviour = "ignore";
    onMessageHandler(
        {
            action: "downloadAllDoujinshis",
            allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
            finalName: "Downloads/DupIgnore"
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("merged ignore-dup batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(() => sentMessages.some((m) => m.action === "batchSummary"), "merged ignore-dup batch must finish");
    const dupMergedSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!dupMergedSummary || dupMergedSummary.succeeded !== 2 || dupMergedSummary.failed !== 0 || dupMergedSummary.skipped !== 0) {
        fail("merged ignore-dup must keep both galleries (id-suffix the second), got " + JSON.stringify(dupMergedSummary));
    }
    if (downloads.length !== 1) {
        fail("merged ignore-dup must deliver one archive, got " + downloads.length);
    }
    const dupZip = await JSZip.loadAsync(Buffer.from(downloads[0].url.split(",")[1], "base64"));
    const dupEntries = Object.keys(dupZip.files).filter((n) => !dupZip.files[n].dir).sort();
    const hasFirst = dupEntries.some((n) => n.indexOf("Test/") === 0);
    const hasSecond = dupEntries.some((n) => n.indexOf("Test_(" + GALLERY_ID2 + ")") === 0);
    if (!hasFirst || !hasSecond) {
        fail("merged ignore-dup ZIP must contain both galleries (original + id-suffixed), got " + JSON.stringify(dupEntries));
    }
    console.log("PASS phase 12a: merged ignore-dup id-suffixes the second title instead of dropping it");

    sentMessages.length = 0;
    downloads.length = 0;
    localSettings = {};
    onMessageHandler(
        {
            action: "downloadAllDoujinshis",
            allDoujinshis: { [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
            finalName: "Downloads/DupIgnoreSep",
            separate: true
        },
        {},
        (result) => {
            if (!result || result.result !== "started") {
                fail("separate ignore-dup batch did not answer {result:'started'}, got " + JSON.stringify(result));
            }
        }
    );
    await waitFor(() => sentMessages.some((m) => m.action === "batchSummary"), "separate ignore-dup batch must finish");
    const dupSepSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!dupSepSummary || dupSepSummary.succeeded !== 1 || dupSepSummary.failed !== 0 || dupSepSummary.skipped !== 1 || dupSepSummary.total !== 2) {
        fail("separate ignore-dup must count the drop as skipped:1, got " + JSON.stringify(dupSepSummary));
    }
    if (downloads.length !== 1) {
        fail("separate ignore-dup must deliver one archive (the first title), got " + downloads.length);
    }
    galleryJson2.title = savedTitle2;
    syncSettings.duplicateBehaviour = "rename";
    console.log("PASS phase 12b: separate ignore-dup counts the dropped title in skipped");

    console.log("PASS: full worker pipeline works in a window-less MV3 context.");
    process.exit(0);
})();
