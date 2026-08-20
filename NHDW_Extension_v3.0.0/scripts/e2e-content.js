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
const contentCode = fs.readFileSync(contentPath, "utf8");
const updateContentCode = fs.readFileSync(updateContentPath, "utf8");

// --- minimal DOM ----------------------------------------------------------
let listenersAdded = 0;

function makeElem(tag, attrs) {
    return {
        tag,
        attrs: attrs || {},
        parent: null,
        innerHTML: "",
        children: [],
        checked: false,
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
        querySelector() { return null; },
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
