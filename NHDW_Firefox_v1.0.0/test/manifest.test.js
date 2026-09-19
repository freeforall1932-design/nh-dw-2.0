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
        for (const key of ['permissions', 'optional_host_permissions', 'host_permissions', 'background', 'action', 'content_scripts', 'options_ui']) {
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

// Firefox manifest: Firefox-for-Android compatibility guards. These are the
// fields whose absence breaks loading on Firefox/Firefox-for-Android rather
// than Chrome, mirroring the MV3 guards above.
describe('Firefox manifest (Android-ready)', () => {
    const firefoxManifest = readJson('NHDW_Firefox_v1.0.0/manifest.json');
    const firefoxRoot = path.join(__dirname, '..');

    it('defines browser_specific_settings.gecko.id (required for signing + stable storage)', () => {
        const gecko = firefoxManifest.browser_specific_settings && firefoxManifest.browser_specific_settings.gecko;
        assert.ok(gecko, 'browser_specific_settings.gecko missing');
        assert.ok(typeof gecko.id === 'string' && gecko.id.includes('@'),
            'gecko.id must be an add-on id (email or GUID): ' + gecko.id);
    });

    it('pins strict_min_version >= 142.0 (data-collection declaration floor on desktop AND Android)', () => {
        const gecko = firefoxManifest.browser_specific_settings.gecko;
        const major = parseInt(String(gecko.strict_min_version).split('.')[0], 10);
        assert.ok(Number.isFinite(major) && major >= 142,
            'strict_min_version must be >= 142.0 (data_collection_permissions floor), got ' + gecko.strict_min_version);
    });

    it('declares data_collection_permissions (required for new AMO listings since Nov 2025)', () => {
        const gecko = firefoxManifest.browser_specific_settings.gecko;
        assert.deepStrictEqual(gecko.data_collection_permissions, { required: ['none'] },
            'extension collects no personal data; the declaration must say so');
    });

    it('runs the background as an event page (Firefox has no MV3 service workers)', () => {
        assert.strictEqual(firefoxManifest.manifest_version, 3);
        assert.ok(Array.isArray(firefoxManifest.background.scripts) && firefoxManifest.background.scripts.length > 0,
            'background.scripts must list the event page bundle');
        assert.ok(firefoxManifest.background.service_worker === undefined,
            'background.service_worker must not be set for Firefox');
    });

    it('does not request the Chromium-only offscreen permission', () => {
        assert.ok(!firefoxManifest.permissions.includes('offscreen'),
            'offscreen permission is Chromium-only and must not ship to Firefox');
    });

    it('declares mobile icon sizes next to desktop ones', () => {
        for (const size of ['48', '64', '96', '128']) {
            assert.ok(firefoxManifest.icons[size], 'icons.' + size + ' missing');
            assert.ok(fs.existsSync(path.join(firefoxRoot, firefoxManifest.icons[size])),
                'declared icon missing on disk: ' + firefoxManifest.icons[size]);
        }
    });

    it('ships a mobile viewport meta in popup and options pages', () => {
        for (const page of ['index.html', 'options.html']) {
            const html = fs.readFileSync(path.join(firefoxRoot, page), 'utf8');
            assert.ok(/<meta[^>]+name="viewport"[^>]+content="width=device-width/.test(html),
                page + ' must declare a device-width viewport meta (Firefox for Android opens these in a tab)');
        }
    });

    it('keeps host permissions https and nhentai-scoped (same hardening as Chrome)', () => {
        for (const pattern of firefoxManifest.host_permissions) {
            assert.ok(/^https:\/\/(?:[a-z0-9*-]+\.)?nhentai\.net\/\*$/.test(pattern),
                'host_permissions must stay https nhentai-scoped: ' + pattern);
        }
        for (const pattern of firefoxManifest.optional_host_permissions || []) {
            assert.ok(/^https:\/\/(?:\*\.)?[a-z0-9-]*\*?\.nhentai\.net\/\*$/.test(pattern),
                'optional host patterns must be https and nhentai-scoped: ' + pattern);
        }
    });
});
