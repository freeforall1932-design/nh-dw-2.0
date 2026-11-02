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
// Realistic headers: the probe and the archive stage both read dimensions now.
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
const page1 = jpegOf(900, 1400);
const page2 = pngOf(800, 1200);
const page3 = jpegOf(700, 1000);

const fixtures = {
    // Tailspace-style: random image names, page number only in the link, and
    // the DOM order deliberately jumbled (page 2 before page 1).
    'https://reader.example/series/book/chapter-1/': ['text/html', '<div class="page-counter">Page 1 / 3</div><div id="readerarea"><a href="?page=2"><img data-src="https://images.example/two.png" alt="Fixture, page 2"></a><a href="?page=1"><img data-src="https://images.example/one.jpg" alt="Fixture, page 1"></a></div><div class="ads"><img src="https://unapproved.example/ad.jpg"></div>'],
    'https://reader.example/series/book/chapter-2/': ['text/html', '<div id="readerarea"><a href="?page=1"><img data-src="https://images.example/three.jpg" alt="Fixture, page 1"></a></div>'],
    // MangaThemesia-style: no <img> at all, the page list lives in a base64 script.
    'https://reader.example/series/book/chapter-3/': ['text/html', '<div id="readerarea"></div><script src="data:text/javascript;base64,dHNfcmVhZGVyLnJ1bih7ImltYWdlcyI6IFsiaHR0cHM6Ly9pbWFnZXMuZXhhbXBsZS9vbmUuanBnIiwgImh0dHBzOi8vaW1hZ2VzLmV4YW1wbGUvdHdvLnBuZyJdLCAicGFnaW4iOiBmYWxzZX0p"></script>'],
    'https://images.example/t1-mini.jpg': ['image/jpeg', page1],
    'https://images.example/t2-mini.jpg': ['image/jpeg', page3],
    'https://images.example/t1.jpg': ['image/jpeg', page1],
    'https://images.example/t2.jpg': ['image/jpeg', page3],
    // Gallery-mode style: thumbnails only, so the full-size name must be derived by rule.
    'https://reader.example/series/book/chapter-4/': ['text/html', '<div id="readerarea"><img data-src="https://images.example/t1-mini.jpg"><img data-src="https://images.example/t2-mini.jpg"></div>'],
    'https://images.example/one.jpg': ['image/jpeg', page1],
    'https://images.example/two.png': ['image/png', page2],
    'https://images.example/three.jpg': ['image/jpeg', page3]
};
const requests = [], downloads = [], blobs = new Map();
const failUrls = new Set();
let listener = null, blobIndex = 0, nextId = 1, interrupted = false;
const source = new JSDOM('<title>Fixture Title</title><a href="chapter-2/">Chapter 2</a><a href="chapter-1/">Chapter 1</a>', {
    url: 'https://reader.example/series/book/', runScripts: 'outside-only'
});
const app = new JSDOM(pageHtml, { url: 'chrome-extension://fixture/chapters.html?tab=7', runScripts: 'outside-only' });
const sw = source.window, aw = app.window;
const runtime = { id: 'fixture', lastError: null, onMessage: { addListener(fn) { listener = fn; } } };
sw.chrome = { runtime };
// jsdom has no layout and no scrolling; a no-op keeps the sweep's jsdom warning
// out of the log without pretending the page scrolled.
sw.scrollTo = () => {};
sw.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.strictEqual(options.credentials, 'same-origin');
    assert.strictEqual(options.redirect, 'error');
    assert.strictEqual(options.referrerPolicy, 'no-referrer');
    if (failUrls.has(String(url))) throw new Error('Synthetic network failure');
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
const storage = {};
const logFiles = [];
aw.chrome = {
    runtime: {
        getManifest() { return { version: 'fixture' }; },
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
            } else if (message.action === 'ping') queueMicrotask(() => cb({ result: true, version: 'fixture', downloads: true, offscreen: true, completion: true }));
            else if (message.action === 'cancelDownload') queueMicrotask(() => cb({ result: true }));
            else throw new Error('Unexpected worker message');
        }
    },
    downloads: {
        download(options, cb) {
            logFiles.push({ filename: String(options.filename), blob: blobs.get(String(options.url)) });
            queueMicrotask(() => cb(logFiles.length));
        }
    },
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
    // The sweep needs one known open chapter; without it the button explains itself.
    click('loadAll');
    assert.match(aw.document.getElementById('status').textContent, /Use “Use open chapter” first/);
    click('selectAll');
    const order = aw.document.getElementById('order'); order.value = 'newest'; order.dispatchEvent(new aw.Event('change'));
    // Pasting a chapter URL is accepted on the same site and refused elsewhere.
    const urls = aw.document.getElementById('chapterUrls');
    urls.value = 'https://other.example/series/elsewhere/chapter-1/'; click('addUrls');
    assert.match(aw.document.getElementById('status').textContent, /same site/);
    urls.value = 'https://reader.example/series/book/chapter-2/'; click('addUrls');
    assert.match(aw.document.getElementById('status').textContent, /already collected/);
    // Random file names cannot order Tailspace-style pages; the link does.
    aw.document.getElementById('pageOrder').value = 'link-index';
    click('inspect');
    await until(() => aw.document.querySelectorAll('#review li').length === 2 && !aw.document.getElementById('inspect').disabled, 'inspect');
    // The reader advertises 3 pages but only 2 images were found: warn, do not hide it.
    assert.match(aw.document.querySelector('#review p.warning').textContent,
        /Chapter 1 \(found 2 of 3\).*Load all pages \(top-down\)/);
    const reviewed = Array.from(aw.document.querySelectorAll('#review li'), x => x.textContent);
    assert.strictEqual(reviewed.length, 2);
    assert.match(reviewed[0], /^Chapter 1 — 2 image reference\(s\) · sorted by page links \(differs from reader order — verify\): #1 images\.example\//);
    assert.match(reviewed[1], /^Chapter 2 — 1 image reference\(s\) · sorted by page links: #1 images\.example\//);
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
    await until(() => /Saved 2 complete chapter archive/.test(aw.document.getElementById('status').textContent), 'save');
    assert.deepStrictEqual(downloads.map(x => x.filename), [
        'Fixture Title/001 - Chapter 1.cbz', 'Fixture Title/002 - Chapter 2.cbz'
    ]);
    assert.deepStrictEqual(requests.map(x => x.url).slice(2), [
        'https://images.example/one.jpg', 'https://images.example/two.png', 'https://images.example/three.jpg'
    ]);
    const zip1 = await JSZip.loadAsync(await downloads[0].blob.arrayBuffer());
    const zip2 = await JSZip.loadAsync(await downloads[1].blob.arrayBuffer());
    assert.deepStrictEqual(Object.keys(zip1.files).sort(), ['001.jpg', '002.png', 'ComicInfo.xml']);
    const info = await zip1.file('ComicInfo.xml').async('string');
    assert.match(info, /<Series>Fixture Title<\/Series>/);
    assert.match(info, /<Title>Chapter 1<\/Title>/);
    assert.match(info, /<PageCount>2<\/PageCount>/);
    assert.deepStrictEqual(await zip1.file('001.jpg').async('nodebuffer'), page1);
    assert.deepStrictEqual(await zip1.file('002.png').async('nodebuffer'), page2);
    assert.deepStrictEqual(await zip2.file('001.jpg').async('nodebuffer'), page3);
    // A recoverable page failure keeps what arrived, marked incomplete…
    failUrls.add('https://images.example/two.png');
    click('download');
    await until(() => /Saved 1 complete chapter archive\(s\); 1 incomplete: Chapter 1 \(1 of 2\)/.test(aw.document.getElementById('status').textContent), 'salvaged chapter');
    assert.ok(downloads.some(x => x.filename === 'Fixture Title/001 - Chapter 1 (incomplete 1 of 2 pages).cbz'),
        'salvaged file must be marked incomplete in its name');
    failUrls.clear();
    // …while the same failure with salvage off drops only that chapter.
    aw.document.getElementById('salvage').checked = false;
    failUrls.add('https://images.example/two.png');
    click('download');
    await until(() => /1 failed: Chapter 1 —/.test(aw.document.getElementById('status').textContent), 'strict chapter failure');
    failUrls.clear();
    aw.document.getElementById('salvage').checked = true;
    // Browser handoff alone is not success.
    interrupted = true; click('download');
    await until(() => /Stopped after 0 saved archive/.test(aw.document.getElementById('status').textContent), 'interrupted download');
    interrupted = false;
    // Chapters the browser confirmed complete were recorded; re-inspecting marks
    // them as already saved and a save run refuses to duplicate them.
    const savedBefore = downloads.length;
    click('inspect');
    await until(() => aw.document.querySelectorAll('#review li').length === 2 && !aw.document.getElementById('inspect').disabled, 're-inspect');
    assert.match(Array.from(aw.document.querySelectorAll('#review li'), x => x.textContent).join('\n'),
        /already saved, will be skipped/);
    assert.match(aw.document.getElementById('status').textContent, /already saved will be skipped/);
    aw.document.getElementById('confirm').checked = true;
    aw.document.querySelector('#review input[data-host]').checked = true;
    click('download');
    await until(() => /Every selected chapter is already saved/.test(aw.document.getElementById('status').textContent), 'skip saved');
    assert.strictEqual(downloads.length, savedBefore, 'a skipped chapter must not be downloaded again');
    assert.ok(storage.nhdwChapterProgress, 'saved-chapter records must persist');
    // Benchmark: read-only checks from an open chapter page, then the log file.
    source.window.history.pushState({}, '', 'chapter-1/');
    const reader = source.window.document.createElement('div');
    reader.id = 'readerarea';
    reader.innerHTML = '<img src="https://images.example/one.jpg"><img src="https://images.example/two.png">';
    source.window.document.body.appendChild(reader);
    aw.document.getElementById('pageOrder').value = 'reader';
    const fetchesBefore = requests.length;
    click('benchmark');
    await until(() => logFiles.length === 1 && !aw.document.getElementById('benchmark').disabled, 'benchmark');
    assert.match(logFiles[0].filename, /^nhdw-log-\d{4}-\d{2}-\d{2}T[\d-]+Z\.txt$/);
    const logText = await logFiles[0].blob.text();
    assert.match(logText, /NHDW extension log/);
    assert.match(logText, /Source tab reached/);
    assert.match(logText, /Reader inspected/);
    assert.match(logText, /Page image fetched/);
    assert.match(logText, /Scroll container measured|Scroll measurement failed/);
    assert.match(logText, /Storage round-trip/);
    assert.match(logText, /Benchmark finished/);
    // The self-test pressed the page's own controls and put them back.
    assert.match(logText, /Controls exercised/);
    assert.match(logText, /"id":"salvage","kind":"checkbox","ok":true/);
    assert.match(logText, /"id":"format","kind":"select","ok":true/);
    assert.match(logText, /"id":"titleName","kind":"text","ok":true/);
    assert.match(logText, /"id":"download","kind":"state","ok":true/);
    assert.match(logText, /"id":"download service","kind":"message","ok":true/);
    assert.match(logText, /"skipped":4/, 'a review on screen must not be discarded by the self-test');
    assert.strictEqual(aw.document.getElementById('salvage').checked, true, 'controls must return to their values');
    assert.strictEqual(aw.document.getElementById('titleName').value, 'Fixture Title');
    assert.strictEqual(aw.document.getElementById('pageOrder').value, 'reader');
    assert.strictEqual(aw.document.querySelectorAll('#review li').length, 2, 'the review must survive the self-test');
    assert.strictEqual(requests.length, fetchesBefore + 1, 'the benchmark fetches exactly one page image');
    assert.strictEqual(requests[requests.length - 1].url, 'https://images.example/one.jpg');
    assert.ok(!/\?(?!.*")/.test(logText.split('{')[0]), 'log header carries no query string');
    // Forgetting the site clears the remembered approvals but keeps the records.
    click('forgetSite');
    assert.match(aw.document.getElementById('status').textContent, /Remembered hosts cleared/);
    assert.match(aw.document.getElementById('approvalHint').textContent, /No hosts remembered for https:\/\/reader\.example yet\./);
    click('forgetTitle');
    assert.match(aw.document.getElementById('status').textContent, /Cleared 2 saved-chapter record\(s\)/);
    // A reader that keeps its page list in a base64 script (MangaThemesia family):
    // no <img> matched the selector, so the probe falls back to the site's own list.
    const moreUrls = aw.document.getElementById('chapterUrls');
    moreUrls.value = 'https://reader.example/series/book/chapter-3/'; click('addUrls');
    await until(() => aw.document.querySelectorAll('#chapterList input').length === 3, 'third chapter added');
    click('selectNone');
    const third = aw.document.querySelectorAll('#chapterList input')[2];
    third.checked = true; third.dispatchEvent(new aw.Event('change'));
    aw.document.getElementById('pageOrder').value = 'reader';
    const beforeScript = requests.length;
    click('inspect');
    await until(() => /embedded page list/.test(aw.document.getElementById('review').textContent), 'reader-script fallback');
    assert.match(aw.document.querySelector('#review li').textContent, /read from the reader's own embedded page list/);
    assert.strictEqual(requests.length, beforeScript + 1, 'only the chapter HTML is fetched, no image yet');
    assert.match(requests[requests.length - 1].url, /chapter-3\/$/);
    // Thumbnail-only reader: the explicit suffix rule derives full-size URLs, and
    // a chapter where only some pages carry the tail is refused, not half-converted.
    aw.document.getElementById('fullSizeSuffix').value = '-mini';
    moreUrls.value = 'https://reader.example/series/book/chapter-4/'; click('addUrls');
    await until(() => aw.document.querySelectorAll('#chapterList input').length === 4, 'fourth chapter added');
    click('selectNone');
    const fourth = aw.document.querySelectorAll('#chapterList input')[3];
    fourth.checked = true; fourth.dispatchEvent(new aw.Event('change'));
    click('inspect');
    await until(() => /full-size rule removed/.test(aw.document.getElementById('review').textContent), 'suffix rule');
    assert.match(aw.document.querySelector('#review li').textContent, /removed “-mini” from 2 URL\(s\)/);
    const miniReview = Array.from(aw.document.querySelectorAll('#review input[data-host]'), box => box.dataset.host);
    assert.deepStrictEqual(miniReview, ['images.example'], 'only the derived host is offered for approval');
    aw.document.getElementById('confirm').checked = true;
    aw.document.querySelector('#review input[data-host]').checked = true;
    const beforeMini = downloads.length;
    click('download');
    await until(() => downloads.length === beforeMini + 1, 'suffix archive saved');
    const miniZip = await JSZip.loadAsync(await downloads[downloads.length - 1].blob.arrayBuffer());
    assert.deepStrictEqual(await miniZip.file('001.jpg').async('nodebuffer'), page1);
    assert.deepStrictEqual(await miniZip.file('002.jpg').async('nodebuffer'), page3);
    assert.ok(requests.some(item => /\/t1\.jpg$/.test(item.url)), 'the derived full-size URL is what was fetched');
    assert.ok(!requests.some(item => /t1-mini\.jpg$/.test(item.url)), 'the thumbnail URL must not be fetched');
    aw.document.getElementById('fullSizeSuffix').value = '';
    // Remembered reader settings for one site only.
    aw.document.getElementById('imageSelector').value = '#readerarea img';
    aw.document.getElementById('pageOrder').value = 'reader';
    click('saveProfile');
    assert.match(aw.document.getElementById('status').textContent, /Saved these reader settings/);
    assert.ok(storage.nhdwSiteProfiles && storage.nhdwSiteProfiles['https://reader.example']);
    aw.document.getElementById('pageOrder').value = 'link-index';
    click('forgetProfile');
    assert.match(aw.document.getElementById('status').textContent, /Cleared the saved reader settings/);
    assert.deepStrictEqual(Object.keys(storage.nhdwSiteProfiles), []);
    console.log('PASS: bundled chapter UI/probe, explicit host gate, ordered ZIPs, strict completion, resume, suffix rule, site profiles, benchmark log (synthetic VM)');
}
main().then(() => { app.window.close(); source.window.close(); }).catch(error => {
    console.error('FAIL: bundled chapter integration:', error); app.window.close(); source.window.close(); process.exitCode = 1;
});
