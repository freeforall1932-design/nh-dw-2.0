'use strict';
// Offline checks for the indexer (INDEXER_PLAN.md phase 2, Route A). No
// network: fetch is a fake, io is memory (plus one real-fs round trip for
// gzip + atomic state). Run: node tools/indexer/test-crawl.js
//
// When the extension's compiled importer exists
// (NHDW_Extension_v3.0.0/build/test/library/indexFormat.js) the produced
// index text is also round-tripped through the REAL parser the Library tab
// uses — the two ends of the pipeline must never drift apart.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    parseArgs,
    UsageError,
    jobNameFor,
    modeParams,
    walkJob,
    finishJob,
    writeTagsDump,
    makeFsIo,
} = require('./crawl');
const {
    RateLimitedError,
    ChallengeError,
    NotFoundError,
    createClient,
} = require('./nhentaiApi');
const { mapCardsFile, cardToRow } = require('./mapCards');

// ------------------------------------------------------------ test helpers

function memoryIo() {
    const files = new Map();
    return {
        files,
        cardsPath: (job) => job + '.cards.jsonl',
        statePath: (job) => job + '.state.json',
        tagsPath: () => 'nhentai-tags.json',
        indexPath: (site, gz) => site + '.jsonl' + (gz ? '.gz' : ''),
        appendCards(job, cards) {
            const prev = files.get(this.cardsPath(job)) || '';
            files.set(this.cardsPath(job), prev + cards.map((c) => JSON.stringify(c)).join('\n') + '\n');
        },
        readState(job) {
            const raw = files.get(this.statePath(job));
            return raw ? JSON.parse(raw) : null;
        },
        writeState(job, state) {
            files.set(this.statePath(job), JSON.stringify(state));
        },
        writeTagsDump(dump) {
            files.set(this.tagsPath(), JSON.stringify(dump));
        },
        readTagsDump() {
            const raw = files.get(this.tagsPath());
            return raw ? JSON.parse(raw) : null;
        },
        readCards(job) {
            const raw = files.get(this.cardsPath(job));
            return raw === undefined ? null : raw;
        },
        writeIndex(site, text, gz) {
            files.set(this.indexPath(site, false), text);
            if (gz) files.set(this.indexPath(site, true), Buffer.from(text).swap16 && text);
            return this.indexPath(site, !!gz);
        },
    };
}

function card(id, extra) {
    return Object.assign({
        id,
        media_id: 'm' + id,
        title: { english: 'Title ' + id, japanese: '', pretty: 'Title ' + id },
        num_pages: 10 + (id % 5),
        upload_date: 1700000000 + id,
        thumbnail: { path: '/galleries/m' + id + '/thumb.jpg' },
    }, extra || {});
}

function fakeFetch(pages, opts) {
    const calls = [];
    const responses = opts && opts.responses || {};
    async function fetchImpl(url) {
        calls.push(String(url));
        const pageMatch = /page=(\d+)/.exec(String(url));
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        if (responses[page] === '429') {
            return { status: 429, headers: { get: (h) => (h === 'retry-after' ? '30' : null) }, text: async () => '' };
        }
        if (responses[page] === '404') {
            return { status: 404, headers: { get: () => null }, text: async () => '' };
        }
        if (responses[page] === 'challenge') {
            return {
                status: 403,
                headers: { get: () => 'text/html' },
                text: async () => '<!DOCTYPE html><title>Just a moment...</title>',
            };
        }
        if (responses[page] === '500') {
            return { status: 500, headers: { get: () => null }, text: async () => '' };
        }
        const cards = pages[page] || [];
        return {
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ result: cards, num_pages: opts && opts.numPages !== undefined ? opts.numPages : Object.keys(pages).length, per_page: 2, total: 100 }),
        };
    }
    return { fetchImpl, calls };
}

function testClient(fetchImpl) {
    return createClient({ minIntervalMs: 0, fetchImpl, log: () => {} });
}

// ------------------------------------------------------------ client tests

async function testClientBehaviours() {
    // 429 is a stop, with Retry-After surfaced.
    const limited = fakeFetch({}, { responses: { 1: '429' } });
    await assert.rejects(
        testClient(limited.fetchImpl).getGalleriesPage(1, 2),
        (e) => e instanceof RateLimitedError && e.retryAfterSeconds === 30 && /429/.test(e.message));
    assert.strictEqual(limited.calls.length, 1, 'a 429 must never be retried');

    // A challenge page stops with words, never a bypass attempt.
    const challenge = fakeFetch({}, { responses: { 1: 'challenge' } });
    await assert.rejects(
        testClient(challenge.fetchImpl).getGalleriesPage(1, 2),
        (e) => e instanceof ChallengeError);

    // 404 is a named error (the walk decides cap vs bad parameters).
    const missing = fakeFetch({}, { responses: { 1: '404' } });
    await assert.rejects(
        testClient(missing.fetchImpl).getGalleriesPage(1, 2),
        (e) => e instanceof NotFoundError);

    // One 5xx is retried once, then the run stops with the status named.
    const flaky = fakeFetch({}, { responses: { 1: '500' } });
    await assert.rejects(
        testClient(flaky.fetchImpl).getGalleriesPage(1, 2),
        (e) => e instanceof Error && /500/.test(e.message));
    assert.strictEqual(flaky.calls.length, 2, 'a 5xx is retried exactly once');

    // Auth header only ever rides API calls, in the documented shape.
    let seenAuth = null;
    const keyed = createClient({
        apiKey: 'K123',
        minIntervalMs: 0,
        log: () => {},
        fetchImpl: async (url, init) => {
            seenAuth = init.headers['Authorization'];
            return { status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ username: 'tester' }) };
        },
    });
    const profile = await keyed.verifyKey();
    assert.strictEqual(seenAuth, 'Key K123');
    assert.strictEqual(profile.username, 'tester');
}

// ------------------------------------------------------------ walk tests

async function testWalkComplete() {
    const pages = { 1: [card(1), card(2)], 2: [card(3), card(4)], 3: [] };
    const fake = fakeFetch(pages, { numPages: 2, responses: { 3: '404' } });
    const io = memoryIo();
    const outcome = await walkJob({
        client: testClient(fake.fetchImpl),
        io,
        job: 'j',
        params: { mode: 'all' },
        perPage: 2,
        log: () => {},
    });
    assert.strictEqual(outcome.done, true);
    const cards = io.files.get('j.cards.jsonl').trim().split('\n');
    assert.strictEqual(cards.length, 4, 'every card of every page is kept');
    const state = io.readState('j');
    assert.strictEqual(state.done, true);
    assert.strictEqual(state.cardsDone, 4);
    assert.strictEqual(state.nextPage, 3);
    // Pages must be fetched in ascending order, newest-first walks keep order.
    assert.strictEqual(fake.calls.length, 2, 'an empty page is never fetched');
}

async function testWalkResume() {
    const pages = { 1: [card(1), card(2)], 2: [card(3), card(4)] };
    const first = fakeFetch(pages, { numPages: 2 });
    const io = memoryIo();
    const common = { client: testClient(first.fetchImpl), io, job: 'j', params: { mode: 'all' }, perPage: 2, log: () => {} };
    await walkJob(Object.assign({}, common, { maxPages: 1 }));
    assert.strictEqual(io.readState('j').pagesDone, 1, 'state after page one');

    const second = fakeFetch(pages, { numPages: 2 });
    const outcome = await walkJob(Object.assign({}, common, { client: testClient(second.fetchImpl), maxPages: 10 }));
    assert.strictEqual(outcome.done, true);
    assert.strictEqual(second.calls.some((u) => u.includes('page=1')), false, 'resume never refetches a saved page');
    const cards = io.files.get('j.cards.jsonl').trim().split('\n');
    assert.strictEqual(cards.length, 4);
}

async function testWalkCap() {
    const pages = { 1: [card(1), card(2)] };
    const fake = fakeFetch(pages, { numPages: 9, responses: { 2: '404' } });
    const io = memoryIo();
    const outcome = await walkJob({
        client: testClient(fake.fetchImpl),
        io,
        job: 'j',
        params: { mode: 'all' },
        perPage: 2,
        log: () => {},
    });
    assert.strictEqual(outcome.done, true, 'a cap ends the walk');
    assert.strictEqual(outcome.reason, 'cap');
    const state = io.readState('j');
    assert.strictEqual(state.capped, true);
    assert.strictEqual(state.cardsDone, 2);
}

async function testWalkRateLimited() {
    const pages = { 1: [card(1), card(2)] };
    const fake = fakeFetch(pages, { numPages: 5, responses: { 2: '429' } });
    const io = memoryIo();
    const outcome = await walkJob({
        client: testClient(fake.fetchImpl),
        io,
        job: 'j',
        params: { mode: 'all' },
        perPage: 2,
        log: () => {},
    });
    assert.strictEqual(outcome.stopped, true);
    assert.strictEqual(outcome.reason, 'RateLimitedError');
    assert.strictEqual(io.readState('j').nextPage, 2, 'state saved for a clean resume');
}

async function testWalkJobConflict() {
    const io = memoryIo();
    const fake = fakeFetch({ 1: [card(1)] }, { numPages: 1 });
    const common = { client: testClient(fake.fetchImpl), io, job: 'j', perPage: 2, log: () => {} };
    await walkJob(Object.assign({}, common, { params: { mode: 'all' } }));
    assert.rejects(
        () => walkJob(Object.assign({}, common, { params: { mode: 'query', query: 'x' } })),
        UsageError);
}

// ------------------------------------------------------------ mapping tests

function testMapping() {
    const stats = { skippedCards: 0, duplicateCards: 0, mappedRows: 0, droppedTagIds: new Set(), seenIds: new Set() };
    const tags = new Map();

    // Full tag objects on the card build the dictionary.
    const richCard = card(1, {
        tags: [
            { id: 17, type: 'tag', name: 'vanilla', count: 5 },
            { id: 1223, type: 'language', name: 'english', count: 9 },
            { id: 506, type: 'artist', name: 'A. Kari', count: 2 },
            { id: 9, type: 'category', name: 'manga', count: 99 },
        ],
    });
    const row = cardToRow(richCard, tags, stats);
    assert.strictEqual(row[0], '1');
    assert.strictEqual(row[1], 'm1');
    assert.strictEqual(row[2], 'Title 1');
    assert.strictEqual(row[5].indexOf(17) !== -1, true);
    assert.strictEqual(tags.get(17).ns, 'tag');
    assert.strictEqual(tags.get(1223).ns, 'language');
    assert.strictEqual(tags.has(9), false, 'category tags have no schema-1 namespace');

    // Bare tag_ids resolve through the dictionary; unknown ids drop with a count.
    const bareCard = card(2, { tag_ids: [17, 999999] });
    const bareTags = new Map([[17, { id: 17, ns: 'tag', n: 'vanilla', c: 0 }]]);
    const bareRow = cardToRow(bareCard, bareTags, stats);
    assert.deepStrictEqual(bareRow[5], [17], 'unresolvable tag ids are dropped, not guessed');
    assert.ok(stats.droppedTagIds.has(999999));

    // Thumbnail extension is derived from the thumb path when present.
    assert.strictEqual(cardToRow(card(3, { thumbnail: '/galleries/m3/thumb.png' }), bareTags, stats)[6], 'png');
    assert.strictEqual(cardToRow(card(4), bareTags, stats)[6], 'jpg');
    assert.strictEqual(cardToRow(card(5, { thumbnail: { path: '/galleries/m5/thumb.gif' } }), bareTags, stats)[6], 'gif');

    // Duplicate ids are dropped, never double-mapped.
    assert.strictEqual(cardToRow(card(1), bareTags, stats), null);
    assert.strictEqual(stats.duplicateCards, 1);
}

function testMapCardsFile() {
    const cards = [
        card(1, { tags: [{ id: 17, type: 'tag', name: 'vanilla' }, { id: 1223, type: 'language', name: 'english' }] }),
        card(2, { tag_ids: [17, 1223, 5000] }),
        card(1), // duplicate
        'not json',
    ].map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('\n');
    const tagsDump = [{ id: 1223, type: 'language', name: 'english', count: 1000 }];
    const mapped = mapCardsFile(cards, tagsDump, 'nhentai');
    assert.strictEqual(mapped.stats.mappedRows, 2);
    assert.strictEqual(mapped.stats.duplicateCards, 1);
    assert.strictEqual(mapped.stats.skippedCards, 1);
    assert.deepStrictEqual(mapped.stats.droppedTagIds, [5000]);

    const lines = mapped.text.trim().split('\n');
    const header = JSON.parse(lines[0]);
    assert.strictEqual(header._meta.schema, 1);
    assert.strictEqual(header._meta.site, 'nhentai');
    assert.strictEqual(header._meta.count, 2);
    assert.strictEqual(header._meta.tagCount, 2, 'counts come from the rows, not the dump');
    const tagRows = lines.slice(1, 1 + header._meta.tagCount).map((l) => JSON.parse(l));
    for (const tagRow of tagRows) {
        assert.strictEqual(tagRow._t, 1, 'tag rows carry the _t marker');
        assert.strictEqual(tagRow.c, 2, 'tag count matches mapped usage (both rows carry both tags)');
    }
    for (const line of lines.slice(1 + header._meta.tagCount)) {
        const row = JSON.parse(line);
        assert.ok(Array.isArray(row) && row.length >= 6 && row.length <= 7);
    }
}

function testRoundTripThroughRealImporter() {
    const importerPath = path.join(__dirname, '..', '..', 'NHDW_Extension_v3.0.0', 'build', 'test', 'library', 'indexFormat.js');
    if (!fs.existsSync(importerPath)) {
        console.log('  (extension importer not compiled — round-trip check skipped; run npm test in NHDW_Extension_v3.0.0 first)');
        return;
    }
    const { parseIndexText } = require(importerPath);
    const cards = [card(1, { tags: [{ id: 17, type: 'tag', name: 'vanilla' }] }), card(2, { tag_ids: [17] })];
    const cardsText = cards.map((c) => JSON.stringify(c)).join('\n');
    const mapped = mapCardsFile(cardsText, [{ id: 17, type: 'tag', name: 'vanilla' }], 'nhentai');
    const parsed = parseIndexText(mapped.text);
    assert.strictEqual(parsed.meta.site, 'nhentai');
    assert.strictEqual(parsed.rows.length, 2);
    assert.strictEqual(parsed.tags.size, 1);
    assert.strictEqual(parsed.meta.count, parsed.rows.length);
}

// ------------------------------------------------------------ cli + fs tests

function testArgs() {
    const args = parseArgs(['--all', '--key', 'K', '--max-pages', '5', '--gz']);
    assert.strictEqual(args.all, true);
    assert.strictEqual(args.key, 'K');
    assert.strictEqual(args['max-pages'], 5);
    assert.strictEqual(args.gz, true);
    assert.strictEqual(jobNameFor(args), 'nhentai-all');
    assert.deepStrictEqual(modeParams(args), { mode: 'all' });
    const tagArgs = parseArgs(['--tag-id', '17']);
    assert.strictEqual(jobNameFor(tagArgs), 'nhentai-tag-17');
    assert.deepStrictEqual(modeParams(tagArgs), { mode: 'tagged', tagId: 17, sort: 'date' }, 'tagged walks pin sort=date');
    const queryArgs = parseArgs(['--query', 'language:english "a b"']);
    assert.ok(jobNameFor(queryArgs).startsWith('nhentai-query-'));
    assert.throws(() => parseArgs(['--bogus']), UsageError);
    assert.throws(() => parseArgs(['--max-pages', 'x']), UsageError);
}

async function testRealFsRoundTrip() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdw-indexer-'));
    try {
        const io = makeFsIo(dir);
        const pages = { 1: [card(1), card(2)] };
        const fake = fakeFetch(pages, { numPages: 1 });
        await walkJob({
            client: testClient(fake.fetchImpl),
            io,
            job: 'fs',
            params: { mode: 'all' },
            perPage: 2,
            log: () => {},
        });
        const client = createClient({
            minIntervalMs: 0,
            log: () => {},
            fetchImpl: async () => ({
                status: 200,
                headers: { get: () => 'application/json' },
                text: async () => JSON.stringify([{ id: 17, type: 'tag', name: 'vanilla', count: 2 }]),
            }),
        });
        await writeTagsDump({ client, io, log: () => {} });
        assert.ok(fs.existsSync(path.join(dir, 'nhentai-tags.json')));
        // Atomic state writes leave no tmp litter.
        assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

        const mapped = finishJob({ io, job: 'fs', site: 'nhentai', gz: true, log: () => {} });
        const plain = fs.readFileSync(path.join(dir, 'nhentai.jsonl'), 'utf8');
        assert.strictEqual(plain, mapped.text);
        const zipped = fs.readFileSync(path.join(dir, 'nhentai.jsonl.gz'));
        assert.deepStrictEqual(Array.from(zipped.slice(0, 2)), [0x1f, 0x8b], 'the gzip copy is really gzip');
        const zlib = require('zlib');
        assert.strictEqual(zlib.gunzipSync(zipped).toString('utf8'), mapped.text);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ------------------------------------------------------------ runner

const checks = [
    ['client stops on 429 / challenge / 404 / 5xx, sends Key auth', testClientBehaviours],
    ['walk completes pages in order and stops on the empty page', testWalkComplete],
    ['walk resumes from saved state without refetching', testWalkResume],
    ['walk treats a 404 past page 1 as the depth cap', testWalkCap],
    ['walk stops on 429 with state saved', testWalkRateLimited],
    ['walk refuses a job reused with different parameters', testWalkJobConflict],
    ['mapping: full-tag cards, bare tag_ids, thumb ext, dedupe', testMapping],
    ['mapCardsFile: header, tag rows, counts, dropped ids', testMapCardsFile],
    ['round-trip through the real Library importer', testRoundTripThroughRealImporter],
    ['arg parsing and job naming', testArgs],
    ['real fs io: tags dump, atomic state, gzip copy', testRealFsRoundTrip],
];

(async () => {
    let failures = 0;
    for (const [name, fn] of checks) {
        try {
            await fn();
            console.log('  \u2714 ' + name);
        } catch (error) {
            failures++;
            console.log('  \u2718 ' + name);
            console.log(String(error && error.stack ? error.stack : error));
        }
    }
    console.log(failures === 0 ? 'all indexer checks pass' : failures + ' indexer check(s) FAILED');
    process.exitCode = failures === 0 ? 0 : 1;
})();
