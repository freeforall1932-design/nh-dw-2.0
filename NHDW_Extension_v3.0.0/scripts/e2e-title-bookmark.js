// Title-page Bookmark button test: load the built js/titleBookmark.js in a
// window-less VM with a DOM stub that mirrors each supported site's gallery
// page, and verify
//   - the button is injected into the site's OWN button row, immediately after
//     its Download button, carrying the site's presentational classes
//   - it reads "Bookmark" with the outline glyph, turns blue on click, and
//     sends bookmarkAdd with the site, id, title, cover and page count
//   - a second click sends bookmarkRemove with the COMPOSITE "site:id" key
//   - the stored list drives the paint (persistence): a row already in
//     chrome.storage.local renders as "Bookmarked" without a click, and a
//     storage event repaints the button
//   - listing pages, reader pages and markup we do not recognize get no
//     button at all, and our own card controls are never mistaken for the
//     site's Favorite/Download row
//   - the Settings "In-page controls" toggle owns this button too: switching it
//     off leaves the site's toolbar untouched, with no timer left behind
//
// Usage:  node scripts/e2e-title-bookmark.js [path/to/js/titleBookmark.js]
// Exit code 0 = all checks passed.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const bundlePath = process.argv[2] || path.join(__dirname, '..', 'js', 'titleBookmark.js');
const code = fs.readFileSync(bundlePath, 'utf8');

let checks = 0;

function fail(message) {
    console.error('FAIL: ' + message);
    process.exit(1);
}

function ok(condition, message) {
    if (!condition) {
        fail(message);
    }
    checks++;
}

function pass(message) {
    checks++;
    console.log('PASS: ' + message);
}

// --- minimal DOM ----------------------------------------------------------

function makeClassList(node) {
    return {
        add(name) { if (!node._classes.includes(name)) node._classes.push(name); },
        remove(name) {
            const i = node._classes.indexOf(name);
            if (i !== -1) node._classes.splice(i, 1);
        },
        contains(name) { return node._classes.includes(name); },
        toggle(name, force) {
            const on = force === undefined ? !node._classes.includes(name) : !!force;
            if (on) this.add(name); else this.remove(name);
            return on;
        }
    };
}

function makeEl(tag, attrs) {
    const node = {
        tag: String(tag).toLowerCase(),
        children: [],
        attrs: Object.assign({}, attrs),
        _classes: [],
        _listeners: {},
        parentElement: null,
        id: (attrs && attrs.id) || '',
        type: '',
        title: '',
        value: '',
        textContent: '',
        checked: false,
        disabled: false,
        hidden: false,
        style: {},
        get tagName() { return node.tag.toUpperCase(); },
        get parentNode() { return node.parentElement; },
        get nextSibling() {
            if (node.parentElement === null) return null;
            const siblings = node.parentElement.children;
            const i = siblings.indexOf(node);
            return i === -1 || i === siblings.length - 1 ? null : siblings[i + 1];
        },
        get className() { return node._classes.join(' '); },
        set className(value) { node._classes = String(value).split(/\s+/).filter(Boolean); },
        appendChild(child) {
            if (child.parentElement !== null) child.parentElement.removeChild(child);
            child.parentElement = node;
            node.children.push(child);
            if (child.id) node._byId = null;
            return child;
        },
        insertBefore(child, reference) {
            if (reference === null || reference === undefined) return node.appendChild(child);
            const i = node.children.indexOf(reference);
            if (i === -1) throw new Error('insertBefore: reference is not a child');
            if (child.parentElement !== null) child.parentElement.removeChild(child);
            child.parentElement = node;
            node.children.splice(i, 0, child);
            return child;
        },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i === -1) throw new Error('removeChild: not a child');
            node.children.splice(i, 1);
            child.parentElement = null;
            return child;
        },
        setAttribute(name, value) {
            node.attrs[name] = String(value);
            if (name === 'id') node.id = String(value);
            if (name === 'class') node.className = String(value);
        },
        getAttribute(name) {
            if (name === 'class') return node.className === '' ? null : node.className;
            return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
        },
        hasAttribute(name) { return node.getAttribute(name) !== null; },
        addEventListener(type, fn) {
            (node._listeners[type] = node._listeners[type] || []).push(fn);
        },
        dispatch(type, event) {
            const handlers = node._listeners[type] || [];
            const ev = Object.assign({
                preventDefault() {},
                stopPropagation() {},
                target: node
            }, event);
            for (const fn of handlers.slice()) fn(ev);
        },
        querySelector(selector) {
            const found = queryAll(node, selector);
            return found.length > 0 ? found[0] : null;
        },
        querySelectorAll(selector) {
            const found = queryAll(node, selector);
            found.forEach = Array.prototype.forEach.bind(found);
            return found;
        }
    };
    node.classList = makeClassList(node);
    return node;
}

// Selector support for the shapes this bundle uses: "#id", "tag.class",
// ".class", "[attr]", 'tag[attr$="value"]', 'tag[attr="value"]', comma groups
// and descendant chains.
function matchesSimple(node, simple) {
    const compound = /^([a-z0-9-]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/i.exec(simple);
    if (compound === null) return false;
    const tag = compound[1].toLowerCase();
    if (tag && node.tag !== tag) return false;
    const rest = compound[2];
    const tokenRe = /([.#][\w-]+)|(\[([^\]]+)\])/g;
    let token = tokenRe.exec(rest);
    while (token !== null) {
        if (token[1]) {
            if (token[1][0] === '.') {
                if (!node._classes.includes(token[1].slice(1))) return false;
            } else if (node.getAttribute('id') !== token[1].slice(1)) {
                return false;
            }
        } else {
            const attr = /^([\w-]+)(?:(\^=|\$=|\*=|=)"?([^"\]]*)"?)?$/.exec(token[3]);
            if (attr === null) return false;
            const actual = node.getAttribute(attr[1]);
            if (actual === null || actual === undefined) return false;
            const value = attr[3] === undefined ? '' : attr[3];
            if (attr[2] === '=' && String(actual) !== value) return false;
            if (attr[2] === '^=' && String(actual).indexOf(value) !== 0) return false;
            if (attr[2] === '$=' && String(actual).slice(-value.length) !== value) return false;
            if (attr[2] === '*=' && String(actual).indexOf(value) === -1) return false;
        }
        token = tokenRe.exec(rest);
    }
    return true;
}

function descendants(root, out) {
    for (const child of root.children) {
        out.push(child);
        descendants(child, out);
    }
    return out;
}

function queryAll(root, selector) {
    const groups = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
    const found = [];
    for (const group of groups) {
        const parts = group.split(/\s+/);
        let current = descendants(root, []);
        for (let i = 0; i < parts.length; i++) {
            const next = current.filter((node) => matchesSimple(node, parts[i]));
            current = i === parts.length - 1
                ? next
                : next.reduce((acc, node) => acc.concat(descendants(node, [])), []);
        }
        for (const node of current) {
            if (!found.includes(node)) found.push(node);
        }
    }
    return found;
}

function makeDocument() {
    const html = makeEl('html');
    const body = makeEl('body');
    html.appendChild(body);
    const document = {
        readyState: 'complete',
        title: '',
        documentElement: html,
        body: body,
        createElement: (tag) => makeEl(tag),
        createElementNS: (ns, tag) => makeEl(tag),
        addEventListener() {},
        querySelector: (selector) => {
            const found = queryAll(html, selector);
            return found.length > 0 ? found[0] : null;
        },
        querySelectorAll: (selector) => {
            const found = queryAll(html, selector);
            found.forEach = Array.prototype.forEach.bind(found);
            return found;
        }
    };
    return document;
}

// --- chrome + timers ------------------------------------------------------

function makeChrome(store, settings) {
    const state = { store: store, sent: [], changeListeners: [], lastError: undefined, settings: settings || {} };
    state.chrome = {
        storage: {
            sync: {
                get(defaults, callback) {
                    const out = {};
                    const keys = Array.isArray(defaults) ? defaults : Object.keys(defaults || {});
                    for (const key of keys) {
                        out[key] = Object.prototype.hasOwnProperty.call(state.settings, key)
                            ? state.settings[key]
                            : (defaults || {})[key];
                    }
                    callback(out);
                },
                set(patch, callback) {
                    Object.assign(state.settings, patch);
                    if (callback) callback();
                }
            },
            local: {
                get(defaults, callback) {
                    // Key-scoped, like the real API: only requested keys come back.
                    const out = {};
                    const keys = Array.isArray(defaults) ? defaults : Object.keys(defaults || {});
                    for (const key of keys) {
                        out[key] = Object.prototype.hasOwnProperty.call(state.store, key)
                            ? state.store[key]
                            : (defaults || {})[key];
                    }
                    callback(out);
                },
                set(patch, callback) {
                    Object.assign(state.store, patch);
                    if (callback) callback();
                },
                remove(key, callback) {
                    delete state.store[key];
                    if (callback) callback();
                }
            },
            onChanged: {
                addListener(fn) { state.changeListeners.push(fn); }
            }
        },
        runtime: {
            lastError: undefined,
            sendMessage(message, callback) {
                state.sent.push(message);
                if (callback) callback({ result: 'success' });
            }
        }
    };
    state.emitChange = (key) => {
        const changes = {};
        changes[key] = { newValue: state.store[key] };
        for (const listener of state.changeListeners.slice()) listener(changes, 'local');
    };
    return state;
}

function makeTimers() {
    const pending = new Map();
    let nextId = 1;
    return {
        setInterval(fn, ms) {
            const id = nextId++;
            pending.set(id, { fn: fn, ms: ms });
            return id;
        },
        clearInterval(id) { pending.delete(id); },
        setTimeout(fn) { fn(); return 0; },
        clearTimeout() {},
        tick() {
            for (const entry of Array.from(pending.values())) entry.fn();
        },
        get size() { return pending.size; }
    };
}

// --- scenarios ------------------------------------------------------------

const bookmarkQueueModule = require(path.join(__dirname, '..', 'build', 'test', 'utils', 'bookmarkQueue.js'));

function storedQueue(items, collapsed) {
    const state = { v: 1, items: [], collapsed: !!collapsed };
    for (const item of items) state.items.push(item);
    return state;
}

function rowFor(site, id, extra) {
    return Object.assign({
        id: String(id),
        site: site,
        title: 'Stored title',
        thumbnail: '',
        pages: 0,
        source: 'page',
        sourceUrl: '',
        addedAt: 1,
        selected: true,
        status: 'saved',
        error: '',
        filename: ''
    }, extra || {});
}

function run(options) {
    const document = makeDocument();
    if (options.build) options.build(document);
    document.title = options.title || 'Some Gallery';
    // The caller's object is the store, by identity: a test that simulates the
    // panel mutating the list can assign to it and the script's next read sees
    // it, exactly like chrome.storage.local.
    const store = options.store || {};
    const chrome = makeChrome(store, options.settings);
    const timers = makeTimers();
    const sandbox = {
        document: document,
        location: { href: options.url },
        chrome: chrome.chrome,
        console: console,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        Promise: Promise,
        Object: Object,
        Array: Array,
        String: String,
        Number: Number,
        RegExp: RegExp,
        JSON: JSON,
        Math: Math,
        // The gallery-page Smart Download asks before re-downloading a recorded
        // title, so the sandbox needs a window the way a real page has one.
        window: options.window || { confirm: () => true }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: bundlePath });
    return { document: document, chrome: chrome, timers: timers, sandbox: sandbox };
}

async function flush(times) {
    for (let i = 0; i < (times || 4); i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function buttonIn(document) {
    return document.querySelector('[data-nhdw-title-bookmark]');
}

function labelOf(button) {
    const label = button.querySelector('.nhdw-title-bookmark-label');
    return label === null ? '' : label.textContent;
}

function glyphPath(button) {
    const glyph = button.querySelector('svg.nhdw-title-bookmark-icon path');
    return glyph === null ? '' : glyph.getAttribute('d');
}

const OUTLINE = require(path.join(__dirname, '..', 'build', 'test', 'utils', 'titleBookmark.js')).BOOKMARK_ICON_OUTLINE_PATH;
const FILLED = require(path.join(__dirname, '..', 'build', 'test', 'utils', 'titleBookmark.js')).BOOKMARK_ICON_PATH;

// One builder per site, mirroring the captured markup. Each returns the
// element our button must end up inside and the site's own Download button.
const SITES = {
    nhentai: {
        url: 'https://nhentai.net/g/683215/',
        classes: ['btn', 'btn-secondary'],
        build(document) {
            const body = document.body;
            const infoBlock = makeEl('div', { id: 'info-block' });
            const info = makeEl('div', { id: 'info' });
            const h1 = makeEl('h1');
            h1.className = 'title';
            h1.textContent = 'Moonlit Waon-chan (Suite Precure) [Digital]';
            info.appendChild(h1);
            infoBlock.appendChild(info);
            const buttons = makeEl('div');
            buttons.className = 'buttons';
            const favorite = makeEl('button', { id: 'favorite' });
            favorite.className = 'btn btn-primary';
            favorite.textContent = 'Favorite (106)';
            const download = makeEl('a', { id: 'download', href: '/g/683215/download' });
            download.className = 'btn btn-secondary';
            download.textContent = 'Download';
            buttons.appendChild(favorite);
            buttons.appendChild(download);
            infoBlock.appendChild(buttons);
            body.appendChild(infoBlock);
            const cover = makeEl('div', { id: 'cover' });
            const coverImg = makeEl('img');
            coverImg.setAttribute('data-src', 'https://t5.nhentai.net/galleries/4199749/cover.webp');
            coverImg.setAttribute('src', 'data:image/gif;base64,placeholder');
            cover.appendChild(coverImg);
            body.appendChild(cover);
            const tags = makeEl('section', { id: 'tags' });
            const pagesRow = makeEl('div');
            pagesRow.className = 'tag-container field-name';
            pagesRow.textContent = 'Pages: 51';
            tags.appendChild(pagesRow);
            body.appendChild(tags);
            body.textContent = 'Favorite (106) Download Pages: 51';
            return { container: buttons, download: download };
        }
    },
    hentaiera: {
        url: 'https://hentaiera.to/gallery/694133/',
        classes: ['btn', 'btn_colored'],
        build(document) {
            const body = document.body;
            const first = makeEl('div');
            first.className = 'row gallery_first';
            const h1 = makeEl('h1');
            h1.textContent = 'Watashi ga Tsukurimashita. (Touhou Project)';
            first.appendChild(h1);
            const left = makeEl('div');
            left.className = 'col left_cover';
            const cover = makeEl('img');
            cover.setAttribute('src', 'https://hentaiera.site/galleries/4182234/cover.webp');
            cover.setAttribute('alt', 'Watashi ga Tsukurimashita. (Touhou Project) cover');
            left.appendChild(cover);
            first.appendChild(left);
            body.appendChild(first);
            const others = makeEl('div');
            others.className = 'others';
            const fav = makeEl('button', { id: 'add_fav_btn' });
            fav.className = 'btn btn_colored ';
            fav.textContent = 'Favourite (0)';
            const download = makeEl('button', { id: 'download_btn' });
            download.className = 'btn btn_colored';
            download.textContent = 'Download (0)';
            const fap = makeEl('button', { id: 'fap_btn' });
            fap.className = 'btn btn_colored';
            fap.textContent = 'Fapped (0)';
            others.appendChild(fav);
            others.appendChild(download);
            others.appendChild(fap);
            body.appendChild(others);
            body.textContent = 'Favourite (0) Download (0) Fapped (0)';
            return { container: others, download: download };
        }
    },
    imhentai: {
        url: 'https://imhentai.xxx/gallery/1738518/',
        classes: ['tag', 'btn', 'btn-primary'],
        build(document) {
            // Markup taken verbatim from a saved imhentai gallery page:
            //   <div class="g_buttons"> … <button class="tag btn btn-primary
            //   fav_btn" id="add_fav_btn">Favourite (1352)</button>
            //   <button class="tag btn btn-primary dl_btn" id="dl_new">
            //   Download (<span>2996</span>)</button> … <li class="pages">
            //   Pages: 487</li>
            const body = document.body;
            const h1 = makeEl('h1');
            h1.textContent = '[Ochiba] Mahou Shoujo no Himitsu';
            body.appendChild(h1);
            const cover = makeEl('div');
            cover.className = 'col-md-4 col left_cover';
            const img = makeEl('img');
            img.setAttribute('data-src', 'https://m9.imhentai.xxx/027/7gix9myduq/1t.jpg');
            img.setAttribute('src', 'data:image/svg+xml,placeholder');
            cover.appendChild(img);
            body.appendChild(cover);
            const buttons = makeEl('div');
            buttons.className = 'g_buttons';
            const likes = makeEl('div');
            likes.className = 'likes';
            const like = makeEl('button', { id: 'like_btn' });
            like.className = 'tag btn btn-primary fap_btn';
            like.textContent = '7';
            likes.appendChild(like);
            const fav = makeEl('button', { id: 'add_fav_btn' });
            fav.className = 'tag btn btn-primary fav_btn';
            fav.textContent = 'Favourite (1352)';
            const download = makeEl('button', { id: 'dl_new' });
            download.className = 'tag btn btn-primary dl_btn';
            download.textContent = 'Download (2996)';
            buttons.appendChild(likes);
            buttons.appendChild(fav);
            buttons.appendChild(download);
            const list = makeEl('ul');
            list.className = 'galleries_info';
            const pages = makeEl('li');
            pages.className = 'pages';
            pages.textContent = 'Pages: 487';
            list.appendChild(pages);
            body.appendChild(buttons);
            body.appendChild(list);
            body.textContent = 'Favourite (1352) Download (2996) Pages: 487';
            return { container: buttons, download: download };
        }
    },
    hentaienvy: {
        url: 'https://hentaienvy.com/gallery/1606086/',
        classes: ['hnv-gallery-action'],
        build(document) {
            const body = document.body;
            const h1 = makeEl('h1', { id: 'gallery-title' });
            h1.textContent = '[Ochiba] Mahou Shoujo no Himitsu';
            body.appendChild(h1);
            const cover = makeEl('div');
            cover.className = 'hnv-gallery-cover-column';
            const img = makeEl('img');
            img.setAttribute('src', 'https://m11.hentaienvy.com/033/w62za5o4v3/cover.jpg');
            cover.appendChild(img);
            body.appendChild(cover);
            const actions = makeEl('div');
            actions.className = 'hnv-gallery-actions';
            const left = makeEl('div');
            left.className = 'hnv-gallery-actions__left';
            const fav = makeEl('button');
            fav.className = 'js-ajax-action hnv-gallery-action';
            fav.setAttribute('data-action', '/api/gallery/1606086/favorite/toggle');
            fav.textContent = 'Add to favorites 0';
            left.appendChild(fav);
            const right = makeEl('div');
            right.className = 'hnv-gallery-actions__right';
            const download = makeEl('button');
            download.className = 'js-ajax-action hnv-gallery-action';
            download.setAttribute('data-action', '/api/gallery/1606086/download/start');
            download.textContent = 'Download 0';
            const fapped = makeEl('button');
            fapped.className = 'js-ajax-action hnv-gallery-action';
            fapped.setAttribute('data-action', '/api/gallery/1606086/fapped/toggle');
            fapped.textContent = 'Fapped 0';
            right.appendChild(download);
            right.appendChild(fapped);
            actions.appendChild(left);
            actions.appendChild(right);
            body.appendChild(actions);
            const pages = makeEl('div');
            pages.className = 'hnv-gallery-pages';
            pages.textContent = 'Pages: 49';
            body.appendChild(pages);
            body.textContent = 'Add to favorites 0 Download 0 Fapped 0 Pages: 49';
            return { container: right, download: download };
        }
    },
    hentaifox: {
        url: 'https://hentaifox.com/gallery/173098/',
        classes: ['tag', 'btn', 'btn-primary'],
        build(document) {
            // hentaifox's gallery page has never been captured (Cloudflare
            // blocks it), so this fixture is built from the two independent
            // facts that ARE known: the four ids every hentaifox gallery page
            // must expose (`download_btn`, `add_fav_btn`, `thumbs_up`,
            // `thumbs_down` — HentaiFoxData's Qt browser toggles exactly those),
            // and the shared `g_buttons` / `div.info` / `div.cover` structure of
            // the site family. The button must still land correctly AND copy
            // the anchor's own classes, which is what makes an uncaptured site
            // safe.
            const body = document.body;
            const info = makeEl('div');
            info.className = 'info';
            const h1 = makeEl('h1');
            h1.textContent = 'The Girllove Diary';
            info.appendChild(h1);
            const cover = makeEl('div');
            cover.className = 'cover';
            const img = makeEl('img');
            img.setAttribute('src', 'https://i.hentaifox.com/005/4190711/cover.jpg');
            cover.appendChild(img);
            info.appendChild(cover);
            const pages = makeEl('span');
            pages.className = 'i_text pages';
            pages.textContent = 'Pages: 24';
            info.appendChild(pages);
            const buttons = makeEl('ul');
            buttons.className = 'g_buttons';
            const up = makeEl('button', { id: 'thumbs_up' });
            up.className = 'tag btn btn-primary fap_btn';
            up.textContent = '12';
            const fav = makeEl('button', { id: 'add_fav_btn' });
            fav.className = 'tag btn btn-primary fav_btn';
            fav.textContent = 'Favorite (0)';
            const download = makeEl('button', { id: 'download_btn' });
            download.className = 'tag btn btn-primary dl_btn';
            download.textContent = 'Download';
            for (const node of [up, fav, download]) buttons.appendChild(node);
            info.appendChild(buttons);
            body.appendChild(info);
            body.textContent = 'Favorite (0) Download Pages: 24';
            return { container: buttons, download: download };
        }
    },
    hitomi: {
        url: 'https://hitomi.la/galleries/4203493.html',
        classes: [],
        build(document) {
            const body = document.body;
            const hero = makeEl('div');
            hero.className = 'dj-img-meta';
            const picture = makeEl('picture');
            const img = makeEl('img');
            img.setAttribute('id', 'bigtn_img');
            img.setAttribute('src', 'https://atn.gold-usergeneratedcontent.net/webpbigtn/f/5b/cover.webp');
            picture.appendChild(img);
            hero.appendChild(picture);
            const read = makeEl('a', { id: 'read-online-button', href: '/reader/4203493.html' });
            read.textContent = 'Read Online';
            const download = makeEl('a', { id: 'dl-button', href: '#' });
            download.textContent = 'Download';
            hero.appendChild(read);
            hero.appendChild(download);
            body.appendChild(hero);
            const brand = makeEl('h1', { id: 'gallery-brand' });
            brand.textContent = 'Girl with a Ponytail';
            body.appendChild(brand);
            body.textContent = 'Read Online Download';
            return { container: hero, download: download };
        }
    }
};

async function main() {
    // --- 1. every site: position, classes, label ---------------------------
    for (const site of Object.keys(SITES)) {
        const fixture = SITES[site];
        const context = run({ url: fixture.url, build: fixture.build, title: 'Titled' });
        await flush();
        const button = buttonIn(context.document);
        ok(button !== null, site + ': an in-page bookmark button is injected');

        // Position: immediately after the site's Download button.
        const download = context.document.querySelector('#download, #download_btn, #dl_new, #dl-button, [data-action$="/download/start"]');
        ok(download !== null, site + ': the fixture has the site\'s own Download button');
        const container = download.parentElement;
        ok(container.children.indexOf(button) === container.children.indexOf(download) + 1,
            site + ': the bookmark button sits directly after Download in the site\'s own row');
        ok(container.children.indexOf(download) < container.children.indexOf(button),
            site + ': Download stays where the user knows it');

        // Sizing: the site's own button classes are copied onto ours.
        for (const className of fixture.classes) {
            ok(button.classList.contains(className),
                site + ': the button carries the site\'s class "' + className + '"');
        }
        ok(button.classList.contains('nhdw-title-bookmark'), site + ': the button is namespaced');
        // Sizing is copied from the site's own button, but never its behavior
        // hooks: those are how these sites bind their own AJAX handlers.
        for (const name of button.className.split(/\s+/)) {
            ok(!/_btn$|^js[-_]|-trigger$/i.test(name),
                site + ': the site behavior hook "' + name + '" must not be copied onto our button');
        }
        ok(!button.classList.contains('nhdw-title-bookmark-on'), site + ': a fresh button renders as OFF');
        ok(labelOf(button) === 'Bookmark', site + ': the label reads "Bookmark", got ' + JSON.stringify(labelOf(button)));
        ok(glyphPath(button) === OUTLINE, site + ': the outline glyph is drawn while OFF');
        ok(button.getAttribute('aria-pressed') === 'false', site + ': aria-pressed is false while OFF');
    }
    pass('every supported site gets a blue, site-sized "Bookmark" button in its own button row');

    // --- 2. clicking adds, with title/cover/pages read from the page -------
    {
        const context = run({ url: SITES.nhentai.url, build: SITES.nhentai.build, title: 'Titled' });
        await flush();
        const button = buttonIn(context.document);
        button.dispatch('click');
        await flush();
        const add = context.chrome.sent.filter((m) => m.action === 'bookmarkAdd').pop();
        ok(add !== undefined, 'clicking Bookmark sends bookmarkAdd');
        const item = add.items[0];
        ok(item.id === '683215', 'the bookmark carries the gallery id, got ' + item.id);
        ok(item.site === 'nhentai', 'the bookmark carries the site, got ' + item.site);
        ok(item.title === 'Moonlit Waon-chan (Suite Precure) [Digital]', 'the title comes from the page, got ' + JSON.stringify(item.title));
        ok(item.thumbnail === 'https://t5.nhentai.net/galleries/4199749/cover.webp', 'the cover comes from the page (data-src, not the placeholder), got ' + item.thumbnail);
        ok(item.pages === 51, 'the page count comes from the page, got ' + item.pages);
        ok(item.source === 'page', 'a gallery-page bookmark reports source=page');
        ok(item.sourceUrl === 'https://nhentai.net/g/683215/', 'the source url is kept');
        ok(labelOf(button) === 'Bookmarked', 'the button flips to "Bookmarked" on the same click');
        ok(button.classList.contains('nhdw-title-bookmark-on'), 'the ON class is applied instantly too');
        ok(glyphPath(button) === FILLED, 'the filled glyph is drawn while ON');
        ok(button.getAttribute('aria-pressed') === 'true', 'aria-pressed flips to true');

        // Toggle off: composite key, because the row is "site:id".
        button.dispatch('click');
        await flush();
        const remove = context.chrome.sent.filter((m) => m.action === 'bookmarkRemove').pop();
        ok(remove !== undefined && remove.ids[0] === 'nhentai:683215',
            'clicking again removes by the composite key, got ' + JSON.stringify(remove && remove.ids));
        ok(labelOf(button) === 'Bookmark', 'the button paints back to "Bookmark"');
    }
    pass('click toggles the persistent bookmark list, with the page\'s own title, cover and page count');

    // --- 3. persistence: the stored list drives the paint ------------------
    {
        const stored = {};
        stored.bookmarkQueue = storedQueue([rowFor('hentaiera', '694133', { title: 'Stored' })]);
        const context = run({ url: SITES.hentaiera.url, build: SITES.hentaiera.build, store: stored });
        await flush();
        const button = buttonIn(context.document);
        ok(labelOf(button) === 'Bookmarked', 'a row already in chrome.storage.local renders as "Bookmarked" without a click');
        ok(button.classList.contains('nhdw-title-bookmark-on'), '...and carries the ON class');

        // The panel removes the row: the storage event repaints this button.
        const remaining = bookmarkQueueModule.removeBookmarks(
            bookmarkQueueModule.normalizeBookmarkState(stored.bookmarkQueue), ['hentaiera:694133']);
        stored.bookmarkQueue = remaining;
        context.chrome.emitChange('bookmarkQueue');
        await flush();
        ok(labelOf(button) === 'Bookmark', 'removing the row elsewhere repaints the button to "Bookmark"');
        ok(!button.classList.contains('nhdw-title-bookmark-on'), '...and drops the ON class');

        // A different site's row with the same numeric id must NOT match.
        const otherStore = {};
        otherStore.bookmarkQueue = storedQueue([rowFor('imhentai', '694133')]);
        const other = run({ url: SITES.hentaiera.url, build: SITES.hentaiera.build, store: otherStore });
        await flush();
        ok(labelOf(buttonIn(other.document)) === 'Bookmark',
            'an id that only collides on the bare number does not paint the button as bookmarked');
    }
    pass('the stored list is the source of truth for the button\'s state');

    // --- 4. no button where it does not belong -----------------------------
    {
        const listing = run({ url: 'https://nhentai.net/tag/big-adventures/', build: SITES.nhentai.build });
        await flush();
        ok(buttonIn(listing.document) === null, 'a listing page gets no bookmark button');
        listing.timers.tick();
        await flush();
        ok(buttonIn(listing.document) === null, '...and the retry timer never injects one either');
        ok(listing.timers.size === 0, '...and the retry timer is not left running');

        const reader = run({ url: 'https://nhentai.net/g/683215/3/', build: SITES.nhentai.build });
        await flush();
        ok(buttonIn(reader.document) === null, 'a reader page gets no bookmark button');
        reader.timers.tick();
        ok(buttonIn(reader.document) === null, '...and stays that way after a retry');

        const unknown = run({ url: 'https://example.com/g/1/', build: SITES.nhentai.build });
        await flush();
        ok(buttonIn(unknown.document) === null, 'an unsupported host gets no bookmark button');
    }
    pass('listing pages, reader pages and unsupported hosts are left alone');

    // --- 5. markup drift: text fallback, and never our own buttons --------
    {
        const drifted = makeEl('div');
        const context = run({
            url: 'https://nhentai.net/g/4242/',
            title: 'Drifted Gallery',
            build(document) {
                const holder = makeEl('div');
                holder.className = 'buttons';
                const fav = makeEl('a');
                fav.className = 'btn btn-primary';
                fav.textContent = 'Favorite (12)';
                const download = makeEl('a');
                download.className = 'btn btn-secondary';
                download.textContent = 'Download';
                holder.appendChild(fav);
                holder.appendChild(download);
                document.body.appendChild(holder);
                document.body.textContent = 'Favorite (12) Download';
            }
        });
        await flush();
        const button = buttonIn(context.document);
        ok(button !== null, 'a gallery page whose ids changed still gets the button (text anchor)');
        ok(button.parentElement === context.document.querySelector('.buttons'),
            '...inside the row it found');

        const own = run({
            url: 'https://nhentai.net/g/4243/',
            build(document) {
                const holder = makeEl('div');
                holder.className = 'buttons';
                const fav = makeEl('button');
                fav.className = 'btn btn-primary';
                fav.textContent = 'Add to favorites';
                holder.appendChild(fav);
                document.body.appendChild(holder);
                // Our own card controls also contain a button whose text is
                // "Download": it must never be mistaken for the site's row.
                const cardControls = makeEl('div');
                cardControls.className = 'nhdw-card-controls';
                const ourDownload = makeEl('button');
                ourDownload.className = 'nhdw-download';
                ourDownload.textContent = 'Download';
                cardControls.appendChild(ourDownload);
                document.body.appendChild(cardControls);
                document.body.textContent = 'Add to favorites Download';
            }
        });
        await flush();
        const ownButton = buttonIn(own.document);
        ok(ownButton !== null, 'our card controls do not hide the site\'s own favorite button');
        ok(ownButton.parentElement === own.document.querySelector('.buttons'),
            "the button was anchored on the SITE's favorite button, not our card control");
    }
    pass('markup drift is handled by a text anchor that skips our own controls');

    // --- 6. no anchor: nothing is injected, nothing breaks, no timer left --
    {
        const context = run({
            url: 'https://hentaifox.com/gallery/999999/',
            build(document) {
                document.body.textContent = 'a gallery page whose button row is missing';
            }
        });
        await flush();
        ok(buttonIn(context.document) === null, 'a gallery page with no anchor gets no button');
        for (let i = 0; i < 25; i++) context.timers.tick();
        await flush();
        ok(buttonIn(context.document) === null, '...and retrying does not inject a stray button');
        ok(context.timers.size === 0, '...and the bounded retry gives up instead of running forever');
    }
    pass('a page whose button row is missing is left untouched, with no timer left behind');

    // --- 7. JS-rendered rows: the bounded retry picks the row up ----------
    {
        const context = run({
            url: 'https://hitomi.la/galleries/4203493.html',
            build(document) {
                document.body.textContent = 'loading';
            }
        });
        await flush();
        ok(buttonIn(context.document) === null, 'hitomi: nothing to anchor to at load');
        // The site's own script renders the hero a moment later.
        const hero = makeEl('div');
        const download = makeEl('a', { id: 'dl-button', href: '#' });
        download.textContent = 'Download';
        hero.appendChild(download);
        context.document.body.appendChild(hero);
        context.timers.tick();
        await flush();
        const button = buttonIn(context.document);
        ok(button !== null, 'hitomi: the retry injects once the row appears');
        ok(button.parentElement === hero, 'hitomi: the button lands in the rendered row');
        ok(context.timers.size === 0, 'hitomi: the retry stops after a successful injection');
    }
    pass('a JavaScript-rendered button row is picked up, and the retry stops after it is');

    // --- 8. the Settings toggle owns this button too ----------------------
    {
        const off = run({
            url: SITES.nhentai.url,
            build: SITES.nhentai.build,
            settings: { inPageControls: false }
        });
        await flush();
        ok(buttonIn(off.document) === null, 'in-page controls switched off: the site toolbar is left untouched');
        for (let i = 0; i < 25; i++) off.timers.tick();
        await flush();
        ok(buttonIn(off.document) === null, 'in-page controls switched off: no button appears on a later retry');
        ok(off.timers.size === 0, 'in-page controls switched off: no timer is left running');

        const on = run({
            url: SITES.nhentai.url,
            build: SITES.nhentai.build,
            settings: { inPageControls: true }
        });
        await flush();
        ok(buttonIn(on.document) !== null, 'in-page controls switched on: the button is injected');

        const unset = run({ url: SITES.nhentai.url, build: SITES.nhentai.build });
        await flush();
        ok(buttonIn(unset.document) !== null, 'an unset toggle defaults to injected (the 3.7.0 default)');
    }
    pass('the Settings "In-page controls" toggle also governs the gallery-page Bookmark button');

    // --- 9. the sizing really is copied from the site's own button --------
    {
        // imhentai: anchor wears "tag btn btn-primary dl_btn"; our button must
        // pick up the three presentational classes and NOT the dl_btn hook.
        const imh = run({ url: SITES.imhentai.url, build: SITES.imhentai.build });
        await flush();
        const imhButton = buttonIn(imh.document);
        for (const name of ['tag', 'btn', 'btn-primary']) {
            ok(imhButton.classList.contains(name), 'imhentai: copied "' + name + '" from the site Download button');
        }
        ok(!imhButton.classList.contains('dl_btn'), 'imhentai: the dl_btn AJAX hook is NOT copied');
        ok(!imhButton.classList.contains('fav_btn'), 'imhentai: the fav_btn AJAX hook is NOT copied');

        // hentaifox: the same, on the site whose gallery markup we only know
        // through its ids — the copy is what carries the sizing there.
        const fox = run({ url: SITES.hentaifox.url, build: SITES.hentaifox.build });
        await flush();
        const foxButton = buttonIn(fox.document);
        ok(foxButton.parentElement === fox.document.querySelector('.g_buttons'),
            'hentaifox: the button lands in the gallery button row');
        ok(foxButton.classList.contains('btn') && foxButton.classList.contains('btn-primary'),
                "hentaifox: the anchor's own classes are copied for sizing");
        ok(!foxButton.classList.contains('dl_btn'), "hentaifox: the anchor's behavior hook stays behind");
        ok(labelOf(foxButton) === 'Bookmark', 'hentaifox: the label is right on the uncaptured row');

        // hentaifox: the page count comes from the info box, and the title from
        // the <h1> inside it.
        foxButton.dispatch('click');
        await flush();
        const foxAdd = fox.chrome.sent.filter((m) => m.action === 'bookmarkAdd').pop();
        ok(foxAdd !== undefined, 'hentaifox: clicking Bookmark sends bookmarkAdd');
        ok(foxAdd.items[0].pages === 24, 'hentaifox: the page count is read from div.info, got ' + foxAdd.items[0].pages);
        ok(foxAdd.items[0].title === 'The Girllove Diary', 'hentaifox: the title is read from div.info h1, got ' + JSON.stringify(foxAdd.items[0].title));
        ok(foxAdd.items[0].thumbnail === 'https://i.hentaifox.com/005/4190711/cover.jpg',
            'hentaifox: the cover is read from div.cover img, got ' + foxAdd.items[0].thumbnail);

        // The title input fallback (both hentaifox and imhentai publish one).
        const inputTitle = run({
            url: 'https://imhentai.xxx/gallery/4242/',
            build(document) {
                const holder = makeEl('div');
                holder.className = 'g_buttons';
                const fav = makeEl('button', { id: 'add_fav_btn' });
                fav.className = 'tag btn btn-primary fav_btn';
                fav.textContent = 'Favourite (0)';
                const download = makeEl('button', { id: 'dl_new' });
                download.className = 'tag btn btn-primary dl_btn';
                download.textContent = 'Download (0)';
                holder.appendChild(fav);
                holder.appendChild(download);
                document.body.appendChild(holder);
                const hidden = makeEl('input', { id: 'gallery_title' });
                hidden.value = 'Title From The Hidden Input';
                hidden.setAttribute('value', 'Title From The Hidden Input');
                document.body.appendChild(hidden);
                document.body.textContent = 'Favourite (0) Download (0)';
            }
        });
        await flush();
        buttonIn(inputTitle.document).dispatch('click');
        await flush();
        const inputAdd = inputTitle.chrome.sent.filter((m) => m.action === 'bookmarkAdd').pop();
        ok(inputAdd.items[0].title === 'Title From The Hidden Input',
            'a title published only in a hidden <input value> is still picked up, got ' + JSON.stringify(inputAdd.items[0].title));
    }
    pass("the button copies the site button's own presentational classes, and never its behavior hooks");


    // --- 10. Smart Download + Select on the gallery page (items 62b / 64b) --
    // The gallery page is where every site puts its OWN Download button, so
    // ours has to be visually and verbally distinct, and it has to know which
    // site it is on: a job sent from hentaifox must never be fetched through
    // the nhentai route.
    {
        const listSettings = {
            listFormat: 'cbz',
            listOutputMode: 'batch',
            listMasterFolder: true,
            rawMasterFolder: 'NHDW',
            listDownloadName: '{pretty}'
        };
        for (const site of Object.keys(SITES)) {
            const fixture = SITES[site];
            const context = run({ url: fixture.url, build: fixture.build, settings: Object.assign({}, listSettings) });
            await flush();
            const save = context.document.querySelector('[data-nhdw-title-save]');
            ok(save !== null, site + ': a Smart Download control is injected on the gallery page (item 62b)');
            ok(save.textContent === 'Save offline',
                site + ': the control is labelled "Save offline" (never the site\'s own "Download"), got ' + JSON.stringify(save.textContent));
            ok(save.classList.contains('nhdw-title-save'), site + ': the Smart Download control is namespaced');
            const bookmark = buttonIn(context.document);
            ok(save.parentElement === bookmark.parentElement,
                site + ': the control joins the site\'s own button row');
            ok(save.parentElement.children.indexOf(save) === save.parentElement.children.indexOf(bookmark) + 1,
                site + ': Save offline sits directly after Bookmark');
            for (const name of save.className.split(/\s+/)) {
                ok(!/_btn$|^js[-_]|-trigger$/i.test(name),
                    site + ': the site behavior hook "' + name + '" must not be copied onto our control');
            }
            save.dispatch('click');
            await flush();
            const job = context.chrome.sent.filter((m) => m.action === 'downloadAllDoujinshis').pop();
            ok(job !== undefined, site + ': clicking Save offline sends downloadAllDoujinshis');
            ok(job.site === site, site + ': the job names its site, got ' + JSON.stringify(job && job.site));
            ok(Object.keys(job.allDoujinshis).length === 1,
                site + ': a Smart Download is one gallery, got ' + JSON.stringify(job.allDoujinshis));
            ok(job.formatOverride === 'cbz', site + ': the list-mode format travels with the job, got ' + job.formatOverride);
            ok(job.separate === true, site + ': one title is always one artifact (never a merged batch)');
            ok(job.masterFolder === 'NHDW', site + ': the optional master folder travels with the job, got ' + job.masterFolder);
            ok(typeof job.nameTemplate === 'string' && job.nameTemplate !== '',
                site + ': the list-mode name template travels with the job');
            ok(Array.isArray(job.redownloadIds) && job.redownloadIds.length === 0,
                site + ': nothing is force-re-downloaded without a history hit');
        }
        pass('every gallery page gets a site-aware "Save offline" control beside Bookmark (item 62b)');

        // Alt-click opens the existing download form instead of downloading.
        {
            const context = run({ url: SITES.nhentai.url, build: SITES.nhentai.build, settings: Object.assign({}, listSettings) });
            await flush();
            const save = context.document.querySelector('[data-nhdw-title-save]');
            save.dispatch('click');
            await flush();
            const before = context.chrome.sent.length;
            save.dispatch('click', { altKey: true });
            await flush();
            const sent = context.chrome.sent.slice(before);
            ok(sent.filter((m) => m.action === 'downloadAllDoujinshis').length === 0,
                'Alt-clicking Save offline starts no download (it opens the existing form)');
            ok(sent.filter((m) => m.action === 'siteUiOpenPanel').length === 1,
                'Alt-click asks the worker to open the panel: a content script has no chrome.sidePanel');
            ok(save.disabled === false, 'the control stays usable after the secondary affordance');
        }
        pass('the secondary affordance opens the download form instead of downloading');

        // History guard: an already-downloaded title asks before re-fetching.
        {
            const store = { downloadHistory: { 'nhentai:683215': { filename: 'Old/One.cbz', when: 1 } } };
            const declined = run({
                url: SITES.nhentai.url, build: SITES.nhentai.build,
                settings: Object.assign({}, listSettings),
                store: Object.assign({}, store),
                window: { confirm: () => false }
            });
            await flush();
            declined.document.querySelector('[data-nhdw-title-save]').dispatch('click');
            await flush();
            ok(declined.chrome.sent.filter((m) => m.action === 'downloadAllDoujinshis').length === 0,
                'declining the re-download question sends nothing');
            const confirmed = run({
                url: SITES.nhentai.url, build: SITES.nhentai.build,
                settings: Object.assign({}, listSettings),
                store: Object.assign({}, store),
                window: { confirm: () => true }
            });
            await flush();
            confirmed.document.querySelector('[data-nhdw-title-save]').dispatch('click');
            await flush();
            const job = confirmed.chrome.sent.filter((m) => m.action === 'downloadAllDoujinshis').pop();
            ok(job !== undefined, 'confirming the re-download question sends the job');
            ok(job.redownloadIds.join(',') === '683215',
                'the confirmed id travels as redownloadIds, got ' + JSON.stringify(job.redownloadIds));
        }
        pass('Save offline keeps the history guard: it asks before re-downloading a recorded title');

        // Select: the gallery page writes the SAME shared list the cards use.
        {
            const context = run({
                url: SITES.nhentai.url, build: SITES.nhentai.build,
                settings: Object.assign({}, listSettings), store: {}
            });
            await flush();
            const select = context.document.querySelector('[data-nhdw-title-select]');
            ok(select !== null, 'a Select control is injected beside Save offline (item 64b)');
            ok(select.textContent === 'Select', 'the control starts unselected, got ' + JSON.stringify(select.textContent));
            select.dispatch('click');
            await flush();
            ok((context.chrome.store.allIds || []).join(',') === '683215',
                'Select writes the bare gallery id into the shared allIds list, got ' + JSON.stringify(context.chrome.store.allIds));
            ok(context.chrome.store.allIdsSite === 'nhentai',
                'the selection is namespaced by site, got ' + String(context.chrome.store.allIdsSite));
            ok(select.textContent === 'Selected', 'the control reads "Selected" once selected');
            ok(select.getAttribute('aria-pressed') === 'true', 'aria-pressed follows the selection');
            select.dispatch('click');
            await flush();
            ok((context.chrome.store.allIds || []).length === 0,
                'clicking again takes the title back out of the shared list, got ' + JSON.stringify(context.chrome.store.allIds));
            ok(select.textContent === 'Select', 'the control returns to "Select"');
        }
        pass('the gallery-page Select writes into the same shared selection as the cards (item 64b)');

        // A selection made on another site must not survive onto this one.
        {
            const context = run({
                url: SITES.nhentai.url, build: SITES.nhentai.build,
                settings: Object.assign({}, listSettings),
                store: { allIds: ['173098'], allIdsSite: 'hentaifox' }
            });
            await flush();
            ok((context.chrome.store.allIds || []).length === 0,
                'a hentaifox selection is dropped on a nhentai page, got ' + JSON.stringify(context.chrome.store.allIds));
            ok(context.chrome.store.allIdsSite === 'nhentai',
                'the page re-stamps the selection with its own site, got ' + String(context.chrome.store.allIdsSite));
            const select = context.document.querySelector('[data-nhdw-title-select]');
            ok(select !== null && select.textContent === 'Select', 'the control renders unselected for the other site\'s ids');
        }
        pass('a selection never follows the user across sites');
    }

    console.log('');
    console.log(checks + ' checks passed.');
}

main().catch((error) => {
    console.error('FAIL: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
});
