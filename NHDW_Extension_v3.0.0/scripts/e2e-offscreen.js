// End-to-end offscreen document test: load the built js/offscreen.js in a
// window-less-but-DOM-stubbed VM context (like an offscreen document) and
// drive a downloadDoujinshi command through the full pipeline:
// metadata -> image fetch (mocked CDN) -> JSZip -> object URL -> downloads.
//
// This proves the large-gallery fix: the ZIP is delivered via a real object
// URL (URL.createObjectURL), never through the base64 data URL round-trip.
//
// Usage:  node scripts/e2e-offscreen.js [path/to/js/offscreen.js]
// Exit code 0 = object-URL pipeline works end to end.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const JSZip = require("jszip");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "offscreen.js");
const code = fs.readFileSync(bundlePath, "utf8");

// --- chrome stub ---------------------------------------------------------
let onMessageHandler = null;
const sentMessages = [];
const downloads = [];

const sessionStore = {};   // chrome.storage.session stub

const chromeStub = {
    tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} }, query() {} },
    action: { setIcon() {} },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults, { useZip: "zip", maxConcurrentDownloads: "3" })); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
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
            if (cb) cb(1); // success, downloadId = 1
        }
    }
};

// --- object URL stub (the reason the offscreen document exists) -----------
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

// --- fetch stub: nhentai API + image CDN ----------------------------------
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

const pageBytes = [
    (() => { const b = new Uint8Array(2000); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; })(),
    (() => { const b = new Uint8Array(2000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0a]); return b; })(),
    (() => { const b = new Uint8Array(2000); b.set([0xff, 0xd8, 0xff, 0xe1]); return b; })()
];

let failImages = false;
const failMediaIds = new Set();

function fetchStub(url) {
    const u = String(url);
    const apiMatch = /\/api\/gallery\/([0-9]+)/.exec(u);
    if (apiMatch) {
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

// --- sandbox (single VM realm; document defined like an offscreen page) ---
const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchStub,
    Response,
    Blob,   // jszip needs a Blob constructor for generateAsync({type:"blob"})
    URL: URLStub,
    AbortController,
    document: {} // offscreen documents have a DOM; Downloader then zips without web workers
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
        fail("bundle threw while loading: " + err.name + ": " + err.message);
    }
    if (!onMessageHandler) fail("onMessage listener was never registered");

    // Idle state before any work.
    const idleAnswer = await askOffscreen({ action: "isDownloadFinished" });
    if (!idleAnswer || idleAnswer.result !== true) {
        fail("isDownloadFinished should be true while idle, got " + JSON.stringify(idleAnswer));
    }

    // Start a download the way the service worker would relay it.
    const startAnswer = await askOffscreen({
        action: "downloadDoujinshi",
        json: galleryJson,
        path: "Downloads/Test",
        name: "Test"
    });
    if (!startAnswer || startAnswer.result !== "started") {
        fail("downloadDoujinshi did not answer {result:'started'}, got " + JSON.stringify(startAnswer));
    }
    if (!sessionStore.downloadJob || sessionStore.downloadJob.active !== true) {
        fail("job marker must be active while the offscreen job runs, got " + JSON.stringify(sessionStore.downloadJob));
    }

    // During the download, isDownloadFinished must be false and progress must flow.
    const busyAnswer = await askOffscreen({ action: "isDownloadFinished" });
    if (busyAnswer && busyAnswer.result === true) {
        // The 3-page download is so fast it may already be done; that is
        // acceptable, but then we at least expect a completed progress event.
    }
    const progressAnswer = await askOffscreen({ action: "getProgress" });
    if (!progressAnswer || progressAnswer.result !== "success") {
        fail("getProgress did not answer success, got " + JSON.stringify(progressAnswer));
    }

    // Wait for the ZIP to reach chrome.downloads.
    await waitFor(() => downloads.length === 1, "no download reached chrome.downloads");
    const download = downloads[0];

    if (!/^blob:/.test(download.url)) {
        fail("download URL is not an object URL: " + String(download.url).slice(0, 60) +
            " (the base64 data-URL round-trip must not be used in the offscreen document)");
    }
    if (download.filename !== "Downloads/Test.zip") {
        fail("unexpected download filename: " + download.filename);
    }

    const blob = objectBlobs[download.url];
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
    const expected = ["Downloads/Test/001.jpg", "Downloads/Test/002.png", "Downloads/Test/003.jpg"];
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

    // The download is done: the job marker must be cleared.
    await waitFor(() => sessionStore.downloadJob === undefined,
        "job marker must be cleared after the offscreen job completes");

    // goBack must succeed and the finished flag must be true.
    const goBackAnswer = await askOffscreen({ action: "goBack" });
    if (!goBackAnswer || goBackAnswer.result !== "success") {
        fail("goBack did not answer success, got " + JSON.stringify(goBackAnswer));
    }
    const doneAnswer = await askOffscreen({ action: "isDownloadFinished" });
    if (!doneAnswer || doneAnswer.result !== true) {
        fail("isDownloadFinished should be true after completion, got " + JSON.stringify(doneAnswer));
    }

    console.log("PASS: ZIP (" + buf.length + " bytes) delivered via object URL " + download.url);
    console.log("PASS: entries: " + names.join(", ") + "; " + progressMessages.length + " progress broadcasts");

    // ---- Batch download with a failing gallery must report exactly once ----
    // Regression guard: the Downloader surfaces a gallery failure through
    // errorCallback and then re-throws; the batch loop must swallow that
    // re-throw so the outer catch does not report the same failure twice.
    // A batchSummary must still be emitted with the failure counted.
    sentMessages.length = 0;
    downloads.length = 0;
    failImages = true;
    const batchStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { [GALLERY_ID]: "Test" },
        finalName: "Downloads/Batch"
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
    failImages = false;
    const mixedStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { "1": "Missing", [GALLERY_ID]: "Test" },
        finalName: "Downloads/Mixed"
    });
    if (!mixedStart || mixedStart.result !== "started") {
        fail("downloadAllDoujinshis did not answer {result:'started'}, got " + JSON.stringify(mixedStart));
    }
    await waitFor(
        () => sentMessages.some((m) => m.action === "batchSummary"),
        "no batchSummary was sent for the mixed batch"
    );
    const mixedSummary = sentMessages.find((m) => m.action === "batchSummary");
    if (!mixedSummary || mixedSummary.succeeded !== 1 || mixedSummary.failed !== 1 || mixedSummary.total !== 2) {
        fail("mixed batch summary must report 1/1/2, got " + JSON.stringify(mixedSummary));
    }
    if (!mixedSummary.failedKinds || mixedSummary.failedKinds.metadata !== 1) {
        fail("the missing gallery is a metadata failure; failedKinds must be {metadata:1}, got " + JSON.stringify(mixedSummary.failedKinds));
    }
    if (downloads.length !== 1) {
        fail("the successful gallery in the mixed batch must deliver a ZIP, got " + downloads.length);
    }
    if (sentMessages.filter((m) => m.action === "batchProgress").length < 2) {
        fail("batchProgress must be sent before each gallery");
    }
    console.log("PASS: batch continues after a gallery failure and reports 1/1/2");

    // ---- Three-gallery queue with mixed failures ----------------------------
    // Same queue guarantees as the worker suite: per-gallery progress, the loop
    // continues past a metadata failure AND an image failure, the last gallery
    // still emits the single final ZIP, and the summary carries per-kind counts.
    sentMessages.length = 0;
    downloads.length = 0;
    failImages = false;
    failMediaIds.clear();
    failMediaIds.add(String(MEDIA_ID));
    const queueStart = await askOffscreen({
        action: "downloadAllDoujinshis",
        allDoujinshis: { "1": "Missing", [GALLERY_ID]: "One", [GALLERY_ID2]: "Two" },
        finalName: "Downloads/Queue"
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
    if (downloads.length !== 1) {
        fail("exactly one ZIP must be delivered (from the last gallery), got " + downloads.length);
    }
    if (sentMessages.filter((m) => m.action === "downloadError").length !== 2) {
        fail("both failing galleries must report exactly one error each");
    }
    if (sentMessages.filter((m) => m.action === "batchProgress").length !== 3) {
        fail("batchProgress must be sent for all 3 queued galleries");
    }
    console.log("PASS: three-gallery queue continues past metadata+image failures and reports 1/2/3");

    console.log("PASS: offscreen document pipeline works with no base64 round-trip.");
    process.exit(0);
})();
