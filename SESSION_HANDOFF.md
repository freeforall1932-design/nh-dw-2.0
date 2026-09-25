# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-09-26 (session `arena/01a0d976-nh-dw-2-0`). Chrome **3.10.3**,
Firefox **1.4.3**. This session ran the mandatory review pass on the merged
3.10.0 work (PR #50) and found **three defects**, each fixed under a test that
failed on the pre-fix build: **F1** the tested listing-only guard
(`resolveListCardPage()`) had no production caller, so gallery pages whose
related-gallery cards match the listing selectors were decorated and the
floating bar appeared over title pages; **F2** `listControls.readSelection()`
read `allIdsSite` without requesting it, leaving the cross-site selection guard
dead (item 59's class); **F3** the legacy nhentai caption checkbox ran on the
five added hosts. It then landed **item 65**: the panel's third tab is labelled
**Bookmark** (and every tooltip/hint that called it a "Queue" follows) with the
storage key, element ids, message actions and export format deliberately
unchanged — locked by a new `test/tab-labels.test.js` in both trees. It then
landed **item 71**: the panel list points at what replaced the retired
"Download all (N pages)" button (`#selectionPointer` — rows and cards are one
selection; other pages via the range block), the List-mode hint stops naming
the retired button, and the skip guard's identity defect behind backlog §E is
fixed (a recorded **bare** id is the default site's record, never the job's, so
a legacy nhentai record can no longer mask a same-numbered gallery on another
site). Full detail: the 2026-09-26 logs in `IMPROVEMENT_BACKLOG.md`. Read the
**"Next session"** section before starting new work.

**The 3.10.0 work is on main.** The previous session's branch landed as
**PR #50** (merge commit; CI green on both jobs: *Offline suites (fixtures +
window-less VM bundles)* and *Firefox snapshot (offline suites)*). This session
starts from that merge and carries the review fixes (**3.10.1 / 1.4.1**),
item 65 (**3.10.2 / 1.4.2**) and item 71 (**3.10.3 / 1.4.3**) — patch bumps on
purpose: the loadable bytes changed after 3.10.0 merged. The docs under
"Document map" describe the merged 3.10.0 state plus this branch's fixes, the
rename and the item-71 work.

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
| **`CANDIDATE_SITES.md`** | Candidate analysis + onboarding checklist for site #7+; the canonical URL roster is `new domain candidate` on main (2026-09-24 swap: webtoon/manhwa picks moved to the desktop archiver). |
| **`DEPENDENCY_MAINTENANCE.md`** | Tooling versions, the scoped validator override, recheck procedure. |
| **`FOLDER_NAMING_STUDY.md`** | Why the filename guard exists (Chromium bug 579563) and its known limits. |
| **`NHDW_Extension_v3.0.0/ci/README.md`** | The workflows-are-manual-commit rule + the pending-workflows mirror. |

Deleted 2026-09-24 as complete/superseded (recoverable from git history; see
the backlog's archive note): `BOOKMARK_QUEUE_PLAN.md`, `NEXT_CAPTURE.md`,
`SITE_CAPTURE_AUDIT.md`.

## Current state

- **Chrome 3.10.3 / Firefox 1.4.3** (3.10.0/1.4.0 = PR #50; 3.10.1/1.4.1 = this
  branch's 2026-09-26 review fixes; 3.10.2/1.4.2 = item 65, the Bookmark-tab
  rename; 3.10.3/1.4.3 = item 71, the shared-selection pointer + the skip-guard
  identity fix), six sites shipped end to end: nhentai,
  hentaiera, imhentai, hentaienvy, hentaifox, hitomi (+ `cin.*` paste shapes).
  Card controls (Select + Bookmark + Download) and the floating bar now run on
  all six listing shapes; every gallery page and the panel preview carry a
  **Save offline** control; the bar offers **Select all**.
- **PR #48** (branch `arena/01a0cdce-nh-dw-2-0` → main) carries items 39
  (empty-token filename cleanup), 45 (per-row cancel) and 51 (streaming ZIP
  writer via OPFS), plus this session's review pass that found and fixed eight
  defects in them (summary below; full table in `IMPROVEMENT_BACKLOG.md`'s
  2026-09-24 review log).
- **Suites (after item 71; the review-fix run was 587/620, the item-65 run
  591/624):** Chrome **596 unit / 4 pending**, smoke 7, e2e exit 0 (**263
  checks** for `e2e-title-bookmark`, all other e2e green). Firefox **629 unit /
  4 pending**, smoke 7, e2e exit 0,
  lint **0 errors / 0 notices / 32 warnings** (26 pre-existing
  `UNSAFE_VAR_ASSIGNMENT`, 3 `UNSUPPORTED_API` sidePanel/offscreen, 1
  `DANGEROUS_EVAL`, plus 1 new `UNSAFE_VAR_ASSIGNMENT` from the legacy
  checkbox `innerHTML` — same class as the panel's), package
  `nhentai_downloader-1.4.1.zip`. CI green on both jobs; **PR #50 merged to
  main**. Re-run 2026-09-26 after the review fixes: same unit counts, smoke and
  e2e exit 0, FF lint unchanged (32 warnings).
- **Item 71 landed (2026-09-26, this branch):** verify-and-close first — the
  blanket "Download all (N pages)" entry was already gone (item 61's range
  block is the only multi-page path; `#buttonAll` = "Download range now"), so
  the work was to make the panel *say* it: `#selectionPointer` in the list
  ("ticking rows here and ticking cards on the page are the same selection …")
  and a List-mode hint that names the range block. Verifying §E found a **live
  identity defect**: the pipeline's skip guard built its `alreadySet` with
  `toGalleryKey(id, jobSite)`, so a recorded **bare** id (legacy pre-3.8.0
  history — bare ids mean nhentai, as the code's own comment said) was read as
  the *job's* site and masked a same-numbered gallery on another site: a card
  click on the five added hosts could report "already downloaded" and never
  download. Fixed to `toGalleryKey(id)` for that list only (the
  `redownloadIds`/force list legitimately IS site-relative and keeps composing
  with the job site). Chrome 3.10.3 / FF 1.4.3.
- **Item 65 landed (2026-09-26, this branch):** the panel's third tab is
  labelled **Bookmark**. Copy that followed: the card tooltip
  (`listControls.ts`), the auto-capture hint + the side-panel launcher + the
  no-side-panel fallback notice (`popupSettings.ts`), and the two bookmark
  tooltips (`bookmarkQueue.ts`, `titleBookmark.ts`). Deliberately unchanged:
  the `bookmarkQueue` key, `#tabQueue` / `#queuePane` ids, `nhdwBm*` classes,
  `bookmarkGet` / `bookmarkImport` actions, the export format. New
  `test/tab-labels.test.js` in both trees locks both halves and was **red**
  before the change (tab read "Queue"; four copy strings said "Queue").
  Chrome 3.10.2 / FF 1.4.2.
- **Review pass (2026-09-26, this branch):** three defects in the merged 3.10.0
  work, fixed red-first in both trees — `findCards()` now resolves the page
  through `resolveListCardPage()` (gallery/reader pages decorate nothing and
  the bar stays hidden there); `listControls.readSelection()` requests
  `allIdsSite` explicitly, so a foreign site's selection is never read;
  `content.ts` gates the legacy nhentai caption checkbox to `pageSite ===
  "nhentai"`. New e2e coverage: `e2e-list-controls` gallery-page +
  foreign-site phases, `e2e-content` hentaifox phase. Details:
  `IMPROVEMENT_BACKLOG.md` session log 2026-09-26.
- **Shipped on this branch (2026-09-25):** items **62/63/64**, implemented in
  **both** trees behind the previous session's red tests (all 8 per-tree unit
  reds + the 3 `e2e-list-controls` flips are green). `src/utils/listCards.ts`
  is now the real per-site table (no stub left). Plus the item-59 port below.
- **Review finding closed (2026-09-25):** item 59 ("saved list format wins,
  unset inherits") had landed **Firefox-only** on 2026-09-21. Three Chrome
  readers — `utils/listSettings.ts` `readListSettings()`, `options/options.ts`
  and `preview/popupSettings.ts` — plus Chrome's `content/listControls.ts`
  never asked storage for the optional `listFormat` key, so a saved list format
  was ignored everywhere in Chrome (the panel advertised ZIP while list
  downloads used CBZ, etc.). Chrome's `test/list-mode.test.js` used a
  **whole-store merge stub** (`Object.assign({}, defaults, store)`) that
  returns unrequested keys, which is precisely why the defect stayed hidden.
  Fixed in all four readers; the key-scoped `scripts/test-support/storage.js`
  helper, the 36-case `list-format-cases.js` matrix and the item-59 e2e phase
  are now in both trees.
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

## Latest work (2026-09-23/26) — one paragraph per pass

- **Item 71 — panel list actions vs on-page Select (2026-09-26, this branch):**
  red-first: `test/panel-list-actions.test.js` (2 red — no pointer element, and
  the List-mode hint still promised "Download all") plus two `e2e-popup` phase
  10 assertions (`FAIL: the list must point at the shared on-page selection`
  against the pre-fix bundle). Then the §E verification: the guard composed
  recorded bare ids with the job site; two new `batch-pipeline` cases were red
  on the pre-fix build (`a bare default-site record must not skip a hitomi
  gallery`, `a bare (nhentai) record must not skip a hitomi gallery`) and green
  after the one-line fix. Chrome 596 / FF 629 unit, smoke + e2e green both
  trees (263 checks), FF lint unchanged (32 warnings), release re-synced,
  Chrome 3.10.3 / FF 1.4.3.
- **Item 65 — Queue tab → Bookmark tab (2026-09-26, this branch):** a UI-only
  rename, done red-first. `test/tab-labels.test.js` asserts `#tabQueue` reads
  "Bookmark", that no user-facing string still says "Queue tab"/"Queue panel",
  that the replacements are actually present, and that the internals a future
  cleanup might be tempted to rename (the `bookmarkQueue` storage key, the
  `#tabQueue` / `#queuePane` ids) stay put. Red before the change (3 failing),
  green after; Chrome 591 / FF 624 unit, smoke + e2e green both trees,
  FF lint unchanged. Chrome 3.10.2 / FF 1.4.2, release folder re-synced.
- **PR #50 review pass (2026-09-26, this branch):** three defects, fixed
  red-first in both trees. (F1) `utils/listCards.ts`'s `resolveListCardPage()` —
  the listing-only guard `test/list-cards.test.js` pins — had **no production
  caller**: `findCards()` went straight to `getSourceForUrl()` +
  `listCardTargetForSite()`, so a gallery page's related-gallery cards
  (hentaiera capture: 10 × `div.thumb > a.inner_thumb.img_box`; hitomi:
  `#related-content.gallery-content` with `h1.lillie > a`) were decorated and
  the floating bar (Select all) showed over title pages. `findCards()` now
  resolves through the guard. (F2) `listControls.readSelection()` read
  `elems.allIdsSite` from a `get({allIds: []})` — which never returns it — so
  `storedSite` fell back to the current page and the cross-site guard was dead
  (item 59's class); the read now requests the key. (F3) `content.ts`'s legacy
  nhentai caption checkbox — injected on the five added hosts by item 63's
  manifest block — is gated to `pageSite === "nhentai"`. Chrome 587 / FF 620
  unit, both e2e suites green, FF lint unchanged (32 warnings), release folder
  re-synced, versions bumped to Chrome **3.10.1** / Firefox **1.4.1**.

- **Merge + doc refresh (2026-09-25, end of session):** PR #50 → main as
  a merge commit (CI green on both jobs). Every doc that carries next-session
  state was refreshed in the same commit: this file (MERGED banner, corrected
  suite counts, next-session ordering), `WORKLIST.md` (merge banner, stale
  "merge PR #48" owner bullet removed, 71 → 65 → 40 queue), the backlog
  session log + item table, `ADAPTER_WIRING_PLAN.md` §5/§6 (site #7 needs a
  `listCards.ts` row and a listing-host `content_scripts` block),
  `CANDIDATE_SITES.md` §5, `CAPTURE_GUIDE.md` (capture the LISTING page too),
  `MULTISITE_V4_PLAN.md` status, and the three READMEs.
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
- **Items 62/63/64 implemented (2026-09-25, session `arena/01a0d7b8`):** the
  previous session's red tests are green in both trees. `utils/listCards.ts` is
  the real per-site selector table; `findCards()` returns a site with every
  card, so history, bookmark identity and the job payload are site-aware; the
  manifest gained the five-host listing `content_scripts` block; the panel
  preview and every gallery page carry **Save offline** (Alt = open the
  existing form); the floating bar gained **Select all** and stays visible
  while cards exist; the gallery page's **Select** feeds the shared `allIds`,
  now stamped with `allIdsSite` and wiped per site. New coverage:
  `e2e-list-controls` per-site discovery + Select all, `e2e-title-bookmark`
  phase 10 (per-site Smart Download, Alt route, history guard, Select,
  cross-site wipe) — 146 → 263 checks.
- **Review pass (2026-09-25): item 59 was Firefox-only.** Chrome never asked
  storage for the optional `listFormat` key in `readListSettings()`,
  `options.ts`, `popupSettings.ts` or `listControls.ts`, so a saved list format
  was silently ignored while the UI advertised the inherited one. The Chrome
  unit fixture returned the whole store merged over defaults, which is exactly
  what hid it; it now uses the shared key-scoped
  `scripts/test-support/storage.js` (both trees) and the 36-case matrix runs
  against the real reader and the built card/bar controls.
- **Items 62/63/64 recon + red-first (2026-09-25, previous session):** full recon
  of the panel Download-tab header (62a), the site gallery-page Smart Download
  (62b), the six-site card-selector table (63), and Select-all + title-page
  select (64); hitomi listing markup fetched live (`search.html` +
  `galleryblock.js` + `getGalleryId`). Red tests written and verified in both
  trees: **8 red unit tests per tree** (`manifest` listing-hosts block,
  `partitionKnown` explicit-site arg, `message` "Save offline" control,
  `batch-pipeline` bare-force-id × job-site composition, and 4 `list-cards`
  contract tests against a compiling NOT-IMPLEMENTED stub) plus
  `e2e-list-controls` multi-site fixtures + a `location` in the sandbox + 3
  assertion flips, red at the item-64a "bar visible while cards exist" assert.
  Nothing implemented yet — see the "Next session" section.

## Next session — what is left after 62/63/64 (merged on main, PR #50)

**Mandatory first step, unchanged: review the previous session's diff before
writing code** (`WORKLIST.md` "Mandatory first step"). The 2026-09-25 review
pass is the proof it pays: it found that item 59's list-format fix shipped
**Firefox-only** and that the Chrome fixture that should have caught it was a
whole-store merge stub; the 2026-09-26 pass found three more (the dead
listing-only guard, the unrequested `allIdsSite`, the nhentai legacy checkbox
on the five added hosts).

**Items 62/63/64 are DONE** (both trees, all previously-red tests green), the
2026-09-26 review pass closed its three follow-up defects, and **items 65 and
71** have landed. What is left, in the order I would take it:

0. **Two open questions first — items 66 and 71's UX choice.** (a) Item 66's
   owner-confirmed spec says the per-site filter builds "as one header unit"
   with the 65 rename; the rename shipped alone (it was the requested item), so
   the filter needs an explicit go-ahead before anyone starts it: one compact
   `<select>` at the list header (All sites | nhentai | hitomi | hentaiera |
   imhentai | hentaienvy | hentaifox), remembering the last choice across
   unselect/close. (b) Item 71 shipped the "range block + on-page Select"
   reading; if the owner wants the range block *alone*, that is a wording
   change to `#selectionPointer`, not a rebuild.
1. **Item 40** (bootstrap a listing page in `scripts/e2e-popup.js`) — the only
   offline-feasible backlog item left, and the reason the panel **Save
   offline** *click handler* (62a) has no offline coverage: the handler is
   registered inside `updatePreviewAsync`, which the harness cannot reach. The
   markup and the gallery-page twin (62b) ARE covered offline.
2. **Items 68 / 70** — Bookmark list load management and live-session
   auto-fetch, when the owner opens them.
3. **Items 42/58** — real-browser pass. New checks added by 62/63/64 are
   listed in `WORKLIST.md` under the 42/58 heading (per-site card controls on
   real listings, the hitomi block-boundary evidence flag, the gallery-page
   button's placement, the panel Save-offline click, `allIdsSite` behaviour).

**Locked design decisions (kept from the 62/63/64 recon — do not re-litigate):**
1. **62a (panel header):** primary "Save offline" = direct single-gallery
   download with list-mode format/template (`readListSettings`), history guard
   ON (fresh `readHistory` + `toGalleryKey(id, source.site)` → confirm →
   `redownloadIds:[id]`), always `separate: true`; secondary (Alt) = focus
   `#downloadFormat` to open the existing form. Label **"Save offline"** (must
   NOT match `DOWNLOAD_TEXT_RE`, which starts with "download").
2. **62b (site gallery page):** the second control after Bookmark
   (`nhdw-title-save`), wired with a per-attribute guard so a re-run cannot
   double-inject; `nhdw-title-save`/`nhdw-title-select` are in
   `OWN_UI_CLASSES`; rules in `css/titleBookmark.css`. Primary = the same
   `downloadAllDoujinshis` message with `site:`; secondary asks the worker to
   open the panel (`siteUiOpenPanel` — handled in BOTH trees now: the Firefox
   worker opens a panel tab, the Chrome worker calls `chrome.sidePanel.open`
   because a content script has no `chrome.sidePanel`). Do NOT port
   `PANEL_SOURCE_TAB_KEY` to Chrome.
3. **63 (card selectors):** `utils/listCards.ts` is the per-site table;
   `findCards()` dispatches on `getSourceForUrl(location.href).site` and
   returns a site with every card, so history (`partitionKnown(..., site)`,
   `toGalleryKey(id, site)`), bookmark writes (`site` + composite key) and the
   job payload (`site:`) are site-aware everywhere. The manifest carries a
   second `content_scripts` block for the five non-nhentai listing hosts.
   **`getGalleries.ts` (panel listing view) is OUT of scope for 63.**
4. **64a (Select all):** `#nhdw-select-all` beside Clear; the bar is visible
   whenever the page HAS listing cards.
5. **64b (title-page select):** the gallery page writes the BARE id into the
   same `chrome.storage.local.allIds`, stamped with a new **`allIdsSite`**
   key, and the wipe is site-scoped (never a persistent temp list).

**63 card-selector table (shipped — mirrors `src/utils/listCards.ts`):**

| site | mode | container | cover / link | title | id source |
|---|---|---|---|---|---|
| nhentai | link | (link's parent) | `a[href*="/g/"]` | `.caption` (inside the link) | `/g/(\d+)/` |
| hentaifox | card | `.thumb` | `a[href*="/gallery/"]` | `.caption` | `/gallery/(\d+)/` |
| imhentai | card | `.thumb` | `a[href*="/gallery/"]` | `.caption` | `/gallery/(\d+)/` |
| hentaiera | card | `.thumb` | `a.inner_thumb.img_box` | `.gallery_title` | `/gallery/(\d+)/` |
| hentaienvy | card | `article.hnv-gallery-card` | `.hnv-gallery-card__cover` | `.hnv-gallery-card__title` | `/gallery/(\d+)/` |
| hitomi | content | block inside `.gallery-content` | `h1 a` | `h1` | trailing number in `/<type>/<slug>-<id>.html` |

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
- **`allIds` is a transient selection, namespaced by `allIdsSite`** (3.10.0).
  The cards, the panel and a gallery page's **Select** all write BARE gallery
  ids into `chrome.storage.local.allIds`; `content.ts` and `preview.ts` wipe it
  only when the site namespace changes (`allIdsSite` != the current page's
  adapter site), so a selection survives same-site navigation and is dropped
  when the user moves to another site. It must never be persisted as history,
  bookmarks or any other durable store. **Every reader must ask storage for
  `allIdsSite`** — the bar reader (`listControls.readSelection`) once did not,
  which left the cross-site guard dead until the 2026-09-26 review fixed it.
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
  Downloader after a successful final save AND in its catch **only when
  `downloadName !== null`** (this instance owns the writer: the merged-batch
  final save, or a separate-mode gallery with its own writer). Intermediate
  merged galleries share one writer with `downloadName === null` and must
  never clean it up — a mid-batch failure/cancel used to wipe pages already
  collected and corrupt the final archive (fixed 2026-09-24, session
  `arena/01a0d31d-nh-dw-2-0`). `StreamingZipWriter.cleanup()` also awaits
  the write chain before releasing the sink.
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
- The Bookmark tab always downloads `separate: true`; format/master folder/
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
  preview flow (the Bookmark tab can be open on any website); enrichment reports
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

**62/63/64 additions (new, 2026-09-25):** card controls + the floating bar on a
REAL listing of each of the five non-nhentai sites (Select box, bookmark icon,
Download button; **Select all** selects the page and the bar is visible before
anything is ticked). Start with the hitomi row — it is the only one with no
captured sample, so verify the `.gallery-content` block boundary and the id
parse before trusting the others. Then: a card **Download** on hentaifox /
imhentai / hentaienvy / hentaiera / hitomi really resolves and fetches through
that site's adapter (the job carries `site`, the file keeps the bare-id name);
the **bookmark icon** on a non-nhentai card bookmarks with that site (Queue row
shows the right site, and the same number on two sites stays two rows); the
gallery page's **Save offline** sits after our Bookmark in the site's own row
and does not inherit the site's Download styling; the panel's **Save offline**
click (NOT covered offline — see item 40) downloads with the list-mode format;
**Alt**-click opens/reveals the existing form (Chrome: the side panel; Firefox:
a panel tab); a listing selection survives opening a title on the same site and
is dropped when you switch to another site (`allIdsSite`).

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
- Do not read an optional storage key without requesting it. Object-form `chrome.storage.get(defaults)` answers ONLY the keys named in `defaults`, so a key with no default (e.g. `listFormat`) must be appended explicitly (`Object.keys(defaults).concat("listFormat")`); the reader then sees `undefined` and the documented inheritance stays observable. Item 59 shipped Firefox-only for four days because three Chrome readers skipped this.
- Do not write a storage stub that merges the whole store over the caller's defaults (`Object.assign({}, defaults, store)`) — it hides the rule above and hid the same defect. Use the shared key-scoped `scripts/test-support/storage.js` (both trees).
- Do not edit `.github/workflows/**` from an agent session (whole-push rejection); use `ci/pending-workflows/`.
- Do not `git show`/`git cat-file` the pre-sanitization capture commits in an agent session — the original titles trip content filters (working tree is sanitized; history is not).
- Do not add a `test/*.test.js` file without appending it to the explicit mocha list in `package.json`'s `test` script (a new file silently runs nothing and the suite still reports success).
- Do not run bare `npx mocha test/x.test.js` for verification — it uses a stale `build/test/`; only `npm test` runs `build:test` first.
- Do not let a settings pane write on render (`popupSettings.ts`, `options.ts`): only explicit `change` handlers write.
- Do not run `npm audit fix --force`, suppress deprecation warnings, or fork Mozilla's validator to silence the two remaining upstream warnings (`DEPENDENCY_MAINTENANCE.md`).

**Listing card controls, Smart Download, Select all (62/63/64)**
- Do not discover cards with one global selector: `findCards()` dispatches through `utils/listCards.ts` on the page's own adapter site, and every card carries that site.
- Do not compare a non-nhentai card's id against history/bookmarks without the site (`toGalleryKey(id, site)`, `partitionKnown(history, ids, forced, site)`), and never send a card/bar job without `site:` — a hentaifox id would be fetched through nhentai.
- Do not compose a **recorded** history id with the job's site: bare ids mean the default site (legacy pre-3.8.0 history), which is why the pipeline's `alreadySet` normalizes with `toGalleryKey(id)` and not `toGalleryKey(id, jobSite)`. The `redownloadIds`/force list is the opposite — it comes from the current page, so it IS site-relative and keeps composing with the job site. (Both directions are pinned in `test/batch-pipeline.test.js`.)
- Do not rename the internals behind the Bookmark tab's UI label: the storage key stays `bookmarkQueue`, the ids stay `#tabQueue` / `#queuePane`, the row classes stay `nhdwBm*`, the actions stay `bookmarkGet` / `bookmarkImport`, the export format stays `v1`. The 2026-09-26 item-65 test asserts this.
- Do not hide the floating action bar while the page still has listing cards: **Select all** lives there and would be unreachable. Hide it only when `findCards()` finds nothing.
- Do not decorate gallery or reader pages: `findCards()` resolves the page through `resolveListCardPage()` (site + target). A site's related-gallery markup matches its listing selectors (hentaiera `div.thumb > a.inner_thumb.img_box` with `.gallery_title`, hitomi `#related-content.gallery-content` with `h1.lillie > a`), so the tested guard — not the absence of card-shaped markup — is what keeps the controls on listings.
- Do not let `allIds` cross sites: stamp it with `allIdsSite` and wipe it when the namespace changes (cards, panel and the gallery-page Select all share it). Do not read `allIdsSite` without requesting it — object-form `get` answers only the named keys, so request it with an empty default exactly like `content.ts` / `preview.ts` / `titleBookmark.ts` / `listControls.ts` now do.
- Do not label the Smart Download control with anything starting with "download" (`DOWNLOAD_TEXT_RE` owns that wording and the anchor search); the label is **"Save offline"**, and its primary action must stay a single, always-separate job.

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
- Do not let the Bookmark tab write the queue or the history itself (worker single writer; `bookmarkImport` / `historyImport` → `writeHistory()`).
- Do not move a similar row's bookmark button inside its `<label>` (a click would also tick the download checkbox), and do not give the drag-reorder row itself `draggable` (only `span.nhdwBmDrag`).
- Do not make the Bookmark tab download in merged mode (always `separate: true`).
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
  **3.10.0** (PR #50, merged 2026-09-25) items **62/63/64** — per-site listing
  card controls (`utils/listCards.ts`), panel **Save offline**, gallery-page
  **Save offline** + **Select**, **Select all**, `allIdsSite` wipe — plus the
  Chrome port of item 59 (saved list format). **3.10.1** (2026-09-26, this
  branch) the PR #50 review pass: live listing-only guard, `allIdsSite`
  requested by the bar reader, nhentai-only legacy checkbox. **3.10.2**
  (2026-09-26, this branch) item 65: the third panel tab is **Bookmark** —
  UI copy only. **3.10.3** (2026-09-26, this branch) item 71: the list's
  shared-selection pointer + the List-mode hint, and the skip-guard identity
  fix (bare recorded id = default site).
- **Firefox:** 1.0.0 Android snapshot → 1.1.0 parity elevation (rebase onto
  Chrome src + audited delta) → 1.2.0 website-embedded UI (items 56/57, PR #44
  review) → 1.3.0 Chrome-3.9.0 backport → **1.4.0** Chrome-3.10.0 backport
  (62/63/64 card controls, Save offline, Select all) → **1.4.1** the
  2026-09-26 review fixes, same as Chrome 3.10.1) → **1.4.2** item 65, the
  Bookmark-tab rename, same as Chrome 3.10.2 → **1.4.3** item 71, same as
  Chrome 3.10.3. Items 38 (options
  harness) and 59 (list-format readers) were Firefox-scoped fixes — 59 is now
  also in Chrome. `PORTING_AUDIT.md` +
  `FIREFOX_PARITY_PLAN.md` in the Firefox folder are the port's own records.
- **Dependency maintenance (2026-09-21):** Mocha 12.0.2 both trees, web-ext
  10.6.0 + scoped addons-linter 10.13.0 override (Firefox), audits 16→0 /
  5→0, two honest upstream warnings remain.
- **Captures:** all six initial sites captured + audited 2026-09-15…23 (the
  audit's findings live on in `ADAPTER_WIRING_PLAN.md` §1); capture files
  sanitized 2026-09-24.
