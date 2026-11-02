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
        for (const file of ['index.html', 'chapters.html', 'options.html', 'offscreen.html', 'Icon.png',
            'Icon-grey.png', 'THIRD_PARTY_NOTICES.txt', 'css/chapters.css', 'css/content.css',
            'js/background.js', 'js/preview.js', 'js/chapters.js', 'js/universalChapterProbe.js']) {
            assert.ok(paths.includes(file), 'missing ' + file);
        }
        // Icon-crow-*.png ride beside Icon.png as owner-requested comparison
        // candidates (ASSET_PLAN.md family 1: rename to compare in a live
        // extension, no rebuild).
        assert.ok(paths.every((file) => /^(?:css|js|assets)\/|^(?:manifest\.json|index\.html|chapters\.html|options\.html|offscreen\.html|Icon(?:-grey|-crow-[a-z-]+)?\.png|LICENSE|THIRD_PARTY_NOTICES\.txt)$/.test(file)),
            'a non-runtime file slipped into the release');
        assert.ok(!paths.some((file) => /\.(?:map|ts)$/.test(file)));
    });

    it('ships third-party notices for every library bundled into the builds', () => {
        // The probe and the chapter page bundle htmlparser2/css-select (BSD-2,
        // ISC and MIT code); a distributed build must carry their notices.
        // terser does not emit a LICENSE.txt for those, so this file is the
        // only notice and must stay in the package.
        const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        for (const name of ['jszip', 'pako', 'htmlparser2', 'domhandler', 'domutils',
            'domelementtype', 'entities', 'dom-serializer', 'css-select', 'css-what',
            'nth-check', 'boolbase']) {
            assert.ok(notices.includes('\n' + name + ' ') || notices.includes('\n' + name + '\n'),
                'THIRD_PARTY_NOTICES.txt must name ' + name);
        }
        assert.ok(collectRuntimeFiles(ROOT).includes('THIRD_PARTY_NOTICES.txt'),
            'the notices must be part of the packaged runtime');
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
