// Item 61 — listing page-range parser + page-URL rewrite (pure, no DOM).
// These are the rules the Download-tab range block shares with the
// downloadAllPages job path: one parser, one URL builder.

const assert = require('assert');
const {
    parsePageRange,
    listingUrlForPage
} = require('../build/test/utils/pageRange.js');

describe('listing page-range parser (item 61)', () => {
    it('expands an inclusive dash range', () => {
        const result = parsePageRange('1-5', 10);
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.pages, [1, 2, 3, 4, 5]);
    });

    it('accepts mixed singles and ranges separated by commas', () => {
        const result = parsePageRange('2,4,6-8', 10);
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.pages, [2, 4, 6, 7, 8]);
    });

    it('accepts a single page number', () => {
        const result = parsePageRange('3', 10);
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.pages, [3]);
    });

    it('de-duplicates repeated and overlapping pages instead of downloading twice', () => {
        const result = parsePageRange('2,2,3-4,4', 10);
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.pages, [2, 3, 4]);
    });

    it('rejects a zero-width range (3-3) as bounds, matching the old Download-all help rules', () => {
        const result = parsePageRange('3-3', 10);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, 'bounds');
    });

    it('rejects a reversed range rather than guessing', () => {
        const result = parsePageRange('8-6', 10);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, 'bounds');
    });

    it('rejects a single page above maxPage', () => {
        const result = parsePageRange('11', 10);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, 'pageNumber');
    });

    it('rejects a range endpoint above maxPage', () => {
        const result = parsePageRange('1-99', 10);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, 'pageNumber');
    });

    it('rejects non-numeric garbage as a syntax error', () => {
        for (const bad of ['', ' ', 'abc', '1-x', '1.5', '1--3', '1-']) {
            const result = parsePageRange(bad, 10);
            assert.strictEqual(result.ok, false, 'expected failure for ' + JSON.stringify(bad));
            assert.strictEqual(result.error, 'syntax', 'expected syntax for ' + JSON.stringify(bad));
        }
    });

    it('rejects an empty comma slot instead of silently skipping it', () => {
        const result = parsePageRange('1,,3', 10);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, 'syntax');
    });

    it('fails closed when maxPage is unknown or non-positive', () => {
        for (const max of [0, -1, NaN]) {
            const result = parsePageRange('1-2', max);
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.error, 'pageNumber');
        }
    });
});

describe('listing page URL rewrite (item 61)', () => {
    it('replaces an existing page= parameter', () => {
        assert.strictEqual(
            listingUrlForPage('https://nhentai.net/?q=foo&page=3', 7),
            'https://nhentai.net/?q=foo&page=7'
        );
    });

    it('appends with & when the URL already has a query', () => {
        assert.strictEqual(
            listingUrlForPage('https://nhentai.net/search/?q=foo', 2),
            'https://nhentai.net/search/?q=foo&page=2'
        );
    });

    it('appends with ? when the URL has no query', () => {
        assert.strictEqual(
            listingUrlForPage('https://nhentai.net/', 4),
            'https://nhentai.net/?page=4'
        );
    });

    it('matches the batchPipeline walk so both paths request the same URL', () => {
        // Same algorithm as runPagedBatchDownload's page loop.
        const walk = (url, page) => {
            const m = /page=([0-9]+)/.exec(url);
            if (m !== null) return url.replace(m[0], 'page=' + page);
            if (url.indexOf('?') !== -1) return url + '&page=' + page;
            return url + '?page=' + page;
        };
        const samples = [
            'https://nhentai.net/',
            'https://nhentai.net/?q=foo',
            'https://nhentai.net/?q=foo&page=1',
            'https://nhentai.net/tag/yaoi/'
        ];
        for (const url of samples) {
            for (const page of [1, 3, 9]) {
                assert.strictEqual(listingUrlForPage(url, page), walk(url, page));
            }
        }
    });
});
