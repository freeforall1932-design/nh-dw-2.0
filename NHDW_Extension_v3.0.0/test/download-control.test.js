// Completion tracking for browser downloads (downloadControl.ts) and the
// failed-gallery bookkeeping (failedGalleries.ts).
//
// chrome.downloads.download()'s callback fires when the download ITEM is
// created, not when the file is on disk. Raw mode (one browser download per
// page) used to treat that as success, so a page interrupted after it started
// was invisible: the gallery counted as complete and was recorded in the
// download history with a page missing. These tests pin the new contract:
// a download is "saved" only at state complete, "interrupted" feeds the retry
// loop, a missing event is recovered through downloads.search, a stuck
// download is cancelled after the cap, and contexts without onChanged keep the
// historical "started = saved" behaviour (the e2e harnesses rely on it).

const assert = require('assert');
const {
    awaitDownloadCompletion,
    startTrackedDownload,
    startBrowserDownload,
    installDownloadCompletionTracker,
    completionTrackingAvailable,
    interruptedMessage,
    lastErrorMessage,
    normalizeRawConcurrency,
    pendingCompletionCount,
    RAW_CONCURRENCY_DEFAULT,
    RAW_CONCURRENCY_MAX
} = require('../build/test/background/downloadControl.js');
const { resetTrackedNamesForTests } = require('../build/test/background/downloadNaming.js');
const { classifyError } = require('../build/test/utils/utils.js');
const {
    normalizePendingFailures,
    mergeFailures,
    dropFailures,
    groupRetryMessages,
    retryJobKey,
    FAILED_GALLERIES_CAP
} = require('../build/test/utils/failedGalleries.js');

// Minimal chrome.downloads stub with a controllable onChanged event, an
// in-memory item table for search(), and a cancel() log.
function makeChromeStub({ withOnChanged = true, withSearch = true } = {}) {
    const stub = {
        runtime: { id: 'testid', lastError: null },
        downloads: {
            calls: [],
            items: {},
            cancelled: [],
            nextId: 1,
            download(opts, cb) {
                stub.downloads.calls.push(opts);
                const id = stub.downloads.nextId++;
                stub.downloads.items[id] = { id: id, state: 'in_progress' };
                if (cb) cb(id);
            },
            cancel(id, cb) {
                stub.downloads.cancelled.push(id);
                if (cb) cb();
            }
        }
    };
    if (withOnChanged) {
        stub.downloads.onChanged = {
            listeners: [],
            addListener(fn) { this.listeners.push(fn); }
        };
        stub.fire = (delta) => { for (const fn of stub.downloads.onChanged.listeners) fn(delta); };
    }
    if (withSearch) {
        stub.downloads.search = (query, cb) => {
            const item = stub.downloads.items[query.id];
            cb(item ? [item] : []);
        };
    }
    return stub;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('download completion tracking', () => {
    let chrome;

    beforeEach(() => {
        chrome = makeChromeStub();
        globalThis.chrome = chrome;
        resetTrackedNamesForTests();
    });

    afterEach(() => {
        delete globalThis.chrome;
    });

    it('resolves ok only when the download reaches state complete', async () => {
        chrome.downloads.items[5] = { id: 5, state: 'in_progress' };
        const pending = awaitDownloadCompletion(5, { pollMs: 60000 });
        assert.strictEqual(pendingCompletionCount(), 1);
        chrome.fire({ id: 5, state: { current: 'complete' } });
        const outcome = await pending;
        assert.deepStrictEqual(outcome, { ok: true, state: 'complete' });
        assert.strictEqual(pendingCompletionCount(), 0);
    });

    it('reports an interrupted download with its reason', async () => {
        chrome.downloads.items[6] = { id: 6, state: 'in_progress' };
        const pending = awaitDownloadCompletion(6, { pollMs: 60000 });
        chrome.fire({ id: 6, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
        const outcome = await pending;
        assert.strictEqual(outcome.ok, false);
        assert.strictEqual(outcome.state, 'interrupted');
        assert.strictEqual(outcome.error, 'Download interrupted (NETWORK_FAILED)');
    });

    it('ignores events of other downloads and non-terminal transitions', async () => {
        let settled = false;
        chrome.downloads.items[7] = { id: 7, state: 'in_progress' };
        const pending = awaitDownloadCompletion(7, { pollMs: 60000 }).then((o) => { settled = true; return o; });
        chrome.fire({ id: 8, state: { current: 'complete' } });
        chrome.fire({ id: 7, paused: { current: true } });
        chrome.fire({ id: 7, state: { current: 'in_progress' } });
        await tick();
        assert.strictEqual(settled, false, 'unrelated events must not settle the wait');
        chrome.fire({ id: 7, state: { current: 'complete' } });
        assert.strictEqual((await pending).ok, true);
    });

    it('does not lose a terminal event that arrives before the wait starts', async () => {
        installDownloadCompletionTracker();
        chrome.downloads.items[9] = { id: 9, state: 'interrupted', error: 'USER_CANCELED' };
        chrome.fire({ id: 9, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
        const outcome = await awaitDownloadCompletion(9, { pollMs: 60000 });
        assert.strictEqual(outcome.ok, false);
        assert.ok(/USER_CANCELED/.test(outcome.error));
    });

    it('recovers a missed event through downloads.search polling', async () => {
        chrome.downloads.items[10] = { id: 10, state: 'in_progress' };
        const pending = awaitDownloadCompletion(10, { pollMs: 5 });
        await tick();
        chrome.downloads.items[10].state = 'complete'; // no event fired
        const outcome = await pending;
        assert.deepStrictEqual(outcome, { ok: true, state: 'complete' });
    });

    it('treats a download erased from the browser list as lost (but not one that is merely not searchable yet)', async () => {
        // Not yet searchable at the first check: keep waiting, then complete.
        const late = awaitDownloadCompletion(16, { pollMs: 5 });
        await tick();
        chrome.downloads.items[16] = { id: 16, state: 'complete' };
        assert.strictEqual((await late).ok, true);
        // Present, then erased mid-flight: lost.
        chrome.downloads.items[11] = { id: 11, state: 'in_progress' };
        const pending = awaitDownloadCompletion(11, { pollMs: 5 });
        await tick();
        delete chrome.downloads.items[11];
        const outcome = await pending;
        assert.strictEqual(outcome.ok, false);
        assert.ok(/disappeared/.test(outcome.error));
    });

    it('cancels a download that never finishes and reports the timeout', async () => {
        chrome.downloads.items[12] = { id: 12, state: 'in_progress' };
        const outcome = await awaitDownloadCompletion(12, { pollMs: 5, maxWaitMs: 20 });
        assert.strictEqual(outcome.ok, false);
        assert.strictEqual(outcome.state, 'timeout');
        assert.deepStrictEqual(chrome.downloads.cancelled, [12]);
        assert.ok(/stopped/.test(outcome.error));
        assert.strictEqual(classifyError('Failed to download original image (' + outcome.error + ').').kind, 'image', 'a stuck download we stopped is an image failure, not a user cancel');
    });

    it('answers "pending" instead of cancelling when asked to only report', async () => {
        chrome.downloads.items[13] = { id: 13, state: 'in_progress' };
        const outcome = await awaitDownloadCompletion(13, { pollMs: 5, maxWaitMs: 20, onTimeout: 'report' });
        assert.deepStrictEqual(outcome, { ok: false, state: 'pending' });
        assert.deepStrictEqual(chrome.downloads.cancelled, []);
        assert.strictEqual(pendingCompletionCount(), 0, 'a reported slice must not leak a waiter');
    });

    it('stops waiting on abort and cancels loose pages when asked to', async () => {
        chrome.downloads.items[14] = { id: 14, state: 'in_progress' };
        const controller = new AbortController();
        const pending = awaitDownloadCompletion(14, { pollMs: 60000, signal: controller.signal, cancelOnAbort: true });
        controller.abort();
        const outcome = await pending;
        assert.strictEqual(outcome.state, 'aborted');
        assert.deepStrictEqual(chrome.downloads.cancelled, [14]);
        // An archive the user waited for is NOT cancelled on abort.
        chrome.downloads.items[15] = { id: 15, state: 'in_progress' };
        const keep = new AbortController();
        keep.abort();
        const kept = await awaitDownloadCompletion(15, { pollMs: 60000, signal: keep.signal });
        assert.strictEqual(kept.state, 'aborted');
        assert.deepStrictEqual(chrome.downloads.cancelled, [14]);
    });

    it('keeps "started = saved" where the downloads API has no onChanged event', async () => {
        globalThis.chrome = makeChromeStub({ withOnChanged: false });
        assert.strictEqual(completionTrackingAvailable(), false);
        const outcome = await awaitDownloadCompletion(1);
        assert.deepStrictEqual(outcome, { ok: true, state: 'unknown' });
    });

    it('startTrackedDownload starts, binds and waits; interruption rejects with the reason', async () => {
        const pending = startTrackedDownload('https://i.nhentai.net/galleries/1/1.jpg', 'NHDW/T/001.jpg', { pollMs: 60000 });
        await tick();
        assert.strictEqual(chrome.downloads.calls.length, 1);
        assert.strictEqual(chrome.downloads.calls[0].filename, 'NHDW/T/001.jpg');
        assert.strictEqual(chrome.downloads.calls[0].conflictAction, 'uniquify');
        chrome.fire({ id: 1, state: { current: 'interrupted' }, error: { current: 'FILE_NO_SPACE' } });
        await assert.rejects(pending, /Download interrupted \(FILE_NO_SPACE\)/);

        const ok = startTrackedDownload('https://i.nhentai.net/galleries/1/2.jpg', 'NHDW/T/002.jpg', { pollMs: 60000 });
        await tick();
        chrome.fire({ id: 2, state: { current: 'complete' } });
        assert.deepStrictEqual(await ok, { downloadId: 2 });
    });

    it('surfaces the browser\'s refusal to create a download as a readable message', async () => {
        chrome.downloads.download = (opts, cb) => {
            chrome.runtime.lastError = { message: 'Invalid filename' };
            cb(undefined);
            chrome.runtime.lastError = null;
        };
        await assert.rejects(startBrowserDownload('https://x/1.jpg', 'a/b.jpg'), /Invalid filename/);
        assert.strictEqual(lastErrorMessage('fallback'), 'fallback');
        assert.strictEqual(interruptedMessage(undefined), 'Download interrupted');
    });

    it('normalizes the raw concurrency setting into 1..10 with a default of 3', () => {
        assert.strictEqual(RAW_CONCURRENCY_DEFAULT, 3);
        assert.strictEqual(RAW_CONCURRENCY_MAX, 10);
        assert.strictEqual(normalizeRawConcurrency(undefined), 3);
        assert.strictEqual(normalizeRawConcurrency('garbage'), 3);
        assert.strictEqual(normalizeRawConcurrency('0'), 3);
        assert.strictEqual(normalizeRawConcurrency('2'), 2);
        assert.strictEqual(normalizeRawConcurrency(5), 5);
        assert.strictEqual(normalizeRawConcurrency('99'), 10);
    });
});

describe('failed-gallery bookkeeping (pure)', () => {
    const job = { formatOverride: 'raw', nameTemplate: '{pretty}', masterFolder: 'NHDW', tabId: 4 };

    it('normalizes stored entries and drops corrupt ones', () => {
        const out = normalizePendingFailures([
            { id: 1, name: 'One', error: 'x', retryJob: job, at: 10 },
            { id: '', name: 'nope' },
            null,
            { id: '2' }
        ]);
        assert.strictEqual(out.length, 2);
        assert.deepStrictEqual(out[0], { id: '1', name: 'One', error: 'x', retryJob: job, at: 10 });
        assert.deepStrictEqual(out[1], { id: '2', name: '2', error: '', retryJob: null, at: 0 });
        assert.deepStrictEqual(normalizePendingFailures('garbage'), []);
    });

    it('merges new failures, replaces repeated ids and caps the list oldest-first', () => {
        const first = mergeFailures([], [{ id: '1', name: 'One', error: 'a' }, { id: '2', name: 'Two', error: 'b' }], job, 100);
        assert.strictEqual(first.length, 2);
        const again = mergeFailures(first, [{ id: '2', name: 'Two', error: 'newer' }], { formatOverride: 'zip' }, 200);
        assert.strictEqual(again.length, 2);
        assert.strictEqual(again[1].id, '2');
        assert.strictEqual(again[1].error, 'newer');
        assert.deepStrictEqual(again[1].retryJob, { formatOverride: 'zip' });
        const many = [];
        for (let i = 0; i < FAILED_GALLERIES_CAP + 5; i++) {
            many.push({ id: String(1000 + i), name: 'G' + i, error: 'e' });
        }
        const capped = mergeFailures([], many, job, 1);
        assert.strictEqual(capped.length, FAILED_GALLERIES_CAP);
        assert.strictEqual(capped[0].id, '1005', 'oldest entries are dropped first');
    });

    it('drops galleries that later succeeded', () => {
        const list = mergeFailures([], [{ id: '1', name: 'One', error: 'a' }, { id: '2', name: 'Two', error: 'b' }], job, 1);
        const left = dropFailures(list, [1]);
        assert.deepStrictEqual(left.map((e) => e.id), ['2']);
    });

    it('groups a retry into one separate-files job per distinct settings, forcing the failed ids', () => {
        const entries = mergeFailures([], [
            { id: '1', name: 'One', error: 'a' },
            { id: '2', name: 'Two', error: 'b' }
        ], job, 1).concat(mergeFailures([], [{ id: '3', name: 'Three', error: 'c' }], { formatOverride: 'pdf' }, 2));
        const messages = groupRetryMessages(entries, 42);
        assert.strictEqual(messages.length, 2);
        const raw = messages[0];
        assert.strictEqual(raw.action, 'downloadAllDoujinshis');
        assert.deepStrictEqual(raw.allDoujinshis, { '1': 'One', '2': 'Two' });
        assert.deepStrictEqual(raw.redownloadIds, ['1', '2']);
        assert.strictEqual(raw.separate, true, 'a retry never merges the failed titles into a second partial archive');
        assert.strictEqual(raw.formatOverride, 'raw');
        assert.strictEqual(raw.nameTemplate, '{pretty}');
        assert.strictEqual(raw.masterFolder, 'NHDW');
        assert.strictEqual(raw.tabId, 42, 'the active tab wins over the original (possibly closed) one');
        assert.deepStrictEqual(raw.galleryMetadata, {});
        const pdf = messages[1];
        assert.deepStrictEqual(pdf.allDoujinshis, { '3': 'Three' });
        assert.strictEqual(pdf.formatOverride, 'pdf');
        assert.strictEqual(pdf.nameTemplate, undefined);
        assert.strictEqual(retryJobKey(job) === retryJobKey({ formatOverride: 'raw', nameTemplate: '{pretty}', masterFolder: 'NHDW', tabId: 9 }), true,
            'the source tab must not split retries into separate jobs');
    });

    it('still builds a retry (with stored defaults) for entries that carry no job', () => {
        const messages = groupRetryMessages([{ id: '5', name: 'Five', error: 'e', retryJob: null, at: 0 }]);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].formatOverride, undefined);
        assert.strictEqual(messages[0].tabId, undefined);
        assert.deepStrictEqual(messages[0].allDoujinshis, { '5': 'Five' });
    });
});
