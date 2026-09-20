// Website-embedded UI test: load the built js/siteUi.js in a window-less VM
// with a DOM stub that mirrors nhentai's header (Bootstrap navbar-header +
// hamburger) and verify:
//   - an invoker is injected next to the hamburger, idempotently
//   - a header re-render (MutationObserver) gets a fresh invoker, not two
//   - clicking the invoker opens a drawer with This page / Queue / Settings
//   - Settings reuses renderSettings (the API-key field is present)
//   - Queue reuses renderBookmarks (the paste box is present)
//   - a gallery URL shows Download this title and sends downloadAllDoujinshis
//   - a listing page with the in-page bar delegates Download selected to it
//   - embeddedUi:false injects nothing
//   - a siteUiToggle message opens the drawer
//   - a second execution of the bundle (on-demand inject) does not duplicate
//
// Usage:  node scripts/e2e-site-ui.js [path/to/js/siteUi.js]
// Exit code 0 = all checks passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "siteUi.js");
const code = fs.readFileSync(bundlePath, "utf8");

function fail(message) {
    console.error("FAIL: " + message);
    process.exit(1);
}

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
        tagName: String(tag || "div").toUpperCase(),
        children: [],
        attrs: Object.assign({}, attrs || {}),
        _classes: String((attrs && attrs.class) || "").split(/\s+/).filter(Boolean),
        _listeners: {},
        parentElement: null,
        type: "",
        title: "",
        value: "",
        textContent: "",
        innerHTML: "",
        checked: false,
        disabled: false,
        hidden: false,
        selected: false,
        src: "",
        href: "",
        alt: "",
        style: {},
        get className() { return node._classes.join(" "); },
        set className(value) { node._classes = String(value).split(/\s+/).filter(Boolean); },
        get id() { return node.attrs.id || ""; },
        set id(value) {
            node.attrs.id = String(value);
            if (node._document && value) node._document._ids.set(String(value), node);
        },
        get nextSibling() {
            if (!node.parentElement) return null;
            const i = node.parentElement.children.indexOf(node);
            return i >= 0 && i + 1 < node.parentElement.children.length
                ? node.parentElement.children[i + 1]
                : null;
        },
        appendChild(child) {
            child.parentElement = node;
            node.children.push(child);
            if (node._document && child.id) node._document._ids.set(child.id, child);
            if (node._onMutate) node._onMutate();
            let ancestor = node.parentElement;
            while (ancestor) {
                if (ancestor._onMutate) ancestor._onMutate();
                ancestor = ancestor.parentElement;
            }
            return child;
        },
        insertBefore(child, ref) {
            if (!ref) return node.appendChild(child);
            const i = node.children.indexOf(ref);
            if (i === -1) return node.appendChild(child);
            child.parentElement = node;
            node.children.splice(i, 0, child);
            if (node._document && child.id) node._document._ids.set(child.id, child);
            return child;
        },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i === -1) throw new Error("removeChild: not a child");
            node.children.splice(i, 1);
            child.parentElement = null;
            if (node._document && child.id) node._document._ids.delete(child.id);
            return child;
        },
        remove() {
            if (node.parentElement) node.parentElement.removeChild(node);
            else if (node._document && node.id) node._document._ids.delete(node.id);
        },
        setAttribute(name, value) {
            node.attrs[name] = String(value);
            if (name === "id") node.id = value;
            if (name === "class") node.className = value;
        },
        getAttribute(name) {
            if (name === "id") return node.id || null;
            if (name === "class") return node.className || null;
            return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
        },
        addEventListener(type, fn) {
            (node._listeners[type] = node._listeners[type] || []).push(fn);
        },
        click() { node.dispatch("click"); },
        dispatchEvent(event) {
            node.dispatch(event && event.type ? event.type : "click", event);
            return true;
        },
        dispatch(type, event) {
            const handlers = node._listeners[type] || [];
            const ev = Object.assign({
                preventDefault() {},
                stopPropagation() {},
                target: node,
                type: type
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
        },
        getBoundingClientRect() {
            return { top: 0, bottom: 48, left: 0, right: 360, width: 360, height: 48 };
        }
    };
    node.classList = makeClassList(node);
    if (attrs) {
        if (attrs.id) node.id = attrs.id;
        if (attrs.href) node.attrs.href = attrs.href;
        if (attrs.class) node.className = attrs.class;
    }
    return node;
}

function matchesSimple(node, simple) {
    if (simple.startsWith("#")) {
        return node.id === simple.slice(1);
    }
    const taggedClass = /^([a-z][a-z0-9]*)\.([a-z0-9_-]+)$/i.exec(simple);
    if (taggedClass) {
        return node.tag === taggedClass[1] && node._classes.includes(taggedClass[2]);
    }
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
    for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const next = [];
        for (const node of current) {
            if (matchesSimple(node, part)) next.push(node);
        }
        current = p === parts.length - 1
            ? next
            : next.reduce((acc, node) => acc.concat(descendants(node, [])), []);
    }
    return current;
}

function makeNhentaiDocument(options) {
    const opts = options || {};
    const html = makeEl("html");
    const body = makeEl("body");
    html.appendChild(body);

    const navbar = makeEl("nav", { class: "navbar navbar-inverse navbar-fixed-top" });
    const header = makeEl("div", { class: "navbar-header" });
    const brand = makeEl("a", { class: "navbar-brand" });
    brand.textContent = "nhentai";
    header.appendChild(brand);
    const hamburger = makeEl("button", { class: "navbar-toggle collapsed", id: "nav_btn" });
    hamburger.type = "button";
    header.appendChild(hamburger);
    navbar.appendChild(header);
    const collapse = makeEl("div", { class: "navbar-collapse", id: "navbar" });
    const right = makeEl("ul", { class: "nav navbar-nav navbar-right" });
    collapse.appendChild(right);
    navbar.appendChild(collapse);
    body.appendChild(navbar);

    if (opts.gallery) {
        const info = makeEl("div", { id: "info" });
        const h1 = makeEl("h1", { class: "title" });
        const pretty = makeEl("span", { class: "pretty" });
        pretty.textContent = opts.gallery.title || "Sample Title";
        h1.appendChild(pretty);
        info.appendChild(h1);
        info.appendChild(makeEl("div"));
        info.children[1].textContent = (opts.gallery.pages || 20) + " pages";
        body.appendChild(info);
        const cover = makeEl("div", { id: "cover" });
        const img = makeEl("img");
        img.setAttribute("src", "https://t.nhentai.net/galleries/1/cover.jpg");
        cover.appendChild(img);
        body.appendChild(cover);
    }

    if (opts.listing) {
        const container = makeEl("div", { class: "container" });
        const gallery = makeEl("div", { class: "gallery" });
        const cover = makeEl("a", { href: "/g/111111/" });
        cover.className = "cover";
        const caption = makeEl("div", { class: "caption" });
        caption.textContent = "Title 1\n20 pages";
        cover.appendChild(caption);
        gallery.appendChild(cover);
        container.appendChild(gallery);
        body.appendChild(container);

        const bar = makeEl("div", { id: "nhdw-action-bar" });
        bar.className = "nhdw-action-bar";
        const count = makeEl("span", { id: "nhdw-count" });
        count.textContent = "2 selected";
        bar.appendChild(count);
        const download = makeEl("button", { id: "nhdw-download-selected" });
        download.textContent = "Download";
        bar.appendChild(download);
        const clear = makeEl("button", { id: "nhdw-clear-selected" });
        clear.textContent = "Clear";
        bar.appendChild(clear);
        body.appendChild(bar);
    }

    const ids = new Map();
    const document = {
        _ids: ids,
        documentElement: html,
        body: body,
        title: opts.title || "nhentai",
        readyState: "complete",
        createElement: (tag) => {
            const el = makeEl(tag);
            el._document = document;
            return el;
        },
        createTextNode: (text) => {
            const n = makeEl("#text");
            n.textContent = text;
            return n;
        },
        getElementById(id) {
            if (ids.has(id)) return ids.get(id);
            const all = descendants(html, []);
            return all.find((node) => node.id === id) || null;
        },
        querySelector(selector) { return html.querySelector(selector); },
        querySelectorAll(selector) { return html.querySelectorAll(selector); },
        addEventListener(type, fn) {
            (html._listeners[type] = html._listeners[type] || []).push(fn);
        }
    };
    html._document = document;
    body._document = document;
    navbar._document = document;
    header._document = document;
    hamburger._document = document;
    ids.set("nav_btn", hamburger);
    if (opts.listing) {
        ids.set("nhdw-action-bar", body.querySelector("#nhdw-action-bar"));
        ids.set("nhdw-count", body.querySelector("#nhdw-count"));
        ids.set("nhdw-download-selected", body.querySelector("#nhdw-download-selected"));
        ids.set("nhdw-clear-selected", body.querySelector("#nhdw-clear-selected"));
    }
    return { document: document, body: body, navbar: navbar, header: header, hamburger: hamburger };
}

function run(options) {
    const opts = options || {};
    const settings = Object.assign({}, opts.settings);
    const localStore = Object.assign({}, opts.local || {});
    const sentMessages = [];
    const messageListeners = [];
    const mutationCallbacks = [];
    const href = opts.href || "https://nhentai.net/";
    const location = { href: href };
    const dom = makeNhentaiDocument(opts);

    class MutationObserverStub {
        constructor(callback) { this.callback = callback; }
        observe(target) {
            mutationCallbacks.push(this.callback);
            target._onMutate = () => { /* fired manually */ };
        }
        disconnect() {}
    }

    const chromeStub = {
        storage: {
            sync: {
                get(defaults, cb) { cb(Object.assign({}, defaults, settings)); },
                set(items) { Object.assign(settings, items); },
                remove(key) { delete settings[key]; },
                onChanged: { addListener() {} }
            },
            local: {
                get(defaults, cb) { cb(Object.assign({}, defaults, localStore)); },
                set(items) { Object.assign(localStore, items); }
            },
            onChanged: { addListener() {} }
        },
        runtime: {
            lastError: null,
            onMessage: { addListener(fn) { messageListeners.push(fn); } },
            sendMessage(message, cb) {
                sentMessages.push(message);
                if (message && message.action === "bookmarkGet") {
                    if (cb) cb({ state: { version: 1, collapsed: false, items: [] } });
                    return;
                }
                if (cb) cb({ result: "started", ok: true });
            },
            getURL(p) { return "moz-extension://testid/" + String(p).replace(/^\//, ""); },
            getManifest() {
                return { content_scripts: [{ js: ["js/content.js", "js/listControls.js", "js/siteUi.js"] }] };
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
        location: location,
        window: {
            location: location,
            matchMedia() {
                return { matches: !!opts.mobile, addEventListener() {}, addListener() {} };
            },
            confirm() { return opts.confirm === undefined ? true : !!opts.confirm; },
            addEventListener(type, fn) {
                (dom.document.documentElement._listeners[type] =
                    dom.document.documentElement._listeners[type] || []).push(fn);
            }
        },
        fetch() { return Promise.reject(new Error("no network in the siteUi harness")); },
        confirm() { return opts.confirm === undefined ? true : !!opts.confirm; },
        matchMedia() {
            return { matches: !!opts.mobile, addEventListener() {}, addListener() {} };
        },
        addEventListener() {},
        MouseEvent: function MouseEvent(type, init) {
            return Object.assign({ type: type, preventDefault() {}, stopPropagation() {} }, init || {});
        }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: path.basename(bundlePath) });

    return {
        sandbox: sandbox,
        dom: dom,
        sentMessages: sentMessages,
        messageListeners: messageListeners,
        mutationCallbacks: mutationCallbacks,
        location: location,
        localStore: localStore
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    // --- 1. invoker injection ---------------------------------------------
    {
        const ctx = run({});
        await wait(20);
        const invoker = ctx.dom.document.getElementById("nhdwSiteUiInvoker");
        if (!invoker) fail("expected the invoker button in the navbar");
        if (invoker.parentElement !== ctx.dom.header) {
            fail("the invoker must sit in .navbar-header, next to the hamburger");
        }
        const label = invoker.querySelector(".nhdw-invoker-label");
        if (!label || label.textContent !== "Downloader") {
            fail("the invoker must be labelled Downloader, got " + (label && label.textContent));
        }
        console.log("PASS: invoker is injected next to the hamburger");
    }

    // --- 2. idempotence + header re-render --------------------------------
    {
        const ctx = run({});
        await wait(20);
        if (ctx.dom.document.querySelectorAll(".nhdw-invoker").length !== 1) {
            fail("exactly one invoker after load");
        }
        // Simulate the site replacing the header: drop the invoker, fire the
        // observer, and expect it to come back once.
        const existing = ctx.dom.document.getElementById("nhdwSiteUiInvoker");
        existing.remove();
        for (const callback of ctx.mutationCallbacks) callback([]);
        await wait(250);
        const again = ctx.dom.document.querySelectorAll(".nhdw-invoker");
        if (again.length !== 1) {
            fail("a missing invoker must be re-injected exactly once, got " + again.length);
        }
        console.log("PASS: injection is idempotent and survives a header re-render");
    }

    // --- 3. drawer tabs + reused renderers --------------------------------
    {
        const ctx = run({});
        await wait(20);
        ctx.dom.document.getElementById("nhdwSiteUiInvoker").click();
        await wait(20);
        const root = ctx.dom.document.getElementById("nhdwSiteUi");
        if (!root || root.hidden) fail("clicking the invoker must open the drawer");
        if (!ctx.dom.document.getElementById("nhdwSiteUiTab-page")) fail("missing This page tab");
        if (!ctx.dom.document.getElementById("nhdwSiteUiTab-queue")) fail("missing Queue tab");
        if (!ctx.dom.document.getElementById("nhdwSiteUiTab-settings")) fail("missing Settings tab");

        ctx.dom.document.getElementById("nhdwSiteUiTab-settings").click();
        await wait(20);
        if (!ctx.dom.document.getElementById("psApiKeyInput")) {
            fail("Settings must reuse renderSettings (API-key field missing)");
        }
        if (!ctx.dom.document.getElementById("psEmbeddedUi")) {
            fail("Settings must offer the in-page panel toggle when siteUi ships");
        }

        ctx.dom.document.getElementById("nhdwSiteUiTab-queue").click();
        await wait(20);
        if (!ctx.dom.document.getElementById("nhdwBmPaste")) {
            fail("Queue must reuse renderBookmarks (paste box missing)");
        }
        console.log("PASS: drawer opens with This page / Queue / Settings, reusing the existing renderers");
    }

    // --- 4. gallery page: Download this title -----------------------------
    {
        const ctx = run({
            href: "https://nhentai.net/g/177013/",
            gallery: { title: "Metamorphosis", pages: 225 }
        });
        await wait(20);
        ctx.dom.document.getElementById("nhdwSiteUiInvoker").click();
        await wait(20);
        const pane = ctx.dom.document.getElementById("nhdwSiteUiPage");
        if (!pane) fail("This page pane missing");
        const title = pane.querySelector(".nhdw-site-ui-card-title");
        if (!title || title.textContent.indexOf("Metamorphosis") === -1) {
            fail("gallery pane must show the pretty title, got " + (title && title.textContent));
        }
        const buttons = pane.querySelectorAll(".nhdw-site-ui-btn");
        const download = Array.from ? null : null;
        let found = null;
        for (let i = 0; i < buttons.length; i++) {
            if (/Download/.test(buttons[i].textContent)) found = buttons[i];
        }
        if (!found) fail("gallery pane must have a Download this title button");
        found.click();
        await wait(20);
        const job = ctx.sentMessages.filter((m) => m && m.action === "downloadAllDoujinshis").pop();
        if (!job) fail("Download this title must send downloadAllDoujinshis");
        if (!job.allDoujinshis || !job.allDoujinshis["177013"]) {
            fail("the job must contain gallery 177013, got " + JSON.stringify(job.allDoujinshis));
        }
        if (job.separate !== true) fail("a single title must download as its own file");
        console.log("PASS: a gallery page shows the title and downloads it as one file");
    }

    // --- 5. listing page delegates to the in-page bar ---------------------
    {
        const ctx = run({ listing: true, href: "https://nhentai.net/" });
        await wait(20);
        ctx.dom.document.getElementById("nhdwSiteUiInvoker").click();
        await wait(20);
        const pane = ctx.dom.document.getElementById("nhdwSiteUiPage");
        const line = ctx.dom.document.getElementById("nhdwSiteUiSelectionLine");
        if (!line || line.textContent !== "2 selected") {
            fail("listing pane must read the in-page bar count, got " + (line && line.textContent));
        }
        let delegated = false;
        const barDownload = ctx.dom.document.getElementById("nhdw-download-selected");
        barDownload.addEventListener("click", () => { delegated = true; });
        const buttons = pane.querySelectorAll(".nhdw-site-ui-btn");
        let found = null;
        for (let i = 0; i < buttons.length; i++) {
            if (buttons[i].textContent === "Download selected") found = buttons[i];
        }
        if (!found) fail("listing pane must offer Download selected");
        found.click();
        if (!delegated) fail("Download selected must click the in-page bar's own button");
        console.log("PASS: a listing page delegates Download selected to the in-page bar");
    }

    // --- 6. disabled setting injects nothing ------------------------------
    {
        const ctx = run({ settings: { embeddedUi: false } });
        await wait(20);
        if (ctx.dom.document.getElementById("nhdwSiteUiInvoker")) {
            fail("embeddedUi:false must inject no invoker");
        }
        // A toolbar click while disabled must answer ok:false so the worker
        // can fall back to the popup document.
        if (ctx.messageListeners.length === 0) fail("the toggle listener must still register while disabled");
        let answered = null;
        ctx.messageListeners[0]({ action: "siteUiToggle" }, {}, (response) => { answered = response; });
        if (!answered || answered.ok !== false) {
            fail("disabled toggle must answer {ok:false}, got " + JSON.stringify(answered));
        }
        console.log("PASS: embeddedUi:false injects nothing and refuses the toolbar toggle");
    }

    // --- 7. siteUiToggle message opens the drawer -------------------------
    {
        const ctx = run({});
        await wait(20);
        if (ctx.messageListeners.length === 0) fail("expected a runtime onMessage listener");
        ctx.messageListeners[0]({ action: "siteUiToggle", open: true }, {}, () => {});
        await wait(20);
        const root = ctx.dom.document.getElementById("nhdwSiteUi");
        if (!root || root.hidden) fail("siteUiToggle open:true must open the drawer");
        console.log("PASS: a siteUiToggle message opens the drawer");
    }

    // --- 8. double load does not duplicate --------------------------------
    {
        const ctx = run({});
        await wait(20);
        vm.runInContext(code, ctx.sandbox, { filename: path.basename(bundlePath) });
        await wait(20);
        const invokers = ctx.dom.document.querySelectorAll(".nhdw-invoker");
        if (invokers.length !== 1) {
            fail("a second execution of the bundle must not add another invoker, got " + invokers.length);
        }
        console.log("PASS: on-demand re-inject of the bundle does not duplicate the invoker");
    }

    console.log("PASS: website-embedded UI behaves correctly.");
})().catch((error) => {
    console.error("FAIL: " + (error && error.stack ? error.stack : error));
    process.exit(1);
});
