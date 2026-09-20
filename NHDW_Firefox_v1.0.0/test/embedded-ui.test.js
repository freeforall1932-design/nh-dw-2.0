// Website-embedded UI contract (embeddedUi.ts, items 56/57): the pure rules
// the content script, the worker and the settings pane share. No browser.
//
// The contract pinned here:
//  * Unset embeddedUi means ON (it is the primary surface, not an experiment).
//  * Unset toolbarOpensEmbedded follows the device the content script measured.
//  * An explicit toolbar boolean always wins over the device.
//  * shipsSiteUi is a manifest probe, so the same source is inert in Chrome.
//  * The invoker anchors ONLY on `.navbar`, preferring always-visible slots
//    (header / left / hamburger parent) over the collapsible right-hand list.
//  * A toolbar click never does nothing: toggle, then inject, then the popup.

const assert = require('assert');
const {
    EMBEDDED_UI_KEY,
    EMBEDDED_UI_DEFAULT,
    TOOLBAR_EMBEDDED_KEY,
    MOBILE_DEVICE_KEY,
    MOBILE_LAYOUT_MEDIA,
    SITE_UI_BUNDLE,
    PANEL_PAGE,
    SITE_UI_TOGGLE_ACTION,
    SITE_UI_OPEN_PANEL_ACTION,
    NAVBAR_SELECTOR,
    galleryIdFromUrl,
    normalizeEmbeddedUi,
    resolveToolbarEmbedded,
    shipsSiteUi,
    popupForTab,
    handleToolbarClick,
    resolveInvokerAnchor,
    findHamburger
} = require('../build/test/utils/embeddedUi.js');

describe('embedded UI contract (items 56/57)', () => {
    it('keeps the storage keys and the layout gate stable', () => {
        assert.strictEqual(EMBEDDED_UI_KEY, 'embeddedUi');
        assert.strictEqual(EMBEDDED_UI_DEFAULT, true);
        assert.strictEqual(TOOLBAR_EMBEDDED_KEY, 'toolbarOpensEmbedded');
        assert.strictEqual(MOBILE_DEVICE_KEY, 'nhdwMobileDevice');
        assert.strictEqual(MOBILE_LAYOUT_MEDIA, '(max-width: 640px) and (pointer: coarse)');
        assert.strictEqual(SITE_UI_BUNDLE, 'js/siteUi.js');
        assert.strictEqual(PANEL_PAGE, 'index.html');
        assert.strictEqual(SITE_UI_TOGGLE_ACTION, 'siteUiToggle');
        assert.strictEqual(SITE_UI_OPEN_PANEL_ACTION, 'siteUiOpenPanel');
        assert.strictEqual(NAVBAR_SELECTOR, '.navbar');
    });

    it('reads a gallery id from /g/<id>/ shapes and rejects everything else', () => {
        assert.strictEqual(galleryIdFromUrl('https://nhentai.net/g/177013/'), '177013');
        assert.strictEqual(galleryIdFromUrl('https://nhentai.net/g/177013'), '177013');
        assert.strictEqual(galleryIdFromUrl('https://nhentai.net/g/177013/?page=2'), '177013');
        assert.strictEqual(galleryIdFromUrl('/g/42/'), '42');
        assert.strictEqual(galleryIdFromUrl('https://nhentai.net/'), null);
        assert.strictEqual(galleryIdFromUrl('https://nhentai.net/search/?q=foo'), null);
        assert.strictEqual(galleryIdFromUrl(''), null);
        assert.strictEqual(galleryIdFromUrl(null), null);
        assert.strictEqual(galleryIdFromUrl(undefined), null);
    });

    it('treats an unset embeddedUi as ON, and honours explicit booleans and strings', () => {
        assert.strictEqual(normalizeEmbeddedUi(undefined), true);
        assert.strictEqual(normalizeEmbeddedUi(null), true);
        assert.strictEqual(normalizeEmbeddedUi(true), true);
        assert.strictEqual(normalizeEmbeddedUi(false), false);
        assert.strictEqual(normalizeEmbeddedUi('true'), true);
        assert.strictEqual(normalizeEmbeddedUi('on'), true);
        assert.strictEqual(normalizeEmbeddedUi('false'), false);
        assert.strictEqual(normalizeEmbeddedUi('off'), false);
        assert.strictEqual(normalizeEmbeddedUi('0'), false);
    });

    it('lets an explicit toolbar setting win and follows the device when unset', () => {
        assert.strictEqual(resolveToolbarEmbedded(undefined, true), true);
        assert.strictEqual(resolveToolbarEmbedded(undefined, false), false);
        assert.strictEqual(resolveToolbarEmbedded(null, true), true);
        assert.strictEqual(resolveToolbarEmbedded(true, false), true);
        assert.strictEqual(resolveToolbarEmbedded(false, true), false);
        assert.strictEqual(resolveToolbarEmbedded('on', false), true);
        assert.strictEqual(resolveToolbarEmbedded('off', true), false);
    });

    it('shipsSiteUi is true only when the manifest injects js/siteUi.js', () => {
        assert.strictEqual(shipsSiteUi(null), false);
        assert.strictEqual(shipsSiteUi({}), false);
        assert.strictEqual(shipsSiteUi({ content_scripts: [] }), false);
        assert.strictEqual(shipsSiteUi({
            content_scripts: [{ js: ['js/content.js', 'js/listControls.js'] }]
        }), false, 'Chrome-shaped manifest must stay inert');
        assert.strictEqual(shipsSiteUi({
            content_scripts: [{ js: ['js/content.js', 'js/listControls.js', 'js/siteUi.js'] }]
        }), true);
    });

    it('clears the toolbar popup only on a site tab while embedded mode is on', () => {
        const isSite = (url) => /^https:\/\/nhentai\.net/.test(url);
        assert.strictEqual(popupForTab(false, 'https://nhentai.net/g/1/', isSite), 'index.html');
        assert.strictEqual(popupForTab(true, 'https://nhentai.net/g/1/', isSite), '');
        assert.strictEqual(popupForTab(true, 'https://example.com/', isSite), 'index.html');
        assert.strictEqual(popupForTab(true, '', isSite), 'index.html');
        assert.strictEqual(popupForTab(true, undefined, isSite), 'index.html');
    });
});

describe('handleToolbarClick', () => {
    function hostSpy() {
        const calls = { send: [], inject: 0, panel: 0 };
        return {
            calls: calls,
            sendToTab: async (tabId, message) => {
                calls.send.push({ tabId: tabId, message: message });
                return false;
            },
            injectSiteUi: async () => {
                calls.inject += 1;
                return false;
            },
            openPanelPage: () => { calls.panel += 1; }
        };
    }

    it('does nothing when embedded toolbar mode is off (the popup is set)', async () => {
        const host = hostSpy();
        const outcome = await handleToolbarClick(host, { id: 7, url: 'https://nhentai.net/' }, {
            embeddedToolbar: false,
            isSiteUrl: () => true
        });
        assert.strictEqual(outcome, 'ignored');
        assert.strictEqual(host.calls.send.length, 0);
        assert.strictEqual(host.calls.panel, 0);
    });

    it('opens the fallback panel on a non-site tab', async () => {
        const host = hostSpy();
        const outcome = await handleToolbarClick(host, { id: 7, url: 'https://example.com/' }, {
            embeddedToolbar: true,
            isSiteUrl: (url) => /nhentai\.net/.test(url)
        });
        assert.strictEqual(outcome, 'panel');
        assert.strictEqual(host.calls.panel, 1);
        assert.strictEqual(host.calls.send.length, 0);
    });

    it('toggles the drawer when the content script answers', async () => {
        const host = hostSpy();
        host.sendToTab = async (tabId, message) => {
            host.calls.send.push({ tabId: tabId, message: message });
            return true;
        };
        const outcome = await handleToolbarClick(host, { id: 9, url: 'https://nhentai.net/g/1/' }, {
            embeddedToolbar: true,
            isSiteUrl: () => true
        });
        assert.strictEqual(outcome, 'toggled');
        assert.strictEqual(host.calls.send.length, 1);
        assert.strictEqual(host.calls.send[0].message.action, 'siteUiToggle');
        assert.strictEqual(host.calls.inject, 0);
        assert.strictEqual(host.calls.panel, 0);
    });

    it('injects the bundle and retries when nobody answered, then falls back', async () => {
        const host = hostSpy();
        host.injectSiteUi = async () => {
            host.calls.inject += 1;
            return true;
        };
        const outcome = await handleToolbarClick(host, { id: 9, url: 'https://nhentai.net/' }, {
            embeddedToolbar: true,
            isSiteUrl: () => true,
            sleep: async () => {},
            retries: 2,
            retryDelayMs: 0
        });
        assert.strictEqual(outcome, 'panel');
        assert.strictEqual(host.calls.inject, 1);
        // First send + two post-inject retries.
        assert.strictEqual(host.calls.send.length, 3);
        assert.strictEqual(host.calls.send[1].message.open, true);
        assert.strictEqual(host.calls.panel, 1);
    });

    it('reports injected when a post-inject retry succeeds', async () => {
        const host = hostSpy();
        let n = 0;
        host.sendToTab = async (tabId, message) => {
            host.calls.send.push({ tabId: tabId, message: message });
            n += 1;
            return n >= 2;
        };
        host.injectSiteUi = async () => {
            host.calls.inject += 1;
            return true;
        };
        const outcome = await handleToolbarClick(host, { id: 9, url: 'https://nhentai.net/' }, {
            embeddedToolbar: true,
            isSiteUrl: () => true,
            sleep: async () => {},
            retries: 3,
            retryDelayMs: 0
        });
        assert.strictEqual(outcome, 'injected');
        assert.strictEqual(host.calls.panel, 0);
    });
});

describe('resolveInvokerAnchor', () => {
    function node(tag, attrs, children) {
        const n = {
            tagName: String(tag).toUpperCase(),
            tag: tag,
            attrs: Object.assign({}, attrs),
            children: children || [],
            parentElement: null,
            get className() { return n.attrs.class || ''; },
            get id() { return n.attrs.id || ''; },
            querySelector(selector) {
                return find(n, selector);
            }
        };
        for (const child of n.children) {
            child.parentElement = n;
        }
        return n;
    }

    function matches(el, selector) {
        if (selector.startsWith('.')) {
            const cls = selector.slice(1);
            return String(el.className || '').split(/\s+/).includes(cls);
        }
        if (selector.startsWith('#')) {
            return el.id === selector.slice(1);
        }
        const tagged = /^([a-z]+)\.([a-z0-9_-]+)$/i.exec(selector);
        if (tagged) {
            return el.tagName === tagged[1].toUpperCase()
                && String(el.className || '').split(/\s+/).includes(tagged[2]);
        }
        return el.tagName === String(selector).toUpperCase();
    }

    function walk(root, out) {
        for (const child of root.children || []) {
            out.push(child);
            walk(child, out);
        }
        return out;
    }

    function find(root, selector) {
        const all = walk(root, []);
        for (const el of all) {
            if (matches(el, selector)) {
                return el;
            }
        }
        return null;
    }

    it('returns null when the page has no .navbar (stay out of it)', () => {
        const doc = node('html', {}, [node('body', {}, [node('div', { class: 'container' }, [])])]);
        assert.strictEqual(resolveInvokerAnchor(doc), null);
    });

    it('anchors in .navbar-header next to the hamburger (nhentai Bootstrap layout)', () => {
        const hamburger = node('button', { class: 'navbar-toggle', id: 'nav_btn' }, []);
        const header = node('div', { class: 'navbar-header' }, [
            node('a', { class: 'navbar-brand' }, []),
            hamburger
        ]);
        const navbar = node('nav', { class: 'navbar navbar-inverse' }, [
            header,
            node('div', { class: 'navbar-right' }, [node('ul', {}, [])])
        ]);
        const doc = node('html', {}, [node('body', {}, [navbar])]);
        const anchor = resolveInvokerAnchor(doc);
        assert.ok(anchor, 'expected an anchor');
        assert.strictEqual(anchor.kind, 'bootstrap-header');
        assert.strictEqual(anchor.container, header);
        assert.strictEqual(anchor.reference, hamburger);
        assert.strictEqual(anchor.asListItem, false);
        assert.strictEqual(findHamburger(navbar), hamburger);
    });

    it('anchors in .navbar_left (mirror generation captured in-repo)', () => {
        const hamburger = node('button', { id: 'nav_btn', class: 'navbar-toggle' }, []);
        const left = node('div', { class: 'navbar_left' }, [
            node('div', { class: 'navbar_logo' }, []),
            node('button', { id: 'drop_btn' }, []),
            hamburger
        ]);
        const navbar = node('div', { class: 'navbar' }, [
            left,
            node('div', { class: 'navbar_right' }, [])
        ]);
        const doc = node('html', {}, [navbar]);
        const anchor = resolveInvokerAnchor(doc);
        assert.ok(anchor, 'expected an anchor');
        assert.strictEqual(anchor.kind, 'clone-left');
        assert.strictEqual(anchor.container, left);
        assert.strictEqual(anchor.reference, hamburger);
    });

    it('never prefers the right-hand list (it is hidden at phone width)', () => {
        const hamburger = node('button', { class: 'navbar-toggle' }, []);
        const header = node('div', { class: 'navbar-header' }, [hamburger]);
        const right = node('ul', { class: 'navbar-right' }, [node('li', {}, [])]);
        const navbar = node('nav', { class: 'navbar' }, [header, right]);
        const doc = node('html', {}, [navbar]);
        const anchor = resolveInvokerAnchor(doc);
        assert.strictEqual(anchor.kind, 'bootstrap-header');
        assert.notStrictEqual(anchor.container, right);
    });

    it('falls back to the navbar root when no known slot exists', () => {
        const navbar = node('div', { class: 'navbar' }, [node('a', { class: 'logo' }, [])]);
        const doc = node('html', {}, [navbar]);
        const anchor = resolveInvokerAnchor(doc);
        assert.ok(anchor);
        assert.strictEqual(anchor.kind, 'navbar-root');
        assert.strictEqual(anchor.container, navbar);
        assert.strictEqual(anchor.reference, null);
    });
});
