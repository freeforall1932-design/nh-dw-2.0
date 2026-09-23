// Items 41, 43, 44 and 52 — the pure contracts behind the four small wins:
//
//   * 41: isCanonicalTemplate — when may the checkbox builder be offered at all
//   * 43: bookmarkTogglePresentation — the panel toggle's shared words/classes
//   * 44: moveBookmark — drag-reorder, which is just array order
//   * 52: queueTransfer — the backup file format, and the merge policy that
//         decides what an import may and may not touch
//
// No browser: every module here is chrome-free and DOM-free at import time.

const assert = require('assert');
const {
    TEMPLATE_TOKENS,
    templateTokensInUse,
    isTokenOnlyTemplate,
    isCanonicalTemplate,
    buildTemplate
} = require('../build/test/options/nameTemplate.js');
const {
    emptyBookmarkState,
    normalizeBookmarkState,
    addBookmarks,
    moveBookmark,
    bookmarkTogglePresentation,
    planBookmarkDownload
} = require('../build/test/utils/bookmarkQueue.js');
const {
    TRANSFER_APP_ID,
    TRANSFER_VERSION,
    buildTransferPayload,
    serializeTransfer,
    parseTransferPayload,
    mergeImportedBookmarks,
    mergeImportedHistory
} = require('../build/test/utils/queueTransfer.js');

// addBookmarks UNshifts (newly bookmarked rows go to the top), so a test that
// cares about ORDER builds the state from an explicit row list instead.
function orderedState(rows) {
    return normalizeBookmarkState({
        v: 1,
        collapsed: false,
        items: rows.map((row) => ({
            id: row.id,
            site: row.site,
            title: 'Title ' + row.id,
            selected: true,
            status: 'saved'
        }))
    });
}

function stateWith(ids) {
    let state = emptyBookmarkState();
    for (const id of ids) {
        state = addBookmarks(state, [{ id: id, title: 'Title ' + id, source: 'paste' }]).state;
    }
    return state;
}

describe('item 41 — the odd-separator gate', () => {
    it('accepts exactly what the checkbox builder emits', () => {
        assert.strictEqual(isCanonicalTemplate('{pretty}'), true);
        assert.strictEqual(isCanonicalTemplate('{pretty} - {id}'), true);
        assert.strictEqual(isCanonicalTemplate('{pretty} - {id} - {artist} - {language}'), true);
        assert.strictEqual(isCanonicalTemplate(''), true);
    });

    it('rejects a token-only template whose separator or spacing the tick boxes would rewrite', () => {
        // The 41 report: isTokenOnlyTemplate said yes, and the first tick
        // silently rewrote the separator.
        assert.strictEqual(isTokenOnlyTemplate('{pretty}_{id}'), true);
        assert.strictEqual(isCanonicalTemplate('{pretty}_{id}'), false);
        assert.strictEqual(isCanonicalTemplate('{pretty} {id}'), false);
        assert.strictEqual(isCanonicalTemplate('{pretty} -  {id}'), false);
        assert.strictEqual(isCanonicalTemplate('{pretty} - {id} '), false);
    });

    it('rejects out-of-order tokens and custom templates', () => {
        assert.strictEqual(isTokenOnlyTemplate('{id} - {pretty}'), true);
        assert.strictEqual(isCanonicalTemplate('{id} - {pretty}'), false);
        assert.strictEqual(isCanonicalTemplate('My gallery {id}'), false);
    });

    it('agrees with buildTemplate for every token subset it accepts', () => {
        // The gate exists to protect this identity: rebuilding a template the
        // gate accepted must produce that same template, character for
        // character — otherwise a tick could still change the user's setting.
        for (const token of TEMPLATE_TOKENS) {
            const template = buildTemplate({ [token]: true });
            assert.strictEqual(isCanonicalTemplate(template), true, template);
            assert.strictEqual(buildTemplate(templateTokensInUse(template)), template);
        }
    });
});

describe('item 43 — the shared bookmark toggle presentation', () => {
    it('names the two states the same way on every surface', () => {
        assert.deepStrictEqual(
            { label: bookmarkTogglePresentation(true).label, title: bookmarkTogglePresentation(false).label },
            { label: 'Bookmarked', title: 'Bookmark' });
    });

    it('carries the on-state class only when bookmarked', () => {
        assert.strictEqual(bookmarkTogglePresentation(false).className, 'nhdwBookmarkToggle');
        assert.ok(bookmarkTogglePresentation(true).className.split(' ').includes('nhdwBookmarkOn'));
        assert.ok(!bookmarkTogglePresentation(false).className.split(' ').includes('nhdwBookmarkOn'));
    });
});

describe('item 44 — drag-reorder is array order', () => {
    const three = () => orderedState([{ id: '1' }, { id: '2' }, { id: '3' }]);

    it('moves a row to a later position', () => {
        const moved = moveBookmark(three(), '1', 2);
        assert.deepStrictEqual(moved.items.map((item) => item.id), ['2', '3', '1']);
    });

    it('moves a row to an earlier position', () => {
        const moved = moveBookmark(three(), '3', 0);
        assert.deepStrictEqual(moved.items.map((item) => item.id), ['3', '1', '2']);
    });

    it('clamps out-of-range targets instead of dropping the row', () => {
        assert.deepStrictEqual(moveBookmark(three(), '1', 99).items.map((item) => item.id), ['2', '3', '1']);
        assert.deepStrictEqual(moveBookmark(three(), '3', -5).items.map((item) => item.id), ['3', '1', '2']);
    });

    it('returns the SAME state for a no-op or an unknown id (so callers can skip a re-render)', () => {
        const state = orderedState([{ id: '1' }, { id: '2' }]);
        assert.strictEqual(moveBookmark(state, '1', 0), state);
        assert.strictEqual(moveBookmark(state, 'nope', 1), state);
        // A fractional target floors into range: that is a drop between two
        // rows, which is a real move and not a no-op.
        assert.deepStrictEqual(moveBookmark(state, '1', 1.4).items.map((item) => item.id), ['2', '1']);
    });

    it('is the order the queue downloads in', () => {
        // The whole point of the affordance: reordering changes the batch order.
        const moved = moveBookmark(three(), '3', 0);
        const plan = planBookmarkDownload(moved, []);
        assert.deepStrictEqual(plan.download, ['3', '1', '2']);
    });

    it('accepts composite keys, so a multi-site row is draggable too', () => {
        const state = orderedState([{ id: '1', site: 'nhentai' }, { id: '1', site: 'hitomi' }, { id: '2', site: 'nhentai' }]);
        const moved = moveBookmark(state, 'hitomi:1', 2);
        assert.deepStrictEqual(moved.items.map((item) => item.site + ':' + item.id), ['nhentai:1', 'nhentai:2', 'hitomi:1']);
    });
});

describe('item 52 — backup file format', () => {
    const bookmarks = stateWith(['1', '2']);
    const history = { 'nhentai:1': { filename: 'one.zip', when: 1700000000000 } };

    it('writes a self-describing, human-readable file', () => {
        const payload = buildTransferPayload(bookmarks, history, new Date(1700000000000));
        assert.strictEqual(payload.app, TRANSFER_APP_ID);
        assert.strictEqual(payload.version, TRANSFER_VERSION);
        assert.strictEqual(payload.exportedAt, '2023-11-14T22:13:20.000Z');
        assert.strictEqual(payload.bookmarkCount, 2);
        assert.strictEqual(payload.historyCount, 1);
        const text = serializeTransfer(payload);
        assert.ok(text.indexOf('\n') !== -1, 'the file is pretty-printed for humans');
        assert.deepStrictEqual(JSON.parse(text).bookmarks.items.map((item) => item.id), bookmarks.items.map((item) => item.id));
    });

    it('round-trips: export -> parse returns the same rows', () => {
        const text = serializeTransfer(buildTransferPayload(bookmarks, history));
        const parsed = parseTransferPayload(text);
        assert.strictEqual(parsed.ok, true);
        assert.deepStrictEqual(parsed.bookmarks.items.map((item) => item.id), bookmarks.items.map((item) => item.id));
        assert.deepStrictEqual(parsed.history, history);
    });

    it('rejects what it cannot safely read, with a reason', () => {
        assert.strictEqual(parseTransferPayload('').ok, false);
        assert.strictEqual(parseTransferPayload('not json').ok, false);
        assert.strictEqual(parseTransferPayload('[1,2,3]').ok, false);
        assert.strictEqual(parseTransferPayload(JSON.stringify({ app: 'something-else', bookmarks: bookmarks })).ok, false);
        assert.strictEqual(parseTransferPayload(JSON.stringify({ version: 99, bookmarks: bookmarks })).ok, false);
        assert.strictEqual(parseTransferPayload(JSON.stringify({ bookmarks: { v: 1, items: [] } })).ok, false,
            'a file with nothing in it is an error, not a silent no-op');
        for (const bad of ['', 'not json', '[1,2,3]']) {
            assert.ok(typeof parseTransferPayload(bad).error === 'string' && parseTransferPayload(bad).error.length > 0);
        }
    });

    it('accepts a bare bookmark state or a bare history map (hand-made files)', () => {
        const bare = parseTransferPayload(JSON.stringify(bookmarks));
        assert.strictEqual(bare.ok, true);
        assert.strictEqual(bare.bookmarks.items.length, 2);

        const historyOnly = parseTransferPayload(JSON.stringify({ history: history }));
        assert.strictEqual(historyOnly.ok, true);
        assert.deepStrictEqual(historyOnly.history, history);
    });

    it('drops unusable rows instead of failing the whole file', () => {
        const parsed = parseTransferPayload(JSON.stringify({
            app: TRANSFER_APP_ID,
            version: 1,
            bookmarks: { v: 1, items: [{ id: '1' }, { id: 'not-a-number' }, { id: '2', site: 'hitomi' }] },
            history: { 'nhentai:1': { filename: 'one.zip', when: 5 }, nonsense: 'nope' }
        }));
        assert.strictEqual(parsed.ok, true);
        assert.deepStrictEqual(parsed.bookmarks.items.map((item) => item.id), ['1', '2']);
        assert.strictEqual(Object.keys(parsed.history).length, 1);
    });
});

describe('item 52 — import merges and never deletes', () => {
    it('adds only the rows the profile does not have, appended (the current order is the download order)', () => {
        const local = orderedState([{ id: '1' }, { id: '2' }]);
        const imported = orderedState([{ id: '2' }, { id: '3' }]);
        const merged = mergeImportedBookmarks(local, imported);
        assert.deepStrictEqual(merged.items.map((item) => item.id), ['1', '2', '3']);
    });

    it('keeps the LOCAL row for a gallery both sides have', () => {
        const local = normalizeBookmarkState({ v: 1, items: [{ id: '1', title: 'Local', status: 'done', filename: 'mine.zip', selected: false }] });
        const imported = normalizeBookmarkState({ v: 1, items: [{ id: '1', title: 'Imported', status: 'saved', filename: '', selected: true }] });
        const merged = mergeImportedBookmarks(local, imported);
        assert.strictEqual(merged.items.length, 1);
        assert.strictEqual(merged.items[0].filename, 'mine.zip');
        assert.strictEqual(merged.items[0].status, 'done');
        assert.strictEqual(merged.items[0].selected, false);
    });

    it('treats the same numeric id on two sites as two different rows', () => {
        const local = normalizeBookmarkState({ v: 1, items: [{ id: '1', site: 'nhentai' }] });
        const imported = normalizeBookmarkState({ v: 1, items: [{ id: '1', site: 'hitomi' }] });
        assert.strictEqual(mergeImportedBookmarks(local, imported).items.length, 2);
    });

    it('changes nothing when the file adds nothing, and never shortens the list', () => {
        const local = orderedState([{ id: '1' }, { id: '2' }]);
        // Structural, not reference: normalization returns a fresh object, and
        // nothing in the pipeline depends on identity.
        assert.deepStrictEqual(mergeImportedBookmarks(local, orderedState([{ id: '1' }])), local);
        assert.strictEqual(mergeImportedBookmarks(local, emptyBookmarkState()).items.length, 2);
    });

    it('keeps the local history record and adds missing keys only', () => {
        const local = { 'nhentai:1': { filename: 'mine.zip', when: 10 } };
        const imported = { 'nhentai:1': { filename: 'theirs.zip', when: 99 }, 'nhentai:2': { filename: 'two.zip', when: 5 } };
        const merged = mergeImportedHistory(local, imported);
        assert.strictEqual(Object.keys(merged).length, 2);
        assert.strictEqual(merged['nhentai:1'].filename, 'mine.zip', 'the local record wins');
        assert.strictEqual(merged['nhentai:1'].when, 10);
        assert.strictEqual(merged['nhentai:2'].filename, 'two.zip');
        assert.strictEqual(merged['nhentai:2'].when, 5, 'the imported file keeps its own timestamp');
    });

    it('normalizes bare legacy keys on the way in, so a hand-made file cannot create a duplicate', () => {
        const merged = mergeImportedHistory({ 'nhentai:1': { filename: 'mine.zip', when: 10 } }, { '1': { filename: 'theirs.zip', when: 99 } });
        assert.strictEqual(Object.keys(merged).length, 1);
        assert.strictEqual(merged['nhentai:1'].filename, 'mine.zip');
    });

    it('an empty import is a no-op in both directions', () => {
        const local = orderedState([{ id: '1' }]);
        assert.deepStrictEqual(mergeImportedHistory({}, {}), {});
        assert.deepStrictEqual(mergeImportedBookmarks(local, emptyBookmarkState()), local);
    });
});
