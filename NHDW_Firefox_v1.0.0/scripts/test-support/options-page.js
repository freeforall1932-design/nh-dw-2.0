// Small, deliberately limited DOM/WebExtension model for the options bundle.
// Parse the REAL options.html; never invent missing elements or option lists.
// This is wiring coverage, not a renderer, CSS engine or browser substitute.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(root, "options.html"), "utf8");
const copy = (value) => structuredClone(value);

function decode(text) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
        if (entity[0] !== "#") return entities[entity.toLowerCase()];
        return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === "x" ? 2 : 1),
            entity[1].toLowerCase() === "x" ? 16 : 10));
    });
}

class TestEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.cancelable = !!init.cancelable;
        this.defaultPrevented = false;
        Object.assign(this, init);
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}

function descendants(node) {
    return node.childNodes.flatMap((child) => [child, ...descendants(child)]);
}

function makeDocument(track) {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase();
            this.nodeType = 1;
            this.childNodes = [];
            this.parentElement = null;
            this.attributes = Object.create(null);
            this.style = {};
            this.listeners = new Map();
            this._value = undefined;
            this._checked = false;
            this.disabled = false;
            this.hidden = false;
            // undefined = the HTML single-select default; null = explicitly
            // unselected (e.g. assigning an unknown value or selectedIndex=-1).
            this._selected = undefined;
        }
        get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
        get id() { return this.attributes.id || ""; }
        set id(value) { this.attributes.id = String(value); }
        get type() { return this.attributes.type || (this.tagName === "INPUT" ? "text" : ""); }
        set type(value) { this.attributes.type = String(value); }
        get placeholder() { return this.attributes.placeholder || ""; }
        set placeholder(value) { this.attributes.placeholder = String(value); }
        get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
        set textContent(value) {
            for (const child of this.childNodes) child.parentElement = null;
            this.childNodes = [];
            if (value !== "" && value != null) this.appendChild(document.createTextNode(String(value)));
        }
        get checked() { return this._checked; }
        set checked(value) { this._checked = !!value; }
        get options() {
            return this.tagName === "SELECT"
                ? descendants(this).filter((node) => node.tagName === "OPTION") : undefined;
        }
        selectedOption() {
            const options = this.options;
            if (this._selected === undefined) {
                return options.filter((option) => option.hasAttribute("selected")).at(-1) || options[0] || null;
            }
            return options.includes(this._selected) ? this._selected : null;
        }
        get selectedIndex() { return this.options.indexOf(this.selectedOption()); }
        set selectedIndex(value) { this._selected = this.options[Number(value)] || null; }
        get selected() {
            const select = this.ownerSelect();
            return !!select && select.selectedOption() === this;
        }
        set selected(value) {
            const select = this.ownerSelect();
            if (select && value) select._selected = this;
            else if (select && select._selected === this) select._selected = null;
        }
        ownerSelect() {
            let parent = this.parentElement;
            while (parent && parent.tagName !== "SELECT") parent = parent.parentElement;
            return parent;
        }
        get value() {
            if (this.tagName === "SELECT") return this.selectedOption()?.value || "";
            if (this.tagName === "OPTION") return this.attributes.value ?? this.textContent.trim();
            return this._value ?? this.attributes.value ?? "";
        }
        set value(value) {
            const text = String(value == null ? "" : value);
            if (this.tagName === "SELECT") this._selected = this.options.find((option) => option.value === text) || null;
            else if (this.tagName === "OPTION") this.attributes.value = text;
            else this._value = text;
        }
        hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
        getAttribute(name) { return this.hasAttribute(name) ? this.attributes[name] : null; }
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name === "checked") this.checked = true;
            if (name === "disabled") this.disabled = true;
            if (name === "hidden") this.hidden = true;
            if (name === "style") {
                for (const declaration of String(value).split(";")) {
                    const [property, ...rest] = declaration.split(":");
                    if (rest.length) this.style[property.trim()] = rest.join(":").trim();
                }
            }
        }
        appendChild(child) {
            if (child.parentElement) child.parentElement.removeChild(child);
            this.childNodes.push(child);
            child.parentElement = this;
            return child;
        }
        removeChild(child) {
            const index = this.childNodes.indexOf(child);
            assert.notEqual(index, -1, "removeChild requires an attached child");
            const select = child.tagName === "OPTION" ? child.ownerSelect() : null;
            const selected = select && select.selectedOption() === child;
            this.childNodes.splice(index, 1);
            child.parentElement = null;
            if (selected) select._selected = undefined;
            return child;
        }
        remove() { if (this.parentElement) this.parentElement.removeChild(this); }
        addEventListener(type, handler) {
            const listeners = this.listeners.get(type) || [];
            listeners.push(handler);
            this.listeners.set(type, listeners);
        }
        dispatchEvent(event) {
            event.target = this;
            event.currentTarget = this;
            for (const handler of (this.listeners.get(event.type) || []).slice()) {
                // Browser listeners declared with function() receive the
                // element as `this`. Select.update depends on that binding.
                track(handler.call(this, event));
            }
            return !event.defaultPrevented;
        }
        click() {
            if (!this.disabled) this.dispatchEvent(new TestEvent("click", { cancelable: true }));
        }
    }

    const document = {
        childNodes: [],
        readyState: "complete",
        createElement(tag) { return new Element(tag); },
        createTextNode(text) {
            return { nodeType: 3, textContent: String(text), childNodes: [], parentElement: null };
        },
        getElementById(id) { return descendants(this).find((node) => node.id === id) || null; },
        getElementsByTagName(tag) { return descendants(this).filter((node) => node.tagName === tag.toUpperCase()); }
    };

    const stack = [document];
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi) || [];
    for (const token of tokens) {
        if (token.startsWith("<!")) continue;
        if (token.startsWith("</")) {
            const tag = /^<\/([\w-]+)/.exec(token)[1].toUpperCase();
            assert.equal(stack.at(-1).tagName, tag, "unsupported/mismatched markup in options.html");
            stack.pop();
            continue;
        }
        let node;
        if (token.startsWith("<")) {
            const [, tag, attrs] = /^<([\w-]+)([\s\S]*?)\/?\s*>$/.exec(token);
            node = document.createElement(tag);
            for (const match of attrs.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                node.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ""));
            }
            const parent = stack.at(-1);
            if (parent === document) document.childNodes.push(node);
            else parent.appendChild(node);
            if (!voidTags.has(tag.toLowerCase()) && !token.endsWith("/>")) stack.push(node);
        } else {
            node = document.createTextNode(decode(token));
            if (stack.at(-1) === document) document.childNodes.push(node);
            else stack.at(-1).appendChild(node);
        }
    }
    assert.equal(stack.length, 1, "unclosed markup in options.html");
    document.documentElement = document.getElementsByTagName("html")[0];
    document.body = document.getElementsByTagName("body")[0];
    assert.ok(document.documentElement && document.body);
    assert.ok(document.getElementsByTagName("script").some((node) => node.getAttribute("src") === "js/options.js"),
        "options.html must load the bundle this harness exercises");
    return document;
}

function createOptionsPage(code, config = {}) {
    const sync = copy(config.sync || {});
    const local = copy(config.local || {});
    const writes = [];
    const reads = [];
    const fetches = [];
    const confirmations = [];
    const callbacks = [];
    const pending = new Set();
    const errors = [];
    function track(result) {
        if (!result || typeof result.then !== "function") return;
        const promise = Promise.resolve(result).catch((error) => errors.push(error)).finally(() => pending.delete(promise));
        pending.add(promise);
    }
    const document = makeDocument(track);
    function area(name, store) {
        return {
            get(keys, callback) {
                const request = copy(keys);
                reads.push({ area: name, keys: request });
                // Truly asynchronous: options.ts registers this read BEFORE
                // declaring TEMPLATE_LABELS. Also honor earlier queued writes,
                // rather than snapshotting stale values at get() call time.
                callbacks.push(() => {
                    const answer = {};
                    const names = request == null ? Object.keys(store) : typeof request === "string" ? [request]
                        : Array.isArray(request) ? request : Object.keys(request);
                    for (const key of names) {
                        if (Object.hasOwn(store, key)) answer[key] = copy(store[key]);
                        else if (request && typeof request === "object" && !Array.isArray(request)) answer[key] = copy(request[key]);
                    }
                    track(callback(answer));
                });
            },
            set(items, callback) {
                const values = copy(items);
                writes.push({ area: name, operation: "set", values });
                callbacks.push(() => { Object.assign(store, values); if (callback) track(callback()); });
            },
            remove(keys, callback) {
                const names = Array.isArray(keys) ? Array.from(keys) : [keys];
                writes.push({ area: name, operation: "remove", keys: names });
                callbacks.push(() => { for (const key of names) delete store[key]; if (callback) track(callback()); });
            },
            clear() { throw new Error("options must never clear a whole storage area"); }
        };
    }
    const chrome = {
        storage: { sync: area("sync", sync), local: area("local", local) },
        runtime: { lastError: null },
        // No sidePanel on Firefox; a capability fixture tests the guarded path.
        ...(config.sidePanel ? { sidePanel: config.sidePanel } : {})
    };
    const sandbox = {
        document, chrome, console, Event: TestEvent,
        confirm(question) { confirmations.push(question); return !!config.confirm; },
        fetch(url, init) {
            fetches.push({ url, init: copy(init) });
            if (config.fetch) return config.fetch(url, init);
            const error = new Error("Unexpected network request in offline options test: " + url);
            errors.push(error);
            return Promise.reject(error);
        }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(code, sandbox, { filename: "options.js", timeout: 5000 });
    return {
        document, chrome, sync, local, writes, reads, fetches, confirmations,
        el(id) {
            const node = document.getElementById(id);
            assert.ok(node, "expected real options-page element #" + id);
            return node;
        },
        async flush() {
            for (let turn = 0; turn < 50; turn++) {
                let count = 0;
                while (callbacks.length) {
                    assert.ok(++count < 1000, "storage callback loop");
                    callbacks.shift()();
                }
                await new Promise((resolve) => setImmediate(resolve));
                if (errors.length) throw errors[0];
                if (callbacks.length === 0 && pending.size === 0) return;
            }
            throw new Error("options callbacks did not settle (unresolved mock response or event-handler promise)");
        },
        async change(id, value) {
            const node = this.el(id);
            if (node.type === "checkbox") node.checked = value;
            else node.value = value;
            node.dispatchEvent(new TestEvent("change"));
            await this.flush();
        },
        async input(id, value) {
            const node = this.el(id);
            node.value = value;
            node.dispatchEvent(new TestEvent("input"));
            await this.flush();
        },
        async click(id) { this.el(id).click(); await this.flush(); }
    };
}

module.exports = { createOptionsPage, makeDocument, TestEvent };
