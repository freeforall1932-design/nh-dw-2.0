# Tailspace / React Router page-data fixtures

`comic-101.data`, `comic-102.data`, `comic-103.data` are what
`https://tailspace.com/c/<slug>.data?_routes=routes/pages/comic/ComicPage`
returns in shape: turbo-stream v2 text produced by the official encoder
(`generate.js`, turbo-stream 2.4.1, MIT). **All data is synthetic**: a
three-part linked series ("Scale Train") with unsorted pages, a missing
`fileType` (old comics default to jpg), png/webp pages, shared references, a
deferred value on a later `P` line, a Map, dates, NaN and undefined. Part 3
states `numberOfPages: 3` but lists 2 pages, to exercise the mismatch warning.

`generic-reader.data` is an unknown React Router reader with one unambiguous
`images` URL list (generic fallback, no recipe).

Shape sources: keiyoushi/extensions-source `src/en/tailspace` (Apache-2.0) and
cofob/memesave-bot `scraper/src_tailspace.go` (facts only). No live site was
fetched; the first real run should confirm the endpoint and the image CDN.
