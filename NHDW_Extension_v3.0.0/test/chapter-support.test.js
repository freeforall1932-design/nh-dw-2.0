const assert = require('assert');
const {
    readImageSize, assertUsablePage, MIN_PAGE_DIMENSION, identifyImage, pickScrollTarget,
    readerScriptPayloads, readerScriptImageUrls, collectReaderScriptPages, hasReaderScript,
    collectStaticChapterPages, normalizeFullSizeSuffix, stripFullSizeSuffix, applyFullSizeSuffix
} = require('../build/test/utils/universalChapter.js');
const {
    profileFor, saveProfile, forgetProfile, checkProfile, profileOrigin, MAX_PROFILES, PROFILE_STORAGE_KEY
} = require('../build/test/utils/siteProfiles.js');
const { approvedHostsFor, rememberHosts, forgetOrigin, MAX_HOSTS_PER_ORIGIN } = require('../build/test/utils/hostApprovals.js');
const {
    progressTitleKey, partitionSaved, recordSaved, forgetSaved, MAX_CHAPTERS_PER_TITLE
} = require('../build/test/utils/chapterProgress.js');
const {
    makeLogEntry, appendLog, redactUrl, redactLogValue, formatLog, summarizeError, LOG_CAP
} = require('../build/test/utils/extensionLog.js');
const {
    selfTestPlan, skippedForReview, summarizeSelfTest, formatSelfTest,
    alternateSelectValue, markerValue, SELF_TEST_MARKER, REVIEW_INVALIDATING
} = require('../build/test/utils/uiSelfTest.js');

// --- tiny binary builders so the tests describe real headers -----------------
function u16(n) { return [(n >> 8) & 255, n & 255]; }
function u16le(n) { return [n & 255, (n >> 8) & 255]; }
function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u32le(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function png(width, height) {
    return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...u32be(13), 73, 72, 68, 82,
        ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);
}
function gif(width, height) {
    const head = Array.from(Buffer.from('GIF89a'));
    return Uint8Array.from([...head, ...u16le(width), ...u16le(height), 0, 0, 0]);
}
function jpeg(width, height) {
    // SOI, APP0 (length 4), SOF0 with dimensions, EOI
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, ...u16(height), ...u16(width), 0x03,
        0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
}
function webpVp8x(width, height) {
    const w = width - 1, h = height - 1;
    return Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'),
        ...Buffer.from('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0,
        w & 255, (w >> 8) & 255, (w >> 16) & 255,
        h & 255, (h >> 8) & 255, (h >> 16) & 255]);
}

describe('page image dimensions (spacer/tracker rejection)', () => {
    it('reads real pixel dimensions from PNG, GIF, JPEG and WebP headers', () => {
        assert.deepStrictEqual(readImageSize(png(800, 1200)), { format: 'png', width: 800, height: 1200 });
        assert.deepStrictEqual(readImageSize(gif(640, 480)), { format: 'gif', width: 640, height: 480 });
        assert.deepStrictEqual(readImageSize(jpeg(900, 1400)), { format: 'jpg', width: 900, height: 1400 });
        assert.deepStrictEqual(readImageSize(webpVp8x(1024, 1536)), { format: 'webp', width: 1024, height: 1536 });
    });
    it('rejects 1x1 and tiny placeholders but accepts a normal page', () => {
        for (const tiny of [png(1, 1), gif(1, 1), jpeg(2, 2), webpVp8x(3, 3)]) {
            assert.throws(() => assertUsablePage(tiny), /too small/, identifyImage(tiny));
        }
        assert.strictEqual(assertUsablePage(png(200, 300)).width, 200);
        assert.strictEqual(MIN_PAGE_DIMENSION, 128);
        // Exactly at the threshold is usable; one pixel less is not.
        assert.ok(assertUsablePage(png(128, 128)));
        assert.throws(() => assertUsablePage(png(127, 500)), /too small/);
    });
    it('refuses unreadable headers instead of saving blind', () => {
        assert.strictEqual(readImageSize(png(800, 1200).slice(0, 20)), null);
        assert.throws(() => assertUsablePage(png(800, 1200).slice(0, 20)), /no readable dimensions/);
        assert.throws(() => assertUsablePage(Buffer.from('<html>not an image</html>')), /no readable dimensions/);
        // Truncated JPEG before any SOF marker.
        assert.strictEqual(readImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0])), null);
    });
});

describe('scroll target selection for inner-scroll readers', () => {
    it('picks the largest genuinely scrollable container', () => {
        const chosen = pickScrollTarget([
            { name: 'window', scrollHeight: 900, clientHeight: 900 },
            { name: 'div#reader', scrollHeight: 12000, clientHeight: 800, clientWidth: 700 },
            { name: 'aside', scrollHeight: 400, clientHeight: 300, clientWidth: 300 }
        ]);
        assert.strictEqual(chosen.name, 'div#reader');
    });
    it('ignores boxes that cannot really scroll or are layout artefacts', () => {
        assert.strictEqual(pickScrollTarget([
            { name: 'window', scrollHeight: 800, clientHeight: 800 },
            { name: 'tiny-overflow', scrollHeight: 500, clientHeight: 400 },
            { name: 'short', scrollHeight: 5000, clientHeight: 100 },
            { name: 'hairline', scrollHeight: 5000, clientHeight: 800, clientWidth: 2 }
        ]), null);
    });
});

describe('remembered image-host approvals', () => {
    it('remembers per exact origin and returns only that origin', () => {
        let map = rememberHosts({}, 'https://a.example', ['pics.a.example', 'cdn.example']);
        map = rememberHosts(map, 'https://b.example', ['pics.b.example']);
        assert.deepStrictEqual(approvedHostsFor(map, 'https://a.example'), ['pics.a.example', 'cdn.example']);
        assert.deepStrictEqual(approvedHostsFor(map, 'https://b.example'), ['pics.b.example']);
        assert.deepStrictEqual(approvedHostsFor(map, 'https://c.example'), []);
        // A subdomain is a different site: no inherited approval.
        assert.deepStrictEqual(approvedHostsFor(map, 'https://sub.a.example'), []);
    });
    it('dedupes, bounds, rejects malformed input and forgets one origin only', () => {
        let map = rememberHosts({}, 'https://a.example', ['x.example', 'x.example', 'bad host', 'http://nope']);
        assert.deepStrictEqual(approvedHostsFor(map, 'https://a.example'), ['x.example']);
        const many = Array.from({ length: MAX_HOSTS_PER_ORIGIN + 5 }, (_, i) => 'h' + i + '.example');
        map = rememberHosts(map, 'https://a.example', many);
        assert.strictEqual(approvedHostsFor(map, 'https://a.example').length, MAX_HOSTS_PER_ORIGIN);
        map = rememberHosts(map, 'https://b.example', ['keep.example']);
        const after = forgetOrigin(map, 'https://a.example');
        assert.deepStrictEqual(approvedHostsFor(after, 'https://a.example'), []);
        assert.deepStrictEqual(approvedHostsFor(after, 'https://b.example'), ['keep.example']);
        assert.deepStrictEqual(rememberHosts({ 'ftp://x': ['y.example'] }, 'https://a.example', []), { 'https://a.example': [] });
    });
});

describe('chapter progress (skip already saved)', () => {
    const key = progressTitleKey('https://reader.example', '  My   Title ');
    it('builds a stable key from site and normalised title', () => {
        assert.strictEqual(key, 'https://reader.example | my title');
        assert.strictEqual(progressTitleKey('ftp://reader.example', 'x'), null);
        assert.strictEqual(progressTitleKey('https://reader.example', '   '), null);
    });
    it('splits a selection into pending and already-saved chapters', () => {
        const chapters = [
            { chapterUrl: 'https://reader.example/c/1/' },
            { chapterUrl: 'https://reader.example/c/2/' },
            { chapterUrl: 'https://reader.example/c/3/' }
        ];
        let map = recordSaved({}, key, [{ chapterUrl: chapters[1].chapterUrl, filename: 'T/002.cbz', pages: 5 }], 1);
        let split = partitionSaved(map, key, chapters);
        assert.deepStrictEqual(split.alreadySaved.map(c => c.chapterUrl), [chapters[1].chapterUrl]);
        assert.deepStrictEqual(split.pending.map(c => c.chapterUrl), [chapters[0].chapterUrl, chapters[2].chapterUrl]);
        // A different title or site must not inherit the record.
        assert.strictEqual(partitionSaved(map, progressTitleKey('https://reader.example', 'Other'), chapters).alreadySaved.length, 0);
        assert.strictEqual(partitionSaved(map, progressTitleKey('https://other.example', 'My Title'), chapters).alreadySaved.length, 0);
        // Forgetting one title keeps the others.
        map = recordSaved(map, progressTitleKey('https://reader.example', 'Second'), [{ chapterUrl: 'https://reader.example/c/9/', filename: 'S/009.cbz', pages: 1 }], 2);
        const forgot = forgetSaved(map, key);
        assert.strictEqual(partitionSaved(forgot, key, chapters).alreadySaved.length, 0);
        assert.strictEqual(partitionSaved(forgot, progressTitleKey('https://reader.example', 'Second'), [{ chapterUrl: 'https://reader.example/c/9/' }]).alreadySaved.length, 1);
    });
    it('drops malformed records, ignores unsafe entries and stays bounded', () => {
        const map = recordSaved({ 'k': { 'https://x/1': { filename: 'ok.cbz', pages: 2, savedAt: 5 }, 'bad': { filename: '' } } },
            null, [{ chapterUrl: 'http://insecure/1', filename: 'nope.cbz', pages: 1 }]);
        assert.deepStrictEqual(Object.keys(map.k), ['https://x/1']);
        let bounded = {};
        const entries = Array.from({ length: MAX_CHAPTERS_PER_TITLE + 10 }, (_, i) => ({
            chapterUrl: 'https://reader.example/c/' + i + '/', filename: 'T/' + i + '.cbz', pages: 1
        }));
        bounded = recordSaved(bounded, key, entries, 1000);
        assert.strictEqual(Object.keys(bounded[key]).length, MAX_CHAPTERS_PER_TITLE);
    });
});

describe('extension log (redacted, bounded, exportable)', () => {
    it('keeps URL origin and path but never query or fragment', () => {
        assert.strictEqual(redactUrl('https://cdn.example/img/1.jpg?token=abc&sig=dead#x'), 'https://cdn.example/img/1.jpg');
        assert.strictEqual(redactUrl('data:image/png;base64,AAAA'), '<data:>');
        assert.strictEqual(redactUrl('not a url'), 'not a url');
    });
    it('redacts secrets, payloads and deep objects', () => {
        const redacted = redactLogValue({
            url: 'https://a.example/x?t=1', cookie: 'sid=1', authorization: 'Bearer z', base64: 'AAAA',
            nested: { apiKey: 'k', host: 'pics.example' }, list: [1, 2], big: 'A'.repeat(120), data: 'data:image/png;base64,xx'
        });
        assert.strictEqual(redacted.url, 'https://a.example/x');
        assert.strictEqual(redacted.cookie, '<redacted>');
        assert.strictEqual(redacted.authorization, '<redacted>');
        assert.strictEqual(redacted.nested.apiKey, '<redacted>');
        assert.strictEqual(redacted.nested.host, 'pics.example');
        assert.strictEqual(redacted.big, '<base64 120 chars>');
        assert.strictEqual(redacted.data, '<data: payload>');
    });
    it('caps the buffer and formats a readable file', () => {
        let buffer = [];
        for (let i = 0; i < LOG_CAP + 5; i++) buffer = appendLog(buffer, makeLogEntry('info', 'probe', 'step ' + i, { i }, i));
        assert.strictEqual(buffer.length, LOG_CAP);
        assert.strictEqual(buffer[buffer.length - 1].message, 'step ' + (LOG_CAP + 4));
        const text = formatLog([makeLogEntry('info', 'probe', 'step 0', { i: 0 }, 0), makeLogEntry('error', 'probe', 'step 1', undefined, 1000)],
            { extension: '3.14.0', page: 'https://reader.example/c/1/' });
        assert.match(text, /NHDW extension log/);
        assert.match(text, /entries: 2/);
        assert.match(text, /1970-01-01T00:00:00Z INFO {2}\[probe\] step 0 \{"i":0\}/);
        assert.match(text, /1970-01-01T00:00:01Z ERROR \[probe\] step 1/);
        assert.ok(text.endsWith('\n'));
    });
    it('summarises errors without leaking detail', () => {
        const error = new Error('boom');
        error.code = 'transfer';
        assert.deepStrictEqual(summarizeError(error), { message: 'boom', code: 'transfer', name: 'Error' });
        assert.deepStrictEqual(summarizeError('plain'), { message: 'plain' });
        assert.strictEqual(summarizeError(null).message, 'Unknown error');
    });
});

describe('UI self-test plan (synthetic control exercise)', () => {
    const ids = plan => plan.map(target => target.id);

    it('drives checkboxes, selects and text fields, but never a button', () => {
        const plan = selfTestPlan(false);
        assert.deepStrictEqual(ids(plan).slice(0, 3), ['chapterFilter', 'outsideLinks', 'otherListPages']);
        for (const id of ['salvage', 'retry', 'rememberHosts', 'skipSaved', 'confirm']) assert.ok(ids(plan).includes(id), id);
        for (const id of ['order', 'imageAttribute', 'pageOrder', 'format', 'titleName', 'linkSelector', 'imageSelector']) {
            assert.ok(ids(plan).includes(id), id);
        }
        // Every button has a side effect: scan, inspect, save, cancel, sweep, forget.
        for (const id of ['scanTitle', 'scanCurrent', 'inspect', 'download', 'cancel', 'loadAll', 'benchmark',
            'saveLog', 'forgetSite', 'forgetTitle', 'reset', 'selectAll', 'selectNone', 'addUrls']) {
            assert.ok(!ids(plan).includes(id), id + ' must never be driven');
        }
        for (const target of plan) assert.ok(['checkbox', 'select', 'text'].includes(target.kind));
    });

    it('leaves review-wiping controls alone while a review is on screen', () => {
        const withReview = ids(selfTestPlan(true));
        for (const id of REVIEW_INVALIDATING) assert.ok(!withReview.includes(id), id + ' would discard the review');
        assert.ok(withReview.includes('format') && withReview.includes('titleName') && withReview.includes('linkSelector'));
        assert.deepStrictEqual(skippedForReview(true).sort(), REVIEW_INVALIDATING.slice().sort());
        assert.deepStrictEqual(skippedForReview(false), []);
        assert.deepStrictEqual(selfTestPlan(true).length, selfTestPlan(false).length - REVIEW_INVALIDATING.length);
    });

    it('picks a real alternative option and refuses when there is none', () => {
        assert.strictEqual(alternateSelectValue(['', 'cbz', 'zip'], ''), 'cbz');
        assert.strictEqual(alternateSelectValue(['', 'cbz', 'zip'], 'cbz'), 'zip');
        assert.strictEqual(alternateSelectValue(['reader', ''], 'reader'), '');
        assert.strictEqual(alternateSelectValue(['cbz'], 'cbz'), null);
        assert.strictEqual(alternateSelectValue([], ''), null);
    });

    it('uses a distinctive marker that always differs from the current text', () => {
        assert.strictEqual(markerValue('Fixture Title'), SELF_TEST_MARKER);
        assert.notStrictEqual(markerValue(SELF_TEST_MARKER), SELF_TEST_MARKER);
        assert.strictEqual(markerValue(''), SELF_TEST_MARKER);
    });

    it('summarises and formats outcomes without hiding a failure', () => {
        const checks = [
            { id: 'retry', kind: 'checkbox', action: 'click twice', before: 'true', after: 'false', restored: true, ok: true },
            { id: 'format', kind: 'select', action: 'select', before: 'cbz', after: 'zip', restored: false, ok: false, note: 'did not return' }
        ];
        assert.deepStrictEqual(summarizeSelfTest(checks, 4), { checked: 2, failed: 1, skipped: 4 });
        const lines = formatSelfTest(checks);
        assert.match(lines[0], /^retry \(checkbox\): click twice — ok$/);
        assert.match(lines[1], /^format \(select\): select — FAILED \(did not return\)$/);
        assert.deepStrictEqual(summarizeSelfTest([]), { checked: 0, failed: 0, skipped: 0 });
    });
});

// --- MangaThemesia reader script (real base64 payloads, no network) -----------
function readerPayload(imagesJson) {
    return 'ts_reader.run(' + JSON.stringify({ images: imagesJson, pagin: false }) + ')';
}
function scriptTag(payload) {
    return '<script src="data:text/javascript;base64,' + Buffer.from(payload, 'utf8').toString('base64') + '"></script>';
}

describe('reader scripts that carry the page list (MangaThemesia family)', () => {
    const chapterUrl = 'https://reader.example/series/book/chapter-1/';

    it('decodes the payload and keeps the site list order', () => {
        const html = '<div id="readerarea"></div>' + scriptTag(readerPayload([
            'https://images.example/001.jpg', 'https://images.example/002.jpg', 'https://images.example/003.jpg'
        ]));
        assert.strictEqual(hasReaderScript(html), true);
        assert.strictEqual(readerScriptPayloads(html).length, 1);
        const pages = collectReaderScriptPages(html, chapterUrl);
        assert.deepStrictEqual(pages.map(page => page.url), [
            'https://images.example/001.jpg', 'https://images.example/002.jpg', 'https://images.example/003.jpg'
        ]);
        assert.deepStrictEqual(pages.map(page => page.host), ['images.example', 'images.example', 'images.example']);
    });

    it('resolves relative URLs against the chapter and drops anything not public HTTPS', () => {
        const html = scriptTag(readerPayload([
            '/wp-content/uploads/one.jpg',
            'https://cdn.other.example/two.jpg',
            'http://insecure.example/three.jpg',
            'data:image/gif;base64,R0lGODlhAQABAAA=',
            'https://user:pass@bad.example/four.jpg',
            'https://localhost/five.jpg',
            'not a url'
        ]));
        const pages = collectReaderScriptPages(html, chapterUrl);
        assert.deepStrictEqual(pages.map(page => page.url), [
            'https://reader.example/wp-content/uploads/one.jpg', 'https://cdn.other.example/two.jpg'
        ]);
    });

    it('refuses a payload that is not an image list, and HTML with no payload at all', () => {
        assert.deepStrictEqual(readerScriptImageUrls('ts_reader.run({"pagin":true})'), []);
        assert.deepStrictEqual(readerScriptImageUrls('nothing here'), []);
        assert.deepStrictEqual(readerScriptImageUrls('ts_reader.run({"images":not json})'), []);
        assert.deepStrictEqual(collectReaderScriptPages('<div id="readerarea"></div>', chapterUrl), []);
        assert.deepStrictEqual(readerScriptPayloads(''), []);
        assert.deepStrictEqual(readerScriptPayloads('<script src="data:text/javascript;base64,!!!!"></script>'), []);
        assert.throws(() => collectReaderScriptPages('<script></script>', 'http://plain.example/c/1/'), /not allowed/);
    });

    it('is only a fallback: a normal reader is read from its images, not the script', () => {
        const html = '<div id="readerarea"><img data-src="https://images.example/dom-1.jpg">' +
            '<img data-src="https://images.example/dom-2.jpg"></div>' + scriptTag(readerPayload([
                'https://images.example/script-1.jpg', 'https://images.example/script-2.jpg',
                'https://images.example/script-3.jpg'
            ]));
        const fromDom = collectStaticChapterPages(html, chapterUrl, '#readerarea img', 'auto', 'reader');
        assert.deepStrictEqual(fromDom.pages.map(page => page.url), [
            'https://images.example/dom-1.jpg', 'https://images.example/dom-2.jpg'
        ]);
        // The script is still there for the probe to use only when the selector found nothing.
        assert.strictEqual(hasReaderScript(html), true);
    });
});

describe('explicit thumbnail suffix rule', () => {
    const pages = suffix => [
        { url: 'https://images.example/a1B2c3-mini.jpg', host: 'images.example' },
        { url: 'https://images.example/d4E5f6-mini.jpg', host: 'images.example' }
    ];

    it('accepts only a literal suffix and rejects patterns or empty-ish values', () => {
        assert.strictEqual(normalizeFullSizeSuffix(''), '');
        assert.strictEqual(normalizeFullSizeSuffix('  '), '');
        assert.strictEqual(normalizeFullSizeSuffix('-mini'), '-mini');
        assert.strictEqual(normalizeFullSizeSuffix('_thumb'), '_thumb');
        assert.strictEqual(normalizeFullSizeSuffix('mini'), null, 'no separator: a guess');
        assert.strictEqual(normalizeFullSizeSuffix('-m*'), null);
        assert.strictEqual(normalizeFullSizeSuffix('-mini.jpg'), null);
        assert.strictEqual(normalizeFullSizeSuffix('-' + 'x'.repeat(20)), null);
    });

    it('derives the full-size URL only when the page carries the suffix', () => {
        assert.strictEqual(stripFullSizeSuffix('https://images.example/a1B2c3-mini.jpg', '-mini'),
            'https://images.example/a1B2c3.jpg');
        assert.strictEqual(stripFullSizeSuffix('https://images.example/a1B2c3.jpg', '-mini'), null);
        assert.strictEqual(stripFullSizeSuffix('https://images.example/a1B2c3-mini.jpg', ''), null);
        assert.strictEqual(stripFullSizeSuffix('http://plain.example/a-mini.jpg', '-mini'), null, 'HTTPS only');
        assert.strictEqual(stripFullSizeSuffix('https://images.example/mini', '-mini'), null, 'never an empty path');
    });

    it('applies to a whole chapter or refuses it — never a mixed batch', () => {
        const applied = applyFullSizeSuffix(pages(), '-mini');
        assert.deepStrictEqual(applied.pages.map(page => page.url), [
            'https://images.example/a1B2c3.jpg', 'https://images.example/d4E5f6.jpg'
        ]);
        assert.strictEqual(applied.changed, 2);
        assert.deepStrictEqual(applyFullSizeSuffix(pages(), '').pages.map(page => page.url),
            pages().map(page => page.url), 'no rule means no rewrite');
        assert.throws(() => applyFullSizeSuffix([
            { url: 'https://images.example/a-mini.jpg', host: 'images.example' },
            { url: 'https://images.example/b.jpg', host: 'images.example' }
        ], '-mini'), /do not carry/);
        assert.throws(() => applyFullSizeSuffix([
            { url: 'https://images.example/x-mini.jpg', host: 'images.example' },
            { url: 'https://images.example/x-mini.jpg', host: 'images.example' }
        ], '-mini'), /duplicate/);
        assert.throws(() => applyFullSizeSuffix(pages(), 'mini'), /must look like/);
    });
});

describe('remembered reader settings per site', () => {
    const good = { selector: '#readerarea img', attribute: 'auto', order: 'reader', fullSizeSuffix: '' };

    it('accepts a normal profile and rejects values it would otherwise have to guess about', () => {
        assert.strictEqual(checkProfile(good).ok, true);
        assert.strictEqual(checkProfile(Object.assign({}, good, { selector: '  ' })).ok, false);
        assert.strictEqual(checkProfile(Object.assign({}, good, { attribute: 'srcset' })).ok, false);
        assert.strictEqual(checkProfile(Object.assign({}, good, { order: 'numeric' })).ok, false);
        assert.strictEqual(checkProfile(Object.assign({}, good, { fullSizeSuffix: 'mini' })).ok, false);
        assert.strictEqual(checkProfile(Object.assign({}, good, { selector: 'a'.repeat(501) })).ok, false);
        assert.strictEqual(checkProfile(null).ok, false);
    });

    it('keys on the exact HTTPS origin and never on a bare hostname', () => {
        assert.strictEqual(profileOrigin('https://reader.example'), 'https://reader.example');
        assert.strictEqual(profileOrigin('HTTPS://Reader.Example'), 'https://reader.example');
        assert.strictEqual(profileOrigin('http://reader.example'), null);
        assert.strictEqual(profileOrigin('reader.example'), null);
        assert.strictEqual(profileOrigin('https://reader.example/path'), null);
        const map = saveProfile({}, 'https://reader.example', Object.assign({}, good, { fullSizeSuffix: '-mini' }), 1);
        assert.strictEqual(profileFor(map, 'https://reader.example').fullSizeSuffix, '-mini');
        assert.strictEqual(profileFor(map, 'https://other.example'), null, 'another site never inherits settings');
        assert.strictEqual(profileFor(map, 'http://reader.example'), null, 'a non-HTTPS origin is a different key');
    });

    it('round-trips through storage and re-validates on read', () => {
        const stored = JSON.parse(JSON.stringify(saveProfile({}, 'https://reader.example', good, 5)));
        assert.strictEqual(stored[PROFILE_STORAGE_KEY], undefined, 'the map is stored under its own key, not nested');
        assert.deepStrictEqual(profileFor(stored, 'https://reader.example'), {
            selector: '#readerarea img', attribute: 'auto', order: 'reader', fullSizeSuffix: '', savedAt: 5
        });
        const tampered = JSON.parse(JSON.stringify(stored));
        tampered['https://reader.example'].selector = '';
        assert.strictEqual(profileFor(tampered, 'https://reader.example'), null, 'a hand-edited entry is ignored');
    });

    it('forgets one site, keeps the others, and caps the list oldest-first', () => {
        let map = saveProfile({}, 'https://a.example', good, 1);
        map = saveProfile(map, 'https://b.example', good, 2);
        assert.deepStrictEqual(Object.keys(map).sort(), ['https://a.example', 'https://b.example']);
        const after = forgetProfile(map, 'https://a.example');
        assert.deepStrictEqual(Object.keys(after), ['https://b.example']);
        assert.deepStrictEqual(Object.keys(forgetProfile(map, 'https://c.example')), ['https://a.example', 'https://b.example']);
        for (let i = 0; i < MAX_PROFILES + 5; i++) map = saveProfile(map, 'https://s' + i + '.example', good, 100 + i);
        assert.strictEqual(Object.keys(map).length, MAX_PROFILES);
        assert.strictEqual(profileFor(map, 'https://s0.example'), null, 'the oldest entry is evicted');
    });
});
