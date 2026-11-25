// Regenerates the *.data fixtures with the OFFICIAL turbo-stream encoder (MIT),
// the v2 format react-router 7 bundles. Not run by the test suite.
//   cd /tmp && npm pack turbo-stream@2.4.1 && tar -xzf turbo-stream-2.4.1.tgz
//   node generate.js /tmp/package <this folder>
// All data is synthetic, shaped like keiyoushi's Tailspace DTOs.
const { encode } = require(require('path').resolve(process.argv[2], 'dist/turbo-stream.js'));
const fs = require('fs');
async function text(value) {
  const reader = encode(value).getReader(); let out = ''; const dec = new TextDecoder();
  for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; out += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true }); }
  return out;
}
const sharedTag = { id: 7, name: 'dragon', category: 'species' };
function comic(id, slug, name, prev, next, pages, numberOfPages = pages.length) {
  return { id, name, slug, numberOfPages, description: '{"type":"doc","content":[]}', category: 'Male', isSfw: false, state: 'wip',
    thumbnailVersion: 2, artist: { name: 'Fixture Artist' }, additionalArtists: [], tags: [sharedTag, { id: 9, name: 'train', category: null }],
    pages, published: new Date(Date.UTC(2026, 9, id - 100)), previousComic: prev ? { slug: prev } : null, nextComic: next ? { slug: next } : null };
}
const out = process.argv[3];
(async () => {
  const parts = [
    comic(101, 'Scale Train', 'Scale Train - Chapter 1', null, 'Scale Train 2',
      // deliberately unsorted; fileType missing / png / webp
      [{ token: 'b2', pageNumber: 2, fileType: 'png' }, { token: 'a1', pageNumber: 1 }, { token: 'c3', pageNumber: 3, fileType: 'webp' }]),
    comic(102, 'Scale Train 2', 'Scale Train - Chapter 2', 'Scale Train', 'Scale Train 3', [{ token: 'd4', pageNumber: 1, fileType: 'jpg' }]),
    comic(103, 'Scale Train 3', 'Scale Train - Chapter 3', 'Scale Train 2', null, [{ token: 'e5', pageNumber: 1, fileType: 'jpg' }, { token: 'f6', pageNumber: 2, fileType: 'jpg' }], 3)
  ];
  for (const c of parts) {
    const body = await text({
      'root': { data: { user: null, flags: new Map([['beta', true]]) } },
      'routes/pages/comic/ComicPage': { data: {
        comic: c,
        // a deferred value (resolved on a later "P" line), with card thumbnails
        // under "images" that must never be mistaken for the page list
        related: Promise.resolve([{ slug: 'Other', images: ['https://pics.tailspace.com/comics/999/thumbnail-2x.webp'] }]),
        viewedAt: new Date(Date.UTC(2026, 10, 24)), missing: undefined, ratio: NaN
      } }
    });
    fs.writeFileSync(out + '/comic-' + c.id + '.data', body);
  }
  // The same comic as a server-rendered page (built-in site, HTML fallback):
  // react-router 7.9 streams the data into <script> tags exactly like this
  // (StreamTransfer: escapeHtml(JSON.stringify(chunk)) per chunk). The stream
  // is split mid-value on purpose, so the reader must join the chunks.
  const ESCAPE = { '&': '\\u0026', '>': '\\u003e', '<': '\\u003c', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  const rrEscape = (html) => html.replace(/[&><\u2028\u2029]/g, (m) => ESCAPE[m]);
  const pageStream = fs.readFileSync(out + '/comic-101.data', 'utf8');
  const cut = Math.floor(pageStream.length / 2);
  const script = (chunk) => '<script>window.__reactRouterContext.streamController.enqueue(' + rrEscape(JSON.stringify(chunk)) + ');</script>';
  fs.writeFileSync(out + '/comic-101.html', '<!DOCTYPE html><html lang="en"><head><title>Scale Train - Chapter 1 | Tailspace</title></head><body>' +
    '<div id="root"><h1>Scale Train - Chapter 1</h1><img src="https://pics.tailspace.com/comics/101/a1-mini.jpg"></div>' +
    '<script>window.__reactRouterContext = {"basename":"/","future":{},"isSpaMode":false};window.__reactRouterContext.stream = new ReadableStream({start(controller){window.__reactRouterContext.streamController = controller;}}).pipeThrough(new TextEncoderStream());</script>' +
    script(pageStream.slice(0, cut)) + script(pageStream.slice(cut)) +
    '<script>window.__reactRouterContext.streamController.close();</script></body></html>');
  // A comic the site does not have: the loader answers comic: null.
  fs.writeFileSync(out + '/comic-missing.data', await text({
    'root': { data: { user: null } },
    'routes/pages/comic/ComicPage': { data: { comic: null } }
  }));
  // A comic whose server extension is "jpeg" (kept exactly in the image URL)
  // and whose title carries characters HTML must escape.
  fs.writeFileSync(out + '/comic-104.data', await text({
    'routes/pages/comic/ComicPage': { data: { comic: comic(104, 'Tom & Jerry: <Part 1>', 'Tom & Jerry: <Part 1>', null, null,
      [{ token: 'g7', pageNumber: 1, fileType: 'jpeg' }, { token: 'h8', pageNumber: 2, fileType: 'gif' }]) } }
  }));
  // Generic React Router reader (no recipe): one unambiguous URL list.
  fs.writeFileSync(out + '/generic-reader.data', await text({
    'root': { data: {} },
    'routes/read.$id': { data: { chapter: { title: 'Chapter 9', images: ['https://cdn.reader.example/9/1.jpg', 'https://cdn.reader.example/9/2.png'] } } }
  }));
})();
