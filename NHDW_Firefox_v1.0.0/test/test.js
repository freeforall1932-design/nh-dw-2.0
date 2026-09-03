// Live network check against the real nhentai API.
// Opt-in only: run with RUN_LIVE_TESTS=1 (npm run test:live).
// The default `npm test` suite never touches the network.
//
// API key mode checks additionally require your own key:
//
//     NH_API_KEY=<your key> npm run test:live
//
// They answer the two open questions from the session handoff without
// needing the extension or a browser:
//   1. Is the keyed official API reachable and accepted for this account?
//   2. Does POST /api/v2/galleries/<id>/download return a usable archive URL
//      for this account (the `allow_downloads` feature flag / tier), and is
//      the short-lived URL fetchable without the key, as the extension does?
//
// The archive probe REPORTS availability instead of asserting it: the
// endpoint may legitimately be gated per account, and the extension is
// designed to fall back to page-by-page in exactly that case.

const assert = require('assert');
const fetch = require('node-fetch');

// Fixture tests intentionally exercise retryable image failures. Keep those
// expected warnings out of a passing test run; production bundles do not set it.
global.__NHDW_SILENT_RETRY_LOGS__ = true;

const live = process.env.RUN_LIVE_TESTS === '1' ? describe : describe.skip;
const keyedLive = (process.env.RUN_LIVE_TESTS === '1' && process.env.NH_API_KEY)
    ? describe
    : describe.skip;

// A known-live gallery used for the keyed probes (verified 2026-08: 31 pages,
// media_id 4128713, all webp).
const GALLERY_ID = '674496';
const MEDIA_ID = '4128713';
const API_KEY = String(process.env.NH_API_KEY || '').trim();

live('Live nhentai API (opt-in)', () => {
    it('Get doujinshi pretty text', async () => {
        const response = await fetch('https://nhentai.net/api/v2/galleries/161194');
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.title.pretty, "Tsuna-kan. | Tuna Can");
    });
});

keyedLive('Live nhentai API with an API key (opt-in, NH_API_KEY)', () => {
    // The documented third-party auth scheme; only ever attached to
    // nhentai.net API routes — mirroring apiAuth.getApiHeadersForUrl().
    const authHeaders = { Authorization: 'Key ' + API_KEY };

    it('verifies the key against the documented profile endpoint', async () => {
        const response = await fetch('https://nhentai.net/api/v2/user', { headers: authHeaders });
        assert.equal(response.status, 200,
            'HTTP ' + response.status + ' — the API rejected this key');
        const profile = await response.json();
        assert.equal(typeof profile.username, 'string');
        assert.ok(profile.username.length > 0);
        console.log('    key verified for user: ' + profile.username);
    });

    it('reads gallery metadata through the keyed official API', async () => {
        const response = await fetch('https://nhentai.net/api/v2/galleries/' + GALLERY_ID, {
            headers: authHeaders
        });
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(String(json.media_id), MEDIA_ID);
        assert.ok(Array.isArray(json.pages) && json.pages.length > 0,
            'API v2 payload must carry pages');

        // Prove the extension's normalizer consumes the LIVE payload: legacy
        // shape out, every page mapped to a usable type code.
        const { coerceGallery } = require('../build/test/parsing/GalleryEmbed.js');
        const legacy = coerceGallery(json);
        assert.ok(legacy, 'coerceGallery must normalize the live API v2 payload');
        assert.equal(String(legacy.media_id), MEDIA_ID);
        assert.ok(Array.isArray(legacy.images.pages) && legacy.images.pages.length > 0);
        assert.ok(legacy.images.pages.every((page) => page.t !== '0'),
            'every live page must map to a usable type code');
    });

    it('probes the one-shot archive endpoint and reports availability', async () => {
        const response = await fetch(
            'https://nhentai.net/api/v2/galleries/' + GALLERY_ID + '/download?format=zip',
            { method: 'POST', headers: authHeaders }
        );

        if (response.status === 200) {
            const body = await response.json();
            assert.equal(typeof body.url, 'string', 'DownloadResponse must carry a url');
            assert.ok(/^https?:\/\//.test(body.url), 'the archive url must be absolute');
            assert.equal(typeof body.expires_at, 'number', 'DownloadResponse must carry expires_at');

            // The extension fetches the short-lived delivery URL WITHOUT the
            // API key (the signed URL is the credential). Verify that works
            // and the payload really is a ZIP — read only the first chunk,
            // never the whole archive.
            const archiveResp = await fetch(body.url);
            assert.equal(archiveResp.status, 200,
                'the archive delivery URL must be fetchable without the API key');
            const head = await new Promise((resolve, reject) => {
                let settled = false;
                archiveResp.body.once('data', (chunk) => {
                    if (!settled) { settled = true; resolve(chunk); archiveResp.body.destroy(); }
                });
                archiveResp.body.once('error', (error) => {
                    if (!settled) { settled = true; reject(error); }
                });
                archiveResp.body.once('end', () => {
                    if (!settled) { settled = true; resolve(Buffer.alloc(0)); }
                });
            });
            assert.ok(head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b,
                'the archive must start with the ZIP magic bytes PK');
            console.log('    ANSWER: archive endpoint AVAILABLE for this account' +
                ' (DownloadResponse url + expires_at, delivery URL fetchable keyless, ZIP magic ok).' +
                ' expires_at=' + body.expires_at);
        } else if (response.status === 401 || response.status === 403) {
            console.log('    ANSWER: archive endpoint rejected this key (HTTP ' +
                response.status + '). The extension falls back to page-by-page.');
        } else if (response.status === 503) {
            console.log('    ANSWER: archive feature disabled server-side (HTTP 503,' +
                ' allow_downloads flag). The extension falls back to page-by-page.');
        } else if (response.status === 429) {
            console.log('    ANSWER: archive endpoint rate-limited right now (HTTP 429)' +
                ' — rerun later; the extension backs off on Retry-After.');
        } else {
            console.log('    ANSWER: unexpected HTTP ' + response.status +
                ' from the archive endpoint.');
        }
        // Contract check only: any documented outcome is acceptable here —
        // availability depends on the account, and the extension is built to
        // fall back on every non-200.
        assert.ok(response.status > 0, 'the probe must get an HTTP answer');
    });
});

if (process.env.RUN_LIVE_TESTS === '1' && !process.env.NH_API_KEY) {
    console.log('NOTE: set NH_API_KEY=<your key> to also run the keyed live checks' +
        ' (key verification, keyed metadata, archive-endpoint availability).');
}
