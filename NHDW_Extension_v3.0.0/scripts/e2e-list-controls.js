// In-page listing card controls test: load the built js/listControls.js in a
// window-less VM with a DOM stub that mirrors nhentai's card markup and verify
//   - a Download button and a Select box are injected on every gallery card
//   - injection is idempotent (a second pass adds nothing) and picks up cards
//     added later by infinite scroll / pagination through the MutationObserver
//   - selecting a card writes the shared chrome.storage.local "allIds" list the
//     panel reads, and the floating action bar tracks the count
//   - the per-card Download button sends downloadAllDoujinshis with the shared
//     format registry values (format, separate, template, master folder)
//   - "raw" disables the merge option (no container to merge into)
//   - a multi-title batch PDF asks for confirmation and falls back to separate
//     files when the user declines (never a silent tankoubon merge)
//   - the whole script is a no-op when the user turns the controls off
//
// Usage:  node scripts/e2e-list-controls.js [path/to/js/listControls.js]
// Exit code 0 = all checks passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "listControls.js");
const code = fs.readFileSync(bundlePath, "utf8");

function fail(message) {
    console.error("FAIL: " + message);
    process.exit(1);
}

// --- minimal DOM ----------------------------------------------------------

function makeClassList(node) {
    return {
        add(name) { if (!node._classes.includes(name)) node._classes.push(name); },
        remove(name) {
            const i = node._classes.indexOf(name);
            if (i !== -1) node._classes.splice(i, 1);
        },
        contains(name) { return node._classes.includes(name); },
        toggle(name, force) {
            const on = force === undefined ? !node._classes.includes(name) : !!force;
            if (on) this.add(name); else this.remove(name);
            return on;
        }
    };
}

function makeEl(tag, attrs) {
    const node = {
        tag: tag,
        children: [],
        attrs: Object.assign({}, attrs),
        _classes: [],
        _listeners: {},
        parentElement: null,
        id: "",
        type: "",
        title: "",
        value: "",
        textContent: "",
        innerHTML: "",
        checked: false,
        disabled: false,
        hidden: false,
        selected: false,
        style: {},
        get className() { return node._classes.join(" "); },
        set className(value) { node._classes = String(value).split(/\s+/).filter(Boolean); },
        appendChild(child) {
            child.parentElement = node;
            node.children.push(child);
            if (node._onMutate) node._onMutate();
            let ancestor = node.parentElement;
            while (ancestor) {
                if (ancestor._onMutate) ancestor._onMutate();
                ancestor = ancestor.parentElement;
            }
            return child;
        },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i === -1) throw new Error("removeChild: not a child");
            node.children.splice(i, 1);
            child.parentElement = null;
            return child;
        },
        setAttribute(name, value) { node.attrs[name] = String(value); },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
        },
        addEventListener(type, fn) {
            (node._listeners[type] = node._listeners[type] || []).push(fn);
        },
        dispatch(type, event) {
            const handlers = node._listeners[type] || [];
            const ev = Object.assign({
                preventDefault() {},
                stopPropagation() {},
                target: node
            }, event);
            for (const fn of handlers.slice()) fn(ev);
        },
        querySelector(selector) {
            const found = queryAll(node, selector);
            return found.length > 0 ? found[0] : null;
        },
        querySelectorAll(selector) {
            const found = queryAll(node, selector);
            found.forEach = Array.prototype.forEach.bind(found);
            return found;
        }
    };
    node.classList = makeClassList(node);
    return node;
}

// Selector support limited to what the bundle actually uses:
// ".class", "tag[attr*=value]", 'input[type="checkbox"]' and descendant chains.
function matchesSimple(node, simple) {
    const attrMatch = /^([a-z]*)\[([a-z-]+)(\*?=)"?([^"\]]*)"?\]$/i.exec(simple);
    if (attrMatch) {
        const [, tag, attr, op, value] = attrMatch;
        if (tag && node.tag !== tag) return false;
        const actual = node.getAttribute(attr) !== null ? node.getAttribute(attr) : node[attr];
        if (actual === undefined || actual === null) return false;
        return op === "*=" ? String(actual).includes(value) : String(actual) === value;
    }
    if (simple.startsWith(".")) {
        return node._classes.includes(simple.slice(1));
    }
    return node.tag === simple;
}

function descendants(root, out) {
    for (const child of root.children) {
        out.push(child);
        descendants(child, out);
    }
    return out;
}

function queryAll(root, selector) {
    const parts = String(selector).trim().split(/\s+/);
    let current = descendants(root, []);
    for (const part of parts) {
        const next = [];
        for (const node of current) {
            if (matchesSimple(node, part)) next.push(node);
        }
        // Descendant combinator: continue searching inside the matches.
        current = parts.indexOf(part) === parts.length - 1
            ? next
            : next.reduce((acc, node) => acc.concat(descendants(node, [])), []);
    }
    return current;
}

// Build a listing document with N nhentai-style cards.
function makeDocument(ids) {
    const html = makeEl("html");
    const body = makeEl("body");
    const container = makeEl("div", { class: "container" });
    container.className = "container";
    body.appendChild(container);
    html.appendChild(body);

    const addCard = (id, title) => {
        const gallery = makeEl("div");
        gallery.className = "gallery";
        const cover = makeEl("a", { href: "/g/" + id + "/" });
        cover.className = "cover";
        const caption = makeEl("div");
        caption.className = "caption";
        caption.textContent = title;
        cover.appendChild(caption);
        gallery.appendChild(cover);
        container.appendChild(gallery);
        return gallery;
    };
    ids.forEach((id, index) => addCard(id, "Title " + (index + 1)));

    const document = {
        documentElement: html,
        body: body,
        title: "Search results",
        readyState: "complete",
        createElement: (tag) => makeEl(tag),
        createTextNode: (text) => {
            const node = makeEl("#text");
            node.textContent = text;
            return node;
        },
        getElementById(id) {
            const all = descendants(html, []);
            return all.find((node) => node.id === id) || null;
        },
        querySelector(selector) { return html.querySelector(selector); },
        querySelectorAll(selector) { return html.querySelectorAll(selector); },
        addEventListener() {}
    };
    return { document: document, body: body, container: container, addCard: addCard };
}

function run(options) {
    const settings = options.settings || {};
    // Persistent download-history fixture (chrome.storage.local "downloadHistory").
    const localStore = Object.assign({ allIds: [] }, options.history || {});
    const syncWrites = [];
    const localWrites = [];
    const sentMessages = [];
    const confirmAnswers = options.confirmAnswers || [];
    const dom = makeDocument(options.ids || ["111111", "222222", "333333"]);
    const mutationCallbacks = [];

    class MutationObserverStub {
        constructor(callback) { this.callback = callback; }
        observe(target) {
            mutationCallbacks.push(this.callback);
            target._onMutate = () => { /* fired manually by the test */ };
        }
        disconnect() {}
    }

    const chromeStub = {
        storage: {
            sync: {
                get(defaults, cb) { cb(Object.assign({}, defaults, settings)); },
                set(items) { syncWrites.push(items); }
            },
            local: {
                get(defaults, cb) { cb(Object.assign({}, defaults, localStore)); },
                set(items) { localWrites.push(items); Object.assign(localStore, items); }
            },
            onChanged: { addListener() {} }
        },
        runtime: {
            lastError: null,
            sendMessage(message, cb) {
                sentMessages.push(message);
                if (cb) cb({ result: "started" });
            }
        }
    };

    const sandbox = {
        chrome: chromeStub,
        console,
        setTimeout,
        clearTimeout,
        document: dom.document,
        MutationObserver: MutationObserverStub,
        window: {
            confirm() {
                return confirmAnswers.length > 0 ? confirmAnswers.shift() : true;
            }
        }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: path.basename(bundlePath) });

    return {
        dom: dom,
        localStore: localStore,
        syncWrites: syncWrites,
        localWrites: localWrites,
        sentMessages: sentMessages,
        mutationCallbacks: mutationCallbacks
    };
}

function cardControls(dom) {
    return dom.document.querySelectorAll(".nhdw-card-controls");
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    // --- 1. injection ------------------------------------------------------
    {
        const ctx = run({});
        await wait(0);
        const controls = cardControls(ctx.dom);
        if (controls.length !== 3) {
            fail("expected 3 injected card control boxes, got " + controls.length);
        }
        for (const box of controls) {
            if (!box.querySelector(".nhdw-select-box")) fail("a card is missing its Select box");
            if (!box.querySelector(".nhdw-download")) fail("a card is missing its Download button");
        }
        const bar = ctx.dom.document.getElementById("nhdw-action-bar");
        if (!bar) fail("the floating action bar was not added");
        if (!bar.classList.contains("nhdw-hidden")) {
            fail("the action bar must stay hidden while nothing is selected");
        }
        console.log("PASS: every listing card gets a Download button and a Select box");

        // --- 2. idempotence + infinite scroll ------------------------------
        ctx.dom.addCard("444444", "Title 4");
        for (const callback of ctx.mutationCallbacks) callback([]);
        await wait(200);
        const after = cardControls(ctx.dom);
        if (after.length !== 4) {
            fail("a card added after load must be decorated exactly once, got " + after.length + " control boxes");
        }
        console.log("PASS: injection is idempotent and survives infinite scroll (MutationObserver)");

        // --- 3. selection syncs with the panel's storage -------------------
        const firstBox = after[0].querySelector(".nhdw-select-box");
        firstBox.checked = true;
        firstBox.dispatch("change");
        if (!ctx.localStore.allIds.includes("111111")) {
            fail("selecting a card must write the shared allIds list, got " + JSON.stringify(ctx.localStore.allIds));
        }
        const count = ctx.dom.document.getElementById("nhdw-count");
        if (!count || count.textContent !== "1 selected") {
            fail("the action bar must show the selection count, got " + (count && count.textContent));
        }
        const bar2 = ctx.dom.document.getElementById("nhdw-action-bar");
        if (bar2.classList.contains("nhdw-hidden")) {
            fail("the action bar must become visible once something is selected");
        }
        console.log("PASS: selection syncs with the panel (shared allIds) and drives the action bar");

        // --- 4. per-card download uses the shared registry -----------------
        after[1].querySelector(".nhdw-download").dispatch("click");
        const single = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!single || single.action !== "downloadAllDoujinshis") {
            fail("the card Download button must start a download, got " + JSON.stringify(single));
        }
        if (single.formatOverride !== "zip" || single.separate !== true) {
            fail("a single card must download as its own file: " + JSON.stringify(single));
        }
        if (single.nameTemplate !== "{pretty}") {
            fail("the list-mode template must travel with the job, got " + single.nameTemplate);
        }
        if (single.masterFolder !== "NHDW") {
            fail("the optional master folder must travel with the job, got " + single.masterFolder);
        }
        if (Object.keys(single.allDoujinshis).length !== 1) {
            fail("a card download must contain exactly that gallery");
        }
        console.log("PASS: the card Download button reuses the shared list-mode job options");
    }

    // --- 4b. download history: counts, labels, skip and override -----------
    {
        const ctx = run({
            history: { downloadHistory: { "222222": { filename: "Old/Two.zip", when: 1 } } }
        });
        await wait(0);
        // Card label reflects the recorded state.
        const controls = cardControls(ctx.dom);
        if (controls[1].querySelector(".nhdw-download").textContent !== "Downloaded") {
            fail("a recorded card must show 'Downloaded'");
        }
        if (controls[0].querySelector(".nhdw-download").textContent !== "Download") {
            fail("an un-recorded card must show 'Download'");
        }
        // Select the recorded + one fresh card: counts show real numbers.
        const boxA = controls[0].querySelector(".nhdw-select-box");
        boxA.checked = true;
        boxA.dispatch("change");
        const boxB = controls[1].querySelector(".nhdw-select-box");
        boxB.checked = true;
        boxB.dispatch("change");
        const count = ctx.dom.document.getElementById("nhdw-count");
        if (!count || count.textContent !== "2 selected \u00b7 1 already downloaded \u00b7 1 will download") {
            fail("the bar must show the history-aware counts, got " + JSON.stringify(count && count.textContent));
        }
        // The bulk toggle appears only where there is something recorded.
        const row = ctx.dom.document.getElementById("nhdw-redownload-row");
        if (!row || row.hidden) fail("the 'include already downloaded' row must be visible");
        // Start download: recorded gallery is skipped, zero API calls (it is
        // not even sent to the worker).
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const job1 = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!job1 || job1.action !== "downloadAllDoujinshis") {
            fail("expected a downloadAllDoujinshis job, got " + JSON.stringify(job1));
        }
        if (!job1.allDoujinshis["111111"] || job1.allDoujinshis["222222"] !== undefined) {
            fail("the recorded gallery must be skipped, got " + JSON.stringify(job1.allDoujinshis));
        }
        if (!Array.isArray(job1.redownloadIds) || job1.redownloadIds.length !== 0) {
            fail("no download-anyway ids without an explicit override, got " + JSON.stringify(job1.redownloadIds));
        }
        // Bulk "Include already downloaded" re-sends the recorded gallery.
        const includeBox = ctx.dom.document.getElementById("nhdw-redownload");
        includeBox.checked = true;
        includeBox.dispatch("change");
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const job2 = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!job2.allDoujinshis["111111"] || !job2.allDoujinshis["222222"]) {
            fail("the include-already toggle must re-send recorded galleries, got " + JSON.stringify(job2.allDoujinshis));
        }
        if (job2.redownloadIds.join(",") !== "222222") {
            fail("included recorded ids must travel as redownloadIds, got " + JSON.stringify(job2.redownloadIds));
        }
        console.log("PASS: recorded cards are skipped with history-aware counts and a bulk override");

        // Per-card download-anyway: declining does nothing, confirming re-sends.
        const singleCtx = run({
            history: { downloadHistory: { "222222": { filename: "Old/Two.zip", when: 1 } } },
            confirmAnswers: [false]
        });
        await wait(0);
        cardControls(singleCtx.dom)[1].querySelector(".nhdw-download").dispatch("click");
        if (singleCtx.sentMessages.length !== 0) {
            fail("declining the download-again confirmation must send nothing, got " +
                JSON.stringify(singleCtx.sentMessages));
        }
        const singleCtx2 = run({
            history: { downloadHistory: { "222222": { filename: "Old/Two.zip", when: 1 } } },
            confirmAnswers: [true]
        });
        await wait(0);
        cardControls(singleCtx2.dom)[1].querySelector(".nhdw-download").dispatch("click");
        const singleJob = singleCtx2.sentMessages[singleCtx2.sentMessages.length - 1];
        if (!singleJob || !singleJob.allDoujinshis["222222"]) {
            fail("confirming the download-again confirmation must send the gallery, got " +
                JSON.stringify(singleJob));
        }
        if (singleJob.redownloadIds.join(",") !== "222222") {
            fail("a confirmed card must carry its id in redownloadIds, got " +
                JSON.stringify(singleJob.redownloadIds));
        }
        console.log("PASS: per-card Download anyway asks for confirmation and re-sends on OK");

        // Merged mode never skips: the one archive needs every selected title.
        const mergedCtx = run({
            settings: { listFormat: "zip", listOutputMode: "batch" },
            history: { downloadHistory: { "222222": { filename: "Old/Two.zip", when: 1 } } }
        });
        await wait(0);
        for (const control of cardControls(mergedCtx.dom)) {
            const box = control.querySelector(".nhdw-select-box");
            box.checked = true;
            box.dispatch("change");
        }
        mergedCtx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const mergedJob = mergedCtx.sentMessages[mergedCtx.sentMessages.length - 1];
        if (!mergedJob.allDoujinshis["111111"] || !mergedJob.allDoujinshis["222222"]) {
            fail("merged mode must keep recorded titles, got " + JSON.stringify(mergedJob.allDoujinshis));
        }
        console.log("PASS: merged mode keeps every selected title (one archive needs them all)");
    }

    // --- 5. raw disables merging ------------------------------------------
    {
        const ctx = run({ settings: { listFormat: "raw", listOutputMode: "batch" } });
        await wait(0);
        const controls = cardControls(ctx.dom);
        const box = controls[0].querySelector(".nhdw-select-box");
        box.checked = true;
        box.dispatch("change");
        const modeSelect = ctx.dom.document.getElementById("nhdw-output");
        if (!modeSelect.disabled || modeSelect.value !== "separate") {
            fail("raw has no container to merge into: the merge option must be disabled, got "
                + JSON.stringify({ disabled: modeSelect.disabled, value: modeSelect.value }));
        }
        console.log("PASS: raw is always one folder per title (merge option disabled)");
    }

    // --- 6. batch PDF asks before merging different titles -----------------
    {
        // The user declines the merge -> the job must fall back to separate
        // files rather than producing a tankoubon of unrelated works.
        const ctx = run({
            settings: { listFormat: "pdf", listOutputMode: "batch" },
            confirmAnswers: [false]
        });
        await wait(0);
        const controls = cardControls(ctx.dom);
        for (const control of controls) {
            const box = control.querySelector(".nhdw-select-box");
            box.checked = true;
            box.dispatch("change");
        }
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const job = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!job || job.formatOverride !== "pdf") {
            fail("expected a PDF job, got " + JSON.stringify(job));
        }
        if (job.separate !== true) {
            fail("declining the merge warning must produce one PDF per title, got separate="
                + job.separate);
        }
        console.log("PASS: batch PDF over several titles warns and falls back to separate files");
    }

    {
        // The downgrade to separate files must ALSO apply the history skip.
        // Merged mode keeps every title (one archive needs them all), so the
        // recorded gallery is still in the selection when the warning is
        // answered; once the user picks one PDF per title the job is separate
        // and the recorded gallery must be dropped here - not sent to the
        // worker to be resolved and skipped (that costs the metadata/API calls
        // the skip exists to avoid, and the counts shown would be wrong).
        const ctx = run({
            settings: { listFormat: "pdf", listOutputMode: "batch" },
            history: { downloadHistory: { "222222": { filename: "Old/Two.pdf", when: 1 } } },
            confirmAnswers: [false]
        });
        await wait(0);
        for (const control of cardControls(ctx.dom)) {
            const box = control.querySelector(".nhdw-select-box");
            box.checked = true;
            box.dispatch("change");
        }
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const job = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!job || job.separate !== true) {
            fail("declining the merge must produce separate files, got " + JSON.stringify(job));
        }
        if (job.allDoujinshis["222222"] !== undefined) {
            fail("a separate-mode job must not carry the already-downloaded title, got "
                + JSON.stringify(job.allDoujinshis));
        }
        if (!job.allDoujinshis["111111"]) {
            fail("the unrecorded title must still download, got " + JSON.stringify(job.allDoujinshis));
        }
        console.log("PASS: switching to separate files in the merge warning applies the history skip");
    }

    {
        // ...and confirming the merge must keep every title, recorded or not:
        // the skip belongs to separate mode only.
        const ctx = run({
            settings: { listFormat: "pdf", listOutputMode: "batch" },
            history: { downloadHistory: { "222222": { filename: "Old/Two.pdf", when: 1 } } },
            confirmAnswers: [true]
        });
        await wait(0);
        for (const control of cardControls(ctx.dom)) {
            const box = control.querySelector(".nhdw-select-box");
            box.checked = true;
            box.dispatch("change");
        }
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const job = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!job || job.separate !== false) {
            fail("confirming the merge must keep one merged file, got " + JSON.stringify(job));
        }
        if (!job.allDoujinshis["222222"] || !job.allDoujinshis["111111"]) {
            fail("a merged job must keep every selected title, got " + JSON.stringify(job.allDoujinshis));
        }
        console.log("PASS: confirming the merge still keeps the recorded title in the archive");
    }

    {
        // Confirming keeps the merge, so the escape hatch still exists.
        const ctx = run({
            settings: { listFormat: "pdf", listOutputMode: "batch" },
            confirmAnswers: [true]
        });
        await wait(0);
        for (const control of cardControls(ctx.dom)) {
            const box = control.querySelector(".nhdw-select-box");
            box.checked = true;
            box.dispatch("change");
        }
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const job = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (job.separate !== false) {
            fail("confirming the merge must keep the single merged PDF, got separate=" + job.separate);
        }
        console.log("PASS: confirming the warning still allows an intentional merge");
    }

    // --- 7. the controls can be switched off -------------------------------
    {
        const ctx = run({ settings: { inPageControls: false } });
        await wait(50);
        if (cardControls(ctx.dom).length !== 0) {
            fail("no controls may be injected when the setting is off");
        }
        if (ctx.dom.document.getElementById("nhdw-action-bar")) {
            fail("no action bar may be added when the setting is off");
        }
        console.log("PASS: in-page controls stay out of the page when disabled");
    }

    // --- N. list mode inherits the single-title format ----------------------
    // listFormat is NOT stored here, so the in-page controls must fall through
    // to the single-title format (cbz) exactly like the popup does. Before the
    // listFormat key was dropped from LIST_MODE_DEFAULTS, the storage default
    // made this zip while the panel advertised cbz.
    {
        const ctx = run({ settings: { useZip: "cbz" } });
        await wait(0);
        const controls = cardControls(ctx.dom);
        if (controls.length === 0) {
            fail("expected injected card controls for the inheritance check");
        }
        controls[0].querySelector(".nhdw-download").dispatch("click");
        const job = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!job || job.formatOverride !== "cbz") {
            fail("with no listFormat stored a card download must inherit cbz, got " + JSON.stringify(job));
        }
        console.log("PASS: in-page card downloads inherit the single-title format");
    }

    console.log("PASS: in-page listing card controls behave correctly.");
})();
