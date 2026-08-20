// Fixture tests for the Downloader: image URL generation and fallback order,
// ZIP entry naming/content, raw mode, and the object-URL delivery branch.
// No network access required; the class under test is compiled from
// src/background/Downloader.ts into build/test by tsconfig.test.json.

const assert = require('assert');
const JSZip = require('jszip');
const Downloader = require('../build/test/background/Downloader.js').default;

const gallery = {
    id: 123456,
    media_id: 987654,
    title: { english: 'Test', japanese: '', pretty: 'Test' },
    images: { pages: [{ t: 'j' }, { t: 'p' }, { t: 'j' }] },
    tags: []
};

const pageBytes = [
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x04, 0x05]),
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x06, 0x07, 0x08])
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
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to fetch original image/.test(error));
        assert.ok(/unexpected content-type/.test(error), 'the error must mention the content-type rejection: ' + error);
        assert.strictEqual(fetchStub.attempted.length, 3 * 6 * 5, '3 pages x (1 attempt + 5 retries) x 5 hosts');
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
        await assert.rejects(downloader.startAsync());
        assert.ok(error !== null && /Failed to download original image/.test(error));
        assert.strictEqual(chrome.downloads.calls.length, 3 * 6, '3 pages x (1 attempt + 5 retries)');
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

        assert.strictEqual(fetchCalls, 3, 'aborted pages must not be retried (3 pages, one canonical fetch each)');
        assert.strictEqual(chrome.downloads.calls.length, 0, 'no ZIP must be delivered when aborted');
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
