// Manifest regression tests for MV3 permissions and release/source parity.
// No browser is needed; these catch missing permissions that only fail when
// the packed extension is loaded in Chrome/Brave.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8'));
}

describe('MV3 manifest', () => {
    const sourceManifest = readJson('NHDW_Extension_v3.0.0/manifest.json');
    const releaseManifest = readJson('NHDW_Release_v3.0.0/manifest.json');

    it('requests the offscreen permission required for the ZIP object-URL download path', () => {
        assert.strictEqual(sourceManifest.manifest_version, 3);
        assert.ok(sourceManifest.permissions.includes('offscreen'), 'source manifest must include permissions.offscreen');
        assert.ok(releaseManifest.permissions.includes('offscreen'), 'release manifest must include permissions.offscreen');
    });

    it('keeps source and release manifests in sync for runtime-critical fields', () => {
        for (const key of ['permissions', 'host_permissions', 'background', 'action', 'content_scripts', 'options_ui']) {
            assert.deepStrictEqual(releaseManifest[key], sourceManifest[key], `release manifest ${key} differs from source`);
        }
    });

    it('declares default_icon so the toolbar has an icon before setIcon runs', () => {
        assert.strictEqual(sourceManifest.action.default_icon['64'], 'Icon.png');
        assert.strictEqual(sourceManifest.action.default_icon['128'], 'Icon.png');
        assert.deepStrictEqual(releaseManifest.action.default_icon, sourceManifest.action.default_icon);
    });

    it('ships the color and grey toolbar icons next to the manifest', () => {
        const root = path.join(__dirname, '..');
        const releaseRoot = path.join(__dirname, '..', '..', 'NHDW_Release_v3.0.0');
        for (const name of ['Icon.png', 'Icon-grey.png']) {
            assert.ok(fs.existsSync(path.join(root, name)), 'missing ' + name + ' in the source package');
            assert.ok(fs.existsSync(path.join(releaseRoot, name)), 'missing ' + name + ' in the release package');
        }
    });

    it('background bundle uses root-relative toolbar icon paths', () => {
        const bundle = fs.readFileSync(path.join(__dirname, '..', 'js', 'background.js'), 'utf8');
        assert.ok(bundle.includes('/Icon.png'), 'built worker must fetch /Icon.png from the extension root');
        assert.ok(bundle.includes('/Icon-grey.png'), 'built worker must fetch /Icon-grey.png from the extension root');
        assert.ok(!/setIcon\(\{path:"Icon(?:-grey)?\.png"\}/.test(bundle),
            'relative Icon.png paths resolve to js/Icon.png and fail to fetch in MV3');
    });
});
