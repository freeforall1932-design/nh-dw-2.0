# Capture only the missing site details

This guide covers the **Sasangeyou chapter reader**, an optional **batch link**,
and nhentai.net's **own Download button**. You do not need to provide images,
files, passwords, cookies, API keys, signed URLs, network logs or HAR files.
Use one of the unflagged examples you already supplied. You may send the reader
result first; the other observations can follow separately. These steps use a
desktop browser. If you only have a phone, tell me the browser and device;
you can still report what the chapter and buttons visibly do.

The small Console helper below reads the selected page element's tag, structural
IDs/classes, attribute **names**, image counts and URL **hostnames/suffixes**.
URL path shapes use placeholders plus a short whitelist of common structural
segments; original paths, queries and fragments are not copied. It also reports
whether an inline script contains the `ts_reader.run` marker, without copying the
script contents. It does **not** click controls, send requests, read cookies or
storage, or copy image data. Review the output before sharing: hostnames and
structural names are retained, so remove any unexpected personal information.
The same helper is also in [`tools/capture-site-structure.js`](tools/capture-site-structure.js).

## 1. Sasangeyou: the page that actually displays a chapter

1. On a desktop Chromium browser, open the **chapter reader you already gave**
   and let an actual chapter page appear. Do not use a batch entry for this.
2. Press **F12** to open Developer Tools. Click the inspect-element icon (or
   press **Ctrl+Shift+C**), then click one of the chapter's page images. The
   **Elements** tab should highlight the corresponding element. If an overlay
   is selected instead, in Elements press **Ctrl+F**, try `readerarea`, expand
   the result and select a page `<img>`; if it is not found, just tell me.
3. Switch to **Console**, copy the helper below, paste it, and press **Enter**.
   Chrome may show a self-XSS warning; only use a snippet you have reviewed.
   The selected Elements node remains available as `$0` in the Console.
4. The result is copied to the clipboard. Paste it into a text editor, review
   it, and send the text here. If it says to select an element, repeat step 2.
   If it prints the result instead of copying, copy that printed JSON.
5. Tell me whether the chapter displays normally, and whether you selected
   Server 1 or Server 2. Do not send the actual page images or media URLs.

The helper samples the nearest ancestor with multiple images. It may include
logos or other page images; this is useful diagnostic data, not a claim that
all sampled images belong to the chapter. No refresh or Network capture is
needed for this part.

## 2. Optional: a batch link for the same title

1. On the **title's own chapter list**, find its Batch entry if it has one;
   do not use a Batch label under **Related Series**. If none is visible, say
   "no batch seen" rather than assuming it is expired.
2. If convenient, select that entry or its link in **Elements** and run the
   same helper. It records only the destination hostname, not its secret path.
3. Open it normally only if you wish, and say what you see: a mirror list,
   shortener, host page, login/CAPTCHA, explicit "file not found/expired", or
   something else. Do not submit passwords, solve access challenges for this
   capture, install anything, or send the file or full/signed link. A blocked
   or unknown host is **not** the same as an expired file.

## 3. nhentai.net: the website's own Download button

1. Open a gallery you can normally access. Use the **website's Download**
   button, not the extension's **Save offline** button. First select the
   website button in **Elements** and run the same helper if possible.
2. In Developer Tools, open **Network** and click the clear icon. Click the
   website's Download button **once** as you normally would.
3. If a new Fetch/XHR or Document request appears, select the request caused
   by that click and open **Headers → General**. Record only its **method**
   (GET/POST), **status**, and **hostname**. If obvious, also give a path shape
   with gallery IDs and unique components replaced by `{id}` or `{redacted}`;
   omit the query and fragment. Under **Response Headers**, `Content-Type` is
   useful if visible. Do not copy request/response bodies or other headers.
4. Tell me what the button did: started a file download, opened a menu, asked
   for login, showed an error, or something else. If no request appears, just
   say so. You do **not** need to upload the file or share an API key.

Suggested notes:

```text
Reader: displayed normally? selected server?
Batch (optional): not seen / host / mirror / shortener / explicitly expired / other
NH button: label, visible result, method, status, hostname, optional redacted path shape, Content-Type
```

## Console helper — use for either site

Copy the entire block below after selecting the relevant element in Elements:

```js
/*
 * Paste this into the Chrome/Edge/Brave DevTools Console after selecting an
 * element in Elements. It reads local DOM structure and checks for a reader
 * marker in inline scripts; it does not click, fetch, send requests, read
 * cookies/storage, or copy script contents or media bytes.
 *
 * The output includes public hostnames, short structural IDs/classes, and
 * attribute NAMES, and URL path shapes using placeholders and a short
 * whitelist of structural segments. Other values, queries and fragments are
 * not copied. No original URL path or request headers are included.
 * Review the result before sharing it; remove any unexpected personal data.
 */
(() => {
    const selected = typeof $0 === 'undefined' ? null : $0;
    if (!selected || selected.nodeType !== 1) {
        console.warn('Select a page element in the Elements tab, then run this again.');
        return;
    }

    const sensitive = /token|secret|cookie|csrf|nonce|session|password|passwd|authorization|auth|apikey|api[-_]?key|email|user|account|signed/i;
    function structuralName(value) {
        const name = typeof value === 'string' ? value : '';
        if (!/^[a-z_][a-z0-9_-]{0,47}$/i.test(name) || sensitive.test(name) || /\d{5,}/.test(name)) return null;
        return name;
    }
    function safeHost(host) {
        if (!host || sensitive.test(host) || host.split('.').some((part) => part.length > 48)) return '[redacted-host]';
        return host;
    }
    function summarizeUrl(value) {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) return { kind: 'empty' };
        if (raw[0] === '#') return { kind: 'fragment' };
        if (/^(?:data|blob):/i.test(raw)) return { kind: 'inline-or-blob' };
        try {
            const url = new URL(raw, location.href);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'other-scheme' };
            const suffix = url.pathname.match(/(?:\.(?:jpg|jpeg|png|webp|gif|avif|zip|cbz|pdf)){1,2}$/i);
            const extension = suffix ? suffix[0].toLowerCase() : null;
            const known = new Set(['wp-content', 'uploads', 'galleries', 'images', 'manga', 'api', 'v2', 'g', 'download']);
            const segments = url.pathname.split('/');
            const pathShape = segments.map((part, index) => {
                if (!part) return '';
                if (known.has(part.toLowerCase())) return part.toLowerCase();
                if (/^\d+$/.test(part)) return '{number}';
                if (index === segments.length - 1 && extension) return '{file}' + extension;
                return '{redacted}';
            }).join('/');
            const result = { kind: 'http', host: safeHost(url.hostname), pathShape: pathShape, suffix: extension };
            if (url.hostname === 'nhentai.net') {
                if (/^\/api\/v2\/galleries\/\d+\/download\/?$/.test(url.pathname)) {
                    result.route = '/api/v2/galleries/{id}/download';
                } else if (/^\/g\/\d+\/download\/?$/.test(url.pathname)) {
                    result.route = '/g/{id}/download';
                }
            }
            return result;
        } catch (_) {
            return { kind: 'unparseable' };
        }
    }
    const urlAttributes = ['href', 'action', 'formaction', 'src', 'data-src', 'data-lazy-src', 'data-original', 'data-url'];
    function describe(element) {
        const urls = {};
        for (const name of urlAttributes) {
            if (element.hasAttribute(name)) urls[name] = summarizeUrl(element.getAttribute(name));
        }
        if (element.tagName.toLowerCase() === 'img' && element.currentSrc) {
            urls.currentSrc = summarizeUrl(element.currentSrc);
        }
        return {
            tag: element.tagName.toLowerCase(),
            id: structuralName(element.id),
            classes: Array.from(element.classList).map(structuralName).filter(Boolean).slice(0, 20),
            attributeNames: Array.from(element.attributes).map((attribute) => attribute.name).slice(0, 40),
            descendantImageCount: element.querySelectorAll('img').length,
            urls: urls
        };
    }
    const nodes = [];
    for (let node = selected; node && nodes.length < 7; node = node.parentElement) nodes.push(node);
    const container = nodes.find((node) => node.querySelectorAll('img').length >= 2);
    let imageSamples = null;
    if (container) {
        const images = Array.from(container.querySelectorAll('img'));
        const indices = Array.from(new Set([0, 1, 2, images.length - 3, images.length - 2, images.length - 1]))
            .filter((index) => index >= 0 && index < images.length).sort((a, b) => a - b);
        imageSamples = {
            note: 'First and last images inside the nearest ancestor with at least two images; this may include unrelated images.',
            count: images.length,
            samples: indices.map((index) => ({ index: index, element: describe(images[index]) }))
        };
    }
    // Presence only: never copy an inline script or its embedded URLs.
    const hasTsReaderMarker = Array.from(document.scripts).some((script) =>
        /\bts_reader\s*\.\s*run\s*\(/.test(script.textContent || '')
    );
    const result = {
        captureVersion: 1,
        pageHost: safeHost(location.hostname),
        hasTsReaderMarker: hasTsReaderMarker,
        selected: describe(selected),
        ancestors: nodes.slice(1).map(describe),
        imageSamples: imageSamples
    };
    const text = JSON.stringify(result, null, 2);
    if (typeof copy === 'function') {
        copy(text);
        console.info('Sanitized structure copied. Paste into a text editor, review it, then share.');
    } else {
        console.info('Copy the sanitized structure below, review it, then share:');
        console.log(text);
    }
})();
```
