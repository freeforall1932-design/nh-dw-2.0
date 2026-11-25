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
  // Generic React Router reader (no recipe): one unambiguous URL list.
  fs.writeFileSync(out + '/generic-reader.data', await text({
    'root': { data: {} },
    'routes/read.$id': { data: { chapter: { title: 'Chapter 9', images: ['https://cdn.reader.example/9/1.jpg', 'https://cdn.reader.example/9/2.png'] } } }
  }));
})();
