const assert = require('assert');
const { URL: NodeURL } = require('url');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const {
    publicHttpsUrl, discoverChapters, collectChapterImages, collectStaticChapterImages,
    identifyImage, readBoundedResponse, checkResponse, UNIVERSAL_MAX_CHAPTERS
} = require('../build/test/utils/universalChapter.js');
const { runUniversalChapterBatch } = require('../build/test/utils/universalChapterBatch.js');

function dom(html, url = 'https://reader.example/series/book/') {
    return new JSDOM(html, { url });
}
const jpeg = Uint8Array.from([255, 216, 255, 224, 1, 2, 3]);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
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
        const count = await runUniversalChapterBatch(chapters, 'Synthetic Title', 'cbz', {
            getPage: async (id, index) => { calls.push([id, index]); return index === 0 ? page(jpeg, 'jpg') : page(png, 'png'); },
            save: async (blob, filename) => { saves.push({ filename, bytes: Buffer.from(await blob.arrayBuffer()) }); }
        });
        assert.strictEqual(count, 2);
        assert.deepStrictEqual(calls, [['chapter-0', 0], ['chapter-0', 1], ['chapter-1', 0]]);
        assert.deepStrictEqual(saves.map(x => x.filename), ['Synthetic Title/001 - Chapter 1.cbz', 'Synthetic Title/002 - Chapter 2.cbz']);
        const zip = await JSZip.loadAsync(saves[0].bytes);
        assert.deepStrictEqual(Object.keys(zip.files), ['001.jpg', '002.png']);
        assert.deepStrictEqual(await zip.file('001.jpg').async('nodebuffer'), Buffer.from(jpeg));
        assert.deepStrictEqual(await zip.file('002.png').async('nodebuffer'), Buffer.from(png));
    });
    it('never saves a partial chapter and stops subsequent work on a page error', async () => {
        const calls = [], saves = [];
        await assert.rejects(runUniversalChapterBatch(chapters, 'Title', 'zip', {
            getPage: async (id, index) => { calls.push([id, index]); if (index === 1) throw new Error('rate limited'); return page(jpeg, 'jpg'); },
            save: async (_blob, filename) => { saves.push(filename); }
        }), /rate limited/);
        assert.deepStrictEqual(calls, [['chapter-0', 0], ['chapter-0', 1]]);
        assert.deepStrictEqual(saves, []);
    });
    it('rejects forged or mislabeled image bytes before saving', async () => {
        let saved = false;
        await assert.rejects(runUniversalChapterBatch([chapters[0]], 'Title', 'zip', {
            getPage: async () => page(Buffer.from('<html>bad</html>'), 'jpg'),
            save: async () => { saved = true; }
        }), /signature/);
        assert.strictEqual(saved, false);
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
        }, controller.signal), /Cancelled/);
        assert.deepStrictEqual(saves, []);
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
