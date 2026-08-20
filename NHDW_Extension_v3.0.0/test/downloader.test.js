// Fixture tests for the Downloader: image URL generation and fallback order,
// ZIP entry naming/content, raw mode, and the object-URL delivery branch.
// No network access required; the class under test is compiled from
// src/background/Downloader.ts into build/test by tsconfig.test.json.

const assert = require('assert');
const JSZip = require('jszip');
const Downloader = require('../build/test/background/Downloader.js').default;
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

function makeChromeStub(useZip, maxConcurrentDownloads = '3') {
    const stub = {
        storage: {
            sync: {
                get(defaults, cb) {
                    cb(Object.assign({}, defaults, { useZip, maxConcurrentDownloads }));
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
            'Downloads/RawTest-001.jpg',
            'Downloads/RawTest-002.png',
            'Downloads/RawTest-003.jpg'
        ]);
        // Raw mode must not fetch anything itself (Chrome does the download).
        assert.strictEqual(fetchStub.attempted.length, 0);
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
        assert.strictEqual(chrome.downloads.calls.length, 3 * 6, '3 pages x (1 attempt + 5 retries)');
    });
});

describe('Downloader (folder mode)', () => {
    let chrome;
    let fetchStub;

    beforeEach(() => {
        chrome = makeChromeStub('zip');
        fetchStub = makeFetchStub();
        globalThis.chrome = chrome;
        globalThis.fetch = fetchStub;
        globalThis.URL = undefined; // Node has no createObjectURL -> data-URL branch
        globalThis.FileReader = FileReaderStub;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
        delete globalThis.URL;
        delete globalThis.FileReader;
    });

    it('saves one image file per page into the gallery folder and never zips', async () => {
        const saved = [];
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/FolderTest', () => {}, () => {}, 'FolderTest', new JSZip(), 'Downloads/FolderTest', null, undefined, { useZip: 'folder', maxConcurrentDownloads: 3 });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        downloader.saveUrl = (url, filename) => {
            saved.push({ url, filename });
            return Promise.resolve();
        };
        await downloader.startAsync();

        assert.strictEqual(chrome.downloads.calls.length, 0, 'folder mode must not use chrome.downloads directly');
        assert.strictEqual(saved.length, 3, 'one save per page');
        assert.deepStrictEqual(saved.map((s) => s.filename), [
            'Downloads/FolderTest/001.jpg',
            'Downloads/FolderTest/002.png',
            'Downloads/FolderTest/003.jpg'
        ]);
        for (const s of saved) {
            assert.ok(/^data:/.test(s.url) || /^blob:/.test(s.url), 'expected a data/blob URL, got ' + s.url.slice(0, 40));
        }
        assert.ok(downloader.isDone(), 'folder mode must report completion');
    });

    it('uses constructor settings and never reads chrome.storage', async () => {
        let storageReads = 0;
        chrome.storage.sync.get = (defaults, cb) => {
            storageReads++;
            cb(Object.assign({}, defaults));
        };
        const saved = [];
        // downloadName null = mid-batch gallery (no final archive of its own).
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/FolderTest2', () => {}, () => {}, 'FolderTest2', new JSZip(), null, null, undefined, { useZip: 'folder' });
        downloader.revokeObjectUrlDelayMs = 10;
        downloader.retryBackoffMs = 0;
        downloader.saveUrl = (url, filename) => {
            saved.push(filename);
            return Promise.resolve();
        };
        await downloader.startAsync();
        assert.strictEqual(storageReads, 0, 'constructor settings must skip chrome.storage');
        assert.strictEqual(saved.length, 3);
        assert.strictEqual(chrome.downloads.calls.length, 0);
    });

    it('fails the gallery when a folder save is rejected', async () => {
        let error = null;
        const downloader = new Downloader(JSON.parse(JSON.stringify(gallery)), 'Downloads/FolderFail', (e) => { error = e; }, () => {}, 'FolderFail', new JSZip(), 'Downloads/FolderFail', null, undefined, { useZip: 'folder', maxConcurrentDownloads: 1 });
        downloader.retryBackoffMs = 0;
        downloader.saveUrl = () => Promise.reject(new Error('disk full (fixture)'));
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to save image to 001\.jpg/.test(String(error)));
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
