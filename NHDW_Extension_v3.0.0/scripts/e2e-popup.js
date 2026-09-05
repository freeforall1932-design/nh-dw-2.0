// Window-less popup test: load the built js/preview.js in a VM with a DOM stub
// and drive the panel through the messages the worker/offscreen document send
// it (updateProgress / downloadError / batchProgress / batchSummary), then
// click the buttons those messages render.
//
// WHY THIS EXISTS. Until now the only popup coverage was the real-browser suite
// (scripts/e2e-browser.js), which cannot run in CI or in this sandbox, so the
// message -> UI layer - the layer where "the panel is a dead-end" (item 29) and
// "the failed list disappeared" (3.6.4) both lived - was untested. This harness
// is deliberately scoped to that layer: it does NOT bootstrap a listing page
// (no injected checkboxes, no similar-galleries panel). It proves:
//
//   1. an object-shaped error renders as its message, never "[object Object]";
//   2. a batch-level error still leaves a clickable Go Back (item 29);
//   3. a batch summary names the failed galleries and offers Retry failed (N);
//   4. clicking Retry re-sends exactly those titles with the job's settings,
//      and when the worker refuses to start, the failed notice comes BACK
//      instead of leaving the panel with no way to retry again.
//
// Usage:  node scripts/e2e-popup.js [path/to/js/preview.js]
// Exit code 0 = all phases passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "preview.js");
const code = fs.readFileSync(bundlePath, "utf8");

function fail(msg) {
    console.error("FAIL: " + msg);
    process.exit(1);
}

// --- minimal DOM -----------------------------------------------------------
// getElementById auto-vivifies: the popup asks for many optional ids and a
// missing node would throw where the real panel simply has one.
const nodes = new Map();

function makeNode(tag, id) {
    const node = {
        tagName: String(tag || "div").toUpperCase(),
        id: id || "",
        children: [],
        _classes: [],
        _listeners: {},
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        disabled: false,
        checked: false,
        style: {},
        parentElement: null,
        classList: {
            add(name) { if (!node._classes.includes(name)) node._classes.push(name); },
            remove(name) {
                const i = node._classes.indexOf(name);
                if (i !== -1) node._classes.splice(i, 1);
            },
            contains(name) { return node._classes.includes(name); }
        },
        setAttribute(k, v) { node[k] = v; },
        getAttribute(k) { return node[k]; },
        appendChild(child) { node.children.push(child); child.parentElement = node; return child; },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i !== -1) node.children.splice(i, 1);
            return child;
        },
        addEventListener(type, fn) {
            (node._listeners[type] = node._listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            const list = node._listeners[type] || [];
            const i = list.indexOf(fn);
            if (i !== -1) list.splice(i, 1);
        },
        dispatch(type, event) {
            for (const fn of (node._listeners[type] || []).slice()) {
                fn(Object.assign({ type: type, preventDefault() {}, stopPropagation() {}, target: node }, event || {}));
            }
        },
        // In a real panel, re-rendering #action replaces the old button element
        // and its listener with it. This stub keeps one node per id, so every
        // wiring stacks up; clicking "the current button" means the LAST
        // listener registered for it.
        dispatchLast(type, event) {
            const list = (node._listeners[type] || []).slice();
            const fn = list[list.length - 1];
            if (fn) {
                fn(Object.assign({ type: type, preventDefault() {}, stopPropagation() {}, target: node }, event || {}));
            }
        },
        focus() {},
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    return node;
}

function byId(id) {
    let node = nodes.get(id);
    if (!node) {
        node = makeNode("div", id);
        nodes.set(id, node);
    }
    return node;
}

const bodyNode = makeNode("body");
const documentStub = {
    body: bodyNode,
    documentElement: makeNode("html"),
    readyState: "complete",
    getElementById: byId,
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
};

// --- chrome stub -----------------------------------------------------------
// The panel registers TWO onMessage listeners (popup.ts drives the download
// UI, preview.ts the tab/URL behaviour). Chrome calls every listener, so the
// harness must too - keeping only the last one silently tested the wrong half.
const messageListeners = [];
const sentMessages = [];
// What the worker answers for getFailedGalleries (the session failure list).
let failedStore = [];
// What the worker answers for a retry command; phases flip this to "error".
let retryAnswer = { result: "started" };

const chromeStub = {
    runtime: {
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        sendMessage(msg, cb) {
            sentMessages.push(msg);
            if (!cb) return;
            if (msg && msg.action === "getFailedGalleries") {
                cb({ result: "success", failed: failedStore });
                return;
            }
            if (msg && msg.action === "forgetFailedGalleries") {
                failedStore = [];
                cb({ result: "success" });
                return;
            }
            if (msg && msg.action === "downloadAllDoujinshis") {
                cb(retryAnswer);
                return;
            }
            cb({ result: "success" });
        },
        lastError: null,
        getURL: (p) => p
    },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults)); }, set(_items, cb) { if (cb) cb(); } },
        local: {
            // apiKeyGate: "skipped" = the first-run gate was already answered,
            // so the panel renders its normal preview instead of the key box
            // (which would overwrite #action under the phases below).
            get(defaults, cb) { cb(Object.assign({}, defaults, { apiKeyGate: "skipped" })); },
            set(_items, cb) { if (cb) cb(); },
            remove(_key, cb) { if (cb) cb(); },
            clear(cb) { if (cb) cb(); }
        },
        session: { get(_key, cb) { cb({}); }, set(_items, cb) { if (cb) cb(); }, remove(_key, cb) { if (cb) cb(); } }
    },
    tabs: {
        query(_q, cb) { cb([{ id: 7, url: "https://nhentai.net/g/123456/" }]); },
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} }
    },
    action: { setIcon() {}, setPopup() {} },
    sidePanel: undefined,
    permissions: { contains(_p, cb) { cb(true); } },
    scripting: { executeScript(_o, cb) { if (cb) cb([]); } }
};

const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    document: documentStub,
    chrome: chromeStub,
    URL: URL,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    fetch: () => Promise.reject(new Error("no network in the popup harness")),
    confirm: () => false,
    alert: () => {},
    navigator: { userAgent: "popup-harness" },
    location: { href: "https://nhentai.net/g/123456/" }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    try {
        vm.runInContext(code, sandbox, { filename: bundlePath });
    } catch (err) {
        fail("bundle threw while loading: " + err.name + ": " + err.message);
    }
    if (messageListeners.length === 0) fail("the popup never registered an onMessage listener");
    if (messageListeners.length < 2) {
        fail("expected both popup and preview listeners, got " + messageListeners.length);
    }
    // Deliver a message the way chrome.runtime does: every listener, in order.
    const deliver = (msg) => {
        for (const fn of messageListeners.slice()) {
            fn(msg, {}, () => {});
        }
    };

    // ---- Phase 1: object-shaped error renders its message -------------------
    // The worker sends errorMessage(error) today, so this is latent - but the
    // popup is the LAST hop, and String(plainObject) here is how the original
    // "[object Object]" report was produced.
    deliver({
        action: "downloadError",
        error: { message: "Failed to download original image (NETWORK_FAILED)." },
        galleryId: "123456",
        galleryName: "Some Title",
        retryJob: { formatOverride: "cbz", tabId: 7 }
    });
    await wait(20);
    const action = byId("action");
    if (/\[object Object\]/.test(action.innerHTML)) {
        fail("an object-shaped error must not render as [object Object], got " + action.innerHTML);
    }
    if (!/NETWORK_FAILED/.test(action.innerHTML)) {
        fail("the error message must be shown, got " + action.innerHTML);
    }
    if (!/Some Title/.test(action.innerHTML)) {
        fail("the failed gallery must be named, got " + action.innerHTML);
    }
    if (!/id="buttonBack"/.test(action.innerHTML) || !/id="buttonRetryFailed"/.test(action.innerHTML)) {
        fail("a retryable error must offer Retry and Go Back, got " + action.innerHTML);
    }
    console.log("PASS phase 1: object-shaped downloadError renders its message with Retry + Go Back");

    // ---- Phase 2: batch-level error still leaves an action (item 29) -------
    deliver({ action: "downloadError", error: "Unable to start the offscreen download document." });
    await wait(20);
    if (!/id="buttonBack"/.test(byId("action").innerHTML)) {
        fail("a batch-level error must still render Go Back, got " + byId("action").innerHTML);
    }
    if (/id="buttonRetryFailed"/.test(byId("action").innerHTML)) {
        fail("a non-retryable error must not offer Retry");
    }
    console.log("PASS phase 2: batch-level error leaves a clickable Go Back (item 29)");

    // ---- Phase 3: batch summary names the failures -------------------------
    deliver({
        action: "batchSummary",
        succeeded: 1,
        failed: 1,
        total: 2,
        skipped: 0,
        failedKinds: { image: 1 },
        failedGalleries: [{ id: "654321", name: "Broken Title", error: "Failed to download original image (x)." }],
        retryJob: { formatOverride: "zip" }
    });
    await wait(20);
    const summary = byId("action").innerHTML;
    if (!/Broken Title/.test(summary)) {
        fail("the summary must name the failed gallery, got " + summary);
    }
    if (!/Retry failed \(1\)/.test(summary)) {
        fail("the summary must offer Retry failed (1), got " + summary);
    }
    console.log("PASS phase 3: batch summary names failed galleries and offers Retry failed (N)");

    // ---- Phase 4: Retry re-sends the job, and a refusal restores the notice -
    failedStore = [{
        id: "654321",
        name: "Broken Title",
        error: "Failed to download original image (x).",
        retryJob: { formatOverride: "zip" },
        at: 1
    }];
    // The Retry button rendered by the summary is wired on a setTimeout; click
    // the one the popup bound inside #action.
    const retryButton = byId("buttonRetryFailed");
    if (!retryButton._listeners.click || retryButton._listeners.click.length === 0) {
        fail("the summary's Retry button was never wired");
    }
    sentMessages.length = 0;
    retryAnswer = { result: "error" };   // the worker refuses to start the job
    retryButton.dispatchLast("click");
    await wait(30);
    const retryMessage = sentMessages.find((m) => m.action === "downloadAllDoujinshis");
    if (!retryMessage) {
        fail("clicking Retry must re-send a downloadAllDoujinshis job, sent " + JSON.stringify(sentMessages));
    }
    if (!retryMessage.allDoujinshis["654321"]) {
        fail("the retry must carry exactly the failed gallery, got " + JSON.stringify(retryMessage.allDoujinshis));
    }
    if (!Array.isArray(retryMessage.redownloadIds) || retryMessage.redownloadIds.indexOf("654321") === -1) {
        fail("the retry must force the id past the history guard, got " + JSON.stringify(retryMessage.redownloadIds));
    }
    if (retryMessage.formatOverride !== "zip" || retryMessage.separate !== true) {
        fail("the retry must reuse the failed job's settings as separate files, got " + JSON.stringify(retryMessage));
    }
    // The refusal must NOT leave the panel without the failed list.
    const notice = byId("failedNotice");
    if (notice.hidden !== false) {
        fail("a refused retry must restore the failed notice, got hidden=" + notice.hidden);
    }
    if (!/Broken Title/.test(notice.innerHTML)) {
        fail("the restored notice must list the still-failed gallery, got " + notice.innerHTML);
    }
    if (!/id="buttonRetryPending"/.test(notice.innerHTML)) {
        fail("the restored notice must offer Retry failed again, got " + notice.innerHTML);
    }
    console.log("PASS phase 4: Retry re-sends the failed titles and a refusal restores the notice");

    // ---- Phase 5: dismiss forgets the list --------------------------------
    sentMessages.length = 0;
    byId("buttonDismissFailed").dispatchLast("click");
    await wait(20);
    if (!sentMessages.some((m) => m.action === "forgetFailedGalleries")) {
        fail("Dismiss must ask the worker to forget the failures, sent " + JSON.stringify(sentMessages));
    }
    if (byId("failedNotice").hidden !== true) {
        fail("Dismiss must hide the notice");
    }
    console.log("PASS phase 5: Dismiss forgets the failed list and hides the notice");

    console.log("PASS: popup message layer behaves correctly in a window-less context.");
    process.exit(0);
})();
