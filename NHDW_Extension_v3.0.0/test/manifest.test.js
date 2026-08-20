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
});
