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
        for (const key of ['permissions', 'optional_host_permissions', 'host_permissions', 'background', 'action', 'side_panel', 'content_scripts', 'options_ui']) {
            assert.deepStrictEqual(releaseManifest[key], sourceManifest[key], `release manifest ${key} differs from source`);
        }
    });

    it('keeps the extension version in sync between source and release', () => {
        assert.strictEqual(releaseManifest.version, sourceManifest.version,
            'release manifest version differs from source');
    });

    it('hardens CDN host access without <all_urls>: static hosts plus an optional nhentai-only grant', () => {
        for (const manifest of [sourceManifest, releaseManifest]) {
            // The chrome.permissions API is available to every MV3 extension
            // WITHOUT being declared; only optional_host_permissions must be
            // listed. Declaring a literal "permissions" permission is invalid
            // and makes Chrome refuse to load the extension
            // ("Permission 'permissions' is unknown").
            assert.ok(!manifest.permissions.includes('permissions'),
                'manifest must not declare the invalid "permissions" permission');

            // Optional hosts: HTTPS, nhentai-owned only, no wildcards beyond *.nhentai.net.
            const optional = manifest.optional_host_permissions || [];
            assert.ok(optional.length > 0, 'optional_host_permissions must exist for dynamic CDN hosts');
            for (const pattern of optional) {
                assert.ok(!pattern.includes('<all_urls>') && pattern !== '*://*/*',
                    'optional_host_permissions must never contain <all_urls>');
                assert.ok(/^https:\/\/(?:\*\.)?[a-z0-9-]*\*?\.nhentai\.net\/\*$/.test(pattern),
                    'optional host patterns must be https and nhentai-scoped: ' + pattern);
            }

            // Static hosts: unchanged known mirrors, no broadening.
            for (const pattern of manifest.host_permissions) {
                assert.ok(/^https:\/\/(?:[a-z0-9*-]+\.)?nhentai\.net\/\*$/.test(pattern),
                    'host_permissions must stay https nhentai-scoped: ' + pattern);
                assert.ok(!pattern.includes('<all_urls>'), 'host_permissions must not contain <all_urls>');
            }
        }
    });

    it('declares only valid, Chrome-recognized permissions (unknown names break extension loading)', () => {
        // Chrome rejects the entire manifest if any declared permission is not
        // a recognized name (e.g. "Permission 'foo' is unknown"), so guard the
        // full list against typos / invalid entries.
        const VALID = new Set([
            'downloads', 'tabs', 'storage', 'alarms', 'scripting', 'offscreen',
            'activeTab', 'notifications', 'contextMenus', 'cookies', 'identity',
            'unlimitedStorage', 'webNavigation', 'webRequest', 'declarativeNetRequest',
            'declarativeNetRequestWithHostAccess', 'management', 'privacy', 'idle',
            'sidePanel', 'favicon', 'search'
        ]);
        for (const manifest of [sourceManifest, releaseManifest]) {
            for (const permission of manifest.permissions) {
                assert.ok(VALID.has(permission),
                    'unknown permission "' + permission + '" would make Chrome refuse to load the extension');
            }
        }
    });

    it('ships the side panel as a first-class UI with the popup kept as fallback', () => {
        // The panel and the popup render the SAME document: one rendered view,
        // no duplicated markup. A settings toggle (uiMode) decides which one a
        // toolbar click opens at runtime via chrome.sidePanel.setPanelBehavior
        // / chrome.action.setPopup.
        for (const manifest of [sourceManifest, releaseManifest]) {
            assert.ok(manifest.permissions.includes('sidePanel'),
                'sidePanel permission is required for chrome.sidePanel');
            assert.ok(manifest.side_panel && manifest.side_panel.default_path === 'index.html',
                'side_panel.default_path must point at the shared popup document');
            assert.strictEqual(manifest.action.default_popup, 'index.html',
                'the popup fallback must stay declared so users can switch back to it');
        }
    });

    it('injects the in-page listing card controls alongside the legacy checkbox script', () => {
        for (const manifest of [sourceManifest, releaseManifest]) {
            const scripts = manifest.content_scripts[0].js;
            assert.ok(scripts.includes('js/content.js'), 'legacy caption checkbox script must stay');
            assert.ok(scripts.includes('js/listControls.js'),
                'in-page Download/Select card controls must be injected on listing pages');
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

    it('does not expose every extension file to arbitrary sites via web_accessible_resources', () => {
        for (const manifest of [sourceManifest, releaseManifest]) {
            const entries = manifest.web_accessible_resources || [];
            for (const entry of entries) {
                assert.ok(!entry.matches.includes('<all_urls>'),
                    'web_accessible_resources must not match <all_urls> (it would expose every bundled file to any page)');
                assert.ok(!entry.resources.includes('*'),
                    'web_accessible_resources must not expose all extension files');
            }
        }
        assert.deepStrictEqual(releaseManifest.web_accessible_resources, sourceManifest.web_accessible_resources,
            'release web_accessible_resources differs from source');
    });

    it('background bundle uses root-relative toolbar icon paths', () => {
        const bundle = fs.readFileSync(path.join(__dirname, '..', 'js', 'background.js'), 'utf8');
        assert.ok(bundle.includes('/Icon.png'), 'built worker must fetch /Icon.png from the extension root');
        assert.ok(bundle.includes('/Icon-grey.png'), 'built worker must fetch /Icon-grey.png from the extension root');
        assert.ok(!/setIcon\(\{path:"Icon(?:-grey)?\.png"\}/.test(bundle),
            'relative Icon.png paths resolve to js/Icon.png and fail to fetch in MV3');
    });
});
