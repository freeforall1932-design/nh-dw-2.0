'use strict';
// Offline checks for the DevTools capture helper. No browser/network needed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { URL } = require('url');
const source = fs.readFileSync(path.join(__dirname, 'capture-site-structure.js'), 'utf8');
const guide = fs.readFileSync(path.join(__dirname, '..', 'SITE_CAPTURE_GUIDE.md'), 'utf8');
const embedded = guide.match(/## Console helper[\s\S]*?```js\n([\s\S]*?)```/);
assert.ok(embedded, 'guide must contain the pasteable helper');
assert.strictEqual(embedded[1], source, 'guide and tested helper must stay identical');

class Element {
    constructor(tag, { id = '', classes = [], attrs = {}, currentSrc = '', children = [] } = {}) {
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.classList = classes;
        this.attributeMap = attrs;
        this.attributes = Object.keys(attrs).map((name) => ({ name }));
        this.currentSrc = currentSrc;
        this.children = children;
        this.parentElement = null;
        for (const child of children) child.parentElement = this;
    }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributeMap, name); }
    getAttribute(name) { return this.attributeMap[name]; }
    querySelectorAll(selector) {
        assert.strictEqual(selector, 'img');
        const found = [];
        const walk = (node) => {
            for (const child of node.children) {
                if (child.tagName === 'IMG') found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }
}

function run(selected, withCopy = true) {
    let clipboard;
    const messages = [];
    const context = {
        $0: selected, URL,
        location: { hostname: 'sasangeyou.net', href: 'https://sasangeyou.net/sensitive-page?session=never-share#private' },
        document: { scripts: [{ textContent: 'ts_reader.run({"images":["private-script-value"]});' }] },
        console: { info: (...args) => messages.push(args), warn: (...args) => messages.push(args), log: (...args) => messages.push(args) },
        fetch: () => { throw new Error('The capture helper must not perform network requests'); }
    };
    if (withCopy) context.copy = (text) => { clipboard = text; };
    vm.runInNewContext(source, context, { timeout: 1000 });
    return { clipboard, messages };
}

const image = new Element('img', {
    id: 'reader-page-1', classes: ['page', 'session-secret'],
    attrs: { src: 'https://name:password@cdn.example.test/private/story.jpg.webp?signature=never-share#fragment', 'data-token': 'hidden-token' },
    currentSrc: 'https://cdn.example.test/private/story.jpg.webp?signature=never-share'
});
const other = new Element('img', { attrs: { 'data-src': 'https://cdn.example.test/private/other.jpg?key=never-share' } });
const reader = new Element('div', { id: 'readerarea', classes: ['reading-content'], children: [image, other] });
new Element('main', { id: 'session-super-secret', children: [reader] });
const result = run(image);
const captured = JSON.parse(result.clipboard);
assert.strictEqual(captured.hasTsReaderMarker, true);
assert.strictEqual(captured.selected.tag, 'img');
assert.strictEqual(captured.selected.urls.src.host, 'cdn.example.test');
assert.strictEqual(captured.selected.urls.src.pathShape, '/{redacted}/{file}.jpg.webp');
assert.strictEqual(captured.selected.urls.src.suffix, '.jpg.webp');
assert.strictEqual(captured.ancestors[0].id, 'readerarea');
assert.strictEqual(captured.imageSamples.count, 2);
assert.deepStrictEqual(captured.selected.classes, ['page']);
for (const privateValue of ['never-share', 'password', 'hidden-token', '/private/', 'story', 'session-super-secret', 'private-script-value']) {
    assert.ok(!result.clipboard.includes(privateValue), 'output leaked: ' + privateValue);
}

const button = new Element('a', { id: 'download', attrs: { href: 'https://nhentai.net/g/76543/download/?sig=never-share#secret' } });
const buttonResult = run(button);
const buttonCapture = JSON.parse(buttonResult.clipboard);
assert.strictEqual(buttonCapture.selected.urls.href.host, 'nhentai.net');
assert.strictEqual(buttonCapture.selected.urls.href.pathShape, '/g/{number}/download/');
assert.strictEqual(buttonCapture.selected.urls.href.route, '/g/{id}/download');
assert.ok(!buttonResult.clipboard.includes('76543'));
assert.ok(!buttonResult.clipboard.includes('never-share'));

const noSelection = run(null);
assert.strictEqual(noSelection.clipboard, undefined);
assert.ok(noSelection.messages.some((entry) => String(entry[0]).includes('Select a page element')));
const fallback = run(button, false);
assert.ok(fallback.messages.some((entry) => String(entry[0]).includes('"captureVersion"')));
console.log('PASS: selected structure, URL redaction, button route shape and no-selection behavior');
