// React Router "single fetch" page data (`<path>.data`, turbo-stream v2) as a
// chapter page-list source, plus the built-in Tailspace recipe.
// Fixtures in test/fixtures/tailspace/ were produced by the official
// turbo-stream 2.4.1 encoder (MIT; the format react-router 7 bundles) from
// SYNTHETIC data shaped like keiyoushi's Tailspace DTOs. No live site.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { URL: NodeURL } = require('url');
const {
    decodeTurboStream, routeLoaderData, singleFetchDataUrl, hasRouterContext,
    routeDataImageUrls, routeDataPageRefs, routeDataRecipeFor, walkSeries
} = require('../build/test/utils/routeData.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'tailspace', name), 'utf8');
const COMIC = 'routes/pages/comic/ComicPage';

describe('React Router page data (turbo-stream) as a chapter source', () => {
    const previous = globalThis.URL;
    before(() => { globalThis.URL = NodeURL; });
    after(() => { globalThis.URL = previous; });

    describe('decodeTurboStream', () => {
        it('decodes real encoder output: shared references, dates, maps, deferred lines, special numbers', () => {
            const decoded = decodeTurboStream(fixture('comic-101.data'));
            const loaders = routeLoaderData(decoded);
            assert.deepStrictEqual(Object.keys(loaders).sort(), ['root', COMIC]);
            const data = loaders[COMIC];
            assert.strictEqual(data.comic.id, 101);
            assert.strictEqual(data.comic.slug, 'Scale Train');
            // pageNumber 2 is stored once and shared with thumbnailVersion.
            assert.strictEqual(data.comic.thumbnailVersion, 2);
            assert.deepStrictEqual(data.comic.pages.map(p => [p.token, p.pageNumber, p.fileType]),
                [['b2', 2, 'png'], ['a1', 1, undefined], ['c3', 3, 'webp']]);
            assert.strictEqual(data.comic.published, Date.UTC(2026, 9, 1), 'dates become epoch milliseconds');
            assert.strictEqual(data.comic.previousComic, null);
            assert.strictEqual(data.comic.nextComic.slug, 'Scale Train 2');
            assert.strictEqual(data.comic.tags[0].name, 'dragon');
            assert.ok(Number.isNaN(data.ratio));
            assert.strictEqual(data.missing, undefined);
            assert.strictEqual(loaders.root.flags.beta, true, 'maps become plain objects');
            // The promise resolved on the later "P67:" line.
            assert.strictEqual(data.related[0].slug, 'Other');
        });

        it('keeps objects prototype-free so page data cannot pollute Object.prototype', () => {
            const decoded = decodeTurboStream('[{"_1":2},"__proto__",{"_3":4},"polluted",true]');
            assert.strictEqual(({}).polluted, undefined);
            assert.strictEqual(Object.getPrototypeOf(decoded), null);
        });

        it('handles holes, a primitive root, cycles and react-router plugin types', () => {
            const holey = decodeTurboStream('[[1,-1,2],"a","b"]');
            assert.strictEqual(holey.length, 3);
            assert.strictEqual(holey[0], 'a');
            assert.ok(!(1 in holey), 'a hole stays a hole');
            assert.strictEqual(holey[2], 'b');
            assert.strictEqual(decodeTurboStream('-5'), null);
            const cyclic = decodeTurboStream('[{"_1":0}, "self"]');
            assert.strictEqual(cyclic.self, cyclic);
            const plugin = decodeTurboStream('[{"_1":2,"_3":4},"a",["SingleFetchClassInstance",5],"b",["SanitizedError",6],{"_7":8},"x","k",1]');
            assert.deepStrictEqual(JSON.parse(JSON.stringify(plugin.a)), { k: 1 });
            assert.strictEqual(plugin.b, null, 'errors carry no page data');
            assert.strictEqual(decodeTurboStream('[["E","boom","Error"]]'), null);
            assert.strictEqual(decodeTurboStream('[{"_1":2},"later",["P",0]]').later, undefined, 'an unresolved deferred value is undefined');
            assert.strictEqual(decodeTurboStream('[{"_1":2},"gone",["P",3]]\nE3:-5').gone, null, 'a rejected deferred value is null');
        });

        it('refuses what is not turbo-stream instead of guessing', () => {
            for (const bad of ['', '<!doctype html><html></html>', '{"a":1}', '[]', '[{"_1":9}]', '[{"x":1}]', '[1]\nQ1:[2]', '[1]\nP1:{"a":1}']) {
                assert.throws(() => decodeTurboStream(bad), err => err.code === 'format', JSON.stringify(bad));
            }
            assert.throws(() => decodeTurboStream('[' + new Array(260000).fill('0').join(',') + ']'), err => err.code === 'format', 'value cap');
        });
    });

    describe('singleFetchDataUrl / hasRouterContext', () => {
        it('builds the URL exactly like react-router (root, trailing slash, routes, query)', () => {
            assert.strictEqual(singleFetchDataUrl('https://tailspace.com/c/Scale%20Train?page=3#x', ['a/b'], false).href,
                'https://tailspace.com/c/Scale%20Train.data?_routes=a%2Fb');
            assert.strictEqual(singleFetchDataUrl('https://reader.example/', null, true).href, 'https://reader.example/_root.data');
            assert.strictEqual(singleFetchDataUrl('https://reader.example/read/9/?lang=en&_routes=x', null, true).href,
                'https://reader.example/read/9.data?lang=en');
            assert.strictEqual(singleFetchDataUrl('http://reader.example/read/9', null, true), null, 'HTTPS only');
            assert.strictEqual(singleFetchDataUrl('https://127.0.0.1/read/9', null, true), null, 'public hosts only');
        });
        it('recognises a React Router / Remix server render', () => {
            assert.ok(hasRouterContext('<script>window.__reactRouterContext = {"basename":"/"};</script>'));
            assert.ok(hasRouterContext('window.__remixContext = {}'));
            assert.ok(!hasRouterContext('<script id="__NEXT_DATA__"></script>'));
        });
    });

    describe('generic page lists (no recipe)', () => {
        it('finds the one unambiguous URL list', () => {
            const loaders = routeLoaderData(decodeTurboStream(fixture('generic-reader.data')));
            assert.deepStrictEqual(routeDataImageUrls(loaders), ['https://cdn.reader.example/9/1.jpg', 'https://cdn.reader.example/9/2.png']);
        });
        it('returns nothing when two different lists compete, and never walks into card lists', () => {
            assert.deepStrictEqual(routeDataImageUrls({ r: { a: { images: ['https://x.example/1.jpg'] }, b: { images: ['https://x.example/2.jpg'] } } }), []);
            assert.deepStrictEqual(routeDataImageUrls({ r: { related: [{ images: ['https://x.example/t.jpg'] }] } }), []);
            // Tailspace's own pages are token objects, not URLs: no generic match.
            assert.deepStrictEqual(routeDataImageUrls(routeLoaderData(decodeTurboStream(fixture('comic-101.data')))), []);
        });
        it('makes page references all or nothing', () => {
            const chapter = 'https://reader.example/read/9';
            assert.strictEqual(routeDataPageRefs(['https://cdn.example/1.jpg', '/2.jpg'], chapter)[1].url, 'https://reader.example/2.jpg');
            assert.deepStrictEqual(routeDataPageRefs(['https://cdn.example/1.jpg', 'javascript:alert(1)'], chapter), []);
            assert.deepStrictEqual(routeDataPageRefs(['https://cdn.example/1.jpg#frag'], chapter), []);
            assert.deepStrictEqual(routeDataPageRefs(null, chapter), []);
            assert.throws(() => routeDataPageRefs(['https://cdn.example/1.jpg'], 'http://reader.example/'), err => err.code === 'url');
        });
    });

    describe('Tailspace recipe (facts from keiyoushi/extensions-source, Apache-2.0)', () => {
        const recipe = routeDataRecipeFor('https://tailspace.com');
        const loadersOf = id => routeLoaderData(decodeTurboStream(fixture('comic-' + id + '.data')));

        it('answers only for the exact origin', () => {
            assert.ok(recipe);
            assert.strictEqual(routeDataRecipeFor('https://TAILSPACE.com'), recipe);
            for (const other of ['http://tailspace.com', 'https://evil.tailspace.com.example', 'https://reader.example', '']) {
                assert.strictEqual(routeDataRecipeFor(other), null, other);
            }
            assert.strictEqual(recipe.chapterRoute, COMIC);
        });

        it('recognises chapter paths and round-trips slugs with spaces', () => {
            assert.strictEqual(recipe.chapterSlug('/c/Scale%20Train'), 'Scale Train');
            assert.strictEqual(recipe.chapterSlug('/c/Scale%20Train/'), 'Scale Train');
            for (const other of ['/', '/browse', '/c/', '/c/a/b', '/u/Scale']) assert.strictEqual(recipe.chapterSlug(other), null, other);
            assert.strictEqual(recipe.chapterUrl('https://tailspace.com', 'Scale Train'), 'https://tailspace.com/c/Scale%20Train');
        });

        it('builds full-size URLs in page-number order with the default jpg', () => {
            const pages = recipe.pages(loadersOf(101)[COMIC]);
            assert.deepStrictEqual(pages, [
                'https://pics.tailspace.com/comics/101/a1.jpg',
                'https://pics.tailspace.com/comics/101/b2.png',
                'https://pics.tailspace.com/comics/101/c3.webp'
            ]);
            const refs = routeDataPageRefs(pages, 'https://tailspace.com/c/Scale%20Train');
            assert.deepStrictEqual(Array.from(new Set(refs.map(r => r.host))), ['pics.tailspace.com']);
        });

        it('refuses the whole list on any unexpected page entry', () => {
            const good = { comic: { id: 5, pages: [{ token: 'abc', pageNumber: 1 }] } };
            assert.deepStrictEqual(recipe.pages(good), ['https://pics.tailspace.com/comics/5/abc.jpg']);
            const variants = [
                { comic: { id: 5, pages: [{ token: '../x', pageNumber: 1 }] } },
                { comic: { id: 5, pages: [{ token: 'a/b', pageNumber: 1 }] } },
                { comic: { id: 5, pages: [{ token: 'abc', pageNumber: 1, fileType: 'svg' }] } },
                { comic: { id: 5, pages: [{ token: 'abc' }] } },
                { comic: { id: '5', pages: [{ token: 'abc', pageNumber: 1 }] } },
                { comic: { id: 0, pages: [{ token: 'abc', pageNumber: 1 }] } },
                { comic: { id: 5, pages: [] } },
                { comic: null }, null
            ];
            for (const data of variants) assert.strictEqual(recipe.pages(data), null, JSON.stringify(data));
        });

        it('reads the total the site states, ignoring nonsense, and flags the referrer expectation', () => {
            assert.strictEqual(recipe.advertised(loadersOf(101)[COMIC]), 3);
            assert.strictEqual(recipe.advertised(loadersOf(103)[COMIC]), 3, 'part 3 states 3 while listing 2 (fixture mismatch)');
            assert.strictEqual(recipe.pages(loadersOf(103)[COMIC]).length, 2);
            for (const bad of [0, -1, 1.5, '3', 100000, null]) assert.strictEqual(recipe.advertised({ comic: { numberOfPages: bad } }), null, String(bad));
            assert.strictEqual(recipe.imagesExpectReferrer, true);
        });

        it('reads the series links of a part', () => {
            assert.deepStrictEqual(recipe.part(loadersOf(102)[COMIC]),
                { slug: 'Scale Train 2', name: 'Scale Train - Chapter 2', previous: 'Scale Train', next: 'Scale Train 3' });
            assert.strictEqual(recipe.part({ comic: { slug: 'a/b' } }), null);
        });

        it('walks a series from its middle part, oldest first', async () => {
            const bySlug = {};
            for (const id of [101, 102, 103]) { const part = recipe.part(loadersOf(id)[COMIC]); bySlug[part.slug] = part; }
            const asked = [];
            const walk = await walkSeries(bySlug['Scale Train 2'], async slug => { asked.push(slug); return bySlug[slug] || null; });
            assert.deepStrictEqual(walk.parts.map(p => p.name), ['Scale Train - Chapter 1', 'Scale Train - Chapter 2', 'Scale Train - Chapter 3']);
            assert.deepStrictEqual(asked, ['Scale Train', 'Scale Train 3'], 'each part is requested once');
            assert.strictEqual(walk.truncated, false);
            assert.strictEqual(walk.broken, false);
        });

        it('stops on loops, missing parts and the chapter cap', async () => {
            const loop = { a: { slug: 'a', name: 'A', previous: null, next: 'b' }, b: { slug: 'b', name: 'B', previous: 'a', next: 'a' } };
            const looped = await walkSeries(loop.a, async slug => loop[slug]);
            assert.deepStrictEqual(looped.parts.map(p => p.slug), ['a', 'b']);
            const broken = await walkSeries({ slug: 'a', name: 'A', previous: null, next: 'zz' }, async () => null);
            assert.strictEqual(broken.broken, true);
            assert.strictEqual(broken.parts.length, 1);
            const chain = slug => ({ slug, name: slug, previous: null, next: String(Number(slug) + 1) });
            const capped = await walkSeries(chain('1'), async slug => chain(slug), 5);
            assert.strictEqual(capped.parts.length, 5);
            assert.strictEqual(capped.truncated, true);
        });
    });
});
