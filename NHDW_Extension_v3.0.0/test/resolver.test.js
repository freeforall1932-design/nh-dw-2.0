const assert = require('assert');
const { resolveSelectedGalleries } = require('../build/test/preview/selectedGalleryResolver.js');
const { readGalleryFromTab } = require('../build/test/preview/activeTabGallery.js');

describe('selected gallery resolver', () => {
    let executeCalls;

    beforeEach(() => {
        executeCalls = [];
        global.chrome = {
            runtime: { lastError: null },
            // Deliberately omit tabs.create. Batch metadata must be obtained
            // from the already-open source tab, never from temporary tabs.
            tabs: {},
            scripting: {
                executeScript(details, callback) {
                    executeCalls.push(details);
                    const url = details.args && details.args[0];
                    const match = typeof url === 'string' && /gallery\/(\d+)/.exec(url);
                    if (match) {
                        const id = match[1];
                        callback([{ result: JSON.stringify({
                            id: Number(id),
                            media_id: 'media-' + id,
                            title: { pretty: 'Gallery ' + id },
                            images: { pages: [{ t: 'w' }] }
                        }) }]);
                    } else {
                        callback([{ result: { gallery: null, scripts: [] } }]);
                    }
                }
            }
        };
    });

    afterEach(() => {
        delete global.chrome;
    });

    it('resolves selected galleries through the supplied tab without creating or navigating tabs', async () => {
        const resolved = await resolveSelectedGalleries(['123', '456'], 42);
        assert.deepStrictEqual(Object.keys(resolved), ['123', '456']);
        assert.strictEqual(resolved['123'].media_id, 'media-123');
        assert.strictEqual(resolved['456'].media_id, 'media-456');
        assert.ok(executeCalls.length >= 2);
        assert.ok(executeCalls.every((call) => call.target.tabId === 42));
    });

    it('does not try to create a fallback tab when no source tab was supplied', async () => {
        const resolved = await resolveSelectedGalleries(['789']);
        assert.deepStrictEqual(resolved, {});
        assert.strictEqual(executeCalls.length, 0);
    });

    it('parses window._gallery from already-loaded script tags without hitting /api/gallery', async () => {
        const embed = String.raw`{\u0022id\u0022:555,\u0022media_id\u0022:\u0022777\u0022,\u0022title\u0022:{\u0022pretty\u0022:\u0022From Script\u0022},\u0022images\u0022:{\u0022pages\u0022:[{\u0022t\u0022:\u0022j\u0022}]}}`;
        let executeCount = 0;
        global.chrome.scripting.executeScript = (details, callback) => {
            executeCount++;
            callback([{ result: {
                gallery: null,
                scripts: ['window._gallery = JSON.parse("' + embed + '");']
            } }]);
        };
        const gallery = await readGalleryFromTab(42, '555');
        assert.strictEqual(gallery.media_id, '777');
        assert.strictEqual(gallery.title.pretty, 'From Script');
        assert.strictEqual(executeCount, 1, 'must not fall through to a same-origin /api/gallery fetch');
    });

    it('accepts a gallery object already present on the page without extra fetches', async () => {
        let executeCount = 0;
        global.chrome.scripting.executeScript = (details, callback) => {
            executeCount++;
            callback([{ result: {
                gallery: {
                    id: 1,
                    media_id: '9',
                    title: { pretty: 'Live' },
                    images: { pages: [{ t: 'w' }] }
                },
                scripts: []
            } }]);
        };
        const gallery = await readGalleryFromTab(7, '1');
        assert.strictEqual(gallery.media_id, '9');
        assert.strictEqual(executeCount, 1);
    });
});
