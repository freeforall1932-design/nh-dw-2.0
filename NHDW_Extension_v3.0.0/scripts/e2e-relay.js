// Service-worker relay test: load the built js/background.js in a window-less
// VM context with a chrome.offscreen stub and prove that the service worker
// forwards download commands to the offscreen document and answers the popup.
//
// Usage:  node scripts/e2e-relay.js [path/to/js/background.js]
// Exit code 0 = relay behaves correctly.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "background.js");
const code = fs.readFileSync(bundlePath, "utf8");

let onMessageHandler = null;
const relays = [];            // messages sent to the offscreen document
const broadcasts = [];        // messages sent to the popup
const downloadCalls = [];     // chrome.downloads.download calls by the worker
const executeScriptCalls = [];
let createDocumentCalls = 0;
let closeDocumentCalls = 0;
let hasDocumentResult = false;
// What the simulated offscreen document answers for isDownloadFinished.
let offscreenFinished = false;
// chrome.storage.session backing store (the active-job marker lives here).
const sessionStore = {};

const chromeStub = {
    tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query(_query, cb) { cb([{ url: "https://nhentai.net/g/1/" }]); }
    },
    action: { setIcon() {} },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        session: {
            get(key, cb) { cb(typeof key === "string" ? { [key]: sessionStore[key] } : Object.assign({}, sessionStore)); },
            set(items) { Object.assign(sessionStore, items); },
            remove(key) { delete sessionStore[key]; }
        }
    },
    scripting: {
        // The worker performs tab injections on behalf of the offscreen
        // document (fetchInTab / fetchUrlInTab relays).
        executeScript(details, cb) {
            executeScriptCalls.push(details);
            if (cb) {
                setTimeout(() => cb([{
                    result: {
                        ok: true, status: 200, statusText: "OK",
                        contentType: "image/jpeg", b64: "AAA=", error: null,
                        text: null
                    }
                }]), 0);
            }
        }
    },
    runtime: {
        onMessage: { addListener(fn) { onMessageHandler = fn; } },
        sendMessage(message, cb) {
            if (message && message.target === "offscreen") {
                relays.push(message);
                // Simulate the offscreen document answering.
                if (cb) {
                    const response = { result: "started" };
                    if (message.action === "isDownloadFinished") response.result = offscreenFinished;
                    else if (message.action === "getProgress") {
                        response.progress = 42;
                        response.doujinshiName = "Test";
                        response.isZipping = true;
                    } else if (message.action === "goBack") {
                        response.result = "success";
                    }
                    setTimeout(() => cb(response), 0);
                }
            } else if (message) {
                broadcasts.push(message);
            }
        },
        lastError: null
    },
    downloads: {
        download(opts, cb) {
            downloadCalls.push(opts);
            if (cb) cb(7);
        }
    },
    offscreen: {
        hasDocument(cb) { cb(hasDocumentResult); },
        createDocument(opts, cb) {
            createDocumentCalls++;
            hasDocumentResult = true;
            if (cb) cb();
        },
        closeDocument() { closeDocumentCalls++; }
    }
};

const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout,
    clearTimeout,
    fetch() { throw new Error("fetch called during background.js load"); }
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

function fail(msg) {
    console.error("FAIL: " + msg);
    process.exit(1);
}

function sendToBackground(message) {
    return new Promise((resolve) => {
        onMessageHandler(message, {}, (response) => resolve(response));
    });
}

(async () => {
    try {
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox, { filename: bundlePath });
    } catch (err) {
        fail("bundle threw while loading: " + err.name + ": " + err.message);
    }
    if (!onMessageHandler) fail("onMessage listener was never registered");

    // 1. isDownloadFinished with no document open: answer true without creating one.
    const idleAnswer = await sendToBackground({ action: "isDownloadFinished" });
    if (!idleAnswer || idleAnswer.result !== true) {
        fail("isDownloadFinished (no document) answered " + JSON.stringify(idleAnswer));
    }
    if (createDocumentCalls !== 0) {
        fail("isDownloadFinished created an offscreen document unnecessarily");
    }
    console.log("PASS: isDownloadFinished answers true without an offscreen document");

    // 2. downloadDoujinshi: create the document and relay the command,
    //    including the options the worker read from chrome.storage.sync
    //    (the offscreen document cannot read storage itself).
    const startAnswer = await sendToBackground({
        action: "downloadDoujinshi",
        json: { id: 123456 },
        path: "Downloads/Test",
        name: "Test",
        tabId: 42
    });
    if (!startAnswer || startAnswer.result !== "started") {
        fail("downloadDoujinshi answered " + JSON.stringify(startAnswer));
    }
    if (createDocumentCalls !== 1) {
        fail("expected one createDocument call, got " + createDocumentCalls);
    }
    const relay = relays.find((r) => r.action === "downloadDoujinshi");
    if (!relay || relay.target !== "offscreen" || relay.json.id !== 123456 || relay.path !== "Downloads/Test" || relay.tabId !== 42) {
        fail("downloadDoujinshi was not relayed correctly: " + JSON.stringify(relay));
    }
    if (!relay.options || typeof relay.options.useZip !== "string" || relay.options.maxConcurrentDownloads === undefined) {
        fail("downloadDoujinshi relay must carry the worker-read options: " + JSON.stringify(relay.options));
    }
    console.log("PASS: downloadDoujinshi creates the offscreen document and relays the command with options");

    // 3. updateProgress: relay getProgress and broadcast the answer to the popup.
    const progressAnswer = await sendToBackground({ action: "updateProgress" });
    if (!progressAnswer || progressAnswer.result !== "success") {
        fail("updateProgress answered " + JSON.stringify(progressAnswer));
    }
    await new Promise((r) => setTimeout(r, 20));
    const progressBroadcast = broadcasts.find((b) => b.action === "updateProgress" && b.progress === 42);
    if (!progressBroadcast || progressBroadcast.isZipping !== true) {
        fail("updateProgress was not forwarded to the popup: " + JSON.stringify(broadcasts));
    }
    console.log("PASS: updateProgress is relayed to the offscreen document and forwarded to the popup");

    // 4. goBack relay.
    const goBackAnswer = await sendToBackground({ action: "goBack" });
    if (!goBackAnswer || goBackAnswer.result !== "success") {
        fail("goBack answered " + JSON.stringify(goBackAnswer));
    }
    if (!relays.some((r) => r.action === "goBack")) {
        fail("goBack was not relayed to the offscreen document");
    }
    console.log("PASS: goBack is relayed");

    // 5. offscreenIdle message closes the document.
    onMessageHandler({ from: "offscreen", action: "offscreenIdle" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    if (closeDocumentCalls !== 1) {
        fail("offscreenIdle did not close the offscreen document (closeDocument calls: " + closeDocumentCalls + ")");
    }
    console.log("PASS: offscreenIdle closes the offscreen document");

    // 5b. A finished job must not be reported as interrupted. Even with a
    //     stale active-job marker still set (the 60s idle window before the
    //     offscreen document closes), a LIVE document that reports the job
    //     finished means the download completed normally: the worker must
    //     clear the marker and answer interrupted:false (the stale-marker
    //     false positive previously made the popup claim "Download
    //     interrupted" right after a success).
    hasDocumentResult = true;
    offscreenFinished = true;
    sessionStore.downloadJob = { active: true, startedAt: Date.now() };
    const finishedAnswer = await sendToBackground({ action: "isDownloadFinished" });
    if (!finishedAnswer || finishedAnswer.result !== true || finishedAnswer.interrupted !== false) {
        fail("a finished job with a live document must answer interrupted:false, got " + JSON.stringify(finishedAnswer));
    }
    if (sessionStore.downloadJob !== undefined) {
        fail("isDownloadFinished must clear a stale marker when the document reports the job finished");
    }
    console.log("PASS: finished job with a live document clears the marker and answers interrupted:false");

    // 5c. jobFinished from the offscreen document clears the marker promptly.
    sessionStore.downloadJob = { active: true, startedAt: Date.now() };
    onMessageHandler({ from: "offscreen", action: "jobFinished" }, {}, () => {});
    if (sessionStore.downloadJob !== undefined) {
        fail("jobFinished must clear the active-job marker, got " + JSON.stringify(sessionStore.downloadJob));
    }
    console.log("PASS: jobFinished clears the active-job marker");

    // 5d. A genuinely interrupted job (no document, marker still set) must
    //     still be reported as interrupted.
    hasDocumentResult = false;
    sessionStore.downloadJob = { active: true, startedAt: Date.now() };
    const interruptedAnswer = await sendToBackground({ action: "isDownloadFinished" });
    if (!interruptedAnswer || interruptedAnswer.result !== true || interruptedAnswer.interrupted !== true) {
        fail("a missing document with a stale marker must answer interrupted:true, got " + JSON.stringify(interruptedAnswer));
    }
    console.log("PASS: missing document with a stale marker still answers interrupted:true");

    // 6. Progress broadcasts from the offscreen document must not loop back
    //    into the relay (they are consumed, not re-sent) and must not keep
    //    the message channel open (returning true made Chrome log
    //    "A listener indicated an asynchronous response by returning true,
    //    but the message channel closed before a response was received").
    const relaysBefore = relays.length;
    const broadcastKeptOpen = onMessageHandler({ from: "offscreen", action: "updateProgress", progress: 7 }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    if (relays.length !== relaysBefore) {
        fail("an offscreen progress broadcast was wrongly relayed back, creating a loop");
    }
    if (broadcastKeptOpen === true) {
        fail("a fire-and-forget offscreen broadcast must not keep the message channel open");
    }
    console.log("PASS: offscreen progress broadcasts do not loop back and do not keep the channel open");

    // 7. Unknown popup actions (e.g. getGalleries, handled by the popup
    //    itself) must not keep the channel open either.
    const getGalleriesKeptOpen = onMessageHandler({ action: "getGalleries", galleries: [] }, {}, () => {});
    if (getGalleriesKeptOpen === true) {
        fail("getGalleries must not be treated as an async-replied worker action");
    }
    console.log("PASS: unhandled actions return false (no 'message channel closed' noise)");

    // 8. saveDownload: the offscreen document cannot call chrome.downloads,
    //    so the worker performs the download on its behalf and answers.
    const saveAnswer = await new Promise((resolve) => {
        onMessageHandler({ from: "offscreen", action: "saveDownload", url: "blob:chrome-extension://x/abc", filename: "Downloads/Test/001.jpg" }, {}, resolve);
    });
    if (!saveAnswer || saveAnswer.result !== 7) {
        fail("saveDownload answered " + JSON.stringify(saveAnswer));
    }
    if (downloadCalls.length !== 1 || downloadCalls[0].url !== "blob:chrome-extension://x/abc" || downloadCalls[0].filename !== "Downloads/Test/001.jpg") {
        fail("saveDownload was not handed to chrome.downloads.download: " + JSON.stringify(downloadCalls));
    }
    console.log("PASS: saveDownload relays the object URL to chrome.downloads.download");

    // 9. fetchInTab: the worker injects the image fetch into the tab
    //    (chrome.scripting is not available in the offscreen document).
    const tabImageAnswer = await new Promise((resolve) => {
        onMessageHandler({ from: "offscreen", action: "fetchInTab", tabId: 42, url: "https://i.nhentai.net/galleries/987654/1.jpg", world: "ISOLATED" }, {}, resolve);
    });
    if (!tabImageAnswer || tabImageAnswer.ok !== true || !tabImageAnswer.b64) {
        fail("fetchInTab answered " + JSON.stringify(tabImageAnswer));
    }
    if (executeScriptCalls.length < 1 || executeScriptCalls[0].world !== "ISOLATED" || !executeScriptCalls[0].target || executeScriptCalls[0].target.tabId !== 42) {
        fail("fetchInTab was not injected through chrome.scripting.executeScript: " + JSON.stringify(executeScriptCalls));
    }
    console.log("PASS: fetchInTab injects the image fetch into the tab via the worker");

    // 10. fetchUrlInTab: page text (gallery API / listings) through the tab.
    const tabUrlAnswer = await new Promise((resolve) => {
        onMessageHandler({ from: "offscreen", action: "fetchUrlInTab", tabId: 42, url: "https://nhentai.net/api/v2/galleries/123456" }, {}, resolve);
    });
    if (!tabUrlAnswer || tabUrlAnswer.ok !== true) {
        fail("fetchUrlInTab answered " + JSON.stringify(tabUrlAnswer));
    }
    if (executeScriptCalls.length < 2 || executeScriptCalls[executeScriptCalls.length - 1].world !== "MAIN") {
        fail("fetchUrlInTab must inject in the MAIN world: " + JSON.stringify(executeScriptCalls));
    }
    console.log("PASS: fetchUrlInTab relays page-text fetches to the tab");

    console.log("PASS: service worker relay behaves correctly.");
    process.exit(0);
})();
