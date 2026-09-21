// Offline regressions for PR #44's real worker wiring, not just its pure
// toolbar helper. Storage reads are key-scoped and browser API failures are
// delivered through lastError, as they are in the callback WebExtension API.
// Usage: node scripts/e2e-embedded-toolbar.js [path/to/background.js]
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bundle = process.argv[2] || path.join(__dirname, "..", "js", "background.js");
const code = fs.readFileSync(bundle, "utf8");
const manifest = require("../manifest.json");
const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
const site = { id: 7, url: "https://nhentai.net/g/111111/", active: true };
const other = { id: 8, url: "https://example.com/", active: false };

function boot(options = {}) {
    const activeTab = options.fullPanel ? { id: 99, url: "moz-extension://review/index.html?sourceTabId=7" } : site;
    const sourceTab = options.sourceTab === undefined ? site : options.sourceTab;
    const sync = { ...options.sync };
    const local = { nhdwMobileDevice: !!options.mobile };
    const storageListeners = [];
    const clickListeners = [];
    const messageListeners = [];
    const updatedListeners = [];
    const popups = [];
    const injected = [];
    const tabMessages = [];
    const createdTabs = [];
    let scriptLoaded = false;
    let chrome;
    function area(store) {
        return {
            get(keys, callback) {
                const names = keys == null ? Object.keys(store)
                    : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
                const answer = {};
                for (const key of names) {
                    if (Object.hasOwn(store, key)) answer[key] = store[key];
                    else if (keys && typeof keys === "object" && !Array.isArray(keys)) answer[key] = keys[key];
                }
                callback(answer);
            },
            set(values, callback) { Object.assign(store, values); if (callback) callback(); },
            remove(key, callback) { delete store[key]; if (callback) callback(); }
        };
    }
    function reply(callback, value, fail) {
        chrome.runtime.lastError = fail ? { message: "Browser refused the operation" } : null;
        if (callback) callback(value);
        chrome.runtime.lastError = null;
    }
    chrome = {
        tabs: {
            query(query, callback) { callback(query.active ? [activeTab] : [site, other]); },
            get(id, callback) { reply(callback, id === 7 ? sourceTab : undefined, !sourceTab); },
            onUpdated: { addListener(fn) { updatedListeners.push(fn); } },
            onActivated: { addListener() {} },
            sendMessage(id, message, callback) {
                tabMessages.push({ id, message });
                reply(callback, { ok: !options.missingContent || scriptLoaded }, false);
            },
            create(details, callback) {
                createdTabs.push(details);
                reply(callback, options.failCreate ? undefined : { id: 90, ...details }, options.failCreate);
            }
        },
        action: {
            setPopup(details) { popups.push(details); },
            setIcon() {},
            onClicked: { addListener(fn) { clickListeners.push(fn); } }
        },
        storage: {
            sync: area(sync), local: area(local), session: area({}),
            onChanged: { addListener(fn) { storageListeners.push(fn); } }
        },
        runtime: {
            lastError: null,
            getURL(file) { return "moz-extension://review/" + file; },
            getManifest() { return manifest; },
            onMessage: { addListener(fn) { messageListeners.push(fn); } },
            sendMessage(_message, callback) { if (callback) callback(); }
        },
        scripting: {
            insertCSS(details, callback) {
                injected.push({ kind: "css", details });
                reply(callback, undefined, options.failCss);
            },
            executeScript(details, callback) {
                if (details.func) {
                    injected.push({ kind: "metadata", details });
                    reply(callback, [{ result: {
                        id: 111111, media_id: 123, num_pages: 1, tags: [],
                        title: { pretty: "Fixture", english: "Fixture", japanese: "" },
                        images: { pages: [{ t: "j", w: 10, h: 10 }], thumbnail: { t: "j" }, cover: { t: "j" } }
                    } }], false);
                    return;
                }
                injected.push({ kind: "js", details });
                scriptLoaded = !options.failScript;
                reply(callback, [], options.failScript);
            }
        },
        downloads: {
            onChanged: { addListener() {} },
            onDeterminingFilename: { addListener() {}, removeListener() {} }
        },
        alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} }
    };
    const sandbox = {
        chrome, console, URL,
        setTimeout(fn, delay) { return setTimeout(fn, Math.min(delay, 5)); },
        clearTimeout,
        fetch: () => Promise.reject(new Error("offline toolbar test"))
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox, { filename: bundle });
    function request(message, sender = { tab: site }) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve({ timeout: true }), 100);
            for (const listener of messageListeners) {
                listener(message, sender, (answer) => {
                    clearTimeout(timeout);
                    resolve(answer);
                });
            }
        });
    }
    return {
        popups, injected, tabMessages, createdTabs,
        popupFor(id) { return popups.filter((entry) => entry.tabId === id).at(-1)?.popup; },
        async click(tab = site) {
            assert.equal(clickListeners.length, 1);
            clickListeners[0](tab);
            await wait();
        },
        changeSync(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                changes[key] = { oldValue: sync[key], newValue: value };
                sync[key] = value;
            }
            for (const listener of storageListeners) listener(changes, "sync");
        },
        update(tab) { for (const fn of updatedListeners) fn(tab.id, { url: tab.url }, tab); },
        request,
        requestPanel(sender) { return request({ action: "siteUiOpenPanel" }, sender); }
    };
}

test("worker honors explicit desktop ON and phone OFF toolbar preferences", () => {
    const desktop = boot({ sync: { toolbarOpensEmbedded: true } });
    assert.equal(desktop.popupFor(7), "");
    assert.equal(desktop.popupFor(8), "index.html");
    const phone = boot({ mobile: true, sync: { toolbarOpensEmbedded: false } });
    assert.equal(phone.popupFor(7), "index.html");
});

test("worker follows the device only when the override is unset, and disable wins", () => {
    assert.equal(boot().popupFor(7), "index.html");
    assert.equal(boot({ mobile: true }).popupFor(7), "");
    assert.equal(boot({ mobile: true, sync: { embeddedUi: false, toolbarOpensEmbedded: true } }).popupFor(7), "index.html");
});

test("preference changes and navigation refresh per-tab popups", () => {
    const ctx = boot();
    ctx.changeSync({ toolbarOpensEmbedded: true });
    assert.equal(ctx.popupFor(7), "");
    ctx.update({ ...site, url: "https://example.com/" });
    assert.equal(ctx.popupFor(7), "index.html");
    ctx.changeSync({ toolbarOpensEmbedded: false });
    assert.equal(ctx.popupFor(7), "index.html");
});

test("existing content script is toggled without reinjecting", async () => {
    const ctx = boot({ mobile: true });
    await ctx.click();
    assert.equal(ctx.tabMessages.length, 1);
    assert.equal(ctx.tabMessages[0].message.action, "siteUiToggle");
    assert.equal(ctx.injected.length, 0);
    assert.equal(ctx.createdTabs.length, 0);
});

test("on-demand injection loads the manifest's CSS before the site UI bundle", async () => {
    const ctx = boot({ mobile: true, missingContent: true });
    await ctx.click();
    assert.deepEqual(ctx.injected.map((entry) => entry.kind), ["css", "js"]);
    assert.deepEqual(Array.from(ctx.injected[0].details.files), manifest.content_scripts[0].css);
    assert.deepEqual(Array.from(ctx.injected[1].details.files), ["js/siteUi.js"]);
    assert.equal(ctx.injected[0].details.target.tabId, 7);
    assert.equal(ctx.tabMessages.at(-1).message.open, true);
    assert.equal(ctx.createdTabs.length, 0);
});

test("failed CSS injection falls back instead of opening an unstyled drawer", async () => {
    const ctx = boot({ mobile: true, missingContent: true, failCss: true });
    await ctx.click();
    assert.equal(ctx.injected.some((entry) => entry.kind === "js"), false);
    assert.equal(ctx.createdTabs.length, 1);
});

test("Full panel and toolbar fallback carry the originating nhentai tab", async () => {
    const ctx = boot({ mobile: true, missingContent: true, failScript: true });
    const answer = await ctx.requestPanel();
    assert.equal(answer.ok, true);
    assert.equal(new URL(ctx.createdTabs[0].url).searchParams.get("sourceTabId"), "7");
    await ctx.click();
    assert.equal(new URL(ctx.createdTabs.at(-1).url).searchParams.get("sourceTabId"), "7");
    await ctx.requestPanel({ tab: other });
    assert.equal(new URL(ctx.createdTabs.at(-1).url).searchParams.has("sourceTabId"), false);
});

test("Full panel reports a tabs.create failure instead of false success", async () => {
    const ctx = boot({ failCreate: true });
    const answer = await ctx.requestPanel();
    assert.equal(answer.ok, false);
});


test("bookmark enrichment from Full panel uses its pinned source, not the active extension tab", async () => {
    const ctx = boot({ fullPanel: true });
    await ctx.request({ action: "bookmarkAdd", items: [{ id: "111111", source: "paste" }] });
    const answer = await ctx.request({ action: "bookmarkEnrich", ids: ["111111"] }, {
        url: "moz-extension://review/index.html?sourceTabId=7",
        tab: { id: 99, url: "moz-extension://review/index.html?sourceTabId=7" }
    });
    assert.equal(answer.resolved, 1);
    assert.equal(answer.skipped, false);
    assert.equal(ctx.injected.find((entry) => entry.kind === "metadata")?.details.target.tabId, 7);
});

test("bookmark enrichment refuses a pinned source that navigated to another site", async () => {
    const ctx = boot({ fullPanel: true, sourceTab: { id: 7, url: "https://example.com/" } });
    const answer = await ctx.request({ action: "bookmarkEnrich", ids: ["111111"] }, {
        url: "moz-extension://review/index.html?sourceTabId=7"
    });
    assert.equal(answer.skipped, true);
    assert.equal(answer.resolved, 0);
    assert.equal(ctx.injected.length, 0);
});

test("a toolbar click racing a disable event still opens the fallback", async () => {
    const ctx = boot({ mobile: true });
    // onClicked was already dispatched under the old popup:"" state, but the
    // async settings read sees the newer disabled state.
    ctx.changeSync({ embeddedUi: false });
    await ctx.click();
    assert.equal(ctx.createdTabs.length, 1);
    assert.equal(ctx.tabMessages.length, 0);
});
