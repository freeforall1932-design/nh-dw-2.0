// Entirely synthetic MangaReader-like examples. They are not evidence of the
// real site's DOM, selectors, servers, authorization, or downloadable media.
const assert = require('assert');
const { URL: NodeURL } = require('node:url');
const {
    inspectSasangeyouReaderCandidate,
    selectReaderServer
} = require('../build/test/parsing/sasangeyouReaderCandidate.js');

const base = 'https://sasangeyou.net/synthetic-reader/';
const identity = { seriesId: 'fixture-series', chapterId: 'fixture-chapter', advertisedPageCount: 2 };
function scriptFor(sources) {
    return '/* synthetic script */\nts_reader.run(' + JSON.stringify({ sources }) + ');';
}

describe('Sasangeyou reader data candidates (synthetic, not wired)', () => {
    let previousUrl;
    beforeEach(() => {
        previousUrl = globalThis.URL;
        globalThis.URL = NodeURL;
    });
    afterEach(() => {
        if (previousUrl === undefined) delete globalThis.URL;
        else globalThis.URL = previousUrl;
    });

    it('offers separate ordered server candidates and requires an explicit selection', () => {
        const script = scriptFor([
            { source: 'Server A', images: ['https://a.example.test/001.jpg', 'https://a.example.test/002.webp'] },
            { source: 'Server B', images: ['https://b.example.test/one.jpg', '/synthetic-insert.png', 'https://b.example.test/one.jpg'] }
        ]);
        const result = inspectSasangeyouReaderCandidate(script, base);
        assert.strictEqual(result.kind, 'candidates');
        assert.deepStrictEqual(result.servers.map(s => [s.id, s.label]), [['server-1', 'Server A'], ['server-2', 'Server B']]);
        assert.throws(() => selectReaderServer(result, '', identity), /not in this snapshot/);
        const selected = selectReaderServer(result, 'server-2', identity);
        assert.strictEqual(selected.serverId, 'server-2');
        assert.deepStrictEqual(selected.pages.map(p => p.url), [
            'https://b.example.test/one.jpg', 'https://sasangeyou.net/synthetic-insert.png', 'https://b.example.test/one.jpg'
        ]);
        assert.ok(selected.pages.every(p => p.serverId === 'server-2'));
        assert.deepStrictEqual(selected.pages.map(p => p.id), ['page-1', 'page-2', 'page-3']);
        assert.strictEqual(selected.referenceCount, 3);
        assert.strictEqual(selected.advertisedCountMatchesReferences, false);
    });

    it('retains quoted braces and escapes while parsing JSON, never executing script', () => {
        globalThis.__readerCandidateExecuted = false;
        const data = { sources: [{ name: 'Server { one } \\ "', images: ['https://images.example.test/one.jpg?x=%7B1%7D'] }] };
        const script = 'globalThis.__readerCandidateExecuted = true; ts_reader.run(' + JSON.stringify(data) + ');';
        const result = inspectSasangeyouReaderCandidate(script, base);
        assert.strictEqual(result.kind, 'candidates');
        assert.strictEqual(result.servers[0].label, data.sources[0].name);
        assert.strictEqual(globalThis.__readerCandidateExecuted, false);
        delete globalThis.__readerCandidateExecuted;
    });

    it('requires a single JSON marker and rejects executable or malformed arguments', () => {
        const tests = [
            ['no marker', 'no-marker'],
            ['ts_reader.run({"sources":[]}); ts_reader.run({"sources":[]});', 'ambiguous-markers'],
            ['ts_reader.run({sources: []});', 'invalid-data'],
            ['ts_reader.run({"sources": [', 'invalid-data'],
            ['ts_reader.run({"sources":[]}, alert(1));', 'invalid-data'],
            ['ts_reader.run({"sources": []});', 'invalid-data'],
            [scriptFor([{ source: 'Empty', images: [] }]), 'invalid-data'],
            [scriptFor(Array.from({ length: 21 }, () => ({ images: ['https://a.example.test/a.jpg'] }))), 'invalid-data']
        ];
        for (const [script, reason] of tests) {
            assert.deepStrictEqual(inspectSasangeyouReaderCandidate(script, base), { kind: 'review', reason });
        }
        assert.strictEqual(inspectSasangeyouReaderCandidate('x'.repeat(4 * 1024 * 1024 + 1), base).reason, 'invalid-data');
    });

    it('rejects questionable base pages and locators without echoing them', () => {
        const image = scriptFor([{ images: ['https://cdn.example.test/1.jpg'] }]);
        for (const reader of ['http://sasangeyou.net/reader', 'https://sasangeyou.net.evil.test/reader', 'https://user@sasangeyou.net/reader', 'https://sasangeyou.net:8443/reader']) {
            assert.strictEqual(inspectSasangeyouReaderCandidate(image, reader).reason, 'invalid-data');
        }
        for (const locator of [
            'http://cdn.example.test/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,a',
            'https://user:secret@cdn.example.test/a.jpg', 'https://127.0.0.1/a.jpg', 'https://localhost/a.jpg',
            'https://box.local/a.jpg', 'https://cdn.example.test:8443/a.jpg', ' https://cdn.example.test/a.jpg '
        ]) {
            const result = inspectSasangeyouReaderCandidate(scriptFor([{ images: [locator] }]), base);
            assert.deepStrictEqual(result, { kind: 'review', reason: 'invalid-locator' });
            assert.ok(!JSON.stringify(result).includes(locator));
        }
    });

    it('never chooses an unrelated or missing candidate, and keeps snapshots independent', () => {
        const one = inspectSasangeyouReaderCandidate(scriptFor([{ images: ['https://a.example.test/a.jpg'] }]), base);
        const two = inspectSasangeyouReaderCandidate(scriptFor([
            { images: ['https://b.example.test/b.jpg'] }, { images: ['https://c.example.test/c.jpg'] }
        ]), base);
        assert.throws(() => selectReaderServer(one, 'server-2', identity), /not in this snapshot/);
        assert.strictEqual(selectReaderServer(one, 'server-1', identity).pages[0].url, 'https://a.example.test/a.jpg');
        assert.strictEqual(selectReaderServer(two, 'server-2', identity).pages[0].url, 'https://c.example.test/c.jpg');
        assert.throws(() => selectReaderServer({ kind: 'review', reason: 'no-marker' }, 'server-1', identity), /require review/);
    });
});
