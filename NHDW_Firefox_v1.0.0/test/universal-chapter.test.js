const assert = require('assert');
const { URL: NodeURL } = require('url');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const {
    publicHttpsUrl, discoverChapters, collectChapterImages, collectStaticChapterImages,
    collectChapterPages, collectStaticChapterPages, orderChapterPages,
    identifyImage, readBoundedResponse, checkResponse, UNIVERSAL_MAX_CHAPTERS,
    detectAdvertisedPageCount, detectStaticPageCount, planScrollSteps, sweepScroll,
    retryDelay, RETRYABLE_CODES
} = require('../build/test/utils/universalChapter.js');
const { runUniversalChapterBatch, buildComicInfoXml, chapterNumberFromLabel } = require('../build/test/utils/universalChapterBatch.js');

function dom(html, url = 'https://reader.example/series/book/') {
    return new JSDOM(html, { url });
}
// Real headers: the archive stage now reads pixel dimensions, so a fixture
// must be a plausible page rather than a bare signature.
function jpegOf(width, height) {
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255,
        (width >> 8) & 255, width & 255, 0x03,
        0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
}
function pngOf(width, height) {
    return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        (width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255,
        (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255,
        8, 6, 0, 0, 0]);
}
const jpeg = jpegOf(800, 1200);
const png = pngOf(640, 480);
const tinyGif = Uint8Array.from([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0]);
const page = (bytes, extension) => ({ base64: Buffer.from(bytes).toString('base64'), size: bytes.length, extension });

describe('universal chapter discovery (synthetic DOM)', () => {
    // Other suites deliberately unset global URL; keep this file independent.
    const previous = globalThis.URL;
    before(() => { globalThis.URL = NodeURL; });
    after(() => { if (previous === undefined) delete globalThis.URL; else globalThis.URL = previous; });
    it('accepts only public HTTPS URLs without credentials, ports, IPs or local hosts', () => {
        for (const good of ['https://reader.example/a', '/chapter/1', 'https://img.reader.example/p.jpg?sig=test']) {
            assert.ok(publicHttpsUrl(good, 'https://reader.example/series/'), good);
        }
        for (const bad of ['http://reader.example/a', 'https://user:pass@reader.example/a', 'https://reader.example:444/a',
            'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://host.local/a',
            'javascript:alert(1)', 'data:image/png,hello', 'https://reader.example/a#part']) {
            assert.strictEqual(publicHttpsUrl(bad, 'https://reader.example/'), null, bad);
        }
    });
    it('finds same-title chapter links in document order and excludes duplicates, fragments and foreign links', () => {
        const d = dom(`<a href="chapter-2/">Chapter 2</a><a href="chapter-1/">Chapter 1</a>
          <a href="chapter-1/">Chapter 1 again</a><a href="#">Chapter 0</a>
          <a href="https://other.example/chapter-3/">Chapter 3</a>
          <a href="/series/other/chapter-4/">Chapter 4</a><a href="chapter-5/">Home</a>`).window.document;
        const found = discoverChapters(d, d.URL, 'a[href]');
        assert.deepStrictEqual(found.chapters.map(x => x.label), ['Chapter 2', 'Chapter 1', 'Home']);
        assert.deepStrictEqual(found.chapters.map(x => new NodeURL(x.url).pathname), [
            '/series/book/chapter-2/', '/series/book/chapter-1/', '/series/book/chapter-5/'
        ]);
        assert.strictEqual(found.truncated, false);
    });
    it('makes outside-title paths an explicit option and supports custom labels', () => {
        const d = dom('<a href="/different-route/one">Part one</a><a href="/different-route/two">Part two</a>').window.document;
        assert.strictEqual(discoverChapters(d, d.URL, 'a', { filterChapterLabels: false }).chapters.length, 0);
        assert.deepStrictEqual(discoverChapters(d, d.URL, 'a', { includeOutsideTitlePath: true, filterChapterLabels: false }).chapters.map(x => x.label), ['Part one', 'Part two']);
        assert.throws(() => discoverChapters(d, d.URL, 'a['), /selector/i);
    });
    it('reports truncation rather than silently claiming a complete title', () => {
        const html = Array.from({length: UNIVERSAL_MAX_CHAPTERS + 1}, (_, i) => `<a href="chapter-${i + 1}/">Chapter ${i + 1}</a>`).join('');
        const d = dom(html).window.document;
        const found = discoverChapters(d, d.URL, 'a[href]');
        assert.strictEqual(found.chapters.length, UNIVERSAL_MAX_CHAPTERS);
        assert.strictEqual(found.truncated, true);
    });
    it('extracts one explicitly chosen image list in DOM order without deduplicating pages', () => {
        const d = dom('<div id="reader"><img src="data:image/gif;base64,AA==" data-src="/image/1.png"><img data-src="/image/1.png"><img data-src="https://img.example/2.jpg"></div><img src="https://ads.example/a.jpg">').window.document;
        const found = collectChapterImages(d, d.URL, '#reader img', 'auto');
        assert.deepStrictEqual(found.map(x => x.url), ['https://reader.example/image/1.png', 'https://reader.example/image/1.png', 'https://img.example/2.jpg']);
        assert.deepStrictEqual(found.map(x => x.host), ['reader.example', 'reader.example', 'img.example']);
    });
    it('requires explicit attribute choice on conflicting image sources and rejects missing or unsafe pages', () => {
        let d = dom('<img src="/thumb.jpg" data-src="/full.jpg">').window.document;
        assert.throws(() => collectChapterImages(d, d.URL, 'img', 'auto'), /different source attributes/);
        assert.strictEqual(collectChapterImages(d, d.URL, 'img', 'data-src')[0].url, 'https://reader.example/full.jpg');
        d = dom('<div><img src="/ok.jpg"><img src="http://img.example/no.jpg"></div>').window.document;
        assert.throws(() => collectChapterImages(d, d.URL, 'img', 'src'), /public HTTPS/);
        assert.throws(() => collectChapterImages(d, d.URL, 'div', 'src'), /image elements only/);
        assert.throws(() => collectChapterImages(d, d.URL, '.missing', 'src'), /No page images/);
        d = dom('<img data-src="https://localhost/secret">').window.document;
        assert.throws(() => collectChapterImages(d, d.URL, 'img', 'data-src'), /public HTTPS/);
    });
    it('parses static HTML as data without constructing a browser DOM or requesting subresources', () => {
        const html = '<base href="https://assets.example/base/"><script src="https://bad.example/script.js">throw Error()</script>' +
          '<iframe src="https://bad.example/frame"></iframe><div id="reader"><img data-src="one.jpg"></div>';
        assert.deepStrictEqual(collectStaticChapterImages(html, 'https://reader.example/chapter/1/', '#reader img', 'data-src'),
            [{ url: 'https://assets.example/base/one.jpg', host: 'assets.example' }]);
        assert.throws(() => collectStaticChapterImages(html, 'https://reader.example/chapter/1/', 'img[', 'data-src'), /selector/i);
        assert.throws(() => collectStaticChapterImages('<base href="http://local.invalid/"><img src="a.jpg">',
            'https://reader.example/chapter/1/', 'img', 'src'), /base URL/);
    });
    it('recognizes supported signatures but rejects HTML and truncated headers', () => {
        assert.strictEqual(identifyImage(jpeg), 'jpg');
        assert.strictEqual(identifyImage(png), 'png');
        assert.strictEqual(identifyImage(Buffer.from('GIF89a123')), 'gif');
        assert.strictEqual(identifyImage(Buffer.from('RIFFxxxxWEBP')), 'webp');
        assert.strictEqual(identifyImage(Buffer.from('xxxxftypavif')), 'avif');
        assert.strictEqual(identifyImage(Buffer.from('<html>not an image</html>')), null);
        assert.strictEqual(identifyImage(Uint8Array.of(137, 80, 78)), null);
    });
    it('bounds streamed data even when Content-Length is missing or inaccurate', async () => {
        await assert.rejects(readBoundedResponse(new Response(Uint8Array.of(1, 2, 3, 4)), 3), /size limit/);
        await assert.rejects(readBoundedResponse(new Response(Uint8Array.of(1), { headers: { 'content-length': '100' } }), 3), /size limit/);
        const bytes = await readBoundedResponse(new Response(Uint8Array.of(1, 2)), 3);
        assert.deepStrictEqual(Array.from(bytes), [1, 2]);
        const c = new AbortController(); c.abort();
        await assert.rejects(readBoundedResponse(new Response(Uint8Array.of(1)), 3, c.signal), /Cancelled/);
    });
    describe('page ordering for jumbled image names', () => {
        // Tailspace-style markup: random image hashes, page number in the link.
        const markup = `<div id="pages">
          <a href="?page=3"><img src="https://pics.example/comics/9/defGHIjklMNOpqr-mini.jpg" alt="Scale Train, page 3"></a>
          <a href="?page=1"><img src="https://pics.example/comics/9/abcDEFghiJKLmno-mini.jpg" alt="Scale Train, page 1"></a>
          <a href="?page=2"><img src="https://pics.example/comics/9/pqrSTUvwxYZAabc-mini.jpg" alt="Scale Train, page 2"></a>
        </div>`;
        const names = list => list.map(p => p.url.split('/').pop());
        it('keeps the reader order when asked', () => {
            const d = dom(markup).window.document;
            const found = collectChapterPages(d, d.URL, '#pages img', 'src');
            assert.strictEqual(found.order, 'reader');
            assert.strictEqual(found.readerOrderDiffers, false);
            assert.deepStrictEqual(names(found.pages), ['defGHIjklMNOpqr-mini.jpg', 'abcDEFghiJKLmno-mini.jpg', 'pqrSTUvwxYZAabc-mini.jpg']);
        });
        it('orders by the page number carried in each link and says it reordered', () => {
            const d = dom(markup).window.document;
            const found = collectChapterPages(d, d.URL, '#pages img', 'src', 'link-index');
            assert.deepStrictEqual(names(found.pages), ['abcDEFghiJKLmno-mini.jpg', 'pqrSTUvwxYZAabc-mini.jpg', 'defGHIjklMNOpqr-mini.jpg']);
            assert.strictEqual(found.readerOrderDiffers, true);
            assert.deepStrictEqual(found.preview.map(x => x.slice(0, 2)), ['#1', '#2', '#3']);
        });
        it('refuses hashed names for number ordering instead of guessing', () => {
            const d = dom(markup).window.document;
            assert.throws(() => collectChapterPages(d, d.URL, '#pages img', 'src', 'name-natural'), /no numbers|hashed/i);
        });
        it('sorts ordinary numeric names naturally (2 before 10 before 100)', () => {
            const d = dom(`<img src="https://i.example/003.jpg"><img src="https://i.example/100.jpg"><img src="https://i.example/1.jpg"><img src="https://i.example/10.jpg"><img src="https://i.example/002.jpg">`).window.document;
            assert.deepStrictEqual(names(collectChapterPages(d, d.URL, 'img', 'src', 'name-natural').pages),
                ['1.jpg', '002.jpg', '003.jpg', '10.jpg', '100.jpg']);
        });
        it('refuses duplicate or partial page numbers and unsupported strategies', () => {
            const duplicate = dom(`<a href="?page=1"><img src="https://i.example/a.jpg"></a><a href="?page=1"><img src="https://i.example/b.jpg"></a>`).window.document;
            assert.throws(() => collectChapterPages(duplicate, duplicate.URL, 'img', 'src', 'link-index'), /ambiguous/);
            const partial = dom(`<a href="?page=1"><img src="https://i.example/a.jpg"></a><img src="https://i.example/b.jpg">`).window.document;
            assert.throws(() => collectChapterPages(partial, partial.URL, 'img', 'src', 'link-index'), /no page number/);
            const d = dom(markup).window.document;
            assert.throws(() => collectChapterPages(d, d.URL, '#pages img', 'src', 'alphabetical'), /supported page-order/);
        });
        it('reads page numbers from data-page, path segments and the caption text', () => {
            const raw = (url, extra) => Object.assign({ url, host: 'i.example', dataPage: null, linkHref: null, altText: '' }, extra);
            const byData = orderChapterPages([
                raw('https://i.example/c.jpg', { dataPage: '2' }), raw('https://i.example/a.jpg', { dataPage: '1' })
            ], 'link-index');
            assert.deepStrictEqual(byData.pages.map(p => p.url.slice(-5)), ['a.jpg', 'c.jpg']);
            const byPath = orderChapterPages([
                raw('https://i.example/b.jpg', { linkHref: 'https://i.example/comic/page-2/' }),
                raw('https://i.example/a.jpg', { linkHref: 'https://i.example/comic/page-1/' })
            ], 'link-index');
            assert.deepStrictEqual(byPath.pages.map(p => p.url.slice(-5)), ['a.jpg', 'b.jpg']);
            const byText = orderChapterPages([
                raw('https://i.example/b.jpg', { altText: 'Scale Train, page 2' }),
                raw('https://i.example/a.jpg', { altText: 'Scale Train, page 1' })
            ], 'link-index');
            assert.deepStrictEqual(byText.pages.map(p => p.url.slice(-5)), ['a.jpg', 'b.jpg']);
        });
        it('applies the same ordering to statically fetched chapter HTML', () => {
            const found = collectStaticChapterPages(markup, 'https://reader.example/comic/', '#pages img', 'src', 'link-index');
            assert.deepStrictEqual(names(found.pages), ['abcDEFghiJKLmno-mini.jpg', 'pqrSTUvwxYZAabc-mini.jpg', 'defGHIjklMNOpqr-mini.jpg']);
            assert.strictEqual(found.readerOrderDiffers, true);
            assert.deepStrictEqual(names(collectStaticChapterImages(markup, 'https://reader.example/comic/', '#pages img', 'src')),
                ['defGHIjklMNOpqr-mini.jpg', 'abcDEFghiJKLmno-mini.jpg', 'pqrSTUvwxYZAabc-mini.jpg']);
        });
    });

    describe('top-down readers (page 1 is simply the first image)', () => {
        it('reads the page total the reader advertises, or stays silent when unsure', () => {
            const cases = [
                ['<div data-total-pages="57"></div>', 57],
                ['<div class="page-counter">3 / 57</div>', 57],
                ['<span class="reader-counter">Page 3 of 57</span>', 57],
                ['<p class="pages">57 pages</p>', 57],
                ['<div class="page-counter">3 / 57</div><div class="page-counter">4 / 57</div>', 57],
                // Different totals are not resolved by picking one.
                ['<div class="page-counter">3 / 57</div><div class="page-counter">4 / 12</div>', null],
                // Nothing that looks like a reader count.
                ['<p>Uploaded 2 days ago</p>', null],
                ['<div data-total-pages="99999"></div>', null]
            ];
            for (const [html, expected] of cases) {
                assert.strictEqual(detectAdvertisedPageCount(dom(html).window.document), expected, 'DOM: ' + html);
                assert.strictEqual(detectStaticPageCount(html), expected, 'static: ' + html);
            }
            assert.strictEqual(detectStaticPageCount('<div data-page-count="8"></div>'), 8);
        });
        it('plans a bounded scroll sweep that always reaches the bottom', () => {
            assert.deepStrictEqual(planScrollSteps(500, 800), [0]);
            assert.deepStrictEqual(planScrollSteps(0, 800), []);
            assert.deepStrictEqual(planScrollSteps(1000, 800, 80), [0, 200]);
            const steps = planScrollSteps(100000, 800, 10);
            assert.ok(steps.length <= 10, 'bounded');
            assert.strictEqual(steps[steps.length - 1], 99200, 'ends at the bottom');
            for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], 'monotonic');
        });
        it('sweeps a lazily growing reader from top to bottom', async () => {
            let height = 1000, y = 0, cancelled = false;
            const seen = [];
            const host = {
                scrollTo(next) { y = next; seen.push(next); height = Math.min(4000, height + 600); },
                scrollY: () => y,
                scrollHeight: () => height,
                viewportHeight: () => 800,
                wait: async () => {},
                isCancelled: () => cancelled
            };
            const result = await sweepScroll(host, 40);
            assert.strictEqual(result.reachedBottom, true);
            assert.deepStrictEqual(seen, [...seen].sort((a, b) => a - b), 'only moves downwards');
            assert.ok(seen.length >= 2);
        });
        it('stops immediately when cancelled and gives up on a page that cannot scroll', async () => {
            const cancelledHost = {
                scrollTo() { throw new Error('must not scroll after cancellation'); },
                scrollY: () => 0, scrollHeight: () => 5000, viewportHeight: () => 800,
                wait: async () => {}, isCancelled: () => true
            };
            assert.deepStrictEqual(await sweepScroll(cancelledHost, 10), { steps: 0, reachedBottom: false });
            // A fixed/overflow layout never changes position: stop instead of looping.
            const stuck = { scrollTo() {}, scrollY: () => 0, scrollHeight: () => 5000, viewportHeight: () => 800,
                wait: async () => {}, isCancelled: () => false };
            const result = await sweepScroll(stuck, 50);
            assert.ok(result.steps < 5, 'gave up quickly, got ' + result.steps);
            assert.strictEqual(result.reachedBottom, false);
        });
    });

    it('stops on throttling and access denial rather than retrying or bypassing', () => {
        for (const [status, message] of [[429, /rate.limit/i], [403, /denied/i], [401, /denied/i], [500, /HTTP 500/]]) {
            assert.throws(() => checkResponse(new Response('', { status })), message);
        }
    });
});

describe('universal chapter archive execution (synthetic)', () => {
    const chapters = [
        { id: 'chapter-0', label: 'Chapter 1', count: 2, hosts: ['reader.example'] },
        { id: 'chapter-1', label: 'Chapter 2', count: 1, hosts: ['reader.example'] }
    ];
    it('saves separate archives in the supplied reading order with ordered image bytes', async () => {
        const calls = [], saves = [];
        const outcome = await runUniversalChapterBatch(chapters, 'Synthetic Title', 'cbz', {
            getPage: async (id, index) => { calls.push([id, index]); return index === 0 ? page(jpeg, 'jpg') : page(png, 'png'); },
            save: async (blob, filename) => { saves.push({ filename, bytes: Buffer.from(await blob.arrayBuffer()) }); }
        });
        assert.deepStrictEqual(outcome.completed, 2);
        assert.deepStrictEqual(outcome.incomplete, []);
        assert.deepStrictEqual(outcome.failed, []);
        assert.deepStrictEqual(outcome.savedFiles.map(x => [x.id, x.complete, x.pages]), [['chapter-0', true, 2], ['chapter-1', true, 1]]);
        assert.deepStrictEqual(calls, [['chapter-0', 0], ['chapter-0', 1], ['chapter-1', 0]]);
        assert.deepStrictEqual(saves.map(x => x.filename), ['Synthetic Title/001 - Chapter 1.cbz', 'Synthetic Title/002 - Chapter 2.cbz']);
        const zip = await JSZip.loadAsync(saves[0].bytes);
        // CBZ carries ComicInfo.xml; the pages keep their order and bytes.
        assert.deepStrictEqual(Object.keys(zip.files), ['001.jpg', '002.png', 'ComicInfo.xml']);
        assert.deepStrictEqual(await zip.file('001.jpg').async('nodebuffer'), Buffer.from(jpeg));
        assert.deepStrictEqual(await zip.file('002.png').async('nodebuffer'), Buffer.from(png));
    });
    it('never writes a partial chapter when salvage is off, but still saves the other chapters', async () => {
        const calls = [], saves = [];
        const outcome = await runUniversalChapterBatch(chapters, 'Title', 'zip', {
            getPage: async (id, index) => { calls.push([id, index]); if (id === 'chapter-0' && index === 1) throw new Error('boom'); return page(jpeg, 'jpg'); },
            save: async (_blob, filename) => { saves.push(filename); }
        });
        assert.deepStrictEqual(calls, [['chapter-0', 0], ['chapter-0', 1], ['chapter-1', 0]]);
        assert.deepStrictEqual(saves, ['Title/002 - Chapter 2.zip']);
        assert.strictEqual(outcome.completed, 1);
        assert.deepStrictEqual(outcome.incomplete, []);
        assert.deepStrictEqual(outcome.failed, [{ label: 'Chapter 1', savedPages: 1, expectedPages: 2, reason: 'boom' }]);
        assert.deepStrictEqual(outcome.savedFiles.map(x => [x.filename, x.complete]), [['Title/002 - Chapter 2.zip', true]]);
    });
    it('salvages the pages already fetched, marked incomplete, and continues to later chapters', async () => {
        const saves = [], outcome = await runUniversalChapterBatch(chapters, 'Title', 'cbz', {
            getPage: async (id, index) => {
                if (id === 'chapter-0' && index === 1) throw new Error('image failed');
                return page(jpeg, 'jpg');
            },
            save: async (blob, filename) => { saves.push({ filename, bytes: Buffer.from(await blob.arrayBuffer()) }); }
        }, undefined, { salvagePartial: true });
        assert.strictEqual(outcome.completed, 1);
        assert.deepStrictEqual(outcome.incomplete.map(x => [x.label, x.savedPages, x.expectedPages, x.reason]),
            [['Chapter 1', 1, 2, 'image failed']]);
        assert.deepStrictEqual(outcome.failed, []);
        // The salvaged chapter keeps only the pages that really arrived, and
        // both the name and the result say it is incomplete.
        assert.deepStrictEqual(saves.map(x => x.filename),
            ['Title/001 - Chapter 1 (incomplete 1 of 2 pages).cbz', 'Title/002 - Chapter 2.cbz']);
    });
    it('saves nothing for a chapter whose first page failed, and still saves later chapters', async () => {
        const saves = [];
        const outcome = await runUniversalChapterBatch(chapters, 'Title', 'zip', {
            getPage: async (id, index) => {
                if (id === 'chapter-0') throw new Error('first page failed');
                if (index > 0) throw new Error('unexpected');
                return page(jpeg, 'jpg');
            },
            save: async (_blob, filename) => { saves.push(filename); }
        }, undefined, { salvagePartial: true });
        assert.strictEqual(outcome.completed, 1);
        assert.deepStrictEqual(outcome.incomplete, []);
        assert.deepStrictEqual(outcome.failed, [{ label: 'Chapter 1', savedPages: 0, expectedPages: 2, reason: 'first page failed' }]);
        assert.deepStrictEqual(saves, ['Title/002 - Chapter 2.zip']);
    });
    it('never salvages throttling, access denial or cancellation into a file', async () => {
        for (const [code, pattern] of [['rate-limit', /rate/], ['blocked', /denied/], ['cancelled', /Cancelled/]]) {
            const saves = [];
            const error = new Error(code === 'rate-limit' ? 'rate limited' : code === 'blocked' ? 'denied' : 'Cancelled.');
            error.code = code;
            await assert.rejects(runUniversalChapterBatch(chapters, 'Title', 'zip', {
                getPage: async (id, index) => { if (id === 'chapter-0' && index === 1) throw error; return page(jpeg, 'jpg'); },
                save: async (_blob, filename) => { saves.push(filename); }
            }, undefined, { salvagePartial: true }), pattern);
            assert.deepStrictEqual(saves, [], code + ' must not salvage');
        }
    });
    it('rejects forged or mislabeled image bytes before saving', async () => {
        let saved = false;
        const outcome = await runUniversalChapterBatch([chapters[0]], 'Title', 'zip', {
            getPage: async () => page(Buffer.from('<html>bad</html>'), 'jpg'),
            save: async () => { saved = true; }
        }, undefined, { salvagePartial: true });
        assert.strictEqual(saved, false);
        assert.strictEqual(outcome.completed, 0);
        assert.match(outcome.failed[0].reason, /signature/);
    });
    it('halts when browser save fails or the user cancels', async () => {
        let calls = 0;
        await assert.rejects(runUniversalChapterBatch(chapters, 'Title', 'zip', {
            getPage: async () => { calls++; return page(jpeg, 'jpg'); },
            save: async () => { throw new Error('interrupted'); }
        }), /interrupted/);
        assert.strictEqual(calls, 2);
        const controller = new AbortController();
        const saves = [];
        await assert.rejects(runUniversalChapterBatch(chapters, 'Title', 'zip', {
            getPage: async () => { controller.abort(); return page(jpeg, 'jpg'); },
            save: async (_blob, filename) => { saves.push(filename); }
        }, controller.signal, { salvagePartial: true }), /Cancelled/);
        assert.deepStrictEqual(saves, []);
    });
    it('retries only transient failures, with a bounded number of attempts', async () => {
        assert.deepStrictEqual(RETRYABLE_CODES, ['transfer', 'timeout', 'http', 'network']);
        assert.strictEqual(retryDelay('transfer', 1), 400);
        assert.strictEqual(retryDelay('transfer', 2), 1200);
        assert.strictEqual(retryDelay('transfer', 3), null, 'bounded');
        for (const code of ['rate-limit', 'blocked', 'cancelled', 'tab-changed', 'approval', 'stale', 'format', '']) {
            assert.strictEqual(retryDelay(code, 1), null, code + ' must never be retried');
        }
    });
    it('recovers a page after a transient error when retry is on', async () => {
        const attempts = [];
        const saves = [];
        const outcome = await runUniversalChapterBatch([chapters[0]], 'Title', 'cbz', {
            getPage: async (id, index) => {
                attempts.push([id, index]);
                const failures = attempts.filter(a => a[1] === 1).length;
                if (index === 1 && failures === 1) {
                    const error = new Error('network blip'); error.code = 'transfer'; throw error;
                }
                return page(jpeg, 'jpg');
            },
            save: async (blob, filename) => { saves.push({ filename, bytes: Buffer.from(await blob.arrayBuffer()) }); }
        }, undefined, { retry: true });
        assert.strictEqual(outcome.completed, 1);
        assert.deepStrictEqual(attempts, [['chapter-0', 0], ['chapter-0', 1], ['chapter-0', 1]]);
        assert.strictEqual(saves.length, 1);
    });
    it('does not retry by default, and never retries throttling', async () => {
        let calls = 0;
        const withoutRetry = await runUniversalChapterBatch([chapters[1]], 'Title', 'zip', {
            getPage: async () => { calls++; const e = new Error('blip'); e.code = 'transfer'; throw e; },
            save: async () => {}
        });
        assert.strictEqual(calls, 1, 'no retry unless asked');
        assert.strictEqual(withoutRetry.failed.length, 1);
        calls = 0;
        // Throttling stops the whole run (even with salvage and retry on), and is
        // attempted exactly once: no retry, no partial file.
        await assert.rejects(runUniversalChapterBatch([chapters[1]], 'Title', 'zip', {
            getPage: async () => { calls++; const e = new Error('rate limited'); e.code = 'rate-limit'; throw e; },
            save: async () => {}
        }, undefined, { retry: true, salvagePartial: true }), /rate limited/);
        assert.strictEqual(calls, 1, '429 is attempted exactly once');
    });
    it('writes a minimal, escaped ComicInfo.xml into CBZ chapters only', async () => {
        assert.strictEqual(chapterNumberFromLabel('Chapter 36.10'), '36.10');
        assert.strictEqual(chapterNumberFromLabel('Extra'), null);
        const xml = buildComicInfoXml({ series: 'A & B <x>', title: 'Chapter "1"', number: '1', pageCount: 3, notes: 'it\'s ok' });
        assert.match(xml, /<Series>A &amp; B &lt;x&gt;<\/Series>/);
        assert.match(xml, /<Title>Chapter &quot;1&quot;<\/Title>/);
        assert.match(xml, /<Number>1<\/Number>/);
        assert.match(xml, /<PageCount>3<\/PageCount>/);
        assert.match(xml, /<Notes>it&apos;s ok<\/Notes>/);
        assert.ok(xml.trimEnd().endsWith('</ComicInfo>'));
        assert.ok(!/Writer|Artist|Genre|Summary|LanguageISO/.test(xml), 'no invented metadata');

        let zipped = null;
        await runUniversalChapterBatch([{ id: 'chapter-0', label: 'Chapter 36.10', count: 1, hosts: ['reader.example'] }],
            'Series & Title', 'cbz', {
                getPage: async () => page(jpeg, 'jpg'),
                save: async (blob) => { zipped = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer())); }
            });
        const info = await zipped.file('ComicInfo.xml').async('string');
        assert.match(info, /<Series>Series &amp; Title<\/Series>/);
        assert.match(info, /<Number>36.10<\/Number>/);
        assert.match(info, /<PageCount>1<\/PageCount>/);
        assert.deepStrictEqual(Object.keys(zipped.files).sort(), ['001.jpg', 'ComicInfo.xml']);

        let plain = null;
        await runUniversalChapterBatch([{ id: 'chapter-0', label: 'Chapter 1', count: 1, hosts: ['reader.example'] }], 'T', 'zip', {
            getPage: async () => page(jpeg, 'jpg'),
            save: async (blob) => { plain = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer())); }
        });
        assert.deepStrictEqual(Object.keys(plain.files), ['001.jpg'], 'a plain ZIP stays plain');
    });
    it('marks the page count in ComicInfo for a salvaged chapter', async () => {
        let zipped = null;
        await runUniversalChapterBatch([chapters[0]], 'Title', 'cbz', {
            getPage: async (id, index) => { if (index === 1) throw new Error('image failed'); return page(jpeg, 'jpg'); },
            save: async (blob) => { zipped = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer())); }
        }, undefined, { salvagePartial: true });
        const info = await zipped.file('ComicInfo.xml').async('string');
        assert.match(info, /<PageCount>1<\/PageCount>/);
        assert.match(info, /<Notes>Incomplete archive: 1 of 2 pages\.<\/Notes>/);
    });
    it('refuses to pad an archive with spacer images', async () => {
        let saved = false;
        const outcome = await runUniversalChapterBatch([{ id: 'chapter-0', label: 'Chapter 1', count: 1, hosts: ['reader.example'] }], 'T', 'zip', {
            getPage: async () => page(tinyGif, 'gif'),
            save: async () => { saved = true; }
        });
        assert.strictEqual(saved, false);
        assert.strictEqual(outcome.completed, 0);
        assert.match(outcome.failed[0].reason, /too small/);
    });
    it('rejects duplicate/invalid chapters before any request and sanitizes filenames', async () => {
        let calls = 0;
        const io = { getPage: async () => { calls++; return page(jpeg, 'jpg'); }, save: async () => {} };
        await assert.rejects(runUniversalChapterBatch([chapters[0], chapters[0]], 'Title', 'zip', io), /invalid or ambiguous/);
        assert.strictEqual(calls, 0);
        let name = '';
        await runUniversalChapterBatch([{ id: 'chapter-0', label: '../Odd/Title', count: 1, hosts: ['reader.example'] }], '../CON', 'zip', {
            getPage: async () => page(jpeg, 'jpg'), save: async (_blob, filename) => { name = filename; }
        });
        assert.ok(!name.startsWith('/') && !name.includes('../') && name.endsWith('.zip'), name);
    });
});
