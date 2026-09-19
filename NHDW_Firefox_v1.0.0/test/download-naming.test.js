// Folder-naming guard tests (downloadNaming.ts).
//
// Two distinct concerns are covered here.
//
// 1. NAMING CORRECTNESS. chrome.downloads.download()'s `filename` is ignored
//    whenever ANY extension registers onDeterminingFilename (Chromium bug
//    579563). Raw pages then land as "1.jpg" in the root of Downloads instead
//    of "NHDW/<Title>/001.jpg", and archives appear under blob UUIDs. The
//    guard re-suggests the requested name for downloads this extension
//    started.
//
// 2. LISTENER LIFETIME. onDeterminingFilename is a global naming-decision
//    event: registering it makes this extension a participant for every
//    download in the profile, so Chrome can blame it for files it has nothing
//    to do with ("failed to name the download ... because another extension
//    determined a different filename \"\""). Asserting only that foreign URLs
//    keep their names is NOT enough — a permanently registered listener is
//    itself the defect. These tests assert attach/detach directly.
//
// No network access required; the module is compiled from source.

const assert = require('assert');
const {
    recordDownloadRequest,
    bindDownloadId,
    discardDownloadRequest,
    forgetDownload,
    lookupSuggestion,
    installDownloadFilenameGuard,
    isFilenameListenerRegistered,
    pendingDownloadNameCount,
    resetTrackedNamesForTests
} = require('../build/test/background/downloadNaming.js');

const OUR_ID = 'abcdefghijklmnopabcdefghijklmnop';

// Minimal chrome stub: runtime.id + optionally downloads events / session
// storage. Tracks add/removeListener so listener lifetime is observable.
function makeChromeStub({ withDeterminingEvent = true, withSession = true } = {}) {
    const stub = {
        runtime: { id: OUR_ID, lastError: null },
        downloads: {
            download: () => {},
            onChanged: { addListener: (fn) => { stub.changedListener = fn; } }
        },
        storage: {},
        determineListener: null,
        addCount: 0,
        removeCount: 0
    };
    if (withDeterminingEvent) {
        stub.downloads.onDeterminingFilename = {
            addListener: (fn) => { stub.determineListener = fn; stub.addCount++; },
            removeListener: (fn) => {
                if (stub.determineListener === fn) stub.determineListener = null;
                stub.removeCount++;
            }
        };
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
    let calls = 0;
    listener(item, (suggestion) => { calls++; suggested = suggestion === undefined ? 'DEFAULT' : suggestion; });
    return { suggested, calls };
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

    // ---- listener lifetime (the cross-extension leak) --------------------

    describe('global listener lifetime', () => {
        it('does not register a filename listener while the worker is idle', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            installDownloadFilenameGuard();
            assert.strictEqual(stub.determineListener, null, 'idle worker must not join the naming chain');
            assert.strictEqual(stub.addCount, 0);
            assert.strictEqual(isFilenameListenerRegistered(), false);
        });

        it('registers lazily on the first own download and unregisters when it drains', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            installDownloadFilenameGuard();
            assert.strictEqual(isFilenameListenerRegistered(), false);

            recordDownloadRequest('https://i.nhentai.net/galleries/1/1.jpg', 'NHDW/T/001.jpg');
            assert.strictEqual(isFilenameListenerRegistered(), true, 'must join the chain for our own work');
            assert.ok(stub.determineListener, 'listener must be attached');
            assert.strictEqual(stub.addCount, 1);

            bindDownloadId('https://i.nhentai.net/galleries/1/1.jpg', 5);
            forgetDownload(5);
            assert.strictEqual(isFilenameListenerRegistered(), false, 'must leave the chain when idle again');
            assert.strictEqual(stub.determineListener, null);
            assert.strictEqual(stub.removeCount, 1);
            assert.strictEqual(pendingDownloadNameCount(), 0);
        });

        it('stays attached while any own download is still pending', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            installDownloadFilenameGuard();
            recordDownloadRequest('https://i.nhentai.net/g/1.jpg', 'NHDW/T/001.jpg');
            recordDownloadRequest('https://i.nhentai.net/g/2.jpg', 'NHDW/T/002.jpg');
            bindDownloadId('https://i.nhentai.net/g/1.jpg', 1);
            bindDownloadId('https://i.nhentai.net/g/2.jpg', 2);

            forgetDownload(1);
            assert.strictEqual(isFilenameListenerRegistered(), true, 'one still in flight');
            forgetDownload(2);
            assert.strictEqual(isFilenameListenerRegistered(), false);
        });

        it('detaches after an interrupted/cancelled download', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            installDownloadFilenameGuard();
            recordDownloadRequest('https://i.nhentai.net/g/3.jpg', 'NHDW/T/003.jpg');
            bindDownloadId('https://i.nhentai.net/g/3.jpg', 3);
            assert.strictEqual(isFilenameListenerRegistered(), true);
            stub.changedListener({ id: 3, state: { previous: 'in_progress', current: 'interrupted' } });
            assert.strictEqual(isFilenameListenerRegistered(), false);
        });

        it('detaches when download creation fails outright', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            installDownloadFilenameGuard();
            recordDownloadRequest('https://i.nhentai.net/g/4.jpg', 'NHDW/T/004.jpg');
            assert.strictEqual(isFilenameListenerRegistered(), true);
            discardDownloadRequest('https://i.nhentai.net/g/4.jpg');
            assert.strictEqual(isFilenameListenerRegistered(), false);
            assert.strictEqual(pendingDownloadNameCount(), 0);
        });

        it('detaches once the suggestion is consumed', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            const url = 'https://i.nhentai.net/g/5.jpg';
            recordDownloadRequest(url, 'NHDW/T/005.jpg');
            installDownloadFilenameGuard();
            const { suggested, calls } = suggestionResult(stub.determineListener, { id: 9, url, byExtensionId: OUR_ID });
            assert.deepStrictEqual(suggested, { filename: 'NHDW/T/005.jpg', conflictAction: 'uniquify' });
            assert.strictEqual(calls, 1, 'suggest must be called exactly once');
            assert.strictEqual(isFilenameListenerRegistered(), false, 'consumed entry must release the chain');
        });

        it('re-attaches after a worker restart only when work is outstanding', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            recordDownloadRequest('https://i.nhentai.net/galleries/9/2.png', 'NHDW/Restarted/002.png');
            const sessionData = stub.storage.session.data;

            // Restart with work in flight: mirror non-empty -> re-attach.
            resetTrackedNamesForTests();
            stub.determineListener = null;
            stub.storage.session.data = sessionData;
            installDownloadFilenameGuard();
            assert.strictEqual(isFilenameListenerRegistered(), true);

            // Restart with nothing in flight: mirror empty -> stay out.
            resetTrackedNamesForTests();
            stub.determineListener = null;
            stub.storage.session.data = {};
            installDownloadFilenameGuard();
            assert.strictEqual(isFilenameListenerRegistered(), false);
        });

        it('expires stale entries so a stuck download cannot pin the listener', () => {
            const stub = makeChromeStub();
            globalThis.chrome = stub;
            installDownloadFilenameGuard();
            recordDownloadRequest('https://i.nhentai.net/g/stuck.jpg', 'NHDW/T/stuck.jpg');
            assert.strictEqual(isFilenameListenerRegistered(), true);

            // Rewind the clock past the TTL (30 min) and poke the map.
            const realNow = Date.now;
            Date.now = () => realNow() + 31 * 60 * 1000;
            try {
                recordDownloadRequest('https://i.nhentai.net/g/fresh.jpg', 'NHDW/T/fresh.jpg');
                discardDownloadRequest('https://i.nhentai.net/g/fresh.jpg');
            } finally {
                Date.now = realNow;
            }
            assert.strictEqual(pendingDownloadNameCount(), 0, 'expired entry must be swept');
            assert.strictEqual(isFilenameListenerRegistered(), false);
        });

        it('is a no-op where the event does not exist (Firefox) and never throws', () => {
            const stub = makeChromeStub({ withDeterminingEvent: false });
            globalThis.chrome = stub;
            assert.doesNotThrow(() => installDownloadFilenameGuard());
            assert.strictEqual(stub.determineListener, null);
            assert.doesNotThrow(() => recordDownloadRequest('https://i.nhentai.net/galleries/1/1.jpg', 'NHDW/T/001.jpg'));
            assert.strictEqual(isFilenameListenerRegistered(), false);
            // Recording still works so the relay path stays functional.
            assert.strictEqual(lookupSuggestion({ id: 1, url: 'https://i.nhentai.net/galleries/1/1.jpg', byExtensionId: OUR_ID }), 'NHDW/T/001.jpg');
        });
    });

    // ---- naming behaviour while attached ---------------------------------

    it('re-asserts the requested filename for our own download id (subfolder kept)', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        recordDownloadRequest('https://i2.nhentai.net/galleries/123/1.jpg', 'NHDW/[Artist] Title/001.jpg');
        installDownloadFilenameGuard();
        const listener = stub.determineListener;
        assert.ok(listener, 'listener must be registered while work is pending');
        // The event can fire before download()'s callback: id unknown, url matches.
        const { suggested } = suggestionResult(listener, { id: 7, url: 'https://i2.nhentai.net/galleries/123/1.jpg', byExtensionId: OUR_ID });
        assert.deepStrictEqual(suggested, { filename: 'NHDW/[Artist] Title/001.jpg', conflictAction: 'uniquify' });
    });

    it('never renames a download started by another extension', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        recordDownloadRequest('https://i2.nhentai.net/galleries/123/1.jpg', 'NHDW/Title/001.jpg');
        installDownloadFilenameGuard();
        assert.strictEqual(
            lookupSuggestion({ id: 12, url: 'https://i2.nhentai.net/galleries/123/1.jpg', byExtensionId: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }),
            null
        );
    });

    it('passes foreign downloads through with a bare suggest and never an empty name', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        // Our own work is pending, so we ARE in the chain — the dangerous
        // window. A foreign download must still come out untouched.
        recordDownloadRequest('https://i.nhentai.net/g/own.jpg', 'NHDW/T/own.jpg');
        installDownloadFilenameGuard();
        const listener = stub.determineListener;
        assert.ok(listener);

        for (const item of [
            { id: 3, url: 'https://example.com/some-other-product.zip', byExtensionId: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' },
            { id: 4, url: 'https://example.com/manual-save.pdf' },
            { id: 5, url: 'https://example.com/Kodomo_Idol.pdf', byExtensionId: undefined }
        ]) {
            const { suggested, calls } = suggestionResult(listener, item);
            assert.strictEqual(suggested, 'DEFAULT', 'foreign download must get a bare suggest()');
            assert.strictEqual(calls, 1, 'suggest must be called exactly once');
        }
    });

    it('never suggests or stores an empty filename', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        recordDownloadRequest('https://i.nhentai.net/g/empty.jpg', '');
        assert.strictEqual(pendingDownloadNameCount(), 0, 'empty names must not be recorded');
        assert.strictEqual(isFilenameListenerRegistered(), false);
        recordDownloadRequest('https://i.nhentai.net/g/ok.jpg', 'NHDW/T/001.jpg');
        installDownloadFilenameGuard();
        // A lookup miss yields null (bare suggest), never "".
        assert.strictEqual(lookupSuggestion({ id: 99, url: 'https://i.nhentai.net/g/missing.jpg', byExtensionId: OUR_ID }), null);
        const { suggested } = suggestionResult(stub.determineListener, { id: 99, url: 'https://i.nhentai.net/g/missing.jpg', byExtensionId: OUR_ID });
        assert.strictEqual(suggested, 'DEFAULT');
    });

    it('re-asserts blob artifact names regardless of attribution', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        const blobUrl = 'blob:chrome-extension://' + OUR_ID + '/b14c-4e2f';
        recordDownloadRequest(blobUrl, '[Artist] Title.cbz');
        installDownloadFilenameGuard();
        const { suggested } = suggestionResult(stub.determineListener, { id: 21, url: blobUrl, byExtensionId: undefined });
        assert.deepStrictEqual(suggested, { filename: '[Artist] Title.cbz', conflictAction: 'uniquify' });
    });

    it('recovers names from the session mirror after a worker restart', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        recordDownloadRequest('https://i.nhentai.net/galleries/9/2.png', 'NHDW/Restarted Gallery/002.png');
        // Simulate the worker restart: fresh memory maps, session data kept.
        const sessionData = stub.storage.session.data;
        resetTrackedNamesForTests();
        stub.determineListener = null;
        stub.storage.session.data = sessionData;
        installDownloadFilenameGuard();
        const listener = stub.determineListener;
        assert.ok(listener, 'work in flight must re-arm the listener');
        const { suggested } = suggestionResult(listener, { id: 42, url: 'https://i.nhentai.net/galleries/9/2.png', byExtensionId: OUR_ID });
        assert.deepStrictEqual(suggested, { filename: 'NHDW/Restarted Gallery/002.png', conflictAction: 'uniquify' });
    });

    it('reads a legacy 3.4.0 session mirror without losing names', () => {
        const stub = makeChromeStub();
        stub.storage.session.data = {
            nhdwDownloadNames: {
                byId: { '4': 'NHDW/Legacy/004.jpg' },
                byUrl: { 'https://i.nhentai.net/g/legacy.jpg': 'NHDW/Legacy/004.jpg' }
            }
        };
        globalThis.chrome = stub;
        installDownloadFilenameGuard();
        assert.strictEqual(lookupSuggestion({ id: 4, url: 'https://i.nhentai.net/g/legacy.jpg', byExtensionId: OUR_ID }), 'NHDW/Legacy/004.jpg');
        assert.strictEqual(isFilenameListenerRegistered(), true);
    });

    it('forgets a name once its download completes', () => {
        const stub = makeChromeStub();
        globalThis.chrome = stub;
        recordDownloadRequest('https://i.nhentai.net/galleries/5/1.jpg', 'NHDW/Done Gallery/001.jpg');
        bindDownloadId('https://i.nhentai.net/galleries/5/1.jpg', 5);
        installDownloadFilenameGuard();
        assert.strictEqual(lookupSuggestion({ id: 5, url: 'https://i.nhentai.net/galleries/5/1.jpg', byExtensionId: OUR_ID }), 'NHDW/Done Gallery/001.jpg');
        stub.changedListener({ id: 5, state: { previous: 'in_progress', current: 'complete' } });
        assert.strictEqual(lookupSuggestion({ id: 5, url: 'https://i.nhentai.net/galleries/5/1.jpg', byExtensionId: OUR_ID }), null);

        // Terminal-but-not-complete states (canceled -> interrupted) also clear.
        recordDownloadRequest('https://i.nhentai.net/galleries/6/1.jpg', 'NHDW/Canceled/001.jpg');
        bindDownloadId('https://i.nhentai.net/galleries/6/1.jpg', 6);
        stub.changedListener({ id: 6, state: { previous: 'complete', current: 'interrupted' } });
        assert.strictEqual(lookupSuggestion({ id: 6, url: 'https://i.nhentai.net/galleries/6/1.jpg', byExtensionId: OUR_ID }), null);
    });

    it('caps the tracked names so long sessions cannot grow unbounded', () => {
        globalThis.chrome = makeChromeStub({ withSession: false });
        for (let i = 0; i < 1500; i++) {
            recordDownloadRequest('https://cdn.example/' + i + '.jpg', 'NHDW/Gallery' + i + '/001.jpg');
        }
        assert.ok(pendingDownloadNameCount() <= 600, 'FIFO cap must hold');
        assert.strictEqual(lookupSuggestion({ id: undefined, url: 'https://cdn.example/0.jpg', byExtensionId: OUR_ID }), null, 'oldest entries must be evicted');
        assert.strictEqual(lookupSuggestion({ id: undefined, url: 'https://cdn.example/1499.jpg', byExtensionId: OUR_ID }), 'NHDW/Gallery1499/001.jpg');
    });

    it('survives a completely missing chrome and malformed session mirror', () => {
        globalThis.chrome = undefined;
        assert.doesNotThrow(() => recordDownloadRequest('https://x/1.jpg', 'NHDW/T/001.jpg'));
        assert.doesNotThrow(() => bindDownloadId('https://x/1.jpg', 1));
        assert.doesNotThrow(() => forgetDownload(1));
        assert.doesNotThrow(() => discardDownloadRequest('https://x/1.jpg'));
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
