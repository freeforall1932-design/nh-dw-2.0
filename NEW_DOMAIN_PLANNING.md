# New domain planning

> **2026-10-29:** A generic, opt-in Chromium chapter collector now exists for
> ordinary accessible pages (explicit chapter selection and per-page archives).
> It is not a site adapter, does not use batch/mirror links, and has no live-site
> validation; see [UNIVERSAL_CHAPTER_TOOL.md](UNIVERSAL_CHAPTER_TOOL.md). The
> site-specific planning and limitations below are unchanged.

This is the feasibility/planning notebook for owner-requested domains and
related download strategies. The candidate roster remains
[`new domain candidate`](new%20domain%20candidate) and
[`CANDIDATE_SITES.md`](CANDIDATE_SITES.md). A planning entry does **not** mean
a candidate is implemented, approved for release, or fully supported. The
nhentai.net archive entry below analyzes an **existing**, unverified code path.

**Current scope:** The owner authorized continuing Sasangeyou chapter support
and Chromium nhentai archive work. A title and its three readers were inspected
as text; a non-graphic fixture, offline planner and synthetic-only reader-data
candidate parser exist. No images were fetched, and no new-site adapter is wired
or live-transfer verified. Batch alternatives may vary; the owner can specify
the desired one. External video/game mirrors and helpers remain on hold;
DoujinDesu implementation awaits reader evidence. The native nhentai button's
click flow remains unobserved. The owner reports that its download and reader
have the same original file size; that is not an independent hash/quality or
original-upload verification. No nhentai video feature is needed.

| Track | Category | Status | Future gate |
| --- | --- | --- | --- |
| [Sasangeyou](#sasangeyounet) | Chapter-based comics plus external video/game links | Offline batch planner and synthetic reader-data candidate parser; adapter unimplemented | Verify raw DOM and an authorized safe chapter transfer; external hosts remain on hold. |
| [DoujinDesu](#doujindesu) | Chapter-based manga/doujinshi/manhwa | Unimplemented; listing and community implementations examined | Reuse a shared chapter model, but verify its reader, image hosts and authorized access independently. |
| [nhentai.net official archives](#nhentainet-official-archives) | Existing supported site, requested button investigation | Chromium API path hardened offline; keep off, native button flow and live transfer unverified | Observe the site's own action and independently verify hosts, permissions, integrity and browser behavior. |

**Scope:** Sasangeyou and DoujinDesu are the new-domain priorities. Per the
owner's report of ad redirects and excessive ads, `nhentai.to` is removed from
the candidate rosters; the report was not independently reproduced. Other
lookalikes are deferred, not treated as equivalent to `.net` or to each other.
Other supported-site feature work is not authorized by this nhentai request;
Chromium archive progress and existing bug fixes are recorded in
[WORKLIST.md](WORKLIST.md). See [scope](#nh-lookalike-scope).

### Browser priority

**Owner decision, 2026-10-27:** Chromium is the primary target. Implement and
verify new work in `NHDW_Extension_v3.0.0/` first; keep its desktop installation
simple: Developer mode → **Load unpacked** → select that folder containing
`manifest.json`. The existing Firefox tree is retained, but new ports, parity,
device checks and signing are deferred unless a particular change is easy to
carry across. They do **not** block a Chromium release. If Firefox is changed
or released later, independently test it and state any differences; do not claim
untested parity.

Firefox does support [temporary unpacked installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)
via `about:debugging`, but the add-on is removed on restart. Standard Firefox
normally requires a Mozilla-signed package for a persistent installation.
The [Chromium load-unpacked workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
is the intended beginner-facing path. This is a priority decision, not a claim
that Firefox cannot load extensions or that all Chromium browsers have been
tested.

The cross-site routing fix was applied to both trees and tested offline, but
other archive defects remain in both. Keep the option **off for all sites**,
and cancel/review previously queued jobs that may have captured it. Reload the
updated build; old installed versions still contain the earlier routing bug.
No real-browser, real-key or live-archive verification was performed.

### Evidence needed for a future authorized comic-reader implementation

The owner reports that both readers display whole pages but right-click or
phone long-press offers no download action. That is a useful observation, not
proof of the underlying network behavior or an access right. Public Sasangeyou
reader metadata was retrieved as converted text, but no image transfer was
verified. A missing context menu alone does not mean the pages are inaccessible:
the extension would need to find the ordered references the reader already uses
and fetch them only where authorized, then adapt them to the output pipeline.

**Examples and evidence:** The notes record observations from earlier
Sasangeyou examples, including one reader whose listed items and advertised
page count differ; a Premium label or visible reader does not establish
permission to save it. Some supplied titles appear to involve sexual content
with minors and must not be opened, used as test cases or reproduced here.
For DoujinDesu the catalog and URL shapes were inspected, but no particular
reader transfer or complete multi-chapter title was verified. Future fixtures
must be non-explicit, normally accessible and authorized.

**Sanitized public-page observation:** A user-supplied workplace-themed title
page displayed three chapters in reverse order (3, 2, 1), with 156 total pages
advertised and 30, 69 and 57 per chapter. Their converted reader pages contained
33, 72 and 61 image references respectively. Of these, 30, 69 and 58 respectively
were on a content host, plus three site-hosted references per chapter; the last
chapter therefore exposed one more content-host reference than its advertised
count even before the three inserts. These are URL/text observations, not verified
image contents. The readers displayed Server 1/2 and full/single-page controls.
Some previous/next links in chapters 2 and 3 point outside the title's displayed
chapter list; do not follow navigation without independently checking identity.
The title carried a Premium label, yet anonymous retrieval returned metadata and
image references; neither image access nor entitlement to download was tested.
A batch label appeared under **related series**, not established as belonging to
this title. A current-title batch was not observed, but may have been omitted by
conversion. No image bytes were fetched. The [sanitized semantic fixture](NHDW_Extension_v3.0.0/test/fixtures/sasangeyou/README.md)
contains fictional URLs and no media. The retrieval tool converted the pages to
Markdown, so the fixture is **not raw HTML**, does not verify DOM selectors,
and cannot prove a completed download or actual batch availability. A further
anonymous check of the site's public WordPress post endpoint returned a
`content.rendered` string containing closing paragraph tags but no usable
image list for this example; it did not expose the reader's rendered DOM. This
is not a reason to infer that the actual chapter reader is empty. The
[step-by-step capture guide](SITE_CAPTURE_GUIDE.md) gathers the missing browser
structure without asking for a full HAR, media or secrets. A separate browser
extension's [MangaReader-theme adapter](https://github.com/Banchon999/Image-Combine-Extension/pull/13)
reports reading an embedded `ts_reader.run` image list on a **different** site;
the capture helper checks only whether that marker exists, not its contents.
This is a useful hypothesis, not proof that Sasangeyou uses the same markup.
That project is AGPL-3.0; no code was copied into this repository.

**Offline Chromium groundwork:** [`chapterPlan.ts`](NHDW_Extension_v3.0.0/src/utils/chapterPlan.ts)
and [`chapter-plan.test.js`](NHDW_Extension_v3.0.0/test/chapter-plan.test.js)
consume normalized, explicitly ordered chapter/page references without network
access. They retain ordered reader references and report advertised page-count
discrepancies; they never infer a server, truncate pages, or mix server lists.
A same-series available batch takes priority only when known coverage exactly
matches the selection. A list of alternative candidates requires an explicit
choice; if the selected option is expired, separate archives are planned only
when all supplied alternatives are explicitly expired too. The caller must
establish that its option list is complete. Blocked, unverified, unobserved,
foreign, incomplete or scope-ambiguous evidence requires review.

[`sasangeyouReaderCandidate.ts`](NHDW_Extension_v3.0.0/src/parsing/sasangeyouReaderCandidate.ts)
parses a hypothetical `ts_reader.run` JSON object without executing script,
offers candidate server lists, and requires one to be selected from the same
in-memory snapshot. Tests use only synthetic data: they do not establish that
Sasangeyou actually uses this markup. Neither core validates authorization,
real hosts, redirects, image bytes or completeness, and neither is **connected
to the extension UI or downloader**. Chromium's current offline suite passed
722 tests (4 pending), build, smoke and VM e2e; no Firefox port or live-browser
validation was performed for the new chapter work. An attempted Chromium 153
headless-shell run could not register the extension and is not a passing
real-browser test.

**Owner preferences, not yet implemented:** Prefer an available site-provided
batch, even when it is one combined file. If the batch hosting is expired,
use the ordinary reader route and save separate archives per chapter. Do not
equate a blocked, throttled or otherwise unverified host with an expired file,
and do not bypass restrictions. The batch/hosting workflow is not implemented,
and file availability, completeness and safety are not verified.

The owner reports that normal chapters usually require no login, while Premium
chapters may be blocked or have no pages/download button. This is the owner's
observation, not an independently verified rule. Treat inaccessible content as
inaccessible rather than attempting to defeat access controls.

**What is still needed:** The assistant can inspect and sanitize appropriate
public, non-graphic page metadata without asking the owner to do that work.
The batch-first and separate-chapter fallback choices are settled. Actual
end-to-end transfer verification still needs a normally accessible, authorized,
non-explicit multi-chapter example; where possible it should include a batch.
Never use examples depicting sexual content involving minors. A series link is
normally sufficient to locate its chapters. ZIP versus CBZ, counts and
promotional-page preferences can be specified later.

Screenshots, downloaded images, browser Network logs and HAR files are **not
required now**. Never share passwords, cookies, API keys, tokens, signed URLs,
secret URL paths or private account information. Strip sensitive queries and
fragments; omit a link whose path is secret. Do not bypass access restrictions.

#### Proposed whole-title functional specification (not yet implemented)

- On a series/title page, discover its actual chapter list, including special
  or decimal chapters; let the user select one, several, or all currently
  accessible chapters. A chapter-reader page defaults to its current chapter;
  it does not silently expand to the whole series.
- Preserve chapter order and labels and, within each chapter, reader page
  order. Do not invent chapter URLs, mix two reader-server page lists, or rely
  solely on a title's advertised count. Keep actual chapter pages and credits;
  exclude unrelated interface elements, and ask before treating an ambiguous
  reader item as a promotional insert to be removed.
- Prefer a site-provided batch even if it is one combined file; when its host
  is expired and the normal reader route is authorized, use separate chapter
  archives with stable, numbered chapter/page names. ZIP/CBZ should preserve
  the fetched image bytes; availability and original-upload quality are not
  guaranteed. PDF and raw output need separate verification.
- Identify each chapter by source, title and chapter, so retry/history cannot
  collide across sites or silently skip another chapter. Show progress and
  allow cancellation. Report blocked, missing or failed chapters/pages; do not
  report the whole title as complete unless every requested chapter completed.
  A future implementation may continue with other chapters and offer retry for
  failed ones rather than erasing completed per-chapter files.
- Validate the actual permitted page references, image types/signatures and
  safety boundaries. Verify chapter discovery, ordering, special chapters,
  page counts, incomplete/locked cases and output in synthetic tests, followed
  by a small authorized Chromium browser test. Firefox remains a separately
  tested, optional port. No bypass of paywalls, logins, CAPTCHA or DRM.

If the existing links and rendered pages are insufficient, request only the
smallest necessary sanitized observation (such as hostname, status or content
type), not a full HAR or raw request/response headers. The owner's report of
whole visible pages is useful, but is not yet a verified network transfer.

### Remaining work

1. **Chromium archive:** build on the offline integrity, URL, throttling and
   completion hardening below; verify real delivery hosts, permissions, save
   completion and contents before recommending the opt-in. Global cooldown
   across contexts, restarts and independently queued jobs remains open.
2. **New-domain track:** capture authorized, sanitized examples; wire and prove
   one Sasangeyou comic chapter, then multi-chapter selection and batch routing.
   Independently validate DoujinDesu's reader and authorization path. Preserve
   Sasangeyou's multiple video mirrors and game variants as separate work.
3. **Native `.net` button:** observe its actual click flow without exposing
   credentials or signed URLs; do not assume it is the documented keyed API.
   Complete the browser, policy and quality gates below. Torrent and automatic
   external video/game transfers remain separate features.

## Sasangeyou.net

**Reviewed:** 2026-10-27. **Complexity:** medium for a single accessible comic
chapter; high for series selection, listing integration and mixed-media support;
very high for automatic downloads from every external host.

### Short answer

A missing download button does not necessarily prevent a comic download: if an
authorized reader exposes its pages, the extension can potentially collect the
ordered image references and use its existing ZIP/CBZ/PDF/raw pipeline, much
like Hitomi. This is **feasible in principle, not yet proven end-to-end**. A
button that links to an external PDF, video, or game site is a different
problem: the button often leads to a *landing page*, not file bytes, and every
provider has its own flow. **Actual automatic downloading is possible in
principle for some accessible files**, either with separately implemented
host-specific adapters or an optional desktop download manager; it is not a
single generic extractor and has not been demonstrated here. The supplied video
offers two genuine file-hosting alternatives to Filemoon: **MEGA and TeraBox**.
A separate game article on the same external site also demonstrates four
providers and two Android architectures. Detailed evidence and a concrete
automation design are below.

The owner-supplied no-button example is labelled **Premium**. Its label and a
visible reader do not establish download rights or bypass permission. Only test
content the user is authorized and legally permitted to access; never retrieve
sexual content involving minors, bypass paywalls, DRM, login requirements or
CAPTCHAs. Stop and report an access restriction rather than circumvent it.

### Can the existing Sasangeyou projects be adapted?

**Yes, as implementation references—not by installing either project unchanged
inside this extension.** The concrete choices are:

| Reference | What it contributes | What adaptation still requires |
| --- | --- | --- |
| [Keiyoushi Sasangeyou + MangaThemesia](https://github.com/keiyoushi/extensions-source/blob/6768cbc2049c5e07d67ea1ac667af73f9737596a/src/id/sasangeyou/src/eu/kanade/tachiyomi/extension/id/sasangeyou/Sasangeyou.kt) | The small Sasangeyou adapter inherits the shared MangaThemesia chapter-list and reader-image logic. That shared parser handles reader images and some embedded image arrays. | It is Kotlin for an Android reader, using Android/Keiyoushi libraries, not a WebExtension. Implement a TypeScript source adapter around verified site behavior, with a shared chapter model, existing archive pipeline, and Chromium wiring and tests; port Firefox later only if straightforward. Upstream also contains a view-count POST; do not copy that side effect unless needed and authorized. |
| [Manga Downloader](https://github.com/elboletaire/manga-downloader/blob/40b0e4bc00cde6c95b900d89ebdbc8baebb751eb/README.md) | Its maintained desktop/CLI project lists Sasangeyou and has a generic HTML/lazy-image reader. It is another useful reference for ordered chapter extraction. | It is a Go desktop/CLI application, not a browser plugin. A bridge would mean a separate installed helper and a new permission, contrary to the current one-extension default unless separately approved. Its AGPL-3.0 terms also need review before code reuse or distribution. |

For a one-extension implementation, prefer a **purpose-built TypeScript
adapter**, not packaging the Android APK or desktop binary. Extractors and
chapter data can inform the design, but neither project proves that our
specific examples or video/game hosts work today. Keiyoushi's code is
Apache-2.0: if code is ported, preserve applicable copyright, license and
notice obligations; do not assume it becomes MIT. No third-party code has been
copied or executed here. The reader, external PDF buttons and each video/game
provider remain separately scoped capabilities.

### Evidence from the supplied examples

The examples below are identified by their roles in the owner's request rather
than reproducing media URLs. Observations are from the web retrieval tool's
text/HTML-to-Markdown output on the review date. That is not a raw-HTML
capture, an authenticated browser test, or a proof of downloadability. **No
image, PDF, video, or game bytes were downloaded or verified.** Sites, hosts,
and availability can change.

| Example | Observed | Implication |
| --- | --- | --- |
| No-button comic | The title links to a chapter reader and is labelled `Premium`; there is no download link in the returned chapter listing. | Absence of a button is not a parser failure. Authorization and actual page-fetch behavior still need verification; do not use a paywall as a fallback target. |
| UpFiles comic | The title says 23 pages and links to a chapter and `Download Chapter 1`. The reader's counter shows 25 items: the returned list includes chapter images plus site-supplied inserted material. Image references use `cdn.sasangeyouku.my.id` and `sasangeyou.net/wp-content/uploads/`; some names end in `.jpg.webp`. | Do not equate the title's advertised page count with the reader's total, assume one image host, or infer actual bytes solely from the first extension. Preserve reader order and distinguish optional promotional material. |
| Older mirror comic | Its download button points at `mir.cr`; following it in the web tool landed on `www.mirrored.to`, which displayed PDF metadata and a further **view download links** step. | This is a mirror directory, not a confirmed direct PDF URL. A mirror may be unavailable or lead to another host. |
| UpFiles button | The supplied `upfiles.com` link landed on `upfilesgo.com` and displayed a PDF name, size and free/premium choices. The free button was not exercised. | Landing-page recognition is feasible; final-file automation and host requirements are untested. Do not save the landing HTML as a PDF. |
| Video | The title's `Download Video` section lists **Filemoon, MEGA and TeraBox** (advertised size 35.3 MB, duration 03:09). Its chapter download button points only to Filemoon. The TeraBox share landing page displayed a single `.mp4` name and a `Download` control; no transfer was started. The chapter reader has one image, not an established video file. | Collect all links from the description as well as the chapter button; a one-image reader is not proof that an animation is a comic. These are host pages/services, not verified direct media files. |
| Animation genre | `/genres/animation/` returns cards linking to `/manga/.../` title pages and pagination including `/genres/animation/page/2/`. The displayed cards are marked Animation. | Listing and pagination discovery are plausible, but an image-gallery batch must not silently treat these cards as comic chapters. Exact DOM selectors still need a capture. |
| Supplied game | The supplied game example is tagged as involving minors. | Its specific download hosts and links are deliberately not enumerated or analyzed. Use the separate game reference below for general site/host research. |
| Separate game reference | A different Sasangeyou title links to an `erogameidn.my.id` article for *Doki Doki Literature Club!*. The article lists two Android architectures and four providers for each. The original game is non-explicit; the site's third-party Android builds, translation and redistribution rights have **not** been verified. | The external site can present multiple alternatives per variant. An article link is not a final file or proof that the advertised mirrors are identical. |

The examples show a `/manga/<slug>/` title page and a separate root-level
`/<chapter-slug>/` reader linked back to the title. **Do not assume the two
slugs are always identical** or treat every root-level URL as a chapter:
`/genres/`, `/blog/`, login pages and other routes also exist. Follow actual
chapter links and reader-to-title links. The displayed numeric `Source` field
is not established as a unique Sasangeyou title or chapter identifier.

### Recommended scope and user experience

1. **Comic-reader path first:** On an authorized comic chapter, discover the
   page list, let the user confirm the chapter and download it as one archive
   or raw folder. On a title page, list its real chapters and let the user
   select one, several or all currently accessible chapters, preserving chapter
   order. The owner chose **one archive per chapter** for the reader fallback,
   but a site batch takes precedence even when it is one combined file. A reader
   page should offer the current chapter without silently expanding to the
   entire series.
2. **Mixed listings:** Classify the title from measured metadata/genre, not the
   `/manga/` prefix alone. Comics use the image path; animation/game items show
   their type and link choices. Unknown types require confirmation rather than
   silently packaging a poster. Listing selection and pagination need their
   own measured fixtures and bounded requests.
3. **External link path:** Present the actual labelled alternatives (and
   chapter, platform, variant and advertised file type/size when known). Let
   the user open or copy a selected provider link. Keep the image archive
   action distinct from the site's hosted PDF: they may differ in pages,
   quality and contents. Do not promise that either is the original source.
4. **Automatic external downloads:** A later, separately approved feature,
   implemented and tested *per host*, not a generic recursive clicker. Direct
   safe file URLs can use the browser download manager after user selection;
   multi-step hosts may require normal user interaction or a dedicated download
   manager. CAPTCHAs, expired links, logins, ads and unsupported providers
   must result in a clear manual-handoff/unsupported state, not retries that
   try to defeat them. Video-only and executable-download integration remain
   outside the current comic-archive scope until the owner explicitly chooses
   otherwise ([candidate scope](CANDIDATE_SITES.md#4-scope--the-swap-decision-2026-09-24-owner-directed)).

For games, never automatically run an installer, APK, archive or script; make
platform and variant an explicit user choice and warn that external files are
untrusted. Do not bulk-open arbitrary links, follow ad popups, or assume that a
file is safe because it is labelled as a game.

### Comic extraction design to validate

1. Parse the title's chapter list and the reader's back-link; retain full
   canonical same-site URLs. Support one and multiple chapters, duplicate labels,
   decimal/special chapters and percent-encoded Unicode slugs. Use source order
   or a verified chapter order, not lexical filename sorting. Never infer links
   by replacing `/manga/` or by inventing numbered URLs.
2. The observed reader displays `Server 1`/`Server 2` and full/single-page
   choices. An existing MangaThemesia implementation suggests
   `#readerarea img` and lazy attributes such as `data-src`/`data-lazy-src`; another common
   pattern is a `ts_reader.run(...)` data object with image arrays. **These are
   reference-derived candidate mechanisms, not confirmed selectors or raw
   payloads for these specific samples.** Capture and verify the actual markup
   before coding. Prefer the reader's real page list, not every image in the
   page; ignore logos, loading placeholders, unrelated recommendations and ads.
3. Resolve relative URLs against the actual document, keep the chosen reader
   server and its page order, and avoid concatenating two server lists as if
   they were consecutive pages. Only substitute a different server for the
   same page after its ordering/equivalence has been verified; otherwise offer
   an explicit whole-server choice. If reader data is embedded in a script,
   parse a bounded, recognized JSON payload as **data**; never `eval` or run
   remote JavaScript. A rendered-DOM fallback may be needed for pages where
   static HTML is insufficient, subject to normal browser access.
4. Preserve ordered page references, including real query parameters where
   required and allowed. The `.jpg.webp` example must be classified by the
   final extension and, preferably, actual image MIME/signature. Validate image
   bytes rather than accepting an HTML challenge or placeholder as a page.
   Produce zero-padded local names in reader order; only convert formats when
   the selected output requires it. Do not silently drop a disclaimer/credit;
   known promotional inserts can be an explicit, tested user option.
5. Report the reader-list count, pages actually retrieved and any failures.
   Compare the advertised page count as a **warning**, not an equality gate:
   the observed 23/25 discrepancy is legitimate. A missing/blocked page must
   not silently become a successful complete archive. Provide bounded retry,
   cancellation and a clear partial/failure status.

### Changes this repository would need

This is not just a new hostname or a Hitomi resolver clone:

- `src/sources/GallerySource.ts` models `getImageUrls(mediaId, filename, extra?)`,
  but `src/background/Downloader.ts` actually calls it with only a media ID and
  generated filename (or a Hitomi hash). The current `images.pages` shape does
  not carry through the arbitrary per-page URLs observed here. Add a serializable,
  validated page-reference representation and wire it through the Chromium
  downloader, popup and batch/offscreen paths; keep existing adapters working.
  The Firefox path is a separately scoped, optional follow-up.
- A title and its chapters need distinct, stable identities. `src/utils/siteKeys.ts`
  can compose colon-free string IDs, **but** `bookmarkQueue.ts`,
  `background/bookmarkService.ts`, list-card matching and paste parsing contain
  numeric-ID assumptions. Define and test a canonical, site-scoped series/chapter
  key based on the normalized actual URL, including encoded Unicode; keep the
  original canonical URL for navigation. Avoid double encoding, collisions and
  interpreting arbitrary colon-containing input as a composite key. Preserve
  existing numeric keys, migrations and history. Decide whether a saved bookmark
  represents a title or a specific chapter before implementing it.
- `extractGallery` is synchronous and existing resolution generally fetches one
  gallery URL. A title-to-chapter-to-pages flow needs an explicit asynchronous
  resolution stage; do not pretend a series landing page already contains a
  complete gallery. Wire both single-popup and batch/list/bookmark paths, not
  just a standalone parser.
- Add a source adapter/parser, source registry entry, measured listing-card and
  title-button rules, URL/paste recognition, and narrowly scoped Chromium
  manifest/content-script entries. If Firefox is ported, add its own tested
  entries. Include page/CDN hosts only after verification; thumbnail hosts are
  not automatically page hosts.
  `tabImageFetch.ts` currently restricts its page-text tab fetch to
  `nhentai.net`, and `cdnConfig.ts` rejects URL queries/fragments: review both
  paths deliberately rather than assuming they support this site already.
- Allow only verified HTTPS hosts and expected paths for page downloads. Treat
  parsed URLs, redirects, DOM and host responses as untrusted; reject local,
  private, credential-bearing, script/data/file and unexpected origins, and
  validate redirect destinations before handing off. Do not grant `<all_urls>`
  or indiscriminately relax global image-URL rules. If a browser API cannot
  safely inspect a redirect chain, stop and offer user-directed navigation.
  Cross-origin, cookie and referrer behavior is browser- and host-dependent and
  must be measured; tab-context fetching is not a guaranteed CORS bypass.
- Test the Chromium paths first; a Firefox port is optional and must be tested
  independently if pursued. Existing ZIP/CBZ/PDF/raw, page ranges, naming,
  progress and retry machinery are reusable **after** the page-reference and
  identity gaps are resolved; reusability is not proof a live source works.

### External-host feasibility and security

| Host/path | What can be automated first | What remains unverified |
| --- | --- | --- |
| Sasangeyou title/chapter links | Parse the labelled chapter or description links and associate them with the right item. | Exact selectors, page variants, mixed-media classification and link freshness. |
| `mir.cr` / `mirrored.to` | Offer the mirror landing page to open/copy. JDownloader has a matching mirror-directory plugin. | Which mirrors are available, whether they contain the same file, and whether any downstream host permits an unattended transfer. |
| `upfiles.com` / `upfilesgo.com` | Offer the landing page; JDownloader has a plugin listing both domains. | Whether a given link, plugin version and free/premium flow work now; a host page is not the final PDF. |
| MEGA | Discover the file-share link and offer a selected, complete link to the provider or a compatible desktop tool. | Availability of this share, decryption/transfer integration, quota and completion. Its fragment can contain the decryption key. |
| TeraBox | Discover the file-share link; the video landing page rendered a named MP4 and a download control. | Whether a user can actually download this share, and whether the documented authenticated API works in this extension. |
| Filemoon | Discover the link, including the duplicate chapter button, and offer an explicit handoff. | The landing page returned HTTP 500 to the retrieval tool; actual stream/file availability and automation are unknown. |
| External game article and its file hosts | Open the article or offer separately labelled platform/variant links after user selection; the independent example below demonstrates four providers. | Safe automatic handling of each provider and file; executable trust, installation and platform compatibility. |

Use a host-specific adapter only after its normal, authorized flow is measured.
A filename or HTTP 200 alone is not proof of a PDF/video/file; verify final
URL, status, content type and, where feasible, signature/length and completion.
If validation cannot be done safely with the chosen browser API, say so and
hand off rather than reporting success. Do not reuse comic-image CDN allowlists
as permission to crawl arbitrary file hosts. Mirror choices are alternatives,
not files to download all at once.

### Can the downloads themselves be automated?

**Yes, conditionally.** Accessible comic chapters could be downloaded and
archived by the extension. External files could be downloaded through individual
provider integrations or an optional desktop download manager. Neither path is
implemented here, and none of the sample files has been transferred. A host
listing, API, or plugin is evidence of a possible route—not a guarantee that
the current links work without login, a challenge, or other user action.

| Content/provider | Plausible automatic transfer | Important limit |
| --- | --- | --- |
| Sasangeyou comic reader | Resolve the selected chapter's ordered images and feed them into the existing ZIP/CBZ/PDF/raw pipeline after the page-URL and identity changes described above. | Only normally accessible, authorized chapters; actual image fetching and archive creation have not been tested for this source. |
| MEGA | An optional local MEGAcmd integration or JDownloader's MEGA plugin can handle the encrypted-share workflow; alternatively research a properly licensed, bundled provider-specific implementation. | An ordinary browser download of the share page does not itself decrypt the file. The exact share and either integration remain untested. |
| TeraBox | Investigate its authenticated shared-file API or JDownloader's TeraBox plugin for actual file transfers. | API registration, authorization, browser compatibility and share-download permissions are unproven; the examined JDownloader plugin requires at least a free account and cookie-based login. |
| Filemoon | Try JDownloader's host-specific plugin on an authorized, non-explicit test video. | The plugin recognizes the observed domain, but current link/format/transfer support was not verified. Do not assume yt-dlp supports the supplied `.to` link. |
| Sfile | Investigate a dedicated normal-access host adapter or the existing legacy JDownloader `sfile.mobi` plugin. | That plugin's pattern matches `.mobi`, not the observed `.co` links. A domain redirect does not establish compatibility; do not rewrite links or claim support without a test. |
| APKAdmin and Userdrive | Their JDownloader host plugins provide plausible automated handling; host-specific extension adapters are another possibility. | Both Userdrive links in the separate game example returned `File Not Found`. A plugin cannot restore missing files; current APKAdmin transfer and plugin behavior are untested. |
| `mir.cr` / Mirrored.to and UpFiles | JDownloader has a mirror-directory crawler and an UpFiles host plugin; an adapter could also discover the available links. | A mirror directory can return *multiple* alternatives. Review/select a single host first; do not auto-start every discovered mirror or treat the directory HTML as the file. |

**Option A — extension only.** This best matches the existing one-extension
architecture. After source/variant selection, implement a separate provider
adapter per supported host. It must obtain a permitted actual file response,
then use the browser download API when that response is suitable. A recognized
multi-step page may need user interaction; MEGA decryption and TeraBox's
authorized API need dedicated work, not just passing the landing URL to the
browser. If TeraBox requires a confidential OAuth client, a shipped extension
or desktop binary cannot safely contain its secret: use a provider-supported
public-client flow or a properly secured backend, if available and approved.
Cross-browser API, licensing and large-file behavior are unresolved. Other
providers remain explicit unsupported/manual options until individually tested.

**Option B — optional JDownloader integration.** Potentially broader coverage
without reimplementing every host: the extension could discover the alternatives
and send the user-selected link to an already installed JDownloader. Its
[official API](https://my.jdownloader.org/developers/) exposes LinkGrabber,
queue and status operations; the source plugins above identify candidate hosts.
One possible workflow is:

1. The user chooses an item, platform/architecture where relevant, and a
   provider. Submit only that authorized selection as a LinkGrabber job, not
   every mirror or an entire article.
2. Initially request **no autostart and no archive extraction**. JDownloader's
   API implementation has an `autoExtract` job field, but its interaction with
   user rules and plugin behavior must be verified. Wait for the job to resolve
   and check the resulting item(s) before starting only the intended download;
   do not start, pause or modify unrelated JDownloader jobs.
3. Track the selected job's progress and terminal state. Report `needs action`,
   unavailable or failed distinctly from success. Do not claim verified file
   integrity merely because JDownloader reports completion.
4. If the host fails, offer alternatives in the **same selected variant**.
   Automatic fallback requires explicit approval and verified equivalence or
   user confirmation. Cancel/finish the previous attempt before another starts,
   and never combine partial files from different hosts.

The documented My.JDownloader API uses account authentication and normally
routes communication through its connection service, with direct connections
possible after authentication. This adds an external service/privacy and setup
choice: disclose it before sending share links or keys. A locally installed
native-messaging bridge is another research option, but it requires a separate
program and browser-specific registration; the documented direct JDownloader
API is marked deprecated. Neither bridge is present or tested in this repo.
Both extension manifests currently lack `nativeMessaging` permission. An
optional helper would be a scope/installation change, **not** the extension-only
architecture already chosen for the project.

For both options, pause for any required login or CAPTCHA and let the user
complete the provider's normal flow; do not bypass a paywall or access
restriction. Do not automatically open, execute or extract downloaded games;
ensure any external manager's own settings cannot do so before starting such
a job. Do not ship third-party resolver services or expose MEGA keys, tokens or
cookies in logs. Implementation and live tests of external-file automation
require separate owner approval and lawful, non-explicit, user-controlled test
files.

#### Video mirrors: prioritize the file hosts

These are **all three links listed in the supplied video description**, not a
claim that the broader animation catalogue uses only these providers. Source
metadata is an advertisement, not proof that the files have the same contents.
The research priority below is not an automatic download preference or a
certification that any provider or file is safe.

| Priority and provider | Evidence from the supplied link | Practical route and remaining work |
| --- | --- | --- |
| **1 — MEGA**, cloud file share | The source has a `mega.nz/file/...` share with a fragment. Fetching its URL without the key returned HTTP 500 from the retrieval tool, which does **not** prove the share is dead. No file metadata or bytes were verified. | Offer **Open** or **Copy** of the complete selected share, including its fragment. MEGA's official documentation explains client-side decryption; its official MEGAcmd guide documents downloading public links, including without login. A future local-helper or SDK integration could be researched, but was not run and would require separate approval, licensing review and completion tests. A browser download of the share-page URL alone must not be treated as a decrypted media download. |
| **1 — TeraBox**, cloud file share | The source's `1024terabox.com/s/...` link redirected to `www.terabox.app`; the rendered page named an `.mp4`, showed one item and a `Download` control. The control was not clicked. | Offer the selected share in the official browser/app flow. The official Open Platform documents authorized shared-file listing and download APIs; see the details below. A JDownloader source plugin also recognizes `1024terabox.com` and `terabox.app`, but no tool or transfer was tested. Account, verification, rate and availability requirements remain unknown for this particular share. |
| **2 — Filemoon**, video host | It is the description's first link and the chapter button's only link. Fetching the landing page returned HTTP 500 from the retrieval tool. | Keep it as a separately selectable fallback. A JDownloader crawler names `filemoon.to`; an older yt-dlp unsupported report is not evidence of present-day compatibility. Neither a stream nor a final file was checked. |

**MEGA detail.** A share URL's fragment may be the decryption key. Preserve the
original full link only for a user-selected open/copy/handoff; do not strip or
URL-decode/re-encode it casually, log it, sync it, send it to an unrelated
resolver, or put it in a fixture. MEGA's client downloads encrypted data and
decrypts it locally. An optional desktop handoff is different from a built-in
extension downloader and must not silently install or invoke a helper. Review
whether a helper exposes keys through command-line arguments, process lists,
shell history, caches or telemetry before handing a link to it. Quotas, access
restrictions and link expiration remain provider decisions; do not attempt to
bypass them.

**TeraBox detail.** Its [Open Platform documentation](https://www.terabox.com/integrations/docs)
describes application credentials and user authorization as well as
`/openapi/share/list` and `/openapi/share/download`; the latter documents a
file download link in the response. The documented parameters include an
access token and share/file identifiers, and the share APIs describe a `sekey`
for extraction-code verification. Parameter spellings and examples in the docs
are not entirely consistent, so actual requirements must be tested rather than
inferred. Nothing here establishes anonymous public-share API access, the
required permissions for this application, or a usable direct download of the
sample. A production integration also needs a secure OAuth design—**an
extension package cannot keep a client secret confidential**—plus an audit of
provider terms, CORS, optional browser permissions, expiry, token storage and
redirects. Never commit or log tokens, `sekey` values or signed `dlink` URLs.
The examined JDownloader TeraBox host plugin is **cookie-login-only and requires
at least a free account for its download path**; that is a plugin-specific
observation, not proof that all TeraBox downloads require an account.

A TeraBox alias or redirected hostname is not another independent mirror: the
observed video and game pages redirect to different TeraBox domains but remain
one provider. The exact aliases and allowed redirect targets must be verified
per provider; do not accept lookalike suffixes or trust link labels alone.

#### Independent game example: platform, architecture and provider choices

To examine the external site without analyzing the supplied game that is tagged
as involving minors, the follow-up used a separate
[Sasangeyou game title](https://sasangeyou.net/manga/game-doki-doki-literature-club-bahasa-indonesia/)
and its linked [ErogameIDN article](https://erogameidn.my.id/doki-doki-literature-club-bahasa-indonesia/).
The article's text advertises Android **version 1 / ARM64-v8a** and **version
2 / ARM-v7a**, each rounded to 149 MB, and lists the same four providers in
both rows. These are two architecture variants with four advertised mirrors
*each*, not eight versions of the game. The publisher's [original game](https://ddlc.moe/)
is free to play; that says nothing about the safety, content or redistribution
rights of these third-party Android packages. No APK was downloaded or run.

| Provider | Advertised for | Landing-page observation on 2026-10-27 | Automation assessment |
| --- | --- | --- | --- |
| **Sfile** (`sfile.co`) | Both architectures | Both pages named an APK and displayed a waiting timer. They advertised 149.31 MB and 149.67 MB respectively and displayed SHA-256 values; these values and files were not verified. | JDownloader has a legacy `sfile.mobi` plugin, but its URL pattern does **not** name `sfile.co`; the former domain's home page now redirects to the latter. Compatibility with these `.co` links and any per-host automation need testing. |
| **Userdrive** (`usersdrive.com`) | Both architectures | Both supplied pages returned a **File Not Found** message in the retrieval tool. This is a time/session-specific observation, not a claim about every Userdrive link. | There is a JDownloader host plugin, but it cannot make a removed file available; no plugin was run. Show unavailable for the observed checks and offer another mirror in the *same* selected variant. |
| **APKAdmin** (`apkadmin.com`) | Both architectures | Both pages identified APKs and displayed a wait followed by a described second download step. A separate `Download APK` link pointed off-host, so labels alone are not trustworthy. No button was clicked. | A JDownloader plugin exists; live support is untested. Do not follow advertising links or guess a final binary URL from a prominent button. |
| **TeraBox** (`1024terabox.com`) | Both architectures | Both shares redirected to `www.1024tera.com`, displaying architecture-specific APK names and a generic download control. | Same provider family as the video mirror. The authorized API and JDownloader limitations above apply; no actual APK transfer was checked. |

The article suggests trying TeraBox when links are dead; that is the article's
advice, not a verified guarantee. It also calls a separate in-game code a
"checksum"; that is **not** evidence of a cryptographic file-integrity check.
The external site's index has Android and PC categories, but this particular
article advertises Android only. Do not invent a PC download from a category or
metadata label. Hosts can change, and the same-size labels do not prove the
four mirrors contain identical bytes.

Executable files deserve extra caution: never automatically install, open, run
or extract an APK, installer, archive or script. Prefer the publisher's
verified distribution when available. A host's self-reported SHA-256 can help
compare a downloaded file with that host's claim, but cannot establish
publisher authenticity or safety; compare against independently trusted
publisher signatures/hashes where available. Mark provenance, rights, malware
status and architecture compatibility as unverified unless actually checked.

#### Proposed mirror discovery and selection contract

1. For a video title, parse the **description's actual download section** and
   the chapter button, not just the first link. Associate every discovered link
   with its source location; deduplicate an exact repeated Filemoon link without
   losing other providers. Avoid social links, recommendations and ads.
2. For a lawful game title, treat its external article as a separate user-chosen
   navigation/fetch. Scope parsing to the article's download section and its
   labelled rows; do not recursively crawl unrelated links. Model
   `item → platform → version/architecture/language → mirror[]`. A category
   label or synopsis is not itself a downloadable platform variant.
3. Keep each candidate's source label, validated provider/host, variant,
   advertised type/size and timestamped **evidence status**. Hold the original
   link only as long as needed for the chosen action; do not persist or log
   fragments, signed queries or other access-bearing components by default.
   A host label is untrusted text: match the actual URL hostname against an
   exact, reviewed provider/alias registry. Keep unknown HTTPS hosts as explicit
   open/copy-only choices; do not silently discard them. Preserve required query
   strings and MEGA fragments for the selected action without exposing secrets
   in logs or persistent history. Avoid deduplicating two distinct links or
   variants merely because their labels or rounded sizes match.
4. Show status separately for `discovered`, `landing page observed`,
   `unavailable`, `needs user/auth`, `unsupported`, `direct file verified` and
   `completed`; a landing page or HTTP 200 is not a completed download.
   Checks are time- and session-specific. If a link fails, show the other
   advertised mirrors **in the same selected variant**. Any automatic failover
   must be separately approved, scoped to that variant and subject to verified
   equivalence or user confirmation; never switch architecture silently.
5. For a later authorized direct-file adapter, validate scheme, provider,
   redirect destinations, final response, file type/length and completion;
   classify challenges, expired signatures and HTML masquerading as a file as
   errors. If the API cannot inspect a redirect safely, stop and offer a manual
   provider-page handoff. Request only the host permissions actually needed.
   Never submit credentials or share keys to an unrelated third-party resolver.

The Sfile/Android observations and the video TeraBox page demonstrate that
metadata discovery can work; they do **not** demonstrate executable safety,
mirror equivalence or a completed transfer. Real browser behavior, actual
selectors and per-host download handling still need authorized, non-explicit
test content and end-to-end validation.

### Research references

- [Keiyoushi Sasangeyou source](https://github.com/keiyoushi/extensions-source/blob/6768cbc2049c5e07d67ea1ac667af73f9737596a/src/id/sasangeyou/src/eu/kanade/tachiyomi/extension/id/sasangeyou/Sasangeyou.kt)
  and its shared [MangaThemesia parser](https://github.com/keiyoushi/extensions-source/blob/6768cbc2049c5e07d67ea1ac667af73f9737596a/lib-multisrc/mangathemesia/src/eu/kanade/tachiyomi/multisrc/mangathemesia/MangaThemesia.kt):
  direct source-specific precedent for chapter/image handling; Android/Kotlin,
  not a drop-in browser extension. The [merged source PR](https://github.com/keiyoushi/extensions-source/pull/13065)
  reports testing Sasangeyou in January 2026; that is not a test of our examples today.
- [Manga Downloader](https://github.com/elboletaire/manga-downloader/blob/40b0e4bc00cde6c95b900d89ebdbc8baebb751eb/README.md)
  lists `sasangeyou.net` as verified on 2026-10-26 and is a desktop/CLI option;
  its [generic PlainHTML reader](https://github.com/elboletaire/manga-downloader/blob/40b0e4bc00cde6c95b900d89ebdbc8baebb751eb/grabber/plainhtml.go)
  and [lazy-image fix](https://github.com/elboletaire/manga-downloader/pull/378)
  are useful design references. Its support listing does not prove every
  chapter, external host or media type works.
- JDownloader's [Mirrored.to plugin](https://github.com/mirror/jdownloader/blob/master/src/jd/plugins/decrypter/MirroredTo.java)
  names `mir.cr`, and the [UpFiles plugin](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/0df09abadf81ea393784fed72774b1c4fc29d2d3/svn_trunk/src/jd/plugins/hoster/UpfilesIo.java)
  names `upfiles.com` and `upfilesgo.com`. These are desktop references, not
  proof that the supplied files download today; no plugin was run here.
- MEGA's [encrypted-links explanation](https://help.mega.io/security/data-protection/encrypted-links),
  [developer resources](https://mega.io/developers) and [MEGAcmd 2.7.0 guide](https://github.com/meganz/MEGAcmd/blob/46d2f8c036c38999d3625b8d2baf49a1ec14d89e/UserGuide.md)
  describe the key-bearing link model and an official desktop transfer option.
  Their existence does not prove the specific sample is live or that a browser
  extension can integrate them as-is.
- [TeraBox Open Platform docs](https://www.terabox.com/integrations/docs)
  document authorization and shared-file API endpoints. They do not establish
  that this extension is registered, authorized or able to download the sample.
- JDownloader's pinned source includes a [MEGA hoster](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/hoster/MegaNz.java),
  [TeraBox share crawler](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/decrypter/TeraboxComFolder.java),
  [TeraBox hoster](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/hoster/TeraboxCom.java)
  and [Filemoon crawler](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/decrypter/FilemoonSxCrawler.java).
  Source-domain matches are evidence of an integration, **not** a tested or
  guaranteed download. The TeraBox hoster specifies cookie-only login and a
  free-account requirement for its own free download path.
- The same JDownloader source mirror includes [Userdrive](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/hoster/UsersdriveCom.java),
  [APKAdmin](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/hoster/ApkadminCom.java)
  and a legacy [Sfile.mobi](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/jd/plugins/hoster/SfileMobi.java)
  plugin. The latter's pattern names `.mobi`, not the observed `.co` links;
  none of these plugins was run or verified on the example files.
- The [My.JDownloader API](https://my.jdownloader.org/developers/) lists
  LinkGrabber add/query/move operations and download-status methods. Its
  [LinkCollector implementation](https://github.com/mycodedoesnotcompile2/jdownloader_mirror/blob/9c617274f4803430b3c7f1af46a21ef95ff1c9e9/svn_trunk/src/org/jdownloader/api/linkcollector/v2/LinkCollectorAPIImplV2.java)
  handles `autostart` and `autoExtract` fields; actual job isolation, user
  settings, authentication and completion behavior still need testing.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
  and [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
  describe communication with an installed local host, including different
  host registration/allowed-extension rules. They do not provide a built-in
  JDownloader bridge or remove the need to install and secure a helper.
- [yt-dlp Filemoon.to issue](https://github.com/yt-dlp/yt-dlp/issues/12093)
  was closed as not planned after an unsupported-URL report. Do **not** claim
  stock yt-dlp supports this exact video host; verify current support separately.
- Chrome's documentation for [cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
  and the [downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
  describes permissions and direct downloads; neither API turns a landing page
  into a final file automatically.

**Licensing:** Keiyoushi is Apache-2.0; Manga Downloader is AGPL-3.0; the
JDownloader plugin source states GPL-3.0-or-later. [MEGAcmd's license](https://github.com/meganz/MEGAcmd/blob/46d2f8c036c38999d3625b8d2baf49a1ec14d89e/LICENSE)
has BSD-style terms for most components and GPL exceptions, including its
interactive shell; check its dependencies and distribution details as well.
The extension trees are MIT (the repository root has a separate Unlicense file).
Study behavior rather than copying code blindly; review attribution, notice and
copyleft obligations before incorporating third-party implementation code.

### Verification gates before a live adapter/release

- [ ] Obtain sanitized **non-explicit, lawful and authorized** structural samples: one
      single-chapter title/reader, one multi-chapter title/reader, a listing
      including pagination, and examples of each external-link section. Record
      structural HTML/DOM and hostnames/status/content types, not image/file
      bytes. Follow [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md); redact cookies,
      authorization, signed queries, fragments/keys, personal information and
      unrelated browsing data. Never commit media or secrets.
- [ ] Compare raw response HTML with rendered DOM and the ordered reader list;
      record actual selectors/attributes and whether both reader servers have
      equivalent page ordering. Test only normal access for the user's session.
- [ ] Prove a single authorized chapter end-to-end in Chromium: identity,
      selected pages, image bytes and MIME/signature, ordered archive, counts,
      retries, cancellation and a clear failure for restricted pages. No
      Chromium download is claimed until this passes. Repeat in Firefox only if
      ported; do not claim Firefox support without its own pass.
- [ ] Add synthetic, non-explicit fixtures for encoded slugs, multiple chapters,
      duplicate markup, lazy/placeholder images, two servers, mixed image
      formats and hosts, counts with inserts, empty/locked readers, bad URLs,
      redirects, one failed page and unrelated page images. Cover popup,
      bookmarks/history, batch, listing pagination and the Chromium manifest;
      cover Firefox separately if that port is undertaken.
- [ ] Add synthetic mirror fixtures: all three video providers plus a repeated
      chapter button; two Android architectures with four alternatives each;
      unknown hosts; a misleading off-host button; `File Not Found` in an HTTP
      200 response; missing/locked shares; and same rounded sizes with different
      bytes. Assert no variant mixing, no false completion, no unsafe auto-run,
      and explicit same-variant alternatives after a failed host.
- [ ] Test URL/security boundaries with dummy keys and tokens: preserve a MEGA
      fragment for explicit handoff but never log or persist it; redact signed
      URLs; reject credential-bearing, local/private and lookalike redirect
      targets; bound retries; handle expired links and user authorization; and
      never send secrets to third-party resolvers. Exercise Chromium first and
      ensure unknown API or CORS behavior fails to a clear manual option; test
      Firefox separately if support is added.
- [ ] If external automatic downloads are separately approved, use user-owned,
      harmless test files with known hashes on each provider. Verify the actual
      permitted login/authorization and redirect flow, completion and byte hash,
      cancellation, expiry and failure states. Start with MEGA and TeraBox;
      record only sanitized results, never the test keys or binaries in Git.
- [ ] For any approved JDownloader bridge, use a mock API first: one selected
      link per job, no unapproved mirrors, no auto-extraction or execution,
      job-scoped status/cancellation and no changes to unrelated downloads.
      Then test provider plugins and the user's settings with harmless files;
      verify that no-extraction survives packagizer rules and that partial,
      offline, authentication and manual-action states are reported correctly.
- [ ] Define and test batch availability, completeness and safe handling, and
      decide the treatment of optional promotional inserts. The owner chose a
      combined batch when available, with separate chapter archives as the
      expired-host fallback. Decide separately whether hosted-PDF link handoff
      and video/game link display belong in this extension; obtain separate
      approval and per-host evidence before automatic external files.

**Open questions:** Should optional promotional inserts be included? If
automatic external downloads are approved later, should they use extension-only
adapters or an optional desktop integration? Which specific hosts merit
independently tested automatic support?
---

## DoujinDesu

**Domain:** `https://doujin.desu.xxx/`

**Reviewed:** 2026-10-27. **Status:** candidate only; medium-to-high
complexity. No adapter or image download has been implemented or tested.

### What was observed

- The homepage and [`/explore`](https://doujin.desu.xxx/explore) returned a
  catalog with manga/manhwa/doujinshi labels, series links shaped like
  `/manga/<slug>`, and chapter links shaped like `/reader/<UUID>`. These are
  separate identities: a series may have multiple chapters and a chapter ID
  is not necessarily numeric. Covers/banners appeared on `pic.desu.xxx`;
  **thumbnail hosts are not proof of chapter-image hosts**. No reader-page
  DOM, image bytes, browser session, login or final download was tested.
- [Keiyoushi's DoujinDesu source](https://github.com/keiyoushi/extensions-source/blob/6768cbc2049c5e07d67ea1ac667af73f9737596a/src/id/doujindesu/src/eu/kanade/tachiyomi/extension/id/doujindesu/Doujindesu.kt)
  models series, chapters and ordered page URLs. Its companion
  [DTOs](https://github.com/keiyoushi/extensions-source/blob/6768cbc2049c5e07d67ea1ac667af73f9737596a/src/id/doujindesu/src/eu/kanade/tachiyomi/extension/id/doujindesu/Dto.kt)
  and [decryptor](https://github.com/keiyoushi/extensions-source/blob/6768cbc2049c5e07d67ea1ac667af73f9737596a/src/id/doujindesu/src/eu/kanade/tachiyomi/extension/id/doujindesu/Decryptor.kt)
  show an API response/decoder dependency, not a plain static reader alone.
  The redesign report was closed by [PR #16944](https://github.com/keiyoushi/extensions-source/pull/16944),
  merged 2026-06-26; it is **not** evidence that the upstream source remains
  broken. It is also not a current browser-extension transfer test.
- A separate [JavaScript reference](https://github.com/PATKORRRR/doujin-scraper/blob/9cea7975ee3bfe1c3325a9a2554eab2d6e27fa5d/src/doujindesu.js)
  exposes series/chapter functions and describes credentials and a rotating
  response key. It targets a Node-style environment and has not been run here;
  it is not an automatically browser-compatible or authorized drop-in.
  Its repository is MIT; Keiyoushi is Apache-2.0. Review attribution and
  licensing before copying or porting either source.

### Proposed approach and gates

1. Share the **generic** series → chapter → ordered page-reference model
   planned for Sasangeyou, but implement a separate DoujinDesu resolver. Use
   source-qualified series slugs and chapter UUIDs; do not cast them to
   numbers, infer chapters from URL text, or conflate sites' identities.
2. First compare the authorized, rendered reader DOM with an actual page-list
   response. Prefer a documented, permitted interface or the user's normally
   accessible rendered page. Determine whether the ordered pages are present,
   how pagination/lazy loading works, and which image hosts, redirects,
   referrer and cookie behavior Chromium actually requires. Test Firefox's
   behavior separately if ported. The community API protocol may change and
   its permission/stability is unknown.
   Do not embed or solicit application secrets, send them to CDNs, execute
   remote scripts, or attempt to defeat login, CAPTCHA, paywall or DRM.
3. Validate HTTPS origins and paths per source; reject unexpected/local
   destinations and unsafe redirects. Add only measured permissions. Preserve
   image order, formats and meaningful chapter labels; test UUIDs, duplicate
   chapters, decimal chapters, empty/locked responses, lazy placeholders and
   both single-chapter and multi-chapter selection. Reuse the existing ZIP/CBZ
   and other outputs only after the common pipeline can carry actual page URLs.
4. Before claiming Chromium support, use sanitized, lawful and authorized
   non-explicit fixtures and prove one series/reader → one completed archive.
   Confirm page counts, ordering, image MIME/signatures, cancellation, rate
   limits and errors; record no media, credentials or signed URLs in Git. If a
   Firefox port is later undertaken, verify it independently before claiming it.

---

## nhentai.net official archives

**Reviewed:** 2026-10-27. This is not a new domain: `nhentai.net` is already a
supported source. The question is whether its **own** packaged downloads can
replace local page assembly. **Yes in principle, and ZIP/CBZ code already
exists**, but it has not been live-verified and has important safety gaps.

### What about the “NHentai videos” gist?

The owner asked about [this third-party gist](https://gist.github.com/devinschumacher/affcf558d4ab8f6a16cb495ee07cc1ac).
Despite its title, its own abstract and format table say nhentai is primarily
an image-gallery site with **no native video streams**. The generic video
quality ladder and the mention of occasional external embeds are not backed by
a verified `.net` video example. The current official documentation describes
gallery pages and image/CDN paths, not a native video feature; we found no
verified evidence of one. That is not a claim to have inspected every page.

The gist also promotes a separate extension, and its December 2025 claim that no
API is documented is stale: nhentai.net now publishes the API v2 documentation
linked below. Do not treat the gist's generic `yt-dlp`/FFmpeg examples as proof
of video support or use its advertised extension as an implementation source;
it was not installed or audited. Sasangeyou's external video mirrors are a
separate site and do not imply that nhentai.net hosts video.

### Official API versus current implementation

The current [official API v2 OpenAPI specification](https://nhentai.net/api/v2/openapi.json)
(version `2.0.0+eb85a3a` when reviewed) documents
`POST /api/v2/galleries/{gallery_id}/download` with `format=zip`, `cbz` or
`torrent`. It requires a user token or API key, the `allow_downloads` feature
flag, and returns a short-lived `url` plus `expires_at`. Third-party extensions
should use a user-generated API key as documented, not a password or embedded
secret. The [official changelog](https://nhentai.net/api/v2/changelog) describes
ZIP as pages plus `meta.json`, CBZ as adding `ComicInfo.xml`, and torrent as a
`.torrent` file. These are format descriptions, **not a statement that images
are original uploads or that all three payloads have identical pages**.

The spec currently lists ZIP/CBZ issuance limits of 10 per 5 minutes per IP,
7 per 5 minutes per user, and 10 per 5 minutes per API-key owner; torrent has
separate limits. Limits can change and apply as relevant to the authentication
mode. Queue conservatively and honor the server's actual response. The
[official CDN guidance](https://nhentai.net/api/v2/docs) says to use the
archive endpoint rather than reconstruct full-gallery archives by walking CDN
page URLs; the changelog also says systematic bulk scraping/full-site mirroring
is unsupported. Do not treat a disabled feature, rate limit, or access failure
as permission to evade those rules. A single archive avoids many page requests,
but it is not guaranteed faster: the provider's changelog mentions per-stream
throttling, and actual throughput and memory use still need measuring.

| Question | What this repository actually does today |
| --- | --- |
| Where? | Both extension trees contain `src/background/ArchiveDownload.ts`, a `Downloader.ts` integration, `options.html`, and mock tests. This is source-code evidence, not a verified released build or real-server result. |
| How is it enabled? | In Options, save an nhentai.net API key locally and enable **Download whole galleries as one ready-made file from the server**. The toggle defaults off; **leave it off pending the safety work below**. The path requires matching nhentai source/ID provenance, ZIP or CBZ, a flat per-gallery output and an inspectable empty archive. Ambiguous jobs, shared combined archives, PDF and raw use the page path instead. |
| What gets saved? | Chromium asks for a short-lived URL, reads a bounded response, validates ZIP structure/entry CRCs, image signatures and count, then hands the unchanged bytes to a tracked browser download. The key is attached to the API, **not** delivery. An eligible archive failure is reported, not silently converted to page requests. This is offline-tested only; a `.zip` alone does not prove completeness or quality. Firefox retains the earlier, less-safe behavior. |
| Torrent? | The official API documents it, but this extension's format selector and native archive client accept **ZIP/CBZ only**. There is no implemented torrent download, client or torrent-completion tracking. A `.torrent` is a descriptor; it is not the gallery itself. |
| Proven? | Offline tests cover source isolation in both trees and the newer Chromium archive validation, rate-limit, worker/offscreen completion and failure paths. They do not verify live archive content or policy. No real API key, live archive request, media, torrent transfer, real-browser run or quality comparison was used. |

Both options pages say to leave this experimental path off. Chromium now reports
eligible archive failures and performs the offline-tested checks below; Firefox
still has the earlier warning and behavior. The panel no longer asserts that
every site's own Download button produces a lower-quality copy. The reported
native-button/reader file-size equivalence remains a user observation, not an
independently verified byte comparison.

### Important existing issues—fix before relying on the option

1. **Cross-site misrouting — fixed in source, offline-tested.** Before the
   change, an eligible synthetic Hitomi job with the global option enabled
   POSTed its numeric ID to the nhentai.net endpoint and saved the mocked
   response under the requested name. Both
   [`Downloader.ts`](NHDW_Extension_v3.0.0/src/background/Downloader.ts)
   copies now require a matching canonical adapter, metadata site/ID and
   independent URL/job identity before an archive request, plus a flat layout
   and inspectable empty writer. Ambiguous legacy jobs fall back to pages.
   Synthetic unit, worker, relay and offscreen tests cover the isolation and
   supported-route cases; no live gallery was requested. This fix does not
   address the other defects below, nor repair already-installed old builds.
2. **A 200 response is not enough — hardened in Chromium only.** A historical
   offline mock saved HTML as ZIP. Chromium now rejects unexpected content,
   malformed/truncated ZIPs, invalid CRCs and image headers, unsafe/duplicate
   names, unsupported entries, mismatched expected image counts and bounded-size
   violations. It requires a plausible future expiry and an HTTPS URL on the
   temporary `nhentai.net` family allowlist; delivery forbids redirects, cookies,
   referrers and the API key. Limits are 128 MiB compressed, 256 MiB expanded,
   64 MiB per entry and 5,000 entries. A Blob plus a validation buffer is still
   materialized. These checks do not decode images or prove page identity or
   original bytes. Actual delivery hosts, CORS, host permissions, expiry and
   Chrome completion/naming are unverified; the temporary allowlist may reject
   legitimate delivery. Firefox still has the earlier HTML/URL/expiry defects.
3. **Fallback and throttling — improved in Chromium only.** Eligible archive
   failures are reported without silently switching to CDN pages. A 120-second
   `Retry-After` is no longer shortened; waits above 15 seconds return 429
   without an early retry, the current batch defers its remaining titles, and
   paginated work stops. Keyed popup metadata also surfaces the 429. Browser
   completion tracking is required for the API archive in synthetic worker and
   offscreen tests. These are not a cross-context/restart-persistent cooldown;
   separately queued jobs and real-browser completion still need verification.
   Firefox retains its earlier silent fallback and 15-second cap.
4. **Normal image validation and metadata — not fixed.** An offline mock
   confirmed that an HTML body over the size threshold, labelled `image/jpeg`,
   is accepted and archived as a `.jpg`: the image-fetch path checks MIME and
   minimum size, not actual image signatures. Raw URL handoff cannot inspect
   bytes. The batch path now rejects explicitly mismatched supplied metadata,
   but code inspection found fetched metadata and single-job source/ID conflicts
   are not uniformly validated; that separate finding is not yet reproduced.
   Title-match fallback is not proof of identical contents across sites.

### Button integration: goal and evidence boundary

**Proposed approach:** make the site's documented, server-made ZIP/CBZ available
through the extension's existing download actions for **nhentai.net only**, using
the existing keyed API path after the defects below are fixed. This avoids
building a whole-gallery ZIP from individual CDN requests and fits the site's
published API guidance. It is a plan, not a claim that the feature has shipped
or that the website's own button and API return the same bytes.

The extension already uses the site's `#download` element as an **insertion
anchor** for its own on-page controls in `src/utils/titleBookmark.ts`. We have
not observed an authorized click or its network flow; the selector does not
prove how the website's button works, which formats it offers, whether it uses
this API, or what account access it requires. A [capture guide](SITE_CAPTURE_GUIDE.md)
now describes how to observe the normal button action without sharing credentials
or signed URLs. Leave that site-owned button untouched. Integrate the documented API behind the **extension's** actions, not
by silently clicking, replacing or intercepting the site's button. A user can
still use the site's own control manually, subject to its normal access rules;
that separate browser action is not automatically an extension-queue success.

If literal button equivalence is important, first inspect a lawful, authorized
session on a non-explicit test gallery: record only button labels, request
method and path shape (with the gallery ID replaced by a placeholder), response
status, format, expiry presence and delivery **hostnames**. Redact the body,
cookies, tokens, query strings, fragments, identifying metadata and files.
Determine whether the site's documented API and button
really share a backend and compare their archives only if permitted. Do not
harvest the site's session token, reverse-engineer authentication, replay a
private endpoint, or claim keyless extension support from this observation.

### Proposed user flow and compatibility

1. On an nhentai.net gallery, the user selects ZIP or CBZ and chooses an
   **Official server archive** method in the existing extension panel/settings;
   the extension's normal **Download** / **Save offline** action submits the
   job. No new generic “lite/source” buttons are proposed for other sites.
2. The extension checks for the user's own API key and the existing
   `useServerArchive` preference. If no key is configured, direct the user to
   the existing key settings or let them use the site's control manually; do
   not copy browser cookies or silently switch methods. The documented API also
   supports user tokens, but this extension currently uses API keys only.
3. Show the selected method and format **before** enqueueing. A queued job
   captures source, gallery ID, method, format, naming and folder preferences,
   not the short-lived URL or key. Issue the API request only when the job is
   ready to transfer. Show requesting, waiting, downloading/verifying and
   completed/failed/cancelled states; percentages only when measurable.
4. Keep the opt-in default and existing `useServerArchive` choices intact on
   migration. Map an existing `true` to this method **only for verified `.net`
   jobs**, never for other sites; `false` must not turn it on. A per-job method
   override is proposed so a user can make an explicit choice without changing
   another queued job. Tell existing opt-in users about the new non-silent
   failure behavior. A future default change needs an owner decision after
   the policy and quality checks, not an assumption that the outputs match.

| Entry point | Existing wiring to retain | Planned behavior |
| --- | --- | --- |
| Gallery panel | `src/preview/popup.ts`: `#button` sends `downloadDoujinshi`; `#buttonSaveOffline` sends a one-gallery `downloadAllDoujinshis` with list settings. | Both expose or clearly summarize the selected method and preserve the selected format, filename and Download again behavior. The single-gallery message must carry verified source provenance. |
| Gallery page | `src/content/titleBookmark.ts` adds **Save offline** next to the site button and sends a one-gallery batch using list settings. | Reuse it; route the chosen method and source through the worker. Do not alter the site's own button or synthesize a click. |
| Listing/card selection and Bookmark | `src/content/listControls.ts`, `src/preview/popup.ts` and `src/utils/batchPipeline.ts` submit selected galleries; multi-site selections are split into site-specific jobs. | Preserve site-qualified IDs, duplicate checks, per-gallery choices and queue order. Native archives are eligible only for separate `.net` ZIP/CBZ outputs; other sites retain their own methods. |
| Queue, progress and retry | `src/background/background.ts`, Chromium `src/offscreen/offscreen.ts`, and `src/background/downloadControl.ts` relay and track jobs. Firefox has a separate worker/`src/content/siteUi.ts` path. | Carry the method through Chromium worker/offscreen and retry messages; test its worker fallback. Honor cancellation and browser completion. Test Firefox's path only if ported. |
| Settings and copy | Both trees have `options.html`, `src/preview/popupSettings.ts`, and local API settings in `src/utils/apiAuth.ts`. | Update Chromium to explain the key, method, format, limits, failure behavior and unverified quality; preserve local-only keys and other sites' preferences. Update Firefox separately if ported. |

**Format and output boundaries:**

| User selection | Official-method behavior for the first release |
| --- | --- |
| One ZIP or CBZ; or a batch saved as separate ZIP/CBZ files | Request one official archive per gallery at its turn in the rate-limited queue. Keep the selected filename/template, master folder and conflict policy. |
| A single combined batch ZIP/CBZ | Do not silently produce separate files or switch to page fetching. Explain that the endpoint returns one archive per gallery; offer the user's explicit choice of separate official files or cancellation/another permitted mode. A future archive-merge design requires safe bounded parsing and metadata/naming rules. |
| PDF or raw images | The API does not offer these outputs. Explain the limitation and let the user explicitly choose ZIP/CBZ or another **permitted** method; do not label an implicit conversion or page walk as the official archive. |
| Torrent | Not part of this change. If separately approved, save a `.torrent` **descriptor**, not a finished gallery; warn that a separate client/peers are needed and peers may see the user's IP and receive uploads. Never auto-start, seed or record content success from a descriptor. |

For an unavailable `.net` title, other supported sites are independent
user-selected alternatives, not guaranteed copies. The existing automatic
fallback chains apply only to imhentai, hentaienvy and hentaiera, **not**
nhentai.net. Do not search or switch sites by title, reuse `.net` IDs, or send
`.net` credentials to another origin as a fallback.

### Implementation steps and remaining work

The owner authorized this Chromium work. The list below describes the target
architecture; the current state and limits above supersede its future-tense
items. Per-job method selection and execution-time-only worker-held credentials
are not yet implemented; existing offscreen jobs still receive the local key in
memory. Do not log or persist that key or signed delivery URLs.

1. **Source and request boundary (contained fix applied).** Both source trees
   now guard the `Downloader.ts` archive POST with independently established
   job/URL provenance, canonical nhentai adapter, matching site/ID and an
   eligible empty flat writer. The single-gallery popup propagates site and URL;
   batch jobs use their selected site/key rather than deriving trust from the
   returned JSON. Missing legacy provenance falls back to pages, because
   `siteKeys.ts` defaulting a historical bare ID to nhentai is not proof for an
   authenticated request. The fix has synthetic unit and VM integration
   coverage, but more complete per-adapter and real-browser tests remain open.
2. **Method as job data.** Define a separate per-job method choice alongside
   `formatOverride` rather than pretending it is a new file format. Propagate
   it through Chromium's `jobOverridesFromRequest`, `BatchJobOptions`, the
   queued-job and retry paths, and the `Downloader`. Avoid reading a mutable
   global setting halfway through an already-queued job; resolve it once. Keep
   mixed-site grouping, duplicate checks, naming and legacy preference migration
   compatible. A retry must retain its original site/method/format, but obtain
   the current local key again rather than persist it in retry records.
3. **Authenticated request and typed outcomes.** In `ArchiveDownload.ts`,
   replace the undifferentiated `null`/silent fallback with explicit outcomes
   such as missing key, unauthorized, feature disabled, rate-limited, invalid
   response, network failure and cancellation. The key remains in
   `chrome.storage.local`, is used only on the exact `.net` API origin, never
   sent to content scripts, delivery hosts, logs or sync storage. Chrome's
   offscreen document cannot read storage: have the worker read the key and
   issue the API POST for an authenticated, validated offscreen job at run
   time, returning only the short-lived result in memory. The existing
   offscreen `batchPipeline.ts` also uses the relayed key for `.net` metadata;
   move those keyed requests behind a validated worker call as well, or design
   another execution-time-only credential handoff without keeping the key in a
   queued job. Preserve metadata behavior and test both Chromium execution
   paths. Chrome's worker fallback issues requests in its worker context; if
   Firefox is ported, independently test its worker implementation. Verify
   internal-message sender/job identity and do not put the key or signed
   URL in queue/retry records, error messages or fixtures. Reject API redirects
   to other origins before forwarding any authorization header.
4. **Queue and limits.** Request the URL just before its transfer, not when a
   job is queued; validate its finite future Unix `expires_at`. Serialize
   issuance and pace user-selected jobs conservatively within all applicable
   published rolling-window limits above; serialization by itself does not
   satisfy a five-minute quota. Other devices can share an IP/account, so a
   server `429` remains authoritative. Honor the **full** `Retry-After` (seconds
   or HTTP date); if a long delay is unsuitable, pause/stop with an explicit
   retry-after time, never retry early. With no usable header, use conservative
   bounded backoff or stop rather than hammering. Avoid repeated issuance for
   expired URLs; allow only a bounded fresh request when safe and within limits.
   Test browser restarts/worker suspension so waiting cannot turn into an early
   retry, and cancel queued/waiting/in-flight work without marking success.
5. **Delivery and integrity.** Validate HTTPS, no embedded credentials, a
   provider-documented/observed permitted delivery origin and every redirect
   **before following it**; reject local/private or unknown targets. Determine
   the actual required host permissions/CORS from an authorized sanitized test,
   not a broad wildcard. Send no API key or session cookies to the delivery
   URL; redact its signed query/fragment everywhere. Reject HTTP-200 HTML or
   challenges, empty/truncated data and invalid ZIP/CBZ; magic alone is not
   enough. Validate ZIP structure/entries with bounded size, entry-count and
   resource limits, checking page count/order when reliable metadata exists.
   Do not execute files or extract arbitrary paths. If validation cannot be
   completed within limits, surface an unverified/failure state rather than
   recording a verified gallery. Before replacing a ZIP, also prove it is an
   eligible empty per-gallery output; failure to inspect it must fail safely,
   not discard pages already accumulated in a shared archive.
6. **Delivery strategy trade-off.** The current Blob approach permits
   validation before saving but buffers the whole archive; set explicit size
   and memory limits and report failures. Enforce a byte cap while reading,
   including when `Content-Length` is absent or inaccurate, rather than
   calling unbounded `response.blob()`. Investigate a streaming or browser
   download-manager alternative only if it can uphold redirect, privacy and
   integrity guarantees in Chromium; verify Firefox separately if ever ported.
   A direct URL handoff is not automatically credential-free: [MDN documents](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download)
   that Firefox downloads include matching cookies, and browser download history
   may retain the signed URL. A browser “complete” event also does not itself
   prove the body is a valid archive. If those boundaries cannot be verified,
   keep the bounded Blob path or report the limitation; do not claim parity.
7. **Status, history and failure policy.** No page-by-page fallback after an
   explicit official-method failure: show the actual reason and offer retry,
   settings or the user's manual site action as appropriate. Do not evade a
   disabled feature, login requirement or rate limit. The provider's guidance
   discourages reconstructing complete galleries from CDN page URLs; any
   separately chosen reader method must be permitted and cannot bypass a block.
   Record the existing `nhentai:<id>` history entry only after a validated file
   and browser-reported completion; failures, cancellations and descriptor-only
   saves do not count. Preserve Download again and file verification semantics.
8. **Quality and copy.** Both trees' copy now distinguishes page-reader images
   from the separate site button, and Chromium's option warns of its current
   limitations. Local ZIP/CBZ preserves the bytes actually fetched; the API
   archive's contained images have not been compared independently. The owner's
   same-file-size observation is useful but does not establish byte identity or
   original-upload provenance.
   Also audit PDF-quality wording for conversions. Previous owner decisions
   in [WORKLIST.md](WORKLIST.md) items 74/75 remain relevant for other sites;
   the new `.net` request is not permission to switch those sites' pipeline or
   reintroduce generic lite/source buttons. Do not label the `.net` archive
   lower- or higher-quality until the comparison below has been performed.

### Verification and release gates

- [ ] Red-first Chromium unit tests: source/ID collisions and legacy provenance;
      key/toggle migration and per-job overrides; every status; 120-second and
      HTTP-date `Retry-After`; missing/expired URLs; HTTP and redirect rejection;
      no secrets/cookies on delivery; HTML-as-200, corrupt, empty, oversized and
      path-traversal archives; cancellation and retries.
- [ ] Chromium synthetic integration/e2e tests: popup Download and Save offline,
      on-page control, cards, Bookmark, mixed-site batch, separate versus combined
      output, unsupported formats, queue/retry, filename/folder conflict, progress
      and browser completion. Assert no history on partial/failed or unverified
      delivery; ensure the site's button is not replaced or clicked. Exercise
      Chrome offscreen **and** worker fallback; run the existing archive and
      relevant test suites.
- [ ] Authorized manual test in current desktop Chrome with a small, non-explicit
      gallery and a user-owned API key: feature-flag/permission behavior, real
      response hosts, ZIP and CBZ validity, filename, cancellation, expiry,
      slow/rate-limited behavior and actual completion. Record only sanitized
      aggregate results; no media, account data or secrets in Git. If access is
      unavailable, leave this gate open and say so.
- [ ] The contained isolation fix was ported and checked offline in Firefox;
      independently test its manual, security and archive-completion paths
      before claiming or releasing Firefox support. Firefox device work is
      deferred and is not a Chromium release gate.
- [ ] Complete the quality comparison below and verify the user-facing copy;
      make any default change only after the owner reviews the findings. The
      actual website button's behavior/equivalence is a separate optional gate,
      not a prerequisite invented from the `#download` anchor.

### Are the images original or compressed?

**Unknown until compared.** ZIP compression is lossless packaging, and CBZ is
usually a ZIP container with a comic-reader extension; neither guarantees what
quality or format the **contained images** had before packaging. The site may
serve resized or already-compressed images, or supply different files in its
archive and reader. A smaller archive, a `.webp` extension, or identical
pixel dimensions alone does not prove the same visual quality or source.

The current local ZIP/CBZ path writes the fetched image bytes into archive
entries without an image re-encode. That proves only what happens *after* those
bytes were served, not that they were the original upload. PDF conversion can
make different encoding choices. Native ZIP, native CBZ and torrent payloads
could also have different metadata, naming or content; none has been compared.

**Proposed comparison:**

1. Choose a small, lawful, non-explicit, user-authorized test gallery and obtain
   the official archive in a normal session. Compare with an already available
   extension-made archive or normally viewed reader pages only where the site
   permits the comparison; do not initiate systematic CDN walking contrary to
   its guidance. If necessary, ask the provider for a suitable test sample.
2. Inspect ZIP/CBZ safely without executing files. Pair page entries in actual
   reading order; report missing/extra pages and distinguish metadata/cover
   files. Compare each paired page's dimensions, image format, byte length and
   SHA-256 hash. Compare all pages if permitted, otherwise label the subset.
3. Equal per-page hashes prove those two retrieved files are byte-identical;
   they **do not** prove equality to the original upload. Different hashes mean
   the bytes differ, not automatically which version is better. To establish
   original-upload quality, compare against the original files or reliable
   provider documentation. Record only aggregate, sanitized results; never
   commit media, identifying metadata, keys or signed URLs.

---

## NH lookalike scope

The owner reports that the `nhentai.to` download button redirected to ads and
that the site is excessively ad-heavy. We did not independently reproduce the
reported flow. On the owner's instruction, `.to` is **removed from the candidate
rosters and excluded from this plan**, not prioritized for a new adapter.

The remaining, independently listed lookalikes are deferred; the earlier
`nhentai.com` entry is retained without implying it is supported. Similar names
are not evidence of shared ownership, API, authentication, gallery IDs or
identical content. Keep `.net` credentials and signed URLs confined to the
official flow, and do not add wildcard origins or automatic cross-site fallback.
The user's report concerns `.to`; it is not a finding about any other site.
