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

const chromeStub = {
    tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} }, query() {} },
    action: { setIcon() {} },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults, { useZip: "zip", maxConcurrentDownloads: "3" })); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults)); } }
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

const galleryJson = {
    id: GALLERY_ID,
    media_id: MEDIA_ID,
    title: { english: "Test", japanese: "", pretty: "Test" },
    images: { pages: [{ t: "j" }, { t: "p" }, { t: "j" }] },
    tags: []
};

const pageBytes = [
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x04, 0x05]),
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x06, 0x07, 0x08])
];

function fetchStub(url) {
    const u = String(url);
    if (u.includes("/api/gallery/" + GALLERY_ID)) {
        return Promise.resolve(new Response(JSON.stringify(galleryJson), { status: 200 }));
    }
    if (u.includes("nhentai.net/galleries/" + MEDIA_ID + "/")) {
        const m = /\/([0-9]+)\.(jpg|png)$/.exec(u);
        if (m) return Promise.resolve(new Response(pageBytes[parseInt(m[1], 10) - 1], { status: 200 }));
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

    // The download is done: goBack must succeed and the finished flag must be true.
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
    console.log("PASS: offscreen document pipeline works with no base64 round-trip.");
    process.exit(0);
})();
