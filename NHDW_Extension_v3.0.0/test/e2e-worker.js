// End-to-end worker test: load the built background.js in a window-less
// context and drive real downloadDoujinshi messages through the entire
// pipeline: metadata -> image fetch (mocked CDN) -> JSZip -> chrome.downloads.
//
// Phases:
//   1. ZIP mode: a valid ZIP with the expected entries reaches chrome.downloads.
//   2. Raw mode: each page is handed to chrome.downloads as a plain image URL.
//   3. Raw mode with failing downloads: the error is reported to the popup
//      (Promise-wrapped callback), not silently dropped.
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
let downloadFails = false;
let expectedWorkerRejection = false;

const chromeStub = {
    tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query(_query, cb) { cb([{ url: "https://nhentai.net/g/123456/" }]); }
    },
    action: { setIcon() {} },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults, syncSettings)); } },
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

// Distinct fake "image" bytes so we can confirm the ZIP has 3 different files.
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

// --- sandbox (single VM realm, like a real service worker) ---------------
const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchStub,
    Response,
    Blob, // jszip needs a Blob constructor for generateAsync({type:"blob"})
    btoa
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
    await waitFor(() => downloads.length === 1, "no ZIP download reached chrome.downloads");

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
    const zipProgress = sentMessages.filter((m) => m.action === "updateProgress").length;
    console.log("PASS phase 1: ZIP (" + buf.length + " bytes) delivered as " + download.filename +
        " with entries " + names.join(", ") + " (" + zipProgress + " progress messages)");

    // ---- Phase 2: raw mode (per-page downloads) ---------------------------
    downloads.length = 0;
    syncSettings = { useZip: "raw", maxConcurrentDownloads: "3" };
    fireDownload("Downloads/RawTest", "RawTest");
    await waitFor(() => downloads.length === 3, "raw mode did not issue 3 per-page downloads");

    const rawUrls = downloads.map((d) => d.url).sort();
    const expectedRaw = [
        "https://i.nhentai.net/galleries/987654/1.jpg",
        "https://i.nhentai.net/galleries/987654/2.png",
        "https://i.nhentai.net/galleries/987654/3.jpg"
    ];
    if (JSON.stringify(rawUrls) !== JSON.stringify(expectedRaw)) {
        fail("raw mode URLs mismatch. Expected " + JSON.stringify(expectedRaw) + " got " + JSON.stringify(rawUrls));
    }
    if (downloads.some((d) => !d.filename.startsWith("Downloads/RawTest-"))) {
        fail("raw mode filename does not use the configured path: " +
            downloads.map((d) => d.filename).join(", "));
    }
    console.log("PASS phase 2: raw mode issued 3 per-page downloads to the canonical image CDN");

    // ---- Phase 3: raw mode with failing downloads -------------------------
    sentMessages.length = 0;
    downloads.length = 0;
    downloadFails = true;
    expectedWorkerRejection = true; // startAsync() re-throws after errorCallback
    syncSettings = { useZip: "raw", maxConcurrentDownloads: "3" };
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
    console.log("PASS phase 3: failing raw downloads were retried (" + downloads.length +
        " attempts) and the error reached the popup: " + error.error);

    console.log("PASS: full worker pipeline works in a window-less MV3 context.");
    process.exit(0);
})();
