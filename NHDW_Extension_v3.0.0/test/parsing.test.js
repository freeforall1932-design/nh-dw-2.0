// Fixture tests for the metadata parsers and filename utilities.
// No network access required; `npm test` compiles the TypeScript under test
// into build/test via tsconfig.test.json and runs these against it.

const assert = require('assert');
const ApiParsing = require('../build/test/parsing/ApiParsing.js').default;
const HtmlParsing = require('../build/test/parsing/HtmlParsing.js').default;
const { utils } = require('../build/test/utils/utils.js');

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
            parsing.GetJsonAsync(new Response(html, { status: 403 })),
            (error) => error instanceof SyntaxError || error instanceof TypeError
        );
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
