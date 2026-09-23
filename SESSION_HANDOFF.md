# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-09-24 (session `arena/01a0cdce-nh-dw-2-0`). Chrome **3.9.0**,
Firefox **1.3.0**, PR #48 open (items 39/45/51 + review fixes, CI green).

**This file was deliberately slimmed on 2026-09-24.** It used to carry every
session's full narrative (192 KB). It now carries only what a fresh session
needs to operate: current state, the durable rules the shipped code depends on,
the verification checklists, and the Do-not list. Per-version history lives in
`IMPROVEMENT_BACKLOG.md` (session logs) and in git; the old long-form handoff
is recoverable from git history (commit `62697a2` and earlier).

## Document map

| Document | Role |
|---|---|
| **`WORKLIST.md`** | The live, ordered list of open work. Start here. |
| **`SESSION_HANDOFF.md`** (this file) | Operating rules: state, invariants, checklists, Do-nots. |
| **`IMPROVEMENT_BACKLOG.md`** | The improvement log: full specs + session logs for every numbered item, oldest first. The keeper of completed-work detail. |
| **`MULTISITE_V4_PLAN.md`** | Multi-site decision record, cooldown strategies (C still pending owner go), bucket list. |
| **`ADAPTER_WIRING_PLAN.md`** | The per-site contract matrix + adapter interface — the reference for adding site #7+. |
| **`CAPTURE_GUIDE.md`** | How to capture samples for a NEW site (method + handover). |
| **`CANDIDATE_SITES.md`** | Candidate roster for site #7+ (tiers + the owner's own picks in §4a). |
| **`DEPENDENCY_MAINTENANCE.md`** | Tooling versions, the scoped validator override, recheck procedure. |
| **`FOLDER_NAMING_STUDY.md`** | Why the filename guard exists (Chromium bug 579563) and its known limits. |
| **`NHDW_Extension_v3.0.0/ci/README.md`** | The workflows-are-manual-commit rule + the pending-workflows mirror. |

Deleted 2026-09-24 as complete/superseded (recoverable from git history; see
the backlog's archive note): `BOOKMARK_QUEUE_PLAN.md`, `NEXT_CAPTURE.md`,
`SITE_CAPTURE_AUDIT.md`.

## Current state

- **Chrome 3.9.0 / Firefox 1.3.0**, six sites shipped end to end: nhentai,
  hentaiera, imhentai, hentaienvy, hentaifox, hitomi (+ `cin.*` paste shapes).
- **PR #48** (branch `arena/01a0cdce-nh-dw-2-0` → main) carries items 39
  (empty-token filename cleanup), 45 (per-row cancel) and 51 (streaming ZIP
  writer via OPFS), plus this session's review pass that found and fixed eight
  defects in them (summary below; full table in `IMPROVEMENT_BACKLOG.md`'s
  2026-09-24 review log).
- **Suites:** Chrome **519 unit / 4 pending**, smoke 7, e2e exit 0 (**143
  PASS**). Firefox **595 unit / 4 pending**, smoke 7, e2e exit 0 (**175
  PASS**), lint **0 errors / 0 notices / 31 advisories**, package
  `nhentai_downloader-1.3.0.zip`. CI (`extension-tests`, Node 22) green on both
  jobs.
- **Captures sanitized 2026-09-24** (owner request): gallery titles, artists,
  tags and CJK text in `5 website page source`, `captures/*` text files and the
  hitomi HAR were replaced with `DUMMY_*`/`[CJK]`/`[FILTERED]` tokens and ad
  blocks stripped; website naming schemes (domains, URL shapes, media paths,
  card markup) were kept, so the captures remain usable adapter references.
  The unsanitized originals stay in git history — do not `git show` the old
  capture commits in an agent session (their content trips content filters).
- **Open (owner-only):** items **42/58** — real-browser pass for the Queue +
  real OPFS/cancel observation, Firefox desktop + Android device pass, then
  `npm run sign:firefox`. Item **40** (popup-harness listing bootstrap) is the
  remaining offline-feasible backlog item. Strategy C (reading-vs-zip
  comparison) still waits for the owner's explicit go.

## Repository and branch

- Checkout layout (three maintained folders + archives):
  - `NHDW_Extension_v3.0.0/` — Chrome source of truth (TypeScript, tests, e2e harnesses). `js/` is **committed**, not ignored.
  - `NHDW_Release_v3.0.0/` — the loadable built package users install.
  - `NHDW_Firefox_v1.0.0/` — Firefox desktop + Android build = Chrome `src/` + an audited delta (`FIREFOX_PARITY_PLAN.md` §2 is the allowlist).
  - `NHDW_Source_v3.0.0/`, `old deprecated source code/` — inactive historical archives; do not "fix" or update them.
- **Only use the current session branch** (`git branch --show-current`); never
  push another branch. Historic handoff text may name older branches — ignore.
- **After every build:** re-sync the release folder with the exhaustive
  file-by-file loop (never a fixed file list): for every file in
  `NHDW_Release_v3.0.0` except `README.md`, `cmp` against
  `NHDW_Extension_v3.0.0` and copy when different; then check the reverse
  direction for missing files. `test/manifest.test.js` asserts the two
  manifests' versions match.
- **Firefox re-sync rule:** copy the Chrome tree and re-apply the audited
  delta; `diff -rq src` must show only the allowlisted files. Firefox's
  `background.ts` is **not** the Chrome file — patch it surgically.
- `node_modules` is **not** persisted between agent sessions — `npm install`
  before build/test in each folder (else `webpack: not found`).
- **CI runs Node 22; agent sandboxes often run Node 20.** Node 21+ has a
  getter-only global `navigator` — stub it with `Object.defineProperty`, never
  plain assignment. Mocha's exit code is its failure count ("exit code 3" =
  3 failing tests). Check-run **annotations** + jobs/steps APIs are readable
  from the sandbox; raw log downloads are not.

## Latest work (2026-09-23/24) — one paragraph per pass

- **3.9.0 first pass:** the card ☆ became a real SVG bookmark icon; every
  gallery page on all six sites got a blue **Bookmark** button next to the
  site's own buttons (`src/content/titleBookmark.ts` + the declarative table in
  `src/utils/titleBookmark.ts`; sizing copies the anchor's presentational
  classes, never its behavior hooks).
- **Second pass (43/44/52/41):** panel bookmark toggles (preview `#buttonBookmark`
  + similar-row `input.similarBookmark`, rendered **outside** each row's
  `<label>`); drag-reorder (`moveBookmark`, array order = download order);
  queue+history JSON export/import (`queueTransfer.ts`; union, local wins,
  never deletes); `isCanonicalTemplate()` gate so odd separators keep the
  manual template field.
- **Third pass (item 48):** per-site jobs — a mixed queue selection splits into
  one `downloadAllDoujinshis` per site (`BatchJobOptions.site`, `plan.bySite`);
  `resolveGalleryMetadata(key, {site})` routes through the site's adapter;
  composite keys for history/failure/retry identity while titles, the `{id}`
  token and `cleanName()` use the **bare** id; a fully-skipped group sends no
  job; `retryJobKey` includes the site.
- **Items 39/45/51 (PR #48):** `cleanEmptyDelimiters()` at the end of
  `getDownloadName()` (collapses dangling ` - `/_/,/| separators and empty
  brackets left by empty tokens); per-row **Cancel** of an in-flight download
  (`cancelGallery(id, site)` across panel → worker → offscreen → pipeline →
  `Downloader.abort()`); streaming ZIP writer (`src/utils/streamingZip.ts` —
  `StreamingZipWriter`, `OpfsZipSink` with delayed unlink + orphan sweep,
  `MemoryZipSink` fallback, STORE-only production archives, JSZip-compatible
  `file()`/`generateAsync()` surface with documented-ignored generate-level
  compression options).
- **PR #48 review pass (mandatory review-before-building):** eight defects
  found by reviewing the PR's own output, each pinned by a red-first test —
  (1) item 45's UI never reached Firefox (handlers with zero senders); (2)
  cancel marks were never consumed (retries failed instantly forever); (3)
  bare-id cancel identity poisoned across sites; (4) a late cancel demoted
  `done` rows; (5) OPFS temp files were unlinked instantly after the
  un-awaited anchor save + orphans leaked; (6) stray `return true` after a
  synchronous reply; (7) READMEs contradicted their own PR; (8) the silently
  ignored DEFLATE request is now documented instead of pretended. Full table
  with evidence: `IMPROVEMENT_BACKLOG.md`, session log 2026-09-24.

## Structural invariants (what the shipped code depends on — do not re-derive)

**Formats & naming**
- Four formats (`zip|cbz|pdf|raw`); legacy `"folder"` maps to `pdf` everywhere;
  `src/utils/downloadFormats.ts` is the single definition (registry, output
  mode, PDF-merge condition). `resolveJobFormat(override, stored)` is the ONE
  place a job's format is decided; `resolveListFormat()` the one place the
  list format is resolved. `listFormat` must never have a concrete
  `chrome.storage.get` default (unset = inherit the single-title format) but
  every reader must request the key explicitly (object-form gets only return
  keys named in defaults).
- `effectiveSeparate = downloadSeparately || format === "raw"`; raw can never
  merge. `archiveLayout`: `flat` (single-title: pages at the archive root,
  `<clean title>.zip`) vs `nested` (shared batch archive: one folder per
  gallery). Entry names are built by `Downloader.#archiveEntryName`
  (`path + "/" + file` when nested) — the writer's `folder()` is decorative.
- Master folders: `rawMasterFolder` (default `NHDW`) and `archiveMasterFolder`,
  both driven by the one `listMasterFolder` UI switch in list mode; `""` = no
  wrap; `replaceSpaces` never rewrites a user-typed folder name.
- `sanitizeArtifactFilename` runs inside `#saveArtifact` for every artifact;
  history records store the SANITIZED name (`artifactRecordFilename`) so
  verify-before-skip can match disk.
- Name templates: checkbox UI builds canonical `"{a} - {b}"` order;
  `isCanonicalTemplate()` gates the checkboxes (odd separators/custom orders
  keep the manual field); `getDownloadName()` ends with
  `cleanEmptyDelimiters()` (item 39); `cleanName()` after. List template
  `listDownloadName` defaults to the `@inherit` sentinel.
- Merged artifact naming: `_DDMMYYYY` (`batchNameDate`, `applyBatchDate` never
  double-stamps), collisions grow `_part2…_part10` then Chrome `uniquify`;
  warn-first on an existing merged file (`{result:"existing"}` ↔
  `existingConfirmed`), multi-page merges keep the part number before the
  ` (lastPage)` marker.

**Download pipeline & lifecycle**
- MV3 split: the worker relays jobs to the **offscreen document**, which owns
  fetch/ZIP/PDF and uses **only `chrome.runtime`** — never storage/downloads/
  scripting/permissions there. The worker owns storage, `chrome.downloads`,
  scripting and permissions. The worker-fallback path (no `chrome.offscreen`,
  i.e. Firefox) wraps the SAME core.
- `src/utils/batchPipeline.ts` is the one shared batch core (`runBatchDownload`,
  `runPagedBatchDownload`, `resolveGalleryMetadata`, `buildRetryJob`); hosts
  inject all IO. Do not fork it.
- `chrome.downloads.download()`'s callback means "item created", **never**
  "file saved". Completion is awaited through `downloadControl.ts`
  (`startTrackedDownload` / `awaitDownloadCompletion`; offscreen relay in
  `AWAIT_DOWNLOAD_SLICE_MS` = 45 s slices — one message channel must never stay
  open near the MV3 5-minute limit; 4-minute cap then cancel).
- Raw mode: pages go through the download manager with `rawMaxConcurrent`
  (1–10, default 3), an interrupted page is retried, a gallery with a missing
  page is FAILED (never recorded).
- Blob artifacts save via the offscreen anchor (`saveArtifactSmart`) — NOT
  awaited; that is why the streaming writer's OPFS unlink is delayed (60 s) and
  why `revokeObjectUrlDelayMs` exists. The worker fallback uses JSZip +
  object-URL (document context) / base64 (service worker).
- Streaming ZIP (item 51): offscreen ZIP/CBZ assembly is
  `StreamingZipWriter` — OPFS when available (`navigator.storage.getDirectory()`),
  `MemoryZipSink` otherwise; peak RAM O(one page); production archives are
  STORE (image payloads are pre-compressed; the Downloader's generateAsync
  DEFLATE request is documented-ignored). `cleanup()` is called by the
  Downloader on success AND in its catch.
- Session-only pause/resume — no durable restart resume; do not claim it.
- The source gallery tab must stay open (may be backgrounded) until its job
  completes; tab-context fetches prefer its Cloudflare-cleared session.
  Tab-first fetching stays; this is not a Cloudflare bypass and must never be
  described as one.

**Identity, history, failures**
- `src/utils/siteKeys.ts` is the one identity contract: composite
  `"<site>:<id>"` keys, default site `nhentai`, `toGalleryKey()` passes
  composites through (safe on both sides of every comparison). Legacy bare rows
  migrate transparently on next write. Never compare a bare id against a store
  directly; never key a file name off a composite key.
- Download history (`chrome.storage.local`): recorded ONLY on full success
  (separate mode per gallery; merged only when the whole job is clean);
  verify-before-skip (`verifyDownloadedFiles`, default ON, worker-side
  `downloadVerify.ts`, never imported by offscreen): a record only skips while
  `chrome.downloads.search` confirms the file exists; merged mode NEVER skips
  (warn-first instead). Skipped ids cost zero API calls; `partitionKnown`
  returns the original candidate strings.
- Failures: every failure names gallery + reason (`failedGalleries.ts`,
  session-persistent); **Retry failed** re-sends exactly those titles with the
  job's own settings, as separate files, past the history guard; `retryJobKey`
  includes the site. Batch metadata that resolves to non-gallery JSON fails ONE
  gallery (`requireGallery`), never the whole batch. User-facing errors are
  message-first everywhere (`errorMessage()`; never `String(plainObject)` —
  the `[object Object]` class of bugs).
- Per-row cancel (item 45 + review): cancel identity is the composite key on
  both sides; pipeline cancel marks are CONSUMED (batch loop on skip; handlers
  on direct enforcement; offscreen also when idle); `markBookmarksFailed` never
  demotes a `done` row. Worker-fallback limitation (accepted): a QUEUED
  single-title job cannot be cancelled there (no queue visibility).

**Bookmark queue (3.7.0+)**
- Two lists that must stay separate: the bookmark queue = **intent**
  (`chrome.storage.local["bookmarkQueue"]`, `{v:1, items, collapsed}`, survives
  restart) vs the offscreen job queue = **work in flight** (memory-only).
  Bookmark rows FEED `downloadAllDoujinshis`; they never replace the pipeline.
- The worker is the single writer; every mutation is a `bookmark*` message.
  `reconcileBookmarksAfterRestart` runs once per worker lifetime
  (`downloading`→`saved`; `done` re-checked against history; `failed` keeps its
  reason; order/selection/thumbnails/dock untouched).
- The Queue tab always downloads `separate: true`; format/master folder/
  template come from the list-mode settings (one source, no disagreement).
- Rows carry `site`; row identity is the composite key; the drag handle
  (`span.nhdwBmDrag`) is the only draggable element; array order = download
  order; a downloading row shows Cancel instead of Download.
- Paste box: bare ids, `site:id`, all six sites' URL shapes, every `cin.*`
  mirror (shapes not hosts), `?id=` bulk, `a-b` ranges; caps 200/range,
  500/paste, 2000 rows; unreadable tokens return in `rejected`.
- Import/export (`queueTransfer.ts`): union merge, local wins, imported rows
  appended, **nothing ever deleted**; queue via `bookmarkImport`, history via
  `historyImport` → `writeHistory()` (serialized write chain).
- `getActiveNhentaiTabId()` is mandatory for any tab lookup outside the
  preview flow (the Queue tab can be open on any website); enrichment reports
  `{resolved, skipped}` honestly.

**Multi-site (3.8.0/3.9.0)**
- One job carries ONE site; per-site adapters (`src/sources/*`) own metadata
  extraction, image URL generation, host/path allowlists (`cdnConfig` is
  per-adapter) and paste-box shapes; the core pipeline has no site-specific
  logic. hitomi: dynamic `gg.js` subdomain math (`hitomiResolver.ts`) — never
  hardcode its CDN subdomains; default format `raw` (1 GB-class galleries).
- Image fetches for Cloudflare-fronted sites go through the open tab
  (`tabImageFetch` pattern) so the browser sends its own Referer/cookies.
- Unpadded numbers in CDN fetch URLs, 3-digit zero-padded names on disk.

**UI surfaces**
- One document (`index.html`) renders popup AND side panel; `uiMode` default
  `sidepanel` (Chrome 116+, feature-detected; `action.setPopup("")` must be
  cleared for the panel behavior to apply). Tabs: Download | Queue | Settings.
  `preview.ts` re-bootstraps on tab activation/navigation; `.nhdwPanel` drops
  the fixed width. There is no "am I the side panel" API — the docked-launcher
  visibility keys off the `nhdwPanel` class (setting-driven proxy).
- Settings panes NEVER write on render — only explicit `change` handlers
  write; first paint uses `renderNamePreview(false)` / `renderTemplatePreview`.
- In-page controls: `listControls.ts` (per-card Download/Select/Bookmark +
  floating bar; idempotent `data-nhdw-controls` marker + debounced
  MutationObserver; selection shared via `chrome.storage.local.allIds`);
  `titleBookmark.ts` (gallery-page Bookmark button, all six sites, declarative
  anchor/selector table, no-ops when nothing matches, never on listing/reader
  pages).
- Firefox-only embedded UI (items 56/57): `siteUi.ts` header invoker + drawer
  on nhentai (anchored ONLY on `.navbar`), reusing `renderSettings` +
  `renderBookmarks`; `shipsSiteUi()` is the inert path in the Chrome tree — do
  not activate it there without a deliberate Chrome release. Desktop/mobile
  separation: mobile behavior only behind
  `(max-width:640px) and (pointer:coarse)`; never restructure shared DOM for
  mobile; Firefox queue-row CSS lives in `css/panelRenderers.css` under
  `:where(#queuePane, #nhdwSiteUiQueue)` (Chrome's `style.css` is unscoped).
- API key: optional, user-pasted, verified via third-party-safe
  `GET /api/v2/user`; `chrome.storage.local` only (never sync, never rendered
  back, never on CDN URLs); first-run gate with two explicit exits
  (`apiKeyGate`); an invalid key can never break a download (keyed routes fall
  through); one-shot server archives (`POST /api/v2/galleries/<id>/download`)
  are opt-in, keyed, ZIP/CBZ-only, single-gallery-only, fallback-on-any-failure.

**Filename guard (3.3.1/3.4.1 — see `FOLDER_NAMING_STUDY.md`)**
- Chromium bug 579563: any other extension's `onDeterminingFilename` listener
  makes Chrome ignore our `filename`. The guard is reference-counted: attached
  only while our own filenames are pending, detached on EVERY drain path
  (consumed, complete, interrupted/cancelled, failed creation, 30-min TTL,
  600-entry FIFO); idle worker = not in the naming chain. Foreign items get a
  bare `suggest()`; `suggest()` exactly once per event; never
  `suggest({filename:""})`. Session mirror `{v:2, pending, idToUrl, order}` in
  `chrome.storage.session`; re-attach after worker restart only with
  outstanding work. Firefox: no-op (event does not exist).

## Required real-browser verification (items 42/58 — owner-only)

Nothing here has EVER run in an agent sandbox; every real-browser claim in
this repo is an expectation until observed. Reload unpacked
`NHDW_Release_v3.0.0` (Chrome 116+) / temporary-load the Firefox package.

**Naming guard (do FIRST — needs a second downloader extension installed):**
- 0A. With NHDW idle, another extension's download must not produce the
  "failed to name… another extension determined…" blame naming NHDW.
- 0B/0C. Worker console: `chrome.downloads.onDeterminingFilename.hasListeners()`
  is `false` idle, `true` mid-job (raw AND blob paths), `false` after
  completion/cancel-from-shelf.
- 0D. With the competitor installed: raw pages still land in
  `NHDW/<Title>/001.jpg`, ZIP keeps `<Title>.zip` (not blob-UUID). Known
  limit: a manager installed AFTER NHDW that actively suggests names still
  wins (Chrome's last-installed rule) — document, do not chase.
- 0E. Kill the worker mid-download: remaining files keep proper names
  (session-mirror re-attach). Accepted gap: one mis-named file possible inside
  the few-ms restart race (open question 1).

**List mode / formats:** separate files named from each gallery's own metadata
(ZIP/CBZ/PDF); merged = one archive; PDF-merge modal (default **Switch to
separate files**, "don't warn again" scoped to pdf+batch+multi only, count
warning fires FIRST on multi-page); folder wrap on/off for archives AND raw;
list template overrides single-title only; raw list mode = one folder per
title, merge disabled; side panel opens/resizes/follows tabs, Settings →
Popup switches back, Chrome <114 falls back silently; in-page card controls
survive infinite scroll and two-way selection sync with the panel, toggle-off
restores the legacy checkbox.

**Single/batch basics:** single ZIP/CBZ = title-named, pages at root; PDF
every page correct order/orientation; raw `NHDW/<Title>/001.jpg…`; two-column
popup (similar galleries fetch on click only; untitled related = `(Non-titled)
#id`); queue jobs serial with pause/resume across popup close; API key
valid/invalid/remove (never echoed); backgrounded source tab still completes;
CDN config fetched once per session + grant notice flow.

**Queue era (item 42):** bookmark three cards → restart machine → list/ticks/
dock identical; thumbnails paint from `t.nhentai.net` (no host permission
involved — confirm not CSP-blocked); "Open docked ↗" opens the side panel from
the popup and hides when the document IS the panel; paste `366224,177013` →
Download now → both land named by the list template; Add-to-queue with no
nhentai tab shows the "Open an nhentai.net tab" notice; auto-capture on a real
infinite-scroll page (including mid-page enable); bookmark icon survives
nhentai re-renders without duplicating; the gallery-page Bookmark button is
never injected twice.

**PR #48 additions (new):** per-row Cancel actually stops one gallery mid-batch
(others continue; the row shows Cancelled; **Retry then works**); a late cancel
after completion leaves the row `done`; OPFS streaming path on a large gallery
(real `navigator.storage` — confirm the temp file disappears ~60 s after the
save and the download is intact); `cleanEmptyDelimiters` on a real
`{language}`-missing template; Firefox: desktop pass (queue, history, bookmark
icon, in-page controls, header invoker + drawer, multi-site download, cancel)
AND Android matrix (grant prompt, drawer at 360px, keep-alive over 60s+ ZIPs,
content controls, toolbar opens drawer) → then `npm run sign:firefox`.

## Open questions (judgement calls a reviewer should look at)

1. **Naming-guard restart race** (accepted trade-off): an event inside the
   async session-read window after a worker restart gets Chrome's default
   name for that one file. How wide is the window in practice? (Step 0E.)
2. **TTL guess:** `ENTRY_TTL_MS` = 30 min — nobody has measured the slowest
   realistic gallery. Needs a data point, not a debate.
3. **`hasListeners()` is the only observation method** for naming-chain
   membership; it proves our state, not Chrome's.
4. **Manual saves of an in-flight image URL** get our recorded name (judged
   harmless; never observed).
5. **URL-keyed name map assumes URLs are unique per artifact** (true today;
   no guard if a future change reuses a URL across concurrent jobs).
6. **Raw format ships behind a "(testing)" label** until folder creation is
   confirmed on every platform (step 0f equivalent).
7. **Paginated Download All** (walks every page + 2-page count warning) is
   e2e-stub-asserted only.
8. **Panel settings are write-only:** readers re-read at inject/open time; the
   "reload the page" hints are never asserted anywhere.
9. **The popup/panel harnesses drive hand-rolled DOM stubs** — layout, focus,
   `hidden` CSS and real listener ordering stay on the real-browser list.
10. **`downloadVerify.ts` never observed against a real `chrome.downloads`**
    (Windows backslash `filenameRegex` matching; `item.exists === false` for a
    deleted file — if `exists` were absent instead, recorded galleries would
    re-download forever: safe but silently slower).
11. **`resolveListFormat` behaviour change to confirm with the owner:** a user
    who set single-title CBZ/PDF/raw and never touched list mode now gets that
    format from listing pages too (documented intent, visible change; do not
    "fix" by persisting on render).
12. **`@types/chrome` pinned at 0.0.154 (2021)** — `chrome.sidePanel` /
    `storage.session` go through `(chrome as any)`; a bump restores type
    safety but risks churn.
13. **`npm run test:browser` has never run in this environment** (GitHub-hosted
    runners cannot launch the MV3 harness — CI is offline-suites-only by
    decision; the suite stays local).
14. **OPFS runtime behavior is mocked-only** (real `navigator.storage`, blob
    reads after `removeEntry`, quota limits) — joins the 42/58 list above.
15. **Worker-fallback cancel cannot reach a QUEUED single-title job** (no
    queue visibility outside offscreen) — recorded, not fixed.

## CI and workflow files (manual-commit only)

Never edit `.github/workflows/**` from an agent session — the push is rejected
for the WHOLE branch (`without workflows permission`). Write the intended file
into `NHDW_Extension_v3.0.0/ci/pending-workflows/`, describe it in
`ci/README.md`, and list it here. **Currently pending: nothing** (the
trigger-paths broadening was applied by the owner on 2026-09-04, commit
`840d79e`; the live workflow and the pending-workflows mirror are
byte-identical — keep them in sync on any future change).

## Do not

**Session discipline**
- Do not switch branches or push to a branch other than the current session branch.
- Do not edit `.github/workflows/**` from an agent session (whole-push rejection); use `ci/pending-workflows/`.
- Do not `git show`/`git cat-file` the pre-sanitization capture commits in an agent session — the original titles trip content filters (working tree is sanitized; history is not).
- Do not add a `test/*.test.js` file without appending it to the explicit mocha list in `package.json`'s `test` script (a new file silently runs nothing and the suite still reports success).
- Do not run bare `npx mocha test/x.test.js` for verification — it uses a stale `build/test/`; only `npm test` runs `build:test` first.
- Do not let a settings pane write on render (`popupSettings.ts`, `options.ts`): only explicit `change` handlers write.
- Do not run `npm audit fix --force`, suppress deprecation warnings, or fork Mozilla's validator to silence the two remaining upstream warnings (`DEPENDENCY_MAINTENANCE.md`).

**Pipeline & downloads**
- Do not treat `chrome.downloads.download()`'s callback as "file saved" — use `startTrackedDownload`/`awaitDownloadCompletion` or the offscreen relay; never hold one `awaitDownload` message open longer than `AWAIT_DOWNLOAD_SLICE_MS`.
- Do not fork the download logic for any mode; everything calls the same `batchPipeline` core and `downloadFormats.ts` registry.
- Do not put `chrome.storage`, `chrome.downloads`, `chrome.scripting` or `chrome.permissions` in the offscreen document.
- Do not delete user files from a defective raw folder automatically, and do not record a gallery in the history unless every page completed.
- Do not remove or weaken the PDF-merge confirmation, and do not widen its "don't warn me again" flag beyond `pdf + batch + more than one title`.
- Do not reintroduce the "folder" output mode (legacy values keep mapping to `pdf`).
- Do not make the master-folder wrap mandatory again, and do not let list mode fall back to the page URL for a file name in separate mode.
- Do not remove tab-first fetching or claim Cloudflare bypass.
- Do not use `/api/v2/auth/*` or `/api/v2/user/keys`.
- Do not add `<all_urls>` (or any non-allowlisted host) to host/optional-host permissions; nhentai image hosts must validate as HTTPS `*.nhentai.net` origins; per-site adapters own their own allowlists.
- Do not expand web-accessible resources.
- Do not drop `action.default_popup` from the manifest (documented fallback for builds without `chrome.sidePanel`).

**Filename guard**
- Do not register `chrome.downloads.onDeterminingFilename` at worker startup or leave it registered while idle; attach only while own filenames are pending, detach on every drain path; never `suggest({filename:""})`; never `suggest` more than once per event.

**Identity & multi-site**
- Do not compare a bare id against history/bookmark/failure stores directly — wrap both sides in `toGalleryKey()`.
- Do not merge per-site jobs back into one mixed batch; one `downloadAllDoujinshis` carries one site.
- Do not key a file name, title or the `{id}` token off the composite `site:id` key (names use `splitGalleryKey(storeKey).id`).
- Do not drop `site` from `retryJobKey` (`undefined`/empty normalizes to `null`).
- Do not put site-specific logic in the core pipeline — it belongs in the adapter.
- Do not hardcode hitomi CDN subdomains (they rotate; fetch `gg.js` at runtime and cache with a TTL).
- Do not try to bypass server-side cooldowns (Strategy A avoids them; Strategy B waits politely; never hammer).
- Do not delete the nhentai adapter before a second site downloads end-to-end (it is the regression control); do not run the lab clone as a second installed extension long-term.

**Cancel & streaming ZIP (PR #48 review)**
- Do not re-add bare-id cancel marks or bare-id matching to `cancelGallery` — composite `toGalleryKey` identity on BOTH sides everywhere.
- Do not let a cancel mark survive its job (consume-on-skip in the loop; consume-on-enforce in handlers). Do not add an "idle" consume to the WORKER fallback (between batch galleries `isDownloadFinished()` is momentarily true — a real mid-batch cancel would be swallowed; only the offscreen document has whole-job visibility via `jobRunning` + `queuedJobs`).
- Do not demote a `done` bookmark row (`markBookmarksFailed` skips settled rows).
- Do not unlink an OPFS temp archive instantly and do not remove the orphan sweep (the anchor save is not awaited; `cleanup()` unlinks after the 60 s grace; `create()` sweeps only `nhdw_archive_*.tmp` OLDER than the grace, before creating its own file).
- Do not make `StreamingZipWriter.generateAsync` honour caller compression options (streaming decides per entry at append time; production archives are STORE by design). Do not "fix" larger PNG payloads by re-buffering pages in memory.

**Bookmark queue**
- Do not merge the bookmark queue into the offscreen job queue, and do not make it write to `chrome.storage.sync` (100 KB/512-item cap would silently truncate).
- Do not reconcile the bookmark list on every read (once per worker lifetime on purpose), and do not reset a row's status when it is re-bookmarked (`duplicates` reports it; the row stays).
- Do not clear `bookmarkOverlay` in `readBookmarkState()` — only the `bookmarkQueue` storage-change event clears it.
- Do not put auto-capture back inside `injectCardControls()` (idempotent injection would make a mid-page enable collect nothing).
- Do not call `getActiveTabId()` from outside the preview flow — use `getActiveNhentaiTabId()`; a permission error is not a guard.
- Do not route a bookmark thumbnail into the download path (`t.nhentai.net` is display-only, deliberately absent from host permissions).
- Do not add a destructive import (union, local wins, append-only — a wrong file cannot wipe a queue).
- Do not let the Queue tab write the queue or the history itself (worker single writer; `bookmarkImport` / `historyImport` → `writeHistory()`).
- Do not move a similar row's bookmark button inside its `<label>` (a click would also tick the download checkbox), and do not give the drag-reorder row itself `draggable` (only `span.nhdwBmDrag`).
- Do not make the Queue tab download in merged mode (always `separate: true`).
- Do not send a queue group whose rows are all skipped (`download: []` produces no job).
- Do not re-add `bookmarkSetStatus` (removed as a handler with no sender).
- Do not re-add a second copy of an item-44/45 CSS block: exactly one definition per selector per tree, and the two trees compute the same declarations.
- Do not change `bookmarkPanel.ts` in one tree only — the file is byte-identical across Chrome and Firefox; Firefox's queue-row CSS lives in `panelRenderers.css` under `:where(#queuePane, #nhdwSiteUiQueue)`.

**Firefox tree**
- Do not modify `NHDW_Extension_v3.0.0/` (the Chrome source of truth) from a Firefox-only task, and do not backport Firefox deltas into Chrome without a deliberate Chrome release.
- Do not sync the Firefox version sequence to Chrome's numbers (independent AMO line).
- Do not duplicate settings/queue renderers in `siteUi.ts`; do not anchor the invoker outside `.navbar` or inside `.navbar-right`/`.navbar-collapse` (hidden at phone width); do not destroy the drawer DOM on disable; do not hide the popup Download tab.
- Do not restructure shared DOM for mobile; mobile behavior only behind `(max-width:640px) and (pointer:coarse)`; do not reintroduce `.nhdwActionBar`-style wrappers.
- Do not re-add real-browser jobs to GitHub Actions (hosted runners cannot launch the MV3 harness — 100% failure record).

## History pointers (one line per milestone → `IMPROVEMENT_BACKLOG.md` session logs + git)

- **3.2.0** settings-in-popup tabs · **3.3.0** raw master folder · **3.3.1**
  filename guard (`FOLDER_NAMING_STUDY.md`) · **3.4.0** list-mode parity +
  side panel + in-page card controls · **3.4.1** guard listener lifetime ·
  **3.5.0** download history + verify-before-skip + merged naming ·
  **3.6.0–3.6.4** named failures/retry, raw completion tracking,
  `[object Object]` sweeps, shared batch pipeline, one format decision per job,
  review items 28–36 · **3.7.0** bookmark queue (six-defect self-review) ·
  **3.8.0** composite `(site,id)` keys + `cin.*` mirrors pinned · **3.9.0**
  multi-site adapters (6 sites), bookmark icon + gallery-page button,
  43/44/52/41, item 48 per-site jobs, 39/45/51 (PR #48) + its review pass.
- **Firefox:** 1.0.0 Android snapshot → 1.1.0 parity elevation (rebase onto
  Chrome src + audited delta) → 1.2.0 website-embedded UI (items 56/57, PR #44
  review) → 1.3.0 Chrome-3.9.0 backport. Items 38 (options harness) and 59
  (list-format readers) were Firefox-scoped fixes. `PORTING_AUDIT.md` +
  `FIREFOX_PARITY_PLAN.md` in the Firefox folder are the port's own records.
- **Dependency maintenance (2026-09-21):** Mocha 12.0.2 both trees, web-ext
  10.6.0 + scoped addons-linter 10.13.0 override (Firefox), audits 16→0 /
  5→0, two honest upstream warnings remain.
- **Captures:** all six initial sites captured + audited 2026-09-15…23 (the
  audit's findings live on in `ADAPTER_WIRING_PLAN.md` §1); capture files
  sanitized 2026-09-24.
