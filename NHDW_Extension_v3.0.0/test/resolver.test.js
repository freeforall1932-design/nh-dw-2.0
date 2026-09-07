const assert = require('assert');
const { resolveSelectedGalleries } = require('../build/test/preview/selectedGalleryResolver.js');
const { readGalleryFromTab, getActiveNhentaiTabId } = require('../build/test/preview/activeTabGallery.js');

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
                    const match = typeof url === 'string' && /galler(?:y|ies)\/(\d+)/.exec(url);
                    if (match) {
                        const id = match[1];
                        callback([{ result: {
                            id: Number(id),
                            media_id: 'media-' + id,
                            title: { pretty: 'Gallery ' + id },
                            images: { pages: [{ t: 'w' }] }
                        } }]);
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

    it('uses an invisible same-tab gallery document only after tab-scoped fetches fail', async () => {
        global.chrome.scripting.executeScript = (details, callback) => {
            executeCalls.push(details);
            const arg = details.args && details.args[0];
            if (arg === '333') {
                callback([{ result: {
                    id: 333,
                    media_id: 'frame-333',
                    title: { pretty: 'Frame Gallery' },
                    images: { pages: [{ t: 'w' }] }
                } }]);
            } else {
                callback([{ result: null }]);
            }
        };

        const resolved = await resolveSelectedGalleries(['333'], 42);
        assert.strictEqual(resolved['333'].media_id, 'frame-333');
        assert.ok(executeCalls.some((call) => call.args[0] === '333'));
        assert.ok(executeCalls.every((call) => call.target.tabId === 42));
    });

    it('does not try to create a fallback tab when no source tab was supplied', async () => {
        const resolved = await resolveSelectedGalleries(['789']);
        assert.deepStrictEqual(resolved, {});
        assert.strictEqual(executeCalls.length, 0);
    });

    it('parses gallery metadata from already-loaded script tags without hitting the API', async () => {
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
        assert.strictEqual(executeCount, 1, 'must not fall through to a same-origin API fetch');
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


// The bookmark Queue tab can be opened while the active tab is any website, and
// neither the worker's resolveTabId() nor the batch pipeline validates the tab
// they are handed. This guard is what keeps enrichment and Queue downloads from
// pointing at a foreign tab.
describe('nhentai-only active tab guard', () => {
    function stubActiveTab(tab) {
        global.chrome = {
            runtime: { lastError: null },
            tabs: { query(_query, cb) { cb(tab === undefined ? [] : [tab]); } }
        };
    }

    afterEach(() => { delete global.chrome; });

    it('returns the id when the active tab is on nhentai', async () => {
        stubActiveTab({ id: 7, url: 'https://nhentai.net/g/366224/' });
        assert.strictEqual(await getActiveNhentaiTabId(), 7);
    });

    it('accepts the bare origin and listing pages too', async () => {
        stubActiveTab({ id: 8, url: 'https://nhentai.net/' });
        assert.strictEqual(await getActiveNhentaiTabId(), 8);
        stubActiveTab({ id: 9, url: 'https://nhentai.net/search/?q=test' });
        assert.strictEqual(await getActiveNhentaiTabId(), 9);
    });

    it('refuses any other site, however similar the host looks', async () => {
        for (const url of [
            'https://example.com/',
            'https://nhentai.net.evil.com/g/1/',
            'https://evil-nhentai.net/g/1/',
            'http://nhentai.net/g/1/',
            'chrome://extensions/'
        ]) {
            stubActiveTab({ id: 3, url: url });
            assert.strictEqual(await getActiveNhentaiTabId(), undefined,
                'must refuse ' + url);
        }
    });

    it('refuses a tab with no url (chrome hides it without the tabs permission)', async () => {
        stubActiveTab({ id: 4 });
        assert.strictEqual(await getActiveNhentaiTabId(), undefined);
    });

    it('survives no tab at all and no chrome object', async () => {
        stubActiveTab(undefined);
        assert.strictEqual(await getActiveNhentaiTabId(), undefined);
        delete global.chrome;
        assert.strictEqual(await getActiveNhentaiTabId(), undefined);
    });
});
