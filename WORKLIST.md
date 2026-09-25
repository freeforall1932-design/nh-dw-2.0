# Worklist — nh-dw-2.0

**Live, ordered. Updated 2026-09-25** (session
`arena/01a0d31d-nh-dw-2-0`: **items 62/63/64 recon + red-first** — full recon,
8 red unit tests per tree + `e2e-list-controls` multi-site fixtures + a
compiling `listCards.ts` stub, **no production logic yet**; see
`SESSION_HANDOFF.md` "Next session" section). Previous session
`arena/01a0cdce-nh-dw-2-0` (2026-09-24):
items **39/45/51** landed with PR #48, the mandatory review pass fixed eight
defects in them (Firefox cancel-UI parity, cancel-mark lifecycle, cross-site
cancel identity, done-row guard, OPFS cleanup hardening, stale docs), captures
+ notes were **sanitized** on owner request (dummy titles/tags, ad blocks
stripped, website naming schemes kept; originals only in git history), and the
docs were consolidated — `SESSION_HANDOFF.md` slimmed to operating rules,
completed-work detail lives in `IMPROVEMENT_BACKLOG.md`;
`BOOKMARK_QUEUE_PLAN.md`, `NEXT_CAPTURE.md` and `SITE_CAPTURE_AUDIT.md` were
deleted as complete/superseded. Session `arena/01a0d31d-nh-dw-2-0`: shared-writer
cleanup regression fixed (new "Done" line below) and the owner's panel-rewrite
roadmap landed as **items 60–71** — all three elaborations closed
(cart = badge + expandable; site filter = dropdown + remember last;
thumbnails = viewport-lazy + GC = distance + idle sweep); owner free-text
notes folded into 60/66/68. **Item 60 (side-panel wash) fixed** — red-first
e2e phase 9/13, both trees green.)

This is the single place to look for *what to do next*.

| Document | What it is for |
|---|---|
| **`WORKLIST.md`** (this file) | Ordered, statused list of open work. Start here. |
| **`SESSION_HANDOFF.md`** | Operating rules: current state, structural invariants, real-browser checklists, the full Do-not list. Read before touching code. |
| **`IMPROVEMENT_BACKLOG.md`** | The improvement log: full specs + session logs for every numbered item. The keeper of completed-work history. |
| **`MULTISITE_V4_PLAN.md`** | Multi-site decision record, cooldown strategies (C pending owner), bucket list. |
| **`ADAPTER_WIRING_PLAN.md`** | Per-site contract matrix + adapter interface — the reference for site #7+. |
| **`CAPTURE_GUIDE.md`** | How to capture samples for a NEW site. |
| **`CANDIDATE_SITES.md`** | Candidate analysis for site #7+ (tiers, onboarding checklist, the 2026-09-24 swap decision). The canonical URL roster lives in `new domain candidate` on main. |

Item numbers are shared with `IMPROVEMENT_BACKLOG.md` and are never reused.

---

## Mandatory first step, every session

**Review the previous session's diff before writing new code.** Hunt for
(1) **missing logic** — a handler with no caller, a setting with no reader, a
notice promising what the code never does; (2) **misaligned code** — a guard in
one path but not its sibling, a default contradicting its own comment;
(3) **broken code** — a state read clobbering a concurrent write, an optimistic
update wiped by the next refresh. Then write a test that **fails on the
pre-fix build**. This rule has paid for itself four times (3.7.0: six defects;
2026-09-05: eight; PR #44 review; PR #48 review: eight more — including a
whole feature's UI missing from one tree).

Two cheap checks that have caught real bugs here:
- `grep -rn <exportedName> src/ scripts/ test/` — an export with one hit (its own declaration) is dead code; a message action with a handler but no sender is dead too (check BOTH trees — that was PR #48's defect 1).
- For any guard you add, grep every caller of the unguarded original and ask whether each is safe by construction or by accident.

---

## Open, in the order I would take them

### Owner roadmap 2026-09-24 — panel rewrite, site parity, auto-fetch (items 60–71)

Owner order confirmed: **bug first, then UI fill**. Specs below are the
confirmed reading of the owner's brief; three decisions stay open and are
elaborated one topic at a time before their items start (do not implement the
open parts until the owner answers).

**Confirmed product rules (apply to every item below):**
- Auto-fetch **v1 = page-range of the live query** (pages 1…N of the URL
  currently open — search/tag/artist/home). Live-session crawl (capture that
  survives navigation / infinite scroll) is a **later phase**, not v1.
- The range picker is **batch-shaped on purpose**: it must not collide with
  on-page Select. Full-page grab already works via card Select + Select-all;
  the Download-tab filler adds *multi-page range* on top.
- Dedicated panel/site **Download** control is **smart**: primary action =
  direct download with pre-determined list-mode naming + format; secondary
  affordance (chevron / long-press / alt) = open the existing download form.
- On gallery pages the site already has its own Download control — ours must
  be **visually and verbally differentiated** (working names from owner:
  "save gallery" / "save it" / "save offline"; final label TBD).
- **Queue tab → renamed Bookmark tab** (storage key `bookmarkQueue` and
  message actions stay as-is — rename is UI-only; see Do-not in handoff).
- Bookmark list must stay **persistent across full browser restart** (already
  true) and gain **load management** for very large lists (title search;
  tag/artist/date filters — engine details in a later open topic).
- Thumbnails in the Bookmark list are **never saved to disk**; only fetched
  for display, and only when the owner opts in (behavior = open topic).
- If a feature is **impossible** on a site's architecture, record it under
  **Blocked** (bottom of this section) with the reason — never silently skip.

#### Ordered items

- [x] **60. Side-panel query-wash / view-reload bug — fixed 2026-09-24.**
  Root cause: `popup.ts` `updatePreviewAsync()` unconditionally wrote
  `message.invalidPage()` into `#action` whenever the active tab's URL had no
  site adapter — so any tab switch/navigation while the panel was open washed
  a live Download-tab view (the owner's "100-line query wipe", and it
  "followed" them onto every unsupported site). Same-URL reboots were already
  guarded by `lastBootstrappedUrl` (red-first phase 9a/9b passed on the
  pre-fix build); the wash was specifically the unsupported-origin branch.
  **Fix (both trees, shared logic):** only paint the invalid-page notice when
  `#action` is still a placeholder (`""` / `"Loading..."` / the notice
  itself). A live view (listing, gallery form, half-typed draft, progress)
  is left alone; returning to a supported URL still re-bootstraps normally.
  **Red-first:** Chrome `e2e-popup.js` phase 9a–9d and Firefox phase 13a–13d
  (Firefox harness needed `isDownloadFinished` flippable to `true` so
  bootstrap reaches `updatePreviewAsync`). Pre-fix run: phase 9c **FAIL**
  `invalidPage` replaced `DRAFT_QUERY_MARKER_100_LINES`; post-fix: both
  trees green. Owner repro notes (visible only while open; browser-close
  does not trigger; follows onto non-supported sites; persistence acceptable
  only if unavoidable) are folded into this item's description above.

- [x] **61. Download-tab auto-fetch fill (page-range v1) — after 60.**
  Fill the empty space on the panel's Download tab with a **range block**:
  detect the active listing (site adapter + live URL), show current page /
  max page, accept `1-5` style ranges (reuse paste-range parser shape from
  the bookmark box), then either **Download range now** (feeds existing
  `downloadAllPages` / per-site job path) or **Add range to Bookmark**.
  nhentai first (listing extraction already exists in `getGalleries.ts`);
  other sites land with item 63's listing parity. On pages where on-page
  Select + Select-all already give a single full page (item 64), the range
  block is the multi-page path on top — and drives item 71's demotion of
  the old blanket "Download all (N pages)" entry. Explicitly NOT infinite
  scroll in v1.

- [ ] **62. Smart Download control beside Bookmark (gallery + panel) — after 60.**
  ⚠ **PARTIAL (red-first, no impl yet, 2026-09-25).** Red test in place:
  `message.test.js` asserts the "Save offline" direct control beside
  `buttonBookmark` in `downloadInfo`. Label **locked to "save offline"**.
  Remaining: 62a panel handler (message.ts + popup `#button` sibling;
  `readListSettings` format/template, history guard → `redownloadIds:[id]`,
  secondary = focus `#downloadFormat`) and 62b site gallery-page button
  (`titleBookmark.ts` `insertAfter` + per-attr guard, `nhdw-title-save`, CSS).
  Primary click = direct download (list-mode format + template, history
  guard on). Secondary = open the existing download form (title/format/name
  preview). Two placements: (a) panel Download tab header, (b) **site gallery
  page** next to our Bookmark button. On (b) the label must not collide with
  the site's own Download (owner candidates: "save gallery" / "save it" /
  "save offline" — **locked: "save offline"**). Chrome tree + Firefox tree
  together; declarative anchor table extended like `titleBookmark.ts`.

- [ ] **63. Card controls on all six sites (Select + Bookmark + Download) — after 61/62.**
  ⚠ **PARTIAL (red-first, no impl yet, 2026-09-25).** Red tests in place
  (both trees): `list-cards.test.js` six-site contract tests (against a
  compiling `listCards.ts` NOT-IMPLEMENTED stub), `manifest.test.js`
  listing-hosts block, `download-history.test.js` `partitionKnown` explicit
  site, `batch-pipeline.test.js` bare-force-id × job-site, `e2e-list-controls`
  multi-site fixtures. **Remaining (the actual work):** real `listCards.ts`
  table + `findCards` (:306) per-site dispatch; pass site to history +
  bookmark (composite key); manifest `content_scripts` block for the 5
  non-nhentai listing hosts (`content.js` + `listControls.js` +
  `css/content.css`); per-site e2e discovery phases. Card-selector table in
  `SESSION_HANDOFF.md` "Next session". **`getGalleries.ts` panel-listing port
  is OUT of scope for 63** (see Blocked note below).
  Port `listControls.ts` injection beyond nhentai: per-site card selectors
  (cover link, caption, container) declared like the titleBookmark table —
  adapted to each architecture, never one brittle global selector. Includes
  manifest `content_scripts` matches for listing URLs (not only `/g/`).
  Floating bar + `allIds` selection sharing already generic — keep. Blocked
  sub-cases go to Blocked below with evidence.

- [ ] **64. Select-all + title-page select integration — with 63.**
  ⚠ **PARTIAL (red-first, no impl yet, 2026-09-25).** Red test in place:
  `e2e-list-controls` item-64a assert flipped to "bar visible while listing
  cards exist" (currently red — the bar only shows once something is
  selected). **Remaining:** (a) `#nhdw-select-all` in `buildActionBar` (:490)
  beside Clear + make the bar visible whenever cards exist; (b) gallery-page
  Select writes the bare id into the same `chrome.storage.local.allIds` +
  repaint on `onChanged`, with a **site-scoped** `allIds` wipe (never cost a
  persistent temp list). Invert/Clear already exist in the panel list — keep
  them consistent.
  (a) Floating bar gains **Select all / Clear** for linear listings
  (home, search, tag, artist — every page `getGalleries` can see).
  (b) On a **single gallery page**, our Select affordance adds *this* title
  into the same `allIds` selection set used on listings, so card + panel
  agree. Invert/Clear already exist in the panel list — keep them consistent.

- [ ] **65. Rename Queue tab → Bookmark tab (UI-only) — after 60, can parallel 61.**
  Tab label, pane copy, tooltips, README/handoff user-facing strings.
  Storage key, message actions, and export format **unchanged** (handoff
  Do-not: no store rename). Firefox drawer copy follows (byte-identical
  shared files rule).

- [x] **66. Bookmark tab per-site filter — confirmed: dropdown select + remember last selection.**
  Elaboration 2 closed 2026-09-24 (owner chose **A** + free-text note:
  remember/restore the last chosen option even after unselect/close, so
  re-opening the panel doesn't lose the filter they were testing with —
  "store or remember on unselected option"). One compact `<select>` at the
  list header: All sites | nhentai | hitomi | hentaiera | imhentai |
  hentaienvy | hentaifox (live counts appended to option labels when cheap,
  e.g. "nhentai (800)"). Keyboard-friendly, one permanent row, trivial to
  render even at 10k+ rows — plays clean with 68's windowed list. No chip
  row, no grouped sections. Builds with 65 (rename) as one header unit.

- [x] **67. On-page cart — confirmed: badge + expandable mini-cart.**
  Elaboration 1 closed 2026-09-24 (owner chose **B**). Compact count chip
  docked next to our existing Select floating bar (same screen real estate —
  must not stack or occlude; shared positioning rules, fragile);
  click expands into the same drawer contents cin-style (count, compact
  title rows, bulk clear / open manager). Live mirror of the persistent
  bookmark store; text-first, thumbnails only if 69 opts them in for that
  view. Side panel remains the full Bookmark tab. Not floating-drawer (A)
  and not idle-fade hybrid (C).

- [ ] **68. Bookmark list load management + already-downloaded marks — after 65.**
  Title search box; filter by tag / artist / date; combined queries. Target
  scale: tens of thousands of rows without jank — windowed rendering or
  equivalent required (cap raise for `MAX_BOOKMARK_ITEMS` is a separate
  owner decision, not implied). **Owner free-text note:** batch download of
  "that list" on Bookmark — with or without search/filter active — must show
  an **already-downloaded** indicator (green checkmark per title for
  simplicity, or group differently) so re-downloads are obvious before you
  run the batch. **Green check only on true success** — never mark a row
  that failed midway as done.

- [x] **69. Thumbnail opt-in + GC — confirmed: viewport-lazy + garbage collection (fragile).**
  Elaboration 3 closed 2026-09-24 (owner custom). **Never persisted**
  (display-only, site CDN). Load-thumbnails for a view; rows lazy-load via
  IntersectionObserver (~30 concurrent, pause during fast scroll).
  **GC trigger: both** — distance drop while scrolling (N viewports away
  from a loaded thumb) **plus** idle-interval sweep (~15–30s) of anything
  not in viewport; **purge all** when panel closes or owner switches site
  group (dropdown 66); on **cross-site search/filter** results (owner's
  dedupe / batch-download prep flow) keep timer/distance GC active.
  Text-only remains the resting state.

- [ ] **70. Live-session auto-fetch (phase 2 of 61) — after 61 ships.**
  Port the twitter-batch-download *ideas* (shallow read of what the tab
  already rendered; MutationObserver harvest so rows aren't lost; run-token
  Stop; optional auto-scroll) onto these six sites' listing/DOM. Infinite
  scroll and "must survive reload" flows live here. Separate spec pass when
  v1 range fetch has real-browser data.

- [ ] **71. Panel list actions vs on-page Select — after 63/64.**
  On listing pages where on-page Select + Select-all exist, the panel's
  redundant "Download all (N pages)" multi-page entry is **demoted or
  replaced** by a pointer to the range block (61) + on-page selection.
  Owner intent confirmed; exact UI (hide vs collapse into range block)
  decided when 61+63 are real.

#### Blocked (record here the moment a site cannot support an item)

_(format: `item · site · architecture reason · capture reference`)_

- **63 · scope note (2026-09-25):** the panel **listing view**
  (`src/preview/getGalleries.ts` + `src/content/getGalleries.ts`) is
  nhentai-shaped and is **NOT** part of item 63. Item 63 is strictly the
  on-page card controls + the manifest listing-host `content_scripts` block.
  If a multi-site panel listing view is wanted later, that's a separate item
  (candidate 70 territory) — do not silently fold it into 63.
- **63 · hitomi (evidence secured, not blocked):** hitomi listing cards are
  JS-rendered (no markup in the homepage capture), so the hitomi row in
  `list-cards.test.js` was derived from a **live fetch** of
  `hitomi.la/search.html` (block = `.gallery-content` child, title `h1 a`,
  pretty URL `/<type>/<slug>-<id>.html`, cover `img[data-src]`) + `getGalleryId`
  (already handles these URLs). **Flag for the debug-review:** the hitomi
  card row is the only one without a captured sample — verify the block
  boundary + id parse against a real listing in a browser pass.

---

### 42/58. Real-browser + Android device passes, then signing — **owner-only, top of the queue**

The only unverifiable-here claims left. Chrome: the Queue-tab checklist, the
naming-guard probes (0A–0E), list-mode/formats steps and the new PR #48 items
(per-row Cancel mid-batch + retry-after-cancel, late-cancel done guard, real
OPFS streaming on a large gallery). Firefox desktop pass + Android matrix,
then `npm run sign:firefox` (AMO keys via env). **Full step-by-step checklists:
`SESSION_HANDOFF.md` → "Required real-browser verification".** `npm run
test:browser` has never run in any agent sandbox.

### 40. Popup harness does not bootstrap a listing page — offline-feasible

Item 59 delivered `getGalleries` directly to test format rendering, but page
injection/bootstrap, pagination, listing-job/PDF-merge and similar-gallery
workflows are still only covered by the content-script harnesses
(`e2e-list-controls.js`). Extending `scripts/e2e-popup.js` means stubbing
`getGalleries` + `activeTabGallery` — a real piece of work; both trees.

### Pending on the OWNER (nothing here is scheduled until they act)

- [ ] **⏳ Strategy C go-ahead (item 50 follow-up).** Chosen and recorded, but
      execution waits for the owner's explicit confirmation (other projects
      running). The owner's own live-testing note already leans Strategy A
      (reader-mode pages won the quality comparison; mirror zips were
      byte-identical), but C is the recorded decision path. A/B/C descriptions:
      `MULTISITE_V4_PLAN.md` §3.
- [ ] **⏳ Site #7 pick.** The 2026-09-24 owner-directed swap landed:
      `new domain candidate` on main now carries the reference roster
      (Tier 1: asmhentai, e-hentai, pururin, simply-hentai, myreadingmanga,
      nhentai.com; Tier 2 boorus), matching `CANDIDATE_SITES.md` §2/§3 1:1 —
      no double entries. The chapter-based webtoon/manhwa picks (tailspace,
      mangak.io, omegascans) swapped to the desktop archiver project. When
      the owner picks one: capture per `CAPTURE_GUIDE.md` (one sanitized HAR,
      or gallery+reader HTML and 3 image URLs), then implement against
      `ADAPTER_WIRING_PLAN.md` §1/§3/§4/§6.
- [ ] **Merge PR #48** (items 39/45/51 + review fixes; CI green; mergeable).
- [ ] **Cross-mirror fallback chains** from the owner's live-testing note
      (throttle-route imhentai↔hentaienvy via the shared `/033/<token>/` store
      by host swap — never by id; hentaiera→hentaienvy→imhentai and
      hentaiera-first chains by title match): deliberately deferred (owner's
      2026-09-15 call: one site at a time, no cross-mirror fallback yet).
      Recorded in `MULTISITE_V4_PLAN.md` §2.2 so it is not re-derived.

---

## Done (one line each — details in `IMPROVEMENT_BACKLOG.md` session logs)

- **Shared-writer cleanup regression (2026-09-24, this session):** merged-batch
  `Downloader.catch` no longer wipes the shared `StreamingZipWriter`
  (gate: `downloadName !== null`); dead `cancel()` / `JSZip` require /
  unused import removed; red-first unit + e2e phase; Chrome 521 / FF 597.

- **39/45/51 (2026-09-24, PR #48):** empty-token filename cleanup ·
  per-row Cancel of in-flight downloads · constant-memory streaming ZIP writer
  (OPFS + memory fallback). Review pass fixed 8 defects (Firefox UI parity,
  cancel-mark lifecycle, composite cancel identity, done-row guard, OPFS
  delayed-unlink + orphan sweep, channel hygiene, stale READMEs, DEFLATE
  honesty). Chrome 519 / Firefox 595 units; e2e 143/175 PASS; CI green.
- **48 (2026-09-23, PR #47):** per-site jobs — a `site:id` queue row is
  downloadable; mixed selections split one job per site; per-adapter metadata
  resolution; bare-id file names; composite history/retry keys.
- **43/44/52/41 (2026-09-23, PR #47):** panel + similar-row bookmark toggles ·
  drag-reorder (order = download order) · queue+history JSON export/import
  (union, local wins, never deletes) · `isCanonicalTemplate()` odd-separator gate.
- **Bookmark icon + gallery-page Bookmark button (2026-09-23, 3.9.0/FF 1.3.0):**
  SVG bookmark on cards; blue Bookmark button on all six sites' gallery pages.
- **49/50/53 (2026-09-22/23, 3.9.0/FF 1.3.0):** hitomi adapter (`gg.js`
  dynamic resolver, default raw) + mirror-network adapters (hentaiera,
  imhentai, hentaienvy) + hentaifox — all six sites shipping.
- **47 (2026-09-14, 3.8.0):** composite `(site,id)` keys everywhere; `cin.*`
  viewer-mirror paste shapes pinned.
- **59 (2026-09-21, Firefox-scoped):** saved list-format reads fixed across
  the three shared readers (explicit optional-key request, no ZIP default,
  inheritance intact; 36-case matrix).
- **Dependency maintenance (2026-09-21):** Mocha 12.0.2 both trees; web-ext
  10.6.0 + scoped addons-linter override (FF); audits 16→0 / 5→0; two honest
  upstream warnings remain (`DEPENDENCY_MAINTENANCE.md`).
- **38 (2026-09-21, Firefox-scoped):** options-page offline harness (33 tests)
  + narrow `options.ts` regression fixes.
- **56/57 (2026-09-20, FF 1.2.0):** website-embedded UI — header invoker +
  settings/queue drawer on nhentai; popup demoted to fallback (Download tab
  kept); PR #44 review fixes (source-tab context, renderer CSS, drawer
  lifecycle).
- **46/37/55/54 (2026-09-19, FF 1.0.0/1.1.0):** Android snapshot; parity
  elevation rebase (Firefox = Chrome src + audited delta); Firefox panel harness.
- **3.7.0 (2026-09-08):** bookmark queue (Queue tab, ☆ on cards, paste box,
  dock, auto-capture off-by-default); six-defect self-review.
- **3.6.0–3.6.4 (2026-09-04/05):** named failures + Retry failed; raw
  completion tracking; `[object Object]` sweeps; shared batch pipeline;
  one format decision per job; review items 28–36 closed.
- **3.5.0 (2026-09-04):** download history, verify-then-redownload, merged
  warn-first naming (`_DDMMYYYY`, `_partN`).
- **3.4.0/3.4.1 (2026-09-03/04):** list-mode parity (four formats everywhere,
  separate/batch, list template, folder wrap), side panel, in-page card
  controls; filename-guard listener lifetime (reference-counted).

---

## Harness notes that will cost you a round if you miss them

- **CI runs Node 22; the agent sandbox often runs Node 20.** Node 21+ has a
  getter-only global `navigator` — stub via `Object.defineProperty`, never
  plain assignment (this broke CI once: OPFS sink tests). **Mocha's exit code
  is its failure count** ("exit code 3" = 3 failing tests). Check-run
  annotations + jobs/steps APIs are readable from the sandbox; raw log
  downloads are not.
- **Bare `npx mocha test/x.test.js` uses a stale `build/test/`.** Only
  `npm test` runs `build:test` first — a brand-new export looks "not a
  function" purely because `tsc` never re-ran.
- **A new `test/*.test.js` must be appended to the explicit mocha list in
  `package.json`'s `test` script** (both trees), or it silently runs nothing.
- **`npm run test:e2e` is 8 scripts (Chrome) / 12 (Firefox), each with its own
  hand-rolled DOM/chrome stub.** Read the header of the one you edit — the stub
  traps in `scripts/e2e-popup.js` each cost a debugging round when written.
  Storage stubs must be key-scoped and async (a whole-store merge mock once hid
  the item-59 defect).
- **`js/` is committed, not ignored.** After any `npm run build`, run the
  exhaustive release-folder sync loop (`SESSION_HANDOFF.md` → Repository and
  branch). `test/manifest.test.js` asserts the two manifests' versions match.
- **`node_modules` does not persist between sessions** — `npm install` first
  in whichever tree you touch.
- **Captures are sanitized working-tree files.** Do not resurrect original
  titles from git history into any file an agent will read (content filters
  hard-stop on them); when adding a NEW capture, sanitize it the same way
  first (dummy titles/artists/tags, strip ad blocks, keep website naming
  schemes) — the pattern lives in the 2026-09-24 backlog log.
