# Worklist — nh-dw-2.0

**Live, ordered. Updated 2026-09-26** (session `arena/01a0d976-nh-dw-2-0`:
**items 68 + 70 landed (owner-directed best-effort)** — the Bookmark tab gained
load management (item 68: search, state/date filters, a bounded window and the
already-downloaded marks) and listing pages gained the live-session harvest
(item 70: read what the tab rendered, keep collecting through the observer,
Stop, optional bounded auto-scroll, survive a reload). Both landed **without**
the spec pass they had been waiting on, on the owner's instruction
("implement it the best you can ... how do I test it later if there's nothing
to test"), so every assumed default a spec pass would have settled is written
down in `IMPROVEMENT_BACKLOG.md` → "Items 68 + 70 (2026-09-26)". Chrome
**3.10.5** / Firefox **1.4.5**; 616 / 649 unit tests, smoke + all offline e2e
green, FF lint unchanged (32 warnings).
**item 40 landed (the popup harness now bootstraps a listing page)** — test-only,
so no version bump: `scripts/e2e-popup.js` in both trees grew the two stubs the
item asked for (the injected `js/getGalleries.js` answer, and `executeInTab`
answering `readGalleryFromTab`'s poll from the tab's own gallery), four new
phases (11a–11d Chrome / 15a–15d Firefox) and a documented settle step for the
wash phase's ~2.8s pending tab read. Red evidence comes from mutations instead
of a red test, since the item adds coverage rather than fixing behaviour: with
`js/getGalleries.js` renamed, `separate: true` dropped, the forced
re-download id removed, or `formatOverride` reading the single-title format,
the new phases fail with precise messages (all four tried, both trees).
Chrome 601 / FF 634 unit, e2e exit 0 (+4 phases both trees), FF lint unchanged.
**item 66 landed (the Bookmark tab's per-site filter)** — one permanent
`<select>` at the list header (All sites | nhentai | hitomi | hentaiera |
imhentai | hentaienvy | hentaifox) with live counts in the option labels. It
filters the **view only** (the stored list is never rewritten), it remembers
the last choice across closes and surfaces (`chrome.storage.sync`, like
uiMode), and while a filter is on the toolbar's **Select all / Select none**
send the visible rows' **composite keys** instead of the whole-list form, so
nothing off screen is silently ticked. Chrome **3.10.4** / Firefox **1.4.4**.
**item 71 landed (verify-and-close + one real defect)** — the blanket "Download
all (N pages)" entry was already gone (item 61's range block), so the panel now
also *says* what took its place: a `#selectionPointer` line in the list
("ticking rows here and ticking cards on the page are the same selection; for
the listing's other pages use the range block below") and a List-mode settings
hint that names the range block instead of the retired button. Verifying §E
turned up a live identity defect: the pipeline's skip guard composed a recorded
**bare** id with the *job's* site, so a legacy (pre-3.8.0) nhentai record
masked a same-numbered gallery on another site — a card click on the five added
hosts could report "already downloaded" and never download. Fixed to read bare
ids as the default site's, with both directions pinned. Chrome **3.10.3** /
Firefox **1.4.3**. **Item 65 landed** — the panel's third tab is labelled **Bookmark** and every
tooltip/hint that called it a "Queue" follows (`listControls` card tooltip,
the settings auto-capture hint, the side-panel launcher, the Settings fallback
notice, the two bookmark tooltips); storage key `bookmarkQueue`, ids `#tabQueue`
/ `#queuePane`, message actions and the export format are unchanged, and a new
`test/tab-labels.test.js` (both trees) locks both halves. Chrome **3.10.2** /
Firefox **1.4.2**. **PR #50 review pass** — three defects found on the merged 3.10.0 work and
fixed red-first in both trees: (F1) `resolveListCardPage()`, the listing-only
guard the unit test pins, had **no production caller**, so gallery pages whose
related cards match the listing selectors got card controls + the floating bar
over the title page; (F2) `listControls.readSelection()` read `allIdsSite`
without requesting it, leaving the cross-site selection guard dead (item 59's
class); (F3) the legacy nhentai caption checkbox ran on the five added hosts.
Chrome **3.10.1** / Firefox **1.4.1**, unit 587/620, all offline e2e green,
release re-synced. **Open queue unchanged: 65 → 71 → 40**, then owner-only
42/58.)

Previous session
`arena/01a0d7b8-nh-dw-2-0`: **items 62/63/64 implemented** on top of the
previous session's red tests — real `listCards.ts` per-site selector table,
site-aware card discovery/history/bookmark identity, the listing-host
`content_scripts` block, the panel **Save offline** control (62a), the
gallery-page **Save offline** + **Select** controls (62b/64b), **Select all**
plus a bar that stays visible while cards exist (64a), and a site-scoped
`allIds` wipe via a new `allIdsSite` key. The mandatory review pass found a
second, older defect: **item 59's saved-list-format fix existed only in the
Firefox tree** — three Chrome readers never asked storage for the optional
`listFormat` key, so a saved list format was silently ignored everywhere
(`listSettings.readListSettings`, `options.ts`, `popupSettings.ts`,
`listControls.ts`). Ported to Chrome with the key-scoped fixtures and the
36-case matrix; the Chrome `list-mode.test.js` store stub was a whole-store
merge mock, which is exactly what hid it. Chrome **3.10.0 / 587 unit**, Firefox
**1.4.0 / 620 unit**, all offline e2e green both trees.

**Merged:** the whole 62/63/64 + item-59-Chrome bundle is on **main** via
**PR #50** (merge commit, both CI jobs green: *Offline suites (fixtures +
window-less VM bundles)* and *Firefox snapshot (offline suites)*). Docs were
refreshed in the same commit for the next session: `SESSION_HANDOFF.md` (state +
next-session ordering), this file, `IMPROVEMENT_BACKLOG.md` (session log + item
table), `ADAPTER_WIRING_PLAN.md` §5/§6 (site #7 now **also** needs a
`listCards.ts` row and a listing-host `content_scripts` block),
`CANDIDATE_SITES.md` §5, `CAPTURE_GUIDE.md` (capture a LISTING page too),
`MULTISITE_V4_PLAN.md` (status), and the three READMEs.

Previous session
`arena/01a0d31d-nh-dw-2-0` (2026-09-25) did the 62/63/64 recon + red-first
state; `arena/01a0cdce-nh-dw-2-0` (2026-09-24) landed 39/45/51 + its review —
items **39/45/51** landed with PR #48, the mandatory review pass fixed eight
defects in them (Firefox cancel-UI parity, cancel-mark lifecycle, cross-site
cancel identity, done-row guard, OPFS cleanup hardening, stale docs), captures
+ notes were **sanitized** on owner request (dummy titles/tags, ad blocks
stripped, website naming schemes kept; originals only in git history), and the
docs were consolidated — `SESSION_HANDOFF.md` slimmed to operating rules,
completed-work detail lives in `IMPROVEMENT_BACKLOG.md`;
`BOOKMARK_QUEUE_PLAN.md`, `NEXT_CAPTURE.md` and `SITE_CAPTURE_AUDIT.md` were
deleted as complete/superseded. (Earlier, same day) Session `arena/01a0d31d-nh-dw-2-0`: shared-writer
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

**Top of the queue (2026-09-26, after items 65, 66, 71 and 40 landed):**
**68** and **70** when the owner opens them (both need an owner spec pass),
then the owner-only **42/58** (real-browser + Android passes, then signing),
which outrank everything else in value. No offline-feasible backlog item is
left unstarted: item 40 was the last one, and item 66 the last owner question
except item 71's wording call (below).

**One open question for the owner (recorded, not started):** (1) **item 71's
remaining UX choice** is narrowed to whether the
range block alone is enough on a listing page or the button should also point
at the page's floating bar — the shipped pointer already names on-page
selection, so either answer is a wording change, not a rebuild.

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
  "save gallery" / "save it" / "save offline"; **label locked: "Save
  offline"** — shipped in 3.10.0 / FF 1.4.0, item 62).
- **Queue tab → renamed Bookmark tab** (storage key `bookmarkQueue` and
  message actions stay as-is — rename is UI-only; see Do-not in handoff).
  **Landed 2026-09-26 as item 65** — UI copy + tab label only.
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

- [x] **62. Smart Download control beside Bookmark (gallery + panel) — done 2026-09-25.**
  **62a (panel):** `message.downloadInfo` renders `#buttonSaveOffline`
  ("Save offline") beside `#buttonBookmark`; `popup.ts` wires it to a direct
  `downloadAllDoujinshis` for ONE gallery using `readListSettings()`
  (format + template + master folder, always `separate: true`), with a fresh
  `readHistory()` guard that asks before re-downloading a recorded title and
  then sends `redownloadIds:[id]`; **Alt**-click focuses `#downloadFormat`
  (the existing form) instead of downloading. **62b (gallery page):**
  `content/titleBookmark.ts` inserts `nhdw-title-save` right after the
  Bookmark button (same presentational-class copy, `nhdw-title-save` added to
  `OWN_UI_CLASSES`, CSS in `css/titleBookmark.css`); primary click sends the
  same one-gallery job with the page's SITE, Alt asks the worker to open the
  panel (`siteUiOpenPanel`, now handled in the Chrome worker too). Label
  locked to **"save offline"** (never matches `DOWNLOAD_TEXT_RE`). Covered by
  `message.test.js` (markup) and `e2e-title-bookmark.js` phase 10 (per-site
  job, Alt route, history guard) in both trees.

- [x] **63. Card controls on all six sites (Select + Bookmark + Download) — done 2026-09-25.**
  Real `utils/listCards.ts` table (one row per site: `mode`, `linkSelector`,
  `linkPattern`, container/title/caption selectors, hitomi's
  `containerAncestorClass`) with `listCardTargetForSite()`, `resolveListCardPage()`
  (adapter-owned URL that is NOT a gallery page) and `cardIdFromHref()`.
  `findCards()` dispatches on `getSourceForUrl(location.href).site` and returns
  `{id, site, title, card}`, so history (`toGalleryKey(id, site)`,
  `partitionKnown(..., site)`), bookmark writes (`site` on `bookmarkAdd`,
  composite key on `bookmarkRemove`) and the download job (`site:`) are all
  site-aware. Manifest: a second `content_scripts` block covers the five
  non-nhentai listing hosts with `content.js` + `listControls.js` +
  `css/content.css`. Per-site e2e discovery phase (all six fixtures) in
  `e2e-list-controls.js`, both trees. **`getGalleries.ts` panel-listing port
  is OUT of scope for 63** (see Blocked note below).

- [x] **64. Select-all + title-page select integration — done 2026-09-25.**
  (a) `#nhdw-select-all` in `buildActionBar()` beside Clear; it selects every
  discovered card, ticks the boxes and refreshes the bar. The bar is now
  visible whenever the page HAS listing cards (`findCards().length > 0`),
  not only once something is selected — that was the item-64a red assert.
  (b) The gallery page's **Select** control (`nhdw-title-select`) writes the
  BARE id into the same `chrome.storage.local.allIds` and repaints on
  `onChanged`. The `allIds` wipe is now **site-scoped** through a new
  `allIdsSite` key (`content.ts` + `preview.ts`): a selection survives
  same-site navigation and is dropped when the user moves to another site's
  namespace — still a transient temp list, never persisted history/bookmarks.
  Invert/Clear in the panel list are unchanged.
  (a) Floating bar gains **Select all / Clear** for linear listings
  (home, search, tag, artist — every page `getGalleries` can see).
  (b) On a **single gallery page**, our Select affordance adds *this* title
  into the same `allIds` selection set used on listings, so card + panel
  agree. Invert/Clear already exist in the panel list — keep them consistent.

- [x] **65. Rename Queue tab → Bookmark tab (UI-only) — DONE 2026-09-26 (3.10.2 / FF 1.4.2).**
  Tab label, pane copy, tooltips, README/handoff user-facing strings.
  Storage key, message actions, and export format **unchanged** (handoff
  Do-not: no store rename). Firefox drawer copy follows (byte-identical
  shared files rule). Red test: `test/tab-labels.test.js` (both trees) —
  it read "Queue" in `index.html` and the old wording in four copy strings
  before the rename, and now also locks the internal names against a
  future "cleanup". Code comments keep their old wording on purpose (they
  describe the concept, and `bookmarkPanel.ts` stays byte-identical).

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
  **Landed 2026-09-26 (3.10.4 / FF 1.4.4)** after the owner's go-ahead:
  `#nhdwBmSiteFilter` in the header, counts as option labels, a "showing X of
  Y" line (hidden for All), a self-explaining filtered-empty note, the choice
  remembered in `chrome.storage.sync.bookmarkSiteFilter` (read on every open;
  corrupt values degrade to All), and filtered Select all/none sending
  `{bookmarkSelect, ids:[visible composite keys]}`. Red-first: 5 new cases in
  `test/bookmark-queue.test.js` + phases 8a–8d in `e2e-bookmark-panel.js`
  (both trees, byte-identical).

- [x] **67. On-page cart — confirmed: badge + expandable mini-cart.**
  Elaboration 1 closed 2026-09-24 (owner chose **B**). Compact count chip
  docked next to our existing Select floating bar (same screen real estate —
  must not stack or occlude; shared positioning rules, fragile);
  click expands into the same drawer contents cin-style (count, compact
  title rows, bulk clear / open manager). Live mirror of the persistent
  bookmark store; text-first, thumbnails only if 69 opts them in for that
  view. Side panel remains the full Bookmark tab. Not floating-drawer (A)
  and not idle-fade hybrid (C).

- [x] **68. Bookmark list load management + already-downloaded marks — DONE 2026-09-26 (3.10.5 / FF 1.4.5).**
  Title search box; filter by tag / artist / date; combined queries. Target
  scale: tens of thousands of rows without jank — windowed rendering or
  equivalent required (cap raise for `MAX_BOOKMARK_ITEMS` is a separate
  owner decision, not implied). **Owner free-text note:** batch download of
  "that list" on Bookmark — with or without search/filter active — must show
  an **already-downloaded** indicator (green checkmark per title for
  simplicity, or group differently) so re-downloads are obvious before you
  run the batch. **Green check only on true success** — never mark a row
  that failed midway as done.
  **Landed 2026-09-26 (3.10.5 / FF 1.4.5), owner-directed best-effort** — no
  spec pass, so the assumed defaults are recorded in `IMPROVEMENT_BACKLOG.md`.
  The list header gained `#nhdwBmSearch` (title, id and tags; every typed word
  must match), `#nhdwBmStatusFilter` (any · not downloaded · ticked · done ·
  failed · downloading) and `#nhdwBmDateFilter` (today · last 7 days · last 30
  days · older), all composing with item 66's site select as **one view** —
  the stored list is never rewritten and the counts line stays whole-list.
  Rendering is windowed: 200 rows (`BOOKMARK_PAGE_SIZE`) plus a full-width
  **Show more (N of M)** control, so the DOM stays small at tens of thousands
  of rows; `MAX_BOOKMARK_ITEMS` was **not** raised (explicitly a separate owner
  decision). The already-downloaded mark is a green ✓ whose tooltip is the
  recorded filename, drawn from the download history by site-aware composite
  key and **never** from `item.status` — a row that merely claims "done" is not
  marked, and a row whose retry failed after an earlier success keeps its mark
  because the artifact is still on disk. A `#nhdwBmHistoryInfo` counter ("N
  already downloaded") sits beside the "showing X of Y" line, and the Download
  button's tooltip says how many of the rows on screen are already on disk
  *before* the batch runs. `bookmarkQueue.ts` learned the optional `tags[]`
  (normalized: strings only, trimmed, deduped) that the search reads. **Select
  all / Select none follow the whole query** (composite keys of every matching
  row; `{all:true}` only when nothing is filtered). Pure helpers in
  `src/utils/bookmarkFilters.ts`. The query is deliberately **not** persisted —
  a forgotten search that hides rows is a nastier surprise than retyping one —
  while the site select keeps its own remembered value.

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

- [x] **70. Live-session auto-fetch (phase 2 of 61) — DONE 2026-09-26 (3.10.5 / FF 1.4.5).**
  Port the twitter-batch-download *ideas* (shallow read of what the tab
  already rendered; MutationObserver harvest so rows aren't lost; run-token
  Stop; optional auto-scroll) onto these six sites' listing/DOM. Infinite
  scroll and "must survive reload" flows live here. Separate spec pass when
  v1 range fetch has real-browser data — **landed best-effort while that data
  is still missing** (owner's call), so the defaults above are the ones to
  re-open if the real-browser pass wants different bounds.
  **Landed 2026-09-26 (3.10.5 / FF 1.4.5), owner-directed best-effort** (the
  spec pass the item asked for is still welcome; the assumed bounds are listed
  in `IMPROVEMENT_BACKLOG.md`). The floating bar gained `#nhdw-harvest`
  (**Harvest** → **Stop harvest**), `#nhdw-harvest-scroll` ("Scroll for me",
  remembered in `chrome.storage.sync.bookmarkHarvestAutoScroll`) and
  `#nhdw-harvest-status` ("N collected", plus "· stopped", "· reached the end
  of the page", "· item limit reached", "· stopped at the scroll limit"). A run
  reads what the tab has already rendered (`findCards()`), dedupes by composite
  key in page order, ticks the cards into the same shared selection the bar
  downloads, and keeps collecting through the existing MutationObserver while
  it is live — so a card an infinite-scroll site renders after the click is not
  lost. Auto-scroll is bounded (700 ms rounds, 40 rounds, 2000 items) and stops
  itself at the page bottom; **Stop** is authoritative through a run token, and
  a stopped run never resumes. The harvest persists to
  `chrome.storage.local.listHarvest` as an **always-inactive** copy and is
  merged back into the selection on the next load — filtered to this page's
  site, by composite key, without duplicates (the merge order is the harvest's
  own, because `allIds` is the download order). Pure core in
  `src/utils/listHarvest.ts`.

- [x] **71. Panel list actions vs on-page Select — DONE 2026-09-26 (3.10.3 / FF 1.4.3).**
  On listing pages where on-page Select + Select-all exist, the panel's
  redundant "Download all (N pages)" multi-page entry is **demoted or
  replaced** by a pointer to the range block (61) + on-page selection.
  Owner intent confirmed; exact UI (hide vs collapse into range block)
  decided when 61+63 are real. Landed as: item 61 had already removed the
  blanket entry, so nothing needed demoting — the list now carries the pointer
  (`#selectionPointer`) and the List-mode hint names the range block. Red-first:
  `test/panel-list-actions.test.js` (2 red) plus 2 assertions in `e2e-popup`'s
  listing phase (`FAIL: the list must point at the shared on-page selection`).
  The same pass verified §E and found the guard-identity defect (2 more red
  tests, fixed) — see the banner and the backlog log.

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

The only unverifiable-here claims left. Chrome: the Bookmark-tab checklist, the
naming-guard probes (0A–0E), list-mode/formats steps and the new PR #48 items
(per-row Cancel mid-batch + retry-after-cancel, late-cancel done guard, real
OPFS streaming on a large gallery). Firefox desktop pass + Android matrix,
then `npm run sign:firefox` (AMO keys via env). **Full step-by-step checklists:
`SESSION_HANDOFF.md` → "Required real-browser verification".** `npm run
test:browser` has never run in any agent sandbox.

  **Added by items 62/63/64 (2026-09-25).** Offline harnesses cover the
  *contract* of the new controls; the real-browser pass still has to confirm:
  (1) card controls + Select all on a REAL listing of each of the five new
  sites (the hitomi row is the only one with no captured sample — verify the
  `.gallery-content` block boundary and the id parse there first);
  (2) a hentaifox/imhentai/hentaienvy/hentaiera/hitomi card **Download** really
  fetches through that site's adapter (job carries `site`); (3) the gallery
  page's **Save offline** button lands in the site's own button row and is
  visually distinct from the site's Download; (4) the panel's **Save offline**
  click (the handler itself is only reachable from a bootstrapped preview, so
  it is NOT covered offline); (5) a selection surviving same-site navigation
  and being dropped across sites (`allIdsSite`).

  **Added by items 68/70 (2026-09-26).** The Bookmark-tab checklist grows:
  type into the search box on a real 1000+-row list (typing stays responsive;
  the window stays 200 rows and **Show more** grows it), confirm the ✓ appears
  only where the file is really on disk (delete one → the mark is gone on the
  next open, while a "done" row with no history record is never marked), and
  that **Select all** under a search downloads exactly the searched rows. On a
  real listing: **Harvest** on a site with infinite scroll (cards appended
  while scrolling are collected exactly once), the **Scroll for me** box's
  remembered state, **Stop** mid-run, and a reload after a harvest (collected
  titles still ticked, nothing duplicated, the run does not restart itself).

### 40. Popup harness does not bootstrap a listing page — DONE 2026-09-26 (test-only)

**Landed.** `scripts/e2e-popup.js` (both trees) now carries the two stubs the
item called for — the panel's `js/getGalleries.js` injection is answered by an
armed listing payload (the content script's role), and `executeInTab` answers
`readGalleryFromTab`'s `_gallery` poll from the tab's own page — plus four
phases that drive the REAL chains instead of hand-delivering messages: a
listing tab URL → bootstrap → injection → listing view (rows, count, range
block), a gallery tab URL → preview from the tab's metadata, the panel's
**Save offline** click → one list-mode job (format/template/folder from the
list-mode keys, `separate: true`, the active tabId, the queued notice), and the
already-downloaded prompt (declining sends nothing; accepting forces exactly
that id). A documented `settleStaleTabRead()` step first lets the item-60 wash
phase's pending tab read finish (~2.8s of five polls) so a late paint cannot
stomp on the assertions. Red evidence is mutation-based (see the banner): the
item adds coverage, so the proof is that breaking the production paths makes
the new phases fail with precise messages.

**Scope note (recorded, not done):** the panel's listing **Download selected**
click, the PDF-merge warning path and the similar-galleries panel are still
only covered by the content-script harnesses; the two stubs above are the
capability they need, so each is now a small follow-up rather than "a real
piece of work".

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
      or gallery+reader **and listing-page** HTML and 3 image URLs — the
      listing sample is required since item 63), then implement against
      `ADAPTER_WIRING_PLAN.md` §1/§3/§4/§6.
- [ ] **Cross-mirror fallback chains** from the owner's live-testing note
      (throttle-route imhentai↔hentaienvy via the shared `/033/<token>/` store
      by host swap — never by id; hentaiera→hentaienvy→imhentai and
      hentaiera-first chains by title match): deliberately deferred (owner's
      2026-09-15 call: one site at a time, no cross-mirror fallback yet).
      Recorded in `MULTISITE_V4_PLAN.md` §2.2 so it is not re-derived.

---

## Done (one line each — details in `IMPROVEMENT_BACKLOG.md` session logs)

- **Item 40 — the popup harness bootstraps a listing page (2026-09-26):** the
  two missing stubs (`js/getGalleries.js` injection answered, `executeInTab`
  answering the `_gallery` poll) plus phases 11a–11d / 15a–15d, which drive the
  listing bootstrap, the gallery preview from the tab, the panel's **Save
  offline** job payload and the already-downloaded prompt — the handler that
  had no offline coverage. Test-only: no version bump, no release re-sync.
  Proof is mutation-based (four mutations, both trees). Chrome 601 / FF 634
  unit, e2e exit 0 (+4 phases each), FF lint unchanged (32 warnings).

- **Item 66 — Bookmark-tab per-site filter (2026-09-26):** one permanent
  `<select>` in the list header (`#nhdwBmSiteFilter`): All sites | nhentai |
  hitomi | hentaiera | imhentai | hentaienvy | hentaifox, live counts in the
  labels, remembered in `chrome.storage.sync` and restored on every open. The
  filter is a **view** — the stored list and the `N bookmarked · N selected ·
  N done` line stay whole, with "showing X of Y" beside the select — and
  filtered Select all/none send the visible rows' **composite keys**
  (`{bookmarkSelect, ids:[…]}`) rather than `{all:true}`, so off-screen rows
  are never ticked. New helpers in `bookmarkQueue.ts` (canonical site list,
  counts, filter, tolerant normalizer, selection keys). Red-first: 5 unit
  cases + 4 harness phases; Chrome 601 / FF 634 unit, e2e green, FF lint
  unchanged (32 warnings), release re-synced. Chrome 3.10.4 / FF 1.4.4.

- **Item 71 — panel list actions vs on-page Select (2026-09-26):** the blanket
  entry was already retired by item 61, so the list now points at what replaced
  it (`#selectionPointer`: rows and cards are one selection, other pages via
  the range block) and the List-mode hint names the range block. Guard fix
  found while verifying §E: a recorded **bare** id is the default site's
  record, never the job's — before it, a legacy nhentai record could mask a
  same-numbered gallery on another site and skip the download. New coverage:
  `test/panel-list-actions.test.js`, 2 `e2e-popup` phase-10 assertions, 2
  `batch-pipeline` cases. Chrome 3.10.3 / FF 1.4.3, 596/629 unit, e2e green,
  FF lint unchanged.

- **Item 65 — Queue tab → Bookmark tab (2026-09-26):** the panel's third tab is
  labelled **Bookmark**; the card tooltip, the auto-capture hint, the
  side-panel launcher, the no-side-panel fallback notice and both bookmark
  tooltips follow. UI-only: `bookmarkQueue`, `#tabQueue` / `#queuePane`,
  message actions and the export format untouched. New
  `test/tab-labels.test.js` in both trees (red before the rename: the tab read
  "Queue" and four copy strings said "Queue"); Chrome 591 / FF 624 unit, e2e
  green both trees, FF lint unchanged. Chrome 3.10.2 / FF 1.4.2.

- **PR #50 review pass (2026-09-26):** three defects in the merged 3.10.0 work,
  each fixed under a test that failed on the pre-fix build — the listing-only
  guard is now the production path in `findCards()` (gallery/reader pages
  decorate nothing, bar hidden there); the bar's `allIdsSite` read requests the
  key (a foreign selection can no longer appear selected); the legacy nhentai
  caption checkbox is gated to nhentai. New `e2e-list-controls` phases
  (gallery page, foreign site) + an `e2e-content` hentaifox phase, both trees;
  Chrome 3.10.1 / FF 1.4.1.

- **62/63/64 — per-site card controls, Smart Download, Select all (2026-09-25,
  this session):** real `listCards.ts` per-site selector table + site-aware
  `findCards`/history/bookmark/job identity; listing-host `content_scripts`
  block for the five non-nhentai sites; **Save offline** in the panel preview
  and beside every gallery page's Bookmark (Alt = open the existing form);
  **Select all** in the floating bar with the bar visible whenever cards
  exist; gallery-page **Select** feeding the shared `allIds`, now wiped per
  site (`allIdsSite`). Chrome 587 / FF 620 unit, all offline e2e green
  (`e2e-list-controls` +27 PASS, `e2e-title-bookmark` 146 → 263 checks).

- **Item 59 ported from Firefox into Chrome (2026-09-25, review finding):**
  `listSettings.readListSettings()`, `options.ts`, `popupSettings.ts` and
  `listControls.ts` now request the optional `listFormat` key explicitly, so a
  saved list format is honoured instead of silently inheriting the single-title
  one. The Chrome unit fixture was a whole-store merge mock (it returned
  unrequested keys) — that is what hid the defect; replaced with the shared
  key-scoped `scripts/test-support/storage.js` + 36-case matrix, both trees.

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
