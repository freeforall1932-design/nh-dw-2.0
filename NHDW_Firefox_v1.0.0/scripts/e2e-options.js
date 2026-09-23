// Item 38: execute the BUILT options bundle against the REAL options.html.
// No browser, network, credentials, extra dependencies or application exports.
// Run after npm run build:
//   node scripts/e2e-options.js [path/to/options.js]
// The optional bundle argument lets regressions run against a pre-fix build.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createOptionsPage, makeDocument, TestEvent } = require("./test-support/options-page");

const bundlePath = process.argv[2] || path.join(__dirname, "..", "js", "options.js");
const code = fs.readFileSync(bundlePath, "utf8");
const choices = {
    useZip: ["zip", "cbz", "pdf", "raw"],
    listFormat: ["zip", "cbz", "pdf", "raw"],
    duplicateBehaviour: ["rename", "ignore"],
    maxConcurrentDownloads: ["1", "3", "5", "10", "15"],
    rawMaxConcurrent: ["1", "2", "3", "5", "10"],
    listOutputMode: ["separate", "batch"]
};
const checkboxDefaults = {
    displayCheckbox: true, darkMode: false, downloadSeparately: false,
    replaceSpaces: true, htmlParsing: false, listMasterFolder: true,
    inPageControls: true, verifyDownloadedFiles: true, batchNameDate: true
};
const tokens = ["pretty", "english", "japanese", "id", "group", "artist", "character", "language"];
const fakeKey = "options-fixture-not-a-real-key";
const history = {
    "111111": { filename: "NHDW/One.zip", when: 1 },
    "nhentai:222222": { filename: "NHDW/Two.cbz", when: 2 }
};

async function page(config) {
    const ctx = createOptionsPage(code, config);
    await ctx.flush();
    return ctx;
}
function selected(ctx, id, value) {
    const select = ctx.el(id);
    assert.equal(select.value, value, id + " displayed value");
    assert.equal(select.selectedIndex, select.options.findIndex((option) => option.value === value), id + " selectedIndex");
    assert.ok(select.selectedIndex >= 0, id + " must select a real option");
    assert.equal(select.options[select.selectedIndex].selected, true);
}
function onlySet(ctx, area, key, value) {
    assert.deepEqual(ctx.writes, [{ area, operation: "set", values: { [key]: value } }]);
    assert.deepEqual(ctx[area][key], value);
}
function preview(ctx) { return ctx.el("listDownloadNamePreview").textContent; }

// Verify the stub contracts before trusting its application-level evidence.
test("DOM fixture uses real markup, real option lists, and no auto-created ids", () => {
    const doc = makeDocument(() => {});
    for (const [id, values] of Object.entries(choices)) {
        assert.deepEqual(doc.getElementById(id).options.map((option) => option.value), values);
    }
    assert.equal(doc.getElementById("not-a-real-control"), null);
    assert.equal(doc.getElementById("downloadNameAdvanced").style.display, "none");
    const detached = doc.createElement("input");
    detached.id = "detached-fixture";
    assert.equal(doc.getElementById(detached.id), null);
    doc.body.appendChild(detached);
    assert.ok(doc.getElementById(detached.id) === detached);
    detached.remove();
    assert.equal(doc.getElementById(detached.id), null);
});

test("select model keeps value, selectedIndex and option.selected in agreement", () => {
    const select = makeDocument(() => {}).getElementById("useZip");
    assert.equal(select.value, "zip");
    assert.equal(select.selectedIndex, 0);
    select.selectedIndex = 2;
    assert.equal(select.value, "pdf");
    assert.equal(select.options[2].selected, true);
    assert.equal(select.options[0].selected, false);
    select.value = "raw";
    assert.equal(select.selectedIndex, 3);
    select.value = "not-an-option";
    assert.equal(select.value, "");
    assert.equal(select.selectedIndex, -1);
    select.options[1].selected = true;
    assert.equal(select.value, "cbz");
    select.options[1].remove();
    assert.equal(select.value, "zip");
    select.selectedIndex = -1;
    assert.equal(select.value, "");
    let receiver;
    select.addEventListener("change", function(event) { receiver = this; assert.ok(event.target === select); });
    select.dispatchEvent(new TestEvent("change"));
    assert.ok(receiver === select, "listener this-binding is required by Select.update");
});

test("storage model is asynchronous, key-scoped and clone-isolated", async () => {
    const ctx = createOptionsPage("", { sync: { chosen: { n: 1 }, unrequested: true } });
    let answer;
    ctx.chrome.storage.sync.get({ chosen: null, absent: 3 }, (value) => { answer = value; });
    assert.equal(answer, undefined);
    await ctx.flush();
    assert.deepEqual(answer, { chosen: { n: 1 }, absent: 3 });
    answer.chosen.n = 9;
    assert.equal(ctx.sync.chosen.n, 1);
    ctx.chrome.storage.sync.get(["unrequested"], (value) => { answer = value; });
    await ctx.flush();
    assert.deepEqual(answer, { unrequested: true });
    const values = { chosen: { n: 2 } };
    ctx.chrome.storage.sync.set(values);
    values.chosen.n = 7;
    ctx.chrome.storage.sync.get("chosen", (value) => { answer = value; });
    assert.equal(ctx.sync.chosen.n, 1, "set has not completed synchronously");
    await ctx.flush();
    assert.deepEqual(answer, { chosen: { n: 2 } }, "get follows the earlier queued set, with values cloned at submission");
    ctx.chrome.storage.sync.remove("chosen");
    ctx.chrome.storage.sync.get("chosen", (value) => { answer = value; });
    await ctx.flush();
    assert.deepEqual(answer, {}, "get follows the earlier queued removal");
    assert.equal(ctx.sync.unrequested, true);
});

test("opening a fresh options page renders defaults without writing either storage area", async () => {
    const ctx = await page();
    for (const [id, value] of Object.entries({ useZip: "zip", listFormat: "zip", duplicateBehaviour: "rename",
        maxConcurrentDownloads: "3", rawMaxConcurrent: "3", listOutputMode: "separate" })) selected(ctx, id, value);
    for (const [id, value] of Object.entries(checkboxDefaults)) assert.equal(ctx.el(id).checked, value, id);
    assert.equal(ctx.el("rawMasterFolder").value, "NHDW");
    assert.equal(ctx.el("listDownloadName").value, "");
    assert.match(ctx.el("listDownloadName").placeholder, /\{pretty\}/);
    assert.equal(preview(ctx), "Example: Downloads/NHDW/Sample_Title.zip");
    assert.match(ctx.el("historyStatus").textContent, /No downloads recorded/);
    assert.match(ctx.el("apiKeyStatus").textContent, /No API key saved/);
    assert.equal(ctx.el("useServerArchive").checked, false);
    assert.equal(ctx.el("apiKey").value, "");
    for (const token of tokens) assert.equal(ctx.el("template_" + token).checked, token === "pretty");
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(ctx.fetches, []);
    assert.deepEqual(ctx.sync, {});
    assert.deepEqual(ctx.local, {});
});

test("saved non-default controls restore without rewriting templates or other preferences", async () => {
    const sync = {
        useZip: "cbz", listFormat: "pdf", duplicateBehaviour: "ignore",
        maxConcurrentDownloads: "10", rawMaxConcurrent: "2", listOutputMode: "batch",
        rawMasterFolder: "Archive/Books", downloadName: "{id} - {pretty}",
        listDownloadName: "{artist} - {id}", unrelatedSetting: "keep",
        ...Object.fromEntries(Object.entries(checkboxDefaults).map(([id, value]) => [id, !value]))
    };
    const ctx = await page({ sync });
    for (const id of Object.keys(choices)) selected(ctx, id, sync[id]);
    for (const id of Object.keys(checkboxDefaults)) assert.equal(ctx.el(id).checked, sync[id], id);
    assert.equal(ctx.el("rawMasterFolder").value, sync.rawMasterFolder);
    assert.equal(ctx.el("listDownloadName").value, sync.listDownloadName);
    assert.match(preview(ctx), /Downloads\/<listing name>\.pdf/);
    assert.deepEqual(ctx.sync, sync);
    assert.deepEqual(ctx.writes, []);
});

test("every explicitly stored list format wins over every single-title format", async () => {
    for (const useZip of choices.useZip) {
        for (const listFormat of choices.listFormat) {
            const ctx = await page({ sync: { useZip, listFormat } });
            selected(ctx, "useZip", useZip);
            selected(ctx, "listFormat", listFormat);
            assert.ok(preview(ctx).endsWith(listFormat === "raw" ? "/001.jpg" : "." + listFormat), `${useZip} / ${listFormat}`);
            assert.deepEqual(ctx.writes, []);
        }
    }
});

test("unset or invalid list format inherits without materializing a saved override", async () => {
    for (const useZip of choices.useZip) {
        for (const extra of [{}, { listFormat: null }, { listFormat: "invalid" }]) {
            const sync = { useZip, ...extra };
            const ctx = await page({ sync });
            selected(ctx, "listFormat", useZip);
            assert.deepEqual(ctx.sync, sync);
            assert.deepEqual(ctx.writes, []);
        }
    }
});

test("legacy folder values display PDF in both selectors without migrating storage on load", async () => {
    for (const sync of [{ useZip: "folder" }, { useZip: "cbz", listFormat: "folder" }]) {
        const ctx = await page({ sync });
        selected(ctx, "useZip", sync.useZip === "folder" ? "pdf" : "cbz");
        selected(ctx, "listFormat", "pdf");
        assert.ok(preview(ctx).endsWith(".pdf"));
        assert.deepEqual(ctx.sync, sync);
        assert.deepEqual(ctx.writes, []);
    }
});

test("Firefox does not advertise the unsupported side panel or rewrite its stored preference", async () => {
    for (const sync of [{}, { uiMode: "sidepanel" }, { uiMode: "popup" }]) {
        const ctx = await page({ sync });
        assert.deepEqual(ctx.el("uiMode").options.map((option) => option.value), ["popup"]);
        selected(ctx, "uiMode", "popup");
        assert.deepEqual(ctx.sync, sync);
        assert.deepEqual(ctx.writes, []);
    }
});

test("the side-panel capability branch keeps supported choices", async () => {
    const ctx = await page({ sidePanel: { setPanelBehavior() {} } });
    assert.deepEqual(ctx.el("uiMode").options.map((option) => option.value), ["sidepanel", "popup"]);
    selected(ctx, "uiMode", "sidepanel");
    await ctx.change("uiMode", "popup");
    onlySet(ctx, "sync", "uiMode", "popup");
});

test("select change handlers persist real selected options, one key at a time", async () => {
    const ctx = await page({ sync: { useZip: "zip", listFormat: "zip", untouched: "keep" } });
    for (const [id, values] of Object.entries({ ...choices, uiMode: ["popup"] })) {
        for (const value of values) {
            ctx.writes.length = 0;
            const select = ctx.el(id);
            select.selectedIndex = select.options.findIndex((option) => option.value === value);
            select.dispatchEvent(new TestEvent("change"));
            await ctx.flush();
            onlySet(ctx, "sync", id, value);
        }
    }
    assert.equal(ctx.sync.untouched, "keep");
    const reopened = await page({ sync: ctx.sync });
    for (const id of Object.keys(choices)) selected(reopened, id, ctx.sync[id]);
    assert.deepEqual(reopened.writes, []);
});

test("checkbox changes persist true and false without clobbering sibling settings", async () => {
    const ctx = await page({ sync: { untouched: "keep" } });
    for (const id of Object.keys(checkboxDefaults)) {
        for (const checked of [true, false]) {
            ctx.writes.length = 0;
            await ctx.change(id, checked);
            onlySet(ctx, "sync", id, checked);
        }
    }
    assert.equal(ctx.sync.untouched, "keep");
});

test("an inherited list format follows single-title edits until explicitly overridden", async () => {
    const ctx = await page({ sync: { useZip: "zip" } });
    await ctx.change("useZip", "cbz");
    selected(ctx, "listFormat", "cbz");
    assert.ok(preview(ctx).endsWith(".cbz"));
    onlySet(ctx, "sync", "useZip", "cbz");
    assert.equal(Object.hasOwn(ctx.sync, "listFormat"), false);
    await ctx.change("listFormat", "pdf");
    ctx.writes.length = 0;
    await ctx.change("useZip", "raw");
    selected(ctx, "listFormat", "pdf");
    assert.ok(preview(ctx).endsWith(".pdf"));
    onlySet(ctx, "sync", "useZip", "raw");
    assert.equal(ctx.sync.listFormat, "pdf");
});

test("raw master folder changes trim input and allow an empty folder", async () => {
    const ctx = await page();
    await ctx.change("rawMasterFolder", "  Archive/Books  ");
    onlySet(ctx, "sync", "rawMasterFolder", "Archive/Books");
    assert.match(preview(ctx), /Downloads\/Archive\/Books\/Sample_Title\.zip/);
    ctx.writes.length = 0;
    await ctx.change("rawMasterFolder", "  ");
    onlySet(ctx, "sync", "rawMasterFolder", "");
    assert.equal(preview(ctx), "Example: Downloads/Sample_Title.zip");
});

test("list template typing is preview-only; change saves only that template or the inherit sentinel", async () => {
    const ctx = await page({ sync: { downloadName: "{pretty}", listDownloadName: "@inherit" } });
    await ctx.input("listDownloadName", "{id}");
    assert.match(preview(ctx), /123456\.zip$/);
    assert.deepEqual(ctx.writes, []);
    await ctx.change("listDownloadName", "{id}");
    onlySet(ctx, "sync", "listDownloadName", "{id}");
    assert.equal(ctx.sync.downloadName, "{pretty}");
    ctx.writes.length = 0;
    await ctx.change("listDownloadName", "  ");
    onlySet(ctx, "sync", "listDownloadName", "@inherit");
    assert.match(preview(ctx), /Sample_Title\.zip$/);
});

test("a canonical token template opens the tick boxes and only an explicit tick writes (item 41)", async () => {
    // Canonical = exactly what buildTemplate emits for its tokens: canonical
    // token order AND the " - " separator.
    const ctx = await page({ sync: { downloadName: "{pretty} - {id}" } });
    assert.equal(ctx.el("downloadNameAdvanced").style.display, "none");
    assert.equal(ctx.el("template_pretty").checked, true);
    assert.equal(ctx.el("template_id").checked, true);
    assert.deepEqual(ctx.writes, [], "opening a canonical template writes nothing");
    await ctx.change("template_language", true);
    onlySet(ctx, "sync", "downloadName", "{pretty} - {id} - {language}");
});

test("a token template with the user's OWN order or separator keeps the manual field (item 41)", async () => {
    // Before the gate, isTokenOnlyTemplate accepted both of these, so the first
    // tick of ANY box silently rewrote them ("{id} - {pretty}" ->
    // "{pretty} - {id} - {language}", "{pretty}_{id}" -> "{pretty} - {id} - ...").
    for (const stored of ["{id} - {pretty}", "{pretty}_{id}", "{pretty} {id}"]) {
        const ctx = await page({ sync: { downloadName: stored } });
        assert.equal(ctx.el("downloadNameChecks").style.display, "none", stored + ": boxes hidden");
        assert.equal(ctx.el("downloadNameAdvanced").style.display, "", stored + ": manual field shown");
        assert.equal(ctx.el("downloadName").value, stored, stored + ": stored verbatim in the field");
        assert.equal(ctx.document.getElementById("template_pretty"), null, stored + ": no tick box rendered");
        assert.deepEqual(ctx.writes, [], stored + ": opening writes nothing");
        assert.match(ctx.el("downloadNamePreview").textContent, /Custom template in use/);
    }
});

test("custom templates use the manual field and are saved verbatim only on change", async () => {
    const ctx = await page({ sync: { downloadName: "Collection {id}" } });
    assert.equal(ctx.el("downloadNameChecks").style.display, "none");
    assert.equal(ctx.el("downloadNameAdvanced").style.display, "");
    assert.equal(ctx.el("downloadName").value, "Collection {id}");
    assert.equal(ctx.document.getElementById("template_pretty"), null);
    await ctx.input("downloadName", "Custom / {pretty}");
    assert.deepEqual(ctx.writes, []);
    await ctx.change("downloadName", "Custom / {pretty}");
    onlySet(ctx, "sync", "downloadName", "Custom / {pretty}");
    assert.match(ctx.el("downloadNamePreview").textContent, /Custom \/ \{pretty\}/);
});

test("inherited list preview respects an intentionally empty single-title template", async () => {
    const ctx = await page({ sync: { downloadName: "", listDownloadName: "@inherit" } });
    assert.match(ctx.el("downloadNamePreview").textContent, /gallery ID/);
    assert.match(preview(ctx), /123456\.zip$/);
    assert.deepEqual(ctx.writes, []);
});

test("a saved empty list template remains distinct from inheritance until an explicit blank change", async () => {
    const ctx = await page({ sync: { downloadName: "{pretty}", listDownloadName: "" } });
    assert.match(preview(ctx), /123456\.zip$/);
    assert.deepEqual(ctx.writes, []);
    await ctx.change("listDownloadName", "");
    onlySet(ctx, "sync", "listDownloadName", "@inherit");
    assert.match(preview(ctx), /Sample_Title\.zip$/);
});

test("live list previews follow current name-template and replace-spaces choices", async () => {
    const ctx = await page({ sync: { downloadName: "{pretty}" } });
    await ctx.change("replaceSpaces", false);
    assert.match(preview(ctx), /Sample Title\.zip$/);
    ctx.writes.length = 0;
    await ctx.change("template_pretty", false);
    onlySet(ctx, "sync", "downloadName", "");
    assert.match(preview(ctx), /123456\.zip$/);
    await ctx.change("template_id", true);
    assert.match(ctx.el("listDownloadName").placeholder, /\{id\}/);
    const manual = await page({ sync: { downloadName: "Collection {pretty}" } });
    await manual.change("downloadName", "{id}");
    assert.match(preview(manual), /123456\.zip$/);
});

test("list preview reflects selected format, merge mode and optional master folder", async () => {
    const ctx = await page();
    await ctx.change("listFormat", "pdf");
    await ctx.change("listOutputMode", "batch");
    assert.equal(preview(ctx), "Example: Downloads/NHDW/<listing name>.pdf - every selected title merged into one file");
    await ctx.change("listMasterFolder", false);
    assert.ok(!preview(ctx).includes("NHDW/"));
    await ctx.change("listFormat", "raw");
    assert.equal(preview(ctx), "Example: Downloads/Sample_Title/001.jpg");
    assert.equal(ctx.sync.listOutputMode, "batch", "preview must not overwrite the user's stored merge preference");
    assert.equal(ctx.sync.useZip, undefined, "list-mode edits must not change the single-title default");
});

test("saved credentials remain local and are never copied into the options DOM", async () => {
    const local = { apiKey: fakeKey, apiKeyGate: "skipped", useServerArchive: true, untouched: { keep: true } };
    const ctx = await page({ local });
    assert.equal(ctx.el("apiKey").value, "");
    assert.ok(!ctx.document.documentElement.textContent.includes(fakeKey));
    assert.match(ctx.el("apiKeyStatus").textContent, /key is saved/);
    assert.equal(ctx.el("useServerArchive").checked, true);
    assert.deepEqual(ctx.local, local);
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(ctx.fetches, []);
});

test("paste trims the API key without verifying or saving until the user clicks", async () => {
    const ctx = await page();
    const paste = new TestEvent("paste", {
        cancelable: true, clipboardData: { getData(type) { assert.equal(type, "text"); return "  " + fakeKey + "\n"; } }
    });
    ctx.el("apiKey").dispatchEvent(paste);
    await ctx.flush();
    assert.equal(paste.defaultPrevented, true);
    assert.equal(ctx.el("apiKey").value, fakeKey);
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(ctx.fetches, []);
});

test("an empty API-key submission reports the problem without fetching or overwriting a saved key", async () => {
    const ctx = await page({ local: { apiKey: fakeKey } });
    await ctx.change("apiKey", "  ");
    await ctx.click("saveApiKey");
    assert.match(ctx.el("apiKeyStatus").textContent, /Paste an API key/);
    assert.deepEqual(ctx.fetches, []);
    assert.deepEqual(ctx.writes, []);
    assert.equal(ctx.local.apiKey, fakeKey);
});

test("successful verification disables Save while pending, then saves locally and clears the gate/input", async () => {
    let respond;
    const response = new Promise((resolve) => { respond = resolve; });
    const ctx = await page({ local: { apiKeyGate: "skipped", unrelated: 7 }, fetch: () => response });
    ctx.el("apiKey").value = "  " + fakeKey + "  ";
    ctx.el("saveApiKey").click();
    assert.equal(ctx.el("saveApiKey").disabled, true);
    assert.match(ctx.el("apiKeyStatus").textContent, /Verifying/);
    assert.deepEqual(ctx.writes, []);
    ctx.el("saveApiKey").click();
    assert.equal(ctx.fetches.length, 1, "disabled Save prevents duplicate submissions");
    assert.deepEqual(ctx.fetches[0], { url: "https://nhentai.net/api/v2/user", init: {
        headers: { Authorization: "Key " + fakeKey }, cache: "no-store"
    } });
    respond({ ok: true, json: async () => ({ username: "Options fixture" }) });
    await ctx.flush();
    assert.equal(ctx.el("saveApiKey").disabled, false);
    assert.equal(ctx.el("apiKey").value, "");
    assert.match(ctx.el("apiKeyStatus").textContent, /Key verified for Options fixture/);
    assert.deepEqual(ctx.writes, [
        { area: "local", operation: "set", values: { apiKey: fakeKey } },
        { area: "local", operation: "remove", keys: ["apiKeyGate"] }
    ]);
    assert.deepEqual(ctx.local, { unrelated: 7, apiKey: fakeKey });
    assert.deepEqual(ctx.sync, {});
});

for (const [label, fetch, expected] of [
    ["HTTP rejection", async () => ({ ok: false, status: 401 }), /HTTP 401/],
    ["malformed profile", async () => ({ ok: true, json: async () => ({}) }), /did not return a user profile/],
    ["network failure", async () => { throw new Error("Offline fixture"); }, /Offline fixture/]
]) {
    test("API-key " + label + " preserves the saved key and re-enables Save", async () => {
        const local = { apiKey: "old-options-fixture-key", apiKeyGate: "skipped", untouched: 4 };
        const ctx = await page({ local, fetch });
        ctx.el("apiKey").value = fakeKey;
        await ctx.click("saveApiKey");
        assert.match(ctx.el("apiKeyStatus").textContent, expected);
        assert.match(ctx.el("apiKeyStatus").textContent, /not saved/);
        assert.equal(ctx.el("saveApiKey").disabled, false);
        assert.equal(ctx.el("apiKey").value, fakeKey);
        assert.deepEqual(ctx.local, local);
        assert.deepEqual(ctx.writes, []);
    });
}

test("Remove key removes only the local key and gate, preserving queue/history/archive preferences", async () => {
    const retained = { downloadHistory: history, bookmarkQueue: { items: [] }, useServerArchive: true };
    const ctx = await page({ local: { ...retained, apiKey: fakeKey, apiKeyGate: "skipped" } });
    ctx.el("apiKey").value = fakeKey;
    await ctx.click("removeApiKey");
    assert.deepEqual(ctx.local, retained);
    assert.deepEqual(ctx.writes, [
        { area: "local", operation: "remove", keys: ["apiKey"] },
        { area: "local", operation: "remove", keys: ["apiKeyGate"] }
    ]);
    assert.equal(ctx.el("apiKey").value, "");
    assert.match(ctx.el("apiKeyStatus").textContent, /removed/);
    assert.deepEqual(ctx.fetches, []);
});

test("server-archive changes stay in local storage, not sync", async () => {
    const ctx = await page();
    for (const value of [true, false]) {
        ctx.writes.length = 0;
        await ctx.change("useServerArchive", value);
        onlySet(ctx, "local", "useServerArchive", value);
        assert.deepEqual(ctx.sync, {});
    }
});

test("history counts legacy/composite records on load without rewriting them", async () => {
    for (const [records, count] of [[history, 2], [{ "nhentai:1": { filename: "One.zip", when: 1 } }, 1]]) {
        const ctx = await page({ local: { downloadHistory: records } });
        assert.match(ctx.el("historyStatus").textContent, new RegExp("^" + count + " galler"));
        assert.deepEqual(ctx.local.downloadHistory, records);
        assert.deepEqual(ctx.writes, []);
    }
});

test("cancelling Clear history makes no storage change", async () => {
    const ctx = await page({ local: { downloadHistory: history }, confirm: false });
    await ctx.click("clearHistory");
    assert.equal(ctx.confirmations.length, 1);
    assert.match(ctx.confirmations[0], /Every gallery will be downloaded again/);
    assert.deepEqual(ctx.local.downloadHistory, history);
    assert.deepEqual(ctx.writes, []);
    assert.equal(ctx.el("clearHistory").disabled, false);
});

test("confirmed Clear history removes only history, and re-enables its button after completion", async () => {
    const retained = { apiKey: fakeKey, apiKeyGate: "skipped", bookmarkQueue: { items: [] }, useServerArchive: true };
    const ctx = await page({ local: { ...retained, downloadHistory: history }, confirm: true });
    ctx.el("clearHistory").click();
    assert.equal(ctx.el("clearHistory").disabled, true);
    await ctx.flush();
    assert.equal(ctx.el("clearHistory").disabled, false);
    assert.match(ctx.el("historyStatus").textContent, /history cleared/);
    assert.deepEqual(ctx.local, retained);
    assert.deepEqual(ctx.writes, [{ area: "local", operation: "remove", keys: ["downloadHistory"] }]);
    assert.deepEqual(ctx.sync, {});
});
