# Universal chapter collector (Chromium, experimental)

A user-driven way to save **one open chapter** or **a title's chapters** from a
normally accessible website as ordered image archives — without adding that
website to the extension's built-in site list, without `host_permissions`, and
without any mirror/batch resolver.

This is deliberately *not* "support for every website". It is a generic reader
that only works where the user can supply a working CSS selector and the site
serves ordinary HTML. Nothing has been validated against a live site yet.

## Where it lives

| Piece | Path |
|---|---|
| Panel tab button (`Chapters ↗`, opens a new tab) | `index.html`, `src/preview/preview.ts` |
| Collector page | `chapters.html`, `css/chapters.css`, `src/chapters/chapters.ts` |
| Injected probe (only after the user opens the tool) | `src/content/universalChapterProbe.ts` |
| Pure discovery/extraction helpers | `src/utils/universalChapter.ts` |
| Sequential archive executor | `src/utils/universalChapterBatch.ts` |
| Relay guard in the service worker | `src/background/background.ts` |
| Tests | `test/universal-chapter.test.js`, `scripts/e2e-universal.js`, `scripts/e2e-chapter-relay.js` |

## Workflow

1. Open the title (or a single chapter) in a tab.
2. Extension panel → **Chapters ↗**. A blank extension page opens bound to that tab.
3. **Find chapters**
   - *Add chapter URLs* takes one chapter URL per line (same site as the source
     tab) when you only want specific chapters, without scanning a title.
   - *Scan / add title page* collects links matching the given CSS selector.
   - Only links on the same HTTPS origin under the title's path are kept unless
     **Include links outside the title path** is enabled.
   - If the title list is paginated (many WordPress/manga themes are), navigate
     the source tab to the next list page and scan again. The tool never guesses
     hidden pages, sorts by number, or follows "related series".
   - *Use open chapter* records only the currently open chapter.
4. Tick exactly the chapters you want, then state the **order of the collected
   list** (oldest→newest, or newest→oldest for reversing a typical listing).
   The order is never inferred from labels.
5. **Inspect the selected readers** with a selector that matches only page
   images. Static chapter HTML is fetched and parsed as data; `src`, `data-src`,
   `data-lazy-src` and `data-original` are supported. If one element has
   different values in several attributes, the automatic mode refuses and asks
   for an explicit attribute instead of guessing full-size vs thumbnail.
   The chosen **page order** is then applied (see below) and the review shows the
   resolved order, e.g. `Chapter 1 — 7 image reference(s) · sorted by page links
   (differs from reader order — verify): #1 pics.example/…-mini.jpg, …`.
6. **Save**: pick a folder name and CBZ/ZIP, approve each discovered image host,
   tick the confirmation, and press the save button. One archive per chapter,
   named `001 - <label>.cbz` under the title folder, pages `001.jpg`, `002.png`…
   Hosts approved for this exact site are remembered (pre-ticked next time, still
   listed so any one can be unticked for a run), and chapters recorded as already
   saved are skipped — both on by default, both revocable in the same step.
7. **If something went wrong**: press **Run benchmark and save log** (step 04).
   It re-checks the open page read-only and writes `nhdw-log-<timestamp>.txt` to
   your downloads. See [BENCHMARK_GUIDE.md](BENCHMARK_GUIDE.md).

## Page order when image names are meaningless

Reader-embedded galleries often use hashed file names, so sorting by file name
is worthless: Tailspace (checked only through its public page text) lists a
seven-page comic as `…/a1B2c3D4e5F6g7H8-mini.jpg` (illustrative placeholder), etc., with the page
number living in the link (`?page=1 … ?page=7`) and the caption (`page 1`).
The tool therefore offers three explicit strategies:

| Strategy | Signal | Refuses when |
|---|---|---|
| Reader order (default) | the order the reader/DOM lists them — for a top-down reader this *is* page 1, 2, 3… | never (nothing is reordered) |
| Page links | `data-page`/`data-index`/`data-number`, then `?page=N`/`?p=N`/`?pg=N` or a `/page-N/` path on the nearest enclosing link, then “page N” in `alt`/`title` | any page lacks a number, or two pages share one |
| File numbers | numeric groups of the final URL segment, compared numerically (`2` before `10` before `100`) | any name has no digits (hashes, word-only names), or two names collide |

The review line states which strategy ran, flags reordering that differs from the
reader order, and previews the first four resolved pages so a wrong guess is
visible before saving. Nothing is ever fuzzy-matched or silently re-sorted.

## Top-down / scroll readers (random file names are fine)

A vertical reader lists every page as an image, so **page 1 is simply the first
image in document order** — no file name is involved. That is the default
`Reader order` strategy, and it is why random hashes (Tailspace, DoujinDesu) are
not a problem *when the reader is top-down*.

Two helpers make that reliable:

- **Advertised page count.** The tool reads a total the reader states
  (`data-total-pages`, `data-page-count`, `data-pages`, or visible counters such
  as `3 / 57`, `Page 3 of 57`, `57 pages`) from live or fetched HTML. If the
  number of images found differs, the review shows a warning with
  `found 2 of 3`; nothing is silently reordered or dropped. Ambiguous or
  conflicting totals are ignored rather than guessed.
- **`Load all pages (top-down)`.** Lazy readers only materialize images near the
  viewport. With one chapter open via *Use open chapter*, this scrolls the source
  tab from top to bottom (bounded: ≤ 80 steps, ~120 ms each, stops when the page
  height stops growing, restores your scroll position, aborts on Cancel) so the
  rest of the pages exist in the DOM. Then press *Inspect*.

For readers that only build images after their own scripts run (an obfuscated
API, for instance), *Use open chapter* is the only path — the page has already
decoded its URLs by the time the tool reads them. Static-HTML inspection finds
nothing there. That means such a site is currently **one chapter at a time**;
batch-opening chapters sequentially is on the worklist, not implemented.

## Partial chapters (your "download all instead of nothing")

`Keep incomplete chapters` (on by default) changes only what a *recoverable*
page failure does:

- pages that already arrived are written as
  `001 - <label> (incomplete 4 of 12 pages).cbz`, and the run summary lists
  `1 incomplete: <label> (4 of 12)`;
- if the failure happened on the first page (nothing usable), that chapter is
  reported as `failed` and the **rest of the batch still runs**;
- with the option off, the chapter is simply reported as `failed` — no partial
  file. Either way a failing chapter no longer discards the other chapters;
- **throttling (429), access denial (401/403) and your Cancel are never
  salvaged** — they stop the run immediately, because a truncated file there
  would mean hammering a site that asked you to stop.

## Guarantees and safety properties (what the tests cover)

- **Opt-in only.** `activeTab` + `chrome.scripting`; the probe is injected only
  when the user opens the tool. There is no wildcard host permission, no
  content-script registration for it, and no network request at extension load.
- **Public HTTPS only.** URLs with credentials, a port, a fragment, IP literals,
  `localhost`/`.local` names or non-HTTPS schemes are rejected.
- **Explicit membership.** Same-origin + same title path by default; outside
  paths require a checkbox. Document order is preserved; duplicates are removed
  only by URL, and the cap reports truncation instead of pretending the list is
  complete.
- **No silent page loss.** Every matched element must be an `<img>` with exactly
  one usable URL; a missing or ambiguous one fails the whole chapter.
- **Data parsing, not page execution.** Fetched chapter HTML is parsed by
  `htmlparser2`/`css-select` (no `DOMParser`, no detached `<img>`, no script
  execution), so no subresource is requested before the host approval step.
- **Bounded and fail-closed.** Redirects (`redirect: "error"`), 429 and
  401/403 stop the run; there is no retry, mirror switch or challenge bypass.
  HTML is capped at 5 MB, a page at 12 MB, a chapter at 128 MB, a chapter list at
  200 entries and 500 images; reads are streamed and checked, not trusted from
  `Content-Length`.
- **Real image bytes.** JPEG/PNG/GIF/WebP/AVIF signatures are checked in the
  probe, and again in the archive builder against the declared extension.
- **Strict save completion.** The page hands its `blob:` URL to the worker's
  existing tracked download path and waits for `state === "complete"`; a merely
  created download, an interruption, a timeout or an unavailable tracker fails
  that chapter. `scripts/e2e-chapter-relay.js` proves the relay accepts only
  this extension page, only `blob:` artifacts, and only with strict completion.
- **No silent truncation.** A full chapter is written only after every page
  succeeded; a partial archive is always named `(incomplete X of Y pages)` and
  reported, and later chapters are still attempted. Throttling is polite: one
  page request at a time with a short pause between them, plus a pause between
  chapter inspections.
- **Cancel** aborts the in-flight fetch, stops the loop and cancels the current
  browser download.

## Decisions and their trade-offs

**“Remember approved hosts per site” — implemented, on by default.** Before
saving, the tool lists every image host it would contact and you tick each one.
The choice is stored per **exact HTTPS origin** (max 30 hosts per origin) and
pre-ticked on the next inspection of that same site; every host is still listed
with a *(remembered)* marker, so it can be unticked for one run, and *Forget
remembered hosts* clears the site. Trade-off, as accepted: a host that later
re-points at something else would not be asked about again — which is why the
list stays visible and revocable rather than becoming invisible.

**Skipping chapters already saved.** A chapter is recorded (bounded: 500 per
title, 100 titles, oldest evicted) only when the browser confirmed the archive
**complete**, keyed by its exact URL. Salvaged/partial archives are deliberately
not recorded, so they are retried rather than silently skipped. Skipped chapters
stay visible in the review with their page counts; *Forget saved chapters for
this title* clears one title.

**Log and benchmark.** Two diagnostics were added rather than relying on the
browser console, which is gone after a reload. The log redacts on the way in
(query/fragment dropped, cookie/token/body keys dropped, base64 and `data:`
payloads replaced), keeps 500 entries in `chrome.storage.local`, and exports as a
text file. The benchmark runs the same read-only checks from whatever page the
source tab is on; its only network request is one page image **from a host you
already approved for that site**, plus a twenty-step scroll that restores the
position. Nothing it does can approve a host or start a download.

**`ComicInfo.xml`** — the file comic readers (Komga, Kavita, CDisplayEx, YACReader)
read from inside a CBZ. Without it a chapter shows as an unnamed grey box; with
it the reader shows the series and chapter. This tool writes only what it truly
knows:

| Field | Source | Why |
|---|---|---|
| `Series` | the title folder you typed | groups chapters of one title |
| `Title` | the chapter label | what the reader shows per file |
| `Number` | first number in the label (`36.10`) | correct sort order in a library |
| `PageCount` | pages actually written | a short file is visible as short |
| `Notes` | only for a salvaged archive | records “Incomplete archive: 4 of 12 pages” |

It does **not** write Writer, Artist, Genre, Summary, LanguageISO or Manga —
the tool has no trustworthy source for them, and a wrong value is worse than an
empty one. If you want author/genre, those must come from the site page, which
is a separate (adapter) job.

**Retry** — enabled by default: two extra attempts with 400 ms and 1200 ms waits,
only for transport/timeout/server errors. Throttling, access denial, Cancel, a
changed tab, an unapproved host and a stale inspection are never retried.

## Known gaps

A full audit (memory, retry, resume, CBZ metadata, inner-scroll containers,
iframes, tiny images, host approvals, release hygiene) is recorded in
[WORKLIST.md](WORKLIST.md#audit-2026-10-30--gaps-found-now-not-previously-recorded),
together with the sanitized evidence and decisions still needed. Closed since:
tiny/placeholder images, inner-scroll containers, remembered hosts, resume, the
log and the benchmark.

Still open, in order of what unblocks most:

- **A real-browser run** ([BENCHMARK_GUIDE.md](BENCHMARK_GUIDE.md)) — nothing in
  the chapter tool has been exercised against a live site. Its log file is the
  first artifact to collect.
- **Per-site outer-HTML captures** ([OUTER_HTML_GUIDE.md](OUTER_HTML_GUIDE.md)) —
  which site needs a capture, where to go, what to pick, what to paste. Without
  one, every site runs on the generic selector defaults.
- **Iframes** — the probe injects in the main frame only; an embedded reader is
  invisible. Decide `allFrames` support and how the review names the frame.
- **Server picker** — sites that switch between "Server 1/2/3" still cannot have
  the server chosen explicitly.
- **Memory on very long chapters** — every page crosses the message channel as
  base64 and JSZip holds the whole chapter; `streamingZip.ts`/OPFS exists for the
  gallery path but is not reused here.
- **Click-to-select picker** — the last usability item; still requires a
  hand-written CSS selector.
- **Release hygiene** — version bump; the Firefox tree has none of this and must
  not be described as having it.

The dropped "use the site's own Download control" idea is archived in
[SITE_DOWNLOAD_CONTROL_EFFORT.md](SITE_DOWNLOAD_CONTROL_EFFORT.md); do not
re-propose it without a sanitized anchor capture *and* a new owner decision.

## Limits (do not overstate this feature)

- **No live validation.** Everything above is synthetic (jsdom, `Response`
  streams, a bundled VM run against stubbed sites). No real website, real
  Chromium, real extension load or real media was exercised. The `Chapters ↗`
  button and the new page have not been clicked in a browser.
- **Selector authoring is the user's job.** Sites whose reader is built by
  JavaScript after load cannot be read from static HTML; "Use open chapter"
  inspects the rendered page instead, one chapter at a time.
- **Cross-origin images need CORS.** The probe fetches images with
  `credentials: "same-origin"` and no referrer. A CDN that does not send CORS
  headers will fail — by design there is no cookie or header forgery.
- **No site-provided batch.** This route deliberately ignores batch links,
  mirror/file hosts and shorteners. The existing offline
  [`chapterPlan.ts`](NHDW_Extension_v3.0.0/src/utils/chapterPlan.ts) still says a
  usable same-title batch has priority; that preference is stated in the UI but
  not automated here.
- **No download history, and metadata is minimal.** Nothing is written to the
  extension's download history. What *is* stored locally: remembered hosts per
  origin, saved-chapter records (file name, page count, timestamp — never page
  bytes) and the redacted log. Chapter numbering comes from the supplied order,
  not from the site. A salvaged chapter is a genuinely short archive — the marker
  in its name and `ComicInfo` is the only thing distinguishing it from a complete
  one, and it is never recorded as saved.
- **No live-browser validation yet.** The benchmark and log have only run in the
  bundled VM harness; the first real run is the next step and its log is the
  artifact to send back.
- **Firefox is not ported.** `NHDW_Firefox_v1.0.0` has none of this.
- **Content responsibility stays with the user.** The tool has no age or
  entitlement check and cannot grant access. Only save material you can
  normally access and may lawfully download. It does not bypass logins, paywalls,
  Premium chapters, Cloudflare or rate limits.

## Verification

- `test/universal-chapter.test.js` — URL policy, discovery, truncation, image
  extraction/ambiguity, static HTML parsing, signatures, stream bounds,
  429/403 handling, all three page-order strategies (including Tailspace-style
  hashed names and duplicate/missing page numbers), advertised page-count
  detection in both DOM and fetched HTML, the bounded scroll sweep, salvage vs
  strict failures, fatal-code handling and cancellation.
- `scripts/e2e-universal.js` — the built `chapters.js` + built probe in a VM
  with a synthetic site, asserting: scan makes no fetches; inspection fetches
  only selected chapter HTML; the save gate blocks unapproved hosts; ZIPs contain
  the exact ordered bytes; an interrupted browser download is reported as
  `Stopped after 0 completed archive(s)`.
- `scripts/e2e-chapter-relay.js` — the worker relay trust boundary.
- `test/chapter-support.test.js` — the supporting pieces on their own: image
  header parsing (PNG/GIF/WebP/JPEG, AVIF accepted with unknown dimensions), the
  128 px gate and its error codes, scroll-target selection, per-origin host
  approvals (exact origin only, cap, forget), saved-chapter records
  (partition/record/forget, caps, partial archives never recorded) and the log
  (redaction of query strings, cookies, tokens, base64 and `data:` payloads,
  entry cap, formatted output).
- `test/manifest.test.js`, `test/package-chrome.test.js` — no broad host access,
  no auto-injection, CSP-safe page, files present in the generated package.
