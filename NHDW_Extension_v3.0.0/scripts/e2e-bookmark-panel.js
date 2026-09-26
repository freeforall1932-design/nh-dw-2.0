// Queue-tab (bookmark panel) end-to-end harness.
//
// The panel lives in the preview bundle (js/preview.js) and is mounted into
// #queuePane when the Queue tab is opened. It holds three behaviours that unit
// tests cannot reach, because they are DOM wiring on top of the pure contract:
//
//   * item 43/44 row chrome: checkbox, drag handle, remove button, and the
//     dragstart -> dragover -> drop sequence that asks the WORKER to reorder.
//   * item 52 export: the anchor/blob the user saves, and the file it contains.
//   * item 52 import: validation, the two messages it sends (queue + history)
//     and the notice it shows - including every failure path.
//
// Everything runs against the built bundle in a window-less VM, so no browser
// is needed. Usage:  node scripts/e2e-bookmark-panel.js [path/to/js/preview.js]

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "preview.js");
const code = fs.readFileSync(bundlePath, "utf8");

function fail(msg) {
    console.error("FAIL: " + msg);
    process.exit(1);
}
function assertEqual(actual, expected, what) {
    if (actual !== expected) {
        fail(what + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
    }
}
function assertOk(value, what) {
    if (!value) {
        fail(what);
    }
}
function assertDeepEqual(actual, expected, what) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(what + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
    }
}

// --- minimal DOM -----------------------------------------------------------
// Two stub requirements beyond a naive fake, both of which the panel relies on:
//   * assigning textContent REPLACES the children (renderList clears the row
//     list that way, so without this every re-render would stack duplicates);
//   * assigning .id registers the node for getElementById (the backup buttons
//     are built with createElement and then found by id).
const nodes = new Map();

function makeNode(tag, id) {
    const node = {
        tagName: String(tag || "div").toUpperCase(),
        children: [],
        _classes: [],
        _listeners: {},
        _text: "",
        attributes: {},
        value: "",
        hidden: false,
        disabled: false,
        checked: false,
        files: null,
        type: "",
        title: "",
        href: "",
        download: "",
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
        setAttribute(k, v) { node.attributes[k] = String(v); if (k === "class") { node.className = String(v); } },
        getAttribute(k) { return node.attributes[k] === undefined ? null : node.attributes[k]; },
        appendChild(child) { node.children.push(child); child.parentElement = node; return child; },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i !== -1) node.children.splice(i, 1);
            return child;
        },
        remove() {
            if (node.parentElement) { node.parentElement.removeChild(node); }
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
            let prevented = false;
            for (const fn of (node._listeners[type] || []).slice()) {
                fn(Object.assign({
                    type: type,
                    target: node,
                    preventDefault() { prevented = true; },
                    stopPropagation() {}
                }, event || {}));
            }
            return prevented;
        },
        // Same reason as the popup harness: one node per id means a re-render
        // stacks listeners, so "the current button" is the last one wired.
        dispatchLast(type, event) {
            const list = (node._listeners[type] || []).slice();
            const fn = list[list.length - 1];
            if (fn) {
                fn(Object.assign({
                    type: type,
                    target: node,
                    preventDefault() {},
                    stopPropagation() {}
                }, event || {}));
            }
        },
        click() { return node.dispatch("click"); },
        focus() {},
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    Object.defineProperty(node, "className", {
        get() { return node._classes.join(" "); },
        set(value) {
            node._classes.length = 0;
            for (const part of String(value === undefined || value === null ? "" : value).split(/\s+/)) {
                if (part !== "" && !node._classes.includes(part)) node._classes.push(part);
            }
        },
        enumerable: true
    });
    Object.defineProperty(node, "textContent", {
        get() { return node._text; },
        set(value) {
            // Replacement, not append - and it drops the old child nodes.
            node._text = String(value === undefined || value === null ? "" : value);
            node.children.length = 0;
        },
        enumerable: true
    });
    let nodeId = "";
    Object.defineProperty(node, "id", {
        get() { return nodeId; },
        set(value) {
            nodeId = String(value);
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

// Row lookup by class, through the panel's own container.
function findRows(container) {
    return (container.children || []).filter((child) => child.classList && child.classList.contains("nhdwBmRow"));
}
function findOne(node, className) {
    return (node.children || []).find((child) => child.classList && child.classList.contains(className)) || null;
}
// Rows are a tree (the checkbox/handle are direct children, the download and
// remove buttons live inside a right-hand column), so the deep walk is what the
// phases use to prove a control exists.
function findDeep(node, className) {
    for (const child of node.children || []) {
        if (child.classList && child.classList.contains(className)) {
            return child;
        }
        const nested = findDeep(child, className);
        if (nested !== null) {
            return nested;
        }
    }
    return null;
}

// A leaf node addressed by the text it shows - the toolbar buttons have no ids.
function findByText(node, text) {
    for (const child of node.children || []) {
        if (child.textContent === text && (child.children || []).length === 0) {
            return child;
        }
        const nested = findByText(child, text);
        if (nested !== null) {
            return nested;
        }
    }
    return null;
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
const messageListeners = [];
const sentMessages = [];
let bookmarkState = { v: 1, collapsed: false, items: [] };
let history = {};
// null = every recorded file exists; a Set simulates deleted files.
let presentFiles = null;
// Every write the panel itself makes. It must never write storage directly:
// the worker is the single writer for the queue, and history goes through the
// historyImport action for the same reason.
const localWrites = [];
// Item 66: the sync store the panel's own preferences live in, plus every
// write, so a phase can assert what was remembered and where.
const syncStore = {};
const syncWrites = [];
const createdUrls = [];
const revokedUrls = [];
const clickedLinks = [];

function stateItem(id, site, extra) {
    return Object.assign({
        id: String(id),
        site: site || "nhentai",
        title: "Gallery " + id,
        thumbnail: "",
        pages: 10,
        selected: true,
        status: "saved",
        filename: "",
        error: "",
        addedAt: 1,
        source: "card",
        sourceUrl: ""
    }, extra || {});
}

const chromeStub = {
    runtime: {
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        sendMessage(msg, cb) {
            sentMessages.push(msg);
            if (!cb) return;
            const respond = (response) => cb(response);
            if (msg.action === "bookmarkGet") {
                respond({ result: "success", state: bookmarkState });
                return;
            }
            if (msg.action === "bookmarkReorder") {
                const items = bookmarkState.items.slice();
                const from = items.map((item) => item.id).indexOf(msg.id);
                const to = Math.max(0, Math.min(items.length - 1, Number(msg.toIndex)));
                if (from !== -1 && from !== to) {
                    const [moved] = items.splice(from, 1);
                    items.splice(to, 0, moved);
                }
                bookmarkState = { v: 1, collapsed: false, items: items };
                respond({ result: "success", state: bookmarkState });
                return;
            }
            if (msg.action === "bookmarkImport") {
                const known = bookmarkState.items.map((item) => item.id + "@" + item.site);
                const added = (msg.state.items || []).filter((item) => known.indexOf(item.id + "@" + item.site) === -1);
                bookmarkState = { v: 1, collapsed: false, items: bookmarkState.items.concat(added) };
                respond({ result: "success", state: bookmarkState });
                return;
            }
            if (msg.action === "historyPresent") {
                respond({ result: "success", ids: Object.keys(history).filter((id) =>
                    presentFiles === null || presentFiles.has(history[id].filename)) });
                return;
            }
            if (msg.action === "historyImport") {
                history = msg.history;
                respond({ result: "success", count: Object.keys(history).length });
                return;
            }
            if (msg.action === "downloadAllDoujinshis") {
                respond({ result: "started" });
                return;
            }
            if (msg.action === "bookmarkRemove" || msg.action === "bookmarkSelect" || msg.action === "bookmarkMarkDownloading") {
                respond({ result: "success", state: bookmarkState });
                return;
            }
            respond({ result: "success" });
        },
        lastError: null,
        getURL: (p) => p
    },
    storage: {
        sync: {
            // Item 66: the per-site filter preference lives here (like uiMode
            // and darkMode), so the stub records writes and replays them - that
            // is what proves "close the panel, reopen it, the filter is back".
            get(defaults, cb) { cb(Object.assign({}, defaults, syncStore)); },
            set(items, cb) { Object.assign(syncStore, items); syncWrites.push(Object.assign({}, items)); if (cb) cb(); },
            remove(key, cb) { delete syncStore[key]; if (cb) cb(); }
        },
        local: {
            get(defaults, cb) {
                // readListSettings + readHistory both come through here.
                const values = Object.assign({}, defaults);
                values.downloadHistory = history;
                cb(values);
            },
            set(items, cb) {
                localWrites.push(Object.assign({}, items));
                if (cb) cb();
            },
            remove(_key, cb) { if (cb) cb(); },
            clear(cb) { if (cb) cb(); }
        },
        session: { get(_k, cb) { cb({}); }, set(_i, cb) { if (cb) cb(); }, remove(_k, cb) { if (cb) cb(); } }
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

class BlobStub {
    constructor(parts, options) {
        this.parts = parts || [];
        this.type = options && options.type ? options.type : "";
        this.text = this.parts.join("");
    }
}

const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    document: documentStub,
    chrome: chromeStub,
    Blob: BlobStub,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    fetch: () => Promise.reject(new Error("no network in the panel harness")),
    confirm: () => false,
    alert: () => {},
    navigator: { userAgent: "panel-harness" },
    location: { href: "chrome-extension://harness/index.html" }
};
// URL.createObjectURL is what the export path uses; the harness records the
// blob so a phase can read the file that would have been saved.
sandbox.URL = Object.assign({}, URL, {
    createObjectURL(blob) {
        createdUrls.push(blob);
        return "blob:harness/" + createdUrls.length;
    },
    revokeObjectURL(url) { revokedUrls.push(url); }
});
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    try {
        vm.runInContext(code, sandbox, { filename: bundlePath });

        // ---- Phase 1: opening the Queue tab builds the chrome -----------------
        const queuePane = byId("queuePane");
        byId("tabQueue").dispatchLast("click");
        await wait(30);

        assertOk(nodes.get("nhdwBmList") !== undefined, "the Queue tab must build a row list (#nhdwBmList)");
        assertOk(nodes.get("nhdwBmExport") !== undefined, "the Queue tab must offer Export backup (item 52)");
        assertOk(nodes.get("nhdwBmImport") !== undefined, "the Queue tab must offer Import backup (item 52)");
        const importInput = nodes.get("nhdwBmImportFile");
        assertOk(importInput !== undefined, "the import button needs a hidden file input");
        assertEqual(importInput.type, "file", "the import picker must be a file input");
        assertEqual(importInput.accept, ".json,application/json", "the picker should filter to JSON files");
        assertEqual(importInput.style.display, "none", "the file input stays hidden behind its button");
        assertEqual(nodes.get("nhdwBmDownloadSelected") !== null, true, "the footer keeps Download selected");
        console.log("PASS phase 1: the Queue tab builds its rows, footer and backup controls (items 43/52)");

        // ---- Phase 2: rows render from the stored state -----------------------
        bookmarkState = {
            v: 1,
            collapsed: false,
            items: [
                stateItem("1"),
                stateItem("2", "hitomi", { selected: false, status: "done", filename: "two.cbz" }),
                stateItem("3", "hentaifox", { status: "downloading" })
            ]
        };
        history = { "nhentai:1": { filename: "one.cbz", when: 5 }, "hitomi:2": { filename: "two.cbz", when: 6 } };
        byId("tabQueue").dispatchLast("click");
        await wait(30);

        const list = byId("nhdwBmList");
        const rows = findRows(list);
        assertEqual(rows.length, 3, "three bookmarks must render three rows");
        assertEqual(rows.map((row) => row.classList.contains("nhdwBmStatus-done")).filter(Boolean).length, 1,
            "a row must carry its own status class so the CSS can colour it");
        assertEqual(rows[1].classList.contains("nhdwBmStatus-downloading"), false, "row 2 is done, not downloading");
        assertEqual(rows[2].classList.contains("nhdwBmStatus-downloading"), true, "row 3 is downloading");
        const select = findOne(rows[0], "nhdwBmSelect");
        assertOk(select !== null, "every row needs its selection checkbox");
        assertEqual(findOne(rows[0], "nhdwBmSelect").checked, true, "row 1 is selected");
        assertEqual(findOne(rows[1], "nhdwBmSelect").checked, false, "row 2 is not selected");
        const handle = findOne(rows[0], "nhdwBmDrag");
        assertOk(handle !== null, "every row needs its drag handle (item 44)");
        assertEqual(handle.getAttribute("draggable"), "true", "the handle must be the draggable element");
        assertEqual(rows[0].getAttribute("draggable"), null, "the row itself must not be draggable, or a click would start a drag");
        assertOk(findDeep(rows[0], "nhdwBmRemove") !== null, "every row keeps its remove button");
        assertEqual(findDeep(rows[0], "nhdwBmRemove").textContent, "\u00d7", "the remove button is the bare multiplication sign");
        // Row 1 and row 3 are selected, row 2 is not; only row 2 is done.
        assertEqual(byId("nhdwBmCounts").textContent, "3 bookmarked \u00b7 2 selected \u00b7 1 done",
            "the counts line must reflect the state");
        console.log("PASS phase 2: rows render checkbox, drag handle, remove button and status classes");

        // ---- Phase 3: drag-reorder asks the worker (item 44) ------------------
        const before = sentMessages.length;
        const movingHandle = findOne(findRows(byId("nhdwBmList"))[0], "nhdwBmDrag");
        // A real drag only fires dragover/drop when dragstart set transfer data
        // (Firefox refuses to start a drag with an empty transfer), so the
        // harness passes a dataTransfer and asserts the panel used it.
        const transfers = [];
        movingHandle.dispatch("dragstart", {
            dataTransfer: { setData(type, value) { transfers.push([type, value]); } }
        });
        assertEqual(transfers.length, 1, "dragstart must put data in the transfer for Firefox");
        assertEqual(transfers[0][0], "text/plain", "the transfer carries text/plain, the only type every engine accepts");
        assertEqual(transfers[0][1], "1", "the transfer carries the dragged row's id");
        assertEqual(findRows(byId("nhdwBmList"))[0].classList.contains("nhdwBmDragging"), true,
            "the dragged row must be marked while the drag is live");

        const targetRow = findRows(byId("nhdwBmList"))[2];
        targetRow.dispatch("dragover");
        assertEqual(targetRow.classList.contains("nhdwBmDropTarget"), true, "a valid drop target must be highlighted");
        const prevented = targetRow.dispatch("drop");
        assertEqual(prevented, true, "drop must call preventDefault, or the browser cancels it");
        await wait(30);

        const reorder = sentMessages.slice(before).find((msg) => msg.action === "bookmarkReorder");
        assertOk(reorder !== undefined, "dropping a row must ask the worker to reorder it");
        assertEqual(reorder.id, "1", "the message names the dragged row");
        assertEqual(reorder.toIndex, 2, "the message names the row it was dropped on");
        assertEqual(findRows(byId("nhdwBmList")).length, 3, "the list is still three rows");
        assertEqual(byId("nhdwBmList").children.length, 3, "the list re-renders from the worker's answer, not by hand");
        assertEqual(bookmarkState.items.map((item) => item.id).join(","), "2,3,1", "the worker applied the move");
        console.log("PASS phase 3: dragstart/dragover/drop reorder through the worker (item 44)");

        // A drag that ends somewhere invalid must not send anything.
        const beforeCancel = sentMessages.length;
        const handle2 = findOne(findRows(byId("nhdwBmList"))[0], "nhdwBmDrag");
        handle2.dispatch("dragstart", { dataTransfer: { setData() {} } });
        findRows(byId("nhdwBmList"))[1].dispatch("dragleave");
        assertEqual(findRows(byId("nhdwBmList"))[1].classList.contains("nhdwBmDropTarget"), false,
            "dragging off a row must clear the highlight");
        handle2.dispatch("dragend");
        assertEqual(sentMessages.slice(beforeCancel).filter((msg) => msg.action === "bookmarkReorder").length, 0,
            "an abandoned drag must not reorder anything");
        console.log("PASS phase 3b: dragleave/dragend leave the queue untouched");

        // ---- Phase 4: export writes one readable file (item 52) ---------------
        createdUrls.length = 0;
        byId("tabQueue").dispatchLast("click");
        await wait(30);
        byId("nhdwBmExport").dispatchLast("click");
        await wait(30);
        assertEqual(createdUrls.length, 1, "Export must hand the browser exactly one blob");
        const file = JSON.parse(createdUrls[0].text);
        assertEqual(file.app, "nh-downloader-transfer", "the file names the app that wrote it");
        assertEqual(file.version, 1, "the file carries a format version");
        assertEqual(file.bookmarks.items.length, 3, "every queued bookmark is in the file");
        assertEqual(Object.keys(file.history).length, 2, "the download history is in the same file");
        assertEqual(file.history["nhentai:1"].filename, "one.cbz", "history keeps its recorded file name");
        assertOk(/^nh-downloader-backup-\d{4}-\d{2}-\d{2}\.json$/.test(nodes.get("nhdwBmExport").title) === false,
            "the export button's title explains the action, not the file name");
        const notice = byId("nhdwBmNotice");
        assertEqual(notice.textContent, "Exported 3 bookmarks and 2 history records.",
            "the user is told what was written");
        // readListSettings seeds its defaults into storage.local on first read;
        // what matters is that the export never writes the QUEUE or HISTORY.
        const backupKeys = localWrites.map((write) => Object.keys(write).join(","));
        assertOk(backupKeys.every((keys) => keys.indexOf("bookmarkQueue") === -1 && keys.indexOf("downloadHistory") === -1),
            "export must not write the queue or the history, wrote " + JSON.stringify(backupKeys));
        console.log("PASS phase 4: Export writes a self-describing JSON file with both stores (item 52)");

        // ---- Phase 5: import merges, and never deletes ------------------------
        const beforeImport = sentMessages.length;
        const incoming = {
            app: "nh-downloader-transfer",
            version: 1,
            bookmarks: {
                v: 1,
                collapsed: false,
                items: [
                    stateItem("1"),                                                          // already here: local wins
                    stateItem("9", "hentaienvy", { title: "New from the file" })             // brand new
                ]
            },
            history: {
                "nhentai:1": { filename: "theirs.cbz", when: 99 },                        // local wins
                "hentaienvy:9": { filename: "nine.cbz", when: 7 }                         // new
            }
        };
        const input = byId("nhdwBmImportFile");
        input.files = [{ name: "backup.json", text: async () => JSON.stringify(incoming) }];
        input.dispatch("change");
        await wait(40);

        const importMessage = sentMessages.slice(beforeImport).find((msg) => msg.action === "bookmarkImport");
        assertOk(importMessage !== undefined, "importing must send the queue to the worker (single writer)");
        assertEqual(importMessage.state.items.length, 2, "the file's rows are normalized before they are sent");
        const historyMessage = sentMessages.slice(beforeImport).find((msg) => msg.action === "historyImport");
        assertOk(historyMessage !== undefined, "importing must also land the merged history");
        assertEqual(historyMessage.history["nhentai:1"].filename, "one.cbz",
            "the local history record wins - only this machine knows the file is here");
        assertEqual(historyMessage.history["hentaienvy:9"].filename, "nine.cbz", "new history rows are added");
        assertEqual(Object.keys(historyMessage.history).length, 3, "nothing in the local history is dropped");
        assertEqual(findRows(byId("nhdwBmList")).length, 4, "the list repaints from the worker's answer");
        assertEqual(notice.textContent, "Import done: added 1 bookmark and 1 history record. Rows already here were kept unchanged.",
            "the notice reports what actually changed");
        const importKeys = localWrites.map((write) => Object.keys(write).join(","));
        assertOk(importKeys.every((keys) => keys.indexOf("bookmarkQueue") === -1 && keys.indexOf("downloadHistory") === -1),
            "the panel must route the queue and the history through the worker, wrote " + JSON.stringify(importKeys));
        assertEqual(input.value, "", "the picker is reset so the same file can be chosen again");
        console.log("PASS phase 5: import merges through the worker and reports what it added (item 52)");

        // A re-import of the same file must be a no-op, not a rewrite.
        const beforeAgain = sentMessages.length;
        byId("nhdwBmImportFile").files = [{ name: "backup.json", text: async () => JSON.stringify(incoming) }];
        byId("nhdwBmImportFile").dispatch("change");
        await wait(40);
        assertOk(sentMessages.slice(beforeAgain).find((msg) => msg.action === "bookmarkImport") !== undefined,
            "a re-import still goes to the worker (it is idempotent there, not skipped here)");
        assertEqual(sentMessages.slice(beforeAgain).filter((msg) => msg.action === "historyImport").length, 0,
            "a re-import adds no history rows, so it must not rewrite the history");
        assertEqual(byId("nhdwBmList").children.length, 4, "the queue length is unchanged");
        console.log("PASS phase 5b: re-importing the same file changes nothing");

        // ---- Phase 6: bad files are refused with a reason --------------------
        const cases = [
            ["", "empty"],
            ["not json at all", "unparseable"],
            [JSON.stringify([1, 2, 3]), "an array"],
            [JSON.stringify({ app: "another-extension", bookmarks: incoming.bookmarks }), "someone else's file"],
            [JSON.stringify({ app: "nh-downloader-transfer", version: 99, bookmarks: incoming.bookmarks }), "a newer format"],
            [JSON.stringify({ app: "nh-downloader-transfer", version: 1, bookmarks: { v: 1, items: [] } }), "an empty backup"]
        ];
        for (const [text, what] of cases) {
            const beforeBad = sentMessages.length;
            byId("nhdwBmImportFile").files = [{ name: "bad.json", text: async () => text }];
            byId("nhdwBmImportFile").dispatch("change");
            await wait(30);
            assertOk(/^Import failed: /.test(byId("nhdwBmNotice").textContent),
                what + " must be refused with a reason, got \"" + byId("nhdwBmNotice").textContent + "\"");
            assertEqual(sentMessages.slice(beforeBad).filter((msg) => msg.action === "bookmarkImport").length, 0,
                what + " must not reach the worker");
            assertEqual(byId("nhdwBmList").children.length, 4, what + " must leave the queue alone");
        }
        console.log("PASS phase 6: unreadable or foreign files are refused with a reason, and nothing changes");

        // ---- Phase 7: Download selected splits the queue per site (item 48) ---
        // One job per site, because a job payload carries a single site: the
        // pipeline composes every store key with it. The ids inside a job stay
        // bare, so file names and `{id}` tokens keep the gallery number.
        bookmarkState = {
            v: 1,
            collapsed: false,
            items: [
                stateItem("700", "nhentai", { title: "Nhentai seven hundred" }),
                stateItem("700", "hitomi", { title: "Hitomi seven hundred" }),
                stateItem("800", "nhentai", { title: "Nhentai eight hundred" }),
                stateItem("900", "hitomi", { title: "", selected: false })
            ]
        };
        history = {};
        byId("tabQueue").dispatchLast("click");
        await wait(30);
        const beforeJobs = sentMessages.length;
        byId("nhdwBmDownloadSelected").dispatchLast("click");
        await wait(60);

        const mark = sentMessages.slice(beforeJobs).find((msg) => msg.action === "bookmarkMarkDownloading");
        assertOk(mark !== undefined, "starting a queue download must mark the rows as downloading");
        assertOk(mark.ids.indexOf("nhentai:700") !== -1 && mark.ids.indexOf("hitomi:700") !== -1,
            "the rows are addressed by composite key, so two sites cannot shadow each other: " + JSON.stringify(mark.ids));
        assertOk(mark.ids.indexOf("hitomi:900") === -1, "an unselected row is not marked as downloading");

        const jobs = sentMessages.slice(beforeJobs).filter((msg) => msg.action === "downloadAllDoujinshis");
        assertEqual(jobs.length, 2, "a two-site selection becomes two jobs, one per site");
        assertEqual(jobs[0].site, undefined,
            "the default site is never written, so an all-nhentai queue sends exactly what it always did");
        assertEqual(jobs[1].site, "hitomi", "the second job names its site");
        assertDeepEqual(Object.keys(jobs[0].allDoujinshis), ["700", "800"],
            "a job's payload is keyed by the BARE id (that is what the file name and {id} token read)");
        assertDeepEqual(Object.keys(jobs[1].allDoujinshis), ["700"],
            "only the hitomi row that is actually selected is in the hitomi job");
        assertEqual(jobs[1].allDoujinshis["700"], "Hitomi seven hundred", "the titles travel with their ids");
        assertEqual(jobs[0].separate, true, "the Queue tab always downloads one file per title");
        assertOk(/across 2 sites/.test(byId("nhdwBmNotice").textContent),
            "the notice says the selection spans two sites, got \"" + byId("nhdwBmNotice").textContent + "\"");
        console.log("PASS phase 7: Download selected sends one per-site job, keys bare and stores composite (item 48)");

        // The history guard is per site too: a recorded nhentai id must not
        // hold back the same-numbered hitomi row (and vice versa).
        history = { "nhentai:700": { filename: "already.cbz", when: 5 } };
        bookmarkState = {
            v: 1,
            collapsed: false,
            items: [
                stateItem("700", "nhentai", { title: "Already here" }),
                stateItem("700", "hitomi", { title: "Still wanted" })
            ]
        };
        byId("tabQueue").dispatchLast("click");
        await wait(30);
        const beforeSkip = sentMessages.length;
        byId("nhdwBmDownloadSelected").dispatchLast("click");
        await wait(60);
        const skipJobs = sentMessages.slice(beforeSkip).filter((msg) => msg.action === "downloadAllDoujinshis");
        assertEqual(skipJobs.length, 1, "the recorded nhentai row is skipped, so only the hitomi job is sent");
        assertEqual(skipJobs[0].site, "hitomi", "and it is the hitomi job that survives");
        assertDeepEqual(Object.keys(skipJobs[0].allDoujinshis), ["700"]);
        assertOk(/already downloaded skipped/.test(byId("nhdwBmNotice").textContent),
            "the user is told something was skipped, got \"" + byId("nhdwBmNotice").textContent + "\"");
        console.log("PASS phase 7b: the history guard is per site, never cross-site (item 48)");

        // A single row's own Download button is the third entry point into the
        // pipeline (the other two are Download selected and the paste box), so
        // it must carry its row's site too - otherwise a hitomi row would be
        // fetched from nhentai by id.
        history = {};
        bookmarkState = {
            v: 1,
            collapsed: false,
            items: [stateItem("700", "hitomi", { title: "Hitomi row download" })]
        };
        byId("tabQueue").dispatchLast("click");
        await wait(30);
        const beforeOne = sentMessages.length;
        const rowOne = findRows(byId("nhdwBmList"))[0];
        const oneButton = rowOne === undefined ? null : findDeep(rowOne, "nhdwBmDownload");
        assertOk(oneButton !== null, "every row keeps its own Download button");
        oneButton.dispatchLast("click");
        await wait(60);
        const oneJobs = sentMessages.slice(beforeOne).filter((msg) => msg.action === "downloadAllDoujinshis");
        assertEqual(oneJobs.length, 1, "a row's Download button starts exactly one job");
        assertEqual(oneJobs[0].site, "hitomi", "the row's Download button carries its own site");
        assertDeepEqual(Object.keys(oneJobs[0].allDoujinshis), ["700"],
            "the row's job is keyed by the bare id, not the composite key");
        assertDeepEqual(oneJobs[0].redownloadIds, undefined,
            "a row that is not recorded in the history is not force-redownloaded");
        console.log("PASS phase 7c: a row's own Download button carries its site and a bare id (item 48)");

        // ---- Phase 7d: a downloading row offers Cancel, not Download (item 45) ----
        // The row-level cancel is the panel half of item 45: while a row is
        // "downloading" its Download button is replaced by a red Cancel that
        // sends cancelGallery with the row's OWN site (composite identity -
        // cancelling hitomi:800 must never touch nhentai:800), and it disables
        // at once so a double click cannot fire two cancels.
        history = {};
        bookmarkState = {
            v: 1,
            collapsed: false,
            items: [
                stateItem("800", "hitomi", { status: "downloading", title: "Cancel me" }),
                stateItem("801", "nhentai", { title: "Idle row" })
            ]
        };
        byId("tabQueue").dispatchLast("click");
        await wait(30);
        const cancelPhaseRows = findRows(byId("nhdwBmList"));
        assertEqual(cancelPhaseRows.length, 2, "both rows render");
        const rowCancelButton = findDeep(cancelPhaseRows[0], "nhdwBmCancel");
        assertOk(rowCancelButton !== null, "a downloading row renders a Cancel button (item 45)");
        assertEqual(rowCancelButton.textContent, "Cancel", "the button says Cancel");
        assertEqual(findDeep(cancelPhaseRows[0], "nhdwBmDownload"), null,
            "a downloading row swaps Download for Cancel, it never shows both");
        assertOk(findDeep(cancelPhaseRows[1], "nhdwBmDownload") !== null,
            "a row that is not downloading keeps its Download button");
        assertEqual(findDeep(cancelPhaseRows[1], "nhdwBmCancel"), null,
            "a row that is not downloading has no Cancel button");
        const beforeCancelClick = sentMessages.length;
        rowCancelButton.dispatchLast("click");
        assertEqual(rowCancelButton.disabled, true,
            "Cancel disables at once so a double click cannot fire twice");
        await wait(30);
        const cancelMsgs = sentMessages.slice(beforeCancelClick).filter((msg) => msg.action === "cancelGallery");
        assertEqual(cancelMsgs.length, 1, "clicking Cancel sends exactly one cancelGallery message");
        assertEqual(cancelMsgs[0].id, "800", "the cancel names the bare row id");
        assertEqual(cancelMsgs[0].site, "hitomi", "the cancel carries the row's own site");
        console.log("PASS phase 7d: a downloading row cancels per row, carrying its site (item 45)");

        // ---- Phase 8: per-site filter (item 66) ------------------------------
        // The dropdown is permanent, its options carry live counts, the chosen
        // site is remembered in chrome.storage.sync (never in the worker-owned
        // local store), and while a filter is on, Select all touches only the
        // visible rows - each by its composite key, so a same-numbered gallery
        // on another site can never be selected by accident.
        syncStore.bookmarkSiteFilter = "hentaifox";
        history = {};
        bookmarkState = {
            v: 1,
            collapsed: false,
            items: [
                stateItem("1"),
                stateItem("2", "hitomi", { selected: false }),
                stateItem("3"),
                stateItem("4", "hentaifox")
            ]
        };
        byId("tabQueue").dispatchLast("click");
        await wait(30);

        assertOk(nodes.get("nhdwBmSiteFilter") !== undefined, "the list header needs the per-site filter (item 66)");
        const filterSelect = nodes.get("nhdwBmSiteFilter");
        assertEqual(filterSelect.tagName, "SELECT", "the filter is a <select>");
        const optionValues = (filterSelect.children || []).map((option) => option.value);
        assertDeepEqual(optionValues, ["all", "nhentai", "hitomi", "hentaiera", "imhentai", "hentaienvy", "hentaifox"],
            "the options are All sites plus the six known sites, in one canonical order");
        const optionLabels = (filterSelect.children || []).map((option) => option.textContent);
        assertEqual(optionLabels[0], "All sites (4)", "the All sites option carries the total count");
        assertEqual(optionLabels[1], "nhentai (2)", "a site with rows carries its own count");
        assertEqual(optionLabels[4], "imhentai", "a site with no rows is still offered, without a count");
        // The stub had the preference stored BEFORE this render, so restoring it
        // is the storage path, not a leftover module variable.
        assertEqual(filterSelect.value, "hentaifox", "the remembered site filter is restored on reopen");
        assertEqual(findRows(byId("nhdwBmList")).length, 1, "only the filtered site's rows render");
        assertEqual(byId("nhdwBmFilterInfo").textContent, "showing 1 of 4",
            "the filter line says how much of the list is visible");
        console.log("PASS phase 8a: the per-site filter renders, counts and restores the remembered choice (item 66)");

        filterSelect.value = "hitomi";
        filterSelect.dispatch("change");
        await wait(30);
        assertEqual(syncStore.bookmarkSiteFilter, "hitomi", "choosing a site stores the preference in sync storage");
        assertEqual(syncWrites[syncWrites.length - 1].bookmarkSiteFilter, "hitomi", "the write carries the chosen site");
        assertEqual(localWrites.some((write) => "bookmarkSiteFilter" in write), false,
            "the preference must never enter the worker-owned local store");
        const filteredRows = findRows(byId("nhdwBmList"));
        assertEqual(filteredRows.length, 1, "switching the filter re-renders only that site's rows");
        assertEqual(findOne(filteredRows[0], "nhdwBmSelect").checked, false, "the hitomi row is the one on screen");
        assertEqual(byId("nhdwBmCounts").textContent, "4 bookmarked \u00b7 3 selected \u00b7 0 done",
            "the counts line keeps reporting the whole list, not the visible slice");
        console.log("PASS phase 8b: choosing a site filters the rows and remembers the choice (item 66)");

        const beforeSelectAll = sentMessages.length;
        const selectAllButton = findByText(byId("queuePane"), "Select all");
        assertOk(selectAllButton !== null, "the toolbar keeps Select all");
        selectAllButton.dispatchLast("click");
        await wait(30);
        const selectAllMsgs = sentMessages.slice(beforeSelectAll).filter((msg) => msg.action === "bookmarkSelect");
        assertEqual(selectAllMsgs.length, 1, "Select all sends one bookmarkSelect message");
        assertDeepEqual(selectAllMsgs[0].ids, ["hitomi:2"],
            "with a filter on, Select all names only the visible rows, by composite key");
        assertEqual(selectAllMsgs[0].all, undefined, "and it does not fall back to the whole-list form");
        console.log("PASS phase 8c: Select all respects the filter and sends composite keys (item 66)");

        filterSelect.value = "imhentai";
        filterSelect.dispatch("change");
        await wait(30);
        assertEqual(findRows(byId("nhdwBmList")).length, 0, "a site with no rows renders no rows");
        assertOk(findDeep(byId("nhdwBmList"), "nhdwBmEmpty") !== null,
            "a filtered-empty list explains itself instead of showing a blank box");
        filterSelect.value = "all";
        filterSelect.dispatch("change");
        await wait(30);
        assertEqual(findRows(byId("nhdwBmList")).length, 4, "All sites brings the whole list back");
        assertEqual(byId("nhdwBmFilterInfo").textContent, "", "the filter line disappears when nothing is filtered");
        const beforeSelectNone = sentMessages.length;
        const selectNoneButton = findByText(byId("queuePane"), "Select none");
        assertOk(selectNoneButton !== null, "the toolbar keeps Select none");
        selectNoneButton.dispatchLast("click");
        await wait(30);
        const selectNoneMsgs = sentMessages.slice(beforeSelectNone).filter((msg) => msg.action === "bookmarkSelect");
        assertEqual(selectNoneMsgs.length, 1, "Select none sends one bookmarkSelect message");
        assertEqual(selectNoneMsgs[0].all, true,
            "with no filter, Select none keeps the unchanged whole-list message");
        assertEqual(selectNoneMsgs[0].selected, false, "and clears the selection");
        console.log("PASS phase 8d: an empty site explains itself, and All sites restores the whole list (item 66)");

        // ---- Phase 9: search, filters and windowed rendering (item 68) ---------
    // The Bookmark tab is a working set: "find the ones I mean" has to work
    // BEFORE a batch runs. These phases drive the real controls (typing in the
    // search box, picking a status/date) and assert what the panel does with
    // the storage the worker would have written.
    syncStore.bookmarkSiteFilter = "all";
    history = { "nhentai:2": { filename: "NHDW/Dark Room.zip", when: 1700000000000 } };
    bookmarkState = {
        v: 1,
        collapsed: false,
        items: [
            stateItem("1", "nhentai", { title: "Milky Way", addedAt: 1, selected: true }),
            stateItem("2", "nhentai", { title: "Dark Room", addedAt: 1, status: "done", selected: false }),
            stateItem("3", "hitomi", { title: "Milky Night", addedAt: 1, status: "failed", selected: true }),
            stateItem("4", "nhentai", { title: "Milky Done", addedAt: Date.now(), status: "done", selected: false })
        ]
    };
    byId("tabQueue").dispatchLast("click");
    await wait(50);

    const searchBox = byId("nhdwBmSearch");
    assertOk(searchBox !== undefined && searchBox.tagName === "INPUT", "the list needs a search box (item 68)");
    assertOk(nodes.has("nhdwBmStatusFilter") && nodes.get("nhdwBmStatusFilter").tagName === "SELECT",
        "the list needs a status filter (item 68)");
    assertOk(nodes.has("nhdwBmDateFilter") && nodes.get("nhdwBmDateFilter").tagName === "SELECT",
        "the list needs a date filter (item 68)");
    assertEqual(findRows(byId("nhdwBmList")).length, 4, "with no query the whole list renders");

    searchBox.value = "milky";
    searchBox.dispatch("input");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 3, "the search narrows the rendered rows");
    assertEqual(byId("nhdwBmFilterInfo").textContent, "showing 3 of 4",
        "the filter line says how much of the list the query shows");
    // The owner's rule: a green check means the file is really on disk. Row 4
    // SAYS done but history has no record for it, so it must stay unmarked -
    // while row 2, which history records, carries the mark with its filename.
    const milkyRows = findRows(byId("nhdwBmList"));
    const doneRow = milkyRows.filter((row) => findDeep(row, "nhdwBmTitle").textContent === "Milky Done")[0];
    assertOk(doneRow !== undefined, "the searched rows carry their stored titles");
    // A DOM node can never be JSON.stringify'd, so this asserts the boolean:
    // a failed run must print a readable message, not a circular-structure
    // TypeError that hides which rule broke.
    assertOk(findDeep(doneRow, "nhdwBmAlready") === null,
        "a row that merely says done must not carry the downloaded mark (item 68)");
    searchBox.value = "dark";
    searchBox.dispatch("input");
    await wait(30);
    const markedRow = findRows(byId("nhdwBmList"))[0];
    const historyMark = findDeep(markedRow, "nhdwBmAlready");
    assertOk(historyMark !== null, "a title history records carries the downloaded mark (item 68)");
    assertOk(String(historyMark.title).indexOf("Dark Room.zip") !== -1,
        "the mark names the artifact behind it, got " + JSON.stringify(historyMark.title));
    assertEqual(byId("nhdwBmHistoryInfo").textContent, "1 already downloaded",
        "the header counts what the current query already has on disk");
    console.log("PASS phase 9a: search narrows the list and the downloaded mark follows history, not row status (item 68)");

    // Status and date compose with each other and with the search; the counts
    // line keeps reporting the WHOLE list, because the query is a view.
    searchBox.value = "";
    searchBox.dispatch("input");
    const statusSelect = nodes.get("nhdwBmStatusFilter");
    statusSelect.value = "done";
    statusSelect.dispatch("change");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 2, "the status filter shows only the done rows");
    statusSelect.value = "selected";
    statusSelect.dispatch("change");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 2, "the selected-only view shows the ticked rows");
    statusSelect.value = "all";
    statusSelect.dispatch("change");
    const dateSelect = nodes.get("nhdwBmDateFilter");
    dateSelect.value = "older";
    dateSelect.dispatch("change");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 3, "the older bucket drops the row added today");
    assertEqual(byId("nhdwBmCounts").textContent, "4 bookmarked \u00b7 2 selected \u00b7 2 done",
        "the counts line keeps reporting the whole list while a query is active");
    assertEqual(byId("nhdwBmHistoryInfo").textContent, "1 already downloaded",
        "the history count follows the query");
    dateSelect.value = "all";
    dateSelect.dispatch("change");
    await wait(30);
    assertEqual(byId("nhdwBmFilterInfo").textContent, "", "the filter line disappears when nothing is filtered");
    assertEqual(byId("nhdwBmHistoryInfo").textContent, "1 already downloaded",
        "the history count stays for the whole list");
    console.log("PASS phase 9b: status and date filters compose, and the counts stay whole-list (item 68)");

    // Windowed rendering: a big list renders a bounded chunk with a "Show more"
    // control instead of thousands of rows, and the window resets when the
    // query changes (so a search cannot be hidden behind a stale window).
    syncStore.bookmarkSiteFilter = "all";
    const manyItems = [];
    for (let i = 1; i <= 250; i++) {
        manyItems.push(stateItem(String(i), "nhentai", { title: "Bulk " + i, addedAt: 1 }));
    }
    bookmarkState = { v: 1, collapsed: false, items: manyItems };
    byId("tabQueue").dispatchLast("click");
    await wait(50);
    assertEqual(findRows(byId("nhdwBmList")).length, 200, "a 250-row list renders one bounded chunk");
    const moreButton = findDeep(byId("nhdwBmList"), "nhdwBmMore");
    assertOk(moreButton !== null, "the window offers a way to show more (item 68)");
    assertEqual(moreButton.textContent, "Show more (200 of 250)", "the control says how much is on screen");
    moreButton.dispatchLast("click");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 250, "Show more grows the window to the end");
    assertOk(findDeep(byId("nhdwBmList"), "nhdwBmMore") === null,
        "the control goes away at the end of the list (item 68)");
    // A query re-windows from the top: one term that every title carries still
    // renders the bounded chunk (not the 250 the user had grown to), and the
    // control says so. Every term must match, so "bulk 250" is exactly one row.
    searchBox.value = "bulk";
    searchBox.dispatch("input");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 200, "the query re-windows from the top");
    assertEqual(findDeep(byId("nhdwBmList"), "nhdwBmMore").textContent, "Show more (200 of 250)",
        "the re-windowed list says how much is on screen");
    searchBox.value = "bulk 250";
    searchBox.dispatch("input");
    await wait(30);
    assertEqual(findRows(byId("nhdwBmList")).length, 1, "every search term must match, so this is one row");
    console.log("PASS phase 9c: the list renders a bounded window and grows on demand (item 68)");

    // Select all honours the query: only the matching rows may be ticked, and
    // they travel as composite keys so a same-numbered gallery elsewhere is
    // never touched. With no query the whole-list form is unchanged.
    bookmarkState = {
        v: 1,
        collapsed: false,
        items: [
            stateItem("1", "nhentai", { title: "Milky Way" }),
            stateItem("2", "nhentai", { title: "Dark Room" }),
            stateItem("3", "hitomi", { title: "Milky Night" }),
            stateItem("4", "nhentai", { title: "Milky Done" })
        ]
    };
    searchBox.value = "";
    searchBox.dispatch("input");
    byId("tabQueue").dispatchLast("click");
    await wait(50);
    searchBox.value = "milky";
    searchBox.dispatch("input");
    await wait(30);
    const beforeQuerySelect = sentMessages.length;
    findByText(byId("queuePane"), "Select all").dispatchLast("click");
    await wait(30);
    const querySelect = sentMessages.slice(beforeQuerySelect).filter((msg) => msg.action === "bookmarkSelect");
    assertEqual(querySelect.length, 1, "Select all sends one bookmarkSelect message");
    assertDeepEqual(querySelect[0].ids, ["nhentai:1", "hitomi:3", "nhentai:4"],
        "a searched Select all names only the matching rows, by composite key");
    assertEqual(querySelect[0].all, undefined, "and it does not fall back to the whole-list form");
    searchBox.value = "";
    searchBox.dispatch("input");
    await wait(30);
    const beforeWholeSelect = sentMessages.length;
    findByText(byId("queuePane"), "Select all").dispatchLast("click");
    await wait(30);
    const wholeSelect = sentMessages.slice(beforeWholeSelect).filter((msg) => msg.action === "bookmarkSelect");
    assertEqual(wholeSelect.length, 1, "Select all still sends one message with no query");
    assertEqual(wholeSelect[0].all, true, "and keeps the unchanged whole-list form");
    console.log("PASS phase 9d: Select all follows the search and sends composite keys (item 68)");

    // Item 68 review: a stored history record is not evidence that the file
    // still exists. Reopening after deletion must NOT claim "on disk", and
    // must not destroy the record (export/history are separate concerns).
    bookmarkState = { v: 1, collapsed: false, items: [stateItem("91"), stateItem("92")] };
    history = {
        "nhentai:91": { filename: "keep.cbz", when: 1 },
        "nhentai:92": { filename: "deleted.cbz", when: 2 }
    };
    presentFiles = new Set(["keep.cbz"]);
    searchBox.value = "";
    searchBox.dispatch("input");
    const beforeVerify = sentMessages.length;
    byId("tabQueue").dispatchLast("click");
    await wait(50);
    const verifiedRows = findRows(byId("nhdwBmList"));
    assertOk(sentMessages.slice(beforeVerify).some((msg) => msg.action === "historyPresent"),
        "opening Bookmark must ask the worker to verify files, not trust the stored record");
    assertOk(findDeep(verifiedRows[0], "nhdwBmAlready") !== null, "present file keeps its check");
    assertOk(findDeep(verifiedRows[1], "nhdwBmAlready") === null, "deleted file loses its check");
    assertEqual(byId("nhdwBmHistoryInfo").textContent, "1 already downloaded",
        "downloaded count also tracks verified files, not recorded files");
    assertEqual(Object.keys(history).length, 2, "display verification must not erase history records");
    console.log("PASS phase 9e: deleted file loses its mark on reopen; history stays intact (item 68)");

    console.log("PASS: the Queue tab's rows, drag-reorder, backup and per-site downloads behave correctly in a window-less context.");
    } catch (error) {
        fail(error && error.stack ? error.stack : String(error));
    }
})();
