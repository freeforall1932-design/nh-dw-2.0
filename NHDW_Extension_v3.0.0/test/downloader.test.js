// Fixture tests for the Downloader: image URL generation and fallback order,
// ZIP entry naming/content, raw mode, and the object-URL delivery branch.
// No network access required; the class under test is compiled from
// src/background/Downloader.ts into build/test by tsconfig.test.json.

const assert = require('assert');
const JSZip = require('jszip');
const Downloader = require('../build/test/background/Downloader.js').default;
const { sanitizeArtifactFilename } = require('../build/test/background/Downloader.js');
const { decodeTabImageBytes, isAllowedImageUrl } = require('../build/test/background/tabImageFetch.js');

const gallery = {
    id: 123456,
    media_id: 987654,
    title: { english: 'Test', japanese: '', pretty: 'Test' },
    images: { pages: [{ t: 'j' }, { t: 'p' }, { t: 'j' }] },
    tags: []
};

function makePageBytes(...markerBytes) {
    const buf = new Uint8Array(2000);
    buf.fill(0x00);  // zero-fill the rest
    for (let i = 0; i < markerBytes.length && i < 10; i++) {
        buf[i] = markerBytes[i];
    }
    return buf;
}

const pageBytes = [
    makePageBytes(0xff, 0xd8, 0xff, 0xe0),  // JPEG header
    makePageBytes(0x89, 0x50, 0x4e, 0x47, 0x0a),  // PNG header
    makePageBytes(0xff, 0xd8, 0xff, 0xe1)  // JPEG header
];

const CANONICAL = 'https://i.nhentai.net/galleries/987654/';
const MIRRORS = [1, 2, 3, 4].map((n) => `https://i${n}.nhentai.net/galleries/987654/`);

function makeChromeStub(useZip, maxConcurrentDownloads = '3', extra = {}) {
    const stub = {
        storage: {
            sync: {
                get(defaults, cb) {
                    cb(Object.assign({}, defaults, { useZip, maxConcurrentDownloads }, extra));
                }
            }
        },
        runtime: { lastError: null, sendMessage() {} },
        downloads: {
            calls: [],
            download(opts, cb) {
                stub.downloads.calls.push(opts);
                if (cb) cb(1); // success, downloadId = 1
            }
        }
    };
    return stub;
}

function makeFetchStub(failHosts = [], htmlHosts = []) {
    const attempted = [];
    const fn = (url) => {
        const u = String(url);
        attempted.push(u);
        if (htmlHosts.some((h) => u.startsWith(h))) {
            // Cloudflare challenge / error page masquerading as a 200 response.
            return Promise.resolve(new Response('<html><head><title>Just a moment...</title></head><body>challenge</body></html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' }
            }));
        }
        if (failHosts.some((h) => u.startsWith(h))) {
            return Promise.resolve(new Response('nope', { status: 404 }));
        }
        const m = /\/([0-9]+)\.(jpg|png)$/.exec(u);
        const idx = m ? parseInt(m[1], 10) - 1 : 0;
        return Promise.resolve(new Response(pageBytes[idx], { status: 200 }));
    };
    fn.attempted = attempted;
    return fn;
}

async function decodeZip(url) {
    assert.ok(/^data:application\/zip;base64,/.test(url), 'expected a base64 zip data URL, got ' + url.slice(0, 40));
    return JSZip.loadAsync(Buffer.from(url.split(',')[1], 'base64'));
}

// Node has no FileReader; the compiled Downloader needs readAsArrayBuffer.
class FileReaderStub {
    readAsArrayBuffer(blob) {
        blob.arrayBuffer().then(
            (buf) => { this.result = buf; if (this.onload) this.onload(); },
            (err) => { this.error = err; if (this.onerror) this.onerror(err); }
        );
    }
}

describe('Downloader (zip mode)', () => {
    let chrome;
    let fetchStub;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        fetchStub = makeFetchStub();
        globalThis.chrome = chrome;
        globalThis.fetch = fetchStub;
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('fetches the canonical image CDN first', async () => {
        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0; // disable in tests to keep timings deterministic
        await downloader.startAsync();

        const expected = [1, 2, 3].map((n) => `${CANONICAL}${n}.${n === 2 ? 'png' : 'jpg'}`);
        assert.deepStrictEqual(fetchStub.attempted, expected);
    });

    it('falls back through the i1-i4 mirrors when the canonical host fails', async () => {
        // maxConcurrentDownloads 1 keeps the fetch order deterministic.
        chrome = makeChromeStub('zip', '1');
        globalThis.chrome = chrome;
        fetchStub = makeFetchStub([CANONICAL, MIRRORS[0]]);
        globalThis.fetch = fetchStub;

        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        // Every page tries canonical, then i1 (both fail), then succeeds on i2.
        const expected = [1, 2, 3].flatMap((n) => {
            const file = `${n}.${n === 2 ? 'png' : 'jpg'}`;
            return [`${CANONICAL}${file}`, `${MIRRORS[0]}${file}`, `${MIRRORS[1]}${file}`];
        });
        assert.deepStrictEqual(fetchStub.attempted, expected);
    });

    it('builds a ZIP with padded original-page names and correct bytes', async () => {
        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        assert.strictEqual(chrome.downloads.calls.length, 1);
        const { url, filename } = chrome.downloads.calls[0];
        assert.strictEqual(filename, 'Downloads/Test.zip');

        const zip = await decodeZip(url);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        assert.deepStrictEqual(names, [
            'Downloads/Test/001.jpg',
            'Downloads/Test/002.png',
            'Downloads/Test/003.jpg'
        ]);
        for (let i = 0; i < names.length; i++) {
            const content = new Uint8Array(await zip.file(names[i]).async('uint8array'));
            const want = pageBytes[i];
            assert.strictEqual(content.length, want.length, names[i] + ' byte length');
            assert.ok(want.every((b, j) => b === content[j]), names[i] + ' bytes must be the fetched page, not a thumbnail');
        }
    });

    it('reports a failure when every image host fails', async () => {
        fetchStub = makeFetchStub([CANONICAL].concat(MIRRORS));
        globalThis.fetch = fetchStub;

        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Test', (e) => { error = e; }, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0; // disable backoff for deterministic test counting
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to fetch original image/.test(error));
        assert.strictEqual(fetchStub.attempted.length, 3 * 6 * 5, '3 pages x (1 attempt + 5 retries) x 5 hosts');
    });

    it('skips a mirror that answers 200 with an HTML challenge page instead of an image', async () => {
        // maxConcurrentDownloads 1 keeps the fetch order deterministic.
        chrome = makeChromeStub('zip', '1');
        globalThis.chrome = chrome;
        fetchStub = makeFetchStub([], [CANONICAL]);
        globalThis.fetch = fetchStub;

        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        // Every page hits the canonical host (200 but text/html), then succeeds
        // on the first numbered mirror.
        const expected = [1, 2, 3].flatMap((n) => {
            const file = `${n}.${n === 2 ? 'png' : 'jpg'}`;
            return [`${CANONICAL}${file}`, `${MIRRORS[0]}${file}`];
        });
        assert.deepStrictEqual(fetchStub.attempted, expected);
        // The ZIP must contain the real page bytes, not the HTML challenge.
        const zip = await decodeZip(chrome.downloads.calls[0].url);
        const names = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort();
        assert.strictEqual(names.length, 3);
        const first = new Uint8Array(await zip.file(names[0]).async('uint8array'));
        assert.ok(pageBytes[0].every((b, j) => b === first[j]), 'first entry must be image bytes');
    });

    it('reports an error when every host answers with HTML challenge pages', async () => {
        fetchStub = makeFetchStub([], [CANONICAL].concat(MIRRORS));
        globalThis.fetch = fetchStub;

        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Test', (e) => { error = e; }, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to fetch original image/.test(error));
        assert.ok(/unexpected content-type/.test(error), 'the error must mention the content-type rejection: ' + error);
        assert.strictEqual(fetchStub.attempted.length, 3 * 6 * 5, '3 pages x (1 attempt + 5 retries) x 5 hosts');
    });

    it('rejects a response that is too small (below minImageBytes)', async () => {
        // maxConcurrentDownloads 1 keeps the fetch order deterministic.
        chrome = makeChromeStub('zip', '1');
        globalThis.chrome = chrome;
        // Return a tiny response (only 10 bytes) from all hosts so every mirror
        // is tried and rejected for being too small.
        const tinyBody = new Uint8Array(10);
        globalThis.fetch = (url) => {
            return Promise.resolve(new Response(tinyBody, {
                status: 200,
                headers: { 'Content-Type': 'image/jpeg' }
            }));
        };

        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Test', (e) => { error = e; }, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null, 'an error must be reported');
        assert.ok(/response too small/.test(error), 'the error must mention the size: ' + error);
    });
});

describe('Downloader (raw mode)', () => {
    let chrome;
    let fetchStub;

    beforeEach(() => {
        chrome = makeChromeStub('raw');
        fetchStub = makeFetchStub();
        globalThis.chrome = chrome;
        globalThis.fetch = fetchStub;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.FileReader;
    });

    it('hands each original page URL to the downloads API with the configured path', async () => {
        const downloader = new Downloader(gallery, 'Downloads/RawTest', () => {}, () => {}, 'RawTest', new JSZip(), null);
        await downloader.startAsync();

        assert.strictEqual(chrome.downloads.calls.length, 3);
        const urls = chrome.downloads.calls.map((c) => c.url);
        assert.deepStrictEqual(urls, [
            `${CANONICAL}1.jpg`,
            `${CANONICAL}2.png`,
            `${CANONICAL}3.jpg`
        ]);
        const filenames = chrome.downloads.calls.map((c) => c.filename);
        assert.deepStrictEqual(filenames, [
            'NHDW/Downloads/RawTest/001.jpg',
            'NHDW/Downloads/RawTest/002.png',
            'NHDW/Downloads/RawTest/003.jpg'
        ]);
        // Raw mode must not fetch anything itself (Chrome does the download).
        assert.strictEqual(fetchStub.attempted.length, 0);
    });

    it('groups raw pages under the master folder by default and honors a custom one', async () => {
        const customChrome = makeChromeStub('raw', '3', { rawMasterFolder: 'Stash' });
        globalThis.chrome = customChrome;
        const custom = new Downloader(gallery, 'Downloads/RawTest', () => {}, () => {}, 'RawTest', new JSZip(), null);
        await custom.startAsync();
        assert.deepStrictEqual(customChrome.downloads.calls.map((c) => c.filename), [
            'Stash/Downloads/RawTest/001.jpg',
            'Stash/Downloads/RawTest/002.png',
            'Stash/Downloads/RawTest/003.jpg'
        ]);
    });

    it('saves straight into the titled folder when the master folder setting is empty', async () => {
        const offChrome = makeChromeStub('raw', '3', { rawMasterFolder: '' });
        globalThis.chrome = offChrome;
        const off = new Downloader(gallery, 'Downloads/RawTest', () => {}, () => {}, 'RawTest', new JSZip(), null);
        await off.startAsync();
        assert.deepStrictEqual(offChrome.downloads.calls.map((c) => c.filename), [
            'Downloads/RawTest/001.jpg',
            'Downloads/RawTest/002.png',
            'Downloads/RawTest/003.jpg'
        ]);
    });

    it('sanitizes a user-typed master folder per path segment', async () => {
        const weirdChrome = makeChromeStub('raw', '3', { rawMasterFolder: 'My:Folder* ' });
        globalThis.chrome = weirdChrome;
        const weird = new Downloader(gallery, 'Downloads/RawTest', () => {}, () => {}, 'RawTest', new JSZip(), null);
        await weird.startAsync();
        assert.deepStrictEqual(weirdChrome.downloads.calls.map((c) => c.filename), [
            'MyFolder/Downloads/RawTest/001.jpg',
            'MyFolder/Downloads/RawTest/002.png',
            'MyFolder/Downloads/RawTest/003.jpg'
        ]);
    });

    it('retries and reports errors through the callback instead of dropping them', async () => {
        chrome.downloads.download = (opts, cb) => {
            chrome.downloads.calls.push(opts);
            chrome.runtime.lastError = { message: 'download failed (fixture)' };
            if (cb) cb(undefined);
        };
        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Fail', (e) => { error = e; }, () => {}, 'Fail', new JSZip(), null);
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to download original image/.test(error));
        assert.ok(/download failed \(fixture\)/.test(error), 'the browser\'s reason must be readable, not [object Object]: ' + error);
        assert.strictEqual(chrome.downloads.calls.length, 3 * 6, '3 pages x (1 attempt + 5 retries)');
    });

    // ---- completion tracking (3.6.0) -------------------------------------
    // With chrome.downloads.onChanged available, a page only counts as saved
    // once its download reaches state "complete". The stub below drives the
    // terminal state per download from a script so the tests can simulate a
    // page that is interrupted AFTER it started.
    function makeTrackedChromeStub(outcomeFor, rawMaxConcurrent) {
        const stub = makeChromeStub('raw', '3', { rawMaxConcurrent: rawMaxConcurrent || '3' });
        const listeners = [];
        let nextId = 1;
        let inFlight = 0;
        stub.downloads.maxInFlight = 0;
        stub.downloads.onChanged = { addListener(fn) { listeners.push(fn); } };
        stub.downloads.cancelled = [];
        stub.downloads.cancel = (id, cb) => { stub.downloads.cancelled.push(id); if (cb) cb(); };
        stub.downloads.search = (query, cb) => cb([{ id: query.id, state: 'in_progress' }]);
        stub.downloads.download = (opts, cb) => {
            const id = nextId++;
            const attempt = stub.downloads.calls.filter((c) => c.filename === opts.filename).length;
            stub.downloads.calls.push(opts);
            inFlight++;
            stub.downloads.maxInFlight = Math.max(stub.downloads.maxInFlight, inFlight);
            if (cb) cb(id);
            const outcome = outcomeFor(opts.filename, attempt);
            setTimeout(() => {
                inFlight--;
                const delta = outcome === 'complete'
                    ? { id: id, state: { current: 'complete' } }
                    : { id: id, state: { current: 'interrupted' }, error: { current: outcome } };
                for (const fn of listeners) fn(delta);
            }, 2);
        };
        return stub;
    }

    it('counts a raw page as saved only when its download completes (not when it starts)', async () => {
        // Page 2 is interrupted once after it started, then completes on retry.
        const tracked = makeTrackedChromeStub((filename, attempt) =>
            (/002\.png$/.test(filename) && attempt === 0) ? 'NETWORK_FAILED' : 'complete');
        globalThis.chrome = tracked;
        let error = null;
        const retries = [];
        const downloader = new Downloader(gallery, 'Downloads/Tracked', (e) => { error = e; }, (_p, _n, _z, retry) => { if (retry) retries.push(retry); }, 'Tracked', new JSZip(), null);
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();
        assert.strictEqual(error, null, 'a page that succeeds on retry must not fail the gallery');
        assert.strictEqual(tracked.downloads.calls.length, 4, '3 pages + 1 retry of the interrupted page');
        assert.strictEqual(tracked.downloads.calls.filter((c) => /002\.png$/.test(c.filename)).length, 2);
        assert.ok(retries.length >= 1 && /retry 1\/5/.test(retries[0]), 'the retry must surface in the progress UI');
        assert.ok(downloader.isDone());
    });

    it('fails the gallery (never "complete") when a raw page keeps getting interrupted', async () => {
        const tracked = makeTrackedChromeStub((filename) => /003\.jpg$/.test(filename) ? 'FILE_NO_SPACE' : 'complete');
        globalThis.chrome = tracked;
        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Defective', (e) => { error = e; }, () => {}, 'Defective', new JSZip(), null);
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to download original image/.test(error), 'the gallery must be reported as failed: ' + error);
        assert.ok(/FILE_NO_SPACE/.test(error), 'the interruption reason must be visible: ' + error);
        assert.strictEqual(tracked.downloads.calls.filter((c) => /003\.jpg$/.test(c.filename)).length, 6, '1 attempt + 5 retries for the bad page');
        assert.strictEqual(tracked.downloads.calls.filter((c) => !/003\.jpg$/.test(c.filename)).length, 2, 'good pages are downloaded once');
    });

    it('caps how many raw pages are in flight at once (rawMaxConcurrent, independent of the archive setting)', async () => {
        const bigGallery = Object.assign({}, gallery, { images: { pages: [1, 2, 3, 4, 5, 6, 7].map(() => ({ t: 'j' })) } });
        const tracked = makeTrackedChromeStub(() => 'complete', '2');
        // The archive concurrency setting is much higher; raw must ignore it.
        tracked.storage.sync.get = (defaults, cb) => cb(Object.assign({}, defaults, { useZip: 'raw', maxConcurrentDownloads: '15', rawMaxConcurrent: '2' }));
        globalThis.chrome = tracked;
        const downloader = new Downloader(bigGallery, 'Downloads/Capped', () => {}, () => {}, 'Capped', new JSZip(), null);
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();
        assert.strictEqual(tracked.downloads.calls.length, 7);
        assert.strictEqual(tracked.downloads.maxInFlight, 2, 'never more than rawMaxConcurrent browser downloads at once');
        assert.strictEqual(downloader.maxConcurrentDownloads, 2);
    });

    it('applies the relayed rawMaxConcurrent in contexts without chrome.storage (offscreen options)', async () => {
        const tracked = makeTrackedChromeStub(() => 'complete');
        globalThis.chrome = tracked;
        const downloader = new Downloader(gallery, 'Downloads/Relayed', () => {}, () => {}, 'Relayed', new JSZip(), null, null, undefined,
            { useZip: 'raw', maxConcurrentDownloads: '10', rawMaxConcurrent: '1', archiveLayout: 'flat' });
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();
        assert.strictEqual(downloader.maxConcurrentDownloads, 1);
        assert.strictEqual(tracked.downloads.maxInFlight, 1);
    });

    it('a cancelled job stops waiting and cancels the loose page downloads', async () => {
        const stub = makeChromeStub('raw');
        const listeners = [];
        stub.downloads.onChanged = { addListener(fn) { listeners.push(fn); } };
        stub.downloads.cancelled = [];
        stub.downloads.cancel = (id, cb) => { stub.downloads.cancelled.push(id); if (cb) cb(); };
        stub.downloads.search = (query, cb) => cb([{ id: query.id, state: 'in_progress' }]);
        let nextId = 1;
        stub.downloads.download = (opts, cb) => { stub.downloads.calls.push(opts); if (cb) cb(nextId++); }; // never completes
        globalThis.chrome = stub;
        const controller = new AbortController();
        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Abort', (e) => { error = e; }, () => {}, 'Abort', new JSZip(), null, controller.signal);
        downloader.retryBackoffMs = 0;
        const run = downloader.startAsync();
        await new Promise((r) => setTimeout(r, 5));
        controller.abort();
        await assert.rejects(run);
        assert.strictEqual(error, null, 'a user cancel is not reported as an error');
        assert.ok(stub.downloads.cancelled.length >= 1, 'in-flight raw pages are cancelled in the browser');
    });
});

describe('Downloader (PDF mode)', () => {
    let chrome;

    // Minimal JPEGs with a real SOF0 frame so the PDF path can read the
    // dimensions and embed them without a canvas re-encode.
    function makeJpegPage(width, height) {
        const buf = new Uint8Array(2000);
        buf.set([
            0xFF, 0xD8,                                  // SOI
            0xFF, 0xC0, 0x00, 0x11,                      // SOF0, length 17
            0x08,                                        // precision
            (height >> 8) & 0xFF, height & 0xFF,         // height
            (width >> 8) & 0xFF, width & 0xFF,           // width
            0x03,                                        // 3 components (RGB)
            0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
        ]);
        buf[buf.length - 2] = 0xFF;
        buf[buf.length - 1] = 0xD9;                      // EOI
        return buf;
    }

    const jpegPages = [makeJpegPage(120, 200), makeJpegPage(120, 190), makeJpegPage(120, 180)];

    beforeEach(() => {
        chrome = makeChromeStub('pdf');
        globalThis.chrome = chrome;
        globalThis.fetch = (url) => {
            const m = /\/([0-9]+)\.(jpg|png)$/.exec(String(url));
            const idx = m ? parseInt(m[1], 10) - 1 : 0;
            return Promise.resolve(new Response(jpegPages[idx], {
                status: 200,
                headers: { 'Content-Type': 'image/jpeg' }
            }));
        };
        globalThis.URL = undefined; // Node has no createObjectURL -> data-URL branch
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('assembles one PDF per gallery named after the title, pages in order, never zips', async () => {
        const saved = [];
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/PdfTest', () => {}, () => {}, 'PdfTest', new JSZip(), 'Downloads/PdfTest', null, undefined, { useZip: 'pdf', maxConcurrentDownloads: 3 });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        downloader.saveUrl = (url, filename) => {
            saved.push({ url, filename });
            return Promise.resolve();
        };
        await downloader.startAsync();

        assert.strictEqual(chrome.downloads.calls.length, 0, 'PDF mode must not use chrome.downloads directly');
        assert.strictEqual(saved.length, 1, 'one PDF artifact for the whole gallery');
        assert.strictEqual(saved[0].filename, 'Downloads/PdfTest.pdf');
        assert.ok(/^data:application\/pdf;base64,/.test(saved[0].url), 'expected a PDF data URL, got ' + saved[0].url.slice(0, 40));
        const bytes = Buffer.from(saved[0].url.split(',')[1], 'base64');
        assert.ok(bytes.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'PDF header');
        assert.ok(bytes.toString('latin1').includes('/Count 3'), 'three pages');
        assert.ok(bytes.toString('latin1').endsWith('%%EOF\n'), 'PDF trailer');
        // The embedded images keep their original bytes (DCTDecode, no re-encode).
        const occurrences = bytes.toString('latin1').split('/Filter /DCTDecode').length - 1;
        assert.strictEqual(occurrences, 3, 'one embedded JPEG per page');
        // Page order: first embedded image must be page 1's dimensions.
        const mediaBox = bytes.toString('latin1').match(/\/MediaBox \[0 0 (\d+) (\d+)\]/g);
        assert.ok(mediaBox, 'MediaBox entries found');
        assert.strictEqual(mediaBox[0], '/MediaBox [0 0 120 200]', 'page 1 first');
        assert.strictEqual(mediaBox[2], '/MediaBox [0 0 120 180]', 'page 3 last');
        assert.ok(downloader.isDone(), 'PDF mode must report completion');
    });

    it('maps the retired "folder" format to PDF so old settings keep working', async () => {
        const saved = [];
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/LegacyFolder', () => {}, () => {}, 'LegacyFolder', new JSZip(), 'Downloads/LegacyFolder', null, undefined, { useZip: 'folder', maxConcurrentDownloads: 3 });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        downloader.saveUrl = (url, filename) => {
            saved.push({ url, filename });
            return Promise.resolve();
        };
        await downloader.startAsync();
        assert.strictEqual(saved.length, 1);
        assert.strictEqual(saved[0].filename, 'Downloads/LegacyFolder.pdf');
        assert.ok(/^data:application\/pdf/.test(saved[0].url));
    });

    it('uses constructor settings and never reads chrome.storage', async () => {
        let storageReads = 0;
        chrome.storage.sync.get = (defaults, cb) => {
            storageReads++;
            cb(Object.assign({}, defaults));
        };
        const saved = [];
        // downloadName null = mid-batch gallery (no final artifact of its own).
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/PdfMidBatch', () => {}, () => {}, 'PdfMidBatch', new JSZip(), null, null, undefined, { useZip: 'pdf' });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        downloader.saveUrl = (url, filename) => {
            saved.push(filename);
            return Promise.resolve();
        };
        await downloader.startAsync();
        assert.strictEqual(storageReads, 0, 'constructor settings must skip chrome.storage');
        assert.strictEqual(saved.length, 0, 'mid-batch PDF galleries do not emit their own file');
    });
});

describe('Downloader (archive layout)', () => {
    let chrome;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        globalThis.chrome = chrome;
        globalThis.fetch = makeFetchStub();
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('puts pages at the archive root for a single-gallery (flat) archive', async () => {
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/Flat', () => {}, () => {}, 'Flat', new JSZip(), 'Downloads/Flat', null, undefined, { useZip: 'zip', maxConcurrentDownloads: 3, archiveLayout: 'flat' });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        assert.strictEqual(chrome.downloads.calls.length, 1);
        const { filename, url } = chrome.downloads.calls[0];
        assert.strictEqual(filename, 'Downloads/Flat.zip', 'archive named after the gallery');
        const zip = await decodeZip(url);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        assert.deepStrictEqual(names, ['001.jpg', '002.png', '003.jpg'], 'no Title/Title double folder inside');
    });

    it('keeps one folder per gallery inside a shared (nested) batch archive', async () => {
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/Nested', () => {}, () => {}, 'Nested', new JSZip(), 'Downloads/Nested', null, undefined, { useZip: 'zip', maxConcurrentDownloads: 3, archiveLayout: 'nested' });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        const zip = await decodeZip(chrome.downloads.calls[0].url);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        assert.deepStrictEqual(names, ['Downloads/Nested/001.jpg', 'Downloads/Nested/002.png', 'Downloads/Nested/003.jpg']);
    });
});

describe('Downloader (optional archive master folder)', () => {
    // List mode can wrap finished archives in a master folder the same way raw
    // downloads wrap their titled folders - but the wrap is a user choice, so
    // it must be OFF unless a caller asks for it (single-title downloads keep
    // landing straight in the download folder).
    let chrome;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        globalThis.chrome = chrome;
        globalThis.fetch = makeFetchStub();
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    async function runWith(settings) {
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Title', () => {}, () => {}, 'Title',
            new JSZip(), 'Title', null, undefined,
            Object.assign({ useZip: 'zip', maxConcurrentDownloads: 3, archiveLayout: 'flat' }, settings));
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();
        return chrome.downloads.calls[0].filename;
    }

    it('saves straight into the download folder when no master folder is requested', async () => {
        assert.strictEqual(await runWith({}), 'Title.zip');
    });

    it('wraps the archive when the caller asks for a master folder', async () => {
        assert.strictEqual(await runWith({ archiveMasterFolder: 'NHDW' }), 'NHDW/Title.zip');
    });

    it('treats an explicitly empty master folder as "no wrap"', async () => {
        assert.strictEqual(await runWith({ archiveMasterFolder: '' }), 'Title.zip');
    });

    it('supports a nested master folder path', async () => {
        assert.strictEqual(await runWith({ archiveMasterFolder: 'NHDW/lists' }), 'NHDW/lists/Title.zip');
    });

    it('sanitizes a user-typed master folder per path segment', async () => {
        assert.strictEqual(await runWith({ archiveMasterFolder: 'My:Folder* ' }), 'MyFolder/Title.zip');
    });
});

describe('sanitizeArtifactFilename', () => {
    it('keeps clean names and subfolders untouched', () => {
        assert.strictEqual(sanitizeArtifactFilename('Downloads/Some Title/001.jpg', 'x'), 'Downloads/Some Title/001.jpg');
        assert.strictEqual(sanitizeArtifactFilename('Title.zip', 'x'), 'Title.zip');
    });

    it('strips reserved characters that make Chrome drop the filename', () => {
        assert.strictEqual(sanitizeArtifactFilename('What?Ever:*.zip', 'x'), 'WhatEver.zip');
        // Backslashes and stray leading dots disappear per segment.
        assert.strictEqual(sanitizeArtifactFilename('..\\hidden/..jpg', 'x'), 'hidden/jpg');
        // Control characters are removed entirely.
        assert.strictEqual(sanitizeArtifactFilename('bad\nname.zip', 'x'), 'badname.zip');
    });

    it('trims trailing dots and spaces per segment (Windows rejects them)', () => {
        assert.strictEqual(sanitizeArtifactFilename('title.zip.  ', 'x'), 'title.zip');
        assert.strictEqual(sanitizeArtifactFilename('folder. /page.jpg', 'x'), 'folder/page.jpg');
    });

    it('bounds segment length and never returns an empty name', () => {
        const long = 'a'.repeat(400);
        const sanitized = sanitizeArtifactFilename(long + '.zip', 'x');
        assert.ok(sanitized.length <= 124, 'segment capped: ' + sanitized.length);
        assert.ok(sanitized.length > 0);
        assert.strictEqual(sanitizeArtifactFilename('', 'Gallery 123'), 'Gallery 123');
        assert.notStrictEqual(sanitizeArtifactFilename('///', 'x'), '');
    });
});

describe('Downloader (corrupt settings)', () => {
    let chrome;
    let fetchStub;

    beforeEach(() => {
        chrome = makeChromeStub('zip', '3');
        // Corrupt the stored value: an unknown format string.
        chrome.storage.sync.get = (defaults, cb) => {
            cb(Object.assign({}, defaults, { useZip: '7z (corrupt)' }));
        };
        fetchStub = makeFetchStub();
        globalThis.chrome = chrome;
        globalThis.fetch = fetchStub;
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('falls back to zip for an unknown useZip value and still saves the archive', async () => {
        // Regression guard: an unknown value must behave like "zip" (pages
        // fetched AND archive delivered), not like an invisible no-op.
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/Corrupt', () => {}, () => {}, 'Corrupt', new JSZip(), 'Downloads/Corrupt');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();
        assert.strictEqual(chrome.downloads.calls.length, 1, 'the archive must still be saved');
        assert.strictEqual(chrome.downloads.calls[0].filename, 'Downloads/Corrupt.zip');
    });
});

describe('Downloader (abort/cancellation)', () => {
    let chrome;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        globalThis.chrome = chrome;
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('aborts in-flight image fetches and never surfaces an error callback', async () => {
        const controller = new AbortController();
        // Fetch resolves slowly unless the signal aborts first; this proves the
        // in-flight request is actually cancelled, not just flagged.
        globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
            const m = /\/([0-9]+)\.(jpg|png)$/.exec(String(url));
            const idx = m ? parseInt(m[1], 10) - 1 : 0;
            const timer = setTimeout(() => resolve(new Response(pageBytes[idx], { status: 200 })), 500);
            const onAbort = () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            };
            if (opts && opts.signal) {
                if (opts.signal.aborted) onAbort();
                else opts.signal.addEventListener('abort', onAbort, { once: true });
            }
        });

        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Test', (e) => { error = e; }, () => {}, 'Test', new JSZip(), 'Downloads/Test', controller.signal);
        const promise = downloader.startAsync();

        // Let the first batch of fetches go in-flight, then cancel.
        await new Promise((r) => setTimeout(r, 10));
        controller.abort();

        await assert.rejects(promise);
        assert.strictEqual(error, null, 'a user cancellation must not surface as a download error');
        assert.strictEqual(chrome.downloads.calls.length, 0, 'no ZIP must be delivered after cancellation');
    });

    it('does not retry or fall back to mirrors after the signal is aborted', async () => {
        const controller = new AbortController();
        let fetchCalls = 0;
        globalThis.fetch = (url, opts) => {
            fetchCalls++;
            if (opts && opts.signal && opts.signal.aborted) {
                return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }
            const m = /\/([0-9]+)\.(jpg|png)$/.exec(String(url));
            const idx = m ? parseInt(m[1], 10) - 1 : 0;
            return Promise.resolve(new Response(pageBytes[idx], { status: 200 }));
        };

        // Abort BEFORE the download starts: each page fetch must fail once with
        // an AbortError and never trigger the 5x retry / mirror fallback.
        controller.abort();
        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test', controller.signal);
        await assert.rejects(downloader.startAsync());

        assert.strictEqual(fetchCalls, 0, 'already-aborted jobs must not start image fetches');
        assert.strictEqual(chrome.downloads.calls.length, 0, 'no ZIP must be delivered when aborted');
    });
});

describe('tab image URL guard', () => {
    it('allows only original-image CDN URLs', () => {
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/987654/1.jpg'), true);
        assert.strictEqual(isAllowedImageUrl('https://i2.nhentai.net/galleries/1/12.webp'), true);
        assert.strictEqual(isAllowedImageUrl('https://nhentai.net/g/1/'), false);
        assert.strictEqual(isAllowedImageUrl('https://evil.example/galleries/1/1.jpg'), false);
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/1/1.jpg?x=1'), false);
    });

    it('round-trips base64 image bytes', () => {
        const b64 = Buffer.from(pageBytes[0]).toString('base64');
        const decoded = decodeTabImageBytes(b64);
        assert.strictEqual(decoded.length, pageBytes[0].length);
        assert.ok(pageBytes[0].every((b, i) => b === decoded[i]));
    });
});

describe('Downloader (tab image fetch)', () => {
    let chrome;

    beforeEach(() => {
        chrome = makeChromeStub('zip', '1');
        globalThis.chrome = chrome;
        globalThis.URL = undefined;
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    function tabScriptReturningPages() {
        const attempted = [];
        chrome.scripting = {
            executeScript(details, cb) {
                const url = details.args[0];
                attempted.push(url);
                const m = /\/([0-9]+)\.(jpg|png)$/.exec(url);
                const idx = m ? parseInt(m[1], 10) - 1 : 0;
                cb([{ result: {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    contentType: idx === 1 ? 'image/png' : 'image/jpeg',
                    b64: Buffer.from(pageBytes[idx]).toString('base64'),
                    error: null
                } }]);
            }
        };
        return attempted;
    }

    it('fetches through the open tab and does not use extension-origin fetch', async () => {
        const attempted = tabScriptReturningPages();
        const worlds = [];
        const inner = chrome.scripting.executeScript;
        chrome.scripting.executeScript = (details, cb) => {
            worlds.push(details.world || 'ISOLATED');
            return inner(details, cb);
        };
        let fetchCalls = 0;
        globalThis.fetch = () => {
            fetchCalls++;
            return Promise.reject(new Error('extension fetch should not run'));
        };

        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.sourceTabId = 99;
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();

        assert.strictEqual(fetchCalls, 0);
        assert.ok(worlds.every((w) => w === 'ISOLATED'), 'isolated world must be tried first so CDN CORS cannot block the tab fetch: ' + worlds.join(','));
        assert.deepStrictEqual(attempted, [1, 2, 3].map((n) => `${CANONICAL}${n}.${n === 2 ? 'png' : 'jpg'}`));
        const zip = await decodeZip(chrome.downloads.calls[0].url);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        const first = new Uint8Array(await zip.file(names[0]).async('uint8array'));
        assert.ok(pageBytes[0].every((b, j) => b === first[j]));
    });

    it('falls back to extension fetch when the tab CORS-fails', async () => {
        chrome.scripting = {
            executeScript(details, cb) {
                cb([{ result: { ok: false, status: 0, statusText: '', contentType: null, b64: null, error: 'Failed to fetch' } }]);
            }
        };
        const fetchStub = makeFetchStub();
        globalThis.fetch = fetchStub;

        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.sourceTabId = 7;
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await downloader.startAsync();
        assert.ok(fetchStub.attempted.length > 0, 'extension fetch must run after a tab CORS failure');
        assert.strictEqual(chrome.downloads.calls.length, 1);
    });

    it('skips extension fetch after a tab HTTP 403 and says metadata was read', async () => {
        chrome.scripting = {
            executeScript(details, cb) {
                cb([{ result: { ok: false, status: 403, statusText: 'Forbidden', contentType: 'text/html', b64: null, error: null } }]);
            }
        };
        let fetchCalls = 0;
        globalThis.fetch = () => {
            fetchCalls++;
            return Promise.resolve(new Response('nope', { status: 403 }));
        };

        let error = null;
        const downloader = new Downloader(gallery, 'Downloads/Test', (e) => { error = e; }, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.sourceTabId = 3;
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        await assert.rejects(downloader.startAsync());
        assert.strictEqual(fetchCalls, 0, 'a real HTTP error from the tab must not also hammer the extension origin');
        assert.ok(error !== null && /Failed to fetch original image/.test(error));
        assert.ok(/Gallery metadata was read/.test(error), error);
        assert.ok(/403/.test(error), error);
    });
});

describe('Downloader (retry backoff)', () => {
    it('has a configurable retryBackoffMs with a sensible default', () => {
        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        assert.strictEqual(downloader.retryBackoffMs, 200, 'default backoff should be 200ms');
        downloader.retryBackoffMs = 0;
        assert.strictEqual(downloader.retryBackoffMs, 0);
        downloader.retryBackoffMs = 1000;
        assert.strictEqual(downloader.retryBackoffMs, 1000);
    });
});

describe('Downloader (object URL delivery, offscreen document)', () => {
    let chrome;
    let storedBlobs;
    let revoked;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        storedBlobs = [];
        revoked = [];
        globalThis.chrome = chrome;
        globalThis.fetch = makeFetchStub();
        globalThis.FileReader = FileReaderStub;
        globalThis.URL = {
            createObjectURL(blob) {
                storedBlobs.push(blob);
                return 'blob:nhtest/1';
            },
            revokeObjectURL(url) { revoked.push(url); }
        };
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('downloads through URL.createObjectURL instead of a base64 data URL', async () => {
        const downloader = new Downloader(gallery, 'Downloads/Test', () => {}, () => {}, 'Test', new JSZip(), 'Downloads/Test');
        downloader.revokeObjectUrlDelayMs = 10;
        await downloader.startAsync();

        assert.strictEqual(chrome.downloads.calls.length, 1);
        const { url, filename } = chrome.downloads.calls[0];
        assert.strictEqual(filename, 'Downloads/Test.zip');
        assert.strictEqual(url, 'blob:nhtest/1');
        assert.ok(!/^data:/.test(url), 'the base64 round-trip must not be used when object URLs exist');

        const buf = Buffer.from(await storedBlobs[0].arrayBuffer());
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        assert.deepStrictEqual(names, [
            'Downloads/Test/001.jpg',
            'Downloads/Test/002.png',
            'Downloads/Test/003.jpg'
        ]);

        // The object URL must be released after the download is accepted.
        await new Promise((r) => setTimeout(r, 50));
        assert.deepStrictEqual(revoked, ['blob:nhtest/1']);
    });
});
