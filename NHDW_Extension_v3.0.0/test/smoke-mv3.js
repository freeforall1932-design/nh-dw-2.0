// Smoke test: load a built background.js bundle in a window-less context (as an
// MV3 service worker runs) and prove that the chrome.runtime.onMessage listener
// actually registers and answers. The previous bundle threw
// "ReferenceError: window is not defined" before reaching addListener.
//
// Usage:  node test/smoke-mv3.js [path/to/js/background.js]
// Exit code 0 = listener registered and answered. Exit code 1 = broken bundle.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "background.js");
const code = fs.readFileSync(bundlePath, "utf8");

let onMessageHandler = null;
let messageListenerRegistered = false;

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
        onMessage: {
            addListener(fn) {
                messageListenerRegistered = true;
                onMessageHandler = fn;
            }
        },
        sendMessage() {},
        lastError: null
    },
    downloads: { download() {} }
};

const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout,
    clearTimeout,
    // fetch must not be needed at load time; fail loudly if it is.
    fetch() { throw new Error("fetch called during background.js load"); }
};
sandbox.self = sandbox;      // MV3 service workers expose self, not window
sandbox.globalThis = sandbox;

if ("window" in sandbox) {
    console.error("FAIL: test setup error - sandbox must not have window");
    process.exit(1);
}

try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: bundlePath });
} catch (err) {
    console.error("FAIL: bundle threw while loading in a window-less service-worker context:");
    console.error("  " + err.name + ": " + err.message);
    console.error("  (This is the original Failure 1: the listener never registers.)");
    process.exit(1);
}

if (!messageListenerRegistered) {
    console.error("FAIL: bundle loaded but chrome.runtime.onMessage.addListener was never called.");
    process.exit(1);
}

// Simulate the popup's first message: isDownloadFinished.
const response = onMessageHandler({ action: "isDownloadFinished" }, {}, (result) => {
    if (!result || result.result !== true) {
        console.error("FAIL: isDownloadFinished answered: " + JSON.stringify(result));
        process.exit(1);
    }
    console.log("PASS: listener registered and isDownloadFinished answered " + JSON.stringify(result));
    console.log("PASS: " + path.basename(bundlePath) + " is safe to run as an MV3 service worker.");
    process.exit(0);
});

// The listener must send a response synchronously for this action.
if (response === undefined) {
    console.error("FAIL: listener returned nothing for isDownloadFinished (sendResponse not called).");
    process.exit(1);
}
