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
6. **Save**: pick a folder name and CBZ/ZIP, approve each discovered image host,
   tick the confirmation, and press the save button. One archive per chapter,
   named `001 - <label>.cbz` under the title folder, pages `001.jpg`, `002.png`…

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
- **All-or-nothing chapters.** A chapter archive is written only after every
  page succeeded; a failed page saves nothing and stops subsequent chapters.
  Throttling is polite: one page request at a time with a short pause between
  them, plus a pause between chapter inspections.
- **Cancel** aborts the in-flight fetch, stops the loop and cancels the current
  browser download.

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
- **No history, no resume, no metadata.** Nothing is recorded in the download
  history; re-running re-fetches pages. Chapter numbering comes from the supplied
  order, not from the site.
- **Firefox is not ported.** `NHDW_Firefox_v1.0.0` has none of this.
- **Content responsibility stays with the user.** The tool has no age or
  entitlement check and cannot grant access. Only save material you can
  normally access and may lawfully download. It does not bypass logins, paywalls,
  Premium chapters, Cloudflare or rate limits.

## Verification

- `test/universal-chapter.test.js` — URL policy, discovery, truncation, image
  extraction/ambiguity, static HTML parsing, signatures, stream bounds,
  429/403 handling, ordered archives, partial-failure and cancellation.
- `scripts/e2e-universal.js` — the built `chapters.js` + built probe in a VM
  with a synthetic site, asserting: scan makes no fetches; inspection fetches
  only selected chapter HTML; the save gate blocks unapproved hosts; ZIPs contain
  the exact ordered bytes; an interrupted browser download is reported as
  `Stopped after 0 completed archive(s)`.
- `scripts/e2e-chapter-relay.js` — the worker relay trust boundary.
- `test/manifest.test.js`, `test/package-chrome.test.js` — no broad host access,
  no auto-injection, CSP-safe page, files present in the generated package.
