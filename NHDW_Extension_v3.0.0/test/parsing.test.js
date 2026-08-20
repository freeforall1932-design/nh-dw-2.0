// Fixture tests for the metadata parsers and filename utilities.
// No network access required; `npm test` compiles the TypeScript under test
// into build/test via tsconfig.test.json and runs these against it.

const assert = require('assert');
const ApiParsing = require('../build/test/parsing/ApiParsing.js').default;
const { isCloudflareResponse } = require('../build/test/parsing/ApiParsing.js');
const HtmlParsing = require('../build/test/parsing/HtmlParsing.js').default;
const { parseGalleryCardsFromHtml, extractFirstLine } = require('../build/test/parsing/CardParsing.js');
const { utils, classifyError } = require('../build/test/utils/utils.js');

describe('ApiParsing', () => {
    const parsing = new ApiParsing();

    it('builds the API URL for a gallery id', () => {
        assert.strictEqual(parsing.GetUrl('123456'), 'https://nhentai.net/api/gallery/123456');
    });

    it('parses a successful JSON response', async () => {
        const json = { id: 123456, title: { english: 'Test', japanese: '', pretty: 'Test' }, tags: [] };
        const result = await parsing.GetJsonAsync(new Response(JSON.stringify(json), { status: 200 }));
        assert.deepStrictEqual(result, json);
    });

    it('rejects a Cloudflare/HTML response (403 page)', async () => {
        const html = '<html><head><title>Just a moment...</title></head><body>cf-challenge</body></html>';
        await assert.rejects(
            parsing.GetJsonAsync(new Response(html, { status: 403, headers: { 'Content-Type': 'text/html' } })),
            (error) => /Cloudflare blocked/.test(error.message)
        );
    });

    it('rejects a 503 Cloudflare challenge with a clear message', async () => {
        const html = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
        await assert.rejects(
            parsing.GetJsonAsync(new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=UTF-8' } })),
            (error) => /Cloudflare blocked/.test(error.message)
        );
    });

    it('rejects a 200 Cloudflare HTML challenge with a clear message', async () => {
        const html = '<html><body>cf-challenge</body></html>';
        await assert.rejects(
            parsing.GetJsonAsync(new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })),
            (error) => /Unexpected response type/.test(error.message)
        );
    });
});

describe('isCloudflareResponse', () => {
    it('detects a 403 response as Cloudflare', () => {
        const resp = new Response('', { status: 403, headers: { 'Content-Type': 'text/html' } });
        assert.strictEqual(isCloudflareResponse(resp), true);
    });

    it('detects a 503 response as Cloudflare', () => {
        const resp = new Response('', { status: 503, headers: { 'Content-Type': 'text/html' } });
        assert.strictEqual(isCloudflareResponse(resp), true);
    });

    it('detects a 200 response with HTML content-type as Cloudflare', () => {
        const resp = new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        assert.strictEqual(isCloudflareResponse(resp), true);
    });

    it('does not flag a healthy JSON response', () => {
        const resp = new Response('{"id":1}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        assert.strictEqual(isCloudflareResponse(resp), false);
    });

    it('does not flag a 404 with JSON content-type', () => {
        const resp = new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
        assert.strictEqual(isCloudflareResponse(resp), false);
    });
});

describe('HtmlParsing', () => {
    const parsing = new HtmlParsing();

    it('builds the gallery page URL for a gallery id', () => {
        assert.strictEqual(parsing.GetUrl('123456'), 'https://nhentai.net/g/123456/1/');
    });

    it('extracts the window._gallery object from a page (\\u0022 escapes + unicode)', async () => {
        // Mirrors the real embed: everything is escaped with \uXXXX, including
        // the double quotes, so the parser's \uXXXX unescape must run first.
        const embed = String.raw`{\u0022id\u0022:123456,\u0022media_id\u0022:\u0022987654\u0022,\u0022title\u0022:{\u0022english\u0022:\u0022Test Gallery\u0022,\u0022japanese\u0022:\u0022\u30c6\u30b9\u30c8\u0022,\u0022pretty\u0022:\u0022Test Gallery\u0022},\u0022images\u0022:{\u0022pages\u0022:[{\u0022t\u0022:\u0022j\u0022},{\u0022t\u0022:\u0022p\u0022}]},\u0022tags\u0022:[]}`;
        const html = '<html><body><script>window._gallery = JSON.parse("' + embed + '");</script></body></html>';
        const result = await parsing.GetJsonAsync(new Response(html, { status: 200 }));
        assert.deepStrictEqual(result, {
            id: 123456,
            media_id: '987654',
            title: { english: 'Test Gallery', japanese: '\u30c6\u30b9\u30c8', pretty: 'Test Gallery' },
            images: { pages: [{ t: 'j' }, { t: 'p' }] },
            tags: []
        });
    });

    it('rejects a page without the window._gallery marker', async () => {
        await assert.rejects(
            parsing.GetJsonAsync(new Response('<html><body>no gallery here</body></html>', { status: 200 })),
            (error) => error instanceof TypeError
        );
    });
});

describe('utils', () => {
    it('cleanName removes characters Chrome rejects in filenames', () => {
        assert.strictEqual(utils.cleanName('a/b\\c?d%e*f:g|h"i<j>k.l', false), 'abcdefghijkl');
    });

    it('cleanName replaces spaces with underscores when requested', () => {
        assert.strictEqual(utils.cleanName('My  Nice   Title ', true), 'My_Nice_Title');
    });

    it('cleanName prefixes Windows reserved device names', () => {
        assert.strictEqual(utils.cleanName('CON', false), '_CON');
        assert.strictEqual(utils.cleanName('prn', false), '_prn');
        assert.strictEqual(utils.cleanName('NUL', false), '_NUL');
        assert.strictEqual(utils.cleanName('Com1', false), '_Com1');
        assert.strictEqual(utils.cleanName('LPT9', false), '_LPT9');
        // Ordinary names must be left untouched.
        assert.strictEqual(utils.cleanName('Continue', false), 'Continue');
        assert.strictEqual(utils.cleanName('Conan', false), 'Conan');
    });

    it('cleanName falls back to a placeholder for empty or all-invalid titles', () => {
        assert.strictEqual(utils.cleanName('', false), 'untitled');
        assert.strictEqual(utils.cleanName('   ', false), 'untitled');
        assert.strictEqual(utils.cleanName('?*:/\\', false), 'untitled');
        assert.strictEqual(utils.cleanName('...', false), 'untitled');
        assert.strictEqual(utils.cleanName('', true), 'untitled');
    });

    it('cleanName preserves Unicode titles', () => {
        assert.strictEqual(utils.cleanName('\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8', true), '\u65e5\u672c\u8a9e_\u30c6\u30b9\u30c8');
        assert.strictEqual(utils.cleanName('\u597d\u304d\u306a\u7269\u8a9e', false), '\u597d\u304d\u306a\u7269\u8a9e');
    });

    it('cleanName uses fallbackId when the title sanitizes to empty', () => {
        // With a fallback ID, an empty title becomes "gallery-<id>".
        assert.strictEqual(utils.cleanName('', false, '123456'), 'gallery-123456');
        assert.strictEqual(utils.cleanName('   ', true, '98765'), 'gallery-98765');
        assert.strictEqual(utils.cleanName('?*:/\\', false, '42'), 'gallery-42');
        assert.strictEqual(utils.cleanName('...', false, '0'), 'gallery-0');
        // Without a fallbackId the existing "untitled" fallback must still apply.
        assert.strictEqual(utils.cleanName('', false), 'untitled');
        assert.strictEqual(utils.cleanName('   ', true), 'untitled');
    });

    it('cleanName avoids reserved names even with a fallbackId', () => {
        assert.strictEqual(utils.cleanName('CON', false, '5'), '_CON');
        assert.strictEqual(utils.cleanName('nul', false, '99'), '_nul');
    });

    it('getDownloadName substitutes every placeholder', () => {
        const tags = [
            { id: 1, type: 'language', name: 'english', url: '', count: 0 },
            { id: 2, type: 'language', name: 'translated', url: '', count: 0 },
            { id: 3, type: 'artist', name: 'artist-a', url: '', count: 0 },
            { id: 4, type: 'artist', name: 'artist-b', url: '', count: 0 },
            { id: 5, type: 'group', name: 'group-x', url: '', count: 0 },
            { id: 6, type: 'character', name: 'char-y', url: '', count: 0 }
        ];
        const name = utils.getDownloadName(
            '[{artist}] {pretty} ({group}) [{language}] #{id}',
            'Pretty Name',
            'English Name',
            '\u65e5\u672c\u8a9e',
            '123456',
            tags
        );
        assert.strictEqual(name, '[artist-a, artist-b] Pretty Name (group-x) [english] #123456');
    });

    it('getDownloadName leaves placeholders empty when tags are absent', () => {
        const name = utils.getDownloadName('{pretty}|{artist}|{language}', 'Pretty', 'English', 'Japanese', '1', []);
        assert.strictEqual(name, 'Pretty||');
    });
});

describe('parseGalleryCardsFromHtml', () => {
    it('extracts id + title pairs from listing HTML', () => {
        const html = '<div class="container">'
            + '<a class="cover" href="/g/111111/"><img src="t.jpg"><div class="caption">Title A</div></a>'
            + '<a class="cover" href="/g/222222/"><img src="t.jpg"><div class="caption">Title B</div></a>'
            + '</div>';
        assert.deepStrictEqual(parseGalleryCardsFromHtml(html), [
            { id: '111111', title: 'Title A' },
            { id: '222222', title: 'Title B' }
        ]);
    });

    it('decodes HTML entities and preserves quotes in titles', () => {
        const html = '<a class="cover" href="/g/333333/"><div class="caption">It&apos;s &quot;Great&quot; &amp; Fine</div></a>';
        assert.deepStrictEqual(parseGalleryCardsFromHtml(html), [
            { id: '333333', title: 'It\'s "Great" & Fine' }
        ]);
    });

    it('skips duplicate gallery ids (same gallery on several cards)', () => {
        const html = '<a class="cover" href="/g/444444/"><div class="caption">First</div></a>'
            + '<a class="cover" href="/g/444444/"><div class="caption">Second</div></a>';
        const cards = parseGalleryCardsFromHtml(html);
        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].id, '444444');
        assert.strictEqual(cards[0].title, 'First');
    });

    it('survives newlines and extra markup between cards', () => {
        const html = '<a class="cover"\n  href="/g/555555/">\n  <div class="caption">Line1</div>\n</a>\n'
            + '<a class="cover" href="/g/666666/"><div class="caption">Line2</div></a>';
        assert.deepStrictEqual(parseGalleryCardsFromHtml(html), [
            { id: '555555', title: 'Line1' },
            { id: '666666', title: 'Line2' }
        ]);
    });

    it('returns an empty title when the caption is missing', () => {
        const html = '<a class="cover" href="/g/777777/"><img src="t.jpg"></a>';
        assert.deepStrictEqual(parseGalleryCardsFromHtml(html), [
            { id: '777777', title: '' }
        ]);
    });

    it('splits the title from injected checkbox markup after <br>', () => {
        const html = '<a class="cover" href="/g/888888/"><div class="caption">Real Title<br/><br/><input id="888888" type="checkbox"> NHentai Downloader:</div></a>';
        assert.deepStrictEqual(parseGalleryCardsFromHtml(html), [
            { id: '888888', title: 'Real Title' }
        ]);
    });

    it('matches a cover link with a trailing page segment', () => {
        const html = '<a class="cover" href="/g/999999/1/"><div class="caption">Deep Link</div></a>';
        assert.deepStrictEqual(parseGalleryCardsFromHtml(html), [
            { id: '999999', title: 'Deep Link' }
        ]);
    });

    it('extractFirstLine strips tags and keeps the first line only', () => {
        assert.strictEqual(extractFirstLine('Hello<br>pages 123'), 'Hello');
        assert.strictEqual(extractFirstLine('<b>Bold</b> title'), 'Bold title');
        assert.strictEqual(extractFirstLine('  padded  '), 'padded');
        assert.strictEqual(extractFirstLine('A &amp; B &#65;&#66;'), 'A & B AB');
    });
});

describe('classifyError', () => {
    it('classifies user cancellation', () => {
        assert.deepStrictEqual(classifyError('Download was aborted'), { kind: 'cancelled', label: 'Cancelled' });
        assert.deepStrictEqual(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })), { kind: 'cancelled', label: 'Cancelled' });
    });

    it('classifies Cloudflare blocks', () => {
        const e = 'Cloudflare blocked the request (HTTP 503). Open the gallery in a tab, complete any challenge, then try again.';
        assert.deepStrictEqual(classifyError(e), { kind: 'cloudflare', label: 'Cloudflare blocked' });
    });

    it('classifies image fetch failures', () => {
        assert.deepStrictEqual(classifyError('Failed to fetch original image from all image servers (404: ).').kind, 'image');
        assert.deepStrictEqual(classifyError('Failed to fetch original image from all image servers (response too small (10 bytes)).').kind, 'image');
        assert.deepStrictEqual(classifyError('Failed to download original image (download failed).').kind, 'image');
        assert.strictEqual(classifyError('Failed to fetch original image from all image servers (unexpected content-type "text/html").').kind, 'image');
    });

    it('classifies archive (ZIP) start failures', () => {
        assert.deepStrictEqual(classifyError('Unable to start download'), { kind: 'zip', label: 'Archive download failed' });
    });

    it('classifies metadata failures', () => {
        assert.deepStrictEqual(classifyError('Can\'t download 123456 (Code 404: not found).').kind, 'metadata');
        assert.deepStrictEqual(classifyError('Unexpected response type "text/html" (HTTP 200).').kind, 'metadata');
        assert.deepStrictEqual(classifyError('Unknown page format x').kind, 'metadata');
    });

    it('falls back to unknown', () => {
        assert.deepStrictEqual(classifyError('Something totally unexpected'), { kind: 'unknown', label: 'Error' });
    });
});
