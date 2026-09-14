// Composite gallery keys (siteKeys.ts, item 47): the "<site>:<id>" identity
// that keeps every persistent store collision-proof once a second site
// arrives. Pure module, no browser needed.
//
// The contract pinned here:
//  * A bare id means the default site ("nhentai") — that is the 3.7.0
//    pipeline's id space, unchanged.
//  * An id that already contains ":" is composite and passes through — so
//    the same helper is safe on both sides of every comparison.
//  * Site slugs normalize to lowercase; a slug containing ":" is invalid and
//    falls back to the default site.

const assert = require('assert');
const {
    GALLERY_KEY_SEPARATOR,
    DEFAULT_SITE,
    normalizeSite,
    composeGalleryKey,
    toGalleryKey,
    splitGalleryKey
} = require('../build/test/utils/siteKeys.js');

describe('site keys (item 47)', () => {
    it('defaults to the nhentai site', () => {
        assert.strictEqual(DEFAULT_SITE, 'nhentai');
        assert.strictEqual(GALLERY_KEY_SEPARATOR, ':');
    });

    it('composes "<site>:<id>" with the default site when none is given', () => {
        assert.strictEqual(composeGalleryKey(undefined, '366224'), 'nhentai:366224');
        assert.strictEqual(composeGalleryKey(null, '366224'), 'nhentai:366224');
        assert.strictEqual(composeGalleryKey('', '366224'), 'nhentai:366224');
        assert.strictEqual(composeGalleryKey('hitomi', '1234'), 'hitomi:1234');
    });

    it('yields "" for an empty id so callers can skip it', () => {
        assert.strictEqual(composeGalleryKey('nhentai', ''), '');
        assert.strictEqual(composeGalleryKey('nhentai', undefined), '');
        assert.strictEqual(toGalleryKey(''), '');
        assert.strictEqual(toGalleryKey(undefined), '');
    });

    it('toGalleryKey prefixes bare ids with the default site', () => {
        assert.strictEqual(toGalleryKey('366224'), 'nhentai:366224');
        assert.strictEqual(toGalleryKey(366224), 'nhentai:366224');
        assert.strictEqual(toGalleryKey(' 366224 '), 'nhentai:366224');
    });

    it('toGalleryKey passes composite ids through unchanged (no double prefix)', () => {
        assert.strictEqual(toGalleryKey('nhentai:366224'), 'nhentai:366224');
        assert.strictEqual(toGalleryKey('hitomi:1234'), 'hitomi:1234');
    });

    it('toGalleryKey honours an explicit site for a bare id', () => {
        assert.strictEqual(toGalleryKey('1234', 'hitomi'), 'hitomi:1234');
        // An explicit site never overrides an already-composite id.
        assert.strictEqual(toGalleryKey('hitomi:1234', 'nhentai'), 'hitomi:1234');
    });

    it('normalizeSite lowercases, defaults on empty, rejects separator slugs', () => {
        assert.strictEqual(normalizeSite('Hitomi'), 'hitomi');
        assert.strictEqual(normalizeSite(' nhentai '), 'nhentai');
        assert.strictEqual(normalizeSite(''), 'nhentai');
        assert.strictEqual(normalizeSite(undefined), 'nhentai');
        // A slug carrying ":" could not be told apart from a composite key.
        assert.strictEqual(normalizeSite('bad:slug'), 'nhentai');
    });

    it('splitGalleryKey answers bare legacy keys as the default site', () => {
        assert.deepStrictEqual(splitGalleryKey('nhentai:366224'), { site: 'nhentai', id: '366224' });
        assert.deepStrictEqual(splitGalleryKey('hitomi:1234'), { site: 'hitomi', id: '1234' });
        assert.deepStrictEqual(splitGalleryKey('366224'), { site: 'nhentai', id: '366224' });
        assert.deepStrictEqual(splitGalleryKey(''), { site: 'nhentai', id: '' });
    });

    it('keeps two same-numbered ids from different sites distinct', () => {
        // The collision the composite keys exist to prevent (item 47):
        // nhentai #366224 and another site's #366224 are different galleries.
        const a = toGalleryKey('366224');
        const b = toGalleryKey('366224', 'hitomi');
        assert.notStrictEqual(a, b);
        assert.strictEqual(splitGalleryKey(a).site, 'nhentai');
        assert.strictEqual(splitGalleryKey(b).site, 'hitomi');
    });
});
