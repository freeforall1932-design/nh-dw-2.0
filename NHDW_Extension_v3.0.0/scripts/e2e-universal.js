// Bundled, offline integration: chapter page + injected probe + synthetic site
// and download-service stubs. No live website or actual Chromium is involved.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');

const root = path.join(__dirname, '..');
const appCode = fs.readFileSync(path.join(root, 'js/chapters.js'), 'utf8');
const probeCode = fs.readFileSync(path.join(root, 'js/universalChapterProbe.js'), 'utf8');
const pageHtml = fs.readFileSync(path.join(root, 'chapters.html'), 'utf8');
const page1 = Buffer.from([255, 216, 255, 224, 1]);
const page2 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
const page3 = Buffer.from([255, 216, 255, 224, 3]);

const fixtures = {
    'https://reader.example/series/book/chapter-1/': ['text/html', '<div id="readerarea"><img data-src="https://images.example/one.jpg"><img data-src="https://images.example/two.png"></div><img src="https://unapproved.example/ad.jpg">'],
    'https://reader.example/series/book/chapter-2/': ['text/html', '<div id="readerarea"><img data-src="https://images.example/three.jpg"></div>'],
    'https://images.example/one.jpg': ['image/jpeg', page1],
    'https://images.example/two.png': ['image/png', page2],
    'https://images.example/three.jpg': ['image/jpeg', page3]
};
const requests = [], downloads = [], blobs = new Map();
let listener = null, blobIndex = 0, nextId = 1, interrupted = false;
const source = new JSDOM('<title>Fixture Title</title><a href="chapter-2/">Chapter 2</a><a href="chapter-1/">Chapter 1</a>', {
    url: 'https://reader.example/series/book/', runScripts: 'outside-only'
});
const app = new JSDOM(pageHtml, { url: 'chrome-extension://fixture/chapters.html?tab=7', runScripts: 'outside-only' });
const sw = source.window, aw = app.window;
const runtime = { id: 'fixture', lastError: null, onMessage: { addListener(fn) { listener = fn; } } };
sw.chrome = { runtime };
sw.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.strictEqual(options.credentials, 'same-origin');
    assert.strictEqual(options.redirect, 'error');
    assert.strictEqual(options.referrerPolicy, 'no-referrer');
    const item = fixtures[String(url)];
    if (!item) throw new Error('Unexpected fixture request');
    return new Response(item[1], { headers: { 'content-type': item[0] } });
};
sw.TextDecoder = TextDecoder;
sw.AbortController = AbortController;

class ObjectURL extends URL {}
ObjectURL.createObjectURL = blob => { const url = 'blob:chrome-extension://fixture/' + (++blobIndex); blobs.set(url, blob); return url; };
ObjectURL.revokeObjectURL = url => blobs.delete(url);
aw.URL = ObjectURL;
aw.Blob = Blob;
aw.AbortController = AbortController;
aw.chrome = {
    runtime: {
        id: 'fixture', lastError: null,
        sendMessage(message, cb) {
            assert.strictEqual(message.from, 'chapters');
            if (message.action === 'saveDownload') {
                assert.strictEqual(message.requireCompletion, true);
                assert.ok(blobs.has(message.url));
                const id = nextId++;
                downloads.push({ id, filename: message.filename, blob: blobs.get(message.url) });
                queueMicrotask(() => cb({ result: id }));
            } else if (message.action === 'awaitDownload') {
                queueMicrotask(() => cb(interrupted ? { result: true, ok: false, state: 'interrupted', error: 'Synthetic interruption' } : { result: true, ok: true, state: 'complete' }));
            } else if (message.action === 'cancelDownload') queueMicrotask(() => cb({ result: true }));
            else throw new Error('Unexpected worker message');
        }
    },
    scripting: {
        executeScript(details, cb) {
            assert.strictEqual(details.target.tabId, 7);
            assert.deepStrictEqual(Array.from(details.files), ['js/universalChapterProbe.js']);
            vm.runInContext(probeCode, source.getInternalVMContext());
            queueMicrotask(() => cb([]));
        }
    },
    tabs: {
        sendMessage(id, message, cb) {
            assert.strictEqual(id, 7);
            assert.ok(listener, 'probe was injected');
            assert.strictEqual(listener(message, { id: 'fixture' }, response => cb(response)), true);
        }
    }
};

function click(id) { aw.document.getElementById(id).click(); }
async function until(predicate, label) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timeout: ' + label + '; status=' + aw.document.getElementById('status').textContent);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
async function main() {
    vm.runInContext(appCode, app.getInternalVMContext());
    click('scanTitle');
    await until(() => aw.document.querySelectorAll('#chapterList input').length === 2 && !aw.document.getElementById('scanTitle').disabled, 'scan');
    assert.strictEqual(requests.length, 0, 'scan should not fetch chapter/media URLs');
    click('selectAll');
    const order = aw.document.getElementById('order'); order.value = 'newest'; order.dispatchEvent(new aw.Event('change'));
    click('inspect');
    await until(() => aw.document.querySelectorAll('#review li').length === 2 && !aw.document.getElementById('inspect').disabled, 'inspect');
    assert.deepStrictEqual(Array.from(aw.document.querySelectorAll('#review li'), x => x.textContent), ['Chapter 1 — 2 image reference(s)', 'Chapter 2 — 1 image reference(s)']);
    assert.deepStrictEqual(requests.map(x => x.url), [
        'https://reader.example/series/book/chapter-1/', 'https://reader.example/series/book/chapter-2/'
    ], 'inspection may fetch only selected chapter HTML, never image/ad URLs');
    const hostBox = aw.document.querySelector('#review input[data-host]');
    assert.strictEqual(hostBox.dataset.host, 'images.example');
    // The save gate must prevent an unapproved host from being fetched.
    aw.document.getElementById('confirm').checked = true; click('download');
    assert.strictEqual(downloads.length, 0);
    assert.strictEqual(requests.length, 2);
    hostBox.checked = true; click('download');
    await until(() => /Saved 2 chapter archive/.test(aw.document.getElementById('status').textContent), 'save');
    assert.deepStrictEqual(downloads.map(x => x.filename), [
        'Fixture Title/001 - Chapter 1.cbz', 'Fixture Title/002 - Chapter 2.cbz'
    ]);
    assert.deepStrictEqual(requests.map(x => x.url).slice(2), [
        'https://images.example/one.jpg', 'https://images.example/two.png', 'https://images.example/three.jpg'
    ]);
    const zip1 = await JSZip.loadAsync(await downloads[0].blob.arrayBuffer());
    const zip2 = await JSZip.loadAsync(await downloads[1].blob.arrayBuffer());
    assert.deepStrictEqual(Object.keys(zip1.files), ['001.jpg', '002.png']);
    assert.deepStrictEqual(await zip1.file('001.jpg').async('nodebuffer'), page1);
    assert.deepStrictEqual(await zip1.file('002.png').async('nodebuffer'), page2);
    assert.deepStrictEqual(await zip2.file('001.jpg').async('nodebuffer'), page3);
    // Browser handoff alone is not success.
    interrupted = true; click('download');
    await until(() => /Stopped after 0 completed archive/.test(aw.document.getElementById('status').textContent), 'interrupted download');
    console.log('PASS: bundled chapter UI/probe, explicit host gate, ordered ZIPs, strict completion (synthetic VM)');
}
main().then(() => { app.window.close(); source.window.close(); }).catch(error => {
    console.error('FAIL: bundled chapter integration:', error); app.window.close(); source.window.close(); process.exitCode = 1;
});
