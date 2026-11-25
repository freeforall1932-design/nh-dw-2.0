// Bundled, offline integration for React Router page data (Tailspace recipe):
// the real chapters page + injected probe against a synthetic tailspace.com tab.
// The ".data" bodies are test/fixtures/tailspace/*.data (official turbo-stream
// encoder output from synthetic data). No live website or browser is involved.
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
const fixture = name => fs.readFileSync(path.join(root, 'test', 'fixtures', 'tailspace', name), 'utf8');

function jpegOf(width, height) {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255,
        (width >> 8) & 255, width & 255, 0x03,
        0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
}
function pngOf(width, height) {
    return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        (width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255,
        (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255,
        8, 6, 0, 0, 0]);
}
function webpOf(width, height) {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUInt32LE(10, 16);
    b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
    return b;
}
const a1 = jpegOf(900, 1400), b2 = pngOf(900, 1400), c3 = webpOf(900, 1400), d4 = jpegOf(800, 1200), e5 = jpegOf(700, 1000), f6 = jpegOf(700, 1001);

const ROUTE = '?_routes=routes%2Fpages%2Fcomic%2FComicPage';
const DATA = slug => 'https://tailspace.com/c/' + encodeURIComponent(slug) + '.data' + ROUTE;
const fixtures = {
    [DATA('Scale Train')]: ['text/x-script', fixture('comic-101.data')],
    [DATA('Scale Train 2')]: ['text/x-script', fixture('comic-102.data')],
    [DATA('Scale Train 3')]: ['text/x-script', fixture('comic-103.data')],
    'https://pics.tailspace.com/comics/101/a1.jpg': ['image/jpeg', a1],
    'https://pics.tailspace.com/comics/101/b2.png': ['image/png', b2],
    'https://pics.tailspace.com/comics/101/c3.webp': ['image/webp', c3],
    'https://pics.tailspace.com/comics/102/d4.jpg': ['image/jpeg', d4],
    'https://pics.tailspace.com/comics/103/e5.jpg': ['image/jpeg', e5],
    'https://pics.tailspace.com/comics/103/f6.jpg': ['image/jpeg', f6]
};
const requests = [], downloads = [], blobs = new Map();
let listener = null, blobIndex = 0, nextId = 1;
// Gallery-mode markup: "-mini" thumbnails that must never be what gets saved,
// plus ordinary links (the DOM fallback when page data is unavailable).
const source = new JSDOM('<title>Scale Train - Tailspace</title>' +
    '<a href="/c/Scale%20Train">Scale Train - Chapter 1</a><a href="/c/Scale%20Train%203">Scale Train - Chapter 3</a>' +
    '<div class="gallery"><img src="https://pics.tailspace.com/comics/102/d4-mini.jpg"></div>' +
    '<script>window.__reactRouterContext = {"basename":"/"};</script>', {
    url: 'https://tailspace.com/c/Scale%20Train%202?page=1', runScripts: 'outside-only'
});
const app = new JSDOM(pageHtml, { url: 'chrome-extension://fixture/chapters.html?tab=7', runScripts: 'outside-only' });
const sw = source.window, aw = app.window;
sw.chrome = { runtime: { id: 'fixture', lastError: null, onMessage: { addListener(fn) { listener = fn; } } } };
sw.scrollTo = () => {};
sw.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.strictEqual(options.credentials, 'same-origin');
    assert.strictEqual(options.redirect, 'error');
    assert.strictEqual(options.referrerPolicy, 'no-referrer', 'no referrer unless the user opts in');
    const item = fixtures[String(url)];
    if (!item) throw new Error('Unexpected fixture request: ' + url);
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
const storage = {};
aw.chrome = {
    runtime: {
        getManifest() { return { version: 'fixture' }; },
        id: 'fixture', lastError: null,
        sendMessage(message, cb) {
            assert.strictEqual(message.from, 'chapters');
            if (message.action === 'saveDownload') {
                assert.ok(blobs.has(message.url));
                const id = nextId++;
                downloads.push({ id, filename: message.filename, blob: blobs.get(message.url) });
                queueMicrotask(() => cb({ result: id }));
            } else if (message.action === 'awaitDownload') {
                queueMicrotask(() => cb({ result: true, ok: true, state: 'complete' }));
            } else if (message.action === 'ping') queueMicrotask(() => cb({ result: true, version: 'fixture', downloads: true, offscreen: true, completion: true }));
            else if (message.action === 'cancelDownload') queueMicrotask(() => cb({ result: true }));
            else throw new Error('Unexpected worker message');
        }
    },
    downloads: { download(options, cb) { queueMicrotask(() => cb(1)); } },
    storage: {
        local: {
            get(defaults, cb) { queueMicrotask(() => cb(Object.assign({}, defaults, storage))); },
            set(values, cb) { Object.assign(storage, values); if (cb) queueMicrotask(() => cb()); },
            remove(key, cb) { delete storage[key]; if (cb) queueMicrotask(() => cb()); }
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
const status = () => aw.document.getElementById('status').textContent;
async function until(predicate, label) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timeout: ' + label + '; status=' + status());
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function main() {
    vm.runInContext(appCode, app.getInternalVMContext());

    // 1. Scanning any part reads the whole linked series from page data.
    click('scanTitle');
    await until(() => /linked part/.test(status()), 'series scan');
    const labels = Array.from(aw.document.querySelectorAll('#chapterList label span'), x => x.textContent);
    assert.deepStrictEqual(labels, ['Scale Train - Chapter 1', 'Scale Train - Chapter 2', 'Scale Train - Chapter 3'], 'oldest first');
    assert.match(status(), /Read 3 linked part\(s\) of this series from the site's own page data/);
    assert.strictEqual(aw.document.getElementById('order').value, 'oldest', 'the known order is preset');
    assert.match(status(), /send its address as the referrer for images; if pages fail, tick that option/, 'points at the opt-in');
    assert.strictEqual(aw.document.getElementById('sendReferrer').checked, false, 'but never ticks it');
    assert.deepStrictEqual(requests.map(r => r.url), [DATA('Scale Train 2'), DATA('Scale Train'), DATA('Scale Train 3')],
        'one data request per part, the reader position (?page=1) dropped, no media fetched');
    console.log('PASS: series scan reads 3 linked parts from React Router page data, oldest first, order preset');

    // 2. Inspection reuses the decoded data: no second request per chapter.
    click('selectAll');
    click('inspect');
    await until(() => aw.document.querySelectorAll('#review li').length === 3 && !aw.document.getElementById('inspect').disabled, 'inspect');
    const reviewed = Array.from(aw.document.querySelectorAll('#review li'), x => x.textContent);
    assert.match(reviewed[0], /^Scale Train - Chapter 1 — 3 image reference\(s\) · read from the site's own page data \(React Router \.data\)/);
    assert.match(reviewed[1], /— 1 image reference\(s\)/);
    assert.match(reviewed[2], /— 2 image reference\(s\)/);
    assert.strictEqual(requests.length, 3, 'inspection used the cached page data');
    assert.deepStrictEqual(Array.from(aw.document.querySelectorAll('#review input[data-host]'), b => b.dataset.host), ['pics.tailspace.com']);
    // Part 3's data states 3 pages but lists 2: say so, with the right advice.
    const warning = aw.document.querySelector('#review p.warning').textContent;
    assert.match(warning, /Scale Train - Chapter 3 \(found 2 of 3\)/);
    assert.match(warning, /site's own page data disagrees with its stated total/);
    assert.doesNotMatch(warning, /Load all pages/, 'scrolling cannot fix page data');
    console.log('PASS: the site\'s stated page total is cross-checked (2 of 3 flagged, no scrolling advice)');
    console.log('PASS: inspection lists full-size pages from page data without re-fetching; only pics.tailspace.com is offered');

    // 3. Save: nothing is fetched before approval, then ordered full-size pages.
    aw.document.getElementById('confirm').checked = true;
    click('download');
    assert.strictEqual(downloads.length, 0, 'the host gate holds');
    aw.document.querySelector('#review input[data-host]').checked = true;
    click('download');
    await until(() => /Saved 3 complete chapter archive/.test(status()), 'save');
    assert.deepStrictEqual(downloads.map(d => d.filename), [
        'Scale Train - Tailspace/001 - Scale Train - Chapter 1.cbz',
        'Scale Train - Tailspace/002 - Scale Train - Chapter 2.cbz',
        'Scale Train - Tailspace/003 - Scale Train - Chapter 3.cbz'
    ]);
    assert.ok(!requests.some(r => /-mini\./.test(r.url)), 'gallery thumbnails are never fetched');
    const zip1 = await JSZip.loadAsync(await downloads[0].blob.arrayBuffer());
    assert.deepStrictEqual(Object.keys(zip1.files).filter(n => n !== 'ComicInfo.xml').sort(), ['001.jpg', '002.png', '003.webp']);
    assert.deepStrictEqual(await zip1.file('001.jpg').async('nodebuffer'), a1, 'page 1 first even though the loader listed it second');
    assert.deepStrictEqual(await zip1.file('002.png').async('nodebuffer'), b2);
    assert.deepStrictEqual(await zip1.file('003.webp').async('nodebuffer'), c3);
    const zip3 = await JSZip.loadAsync(await downloads[2].blob.arrayBuffer());
    assert.deepStrictEqual(await zip3.file('002.jpg').async('nodebuffer'), f6);
    await until(() => JSON.stringify(storage.nhdwExtensionLog || []).includes("React Router page data"), 'log names the page-list source');
    console.log('PASS: 3 ordered CBZ archives of full-size pages (jpg/png/webp), thumbnails never fetched, log names the source');

    // 4. When the site stops serving page data, the tool falls back to links.
    click('reset');
    fixtures[DATA('Scale Train 2')] = ['text/html', '<!doctype html><html></html>'];
    const before = requests.length;
    // Sibling parts are not under this part's path, so the ordinary link scan
    // needs the existing "outside the title path" box (unchanged behaviour).
    aw.document.getElementById('outsideLinks').checked = true;
    click('scanTitle');
    await until(() => !aw.document.getElementById('scanTitle').disabled && aw.document.querySelectorAll('#chapterList input').length > 0, 'fallback scan');
    assert.strictEqual(requests.length, before + 1, 'one refused data request, then the page links');
    const fallback = Array.from(aw.document.querySelectorAll('#chapterList label span'), x => x.textContent);
    assert.deepStrictEqual(fallback, ['Scale Train - Chapter 1', 'Scale Train - Chapter 3'], 'links from the open page');
    assert.doesNotMatch(status(), /linked part/);
    console.log('PASS: an HTML answer instead of page data falls back to the ordinary link scan');
}
main().then(() => { app.window.close(); source.window.close(); }).catch(error => {
    console.error('FAIL: route-data integration:', error); app.window.close(); source.window.close(); process.exitCode = 1;
});
