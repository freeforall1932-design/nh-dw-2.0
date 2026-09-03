// Folder-naming guard tests (downloadNaming.ts).
//
// Root cause this guards against: chrome.downloads.download()'s `filename`
// is ignored whenever ANY extension registers onDeterminingFilename
// (Chromium bug 579563). Raw pages then land as "1.jpg" in the root of
// Downloads instead of "NHDW/<Title>/001.jpg", and archives appear under
// blob UUIDs. The guard re-suggests the requested name for downloads this
// extension started.
//
// No network access required; the module is compiled from source.

const assert = require('assert');
const {
    recordDownloadRequest,
    bindDownloadId,
    forgetDownload,
    lookupSuggestion,
    installDownloadFilenameGuard,
    resetTrackedNamesForTests
} = require('../build/test/background/downloadNaming.js');

const OUR_ID = 'abcdefghijklmnopabcdefghijklmnop';

// Minimal chrome stub: runtime.id + optionally downloads events / session storage.
function makeChromeStub({ withDeterminingEvent = true, withSession = true } = {}) {
    const stub = {
        runtime: { id: OUR_ID, lastError: null },
        downloads: {
            download: () => {},
            onChanged: { addListener: () => {} }
        },
        storage: {}
    };
    if (withDeterminingEvent) {
        stub.downloads.onDeterminingFilename = { addListener: (fn) => { stub.determineListener = fn; } };
    }
    if (withSession) {
        stub.storage.session = {
            data: {},
            get(keys, cb) { cb({ [keys[0]]: this.data[keys[0]] }); },
            set(obj, cb) { Object.assign(this.data, obj); if (cb) cb(); }
        };
    }
    return stub;
}

function suggestionResult(listener, item) {
    let suggested = 'NOT_CALLED';
    listener(item, (suggestion) => { suggested = suggestion === undefined ? 'DEFAULT' : suggestion; });
    return suggested;
}

describe('download naming guard', () => {
    let originalChrome;
    beforeEach(() => {
        originalChrome = globalThis.chrome;
        resetTrackedNamesForTests();
    });
    afterEach(() => {
        globalThis.chrome = originalChrome;
        resetTrackedNamesForTests();
    });

    it('re-asserts the requested filename for our own download id (subfolder kept)', () => {
        globalThis.chrome = makeChromeStub();
        recordDownloadRequest('https://i2.nhentai.net/galleries/123/1.jpg', 'NHDW/[Artist] Title/001.jpg');
        installDownloadFilenameGuard();
        const listener = globalThis.chrome.downloads.onDeterminingFilename ? globalThis.chrome.determineListener : null;
        assert.ok(listener, 'listener must be registered');
        // The event can fire before download()'s callback: id unknown, url matches.
        assert.deepStrictEqual(suggestionResult(listener, { id: 7, url: 'https://i2.nhentai.net/galleries/123/1.jpg', byExtensionId: undefined }), {
            filename: 'NHDW/[Artist] Title/001.jpg',
            conflictAction: 'uniquify'
        });
        // After the callback the id alone is enough (URL could be hidden).
        bindDownloadId('https://i2.nhentai.net/galleries/123/1.jpg', 7);
        assert.deepStrictEqual(suggestionResult(listener, { id: 7, url: 'blob:other', byExtensionId: undefined }), {
            filename: 'NHDW/[Artist] Title/001.jpg',
            conflictAction: 'uniquify'
        });
    });

    it('never touches downloads started by other extensions', () => {
        globalThis.chrome = makeChromeStub();
        recordDownloadRequest('https://i2.nhentai.net/galleries/123/1.jpg', 'NHDW/Title/001.jpg');
        installDownloadFilenameGuard();
        const listener = globalThis.chrome.determineListener;
        assert.strictEqual(suggestionResult(listener, { id: 9, url: 'https://i2.nhentai.net/galleries/123/1.jpg', byExtensionId: 'someotherextensionid' }), 'DEFAULT');
    });

    it('stops asserting once its own download completed (manual saves stay default)', () => {
        globalThis.chrome = makeChromeStub();
        recordDownloadRequest('https://i2.nhentai.net/galleries/123/1.jpg', 'NHDW/Title/001.jpg');
        bindDownloadId('https://i2.nhentai.net/galleries/123/1.jpg', 11);
        // While our download is in flight the URL match asserts (the event
        // can also fire before the id is known — same rule).
        assert.strictEqual(lookupSuggestion({ id: 99, url: 'https://i2.nhentai.net/galleries/123/1.jpg', byExtensionId: undefined }), 'NHDW/Title/001.jpg');
        forgetDownload(11); // onChanged complete/interrupted hygiene
        // After completion the map is clean: a manual save of the same image
        // keeps its default naming.
        assert.strictEqual(lookupSuggestion({ id: 12, url: 'https://i2.nhentai.net/galleries/123/1.jpg', byExtensionId: undefined }), null);
    });

    it('falls back to default for unknown downloads', () => {
        globalThis.chrome = makeChromeStub();
        installDownloadFilenameGuard();
        const listener = globalThis.chrome.determineListener;
        assert.strictEqual(suggestionResult(listener, { id: 3, url: 'https://example.com/a.zip', byExtensionId: OUR_ID }), 'DEFAULT');
        assert.strictEqual(suggestionResult(listener, { id: 4, url: 'https://example.com/b.zip' }), 'DEFAULT');
    });

    it('re-asserts blob artifact names regardless of attribution', () => {
        globalThis.chrome = makeChromeStub();
        const blobUrl = 'blob:chrome-extension://' + OUR_ID + '/b14c-4e2f';
        recordDownloadRequest(blobUrl, '[Artist] Title.cbz');
        installDownloadFilenameGuard();
        const listener = globalThis.chrome.determineListener;
        assert.deepStrictEqual(suggestionResult(listener, { id: 21, url: blobUrl, byExtensionId: undefined }), {
            filename: '[Artist] Title.cbz',
            conflictAction: 'uniquify'
        });
    });

    it('recovers names from the session mirror after a worker restart', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        recordDownloadRequest('https://i.nhentai.net/galleries/9/2.png', 'NHDW/Restarted Gallery/002.png');
        // Simulate the worker restart: fresh memory maps, session data kept.
        const sessionData = stub.storage.session.data;
        resetTrackedNamesForTests();
        stub.storage.session.data = sessionData;
        installDownloadFilenameGuard();
        const listener = stub.determineListener;
        const item = { id: 42, url: 'https://i.nhentai.net/galleries/9/2.png', byExtensionId: OUR_ID };
        // The synchronous memory lookup misses, the session fallback (a sync
        // stub here) recovers the recorded name.
        assert.deepStrictEqual(suggestionResult(listener, item), {
            filename: 'NHDW/Restarted Gallery/002.png',
            conflictAction: 'uniquify'
        });
    });

    it('forgets a name once its download completes', () => {
        const stub = makeChromeStub();
        let changedListener = null;
        stub.downloads.onChanged = { addListener: (fn) => { changedListener = fn; } };
        globalThis.chrome = stub;
        recordDownloadRequest('https://i.nhentai.net/galleries/5/1.jpg', 'NHDW/Done Gallery/001.jpg');
        bindDownloadId('https://i.nhentai.net/galleries/5/1.jpg', 5);
        installDownloadFilenameGuard();
        assert.strictEqual(lookupSuggestion({ id: 5, url: 'https://i.nhentai.net/galleries/5/1.jpg', byExtensionId: OUR_ID }), 'NHDW/Done Gallery/001.jpg');
        changedListener({ id: 5, state: { previous: 'in_progress', current: 'complete' } });
        assert.strictEqual(lookupSuggestion({ id: 5, url: 'https://i.nhentai.net/galleries/5/1.jpg', byExtensionId: OUR_ID }), null);
        // Terminal-but-not-complete states (canceled -> interrupted) also clear.
        recordDownloadRequest('https://i.nhentai.net/galleries/6/1.jpg', 'NHDW/Canceled/001.jpg');
        bindDownloadId('https://i.nhentai.net/galleries/6/1.jpg', 6);
        changedListener({ id: 6, state: { previous: 'complete', current: 'interrupted' } });
        assert.strictEqual(lookupSuggestion({ id: 6, url: 'https://i.nhentai.net/galleries/6/1.jpg', byExtensionId: OUR_ID }), null);
    });

    it('stays a no-op where the event does not exist (Firefox) and never throws', () => {
        const stub = makeChromeStub({ withDeterminingEvent: false });
        globalThis.chrome = stub;
        assert.doesNotThrow(() => installDownloadFilenameGuard());
        assert.strictEqual(stub.determineListener, undefined);
        // Recording still works so the relay path stays functional.
        recordDownloadRequest('https://i.nhentai.net/galleries/1/1.jpg', 'NHDW/T/001.jpg');
        assert.strictEqual(lookupSuggestion({ id: 1, url: 'https://i.nhentai.net/galleries/1/1.jpg', byExtensionId: OUR_ID }), 'NHDW/T/001.jpg');
    });

    it('caps the tracked names so long sessions cannot grow unbounded', () => {
        globalThis.chrome = makeChromeStub({ withSession: false });
        for (let i = 0; i < 1500; i++) {
            recordDownloadRequest('https://cdn.example/' + i + '.jpg', 'NHDW/Gallery' + i + '/001.jpg');
        }
        const gone = lookupSuggestion({ id: undefined, url: 'https://cdn.example/0.jpg', byExtensionId: OUR_ID });
        const kept = lookupSuggestion({ id: undefined, url: 'https://cdn.example/1499.jpg', byExtensionId: OUR_ID });
        assert.strictEqual(gone, null, 'oldest entries must be evicted');
        assert.strictEqual(kept, 'NHDW/Gallery1499/001.jpg');
    });

    it('survives a completely missing chrome and malformed session mirror', () => {
        globalThis.chrome = undefined;
        assert.doesNotThrow(() => recordDownloadRequest('https://x/1.jpg', 'NHDW/T/001.jpg'));
        assert.doesNotThrow(() => bindDownloadId('https://x/1.jpg', 1));
        assert.doesNotThrow(() => forgetDownload(1));
        // Without chrome.runtime.id no download can be attributed to us, so
        // an http(s) match stays conservative (null); the id match would
        // still assert if the entry were not forgotten above.
        assert.strictEqual(lookupSuggestion({ id: 99, url: 'https://x/1.jpg' }), null);
        assert.doesNotThrow(() => recordDownloadRequest('blob:x/b2', 'NHDW/T/002.jpg'));
        assert.strictEqual(lookupSuggestion({ id: 99, url: 'blob:x/b2' }), 'NHDW/T/002.jpg');
        // Malformed mirror data is ignored on load.
        const stub = makeChromeStub();
        stub.storage.session.data = { nhdwDownloadNames: 'garbage' };
        globalThis.chrome = stub;
        assert.doesNotThrow(() => installDownloadFilenameGuard());
    });
});
