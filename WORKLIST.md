# Worklist — nh-dw-2.0

**Live, ordered. Updated 2026-09-14** (session
`arena/01a09ee5-nh-dw-2-0`: **3.8.0 — item 47 landed**; items 48–52 planned,
see `MULTISITE_V4_PLAN.md`. Previous: 3.7.0, PR #40).

This is the single place to look for *what to do next*. The other two documents
carry the depth:

| Document | What it is for |
|---|---|
| **`WORKLIST.md`** (this file) | Ordered, statused list of open work. Start here. |
| **`SESSION_HANDOFF.md`** | What the last session changed and why, the "Do not" rules, real-browser verification steps. Read its top block before touching code. |
| **`IMPROVEMENT_BACKLOG.md`** | Full specs and history for every numbered item, oldest first. |
| **`BOOKMARK_QUEUE_PLAN.md`** | Design and rationale for the 3.7.0 bookmark queue specifically. |
| **`MULTISITE_V4_PLAN.md`** | Multi-site v4: decision record (merge vs new repo), site roster, cooldown analysis, bucket list. Planning mode, no code. |

Item numbers are shared with `IMPROVEMENT_BACKLOG.md` and are never reused.

---

## Mandatory first step, every session

**Review the previous session's diff before writing new code.** This is a rule,
not a suggestion — it is recorded in `SESSION_HANDOFF.md` and it has paid for
itself twice. Hunt for three specific things:

1. **Missing logic** — a message handler with no sender, a setting with no
   reader, a UI notice that promises something the code never does.
2. **Misaligned code** — a guard applied in one path but not its sibling; a
   default that contradicts its own comment; a documented behaviour that is dead
   in every code path.
3. **Broken code** — a state read that clobbers a concurrent write; an
   optimistic UI update wiped by the next refresh; a listener registered in the
   wrong scope.

Then write a test that **fails on the pre-fix build** for anything found. The
3.7.0 session ran this on its own output and found **six** defects (five of them
in code written hours earlier in the same session). The 2026-09-05 session found
**eight** across four passes.

Two cheap checks that have caught real bugs here:

- `grep -rn <exportedName> src/ scripts/ test/` — an export with one hit (its own
  declaration) is dead code.
- For any guard you add, `grep` for every caller of the unguarded original and
  ask whether each one is safe by construction or by accident.

---

## Open, in the order I would take them

### 42. Real-browser pass for the Queue tab — **highest priority**

**Why first:** 3.7.0 shipped on offline evidence. `npm run test:browser` has
**never** run in this environment, so every claim about rendering, restart and
the side-panel API is a VM result or an expectation.

Verify in a real Chrome 116+ profile:

- [ ] Bookmark three cards → close the browser → **restart the machine** →
      reopen → the list, its ticked rows and its collapsed state are identical.
- [ ] Thumbnails actually paint from `t.nhentai.net` (no host permission is
      involved; confirm that is true and not a silent CSP block).
- [ ] "Open docked ↗" opens the side panel **from the popup**, and is **hidden**
      when the document already is the panel.
- [ ] Paste `366224,177013` → **Download now** → both files land, named by the
      list-mode template.
- [ ] **Add to queue** with no nhentai tab open shows the "Open an nhentai.net
      tab" notice, and with one open resolves titles and covers.
- [ ] Auto-capture on a real infinite-scroll page: cards collect as they render,
      and turning it on mid-page collects what is already there.
- [ ] The ☆ survives nhentai's own re-renders without duplicating.

Then add the steps to "Required real-browser verification before PR" in
`SESSION_HANDOFF.md`.

### 43. ☆ on the single-title preview and on similar-gallery rows

**Cost: low.** The worker side is already done — `bookmarkAdd` accepts
`source: "page"` and `"similar"`, and `thumbnailUrlFromGallery` derives a cover
from a resolved `media_id`. Only two render sites are missing:
`popup.ts #doujinshiPreviewAsync` (single title) and the similar-galleries list
built by `message.similarList`.

Decision needed: use the derived `media_id` thumbnail (the metadata is already in
hand at both sites) rather than leaving the row coverless until enrichment.
Recommend yes.

### 44. Drag-reorder the bookmark list

**Cost: low.** `planBookmarkDownload` already emits ids **in list order**, so
reordering the list already reorders the batch — only the affordance is missing.
Order is already implicit in the stored array; add **no** new field. Must not
fight the row's checkbox / Download / Remove hit targets.

### 45. Per-row cancel of an in-flight download — **the surviving half of P3**

**Cost: high, structurally blocked.** The old "P3 queue UI" item is now split:
the bookmark half shipped in 3.7.0; this half did not, because the blocker was
always about the *job* queue. It still lives as `queuedJobs` inside the offscreen
document and is surfaced only as a count.

Cancelling one specific gallery needs the worker to mirror job state into
`chrome.storage.session` with per-item identity, and the offscreen loop to check
it between pages.

**Do not** solve this by growing the bookmark list into a job queue — see the
"Do not" rules in `SESSION_HANDOFF.md`. Until it lands, the existing global
pause / resume / `clearQueue` are the only stop controls.

### 46. Firefox port of the bookmark queue

**Blocked behind 37.** `NHDW_Firefox_v1.0.0` is untouched by 3.7.0 and still
lags at 3.3.1. `chrome.sidePanel` has no Firefox equivalent — the analogue is
`sidebar_action`, and "Open docked ↗" must degrade to a message rather than a
failed call. Everything else ports directly: `bookmarkQueue.ts` is
storage-agnostic, and the worker messages and content-script star are ordinary
WebExtension APIs.

Without item 37 there is no way to verify the port, which is why 37 comes first.

---

## Carried over from the 2026-09-05 review (unchanged)

- [ ] **37. Firefox panel harness.** That tree has no offline coverage of its
      popup/Settings pane at all. Port `scripts/e2e-popup.js` (its DOM stub is
      reusable verbatim) and wire it into its `npm run test:e2e`. **Blocks 46.**
- [ ] **38. Options-page harness.** `js/options.js` has no VM harness, so
      `options.ts`'s DOM wiring is only typechecked. Needs a stub modelling
      `<select>.options` / `selectedIndex` plus the real `options.html` lists.
- [ ] **39. Decide the empty-token separator — needs a human call, not code.**
      `{id} - {pretty} - {language}` with no language tag produces
      `"123456_- "`. The empty-token behaviour is pinned on purpose by
      `test/parsing.test.js`, so this is a contract, not a bug. Two options,
      both with costs; deliberately undecided.
- [ ] **40. Popup harness does not bootstrap a listing page.** So the panel's
      list-job / PDF-merge / similar-galleries paths are covered only by the
      equivalent content-script phases. Extending it means stubbing
      `getGalleries` + `activeTabGallery`.
- [ ] **41. Non-canonical separators are canonicalised on tick (UX decision).**
      `isTokenOnlyTemplate("{pretty}_{id}")` is `true`, so the first tick
      rewrites it to `"{pretty} - {id}"`. Suggested: an `isCanonicalTemplate()`
      gate routing odd separators to the manual input.

Also carried, older: raw retry-policy follow-ups, raw list-mode verification in
a browser, and the standing fact that **no real-browser verification has ever
run in this environment**.

---

## Planning mode — multi-site v4 (items 48–52, not scheduled)

Settled in conversation on 2026-09-14; item 47 has since landed (3.8.0).
Full design,
decision record (merge vs new repo) and per-site facts:
`MULTISITE_V4_PLAN.md`.

- [ ] **48. Adapter layer v2 + multi-site side panel + site-aware paste box** —
      where the lab-clone UI rework lands if merged. Follows 49 on purpose.
      Owns the per-site job-splitting design for mixed-site queue selections
      and the site-aware worker messages (plan §4.2).
- [ ] **49. Hitomi.la adapter** — first new site; avif plumbing; raw-mode
      default for 1 GB-class galleries.
- [ ] **50. Mirror-network adapter** (imhentai / hentaienvy / hentaiera, with
      hentaifox pending spike) + reading-vs-zip comparison + per-site pacing.
      No cooldown bypass — see the plan's Do-not rules.
- [ ] **51. Streaming ZIP writer** — OPFS / File System Access, memory
      O(one page) instead of O(gallery).
- [ ] **52. History export/import (JSON)** — cross-machine carry-over.

Order if called: **49 → 48 → 50 → 51 → 52** (hitomi validates the
adapter contract before the panel rework bakes it in). Rename/rebrand the
repo after 49 proves out; keep the nhentai adapter as the regression control
throughout.

### 53. hentaiera adapter — first non-nhentai site, end to end (2026-09-15)

**Scope narrowed by the user's call: one site, working like nhentai.** No
cross-mirror fallback, no multi-site panel, no hitomi. Those stay in items
48–50 and are explicitly not being pulled forward.

Registered after `SITE_CAPTURE_AUDIT.md` audited the first captures. Three
findings that changed the plan:

1. **imhentai and hentaienvy share a content store but not gallery ids** —
   19/19 shared `/033/<token>/` paths, 0/19 matching ids. Fallback between them
   is a host swap on the token, never an id lookup. (Deferred, but recorded so
   it is not re-derived.)
2. **Two storage backends, four frontends** — not "one mirror network" as
   `MULTISITE_V4_PLAN.md` §2.2 assumed. hentaiera serves images from
   `hentaiera.site` (different TLD from the page host) with numeric media ids
   and webp; imhentai/hentaienvy use `/033/<token>/`.
3. **hitomi's CDN moved** to `ltn.gold-usergeneratedcontent.net`; §2.1 still
   says `ltn.hitomi.la`.

Why hentaiera goes first (measured, in `NEXT_CAPTURE.md`): its image path
`/galleries/<id>/<n>.<ext>` already passes the existing `cdnConfig`
`ALLOWED_IMAGE_PATH` regex **unmodified**; the other three need a new one.

**RESOLVED 2026-09-15 (second capture round) — adapter unblocked, no HAR
needed.** The gallery page (`origin/main:view-source era to gallery 694133
.txt`, fetched via git, never switched branch) plus the user's DevTools
screenshot together pin the whole contract:

- Gallery URL `https://hentaiera.to/gallery/<id>/`; reader page N is
  `/gallery/<id>/N/` (document navigations, not an SPA — `1/`, `3/` are type
  `document` in the screenshot).
- `media_id` and `num_pages` come clean from the `application/ld+json`
  `ImageGallery` block: `image` = `galleries/4182258/cover.webp`,
  `numberOfItems` = 396. Matches the listing extraction exactly.
- Full-page image for N is read **off the reader page N's HTML** (screenshot:
  `3.webp` initiated by `3/:234`). The gallery page only ships the first 12
  thumbnails (`<N>t.webp`) — no full-page list — so the adapter must fetch each
  reader page and take the one `galleries/<media>/N.<ext>` URL it declares.
  That also removes any extension guesswork (thumbs all `.webp`; page 3
  confirmed `webp`, 306 kB, type `webp`).

So the earlier "blocked on 1 HAR" line is withdrawn for hentaiera: build it now.
Fetch image/reader pages through the open tab (`tabImageFetch` pattern) so the
browser sends its own Referer/cookies; a standalone Referer requirement (still
unmeasured) then never bites. The HAR remains useful for the *other* sites.

**LANDED this session (adapter core, pure + tested):**
`src/sources/hentaieraSource.ts` (GallerySource impl: host consts, URL/id
matchers, `getImageUrls` → `hentaiera.site/galleries/<media>/<file>`) and
`src/parsing/hentaieraHtml.ts` (`extractHentaieraGallery` from the ld+json
ImageGallery block + per-gallery extension read off the thumbnail strip;
`extractHentaieraReaderImage` from `<img id="reader_img">`). Tests:
`test/hentaiera.test.js` (9 new; 389→**398** passing); fixtures mirror the real
captures incl. a `.jpg` gallery to pin "extension is read, not assumed".
`tsc` build + smoke green. **Registration into `sources/index.ts` is
deliberately deferred to item 48**: wiring it now would let `popup.ts` resolve a
hentaiera id and feed it to the nhentai API (id collision → wrong-site
metadata). The registry stays nhentai-only until the site-aware parsing
selection lands with it.

**Captures complete for three sites (2026-09-15):** `era to.zip` (hentaiera),
`imhen xxx.zip` (imhentai), `envy com.zip` (hentaienvy) are each sufficient for
their site. Envy is the richest — `#readerPagesJson` is a full per-page
`{page,ext,w,h}` map, `data-reader-image-base` exposes the token, reader is
`/g/<id>/n/`. The full per-site contract table, fox + hitomi capture lists, and
next step live in `ADAPTER_WIRING_PLAN.md` §1/§7/§8. **hentaifox and hitomi
remain uncaptured** (fox = 1–2 HARs — no age modal fires for `ID`; hitomi =
HAR + rendered DOM + gallery JS + `gg.js`).

**HAR settled the last unknowns (2026-09-15, `era to.zip` on origin/main):**
full pages are `image/webp` and the reader page self-declares each one
(`<img id="reader_img" src="…/<N>.webp">`); a `Referer` (origin
`https://hentaiera.to/`) is always sent, so image fetches go through the open
tab (`tabImageFetch` pattern) rather than a bare worker fetch; the capture was
logged-out (zero cookies in the HAR).

**Referer is a live risk the HAR exists to settle.** No code path in the
extension sets one — the only custom header is `User-Agent` from
`descriptiveUserAgentHeaders()` (`apiAuth.ts:56`), plus `Authorization` for the
optional nhentai key. Image fetches are bare
`fetch(url, { credentials: "include", cache: "no-store" })`
(`Downloader.ts:692`, `tabImageFetch.ts:45`). If the CDN hotlink-gates on
Referer, the adapter needs a header it currently has no way to send.

**Not blocked, can land offline now:** the listing parser (verified 25/25
cards from the committed capture — gallery id, `media_id`, page count, title),
paste-box shapes (`/gallery/<numeric>/`, zero exceptions across all four
sites), per-adapter `cdnConfig` allowlists, site slugs, and the two
`host_permissions` entries (`hentaiera.to` + `hentaiera.site`).

Correction carried forward: `MULTISITE_V4_PLAN.md` §2's "sandbox cannot resolve
these hosts (DNS failure)" is wrong — DNS resolves; **egress** is blocked
(`SSL_connect: SSL_ERROR_SYSCALL`, same for `example.com`).

### Remaining from the 2026-09-15 session (carry into the next)

1. **Implement the wiring** — `ADAPTER_WIRING_PLAN.md` §5, in order: registry
   (`getAdapterForUrl`/`getParsingForUrl`) → imhentai adapter → flip the six
   seams with the nhentai-API collision guard → `cdnConfig` per-adapter
   allowlists → paste box + `host_permissions` → `test:e2e` → real-browser
   check (the one verification this environment can't run).
2. **Register `hentaieraSource`** only as part of step 1 (see the deferred
   note under item 53).
3. **Capture hentaifox** (1–2 HARs; no age modal fires for `ID`) and **hitomi**
   (HAR + rendered DOM + gallery JS + `gg.js`) — lists in
   `ADAPTER_WIRING_PLAN.md` §7; then add their adapters the same way.
4. **Merge PR #42** (this session's groundwork).

### Pending on the USER (nothing here is scheduled until they act)

- [ ] **⏳ Strategy C go-ahead (item 50).** Chosen and recorded, but the
      user explicitly asked to WAIT for their confirmation before executing —
      other projects are running. When they say go: build the reader-page
      path, run the comparison, decide A vs B. Plain-language A/B/C
      descriptions live in `MULTISITE_V4_PLAN.md` §3 so nothing is forgotten.
- [ ] **⏳ Sample capture for the new sites (unblocks items 49 and 50).**
      Superseded 2026-09-15: the current per-site list is `CAPTURE_GUIDE.md`,
      not `MULTISITE_V4_PLAN.md` §8. First round of captures landed as
      `5 website page source` + `3 live testing note`; audited in
      `SITE_CAPTURE_AUDIT.md`. Egress is still blocked here, so captures stay
      user-owned.

---

## Done recently

- [x] **Self-review pass (2026-09-14, fourth session).** Ran the mandatory
      own-output review over everything this day produced. Three defects
      found and fixed: (1) the `downloadHistory.ts` header design comment
      still described bare-id keying — the composite-keying comment had been
      lost to a same-file parallel-edit race during implementation, so the
      module doc contradicted its own code; (2) `sameGallery()` in
      `siteKeys.ts` was a dead export (zero production callers) — removed
      with its tests, `splitGalleryKey()` kept as the documented structural
      inverse with its item-48 consumer named in a comment; (3) three
      documents said "nine direct `history[id]` lookups" — the real count is
      **ten** (7 listControls + 3 popup). Also documented the latent gap that
      worker messages (`bookmarkAdd/Enrich/Select/Remove`, failed-gallery
      retry/dismiss) carry only bare ids — harmless while only nhentai rows
      exist, folded into item 48's scope. Verified clean: every remaining
      `history[id]` use is filename-based or key-space-internal; all
      bookmarkService markers route through `patchBookmark`; bookmarkPanel
      routes through the composing queue functions. Suite 390 → **389** (the
      dead test went with its export); e2e and smoke all PASS; bundles
      rebuilt and synced to the release folder.
- [x] **cin.* viewer mirrors (2026-09-14).** The paste box already accepts
      every mirror of the reference viewer site (cin.lat / cin.mom /
      cin.monster / cin.wiki / cin.wtf / …) because the parser matches URL
      *shapes*, never hosts — the site rotates TLDs. Verified live against
      the built module, pinned by three new test cases (mirror `/v/`, mirror
      `?id=` bulk, mixed paste), and documented in the parser comment, the
      README and the v4 plan. No behaviour change; `npm test` 387 → **390**.
- [x] **README overhaul (2026-09-14).** Root README rewritten to the
      high-star-repo format: feature list, site support matrix (shipped /
      planned), install, usage, FAQ, roadmap pointing at
      `MULTISITE_V4_PLAN.md`.
- [x] **3.8.0 (2026-09-14) — item 47, composite (site, id) keys.** New pure
      module `src/utils/siteKeys.ts` (`toGalleryKey`, `composeGalleryKey`,
      `splitGalleryKey`, `sameGallery`); download history, bookmark queue and
      failed galleries key identity as `"<site>:<id>"` with legacy bare rows
      reading as `nhentai:<id>` (transparent migration, no version bump of
      stored shapes). Every comparison point composes through `toGalleryKey`
      on both sides: `normalizeHistory`/`recordHistory`/`partitionKnown`, the
      batch-pipeline skip guard, bookmark row identity (add/remove/select/
      patch/reconcile/plan/find), failed-gallery dedupe, and the ten direct
      `history[id]` lookups in listControls/popup. Bookmark rows and failure
      rows carry a `site` field (default `nhentai`). `npm test` 366 → **387
      passing**; all six e2e scripts PASS (the worker script's history polls
      now read composite keys); bundles rebuilt and copied to the release
      folder; both manifests 3.8.0.
- [x] **3.7.0 (2026-09-08) — bookmark queue.** New tab, persistent
      `chrome.storage.local` list, per-card ☆ with cover capture, collapsible
      dock, paste-by-id (single or batch, bookmark or download-now),
      off-by-default auto-capture, dockable-panel launcher. Six review defects
      found and fixed. `npm test` 310 → **366 passing**; e2e 101 → **117 PASS**.
      Details: `BOOKMARK_QUEUE_PLAN.md`, and the 2026-09-08 session log in both
      other documents.
- [x] **3.6.4 (2026-09-05) — item 33**, one format decision per job
      (`resolveJobFormat`), plus four review passes closing items 28–36.
- [x] **3.6.3 (2026-09-05) — item 32**, one shared batch pipeline
      (`src/utils/batchPipeline.ts`).
- [x] **3.6.2 (2026-09-05) — items 28–31, 34.**

---

## Harness notes that will cost you a round if you miss them

- **Bare `npx mocha test/x.test.js` uses a stale `build/test/`.** Only
  `npm test` runs `build:test` first. A brand-new export will look like
  "not a function" purely because `tsc` never re-ran.
- **A new `test/*.test.js` must be appended to the explicit mocha list in
  `package.json`'s `test` script.** The list is explicit; a new file silently
  runs nothing and the suite still reports success.
- **`npm run test:e2e` is six scripts, each with its own hand-rolled DOM/chrome
  stub.** Read the header of the one you are editing — the stub traps in
  `scripts/e2e-popup.js` each cost a debugging round when they were written.
- **`js/` is committed, not ignored.** After any `npm run build`, copy the
  changed bundles into `NHDW_Release_v3.0.0/` — that is the folder users load.
  `test/manifest.test.js` asserts the two manifests' versions match.
