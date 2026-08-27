// Unit tests for the name-template checkbox helpers (nameTemplate.ts).
// The stored format stays a placeholder string ("{pretty} - {id}"), so the
// download engine and old saved templates are unaffected.

const assert = require('assert');
const { TEMPLATE_TOKENS, templateTokensInUse, isTokenOnlyTemplate, buildTemplate } =
    require('../build/test/options/nameTemplate.js');

describe('name template checkboxes', () => {
    it('detects the tokens used by a stored template', () => {
        const inUse = templateTokensInUse('{pretty} - {id}');
        assert.strictEqual(inUse.pretty, true);
        assert.strictEqual(inUse.id, true);
        assert.strictEqual(inUse.english, false);
        assert.strictEqual(inUse.language, false);
    });

    it('detects the default template ({pretty}) as pretty-only', () => {
        const inUse = templateTokensInUse('{pretty}');
        assert.strictEqual(inUse.pretty, true);
        for (const token of TEMPLATE_TOKENS) {
            if (token !== 'pretty') assert.strictEqual(inUse[token], false);
        }
    });

    it('rebuilds a template from checked boxes in canonical order', () => {
        const template = buildTemplate({ id: true, pretty: true, artist: true });
        assert.strictEqual(template, '{pretty} - {id} - {artist}');
    });

    it('supports a custom separator', () => {
        assert.strictEqual(buildTemplate({ pretty: true, id: true }, ' '), '{pretty} {id}');
    });

    it('returns an empty template when nothing is checked (engine falls back to the gallery id)', () => {
        assert.strictEqual(buildTemplate({}), '');
    });

    it('treats token-only templates (with simple separators) as checkbox-representable', () => {
        assert.strictEqual(isTokenOnlyTemplate('{pretty}'), true);
        assert.strictEqual(isTokenOnlyTemplate('{pretty} - {id}'), true);
        assert.strictEqual(isTokenOnlyTemplate('{pretty} {id} ({language})'), true);
        assert.strictEqual(isTokenOnlyTemplate(''), true);
    });

    it('flags custom templates so the manual input is kept as fallback', () => {
        assert.strictEqual(isTokenOnlyTemplate('My gallery {id}'), false);
        assert.strictEqual(isTokenOnlyTemplate('{pretty}_custom'), false);
    });

    it('round-trips: template -> checkboxes -> template', () => {
        const original = '{pretty} - {id} - {artist} - {language}';
        const rebuilt = buildTemplate(templateTokensInUse(original));
        assert.strictEqual(rebuilt, original);
    });
});
