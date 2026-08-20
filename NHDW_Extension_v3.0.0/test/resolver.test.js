const assert = require('assert');
const { resolveSelectedGalleries } = require('../build/test/preview/selectedGalleryResolver.js');
const { readGalleryFromTab } = require('../build/test/preview/activeTabGallery.js');

function eventHook() {
    const listeners = new Set();
    return {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
        emit(...args) { for (const listener of Array.from(listeners)) listener(...args); },
        get size() { return listeners.size; }
    };
}

describe('selected gallery resolver', () => {
    let created;
    let removed;
    let updated;
    let nextTabId;

    beforeEach(() => {
        created = [];
        removed = [];
        updated = eventHook();
        nextTabId = 100;
        global.chrome = {
            runtime: { lastError: null },
            tabs: {
                onUpdated: updated,
                create(options, callback) {
                    const tab = { id: nextTabId++, status: 'loading', url: options.url };
                    created.push(tab);
                    callback(tab);
                },
                get(tabId, callback) {
                    const tab = created.find((candidate) => candidate.id === tabId);
                    callback(tab);
                },
                remove(tabId, callback) {
                    removed.push(tabId);
                    if (callback) callback();
                }
            },
            scripting: {
                executeScript(details, callback) {
                    const tab = created.find((candidate) => candidate.id === details.target.tabId);
                    const id = tab.url.match(/\/g\/(\d+)\//)[1];
                    callback([{ result: {
                        id: Number(id),
                        media_id: 'media-' + id,
                        title: { pretty: 'Gallery ' + id },
                        images: { pages: [{ t: 'w' }] }
                    } }]);
                }
            }
        };
    });

    afterEach(() => {
        delete global.chrome;
    });

    it('resolves selected galleries sequentially and closes every temporary tab', async () => {
        const resultPromise = resolveSelectedGalleries(['123', '456']);
        // Each tab starts loading, so the resolver must wait for the update event.
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(created.length, 1);
        updated.emit(created[0].id, { status: 'complete' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(created.length, 2);
        updated.emit(created[1].id, { status: 'complete' });

        const resolved = await resultPromise;
        assert.deepStrictEqual(Object.keys(resolved), ['123', '456']);
        assert.deepStrictEqual(removed, [100, 101]);
        assert.strictEqual(updated.size, 0);
    });

    it('uses an already-complete tab without waiting for an update event', async () => {
        global.chrome.tabs.get = (tabId, callback) => {
            const tab = created.find((candidate) => candidate.id === tabId);
            callback(Object.assign({}, tab, { status: 'complete' }));
        };
        const resolved = await resolveSelectedGalleries(['789']);
        assert.strictEqual(resolved['789'].media_id, 'media-789');
        assert.deepStrictEqual(removed, [100]);
        assert.strictEqual(updated.size, 0);
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
