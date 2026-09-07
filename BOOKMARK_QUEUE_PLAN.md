# Bookmark queue — design and approach

**Status:** plan approved by the user's 2026-09-07 request; Phase 1 implemented on
branch `arena/01a07d48-nh-dw-2-0`.
**Sibling implementation studied:** `freeforall1932-design/twitter-batch-download`
(v3.15.0), whose Side Panel queue this borrows its shape from.

---

## 1. What the user asked for, restated

Six requirements, in the user's own order:

| # | Requirement | In one line |
|---|---|---|
| 1 | **Manual bookmark** | A button I click on a gallery card, like the Twitter repo's queue list, but a *bookmark* rather than an auto-collected queue. |
| 2 | **Thumbnail UI** | The row shows the cover thumbnail and the title taken from the card on the website. |
| 3 | **Taskbar-like dock** | The list can be minimised to a small bar and expanded again, with a button for it. |
| 4 | **Survives restart** | Close the browser, restart the PC, reopen the browser → the bookmarked list is exactly what I clicked. (nhentai's own favourites are account/tag oriented, not this.) |
| 5 | **Batch by ID** | A paste box accepting gallery IDs *or* links — single or batch — because the popup cannot host this comfortably. Auto-fetch and manual click both feed the same list. |
| 6 | **Download from the list** | Bookmarks download as a batch, or one at a time, or in a chosen order. |

Reference UI the user pointed at: `https://cin.lat/bulk?id=366224,177013` — paste IDs,
each row shows title + page count + a Download button. The user explicitly does **not**
want the "View Online"/read button that site has.

---

## 2. What already exists (verified in this checkout, v3.6.4)

Checked, not assumed:

* `NHDW_Extension_v3.0.0/manifest.json` already declares `"side_panel": { "default_path":
  "index.html" }` and the `sidePanel` permission.
* `src/background/background.ts:71` sets `const UI_MODE_DEFAULT = "sidepanel"`, applied
  through `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick })` plus
  `chrome.action.setPopup({ popup: useSidePanel ? "" : "index.html" })`.
  `src/options/options.ts:56` and `src/preview/popupSettings.ts:551` both default
  `uiMode: "sidepanel"`.
* `src/preview/preview.ts` renders **one document** (`index.html`) for both the popup and
  the panel, re-bootstrapping on `tabs.onActivated` / `tabs.onUpdated` so the panel
  follows the active tab.
* `src/content/listControls.ts` already injects a per-card Download button + Select box
  with an idempotent `MutationObserver`, and shares selection through
  `chrome.storage.local["allIds"]`.
* `src/utils/downloadHistory.ts` already keeps a persistent, id-keyed
  `chrome.storage.local["downloadHistory"]` record and `partitionKnown()` splits
  candidates into download/skip.
* `src/utils/batchPipeline.ts` `runBatchDownload` walks galleries **sequentially**
  (`for (let i = 0; i < length; i++)` at line 340, `await host.downloadGallery(...)` at
  line 400). `maxConcurrentDownloads` is *page*-level concurrency inside one gallery,
  not gallery-level.
* The download *job* queue lives in the **offscreen document** (`queuedJobs`,
  `src/offscreen/offscreen.ts:63`) and is surfaced only as a count. `IMPROVEMENT_BACKLOG.md:860`
  records this as the structural blocker for the long-planned "P3 queue UI".

### Correction to one premise in the request

The request said the toolbar click here "is still pop up first instead of queue
sidebar/side panel". **That is not the case in this repo** — the side panel has been the
shipping default since 3.4.0 (`UI_MODE_DEFAULT = "sidepanel"`, quoted above). What *is*
true, and is the real gap: the panel is not a queue surface at all. It renders the same
Download/Settings document in both modes, and the only queue is the offscreen job list
surfaced as a number. So the instinct was right; the detail about which surface opens
first was not.

---

## 3. The popup-vs-side-panel question, answered

**Recommendation: dual use, one document, with the side panel as the queue's real home.**

Reasoning:

1. A bookmark queue that must survive a browser restart is *storage*, not a window. Both
   surfaces read the same `chrome.storage.local` record, so neither can lose data. The
   popup closing on blur costs nothing.
2. But a queue you want to *watch* — rows ticking from `saved` to `downloading` to `done`
   — needs a surface that stays open while you browse. That is the side panel. The popup
   is destroyed on blur, so progress there is only ever a snapshot.
3. There is no second markup to maintain: `index.html` is already both. Adding a third tab
   gives the popup the feature for free instead of creating a panel-only code path.
4. The user's "advanced feature button" idea is implementable and is kept: Settings gains
   **Open the dockable Queue panel**, which calls `chrome.sidePanel.open()` (Chrome 116+,
   requires a user gesture — a button click qualifies). In popup mode that is the escape
   hatch to the persistent surface; in panel mode it is a no-op that says so.

So: `Download | Queue | Settings`, identical in both modes, plus the Settings button.

Rejected alternative — panel-only: it would strand popup-mode users (older Chromium, and
the Firefox port where `chrome.sidePanel` does not exist) with no way to reach the feature
at all.

---

## 4. Architecture

### 4.1 Two lists, deliberately separate

The mistake to avoid is merging the bookmark list into the download job queue.

| | Bookmark queue (new) | Download job queue (existing) |
|---|---|---|
| Meaning | *intent* — titles I want | *work* — titles being fetched |
| Owner | service worker (single writer) | offscreen document |
| Storage | `chrome.storage.local["bookmarkQueue"]` | memory only (`queuedJobs`) |
| Lifetime | until the user removes it | until the job ends |
| Survives restart | **yes** | no |

A bookmark row *feeds* the existing `downloadAllDoujinshis` pipeline; it never replaces
it. That reuses the whole verified download path — formats, master folder, name template,
history skip, failure naming, retry — instead of re-implementing it.

### 4.2 Data model

```ts
interface BookmarkItem {
    id: string;          // gallery id — the only identity that matters
    title: string;       // best title known at add time (may be "" for a pasted id)
    thumbnail: string;   // absolute cover-thumb URL, "" when unknown
    pages: number;       // 0 when unknown
    source: "card" | "page" | "paste" | "similar" | "auto";
    sourceUrl: string;   // listing page it came from, "" for paste
    addedAt: number;
    selected: boolean;
    status: "saved" | "downloading" | "done" | "failed";
    error: string;
    filename: string;    // filled from downloadHistory once done
}
```

Storage shape: `{ v: 1, items: BookmarkItem[], collapsed: boolean }` under
`chrome.storage.local["bookmarkQueue"]`.

Why `storage.local` and not `storage.sync`: this is requirement 4. `sync` is capped at
~100 KB / 512 items and a queue of thumbnails and titles would blow that; `local` is what
`downloadHistory` already uses for the same reason (`src/utils/downloadHistory.ts`,
header comment). `collapsed` is stored too so the dock reopens the way you left it.

Why the worker is the single writer: the content script and the panel both mutate the
list. Two independent read-modify-write owners would clobber each other. Every mutation
goes through a worker message, exactly like `queueAdd`/`queueGet` in the Twitter repo's
`background.js`.

### 4.3 Restart reconciliation (requirement 4)

On worker wake (`onStartup`, `onInstalled`, and lazily on the first `bookmarkGet`):

* `downloading` → `saved`. The offscreen document is gone; nothing is actually running.
  The row goes back to being actionable instead of being stuck forever. This mirrors
  `reconcileQueueAfterRestart()` in the Twitter repo, which returns `starting` items to
  `queued` for the same reason.
* `done` is re-checked against `downloadHistory`. If the history record is gone (user
  cleared history), the row drops back to `saved` so it is not shown as finished when the
  extension no longer believes it is.
* `failed` keeps its error text — it is the useful part.
* Everything else (order, selection, thumbnails, collapsed state) is untouched: the list
  comes back "exactly what you clicked".

### 4.4 Capture paths (requirement 1 + the auto-fetch option)

| Path | Trigger | Thumbnail source |
|---|---|---|
| Manual, listing card | new ☆ button on each card | the card's own cover `<img>` — `data-src` (nhentai lazyloads) falling back to `src` |
| Manual, single title | ☆ Bookmark this title in the panel preview | derived from resolved `media_id` |
| Paste | textarea in the Queue tab | none at add time; filled by enrichment (§4.5) |
| Similar galleries | ☆ on a row of the existing similar list | derived from `media_id` |
| **Auto-capture** | toggle in Settings, default **off** | same as the manual card path |

Auto-capture default off, on purpose: on a 60-card search page it would silently build a
60-item list the user never asked for. It is one click to turn on, and it reuses the
existing `MutationObserver` in `listControls.ts`, so infinite scroll and pagination are
already handled.

### 4.5 Paste parsing (requirement 5)

`parseGalleryInput(text)` accepts, mixed freely, separated by commas, spaces, newlines,
semicolons or `|`:

* bare ids — `366224`, `177013`
* nhentai gallery urls — `https://nhentai.net/g/366224/`, `/g/366224/1/`
* the reference site's urls — `https://cin.lat/v/366224`
* ranges — `366220-366224`
* the reference site's whole query string — `?id=366224,177013`

Rules: ids are digits only; duplicates collapse keeping the order first typed; a range
is capped (`MAX_PASTE_RANGE`, 200 ids) and the whole paste is capped (`MAX_PASTE_IDS`,
500) so a typo like `1-999999` cannot build a monster list; tokens that cannot be read
are returned in `rejected` so the UI can name them instead of silently dropping them;
and the parse is **pure** so it is unit-tested without a browser.

Two buttons over the same box, because the user asked for both:

* **Add to queue** — parse, bookmark, resolve titles/thumbnails in the background.
* **Download now** — parse and download immediately, without bookmarking. One id = single
  download; several = the existing batch pipeline, one file per title.

### 4.6 Enrichment

A pasted id has no title and no thumbnail. The worker resolves it through the *same*
routes the rest of the extension uses, in this order (no new network behaviour):

1. the user's open nhentai tab (`fetchGalleryViaTab`, `src/preview/activeTabGallery.ts:294`) —
   the Cloudflare-safe route the popup already depends on;
2. the API v2 endpoint with the stored key when API-key mode is on (`src/utils/apiAuth.ts`).

From the resolved gallery: `title`, `num_pages`, and a thumbnail built as
`https://t.nhentai.net/galleries/<media_id>/thumb.<ext>` from the cover's type code. A
failed enrichment leaves the row with its id visible — an unresolved row is still
downloadable, it just has no pretty title yet.

Note on hosts: `t.nhentai.net` is **not** in `host_permissions`, and it does not need to
be. An `<img>` in an extension page is an ordinary image request, not a `fetch`, so no
host permission and no CORS preflight are involved. This is display-only; no thumbnail is
ever routed through the download path (which is explicitly thumbnail-avoiding — see
`IMPROVEMENT_BACKLOG.md:127`).

### 4.7 Downloading from the list (requirement 6)

Three modes, all reusing `downloadAllDoujinshis`:

* **One at a time** — each row's Download button sends a single-entry map. Identical to
  the existing per-card Download in `listControls.ts`.
* **Batch** — *Download selected (N)* sends every selected id in one job,
  `separate: true`, so it is one file per title named from the list-mode template. The
  pipeline is already sequential per gallery (`runBatchDownload`, §2), which is what
  "sequentially" means here.
* **Order** — rows are downloaded in list order, and the list can be reordered, so
  "download these three first" is a drag/handle concern, not a pipeline change.

Settings are **not** duplicated: format, output mode, master folder and name template all
come from the existing list-mode settings (`src/utils/listSettings.ts`), so the queue and
the in-page floating bar cannot disagree.

Status feedback: rows move `saved → downloading → done | failed` from the worker's
existing `batchSummary` / `downloadError` broadcasts, which already carry
`failedGalleries[]` with id + name + reason (v3.6.0). `done` also picks up the recorded
filename from `downloadHistory`, so the row can show what was saved.

### 4.8 The dock (requirement 3)

A `collapsed` flag in the same storage record. Collapsed, the Queue tab renders one bar:
`★ 12 bookmarked · 3 selected — [Download] [Expand]`. Expanded, the full list. The flag
survives restart with the list. This is the "small taskbar like function" the request
described — implemented as a collapsed header, not a floating window, because a second
floating element over nhentai would collide with the existing action bar in
`css/content.css`.

---

## 5. Phasing

**Phase 1 — landed on this branch.**
Pure core (`src/utils/bookmarkQueue.ts`), worker message handlers
(`src/background/bookmarkService.ts`), the ☆ capture button on listing cards with
auto-capture behind a Settings toggle, the Queue tab with thumbnails / dock / paste box /
per-row and batch download, title-and-cover enrichment for pasted ids, the Settings
"Open the dockable Queue panel" button, and tests. Not landed: drag-reorder, and ☆ on the
single-title preview and similar-gallery rows.

**Phase 2 — next.**
* ☆ on the single-title preview and on similar-gallery rows (the worker side is ready;
  only the two render sites are missing).
* Drag-reorder + "download in this order" — the plan already follows list order, so this
  is purely a list-manipulation affordance.
* Per-row cancel of an in-flight job.

**Phase 3 — later.**
* Port to `NHDW_Firefox_v1.0.0` (`sidebar_action`, no `chrome.sidePanel`).
* Per-item cancel while a job is running — needs the offscreen queue mirrored into
  `chrome.storage.session`, the structural work `IMPROVEMENT_BACKLOG.md:860` describes.
  Deliberately out of Phase 1: bookmark rows are intent, and the download job they spawn
  is still governed by the existing pause/clear controls.

---

## 6. Explicit non-goals

* **Not** a re-implementation of the download pipeline. One download code path exists and
  keeps existing.
* **Not** a sync of nhentai's own account favourites. This list is local to the browser
  profile, like `downloadHistory`.
* **Not** a replacement for the in-page Download/Select buttons. Those stay; the bookmark
  list is additive.
* **Not** thumbnails in the download path. Display only (§4.6).
* **Not** an auto-capture-on-by-default behaviour.

---

## 7. Verification

What was actually run on this branch, in `NHDW_Extension_v3.0.0`:

| Command | Result |
|---|---|
| `npm test` | **361 passing, 4 pending** (baseline before this work was 310 passing / 4 pending — the 51 new cases are `test/bookmark-queue.test.js`) |
| `npm run build` | webpack compiled successfully; `js/background.js`, `js/preview.js` and `js/listControls.js` all re-emitted with the new modules bundled |
| `npm run test:smoke` | worker **and** offscreen bundles both load clean as MV3 documents, still registering no global `onDeterminingFilename` listener |
| `npm run test:e2e` | 115 PASS, 0 FAIL across worker / offscreen / relay / content / list-controls / popup |

What each layer actually executes:

* **Unit** (`test/bookmark-queue.test.js`, 51 cases) runs the compiled
  `build/test/utils/bookmarkQueue.js` — `parseGalleryInput`, `normalizeBookmarkState`,
  `addBookmarks`, `patchBookmark`, `reconcileBookmarksAfterRestart`,
  `thumbnailUrlFromGallery`, `planBookmarkDownload`, and the `chrome.storage.local`
  contract including two overlapping `mutateBookmarks` calls fired together.
* **Worker e2e** (`scripts/e2e-worker.js`, new phase 13a–13h) loads the real built
  `js/background.js` in a VM and drives the actual message handlers: `bookmarkAdd`
  persisting to the stubbed `chrome.storage.local`, duplicate-id no-op,
  `bookmarkSelect` / `bookmarkCollapse` / `bookmarkRemove`, `jobFinished` settling a row
  to `done` with its filename, `batchSummary` landing a failure reason on its row, and
  `bookmarkChanged` broadcasts.
  * **13f is the restart requirement**: a row is forced to `downloading` in storage, the
    bundle is re-run in the same realm (a fresh service-worker instance reading the same
    `chrome.storage.local`), and `bookmarkGet` must return it as `saved` while a
    history-backed `done` row stays `done` and the dock stays collapsed. That passed.
* **Content-script e2e** (`scripts/e2e-list-controls.js`, 6 new checks) asserts the ☆ is
  injected on every card, that clicking it sends `bookmarkAdd` carrying the card's own
  `data-src` cover (not the placeholder) and the caption's page count, that a second click
  sends `bookmarkRemove`, that auto-capture is off by default and bookmarks all three
  cards with `source: "auto"` when switched on, and that a stored list comes back as
  filled stars.

Two defects the tests caught while being written, both fixed:

1. `markBookmarksDownloading` answered `bookmarkMarkDownloading` from a state read that
   could run before the mutation settled; it now awaits the write.
2. Phase 13d/13e initially sent `jobFinished` / `batchSummary` without `from: "offscreen"`
   and timed out — those branches live in `handleOffscreenMessage`
   (`src/background/background.ts:944`), so the test now sends the shape the real
   offscreen document sends.

**Still owes a real-browser pass** (as every prior release in `SESSION_HANDOFF.md` does —
`npm run test:browser` has never run in this environment):

* Restart persistence observed in an actual Chrome profile, not a VM.
* The dock collapse/expand, and thumbnails actually painting from `t.nhentai.net`.
* Paste `366224,177013` → **Download now**, and confirm both files land.
* `chrome.sidePanel.open()` from the Settings button (Chrome 116+).
