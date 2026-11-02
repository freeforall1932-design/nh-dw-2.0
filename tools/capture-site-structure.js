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
