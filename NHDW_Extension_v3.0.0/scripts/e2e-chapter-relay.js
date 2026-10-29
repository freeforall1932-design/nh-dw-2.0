// Offline relay guard: only the extension's own chapter page may hand a
// blob artifact to the worker's tracked download path.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const bundlePath = path.join(__dirname, '..', 'js', 'background.js');
const code = fs.readFileSync(bundlePath, 'utf8');
let onMessage = null;
const started = [];
const chromeStub = {
    tabs: {
        onUpdated: { addListener() {} }, onActivated: { addListener() {} },
        query(_q, cb) { cb([{ url: 'https://nhentai.net/g/1/' }]); }
    },
    action: { setIcon() { return Promise.resolve(); } },
    storage: {
        sync: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        local: { get(defaults, cb) { cb(Object.assign({}, defaults)); } },
        session: { get(_k, cb) { cb({}); }, set() {}, remove() {} }
    },
    runtime: {
        id: 'testid', lastError: null,
        onMessage: { addListener(fn) { onMessage = fn; } },
        sendMessage() {},
        getURL(p) { return 'chrome-extension://testid/' + String(p).replace(/^\//, ''); }
    },
    downloads: {
        download(details, cb) { started.push(details); setTimeout(() => cb(5), 0); },
        search(_q, cb) { cb([{ id: 5, state: 'complete' }]); },
        cancel(_id, cb) { if (cb) cb(); },
        onDeterminingFilename: { addListener() {}, removeListener() {} },
        onChanged: { addListener() {} }
    }
};
const sandbox = { chrome: chromeStub, console, setTimeout, clearTimeout, fetch() { throw new Error('no fetch'); } };
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: bundlePath });
assert.ok(onMessage, 'worker listener registered');

function dispatch(request, sender) {
    return new Promise(resolve => {
        let answered = false;
        const sendResponse = value => { answered = true; resolve(value); };
        const keepOpen = onMessage(request, sender, sendResponse);
        setTimeout(() => { if (!answered) resolve({ unanswered: true, keepOpen: keepOpen }); }, 20);
    });
}
const chaptersSender = { id: 'testid', url: 'chrome-extension://testid/chapters.html?tab=9' };
const blob = 'blob:chrome-extension://testid/4f7d';

(async () => {
    let reply = await dispatch({ from: 'chapters', action: 'saveDownload', url: blob, filename: 'T/001 - A.cbz', requireCompletion: true }, chaptersSender);
    assert.strictEqual(reply.result, 5);
    assert.strictEqual(started.length, 1);
    assert.strictEqual(started[0].filename, 'T/001 - A.cbz');
    reply = await dispatch({ from: 'chapters', action: 'awaitDownload', downloadId: 5 }, chaptersSender);
    assert.strictEqual(reply.result, true);
    assert.strictEqual(reply.state, 'complete');
    assert.strictEqual(reply.ok, true);
    reply = await dispatch({ from: 'chapters', action: 'cancelDownload', downloadId: 5 }, chaptersSender);
    assert.strictEqual(reply.result, true);
    for (const [label, request, sender] of [
        ['a non-extension HTTPS URL', { from: 'chapters', action: 'saveDownload', url: 'https://evil.example/x.zip', filename: 'x.zip', requireCompletion: true }, chaptersSender],
        ['an artifact without strict completion', { from: 'chapters', action: 'saveDownload', url: blob, filename: 'x.zip' }, chaptersSender],
        ['a foreign sender id', { from: 'chapters', action: 'saveDownload', url: blob, filename: 'x.zip', requireCompletion: true }, { id: 'other', url: chaptersSender.url }],
        ['another extension page', { from: 'chapters', action: 'saveDownload', url: blob, filename: 'x.zip', requireCompletion: true }, { id: 'testid', url: 'chrome-extension://testid/index.html' }]
    ]) {
        const before = started.length;
        reply = await dispatch(request, sender);
        assert.notStrictEqual(reply && reply.result, 5, label + ' must not start a browser download');
        assert.strictEqual(started.length, before, label + ' started a download');
    }
    console.log('PASS: chapter relay accepts only its own strict blob artifacts');
})().catch(error => { console.error('FAIL: chapter relay: ' + error.message); process.exitCode = 1; });
