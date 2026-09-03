// Fixture tests for the shared CDN image-server configuration (no network,
// no browser): validation of API-reported servers, response parsing, merge
// order with the cached fallback list, URL generation, allowed-image
// validation, and the optional-permission origin computation.

const assert = require('assert');
const {
    DEFAULT_IMAGE_SERVERS,
    CDN_CONFIG_URL,
    isValidImageServerUrl,
    sanitizeImageServers,
    parseCdnConfigBody,
    mergeImageServers,
    setImageServers,
    resetImageServers,
    getImageServers,
    imageServerOrigins,
    buildImageUrl,
    isAllowedImageUrl
} = require('../build/test/sources/cdnConfig.js');
const { clearnetSource } = require('../build/test/sources/GallerySource.js');
const { isAllowedImageUrl: tabIsAllowedImageUrl } = require('../build/test/background/tabImageFetch.js');

// Restore the default (built-in) server list after every test so module state
// never leaks between cases.
afterEach(() => {
    resetImageServers();
});

describe('CDN config defaults', () => {
    it('keeps the documented fallback mirror list', () => {
        assert.deepStrictEqual(DEFAULT_IMAGE_SERVERS, [
            'https://i.nhentai.net',
            'https://i1.nhentai.net',
            'https://i2.nhentai.net',
            'https://i3.nhentai.net',
            'https://i4.nhentai.net'
        ]);
        assert.strictEqual(CDN_CONFIG_URL, 'https://nhentai.net/api/v2/cdn');
    });

    it('uses the fallback list until a runtime list is applied', () => {
        assert.deepStrictEqual(getImageServers(), DEFAULT_IMAGE_SERVERS);
    });

    it('generates the same URL order as before hardening for the default list', () => {
        assert.deepStrictEqual(clearnetSource.getImageUrls('987654', '1.jpg'), [
            'https://i.nhentai.net/galleries/987654/1.jpg',
            'https://i1.nhentai.net/galleries/987654/1.jpg',
            'https://i2.nhentai.net/galleries/987654/1.jpg',
            'https://i3.nhentai.net/galleries/987654/1.jpg',
            'https://i4.nhentai.net/galleries/987654/1.jpg'
        ]);
    });
});

describe('isValidImageServerUrl', () => {
    it('accepts HTTPS nhentai-owned subdomain origins', () => {
        assert.strictEqual(isValidImageServerUrl('https://i.nhentai.net'), true);
        assert.strictEqual(isValidImageServerUrl('https://i7.nhentai.net'), true);
        assert.strictEqual(isValidImageServerUrl('https://i5.nhentai.net/'), true); // trailing slash ok
        assert.strictEqual(isValidImageServerUrl(' https://i.nhentai.net '), true); // trimmed
        assert.strictEqual(isValidImageServerUrl('https://cdn.images.nhentai.net'), true); // multi-label
        assert.strictEqual(isValidImageServerUrl('https://I.NHENTAI.NET'), true); // case-insensitive host
    });

    it('rejects everything that is not a bare HTTPS nhentai subdomain origin', () => {
        assert.strictEqual(isValidImageServerUrl('http://i.nhentai.net'), false); // not HTTPS
        assert.strictEqual(isValidImageServerUrl('ftp://i.nhentai.net'), false);
        assert.strictEqual(isValidImageServerUrl('https://evil.example'), false); // foreign host
        assert.strictEqual(isValidImageServerUrl('https://i.nhentai.net.evil.example'), false); // suffix trick
        assert.strictEqual(isValidImageServerUrl('https://evil.example/i.nhentai.net'), false); // path on foreign host
        assert.strictEqual(isValidImageServerUrl('https://nhentai.net'), false); // apex, not a subdomain
        assert.strictEqual(isValidImageServerUrl('https://i.nhentai.net:8443'), false); // port
        assert.strictEqual(isValidImageServerUrl('https://user:pass@i.nhentai.net'), false); // credentials
        assert.strictEqual(isValidImageServerUrl('https://i.nhentai.net/galleries'), false); // path
        assert.strictEqual(isValidImageServerUrl('https://i.nhentai.net?a=1'), false); // query
        assert.strictEqual(isValidImageServerUrl('https://i.nhentai.net#frag'), false); // fragment
        assert.strictEqual(isValidImageServerUrl(''), false);
        assert.strictEqual(isValidImageServerUrl('not a url'), false);
        assert.strictEqual(isValidImageServerUrl(undefined), false);
        assert.strictEqual(isValidImageServerUrl(42), false);
    });
});

describe('parseCdnConfigBody', () => {
    it('parses the documented /api/v2/cdn response', () => {
        const body = JSON.stringify({
            image_servers: ['https://i.nhentai.net'],
            thumb_servers: ['https://t.nhentai.net']
        });
        assert.deepStrictEqual(parseCdnConfigBody(body), ['https://i.nhentai.net']);
    });

    it('parses the /api/v2/config superset (announcement ignored)', () => {
        const body = JSON.stringify({
            image_servers: ['https://i7.nhentai.net'],
            thumb_servers: ['https://t.nhentai.net'],
            announcement: { message: 'maintenance', links: [] }
        });
        assert.deepStrictEqual(parseCdnConfigBody(body), ['https://i7.nhentai.net']);
    });

    it('drops invalid entries instead of adopting or rejecting the whole list', () => {
        const body = JSON.stringify({
            image_servers: ['https://i7.nhentai.net', 'http://insecure.nhentai.net', 'https://evil.example', 5, null]
        });
        assert.deepStrictEqual(parseCdnConfigBody(body), ['https://i7.nhentai.net']);
    });

    it('returns null for anything unusable so callers keep their fallback', () => {
        assert.strictEqual(parseCdnConfigBody('<html><title>Just a moment...</title></html>'), null); // Cloudflare
        assert.strictEqual(parseCdnConfigBody('{"image_servers": '), null); // broken JSON
        assert.strictEqual(parseCdnConfigBody('{"thumb_servers": []}'), null); // no image_servers
        assert.strictEqual(parseCdnConfigBody('{"image_servers": "https://i.nhentai.net"}'), null); // wrong type
        assert.strictEqual(parseCdnConfigBody('{"image_servers": []}'), null); // empty
        assert.strictEqual(parseCdnConfigBody('{"image_servers": ["https://evil.example"]}'), null); // all invalid
        assert.strictEqual(parseCdnConfigBody(''), null);
        assert.strictEqual(parseCdnConfigBody(null), null);
    });
});

describe('mergeImageServers', () => {
    it('puts API order first and keeps fallback mirrors as the tail', () => {
        assert.deepStrictEqual(
            mergeImageServers(['https://i7.nhentai.net', 'https://i.nhentai.net'], DEFAULT_IMAGE_SERVERS),
            ['https://i7.nhentai.net', 'https://i.nhentai.net',
             'https://i1.nhentai.net', 'https://i2.nhentai.net', 'https://i3.nhentai.net', 'https://i4.nhentai.net']
        );
    });

    it('deduplicates and ignores invalid preferred entries', () => {
        assert.deepStrictEqual(
            mergeImageServers(['https://i1.nhentai.net', 'https://evil.example', 'https://i9.nhentai.net'], DEFAULT_IMAGE_SERVERS),
            ['https://i1.nhentai.net', 'https://i9.nhentai.net',
             'https://i.nhentai.net', 'https://i2.nhentai.net', 'https://i3.nhentai.net', 'https://i4.nhentai.net']
        );
    });

    it('falls back to the default list for empty input', () => {
        assert.deepStrictEqual(mergeImageServers(null, DEFAULT_IMAGE_SERVERS), DEFAULT_IMAGE_SERVERS);
        assert.deepStrictEqual(mergeImageServers([], DEFAULT_IMAGE_SERVERS), DEFAULT_IMAGE_SERVERS);
    });
});

describe('setImageServers (shared URL generation + validation)', () => {
    it('activates validated API hosts for URL generation while keeping the fallback tail', () => {
        setImageServers(['https://i7.nhentai.net']);
        assert.deepStrictEqual(getImageServers(), [
            'https://i7.nhentai.net',
            'https://i.nhentai.net',
            'https://i1.nhentai.net',
            'https://i2.nhentai.net',
            'https://i3.nhentai.net',
            'https://i4.nhentai.net'
        ]);
        assert.deepStrictEqual(clearnetSource.getImageUrls('987654', '12.webp'), [
            'https://i7.nhentai.net/galleries/987654/12.webp',
            'https://i.nhentai.net/galleries/987654/12.webp',
            'https://i1.nhentai.net/galleries/987654/12.webp',
            'https://i2.nhentai.net/galleries/987654/12.webp',
            'https://i3.nhentai.net/galleries/987654/12.webp',
            'https://i4.nhentai.net/galleries/987654/12.webp'
        ]);
    });

    it('sanitizes hostile relayed lists down to the defaults', () => {
        setImageServers(['https://evil.example', 'http://i.nhentai.net', 'garbage', 7]);
        assert.deepStrictEqual(getImageServers(), DEFAULT_IMAGE_SERVERS);
        assert.ok(getImageServers().every((server) => server.endsWith('.nhentai.net')));
    });

    it('resets to the default list on null/empty', () => {
        setImageServers(['https://i7.nhentai.net']);
        setImageServers(null);
        assert.deepStrictEqual(getImageServers(), DEFAULT_IMAGE_SERVERS);
        setImageServers(['https://i7.nhentai.net']);
        setImageServers([]);
        assert.deepStrictEqual(getImageServers(), DEFAULT_IMAGE_SERVERS);
    });
});

describe('isAllowedImageUrl (shared with tabImageFetch)', () => {
    it('accepts default-host image URLs and rejects everything else (legacy strictness)', () => {
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/987654/1.jpg'), true);
        assert.strictEqual(isAllowedImageUrl('https://i2.nhentai.net/galleries/1/12.webp'), true);
        assert.strictEqual(isAllowedImageUrl('https://i3.nhentai.net/galleries/42/7.gif'), true);
        assert.strictEqual(isAllowedImageUrl('https://nhentai.net/g/1/'), false);
        assert.strictEqual(isAllowedImageUrl('https://evil.example/galleries/1/1.jpg'), false);
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/1/1.jpg?x=1'), false);
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/1/1.jpg#p'), false);
        assert.strictEqual(isAllowedImageUrl('http://i.nhentai.net/galleries/1/1.jpg'), false);
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/other/1.jpg'), false);
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/abc/1.jpg'), false);
        assert.strictEqual(isAllowedImageUrl('https://i.nhentai.net/galleries/1/1.tiff'), false);
        assert.strictEqual(isAllowedImageUrl('not a url'), false);
    });

    it('accepts URLs on runtime-configured hosts only after they are activated', () => {
        assert.strictEqual(isAllowedImageUrl('https://i7.nhentai.net/galleries/9/1.jpg'), false);
        setImageServers(['https://i7.nhentai.net']);
        assert.strictEqual(isAllowedImageUrl('https://i7.nhentai.net/galleries/9/1.jpg'), true);
        // Runtime hosts never loosen the shape rules.
        assert.strictEqual(isAllowedImageUrl('https://i7.nhentai.net/galleries/9/1.jpg?x=1'), false);
        assert.strictEqual(isAllowedImageUrl('https://i7.nhentai.net/other/1.jpg'), false);
    });

    it('stays in sync with tabImageFetch validation', () => {
        setImageServers(['https://i7.nhentai.net']);
        for (const url of [
            'https://i7.nhentai.net/galleries/9/1.jpg',
            'https://i.nhentai.net/galleries/987654/1.jpg',
            'https://i7.nhentai.net/galleries/9/1.jpg?x=1',
            'https://evil.example/galleries/1/1.jpg'
        ]) {
            assert.strictEqual(tabIsAllowedImageUrl(url), isAllowedImageUrl(url), url);
        }
    });
});

describe('URL building and permission origins', () => {
    it('builds exact image URLs and normalizes trailing slashes', () => {
        assert.strictEqual(buildImageUrl('https://i.nhentai.net', '987654', '1.jpg'),
            'https://i.nhentai.net/galleries/987654/1.jpg');
        assert.strictEqual(buildImageUrl('https://i7.nhentai.net/', '987654', '2.png'),
            'https://i7.nhentai.net/galleries/987654/2.png');
    });

    it('computes manifest-style origins for the optional grant', () => {
        assert.deepStrictEqual(
            imageServerOrigins(['https://i.nhentai.net', 'https://i7.nhentai.net']),
            ['https://i.nhentai.net/*', 'https://i7.nhentai.net/*']
        );
        assert.deepStrictEqual(
            imageServerOrigins(['https://i.nhentai.net', 'https://i.nhentai.net/', 'https://evil.example']),
            ['https://i.nhentai.net/*'] // deduplicated, invalid skipped
        );
    });

    it('sanitizeImageServers deduplicates and normalizes', () => {
        assert.deepStrictEqual(
            sanitizeImageServers(['https://i7.nhentai.net/', 'https://i7.nhentai.net', 'https://i.nhentai.net']),
            ['https://i7.nhentai.net', 'https://i.nhentai.net']
        );
        assert.deepStrictEqual(sanitizeImageServers('https://i.nhentai.net'), []);
        assert.deepStrictEqual(sanitizeImageServers(null), []);
    });
});
