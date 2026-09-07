// Persistent bookmark queue: paste parsing, list mutations, restart
// reconciliation, thumbnail derivation, the download plan, and the
// chrome.storage.local read/write contract.
//
// These are the rules behind "close the browser, restart the PC, and the list
// I clicked ☆ on is still there". No browser needed: the module under test is
// dependency-free (chrome.storage is only touched inside the storage
// functions, exercised here with a tiny in-memory stub — the same approach
// test/download-history.test.js uses).

const assert = require('assert');
const {
    BOOKMARK_QUEUE_KEY,
    MAX_PASTE_RANGE,
    emptyBookmarkState,
    normalizeBookmarkState,
    parseGalleryInput,
    thumbnailUrlFromGallery,
    titleFromGallery,
    pagesFromGallery,
    addBookmarks,
    removeBookmarks,
    clearBookmarks,
    setBookmarkSelected,
    setAllBookmarksSelected,
    setBookmarksCollapsed,
    patchBookmark,
    reconcileBookmarksAfterRestart,
    planBookmarkDownload,
    countBookmarks,
    countSelectedBookmarks,
    findBookmark,
    readBookmarks,
    mutateBookmarks,
    writeBookmarks,
    clearBookmarkStorage,
    resetBookmarkWriteChainForTests
} = require('../build/test/utils/bookmarkQueue.js');

// Tiny chrome.storage.local stub so the storage functions can run in Node.
function installChromeStub() {
    const store = {};
    const chrome = {
        runtime: { lastError: null },
        storage: {
            local: {
                get(defaults, cb) {
                    const out = Object.assign({}, defaults);
                    for (const key of Object.keys(store)) {
                        out[key] = store[key];
                    }
                    cb(out);
                },
                set(items, cb) {
                    Object.assign(store, items);
                    if (cb) cb();
                },
                remove(key, cb) {
                    delete store[key];
                    if (cb) cb();
                }
            }
        }
    };
    return { chrome, store };
}

describe('bookmark paste parsing', () => {
    it('reads bare ids separated by commas, spaces, newlines, semicolons and pipes', () => {
        const parsed = parseGalleryInput('366224, 177013\n415022;297974|353127');
        assert.deepStrictEqual(parsed.ids, ['366224', '177013', '415022', '297974', '353127']);
        assert.deepStrictEqual(parsed.rejected, []);
        assert.strictEqual(parsed.truncated, false);
    });

    it('reads the reference site\'s bulk url exactly as the user pastes it', () => {
        // The two ids from the request's example link.
        const parsed = parseGalleryInput('https://cin.lat/bulk?id=366224,177013');
        assert.deepStrictEqual(parsed.ids, ['366224', '177013']);
    });

    it('reads nhentai gallery urls, page urls and path-only urls', () => {
        assert.deepStrictEqual(
            parseGalleryInput('https://nhentai.net/g/366224/ /g/177013/1/ nhentai.net/g/415022').ids,
            ['366224', '177013', '415022']
        );
    });

    it('reads the reference site\'s viewer urls', () => {
        assert.deepStrictEqual(parseGalleryInput('https://cin.lat/v/366224').ids, ['366224']);
    });

    it('expands an inclusive range', () => {
        assert.deepStrictEqual(parseGalleryInput('366220-366224').ids,
            ['366220', '366221', '366222', '366223', '366224']);
    });

    it('caps a runaway range instead of building a monster list', () => {
        const parsed = parseGalleryInput('1-999999');
        assert.strictEqual(parsed.ids.length, MAX_PASTE_RANGE);
        assert.strictEqual(parsed.truncated, true);
        assert.strictEqual(parsed.ids[0], '1');
    });

    it('rejects a reversed range rather than guessing', () => {
        const parsed = parseGalleryInput('366224-366220');
        assert.deepStrictEqual(parsed.ids, []);
        assert.deepStrictEqual(parsed.rejected, ['366224-366220']);
    });

    it('collapses duplicates keeping the order first typed', () => {
        const parsed = parseGalleryInput('177013, 366224, 177013');
        assert.deepStrictEqual(parsed.ids, ['177013', '366224']);
    });

    it('names what it could not read instead of silently dropping it', () => {
        const parsed = parseGalleryInput('366224, not-a-gallery, https://example.com/x');
        assert.deepStrictEqual(parsed.ids, ['366224']);
        assert.deepStrictEqual(parsed.rejected, ['not-a-gallery', 'https://example.com/x']);
    });

    it('survives empty and nullish input', () => {
        assert.deepStrictEqual(parseGalleryInput('').ids, []);
        assert.deepStrictEqual(parseGalleryInput('   \n  ').ids, []);
        assert.deepStrictEqual(parseGalleryInput(undefined).ids, []);
        assert.deepStrictEqual(parseGalleryInput(null).ids, []);
    });

    it('strips the brackets and quotes people paste along with an id', () => {
        assert.deepStrictEqual(parseGalleryInput('[366224] "177013" (415022)').ids,
            ['366224', '177013', '415022']);
    });
});

describe('bookmark state normalization', () => {
    it('returns an empty state for anything unusable', () => {
        for (const raw of [null, undefined, 'nope', 42, []]) {
            const state = normalizeBookmarkState(raw);
            assert.deepStrictEqual(state.items, []);
            assert.strictEqual(state.collapsed, false);
        }
    });

    it('keeps valid rows and drops rows without a numeric id', () => {
        const state = normalizeBookmarkState({
            items: [
                { id: '366224', title: 'A', status: 'done', filename: 'NHDW/A.zip' },
                { id: 'nope', title: 'B' },
                { title: 'C' },
                null,
                'garbage'
            ]
        });
        assert.strictEqual(state.items.length, 1);
        assert.strictEqual(state.items[0].id, '366224');
        assert.strictEqual(state.items[0].status, 'done');
        assert.strictEqual(state.items[0].filename, 'NHDW/A.zip');
    });

    it('reads the legacy bare-array shape', () => {
        const state = normalizeBookmarkState([{ id: '366224' }, { id: '177013' }]);
        assert.deepStrictEqual(state.items.map((item) => item.id), ['366224', '177013']);
    });

    it('de-duplicates a corrupt list that names the same id twice', () => {
        const state = normalizeBookmarkState({ items: [{ id: '366224' }, { id: '366224', title: 'second' }] });
        assert.strictEqual(state.items.length, 1);
        // First occurrence wins: the older row is the one the user saw.
        assert.strictEqual(state.items[0].title, '');
    });

    it('falls back for unknown status and source values instead of throwing', () => {
        const state = normalizeBookmarkState({ items: [{ id: '366224', status: 'exploded', source: 'telepathy' }] });
        assert.strictEqual(state.items[0].status, 'saved');
        assert.strictEqual(state.items[0].source, 'card');
    });

    it('keeps the stored collapsed flag so the dock reopens the way it was left', () => {
        assert.strictEqual(normalizeBookmarkState({ items: [], collapsed: true }).collapsed, true);
        assert.strictEqual(normalizeBookmarkState({ items: [], collapsed: 'yes' }).collapsed, false);
    });
});

describe('bookmark list mutations', () => {
    it('adds newest-first and starts a new row ticked', () => {
        let state = emptyBookmarkState();
        state = addBookmarks(state, [{ id: '111', title: 'first' }], 1000).state;
        state = addBookmarks(state, [{ id: '222', title: 'second' }], 2000).state;
        assert.deepStrictEqual(state.items.map((item) => item.id), ['222', '111']);
        assert.strictEqual(state.items[0].selected, true);
        assert.strictEqual(state.items[0].addedAt, 2000);
        assert.strictEqual(state.items[0].status, 'saved');
    });

    it('never downgrades a row that is already bookmarked', () => {
        let state = emptyBookmarkState();
        state = addBookmarks(state, [{ id: '111', title: 'first' }]).state;
        state = patchBookmark(state, '111', { status: 'done', filename: 'NHDW/first.zip' });
        const result = addBookmarks(state, [{ id: '111', title: 'clicked again' }]);
        assert.deepStrictEqual(result.added, []);
        assert.deepStrictEqual(result.duplicates, ['111']);
        // Re-clicking ☆ on a card that already downloaded must not resurrect it.
        assert.strictEqual(result.state.items[0].status, 'done');
        assert.strictEqual(result.state.items[0].filename, 'NHDW/first.zip');
        assert.strictEqual(result.state.items[0].title, 'first');
    });

    it('ignores candidates without a numeric id', () => {
        const result = addBookmarks(emptyBookmarkState(), [{ id: '' }, { id: 'abc' }, null, { id: '366224' }]);
        assert.deepStrictEqual(result.added, ['366224']);
    });

    it('removes, clears and keeps the collapsed flag through both', () => {
        let state = addBookmarks(emptyBookmarkState(), [{ id: '111' }, { id: '222' }]).state;
        state = setBookmarksCollapsed(state, true);
        state = removeBookmarks(state, ['111']);
        assert.deepStrictEqual(state.items.map((item) => item.id), ['222']);
        assert.strictEqual(state.collapsed, true);
        state = clearBookmarks(state);
        assert.deepStrictEqual(state.items, []);
        assert.strictEqual(state.collapsed, true, 'clearing the list must not un-minimise the dock');
    });

    it('selects one, several and all', () => {
        let state = addBookmarks(emptyBookmarkState(), [{ id: '111' }, { id: '222' }, { id: '333' }]).state;
        state = setBookmarkSelected(state, ['222'], false);
        assert.deepStrictEqual(state.items.map((item) => item.selected), [true, false, true]);
        state = setAllBookmarksSelected(state, false);
        assert.strictEqual(countSelectedBookmarks(state), 0);
        state = setAllBookmarksSelected(state, true);
        assert.strictEqual(countSelectedBookmarks(state), 3);
    });

    it('ignores a patch for an id that is not in the list', () => {
        const state = addBookmarks(emptyBookmarkState(), [{ id: '111' }]).state;
        assert.strictEqual(patchBookmark(state, '999', { status: 'done' }), state,
            'an unknown id must not create a ghost row');
    });

    it('clears the error when a row leaves the failed state', () => {
        let state = addBookmarks(emptyBookmarkState(), [{ id: '111' }]).state;
        state = patchBookmark(state, '111', { status: 'failed', error: 'Cloudflare blocked it' });
        assert.strictEqual(state.items[0].error, 'Cloudflare blocked it');
        state = patchBookmark(state, '111', { status: 'downloading' });
        assert.strictEqual(state.items[0].error, '');
    });

    it('only overwrites title, thumbnail and pages with a real value', () => {
        let state = addBookmarks(emptyBookmarkState(), [{ id: '111', title: 'Known', pages: 71 }]).state;
        state = patchBookmark(state, '111', { title: '', thumbnail: '', pages: 0 });
        assert.strictEqual(state.items[0].title, 'Known');
        assert.strictEqual(state.items[0].pages, 71);
        state = patchBookmark(state, '111', { title: 'Better', thumbnail: 'https://t.nhentai.net/galleries/1/thumb.jpg' });
        assert.strictEqual(state.items[0].title, 'Better');
        assert.ok(state.items[0].thumbnail.indexOf('t.nhentai.net') !== -1);
    });

    it('counts and finds rows', () => {
        const state = addBookmarks(emptyBookmarkState(), [{ id: '111' }, { id: '222' }]).state;
        assert.strictEqual(countBookmarks(state), 2);
        assert.strictEqual(findBookmark(state, '222').id, '222');
        assert.strictEqual(findBookmark(state, 222).id, '222', 'a numeric id must match a stored string id');
        assert.strictEqual(findBookmark(state, '999'), null);
    });
});

describe('bookmark restart reconciliation', () => {
    function seeded() {
        let state = addBookmarks(emptyBookmarkState(), [
            { id: '111', title: 'pending' },
            { id: '222', title: 'in flight' },
            { id: '333', title: 'finished' },
            { id: '444', title: 'broken' }
        ]).state;
        state = patchBookmark(state, '222', { status: 'downloading' });
        state = patchBookmark(state, '333', { status: 'done', filename: 'NHDW/finished.zip' });
        state = patchBookmark(state, '444', { status: 'failed', error: 'image 12 failed' });
        return state;
    }

    it('returns an in-flight row to actionable after the worker comes back', () => {
        // The offscreen document that ran the job is gone; leaving the row
        // "downloading" would strand it forever.
        const next = reconcileBookmarksAfterRestart(seeded(), ['333']);
        assert.strictEqual(findBookmark(next, '222').status, 'saved');
        assert.strictEqual(findBookmark(next, '222').error, '');
    });

    it('keeps a finished row finished while the history still records it', () => {
        const next = reconcileBookmarksAfterRestart(seeded(), ['333']);
        assert.strictEqual(findBookmark(next, '333').status, 'done');
        assert.strictEqual(findBookmark(next, '333').filename, 'NHDW/finished.zip');
    });

    it('drops a finished row back when its history record was cleared', () => {
        const next = reconcileBookmarksAfterRestart(seeded(), []);
        assert.strictEqual(findBookmark(next, '333').status, 'saved');
        assert.strictEqual(findBookmark(next, '333').filename, '');
    });

    it('keeps the failure reason, which is the useful part of a failure', () => {
        const next = reconcileBookmarksAfterRestart(seeded(), ['333']);
        assert.strictEqual(findBookmark(next, '444').status, 'failed');
        assert.strictEqual(findBookmark(next, '444').error, 'image 12 failed');
    });

    it('leaves selection, order, thumbnails and the dock exactly as they were', () => {
        let state = seeded();
        state = setBookmarkSelected(state, ['111'], false);
        state = setBookmarksCollapsed(state, true);
        const next = reconcileBookmarksAfterRestart(state, ['333']);
        assert.deepStrictEqual(next.items.map((item) => item.id), state.items.map((item) => item.id));
        assert.strictEqual(findBookmark(next, '111').selected, false);
        assert.strictEqual(next.collapsed, true);
    });

    it('is a no-op (same object) when nothing needs fixing', () => {
        const state = addBookmarks(emptyBookmarkState(), [{ id: '111' }]).state;
        assert.strictEqual(reconcileBookmarksAfterRestart(state, []), state);
    });

    it('treats a missing history argument as "trust the stored status"', () => {
        const next = reconcileBookmarksAfterRestart(seeded());
        assert.strictEqual(findBookmark(next, '333').status, 'done');
        assert.strictEqual(findBookmark(next, '222').status, 'saved',
            'an in-flight row is still reset: no worker can be mid-job on a fresh read');
    });
});

describe('bookmark thumbnails and titles', () => {
    const gallery = {
        media_id: '4128713',
        title: { english: 'English title', japanese: 'Japanese title', pretty: 'Pretty title' },
        num_pages: 71,
        images: { pages: [{ t: 'j' }, { t: 'j' }], thumbnail: { t: 'j', w: 250, h: 350 } }
    };

    it('builds the cover thumbnail from media_id and the cover type code', () => {
        assert.strictEqual(thumbnailUrlFromGallery(gallery), 'https://t.nhentai.net/galleries/4128713/thumb.jpg');
    });

    it('maps every type code the parser can produce', () => {
        const codes = { j: 'jpg', p: 'png', g: 'gif', w: 'webp' };
        for (const code of Object.keys(codes)) {
            const url = thumbnailUrlFromGallery({ media_id: '9', images: { thumbnail: { t: code } } });
            assert.strictEqual(url, 'https://t.nhentai.net/galleries/9/thumb.' + codes[code]);
        }
    });

    it('falls back to the cover when there is no thumbnail entry', () => {
        const url = thumbnailUrlFromGallery({ media_id: '9', images: { cover: { t: 'p' } } });
        assert.strictEqual(url, 'https://t.nhentai.net/galleries/9/thumb.png');
    });

    it('returns an empty string rather than a broken url', () => {
        assert.strictEqual(thumbnailUrlFromGallery(null), '');
        assert.strictEqual(thumbnailUrlFromGallery({ images: { thumbnail: { t: 'j' } } }), '');
        assert.strictEqual(thumbnailUrlFromGallery({ media_id: 'not-numeric', images: { thumbnail: { t: 'j' } } }), '');
        assert.strictEqual(thumbnailUrlFromGallery({ media_id: '9', images: {} }), '');
        assert.strictEqual(thumbnailUrlFromGallery({ media_id: '9', images: { thumbnail: { t: 'x' } } }), '');
    });

    it('prefers pretty, then english, then japanese, then the id', () => {
        assert.strictEqual(titleFromGallery(gallery, '1'), 'Pretty title');
        assert.strictEqual(titleFromGallery({ title: { english: 'E', japanese: 'J' } }, '1'), 'E');
        assert.strictEqual(titleFromGallery({ title: { japanese: 'J' } }, '1'), 'J');
        assert.strictEqual(titleFromGallery({ title: {} }, '366224'), '(Non-titled) 366224');
        assert.strictEqual(titleFromGallery(null, '366224'), '(Non-titled) 366224');
    });

    it('reads the page count from num_pages, then the page array', () => {
        assert.strictEqual(pagesFromGallery(gallery), 71);
        assert.strictEqual(pagesFromGallery({ images: { pages: [{}, {}, {}] } }), 3);
        assert.strictEqual(pagesFromGallery(null), 0);
        assert.strictEqual(pagesFromGallery({}), 0);
    });
});

describe('bookmark download plan', () => {
    function seeded() {
        let state = addBookmarks(emptyBookmarkState(), [
            { id: '111', title: 'First' },
            { id: '222', title: 'Second' },
            { id: '333', title: '' }
        ]).state;
        return setBookmarkSelected(state, ['333'], false);
    }

    it('plans in list order, so reordering the list reorders the batch', () => {
        // addBookmarks is newest-first, so the seeded list reads 333, 222, 111
        // and 333 is unticked: the batch is 222 then 111, in list order.
        const state = seeded();
        assert.deepStrictEqual(state.items.map((item) => item.id), ['333', '222', '111']);
        const plan = planBookmarkDownload(state, []);
        assert.deepStrictEqual(plan.download, ['222', '111']);
    });

    it('skips what the history already records and says which', () => {
        const plan = planBookmarkDownload(seeded(), ['111']);
        assert.deepStrictEqual(plan.download, ['222']);
        assert.deepStrictEqual(plan.skip, ['111']);
    });

    it('lets an explicit re-download override the skip', () => {
        const plan = planBookmarkDownload(seeded(), ['111'], ['111']);
        assert.deepStrictEqual(plan.download, ['222', '111']);
        assert.deepStrictEqual(plan.skip, []);
    });

    it('never plans an unticked row', () => {
        const plan = planBookmarkDownload(seeded(), []);
        assert.ok(plan.download.indexOf('333') === -1);
        assert.ok(!Object.prototype.hasOwnProperty.call(plan.titles, '333'));
    });

    it('falls back to the id as the display title when the row never learned one', () => {
        const state = setBookmarkSelected(addBookmarks(emptyBookmarkState(), [{ id: '333', title: '' }]).state, ['333'], true);
        const plan = planBookmarkDownload(state, []);
        assert.strictEqual(plan.titles['333'], '333');
    });

    it('produces the id->title map shape downloadAllDoujinshis expects', () => {
        const plan = planBookmarkDownload(seeded(), []);
        assert.deepStrictEqual(plan.titles, { '111': 'First', '222': 'Second' });
    });
});

describe('bookmark storage contract (chrome.storage.local)', () => {
    let chromeStub;

    beforeEach(() => {
        chromeStub = installChromeStub();
        global.chrome = chromeStub.chrome;
        resetBookmarkWriteChainForTests();
    });

    afterEach(() => {
        delete global.chrome;
        resetBookmarkWriteChainForTests();
    });

    it('reads an empty state when nothing was ever stored', async () => {
        const state = await readBookmarks();
        assert.deepStrictEqual(state.items, []);
        assert.strictEqual(state.collapsed, false);
    });

    it('persists under its own key and never touches the download history', async () => {
        await writeBookmarks(addBookmarks(emptyBookmarkState(), [{ id: '366224', title: 'Kept' }]).state);
        assert.ok(Object.prototype.hasOwnProperty.call(chromeStub.store, BOOKMARK_QUEUE_KEY));
        assert.deepStrictEqual(Object.keys(chromeStub.store), [BOOKMARK_QUEUE_KEY]);
        const reread = await readBookmarks();
        assert.strictEqual(reread.items[0].title, 'Kept');
    });

    it('serializes overlapping mutations so neither clobbers the other', async () => {
        await writeBookmarks(addBookmarks(emptyBookmarkState(), [{ id: '111' }]).state);
        // Fired together, not awaited in order: this is what a card click
        // landing while the panel removes a row actually looks like.
        await Promise.all([
            mutateBookmarks((state) => addBookmarks(state, [{ id: '222' }]).state),
            mutateBookmarks((state) => addBookmarks(state, [{ id: '333' }]).state)
        ]);
        const ids = (await readBookmarks()).items.map((item) => item.id).sort();
        assert.deepStrictEqual(ids, ['111', '222', '333'], 'both mutations must survive');
    });

    it('survives a corrupt stored value instead of throwing in the panel', async () => {
        chromeStub.store[BOOKMARK_QUEUE_KEY] = 'garbage';
        const state = await readBookmarks();
        assert.deepStrictEqual(state.items, []);
    });

    it('clears only its own key', async () => {
        chromeStub.store.downloadHistory = { '111': { filename: 'a.zip', when: 1 } };
        await writeBookmarks(addBookmarks(emptyBookmarkState(), [{ id: '111' }]).state);
        await clearBookmarkStorage();
        assert.ok(!Object.prototype.hasOwnProperty.call(chromeStub.store, BOOKMARK_QUEUE_KEY));
        assert.ok(Object.prototype.hasOwnProperty.call(chromeStub.store, 'downloadHistory'),
            'clearing bookmarks must never clear the download history');
    });

    it('works with no chrome object at all (never throws)', async () => {
        delete global.chrome;
        const state = await readBookmarks();
        assert.deepStrictEqual(state.items, []);
    });
});
