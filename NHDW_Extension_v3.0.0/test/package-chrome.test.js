// A generated release archive must contain ONLY the single Chrome tree's
// runtime files. The old checked-in release folder is not a second authority.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { collectRuntimeFiles, createArchive } = require('../scripts/package-chrome');
const ROOT = path.join(__dirname, '..');

describe('one Chrome runtime tree / generated release', () => {
    it('lists only runtime assets, never tooling, sources or screenshots', () => {
        const paths = collectRuntimeFiles(ROOT);
        assert.ok(paths.includes('manifest.json'));
        for (const file of ['index.html', 'options.html', 'offscreen.html', 'Icon.png',
            'Icon-grey.png', 'css/content.css', 'js/background.js', 'js/preview.js']) {
            assert.ok(paths.includes(file), 'missing ' + file);
        }
        assert.ok(paths.every((file) => /^(?:css|js|assets)\/|^(?:manifest\.json|index\.html|options\.html|offscreen\.html|Icon(?:-grey)?\.png|LICENSE)$/.test(file)),
            'a non-runtime file slipped into the release');
        assert.ok(!paths.some((file) => /\.(?:map|ts)$/.test(file)));
    });

    it('generates a self-contained ZIP with byte-identical runtime files', async () => {
        const archive = await JSZip.loadAsync(await createArchive(ROOT));
        const files = Object.keys(archive.files).filter((file) => !archive.files[file].dir).sort();
        assert.deepStrictEqual(files, collectRuntimeFiles(ROOT));
        for (const name of files) {
            const bytes = await archive.file(name).async('nodebuffer');
            assert.ok(bytes.equals(fs.readFileSync(path.join(ROOT, name))), 'stale or altered ' + name);
        }
        assert.strictEqual(JSON.parse(await archive.file('manifest.json').async('string')).version,
            require('../manifest.json').version);
    });
});
