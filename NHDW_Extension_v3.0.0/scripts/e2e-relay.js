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
let createDocumentCalls = 0;
let closeDocumentCalls = 0;
let hasDocumentResult = false;

const chromeStub = {
    tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query(_query, cb) { cb([{ url: "https://nhentai.net/g/1/" }]); }
    },
    action: { setIcon() {} },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults)); } }
    },
    runtime: {
        onMessage: { addListener(fn) { onMessageHandler = fn; } },
        sendMessage(message, cb) {
            if (message && message.target === "offscreen") {
                relays.push(message);
                // Simulate the offscreen document answering.
                if (cb) {
                    const response = { result: "started" };
                    if (message.action === "isDownloadFinished") response.result = false;
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
    downloads: { download() {} },
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

    // 2. downloadDoujinshi: create the document and relay the command.
    const startAnswer = await sendToBackground({
        action: "downloadDoujinshi",
        json: { id: 123456 },
        path: "Downloads/Test",
        name: "Test"
    });
    if (!startAnswer || startAnswer.result !== "started") {
        fail("downloadDoujinshi answered " + JSON.stringify(startAnswer));
    }
    if (createDocumentCalls !== 1) {
        fail("expected one createDocument call, got " + createDocumentCalls);
    }
    const relay = relays.find((r) => r.action === "downloadDoujinshi");
    if (!relay || relay.target !== "offscreen" || relay.json.id !== 123456 || relay.path !== "Downloads/Test") {
        fail("downloadDoujinshi was not relayed correctly: " + JSON.stringify(relay));
    }
    console.log("PASS: downloadDoujinshi creates the offscreen document and relays the command");

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

    // 6. Progress broadcasts from the offscreen document must not loop back
    //    into the relay (they are consumed, not re-sent).
    const relaysBefore = relays.length;
    onMessageHandler({ from: "offscreen", action: "updateProgress", progress: 7 }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    if (relays.length !== relaysBefore) {
        fail("an offscreen progress broadcast was wrongly relayed back, creating a loop");
    }
    console.log("PASS: offscreen progress broadcasts do not loop back through the service worker");

    console.log("PASS: service worker relay behaves correctly.");
    process.exit(0);
})();
