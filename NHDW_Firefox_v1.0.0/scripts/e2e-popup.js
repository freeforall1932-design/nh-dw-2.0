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
//      instead of leaving the panel with no way to retry again;
//   5. Dismiss asks the worker to forget the list and hides the notice;
//   6. opening the Settings tab does NOT rewrite the stored name template
//      (it used to canonicalise "{id} - {pretty}" into "{pretty} - {id}");
//   7. an explicit token tick still saves - the fix must not make the section
//      read-only;
//   8. with no listFormat key set, the list-mode format shown is the inherited
//      single-title one, i.e. the format that will actually be used;
//   9-12. explicit/inherited/legacy formats restore read-only in Settings,
//      edits survive reopening, delivered getGalleries messages render the
//      resolved format, and Queue dispatches it in normal/Full panel mode.
//
// THREE STUB TRAPS, each of which silently tests the wrong thing (all cost a
// debugging round; keep them if you port this harness to the Firefox folder):
//   * the panel registers TWO onMessage listeners (popup.ts and preview.ts), so
//     delivery must fan out - keeping only the last one tests the wrong half;
//   * storage.local must answer apiKeyGate "skipped", otherwise the first-run
//     key gate renders into #action and overwrites every phase;
//   * assigning .id on a createElement node must register it with
//     getElementById (last write wins), because popupSettings builds its
//     checkboxes that way and then looks them up by id - without it the panel
//     reads back fresh unchecked boxes instead of the ones it just built.
// chrome.storage.sync is stateful here and logs every write to syncWrites, so
// "must not write" is assertable. get() is asynchronous and key-scoped: NEVER
// merge the whole store over defaults (that masked the item-59 missing key).
//
// Usage:  node scripts/e2e-popup.js [path/to/js/preview.js] [--full-panel]
// Exit code 0 = all phases passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("node:assert/strict");
const { readStorage } = require("./test-support/storage");
const { formats, formatCases, previewSuffix } = require("./test-support/list-format-cases");

const fullPanel = process.argv.includes("--full-panel");
const bundlePath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || path.join(__dirname, "..", "js", "preview.js");
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
            contains(name) { return node._classes.includes(name); },
            toggle(name, force) {
                const on = force === undefined ? !node._classes.includes(name) : !!force;
                if (on) { node.classList.add(name); } else { node.classList.remove(name); }
                return on;
            }
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
    // In a real DOM, assigning .id makes an element findable by
    // getElementById. The settings pane builds its checkboxes with
    // createElement and then looks them up by id, so without this the panel
    // would read back fresh unchecked nodes instead of the ones it made.
    let nodeId = "";
    Object.defineProperty(node, "id", {
        get() { return nodeId; },
        set(value) {
            nodeId = String(value);
            // Last write wins, like a real document: renderSettings clears its
            // pane and appends fresh elements, so the newest node with an id is
            // the one getElementById must return.
            if (nodeId) nodes.set(nodeId, node);
        },
        enumerable: true
    });
    if (id) node.id = id;
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
// chrome.storage.sync as the panel sees it, plus every write it makes.
const syncStore = {};
const syncWrites = [];
const localWrites = [];
const localStore = { apiKeyGate: "skipped" };
const sourceTab = { id: 7, url: "https://nhentai.net/g/123456/", active: !fullPanel };
const panelUrl = "moz-extension://testid/index.html" + (fullPanel ? "?sourceTabId=7" : "");
const updatedListeners = [];


const chromeStub = {
    runtime: {
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        sendMessage(msg, cb) {
            sentMessages.push(msg);
            if (!cb) return;
            if (msg && msg.action === "isDownloadFinished") {
                // The message-layer phases simulate a job in progress. Do not
                // race an unrelated live metadata fetch against their UI.
                cb({ result: false });
                return;
            }
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
        getURL: (p) => "moz-extension://testid/" + p,
        getManifest: () => fullPanel ? require("../manifest.json")
            : ({ content_scripts: [{ js: ["js/content.js", "js/listControls.js"] }] })
    },
    storage: {
        // Stateful: the settings pane reads what it wrote moments earlier.
        sync: {
            get(keys, cb) { queueMicrotask(() => cb(readStorage(syncStore, keys))); },
            set(items, cb) {
                syncWrites.push(Object.assign({}, items));
                Object.assign(syncStore, items);
                if (cb) cb();
            },
            remove(key, cb) { delete syncStore[key]; if (cb) cb(); }
        },
        local: {
            // apiKeyGate: "skipped" = the first-run gate was already answered,
            // so the panel renders its normal preview instead of the key box
            // (which would overwrite #action under the phases below).
            get(keys, cb) { queueMicrotask(() => cb(readStorage(localStore, keys))); },
            set(items, cb) { localWrites.push(structuredClone(items)); Object.assign(localStore, items); if (cb) cb(); },
            remove(key, cb) { localWrites.push({ remove: key }); delete localStore[key]; if (cb) cb(); },
            clear() { fail("popup bootstrap must never clear local storage"); }
        },
        session: { get(_key, cb) { cb({}); }, set(_items, cb) { if (cb) cb(); }, remove(_key, cb) { if (cb) cb(); } }
    },
    tabs: {
        query(_q, cb) { cb(fullPanel ? [{ id: 99, url: panelUrl, active: true }] : [sourceTab]); },
        get(id, cb) { cb(id === sourceTab.id ? sourceTab : undefined); },
        onUpdated: { addListener(fn) { updatedListeners.push(fn); } },
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
    location: { href: panelUrl }
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
    await wait(20);
    if (localStore.lastUrl !== sourceTab.url) {
        fail("bootstrap must use the source page URL, not the full-panel extension tab: " + localStore.lastUrl);
    }
    console.log("PASS: " + (fullPanel ? "Full panel preserves its originating tab" : "popup follows the active tab"));
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
    if (retryMessage.tabId !== 7) {
        fail("retry must use the validated source tab, never the extension tab: " + retryMessage.tabId);
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

    // ---- Phase 6: opening Settings must not rewrite stored settings --------
    // A canonical template: representable by the checkboxes, so the panel takes
    // the checkbox branch. Merely opening the tab used to rebuild it and save
    // that, silently reordering the file names with no user action.
    //
    // (The item-41 gate — a NON-canonical template like "{pretty}_{id}" never
    // offers the boxes at all — is a pure contract, asserted in
    // test/queue-transfer.test.js and against the real options.html by
    // test:options. This pane builds its DOM once, so it cannot be re-rendered
    // with a second template inside one VM run.)
    syncStore.downloadName = "{pretty} - {id}";
    const writesBefore = syncWrites.length;
    byId("tabSettings").dispatchLast("click");
    await wait(30);
    const tplPreview = byId("psTemplatePreview");
    if (!/Example file name/.test(tplPreview.textContent)) {
        fail("a canonical template must render the tick-box example, got \"" + tplPreview.textContent + "\"");
    }
    const unsolicited = syncWrites.slice(writesBefore).filter((w) => "downloadName" in w);
    if (unsolicited.length > 0) {
        fail("opening the Settings tab must not rewrite downloadName, it wrote " + JSON.stringify(unsolicited));
    }
    if (syncStore.downloadName !== "{pretty} - {id}") {
        fail("the stored template must survive opening Settings untouched, got " + syncStore.downloadName);
    }
    console.log("PASS phase 6: opening Settings leaves the stored name template alone");

    // ---- Phase 7: ticking a token still saves -----------------------------
    // The fix must not turn the section read-only: an explicit change writes,
    // and it must still be reachable on a template the boxes may represent.
    const exampleBefore = tplPreview.textContent;
    const languageBox = byId("psTpl_language");
    if (!languageBox._listeners.change || languageBox._listeners.change.length === 0) {
        fail("the settings tab must wire a change handler to each template checkbox");
    }
    languageBox.checked = true;
    const writesBefore2 = syncWrites.length;
    languageBox.dispatchLast("change");
    await wait(20);
    const saved = syncWrites.slice(writesBefore2).filter((w) => "downloadName" in w).pop();
    if (!saved) {
        fail("ticking a token must save the template");
    }
    if (saved.downloadName.indexOf("{language}") === -1) {
        fail("the saved template must contain the newly ticked token, got " + saved.downloadName);
    }
    if (saved.downloadName.indexOf("{id}") === -1 || saved.downloadName.indexOf("{pretty}") === -1) {
        fail("the saved template must keep the tokens already in use, got " + saved.downloadName);
    }
    // The example is a CONCRETE name, so an optional token with no matching tag
    // shows as an empty segment rather than as "{language}"; what matters is
    // that the example was rebuilt at all.
    if (tplPreview.textContent === exampleBefore) {
        fail("the example file name must be rebuilt after a change, still " + tplPreview.textContent);
    }
    if (!/^Example file name: /.test(tplPreview.textContent)) {
        fail("the example file name must stay readable, got " + tplPreview.textContent);
    }
    console.log("PASS phase 7: ticking a token saves the template it builds");

    // ---- Phase 8: the list format shown must be the one that will be used --
    // listFormat has no stored value here, so list mode inherits the
    // single-title format (cbz). The panel used to default the key to "zip" in
    // its storage.get call, which made it advertise ZIP while listControls and
    // buildListSettings inherited CBZ for the very same storage.
    syncStore.useZip = "cbz";
    delete syncStore.listFormat;
    byId("tabSettings").dispatchLast("click");
    await wait(30);
    const listFormat = byId("psListFormat");
    if (listFormat.value !== "cbz") {
        fail("with no list key set the panel must show the inherited format cbz, got " + listFormat.value);
    }
    const listPreview = byId("psListTemplatePreview");
    if (listPreview.textContent.indexOf(".cbz") === -1) {
        fail("the list-mode example must use the inherited format, got " + listPreview.textContent);
    }
    console.log("PASS phase 8: the list-mode format shown is the one that will be used");

    // ---- Item 59: saved list settings + real reader consumers ------------
    // The legacy DOM auto-creates ids for message-only phases. These checks
    // must instead find real renderer-created controls and their real choices.
    const installFormats = (stored) => {
        delete syncStore.useZip;
        delete syncStore.listFormat;
        Object.assign(syncStore, stored);
    };
    const checkFormatControl = (expected, label) => {
        const control = nodes.get("psListFormat");
        assert.ok(control, label + ": real list format control");
        assert.equal(control.tagName, "SELECT");
        assert.deepEqual(control.children.map((option) => option.value), formats);
        assert.equal(control.value, expected, label);
        assert.ok(nodes.get("psListTemplatePreview").textContent.endsWith(previewSuffix(expected)), label + ": preview");
        return control;
    };
    for (const { label, stored, expected } of formatCases) {
        installFormats(stored);
        const before = structuredClone(syncStore);
        const writes = syncWrites.length;
        const localCount = localWrites.length;
        byId("tabSettings").dispatchLast("click");
        await wait(20);
        checkFormatControl(expected, label);
        assert.deepEqual(syncStore, before, label + ": rendering preserves the stored values");
        assert.equal(syncWrites.length, writes, label + ": no sync writes on render");
        assert.equal(localWrites.length, localCount, label + ": no local writes on render");
    }
    console.log(`PASS phase 9: all ${formatCases.length} saved/inherited/legacy list-format cases restore read-only in Settings`);

    installFormats({ useZip: "cbz", listFormat: "pdf" });
    for (const value of formats) {
        byId("tabSettings").dispatchLast("click");
        await wait(20);
        const control = nodes.get("psListFormat");
        const writes = syncWrites.length;
        const before = structuredClone(syncStore);
        control.value = value;
        control.dispatchLast("change");
        await wait(0);
        assert.deepEqual(syncWrites.slice(writes), [{ listFormat: value }]);
        assert.deepEqual(syncStore, { ...before, listFormat: value });
        const afterChange = syncWrites.length;
        byId("tabSettings").dispatchLast("click");
        await wait(20);
        checkFormatControl(value, "reopened " + value);
        assert.equal(syncWrites.length, afterChange, "reopening must not write");
    }
    console.log("PASS phase 10: explicit list-format changes persist only their own key and survive reopening");

    // Deliver the actual getGalleries message: this tests the listing renderer
    // and shared-reader boundary, NOT live page injection/pagination (item 40).
    syncStore.listOutputMode = "separate";
    for (const { label, stored, expected } of formatCases) {
        installFormats(stored);
        const writes = syncWrites.length;
        const localCount = localWrites.length;
        deliver({ action: "getGalleries", galleries: [{ id: "111111", title: "Format fixture" }], currentPage: 0, maxPage: 0 });
        await wait(20);
        const html = byId("action").innerHTML;
        const select = /<select id="listFormat">([\s\S]*?)<\/select>/.exec(html);
        assert.ok(select, label + ": real listing options markup");
        assert.ok(html.includes('id="listNamePreview"'), label + ": preview is actually in the markup");
        assert.deepEqual(Array.from(select[1].matchAll(/<option value="([^"]+)"/g), (match) => match[1]), formats);
        assert.ok(select[1].includes('<option value="' + expected + '" selected>'), label + ": correct selected option");
        assert.ok(byId("listNamePreview").textContent.endsWith(previewSuffix(expected)), label + ": listing preview");
        assert.equal(syncWrites.length, writes, label + ": listing render is read-only");
        assert.equal(localWrites.length, localCount, label + ": listing render leaves local storage alone");
    }
    console.log(`PASS phase 11: getGalleries renders all ${formatCases.length} resolved list-format cases without saving defaults`);

    // Queue's paste workflow reaches the same reader in the built preview.js.
    byId("tabQueue").dispatchLast("click");
    await wait(20);
    const paste = nodes.get("nhdwBmPaste");
    assert.ok(paste);
    const descendants = (root) => [root, ...(root.children || []).flatMap(descendants)];
    const queueButton = descendants(byId("queuePane")).find((node) => node.tagName === "BUTTON" && node.textContent === "Download now");
    assert.ok(queueButton, "the real Queue Download now button exists");
    retryAnswer = { result: "started" };
    for (const { label, stored, expected } of formatCases) {
        installFormats(stored);
        const writes = syncWrites.length;
        const sent = sentMessages.length;
        paste.value = "111111,222222";
        queueButton.dispatchLast("click");
        await wait(20);
        const job = sentMessages.slice(sent).find((message) => message.action === "downloadAllDoujinshis");
        assert.ok(job, label + ": Queue dispatched a job");
        assert.equal(job.formatOverride, expected, label + ": Queue format");
        assert.equal(job.separate, true, "Queue never merges unrelated titles");
        assert.equal(job.tabId, 7, "normal/full panels keep the originating page");
        assert.deepEqual(Object.keys(job.allDoujinshis), ["111111", "222222"]);
        assert.equal(syncWrites.length, writes, label + ": starting Queue must not save format defaults");
    }
    console.log(`PASS phase 12: Queue dispatches all ${formatCases.length} stored/inherited/legacy formats through the shared reader`);

    if (fullPanel) {
        if (!nodes.has("psEmbeddedUi") || !byId("psEmbeddedUi").checked) {
            fail("Firefox full-panel Settings must show the enabled embedded toggle");
        }
        sourceTab.url = "https://nhentai.net/g/654321/";
        for (const listener of updatedListeners) listener(7, { url: sourceTab.url }, sourceTab);
        await wait(20);
        if (localStore.lastUrl !== sourceTab.url) {
            fail("a full panel must follow navigation in its inactive originating tab");
        }
        console.log("PASS: Full panel follows its inactive source tab's navigation");
    } else if (nodes.has("psEmbeddedUi")) {
        // createElement registers ids even for detached nodes in this stub;
        // test membership in Settings children rather than auto-vivified ids.
        const includesNode = (parent, target) => parent === target || (parent.children || []).some((child) => includesNode(child, target));
        if (includesNode(byId("settingsPane"), nodes.get("psEmbeddedUi"))) {
            fail("a Chrome-shaped build must not render embedded settings");
        }
    }
    console.log("PASS: popup message layer behaves correctly in a window-less context.");
    process.exit(0);
})();
