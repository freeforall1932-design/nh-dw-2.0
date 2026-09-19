// Smoke test: load a built bundle in a window-less context (as an MV3 service
// worker runs) and prove that its chrome.runtime.onMessage listener actually
// registers and answers. The pre-fix background bundle threw
// "ReferenceError: window is not defined" before reaching addListener.
//
// Usage:
//   node scripts/smoke-mv3.js [path/to/bundle.js] [--offscreen]
//
// --offscreen drives the offscreen document bundle, whose listener only
// answers messages addressed with target:"offscreen".
// Exit code 0 = listener registered and answered. Exit code 1 = broken bundle.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const args = process.argv.slice(2);
const offscreenMode = args.includes("--offscreen");
const bundlePath = args.filter((a) => a !== "--offscreen")[0] || path.join(__dirname, "..", "js", "background.js");
const code = fs.readFileSync(bundlePath, "utf8");

let onMessageHandler = null;
let messageListenerRegistered = false;
let onUpdatedListener = null;
let onActivatedListener = null;
const setIconCalls = [];

process.on("unhandledRejection", (reason) => {
    console.error("FAIL: unhandled rejection (toolbar setIcon must catch Failed to fetch): " +
        (reason && reason.message ? reason.message : reason));
    process.exit(1);
});

let determiningListenerCount = 0;

const chromeStub = {
    tabs: {
        onUpdated: { addListener(fn) { onUpdatedListener = fn; } },
        onActivated: { addListener(fn) { onActivatedListener = fn; } },
        query(_query, cb) { cb([{ url: "https://nhentai.net/g/1/" }]); }
    },
    action: {
        // Mirror Chromium MV3: relative icon paths 404 against js/background.js
        // and the returned promise rejects. The worker must use root-relative
        // paths and catch the rejection so it never surfaces as uncaught.
        setIcon(details) {
            setIconCalls.push(details);
            const p = typeof details.path === "string"
                ? details.path
                : (details.path && (details.path["64"] || details.path[64] || Object.values(details.path)[0]));
            return Promise.reject(new Error("Failed to set icon '" + p + "': Failed to fetch"));
        }
    },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        session: { get(_key, cb) { cb({}); }, set() {}, remove() {} }
    },
    runtime: {
        onMessage: {
            addListener(fn) {
                messageListenerRegistered = true;
                onMessageHandler = fn;
            }
        },
        sendMessage() {},
        lastError: null,
        getURL(p) { return "chrome-extension://testid/" + String(p).replace(/^\//, ""); }
    },
    downloads: {
        download() {},
        // onDeterminingFilename is a GLOBAL naming-decision event: an
        // extension that registers it joins the filename chain for every
        // download in the profile and can be blamed by Chrome for files it
        // never started ("failed to name the download ... because another
        // extension determined a different filename"). The shipped worker
        // must therefore NOT register it merely by loading — it is attached
        // on demand while our own downloads are in flight. See the lifetime
        // notes in src/background/downloadNaming.ts.
        onDeterminingFilename: {
            addListener() { determiningListenerCount++; },
            removeListener() { determiningListenerCount--; }
        },
        onChanged: { addListener() {} }
    }
};

const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout,
    clearTimeout,
    // fetch must not be needed at load time; fail loudly if it is.
    fetch() { throw new Error("fetch called during bundle load"); }
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

if (determiningListenerCount !== 0) {
    console.error("FAIL: bundle registered " + determiningListenerCount + " chrome.downloads.onDeterminingFilename listener(s) at load time.");
    console.error("  An idle worker must not participate in the browser-wide filename chain:");
    console.error("  Chrome then blames this extension for downloads started by other extensions.");
    console.error("  Attach the listener on demand instead (src/background/downloadNaming.ts).");
    process.exit(1);
}
console.log("PASS: idle worker registers no global onDeterminingFilename listener.");

function iconPath(details) {
    if (!details) return undefined;
    if (typeof details.path === "string") return details.path;
    return details.path && (details.path["64"] || details.path[64] || Object.values(details.path)[0]);
}

function assertRootRelativeIcon(details, expected, label) {
    const p = iconPath(details);
    if (p !== expected) {
        console.error("FAIL: " + label + " — expected setIcon path " + JSON.stringify(expected) + ", got " + JSON.stringify(p));
        process.exit(1);
    }
    if (!String(p).startsWith("/")) {
        console.error("FAIL: " + label + " — icon path must be root-relative so the MV3 worker does not fetch js/" + p);
        process.exit(1);
    }
}

if (!offscreenMode) {
    if (setIconCalls.length < 1) {
        console.error("FAIL: service worker did not set the toolbar icon for the active tab on startup.");
        process.exit(1);
    }
    assertRootRelativeIcon(setIconCalls[setIconCalls.length - 1], "/Icon.png", "startup icon for nhentai.net");
    if (typeof onUpdatedListener !== "function") {
        console.error("FAIL: chrome.tabs.onUpdated listener was never registered.");
        process.exit(1);
    }
    onUpdatedListener(1, { url: "https://example.com/" }, {});
    assertRootRelativeIcon(setIconCalls[setIconCalls.length - 1], "/Icon-grey.png", "icon off nhentai.net");
    onUpdatedListener(1, { url: "https://nhentai.net/g/123/" }, {});
    assertRootRelativeIcon(setIconCalls[setIconCalls.length - 1], "/Icon.png", "icon on a gallery page");
    if (typeof onActivatedListener === "function") {
        onActivatedListener({ tabId: 1 });
        assertRootRelativeIcon(setIconCalls[setIconCalls.length - 1], "/Icon.png", "icon after tab activation");
    }
    console.log("PASS: setIcon uses root-relative /Icon.png and /Icon-grey.png and swallows fetch failures.");
}

// Give setIcon's rejected promises a tick to surface as unhandledRejection if
// the worker forgot to catch them, then prove the message listener still answers.
setTimeout(() => {
    const request = offscreenMode
        ? { target: "offscreen", action: "isDownloadFinished" }
        : { action: "isDownloadFinished" };

    const answered = onMessageHandler(request, {}, (result) => {
        if (!result || result.result !== true) {
            console.error("FAIL: isDownloadFinished answered: " + JSON.stringify(result));
            process.exit(1);
        }
        console.log("PASS: listener registered and isDownloadFinished answered " + JSON.stringify(result));
        console.log("PASS: " + path.basename(bundlePath) + (offscreenMode ? " works as an offscreen document." : " is safe to run as an MV3 service worker."));
        process.exit(0);
    });

    // The listener must send a response synchronously for this action.
    if (answered === undefined && !offscreenMode) {
        console.error("FAIL: listener returned nothing for isDownloadFinished (sendResponse not called).");
        process.exit(1);
    }
}, 30);
