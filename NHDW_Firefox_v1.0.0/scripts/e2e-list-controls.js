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
//   - saved/inherited/legacy list formats reach card AND bar jobs, read-only;
//     explicit format edits persist and restore on a fresh page
//
// Usage:  node scripts/e2e-list-controls.js [path/to/js/listControls.js]
// Exit code 0 = all checks passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("node:assert/strict");
const { readStorage } = require("./test-support/storage");
const { formats, formatCases } = require("./test-support/list-format-cases");

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
        setAttribute(name, value) {
            node.attrs[name] = String(value);
            // Real DOM: setAttribute("class", ...) is what classList reads, and
            // the bookmark glyph sets its class that way.
            if (name === "class") node.className = String(value);
        },
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
    // Compound "tag.class" (and "tag.a.b"): the glyph lookups use it.
    const compound = /^([a-z0-9-]*)((?:\.[\w-]+)*)$/i.exec(simple);
    if (compound !== null && (compound[1] !== "" || compound[2] !== "")) {
        if (compound[1] !== "" && node.tag !== compound[1]) return false;
        if (compound[2] === "") return true;
        const classes = compound[2].slice(1).split(".");
        for (const name of classes) {
            if (!node._classes.includes(name)) return false;
        }
        return true;
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
// Build a listing document with N cards. `site` selects the captured markup
// shape (item 63): nhentai keeps the caption-inside-the-link layout the bundle
// was born with; the other rows mirror the capture blocks in "5 website page
// source" / the live hitomi search fetch.
function makeDocument(ids, site) {
    site = site || "nhentai";
    const html = makeEl("html");
    const body = makeEl("body");
    const container = makeEl("div", { class: "container" });
    container.className = "container";
    body.appendChild(container);
    html.appendChild(body);

    const addNhentaiCard = (id, title, pages) => {
        const gallery = makeEl("div");
        gallery.className = "gallery";
        const cover = makeEl("a", { href: "/g/" + id + "/" });
        cover.className = "cover";
        // nhentai lazyloads covers: the real address is in data-src while src
        // holds a placeholder. The bookmark button has to read data-src.
        const img = makeEl("img");
        img.setAttribute("data-src", "https://t.nhentai.net/galleries/" + id + "0/thumb.jpg");
        img.setAttribute("src", "data:image/gif;base64,placeholder");
        cover.appendChild(img);
        const caption = makeEl("div");
        caption.className = "caption";
        caption.textContent = title + "\n" + (pages || 71) + " pages";
        cover.appendChild(caption);
        gallery.appendChild(cover);
        container.appendChild(gallery);
        return gallery;
    };

    // hentaifox / imhentai shape: div.thumb > inner_thumb > cover link, with
    // the title in a sibling .caption (title link shares the href).
    const addThumbCard = (id, title) => {
        const thumb = makeEl("div");
        thumb.className = "thumb";
        const inner = makeEl("div");
        inner.className = "inner_thumb";
        const cover = makeEl("a", { href: "/gallery/" + id + "/" });
        cover.className = "cover";
        const img = makeEl("img");
        img.setAttribute("data-src", "https://cdn.example/thumb/" + id + ".jpg");
        img.setAttribute("src", "data:image/gif;base64,placeholder");
        cover.appendChild(img);
        inner.appendChild(cover);
        thumb.appendChild(inner);
        const caption = makeEl("div");
        caption.className = "caption";
        const heading = makeEl("h2");
        heading.className = "g_title";
        const titleLink = makeEl("a", { href: "/gallery/" + id + "/" });
        titleLink.textContent = title;
        heading.appendChild(titleLink);
        caption.appendChild(heading);
        thumb.appendChild(caption);
        container.appendChild(thumb);
        return thumb;
    };

    // hentaiera shape: div.thumb > a.inner_thumb cover, title in div.g_text.
    const addEraCard = (id, title) => {
        const thumb = makeEl("div");
        thumb.className = "thumb";
        const cover = makeEl("a", { href: "/gallery/" + id + "/" });
        cover.className = "inner_thumb img_box";
        const img = makeEl("img");
        img.setAttribute("data-src", "https://hentaiera.site/galleries/" + id + "/thumb.webp");
        img.setAttribute("src", "data:image/gif;base64,placeholder");
        cover.appendChild(img);
        thumb.appendChild(cover);
        const gText = makeEl("div");
        gText.className = "g_text";
        const heading = makeEl("h2");
        heading.className = "gallery_title";
        const titleLink = makeEl("a", { href: "/gallery/" + id + "/" });
        titleLink.textContent = title;
        heading.appendChild(titleLink);
        gText.appendChild(heading);
        thumb.appendChild(gText);
        container.appendChild(thumb);
        return thumb;
    };

    // hentaienvy shape: article.hnv-gallery-card with cover in the media div
    // and the title in the footer.
    const addEnvyCard = (id, title) => {
        const article = makeEl("article");
        article.className = "hnv-gallery-card";
        const media = makeEl("div");
        media.className = "hnv-gallery-card__media thumb";
        const cover = makeEl("a", { href: "/gallery/" + id + "/" });
        cover.className = "hnv-gallery-card__cover";
        const img = makeEl("img");
        img.setAttribute("src", "https://m11.hentaienvy.com/033/thumb/" + id + ".jpg");
        cover.appendChild(img);
        media.appendChild(cover);
        article.appendChild(media);
        const footer = makeEl("footer");
        footer.className = "hnv-gallery-card__caption";
        const heading = makeEl("h2");
        heading.className = "hnv-gallery-card__title";
        const titleLink = makeEl("a", { href: "/gallery/" + id + "/" });
        titleLink.textContent = title;
        heading.appendChild(titleLink);
        footer.appendChild(heading);
        article.appendChild(footer);
        container.appendChild(article);
        return article;
    };

    // hitomi shape: .gallery-content > block div > h1 > a (live search.html +
    // galleryblock.js evidence). The grid is created once, on the first card —
    // a closure var, because the harness nodes expose parentElement (and a
    // fresh makeEl node's parentElement is null while detached).
    let hitomiGrid = null;
    const addHitomiCard = (id, title) => {
        if (hitomiGrid === null) {
            hitomiGrid = makeEl("div");
            hitomiGrid.className = "gallery-content";
            container.appendChild(hitomiGrid);
        }
        const block = makeEl("div");
        const heading = makeEl("h1");
        const titleLink = makeEl("a", { href: "https://hitomi.la/galleries/" + id + ".html" });
        titleLink.textContent = title;
        heading.appendChild(titleLink);
        block.appendChild(heading);
        const img = makeEl("img");
        img.setAttribute("data-src", "https://tn.gold-usergeneratedcontent.net/thumb/" + id + ".webp");
        img.setAttribute("src", "data:image/gif;base64,placeholder");
        block.appendChild(img);
        hitomiGrid.appendChild(block);
        return block;
    };

    const addCard = site === "hentaifox" || site === "imhentai" ? addThumbCard
        : site === "hentaiera" ? addEraCard
        : site === "hentaienvy" ? addEnvyCard
        : site === "hitomi" ? addHitomiCard
        : addNhentaiCard;
    ids.forEach((id, index) => addCard(id, "Title " + (index + 1), 71 + index));

    const document = {
        documentElement: html,
        body: body,
        title: "Search results",
        readyState: "complete",
        createElement: (tag) => makeEl(tag),
        // The bookmark glyph is an inline SVG built with createElementNS (the
        // extension CSP forbids innerHTML), so the stub has to offer it.
        createElementNS: (namespace, tag) => makeEl(tag),
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
    const settings = structuredClone(options.settings || {});
    // Persistent download-history fixture (chrome.storage.local "downloadHistory").
    // `store` seeds the transient selection keys (allIds / allIdsSite) so a
    // fixture can prove which of them a reader actually asked storage for.
    const localStore = Object.assign({ allIds: [] }, options.history || {}, options.store || {});
    const syncWrites = [];
    const localWrites = [];
    const sentMessages = [];
    const syncChangeCallbacks = [];
    const confirmAnswers = options.confirmAnswers || [];
    const dom = makeDocument(options.ids || ["111111", "222222", "333333"], options.site);
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
                get(keys, cb) { queueMicrotask(() => cb(readStorage(settings, keys))); },
                set(items) { const copy = structuredClone(items); syncWrites.push(copy); Object.assign(settings, copy); },
                onChanged: { addListener(fn) { syncChangeCallbacks.push(fn); } }
            },
            local: {
                get(keys, cb) { queueMicrotask(() => cb(readStorage(localStore, keys))); },
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
        // Item 63: card discovery dispatches on the page's own site, so the
        // fixture must be able to point the bundle at each supported host.
        location: { href: options.location || "https://nhentai.net/" },
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
        settings: settings,
        localStore: localStore,
        syncWrites: syncWrites,
        syncChangeCallbacks: syncChangeCallbacks,
        localWrites: localWrites,
        sentMessages: sentMessages,
        mutationCallbacks: mutationCallbacks
    };
}

function cardControls(dom) {
    return dom.document.querySelectorAll(".nhdw-card-controls");
}

// The card bookmark button draws a real bookmark icon (inline SVG), not a
// text star. These are the two shipped paths, pinned here so a change to the
// icon is a deliberate test update rather than a silent visual regression.
const BOOKMARK_GLYPH_FILLED = "M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z";
const BOOKMARK_GLYPH_OUTLINE = "M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm0 13.9-5-2.14-5 2.14V5h10v11.9z";

function bookmarkGlyph(button) {
    const svg = button.querySelector("svg.nhdw-bookmark-glyph");
    if (svg === null) {
        return null;
    }
    return svg.querySelector("path");
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
        // Item 64a: Select all must be reachable with NOTHING selected, so the
        // bar shows whenever listing cards exist (it used to hide until the
        // first selection, which made Select-all dead on arrival).
        if (bar.classList.contains("nhdw-hidden")) {
            fail("the action bar must be visible while listing cards exist (item 64a)");
        }
        // The harness DOM has no #id querySelector — look the control up by id
        // through the document, exactly like the other bar asserts do.
        if (!ctx.dom.document.getElementById("nhdw-select-all")) {
            fail("the floating action bar must offer Select all (item 64a)");
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

    // --- N+1. the bookmark button -----------------------------------------
    {
        const ctx = run({});
        await wait(0);
        const controls = cardControls(ctx.dom);
        if (controls.length !== 3) {
            fail("expected 3 control boxes for the bookmark check, got " + controls.length);
        }
        for (const box of controls) {
            const button = box.querySelector(".nhdw-bookmark");
            if (!button) {
                fail("a card is missing its bookmark button");
            }
            // A real bookmark glyph, not the old ☆/★ text glyph.
            const glyph = bookmarkGlyph(button);
            if (glyph === null) {
                fail("the card bookmark button must draw an inline SVG bookmark icon");
            }
            if (glyph.getAttribute("d") !== BOOKMARK_GLYPH_OUTLINE) {
                fail("an unbookmarked card must draw the outline bookmark glyph, got " + glyph.getAttribute("d"));
            }
            if (button.textContent !== "") {
                fail("the card bookmark button must stay text-free, got " + JSON.stringify(button.textContent));
            }
            if (button.getAttribute("aria-pressed") !== "false") {
                fail("an unbookmarked card must report aria-pressed=false");
            }
        }
        console.log("PASS: every listing card gets a text-free bookmark icon button");

        // Layout: Select + Bookmark sit together at the top-left of the strip
        // and Download stays the strip's own right-hand child.
        for (const box of controls) {
            const left = box.querySelector(".nhdw-card-controls-left");
            if (left === null) {
                fail("the card controls need a left group for Select + Bookmark");
            }
            if (!left.querySelector(".nhdw-select-box")) {
                fail("the Select box must sit in the left group");
            }
            if (!left.querySelector(".nhdw-bookmark")) {
                fail("the Bookmark button must sit in the left group");
            }
            const download = box.querySelector(".nhdw-download");
            if (download === null || download.parentElement !== box) {
                fail("the Download button must stay a direct right-hand child of the strip");
            }
            if (box.children[box.children.length - 1] !== download) {
                fail("Download must be the strip's last (right-most) child");
            }
        }
        console.log("PASS: Select + Bookmark sit top-left, Download stays top-right");

        // A click must carry the card's OWN cover: that is the thumbnail the
        // Queue row shows, and it is only readable from the page.
        controls[0].querySelector(".nhdw-bookmark").dispatch("click");
        const add = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!add || add.action !== "bookmarkAdd") {
            fail("clicking the bookmark button must send bookmarkAdd, got " + JSON.stringify(add));
        }
        const item = add.items[0];
        if (item.id !== "111111") {
            fail("the bookmark must carry the card's gallery id, got " + item.id);
        }
        if (item.thumbnail !== "https://t.nhentai.net/galleries/1111110/thumb.jpg") {
            fail("the bookmark must carry the card's lazyloaded cover (data-src, not the placeholder), got " + item.thumbnail);
        }
        if (item.pages !== 71) {
            fail("the bookmark must carry the caption's page count, got " + item.pages);
        }
        if (item.source !== "card" || item.sourceUrl !== "https://nhentai.net/") {
            fail("a manual card bookmark must report source=card and the page URL, got " + JSON.stringify(item));
        }
        console.log("PASS: the bookmark button sends the card's id, title, page count and cover thumbnail");

        // It is a toggle: it is the only un-bookmark affordance on the page.
        // The wire carries the COMPOSITE key (item 63): a bare id would only
        // ever remove the default site's row.
        controls[0].querySelector(".nhdw-bookmark").dispatch("click");
        const remove = ctx.sentMessages[ctx.sentMessages.length - 1];
        if (!remove || remove.action !== "bookmarkRemove" || String(remove.ids[0]) !== "nhentai:111111") {
            fail("clicking a filled bookmark button must send the composite key, got " + JSON.stringify(remove));
        }
        console.log("PASS: clicking a filled bookmark button takes the title off the list");
    }

    // --- N+2. auto-capture -------------------------------------------------
    {
        // Off by default: on a 60-card search page it would silently build a
        // 60-item list the user never asked for.
        const off = run({});
        await wait(0);
        if (off.sentMessages.some((message) => message.action === "bookmarkAdd")) {
            fail("auto-capture must be OFF by default");
        }
        console.log("PASS: auto-capture stays off unless the user turns it on");

        const on = run({ settings: { bookmarkAutoCapture: true } });
        await wait(0);
        const adds = on.sentMessages.filter((message) => message.action === "bookmarkAdd");
        if (adds.length !== 3) {
            fail("auto-capture must bookmark every card, got " + adds.length + " messages");
        }
        if (adds[0].items[0].source !== "auto") {
            fail("an auto-captured row must report source=auto, got " + adds[0].items[0].source);
        }
        if (!adds[0].items[0].thumbnail) {
            fail("an auto-captured row must still carry the card's cover");
        }
        console.log("PASS: auto-capture bookmarks every card without a click when it is on");

        // Flipping the setting on a page that is ALREADY open must still
        // collect it. Card injection is idempotent and skips decorated cards,
        // so auto-capture has to be its own pass or this silently does nothing.
        const flipped = run({});
        await wait(0);
        if (flipped.sentMessages.some((message) => message.action === "bookmarkAdd")) {
            fail("the flip fixture must start with auto-capture off");
        }
        if (cardControls(flipped.dom).length !== 3) {
            fail("the flip fixture must have decorated its cards first");
        }
        if (flipped.syncChangeCallbacks.length === 0) {
            fail("the content script must listen for the auto-capture setting to change");
        }
        for (const callback of flipped.syncChangeCallbacks) {
            callback({ bookmarkAutoCapture: { newValue: true } }, "sync");
        }
        await wait(0);
        const swept = flipped.sentMessages.filter((message) => message.action === "bookmarkAdd");
        if (swept.length !== 3) {
            fail("turning auto-capture on mid-page must bookmark the cards already there, got " + swept.length);
        }
        if (swept[0].items[0].source !== "auto") {
            fail("a mid-page auto-capture must report source=auto");
        }
        console.log("PASS: turning auto-capture on mid-page still collects the cards already there");

        // And it must not re-send what is already bookmarked.
        for (const callback of flipped.syncChangeCallbacks) {
            callback({ bookmarkAutoCapture: { newValue: true } }, "sync");
        }
        await wait(0);
        const afterSecondSweep = flipped.sentMessages.filter((message) => message.action === "bookmarkAdd").length;
        if (afterSecondSweep !== 3) {
            fail("a second auto-capture sweep must add nothing, got " + afterSecondSweep + " total sends");
        }
        console.log("PASS: a repeated auto-capture sweep adds nothing");
    }

    // --- N+3. an already-bookmarked card renders the filled icon -----------
    {
        const ctx = run({
            history: {
                bookmarkQueue: {
                    v: 1,
                    collapsed: false,
                    items: [{ id: "222222", title: "Title 2", selected: true, status: "saved" }]
                }
            }
        });
        await wait(0);
        const controls = cardControls(ctx.dom);
        const filled = controls[1].querySelector(".nhdw-bookmark");
        if (!filled.classList.contains("nhdw-bookmark-on")) {
            fail("a bookmarked card must render the filled bookmark state, got class=" + filled.className);
        }
        const filledGlyph = bookmarkGlyph(filled);
        if (filledGlyph === null || filledGlyph.getAttribute("d") !== BOOKMARK_GLYPH_FILLED) {
            fail("a bookmarked card must draw the filled bookmark glyph");
        }
        if (filled.getAttribute("aria-pressed") !== "true") {
            fail("a bookmarked card must report aria-pressed=true");
        }
        const empty = controls[0].querySelector(".nhdw-bookmark");
        const emptyGlyph = bookmarkGlyph(empty);
        if (empty.classList.contains("nhdw-bookmark-on") || emptyGlyph === null || emptyGlyph.getAttribute("d") !== BOOKMARK_GLYPH_OUTLINE) {
            fail("an unbookmarked card must draw the outline bookmark glyph");
        }
        console.log("PASS: bookmarked cards come back with the filled bookmark icon after a reload");
    }

    // --- Item 59: real key-scoped reads, every stored/inherited format -----
    const selectedFormat = (ctx) => {
        const select = ctx.dom.document.getElementById("nhdw-format");
        assert.ok(select);
        assert.deepEqual(select.children.map((option) => option.value), formats);
        return select.children.filter((option) => option.selected).map((option) => option.value);
    };
    for (const { label, stored, expected } of formatCases) {
        const ctx = run({ settings: stored });
        await wait(0);
        assert.deepEqual(selectedFormat(ctx), [expected], label + ": selected bar option");
        assert.deepEqual(ctx.syncWrites, [], label + ": opening the page is read-only");
        assert.deepEqual(ctx.settings, stored, label + ": no normalization written back");
        cardControls(ctx.dom)[0].querySelector(".nhdw-download").dispatch("click");
        const job = ctx.sentMessages.find((message) => message.action === "downloadAllDoujinshis");
        assert.ok(job, label + ": card dispatch");
        assert.equal(job.formatOverride, expected, label);
        assert.equal(job.separate, true);
        const sent = ctx.sentMessages.length;
        for (const control of cardControls(ctx.dom).slice(0, 2)) {
            const box = control.querySelector(".nhdw-select-box");
            box.checked = true;
            box.dispatch("change");
        }
        ctx.dom.document.getElementById("nhdw-download-selected").dispatch("click");
        const barJob = ctx.sentMessages.slice(sent).find((message) => message.action === "downloadAllDoujinshis");
        assert.ok(barJob, label + ": bar dispatch");
        assert.equal(barJob.formatOverride, expected, label + ": bar format");
        assert.equal(barJob.separate, true);
        assert.deepEqual(Object.keys(barJob.allDoujinshis), ["111111", "222222"]);
        assert.deepEqual(ctx.syncWrites, [], label + ": downloads do not materialize defaults");
    }
    console.log(`PASS: card/bar controls display and dispatch all ${formatCases.length} explicit/inherited/legacy list formats without writes`);

    const edited = run({ settings: { useZip: "cbz", listFormat: "pdf", unrelated: "keep" } });
    await wait(0);
    for (const format of formats) {
        edited.syncWrites.length = 0;
        const control = edited.dom.document.getElementById("nhdw-format");
        control.value = format;
        control.dispatch("change");
        assert.deepEqual(edited.syncWrites, [{ listFormat: format }]);
        assert.equal(edited.settings.useZip, "cbz");
        assert.equal(edited.settings.unrelated, "keep");
        const reopened = run({ settings: edited.settings });
        await wait(0);
        assert.deepEqual(selectedFormat(reopened), [format]);
        assert.deepEqual(reopened.syncWrites, []);
    }
    console.log("PASS: list bar format edits persist independently and survive a page reload");

    // --- N+4. every supported site's listing markup (item 63) --------------
    // Each row in utils/listCards.ts declares its own card boundary, so the
    // fixtures mirror the captured markup instead of nhentai's. Discovery that
    // silently fell back to a global selector would decorate nothing here.
    {
        const SITES = [
            { site: "nhentai", location: "https://nhentai.net/", ids: ["111111", "222222", "333333"] },
            { site: "hentaifox", location: "https://hentaifox.com/", ids: ["173098", "173099", "173100"] },
            { site: "imhentai", location: "https://imhentai.xxx/", ids: ["1738519", "1738520", "1738521"] },
            { site: "hentaiera", location: "https://hentaiera.to/tag/milf/", ids: ["694133", "694134", "694135"] },
            { site: "hentaienvy", location: "https://hentaienvy.com/", ids: ["1606086", "1606087", "1606088"] },
            { site: "hitomi", location: "https://hitomi.la/search.html?tag%3Afemale%3Aschoolgirl", ids: ["7363", "7364", "7365"] }
        ];
        for (const entry of SITES) {
            const ctx = run({ site: entry.site, location: entry.location, ids: entry.ids });
            await wait(0);
            const controls = cardControls(ctx.dom);
            if (controls.length !== entry.ids.length) {
                fail(entry.site + ": expected " + entry.ids.length + " decorated cards, got " + controls.length);
            }
            const decorated = controls.map((box) => box.parentElement && box.parentElement.getAttribute("data-nhdw-controls"));
            for (const id of entry.ids) {
                if (decorated.indexOf(id) === -1) {
                    fail(entry.site + ": card " + id + " was not decorated, got " + JSON.stringify(decorated));
                }
            }
            for (const box of controls) {
                if (!box.querySelector(".nhdw-select-box") || !box.querySelector(".nhdw-download")
                    || !box.querySelector(".nhdw-bookmark")) {
                    fail(entry.site + ": a card is missing Select / Download / Bookmark");
                }
            }
            // The bookmark write carries the PAGE's site, never the default one.
            controls[0].querySelector(".nhdw-bookmark").dispatch("click");
            const add = ctx.sentMessages.filter((message) => message.action === "bookmarkAdd").pop();
            if (!add || add.items[0].id !== entry.ids[0] || add.items[0].site !== entry.site) {
                fail(entry.site + ": bookmarkAdd must carry the page site, got " + JSON.stringify(add));
            }
            // ...and a per-card download is dispatched as that site's job.
            controls[0].querySelector(".nhdw-download").dispatch("click");
            const job = ctx.sentMessages[ctx.sentMessages.length - 1];
            if (!job || job.action !== "downloadAllDoujinshis" || job.site !== entry.site) {
                fail(entry.site + ": the card job must name its site, got " + JSON.stringify(job));
            }
            if (!job.allDoujinshis[entry.ids[0]]) {
                fail(entry.site + ": the job must carry the card's gallery id, got " + JSON.stringify(job.allDoujinshis));
            }
        }
        console.log("PASS: card controls discover every supported site's own listing markup (item 63)");

        // A gallery page of another site must not be treated as this one, and
        // an unsupported host decorates nothing at all.
        const offSite = run({ site: "hentaifox", location: "https://nhentai.net/", ids: ["173098"] });
        await wait(0);
        if (cardControls(offSite.dom).length !== 0) {
            fail("a fixture whose location disagrees with its markup must not decorate cards");
        }

        // A single-gallery page on a supported host is a TITLE page. Its
        // related-gallery cards match the site's listing selectors exactly (the
        // hentaiera capture: div.thumb > a.inner_thumb.img_box with a sibling
        // .gallery_title), so discovery must honour the documented listing-only
        // contract instead of trusting that no card-shaped markup exists there.
        const galleryPage = run({
            site: "hentaiera",
            location: "https://hentaiera.to/gallery/694133/",
            ids: ["250717", "401339"]
        });
        await wait(0);
        if (cardControls(galleryPage.dom).length !== 0) {
            fail("a gallery page's related-gallery cards must not be decorated as a listing (item 63)");
        }
        const galleryBar = galleryPage.dom.document.getElementById("nhdw-action-bar");
        if (galleryBar && !galleryBar.classList.contains("nhdw-hidden")) {
            fail("the floating bar must stay hidden on a gallery page - there are no listing cards");
        }
        console.log("PASS: a gallery page's related cards are never decorated as a listing (item 63)");
    }

    // --- N+5. Select all (item 64a) ---------------------------------------
    {
        const ctx = run({});
        await wait(0);
        const bar = ctx.dom.document.getElementById("nhdw-action-bar");
        if (bar.classList.contains("nhdw-hidden")) {
            fail("the action bar must be visible while listing cards exist (item 64a)");
        }
        const selectAll = ctx.dom.document.getElementById("nhdw-select-all");
        if (!selectAll) {
            fail("the floating action bar must offer Select all (item 64a)");
        }
        if (ctx.localStore.allIds.length !== 0) {
            fail("the fixture must start with an empty selection");
        }
        selectAll.dispatch("click");
        const expected = ["111111", "222222", "333333"];
        for (const id of expected) {
            if (!ctx.localStore.allIds.includes(id)) {
                fail("Select all must select every card, got " + JSON.stringify(ctx.localStore.allIds));
            }
        }
        const count = ctx.dom.document.getElementById("nhdw-count");
        if (!count || count.textContent !== "3 selected") {
            fail("Select all must refresh the bar count, got " + (count && count.textContent));
        }
        for (const box of cardControls(ctx.dom)) {
            if (!box.querySelector(".nhdw-select-box").checked) {
                fail("Select all must tick every card's Select box");
            }
        }
        console.log("PASS: Select all selects every card on the page and drives the bar (item 64a)");

        // Clear still empties the shared list, so the panel follows.
        ctx.dom.document.getElementById("nhdw-clear-selected").dispatch("click");
        if (ctx.localStore.allIds.length !== 0) {
            fail("Clear must empty the shared allIds list, got " + JSON.stringify(ctx.localStore.allIds));
        }
        for (const box of cardControls(ctx.dom)) {
            if (box.querySelector(".nhdw-select-box").checked) {
                fail("Clear must untick every card's Select box");
            }
        }
        console.log("PASS: Clear still empties the shared selection");
    }

    // --- 14. a foreign site's selection is never read (item 64b review) -----
    // allIdsSite namespaces the transient selection. StorageArea.get answers
    // ONLY the keys a caller names, so reading allIdsSite without requesting it
    // leaves the guard dead: this fixture stores a hentaifox selection and
    // loads a nhentai page, which must therefore show NOTHING selected (the
    // sibling scripts - content.ts, preview.ts, titleBookmark.ts - all ask for
    // the key explicitly).
    {
        const ctx = run({ store: { allIds: ["173098"], allIdsSite: "hentaifox" } });
        await wait(0);
        const count = ctx.dom.document.getElementById("nhdw-count");
        if (!count || count.textContent !== "0 selected") {
            fail("another site's selection must not appear on this page, got " + (count && count.textContent));
        }
        for (const box of cardControls(ctx.dom)) {
            if (box.querySelector(".nhdw-select-box").checked) {
                fail("no card may start ticked from another site's selection");
            }
        }
        console.log("PASS: a selection stamped with another site is never read here (item 64b)");
    }

    console.log("PASS: in-page listing card controls behave correctly.");
})();
