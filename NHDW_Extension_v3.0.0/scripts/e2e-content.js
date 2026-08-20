// Content script test: load the built js/content.js and js/updateContent.js in
// a window-less VM with a minimal DOM stub that mirrors nhentai's card markup
// (the caption div sits INSIDE the gallery cover link) and verify:
//   - checkboxes are injected into each caption with the right gallery ID
//     (via closest() ancestor lookup, matching the real DOM shape)
//   - a single-gallery page without caption cards does not crash the script
//     (regression test for the old captions[0]-undefined bug)
//   - updateContent re-syncs the checkbox state from storage
//
// Usage:  node scripts/e2e-content.js [path/to/js/content.js] [path/to/js/updateContent.js]
// Exit code 0 = all checks passed.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const contentPath = process.argv[2] || path.join(__dirname, "..", "js", "content.js");
const updateContentPath = process.argv[3] || path.join(__dirname, "..", "js", "updateContent.js");
const getGalleriesPath = process.argv[4] || path.join(__dirname, "..", "js", "getGalleries.js");
const contentCode = fs.readFileSync(contentPath, "utf8");
const updateContentCode = fs.readFileSync(updateContentPath, "utf8");
const getGalleriesCode = fs.readFileSync(getGalleriesPath, "utf8");

// --- minimal DOM ----------------------------------------------------------
let listenersAdded = 0;

function collect(node, out, pred) {
    for (const child of node.children) {
        if (pred(child)) out.push(child);
        collect(child, out, pred);
    }
}

function makeElem(tag, attrs) {
    return {
        tag,
        attrs: attrs || {},
        parent: null,
        innerHTML: "",
        children: [],
        checked: false,
        textContent: "",
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
        querySelector(selector) {
            if (selector === ".caption") {
                return this.children.find(c => c.tag === "div" && String(c.attrs.class || "").includes("caption")) || null;
            }
            if (selector === ".current") {
                return this.children.find(c => String(c.attrs.class || "").includes("current")) || null;
            }
            return null;
        },
        querySelectorAll(selector) {
            const out = [];
            if (selector === 'a[href*="/g/"]') {
                collect(this, out, n => n.tag === "a" && String(n.attrs.href || "").includes("/g/"));
            } else if (selector === 'a[href*="page="]') {
                collect(this, out, n => n.tag === "a" && String(n.attrs.href || "").includes("page="));
            }
            return out;
        },
        closest(selector) {
            let node = this;
            while (node) {
                if (matchesSelector(node, selector)) return node;
                node = node.parent;
            }
            return null;
        },
        addEventListener() { listenersAdded++; },
        appendChild(child) { child.parent = this; this.children.push(child); }
    };
}

function matchesSelector(node, selector) {
    // Only the selectors the extension uses: 'a[href*="/g/"]'
    const m = /^a\[href\*=/.exec(selector);
    if (!m) return false;
    return node.tag === "a" && String(node.getAttribute("href") || "").includes("/g/");
}

// Build a listing document with 3 nhentai-style cards.
function makeListingDocument() {
    const body = makeElem("body");
    const container = makeElem("div", { class: "container" });
    body.appendChild(container);
    const captions = [];
    ["111111", "222222", "333333"].forEach((id) => {
        const gallery = makeElem("div", { class: "gallery" });
        const cover = makeElem("a", { href: `/g/${id}/`, class: "cover" });
        const img = makeElem("img");
        const caption = makeElem("div", { class: "caption" });
        cover.appendChild(img);
        cover.appendChild(caption);
        gallery.appendChild(cover);
        container.appendChild(gallery);
        captions.push(caption);
    });
    return { document: { body, getElementsByClassName: () => captions }, captions };
}

// Single gallery page: no caption cards at all.
function makeGalleryDocument() {
    return { document: { getElementsByClassName: () => [] }, captions: [] };
}

function runBundle(code, doc, settings) {
    const checkboxById = new Map();
    const chromeStub = {
        storage: {
            sync: { get(defaults, cb) { cb(Object.assign({}, defaults, settings || {})); } },
            local: {
                get(defaults, cb) {
                    cb(Object.assign({}, defaults, { allIds: [], lastUrl: "" }));
                },
                set() {}
            }
        },
        runtime: { onMessage: { addListener() {} } }
    };
    const sandbox = {
        chrome: chromeStub,
        console,
        setTimeout,
        clearTimeout,
        location: { href: "https://nhentai.net/" },
        document: Object.assign(doc.document, {
            getElementById(id) {
                if (!checkboxById.has(id)) {
                    const el = makeElem("input", { id });
                    checkboxById.set(id, el);
                }
                return checkboxById.get(id);
            }
        })
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: path.basename(code === contentCode ? contentPath : updateContentPath) });
    return { checkboxById, listenersBefore: listenersAdded };
}

// --- content.js -----------------------------------------------------------
console.log("== content.js ==");
{
    const { document, captions } = makeListingDocument();
    runBundle(contentCode, { document });
    const expected = ["111111", "222222", "333333"];
    for (let i = 0; i < expected.length; i++) {
        if (!captions[i].innerHTML.includes(`id="${expected[i]}"`)) {
            console.error(`FAIL: caption ${i} did not receive checkbox id ${expected[i]}`);
            process.exit(1);
        }
    }
    if (listenersAdded !== 3) {
        console.error(`FAIL: expected 3 checkbox listeners, got ${listenersAdded}`);
        process.exit(1);
    }
    console.log("PASS: 3 captions got checkboxes with the right gallery IDs (closest() lookup)");
    console.log("PASS: 3 change listeners registered");
}

{
    const { document } = makeGalleryDocument();
    try {
        runBundle(contentCode, { document });
        console.log("PASS: single-gallery page (no .caption) does not crash");
    } catch (e) {
        console.error("FAIL: content script crashed on a single-gallery page: " + e.message);
        process.exit(1);
    }
}

// --- getGalleries.js ------------------------------------------------------
console.log("== getGalleries.js ==");
{
    const body = makeElem("body");
    const container = makeElem("div", { class: "container" });
    body.appendChild(container);
    const rawTitles = [
        "Title One",
        "It&apos;s &quot;Quoted&quot; &amp; Fine",
        "Title Three"
    ];
    ["111111", "222222", "333333"].forEach((id, idx) => {
        const gallery = makeElem("div", { class: "gallery" });
        const cover = makeElem("a", { href: `/g/${id}/`, class: "cover" });
        const caption = makeElem("div", { class: "caption" });
        // Mirror the injected-checkbox markup content.ts adds after the title.
        caption.innerHTML = rawTitles[idx] + `<br/><br/><input id="${id}" type="checkbox"> NHentai Downloader:`;
        cover.appendChild(caption);
        gallery.appendChild(cover);
        container.appendChild(gallery);
    });
    // A duplicate card for the same gallery must be skipped by id.
    const dupGallery = makeElem("div", { class: "gallery" });
    const dupCover = makeElem("a", { href: "/g/222222/", class: "cover" });
    const dupCaption = makeElem("div", { class: "caption" });
    dupCaption.innerHTML = "Duplicate card";
    dupCover.appendChild(dupCaption);
    dupGallery.appendChild(dupCover);
    container.appendChild(dupGallery);

    // Pagination: current page is a <span class="current">, max is the last link.
    const pagination = makeElem("section", { class: "pagination" });
    const page1 = makeElem("a", { href: "?page=1" });
    page1.textContent = "1";
    const current = makeElem("span", { class: "current" });
    current.textContent = "3";
    const last = makeElem("a", { href: "?page=20", class: "last" });
    last.textContent = "Last";
    pagination.appendChild(page1);
    pagination.appendChild(current);
    pagination.appendChild(last);
    body.appendChild(pagination);

    const sent = [];
    const chromeStub = {
        runtime: { sendMessage(msg) { sent.push(msg); } },
        storage: { sync: { get() {} }, local: { get() {}, set() {} } }
    };
    const sandbox = {
        chrome: chromeStub,
        console,
        document: {
            querySelectorAll(sel) {
                if (sel === 'a[href*="/g/"]') {
                    const out = [];
                    collect(body, out, n => n.tag === "a" && String(n.attrs.href || "").includes("/g/"));
                    return out;
                }
                return [];
            },
            querySelector(sel) {
                if (sel === ".pagination") return pagination;
                return null;
            }
        }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(getGalleriesCode, sandbox, { filename: "getGalleries.js" });

    if (sent.length !== 1 || sent[0].action !== "getGalleries") {
        console.error("FAIL: getGalleries did not send exactly one getGalleries message, got " + JSON.stringify(sent));
        process.exit(1);
    }
    const msg = sent[0];
    if (msg.galleries.length !== 3) {
        console.error("FAIL: expected 3 unique galleries, got " + msg.galleries.length +
            " (" + JSON.stringify(msg.galleries) + ")");
        process.exit(1);
    }
    const [a, b, c] = msg.galleries;
    if (a.id !== "111111" || a.title !== "Title One") {
        console.error("FAIL: first gallery mismatch: " + JSON.stringify(a));
        process.exit(1);
    }
    if (b.id !== "222222" || b.title !== 'It\'s "Quoted" & Fine') {
        console.error("FAIL: quoted/entity title mismatch (id/title pair must stay intact): " + JSON.stringify(b));
        process.exit(1);
    }
    if (c.id !== "333333" || c.title !== "Title Three") {
        console.error("FAIL: third gallery mismatch: " + JSON.stringify(c));
        process.exit(1);
    }
    if (msg.currentPage !== 3 || msg.maxPage !== 20) {
        console.error("FAIL: pagination mismatch, got currentPage=" + msg.currentPage + " maxPage=" + msg.maxPage);
        process.exit(1);
    }
    console.log("PASS: getGalleries extracts unique cards from the DOM with decoded titles + pagination");
}

// --- updateContent.js -----------------------------------------------------
console.log("== updateContent.js ==");
{
    const { document, captions } = makeListingDocument();
    // Inject checkboxes first (as content.js does), then run updateContent.
    captions.forEach((c, i) => { c.innerHTML = `<input id="${["111111", "222222", "333333"][i]}" type="checkbox">`; });
    let checkboxById;
    runBundle(contentCode, { document }); // registers the elements
    const { checkboxById: boxes } = runBundle(updateContentCode, { document });
    checkboxById = boxes;
    // updateContent runs with allIds=[] by default in the stub, so everything
    // must be unchecked after the run.
    for (const id of ["111111", "222222", "333333"]) {
        if (checkboxById.get(id).checked !== false) {
            console.error(`FAIL: updateContent left checkbox ${id} checked despite empty storage`);
            process.exit(1);
        }
    }
    console.log("PASS: updateContent syncs checkbox state for every caption without crashing");
}

console.log("PASS: content script suites passed.");
process.exit(0);
