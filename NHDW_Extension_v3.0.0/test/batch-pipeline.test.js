// Shared batch pipeline (item 32): one storage-free core used by both the
// worker fallback and the offscreen document. These tests drive the core
// through injected IO so chrome.storage / chrome.downloads are never touched.

const assert = require('assert');
const {
    tryParseGalleryText,
    resolveGalleryMetadata,
    runBatchDownload,
    runPagedBatchDownload,
    buildRetryJob
} = require('../build/test/utils/batchPipeline.js');
const { extractGalleryFromHtml } = require('../build/test/parsing/GalleryEmbed.js');

function gallery(id, pretty) {
    return {
        id: Number(id),
        media_id: String(id),
        title: { english: pretty, japanese: '', pretty: pretty },
        images: { pages: [{ t: 'j', w: 1, h: 1 }] },
        tags: []
    };
}

function fakeParsing() {
    return {
        GetUrl: (id) => 'https://nhentai.net/api/v2/galleries/' + id,
        GetJsonAsync: async (resp) => JSON.parse(await resp.text())
    };
}

function makeHost(overrides) {
    const messages = [];
    const downloads = [];
    const errors = [];
    const host = {
        parsing: fakeParsing(),
        aborted: false,
        getAbortSignal: () => null,
        wasAborted: () => host.aborted,
        messageExtras: () => ({}),
        sendMessage: (payload) => { messages.push(payload); },
        errorCallback: (msg) => { errors.push(String(msg)); },
        progressCallback: () => {},
        fetchUrlFromTab: async () => null,
        fetchImpl: async () => ({ ok: false, status: 404, statusText: 'not found', headers: { get: () => null }, text: async () => '' }),
        newZip: () => ({ files: {} }),
        downloadGallery: async (job) => { downloads.push(job); },
        messages: messages,
        downloads: downloads,
        errors: errors
    };
    return Object.assign(host, overrides || {});
}

describe('batchPipeline helpers', () => {
    it('tryParseGalleryText accepts JSON galleries and HTML embeds', () => {
        const json = gallery(1, 'Json');
        assert.strictEqual(tryParseGalleryText(JSON.stringify(json)).media_id, '1');
        assert.strictEqual(tryParseGalleryText(''), null);
        assert.strictEqual(tryParseGalleryText('not a gallery'), null);
        const embed = String.raw`{\u0022id\u0022:123456,\u0022media_id\u0022:\u0022987654\u0022,\u0022title\u0022:{\u0022english\u0022:\u0022Test Gallery\u0022,\u0022japanese\u0022:\u0022\u0022,\u0022pretty\u0022:\u0022Test Gallery\u0022},\u0022images\u0022:{\u0022pages\u0022:[{\u0022t\u0022:\u0022j\u0022},{\u0022t\u0022:\u0022p\u0022}]},\u0022tags\u0022:[]}`;
        const html = '<html><body><script>window._gallery = JSON.parse("' + embed + '");</script></body></html>';
        assert.ok(extractGalleryFromHtml(html));
        assert.strictEqual(tryParseGalleryText(html).media_id, '987654');
    });

    it('buildRetryJob copies format, tab, template and master folder', () => {
        const job = buildRetryJob(7, { useZip: 'cbz', downloadName: '{id}', archiveMasterFolder: 'NHDW' });
        assert.deepStrictEqual(job, {
            formatOverride: 'cbz',
            tabId: 7,
            nameTemplate: '{id}',
            masterFolder: 'NHDW'
        });
        const raw = buildRetryJob(undefined, { useZip: 'raw', rawMasterFolder: 'Loose' });
        assert.strictEqual(raw.formatOverride, 'raw');
        assert.strictEqual(raw.masterFolder, 'Loose');
        assert.strictEqual(raw.tabId, undefined);
    });
});

describe('resolveGalleryMetadata', () => {
    it('uses pre-resolved metadata and rejects non-gallery JSON', async () => {
        const host = makeHost();
        const ok = await resolveGalleryMetadata('1', {
            galleryMetadata: { '1': gallery(1, 'Pre') },
            apiKey: '',
            host: host
        });
        assert.strictEqual(ok.ok, true);
        assert.strictEqual(ok.json.title.pretty, 'Pre');

        await assert.rejects(
            resolveGalleryMetadata('9', {
                galleryMetadata: { '9': {} },
                apiKey: '',
                host: host
            }),
            (error) => /not gallery metadata/.test(error.message)
        );
    });

    it('keyed API is tried first and carries Authorization', async () => {
        const calls = [];
        const host = makeHost({
            fetchImpl: async (url, init) => {
                calls.push({ url: String(url), auth: (init && init.headers && init.headers.Authorization) || null });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => 'application/json' },
                    text: async () => JSON.stringify(gallery(2, 'Keyed'))
                };
            }
        });
        const result = await resolveGalleryMetadata('2', {
            galleryMetadata: {},
            apiKey: 'test-key-123',
            host: host
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.json.title.pretty, 'Keyed');
        assert.ok(calls.length >= 1, 'keyed route must hit fetchImpl');
        assert.strictEqual(calls[0].auth, 'Key test-key-123');
        assert.ok(calls[0].url.indexOf('/api/v2/galleries/2') !== -1);
    });

    it('keyless fallback fetch has no Authorization header', async () => {
        const calls = [];
        const host = makeHost({
            fetchImpl: async (url, init) => {
                calls.push({ url: String(url), auth: (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || null });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => 'application/json' },
                    text: async () => JSON.stringify(gallery(3, 'Keyless'))
                };
            }
        });
        const result = await resolveGalleryMetadata('3', {
            galleryMetadata: {},
            apiKey: '',
            host: host
        });
        assert.strictEqual(result.ok, true);
        assert.ok(calls.every((c) => c.auth === null), 'keyless must never send Authorization, got ' + JSON.stringify(calls));
    });

    it('fallback fetch keeps Authorization when keyed route misses', async () => {
        const calls = [];
        let n = 0;
        const host = makeHost({
            fetchImpl: async (url, init) => {
                n++;
                calls.push({ n: n, auth: (init && init.headers && init.headers.Authorization) || null });
                if (n === 1) {
                    return { ok: false, status: 500, statusText: 'nope', headers: { get: () => null }, text: async () => '' };
                }
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => 'application/json' },
                    text: async () => JSON.stringify(gallery(4, 'Fallback'))
                };
            }
        });
        const result = await resolveGalleryMetadata('4', {
            galleryMetadata: {},
            apiKey: 'abc',
            host: host
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.json.title.pretty, 'Fallback');
        assert.ok(calls.length >= 2);
        assert.strictEqual(calls[calls.length - 1].auth, 'Key abc');
    });

    it('HTML second-chance recovers a gallery when JSON parse is empty', async () => {
        const embed = String.raw`{\u0022id\u0022:5,\u0022media_id\u0022:\u00225\u0022,\u0022title\u0022:{\u0022english\u0022:\u0022FromHtml\u0022,\u0022japanese\u0022:\u0022\u0022,\u0022pretty\u0022:\u0022FromHtml\u0022},\u0022images\u0022:{\u0022pages\u0022:[{\u0022t\u0022:\u0022j\u0022}]},\u0022tags\u0022:[]}`;
        const html = '<html><body><script>window._gallery = JSON.parse("' + embed + '");</script></body></html>';
        const host = makeHost({
            parsing: {
                GetUrl: (id) => 'https://nhentai.net/api/v2/galleries/' + id,
                GetJsonAsync: async () => ({})
            },
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => 'application/json' },
                text: async () => html
            })
        });
        const result = await resolveGalleryMetadata('5', {
            galleryMetadata: {},
            apiKey: '',
            host: host
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.json.title.pretty, 'FromHtml');
    });
});

describe('runBatchDownload', () => {
    it('fails one non-gallery JSON and continues the rest of the batch', async () => {
        const host = makeHost();
        const outcome = await runBatchDownload({
            zip: {},
            allDoujinshis: { '9': 'EmptyJson', '1': 'Good' },
            finalName: 'Batch',
            downloadAtEnd: true,
            galleryMetadata: { '9': {}, '1': gallery(1, 'Good') },
            options: { useZip: 'zip', downloadSeparately: true },
            host: host
        });
        assert.strictEqual(outcome.skipped, 0);
        assert.strictEqual(outcome.records.length, 1);
        assert.strictEqual(outcome.records[0].id, '1');
        assert.strictEqual(outcome.failedGalleries.length, 1);
        assert.strictEqual(outcome.failedGalleries[0].id, '9');
        assert.ok(/not gallery metadata/.test(outcome.failedGalleries[0].error));
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.ok(summary);
        assert.strictEqual(summary.succeeded, 1);
        assert.strictEqual(summary.failed, 1);
        assert.strictEqual(summary.total, 2);
        assert.strictEqual(summary.failedKinds.metadata, 1);
        assert.strictEqual(host.downloads.length, 1);
        assert.strictEqual(host.downloads[0].json.title.pretty, 'Good');
    });

    it('merged ignore id-suffixes the second title instead of dropping it', async () => {
        const host = makeHost();
        const outcome = await runBatchDownload({
            zip: {},
            allDoujinshis: { '11': 'One', '22': 'Two' },
            finalName: 'Merged',
            downloadAtEnd: true,
            galleryMetadata: { '11': gallery(11, 'Test'), '22': gallery(22, 'Test') },
            options: { useZip: 'zip', downloadSeparately: false, duplicateBehaviour: 'ignore' },
            host: host
        });
        assert.strictEqual(outcome.skipped, 0);
        assert.strictEqual(outcome.clean, true);
        assert.deepStrictEqual(outcome.batchKeys, ['11', '22']);
        assert.strictEqual(host.downloads.length, 2);
        assert.strictEqual(host.downloads[0].path, 'Test');
        assert.strictEqual(host.downloads[1].path, 'Test_(22)');
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.strictEqual(summary.succeeded, 2);
        assert.strictEqual(summary.skipped, 0);
    });

    it('separate ignore counts the dropped duplicate in skipped', async () => {
        const host = makeHost();
        const outcome = await runBatchDownload({
            zip: {},
            allDoujinshis: { '11': 'One', '22': 'Two' },
            finalName: 'Sep',
            downloadAtEnd: true,
            galleryMetadata: { '11': gallery(11, 'Test'), '22': gallery(22, 'Test') },
            options: { useZip: 'zip', downloadSeparately: true, duplicateBehaviour: 'ignore' },
            host: host
        });
        assert.strictEqual(outcome.skipped, 1);
        assert.strictEqual(host.downloads.length, 1);
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.strictEqual(summary.succeeded, 1);
        assert.strictEqual(summary.skipped, 1);
        assert.strictEqual(summary.total, 2);
    });

    it('skips already-downloaded ids with zero downloadGallery calls', async () => {
        const host = makeHost({
            fetchImpl: async () => { throw new Error('must not fetch skipped galleries'); }
        });
        const outcome = await runBatchDownload({
            zip: {},
            allDoujinshis: { '1': 'One', '2': 'Two' },
            finalName: 'Skip',
            downloadAtEnd: true,
            galleryMetadata: { '2': gallery(2, 'Two') },
            options: {
                useZip: 'zip',
                downloadSeparately: true,
                alreadyDownloadedIds: ['1']
            },
            host: host
        });
        assert.strictEqual(outcome.skipped, 1);
        assert.strictEqual(host.downloads.length, 1);
        assert.strictEqual(host.downloads[0].json.id, 2);
        assert.strictEqual(host.messages.filter((m) => m.action === 'batchProgress').length, 1);
    });

    it('records the resolved format (not a silent zip default)', async () => {
        const host = makeHost();
        const outcome = await runBatchDownload({
            zip: {},
            allDoujinshis: { '1': 'One' },
            finalName: 'Fmt',
            downloadAtEnd: true,
            galleryMetadata: { '1': gallery(1, 'One') },
            options: { useZip: 'cbz', downloadSeparately: true, archiveMasterFolder: '' },
            host: host
        });
        assert.strictEqual(outcome.records.length, 1);
        assert.ok(outcome.records[0].filename.endsWith('.cbz'), 'record must use cbz, got ' + outcome.records[0].filename);
        assert.strictEqual(host.downloads[0].gallerySettings.useZip, 'cbz');
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.strictEqual(summary.retryJob.formatOverride, 'cbz');
    });

    it('does not send a summary when the job was aborted', async () => {
        const host = makeHost({
            downloadGallery: async () => { host.aborted = true; throw new Error('Download was aborted'); }
        });
        await runBatchDownload({
            zip: {},
            allDoujinshis: { '1': 'One' },
            finalName: 'Abort',
            downloadAtEnd: true,
            galleryMetadata: { '1': gallery(1, 'One') },
            options: { useZip: 'zip', downloadSeparately: true },
            host: host
        });
        assert.ok(!host.messages.some((m) => m.action === 'batchSummary'));
    });

    it('merges host message extras onto broadcasts (offscreen from/queued)', async () => {
        const host = makeHost({
            messageExtras: () => ({ from: 'offscreen', queued: 3 })
        });
        await runBatchDownload({
            zip: {},
            allDoujinshis: { '1': 'One' },
            finalName: 'Extras',
            downloadAtEnd: true,
            galleryMetadata: { '1': gallery(1, 'One') },
            options: { useZip: 'zip', downloadSeparately: true },
            host: host
        });
        const progress = host.messages.find((m) => m.action === 'batchProgress');
        const summary = host.messages.find((m) => m.action === 'batchSummary');
        assert.strictEqual(progress.from, 'offscreen');
        assert.strictEqual(progress.queued, 3);
        assert.strictEqual(summary.from, 'offscreen');
        assert.strictEqual(summary.queued, 3);
    });
});

describe('runPagedBatchDownload', () => {
    it('parses listing HTML and downloads every card', async () => {
        const host = makeHost({
            fetchImpl: async (url) => {
                const page = /page=([0-9]+)/.exec(String(url));
                const n = page ? page[1] : '1';
                const id = n === '1' ? '11' : '22';
                const title = n === '1' ? 'One' : 'Two';
                return {
                    ok: true,
                    status: 200,
                    text: async () => '<a href="/g/' + id + '/1/"><div class="caption">' + title + '</div></a>'
                };
            }
        });
        // Metadata for the cards parsed out of the listing.
        const originalDownload = host.downloadGallery;
        host.downloadGallery = async (job) => originalDownload(job);
        // Galleries are resolved via fetchImpl too if listing parse yields ids
        // without galleryMetadata. Stub metadata fetch after listing HTML.
        const listing = host.fetchImpl;
        host.fetchImpl = async (url, init) => {
            if (String(url).indexOf('/search') !== -1) return listing(url, init);
            const idMatch = /galleries\/([0-9]+)/.exec(String(url));
            const id = idMatch ? idMatch[1] : '0';
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => 'application/json' },
                text: async () => JSON.stringify(gallery(id, id === '11' ? 'One' : 'Two'))
            };
        };
        const outcome = await runPagedBatchDownload({
            allDoujinshis: {},
            pagesArr: [1, 2],
            path: 'Pages',
            url: 'https://nhentai.net/search/?q=test',
            options: { useZip: 'zip', downloadSeparately: true, downloadName: '{pretty}' },
            host: host
        });
        assert.strictEqual(host.downloads.length, 2);
        assert.strictEqual(outcome.records.length, 2);
        assert.strictEqual(outcome.clean, true);
        assert.deepStrictEqual(outcome.failedGalleries, []);
    });

    it('aggregates failedGalleries across listing pages', async () => {
        const host = makeHost();
        const listing = async (url) => {
            const page = /page=([0-9]+)/.exec(String(url));
            const n = page ? page[1] : '1';
            const id = n === '1' ? '11' : '99';
            const title = n === '1' ? 'Good' : 'Bad';
            return {
                ok: true,
                status: 200,
                text: async () => '<a href="/g/' + id + '/1/"><div class="caption">' + title + '</div></a>'
            };
        };
        host.fetchImpl = async (url, init) => {
            if (String(url).indexOf('/search') !== -1) return listing(url, init);
            const idMatch = /galleries\/([0-9]+)/.exec(String(url));
            const id = idMatch ? idMatch[1] : '0';
            if (id === '99') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => 'application/json' },
                    text: async () => '{}'
                };
            }
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => 'application/json' },
                text: async () => JSON.stringify(gallery(id, 'Good'))
            };
        };
        const outcome = await runPagedBatchDownload({
            allDoujinshis: {},
            pagesArr: [1, 2],
            path: 'Pages',
            url: 'https://nhentai.net/search/?q=test',
            options: { useZip: 'zip', downloadSeparately: true, downloadName: '{pretty}' },
            host: host
        });
        assert.strictEqual(host.downloads.length, 1);
        assert.strictEqual(outcome.records.length, 1);
        assert.strictEqual(outcome.failedGalleries.length, 1);
        assert.strictEqual(outcome.failedGalleries[0].id, '99');
        assert.ok(/not gallery metadata/.test(outcome.failedGalleries[0].error));
    });
});

// Backlog item 33: the format a job RESOLVES to must be the same value the
// Downloader is told, the value the history record is written with and the
// value a retry re-sends. Before this was one decision made in three places
// from three inputs, so a caller that omits the per-job override could get a
// record saying ".zip" for a ".cbz"/".pdf"/raw artifact - which breaks
// verify-before-skip into a permanent re-download loop.
describe('job format contract (item 33)', () => {
    const CASES = [
        { sent: 'zip', resolved: 'zip', recordSuffix: '.zip' },
        { sent: 'cbz', resolved: 'cbz', recordSuffix: '.cbz' },
        { sent: 'pdf', resolved: 'pdf', recordSuffix: '.pdf' },
        { sent: 'raw', resolved: 'raw', recordSuffix: '/001.jpg' },
        // A stored setting left over from before PDF replaced the folder mode.
        { sent: 'folder', resolved: 'pdf', recordSuffix: '.pdf' },
        // A caller that sends no format at all: still ONE decision, and the
        // Downloader is told it instead of being left to guess.
        { sent: undefined, resolved: 'zip', recordSuffix: '.zip' }
    ];

    for (const testCase of CASES) {
        const label = testCase.sent === undefined ? 'no format sent' : 'format "' + testCase.sent + '"';
        it('record, Downloader settings and retry job all agree for ' + label, async () => {
            const host = makeHost();
            const outcome = await runBatchDownload({
                zip: {},
                allDoujinshis: { '1': 'One' },
                finalName: 'Contract',
                downloadAtEnd: true,
                galleryMetadata: { '1': gallery(1, 'One') },
                options: { useZip: testCase.sent, downloadSeparately: true, downloadName: '{pretty}', archiveMasterFolder: '' },
                host: host
            });

            assert.strictEqual(host.downloads.length, 1);
            // The Downloader receives the already-resolved format, so it never
            // normalizes a second time and can never disagree with the record.
            assert.strictEqual(host.downloads[0].gallerySettings.useZip, testCase.resolved,
                'the Downloader must be told the resolved format');

            assert.strictEqual(outcome.records.length, 1);
            assert.ok(outcome.records[0].filename.endsWith(testCase.recordSuffix),
                'record must use the resolved format, got ' + outcome.records[0].filename);

            const summary = host.messages.find((m) => m.action === 'batchSummary');
            assert.ok(summary, 'a batch summary must be sent');
            assert.strictEqual(summary.retryJob.formatOverride, testCase.resolved,
                'a retry must re-send the same format the job actually used');
        });
    }

    it('never hands a raw value the Downloader would re-normalize differently', async () => {
        const host = makeHost();
        await runBatchDownload({
            zip: {},
            allDoujinshis: { '1': 'One' },
            finalName: 'Legacy',
            downloadAtEnd: true,
            galleryMetadata: { '1': gallery(1, 'One') },
            options: { useZip: 'folder', downloadSeparately: true, archiveMasterFolder: '' },
            host: host
        });
        assert.strictEqual(host.downloads[0].gallerySettings.useZip, 'pdf');
        assert.strictEqual(host.downloads[0].gallerySettings.useZip.indexOf('folder'), -1,
            'the retired folder value must not survive into the Downloader settings');
    });
});
