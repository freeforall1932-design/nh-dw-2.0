# Offline index + library tab plan

**Recorded:** 2026-11-26 (session `arena/1af576b7-nh-dw-2-0`, branched from `f5be2ec`).
**Status:** **Phase 1, Phase 2 and Phase 3 landed** (same session): Phase 1 —
`library.html` rail + importer + dummy-data mode (23 tests); Phase 2 —
`tools/indexer/` API v2 walker (Route A, resumable, offline-checked, 11
checks incl. a round-trip through the real importer), `.gitignore` for index
outputs; Phase 3 — send-to-queue (chunked, §8.9), visited log (IndexedDB),
`unlimitedStorage` (§8.1), 911 Chrome suite green. **Phase 3b (deferred):
the OPFS thumb cache** — the LRU-capped background cache of §8.8; Browse
today renders thumbs live via plain `<img>` with the offline placeholder
fallback, which needs no permissions. Phases 4–6 not started. This doc
captures the design agreed in discussion so a future session does not
re-derive it.

The idea in one line: **an offline, tag-first index of titles that filters
instantly with no site round-trips, browsed in a full extension tab
(`library.html`), feeding selected titles into the queue the extension already
runs.** The heavy management views move into that tab; the side panel stays a
lean "what is happening right now" surface for browsing on supported sites.

## 1. Decision record

| Decision | Call | Why |
| --- | --- | --- |
| Separate repo for the indexer? | **No — same repo.** | The extension stays the download engine. Every per-site quirk (hitomi `gg.js` math, imhentai `/033/<token>/` paths, hentaifox `g_th` codes, cin.* URL-shape matching) already lives in `src/sources`. A second repo means fixing every site markup/domain change twice, in lockstep, forever. A standalone Hitomi-Downloader-style app without APIs would re-solve all of it. |
| Save all thumbnails in the index? | **No — thumb URLs, not thumbs.** | Covers are ~20–30 KB each → 10–20 GB for a full catalog and days of crawling. Thumb URLs are derivable from `media_id` (+ a small hash field for hitomi) that the metadata rows already carry: ~0 bytes extra. Thumbs load lazily while browsing; slices actually browsed get cached into OPFS. |
| Save all tags per title? | **Yes, but as tag ids.** | One tag dictionary for the whole catalog (few MB), each title stores 6–10 numeric tag ids (~15–30 bytes). A full nhentai-class catalog is **~50–100 MB compressed** for metadata+tags, filterable in memory in milliseconds. |
| Where does browsing/filtering live? | **`library.html` — a new extension dashboard tab.** | Same pattern as `chapters.html` (`chrome.tabs.create({ url: chrome.runtime.getURL(...) })`, webpack entry exists for chapters already). Full-tab width for grid browsing, tag-chip sidebar, dense list view. Same `chrome-extension://` origin → same storage, same OPFS cache, same background worker. No new data model. |
| What happens to the panel? | **Slimmed to a "now" surface.** | See §4. Panel = current queue progress + quick actions on the active site. Bulk/management views move to the library tab. |
| Generated index files in Git? | **No.** | Add `*.index.jsonl.gz` (or equivalent) to `.gitignore`, same convention as the capture zips. |
| Steal Mihon's layout for the tab? | **Yes — navigation rail, five sections.** | Mihon (Tachiyomi fork) proves the model: Library / History / Browse / More. Desktop tab → left rail instead of bottom bar. See §5. |
| Custom data-root & download-location settings possible? | **Yes — no NTFS junction needed.** | File System Access API works in extension tab pages (data root), `chrome.downloads` `saveAs:false` bypasses the save prompt, and the FS Access folder handle becomes the final write target for archives. Firefox keeps OPFS + default downloads. See §7. |

## 2. Index format (three tiers)

One versioned export file per source, gzipped JSONL, first line is a header:

```json
{"_meta":{"schema":1,"site":"nhentai","exported":"2026-11-26","count":512345,"tagCount":48211}}
```

**Tier 1 — tag dictionary** (rows with `_t:1`):

```json
{"_t":1,"id":17,"ns":"tag","n":"full group","c":98123}
```

`ns` ∈ `tag | artist | group | character | parody | language`. `c` is the
count, maintained at export time so the sidebar shows counts without scanning
rows.

**Tier 2 — gallery rows** (compact arrays, one per title):

```json
["366220","m123456","(C99) [Artist] Title [English]",58,1672531200,[17,2017,399,1223,4],"jpg"]
```

Positional: `[id, media_id, title, pages, uploaded_unix, tag_ids[], thumb_ext?]`.
Arrays over objects keeps the whole catalog at the 50–100 MB scale. The
importer knows the layout from `schema`; a missing `thumb_ext` falls back to
trying `jpg`.

**Tier 3 — thumbnails.** Never in the export. Derived per source from
`media_id` / hash fields the row already carries (nhentai:
`t.nhentai.net/galleries/<media_id>/thumb.<ext>`; hitomi needs its stored
imagehash field). Rendered via `<img>` straight from the CDN while online;
fetched through the background (session/Referer handling already there) into
an **OPFS thumb cache** for anything browsed, bookmarked or downloaded. Note:
`host_permissions` needs the thumb hosts (`t*.nhentai.net` etc.) added for the
background fetch path.

**Filtering model:** at import, build an in-memory inverted index
`Map<tagId, Set<rowIndex>>` once (~800k int entries for a full catalog ≈ tens
of MB — fine). Clicking `vanilla` then `english` is a set intersection —
instant, no lag, fully offline.

**Merge policy on re-import:** union, local wins, never deletes — same
policy as the Item 52 backup import. Each row keyed `site:id`. A newer export
of the same site replaces that site's rows wholesale (per-source snapshot) but
never touches other sources or the OPFS thumb cache.

## 3. Where the index comes from

**Decision (Phase 2): Route A, over the documented API v2.** The repo already
carries the project's own API reference
(`old deprecated source code/NHENTAI_API_V2.md`): `GET /api/v2/galleries`
(newest-first, `per_page` ≤ 100), `GET /api/v2/galleries/tagged`
(`sort=date` — the §6 watch shape), `GET /api/v2/search`,
`GET /api/v2/tags/{type}` for the tier-1 dictionary, and
`Authorization: Key <key>` as the only third-party auth. Keyed listings are
30/min, anon 15/min — the client derives its spacing from those numbers and
a 429 stops the run for a clean resume (house rule: throttling is never
retried or bypassed). A Cloudflare challenge body also stops with words.
Shipped as `tools/indexer/` (see its README); offline-checked by
`tools/indexer/test-crawl.js`, which round-trips the produced file through
the real importer when the extension test build exists.

- **Route A — `tools/indexer/` Node crawler — CHOSEN.** Matches the existing
  `tools/` convention; resumable state per page; emits the §2 file; testable
  fully offline with a fake fetch.
- **Route B — extension-driven harvest walk — deferred.** Still the fallback
  if the API rots or a future source has no API: harvest listing cards
  through the user's own tab session into the same §2 format. Decide per
  source when needed.
- Existing index dumps: the Phase 1 importer already accepts the §2 format;
  a converter for a foreign dump is a standalone `tools/indexer/` script if
  one is ever needed.

## 4. Panel slim-down: what moves, what stays

Principle: **panel = "now"** (what is downloading, what is on the current
page), **library tab = "everything, wide"** (any list you scroll, filter, or
bulk-operate on).

| Feature | Today | After |
| --- | --- | --- |
| Queue: current job, progress, speed, fail count, per-row cancel (Item 45) | Panel | **Stays in panel**, compact |
| Queue: full list, drag-reorder (Item 44), bulk ops | Panel | **Moves to library tab** |
| Bookmark manager: search, state/date filters, re-download marks, 200-row window | Panel | **Moves to library tab**; panel keeps a count + quick add |
| Download history browser | Panel | **Moves to library tab** |
| Export/Import backups (Item 52) | Panel/options | **Moves to library tab** (settings section) |
| Paste-anything box | Panel | **Both** — small in panel, full/bulk in library |
| Index browse: tag chips, grid/list, filter, size preview, send-to-queue | — | **Library tab only** |
| Save offline / preview / Bookmark on the current page | Panel + on-page | **Stays** (site-context actions) |
| Harvest / Select all floating bar | On-page | **Stays** (unchanged) |
| Chapters ↗ tool | Own tab | **Stays** (already a tab) |

Migration rule: **extract shared renderers first** (row/card components,
format+template logic) into modules both surfaces import, so panel and
library never diverge. The panel must stay standalone-useful — someone
mid-browse should never need to open a tab just to see download progress.

## 5. `library.html` layout — Mihon-style

Navigation model taken from Mihon: one persistent **left navigation rail**,
each entry a named full-width section. Desktop tab, so a rail replaces
Mihon's bottom bar.

| Rail entry | Mihon equivalent | Contents |
| --- | --- | --- |
| **Browse** (index) | Browse/Explore | Tag-chip filter over the imported index: grid ⇄ list, source dropdown, sort, size preview, send-to-queue. Dummy-data mode until a real import exists. |
| **Bookmarks** (favorites) | Library | The bookmark manager moved out of the panel (§4): search, state/date filters, re-download marks. Category tabs like Mihon's Library come later if wanted. |
| **History** (read/visited) | History | **New visited-log**: the content scripts already run on gallery pages, so recording "opened this gallery on <date>" is one storage write per visit. Merged with the download history into one list: last-visited date, ✓ downloaded badge, one-click "bookmark" and "add to watch" (§6). |
| **Queue** | Updates | Live progress (compact version also stays in the panel, §4) plus the full list, drag-reorder, retry failed, bulk ops. |
| **Settings** | More | Storage root, download behavior, watches management, index import, Export/Import backups (Item 52). |

Per-row details stay as sketched: grid = cover cards with tag chips; list =
dense rows with thumbnail beside title (the "compact or listing" ask);
select checkbox, ✓ downloaded badge, bookmark state; bottom action bar on
selection with size preview → **Send to queue** (Item 48 splits mixed
sources); virtualized rendering (200-row window + Show more fallback,
IntersectionObserver window target for six-figure counts).

## 6. Watches — saved tag combinations with sequential refresh

A **watch** is a saved tag combination the user always wants scanned, e.g.
`vanilla + english`, optionally scoped per source. Managed in Settings,
surfaced above the Browse sidebar.

- **Refresh per watch, and Refresh all:** walks sources **in sequence — one
  source at a time, one page at a time, with the existing cooldowns** — never
  parallel, so no lag and no rate-limit pile-up.
- **Cheap by construction:** listings are reverse-chronological, so refresh
  crawls a source's tag listing only until it hits ids already in the index,
  then stops and moves to the next source. Only genuinely new titles are
  fetched, merged into the index (union, local wins, §2).
- New rows get a **"new since last refresh" badge** in Browse, cleared when
  the section is viewed.
- Optional later toggle: auto-scan on `chrome.alarms` (e.g. daily) using the
  same sequential engine.
- This also de-risks §3: watches keep the index fresh once it exists; a
  one-time deep crawl (Route A or B) still fills the initial gap.

## 7. Storage location & download destination settings

Three settings; all feasible, so **the junction fallback is plan B only**:

1. **Data root** — where index imports, the thumb cache, the visited-log and
   working files live. Default: extension OPFS, zero prompts. Optional: a
   user-picked real folder via the **File System Access API**
   (`showDirectoryPicker()` works in extension tab pages — they are secure
   contexts). The directory handle is stored in IndexedDB; Chrome 122+ keeps
   the grant persistent across sessions, with a manual re-grant button as
   fallback. This gives "store my data on D:" without junction tricks.
   Plan B stays documented: `mklink /J` on the extension's storage folder
   works but is fragile (path contains the extension ID, breaks on
   reinstall).
2. **Bypass "ask where to save"** — `chrome.downloads.download({ saveAs:
   false })` suppresses the per-download prompt, overriding Chrome's global
   ask-every-time preference. This is a settings toggle around existing
   calls, not new plumbing.
3. **Download root override** — `chrome.downloads` cannot leave Chrome's
   default download folder (filenames are relative to it, `..` is rejected).
   But the FS Access folder handle from (1) can be the **final write
   target**: archives stream through the existing OPFS pipeline, then are
   written straight into the chosen folder with the subfolder template
   preserved. Setting offers: Chrome default (subfolder template) / chosen
   folder / ask each time.

**Firefox caveat:** the File System Access API is Chromium-only. Firefox
builds keep OPFS + the default download folder, and for them the junction
note becomes plan A.

## 8. Oversight audit (2026-11-26 review)

Traps found by pressure-testing the plan against the codebase. Each is folded
into the phase where it belongs.

1. **`chrome.storage.local` has a ~10 MB cap, and the manifest has no
   `unlimitedStorage`.** Verified: bookmark queue and download history
   (`bookmarkQueue.ts`, `downloadHistory.ts`) live in `chrome.storage.local`.
   Today's data fits; a six-figure index or visited log does not. Index and
   visited log go to OPFS/IndexedDB from day one; add the `unlimitedStorage`
   permission (no new install warning) for queue/history headroom.
2. **Unpacked installs lose extension-scoped storage on folder changes.** A
   new unpacked folder → new extension ID → OPFS and `chrome.storage.local`
   wiped. The README already warns about ID changes for backups — the same
   hazard kills the thumb cache and any OPFS-stored index. The FS Access data
   root (§7) is therefore **data-loss protection, not a convenience**: land it
   early, and extend the Item 52 backup to cover watches and the visited log
   (folder handles themselves cannot be exported; expect a one-click re-grant
   after import).
3. **Deleted galleries are invisible to a union-only index.** Sites purge
   titles; a union merge keeps dead rows forever. Add a `dead` flag set when
   a download 404s, surface "dead on source" in Browse, and route dead titles
   through the existing `mirrorFallback.ts` before giving up.
4. **Watch early-stop assumes newest-first listings — pin that.** Refresh
   must always use each site's newest-first tag URL (§6); a popular or
   alphabetical listing would stop on the first known id and find nothing
   new.
5. **Pagination depth caps can break both watches and the initial crawl.**
   Community scrapers report nhentai refusing tag/search pages beyond ~25 on
   the HTML site (still unverified live from this sandbox). Phase 2's answer
   is runtime, not folklore: the API walker treats a 404 past page 1 as the
   cap — it keeps what it has, marks the job capped, and points at `--query`
   date-range slicing for deeper fills. Watches are unaffected: they
   early-stop on the first known id long before any cap.
6. **`chrome.alarms` auto-refresh is not Cloudflare-safe.** A background
   fetch with no open tab has no session; expect challenge pages. Watches
   therefore refresh **opportunistically**: through the user's open tab of
   that source when present, else deferred until the next visit. Manual
   Refresh-all while browsing stays the primary path; the alarms toggle is
   best-effort by design.
7. **Memory discipline for six-figure rows.** Rows stay compact arrays
   end-to-end; never re-hydrate into per-row JS objects (hundreds of MB at
   500k rows). Titles decode lazily for the visible window only. Plan B if
   filter performance or memory disappoints: SQLite-WASM over OPFS instead
   of the inverted-index map.
8. **Thumb cache needs eviction.** Browsing big slices accumulates OPFS
   thumbs without bound before a data root exists. LRU cap (Settings,
   default ~2 GB) plus a usage readout (`navigator.storage.estimate()`).
9. **Bulk send-to-queue must chunk.** Writing a 10k-row selection in one
   `storage.local.set` fights the cap (§8.1) and janks the queue; reuse the
   200-row window pattern for batched writes.
10. **Network reality.** Where these sites are ISP-blocked, crawls and
    refreshes may run through VPN/proxy exits with shared IPs — higher
    rate-limit and Cloudflare risk. Another reason watches stay sequential
    and polite by default (§6), and why the initial crawl must be resumable
    and schedulable overnight.

## 9. Phases

- **Phase 0 — this doc.** Schema, surfaces and settings locked (edit here,
  not in code comments).
- **Phase 1 — `library.html` shell (Mihon rail) + importer + dummy-data
  mode.** Webpack entry, tab open wiring, five rail sections, index import
  (§2 format), in-memory inverted index, grid/list + tag-chip filtering on
  sample data. Bookmarks/History/Queue as moved or stubbed views. Index
  stored in OPFS/IndexedDB, never `chrome.storage.local` (§8.1). No
  crawling.
- **Phase 2 — real index. LANDED.** Route A over the documented API v2 (§3
  decision record): `tools/indexer/crawl.js` (--all / --tag-id sort=date /
  --query / --tags / --finish, resumable, keyless or keyed), §2 emitter with
  recomputed tag counts, cap handling per §8.5, `.gitignore` for
  `tools/indexer/indexes/`. **No manifest change was needed and none was
  made on purpose:** Browse renders thumbs with plain `<img>` (no permission
  required), and Phase 3's background OPFS thumb cache must ride the
  existing dynamic CDN-host grant flow (`cdnConfigService` +
  `optional_host_permissions`) — the API docs explicitly forbid hardcoding
  thumb subdomains, so static `t*.nhentai.net` grants would be wrong.
- **Phase 3 — queue integration + visited log. LANDED (thumb cache → 3b).**
  Send-to-queue: the selection becomes `bookmarkAdd` candidates
  (`src/library/sendQueue.ts` — pure, tested), sent in 500-item batches so
  no single storage write goes giant (§8.9); the worker's reply now carries
  `added`/`duplicates` (backwards-compatible) and the bar reports the split;
  duplicate rows are never reset. Visited log: `src/utils/visitedLog.ts` —
  extension IndexedDB (DB `nhdw-library`, store `visited`), content scripts
  report a gallery-page load via `visitedRecord` (validated by the pure
  parser; the worker owns the store, exactly as for the bookmark queue);
  History renders the newest-first list with ✓ download marks and a
  confirmed Clear. Panel-only Tailspace pages are not visit-tracked yet
  (its content script does not resolve a gallery identity). Storage cap:
  `unlimitedStorage` added (§8.1). **Deferred to Phase 3b:** the LRU-capped
  OPFS thumb cache (§8.8) — Browse renders thumbs live via plain `<img>`
  with the offline placeholder fallback, which needs no permissions; the
  cache must ride the dynamic CDN-host grant flow when it lands.
- **Phase 4 — watches + storage settings.** Saved tag combinations,
  sequential multi-source refresh with newest-first URLs (§8.4),
  opportunistic/Cloudflare-aware refresh (§8.6), "new since" badges (§6);
  data-root picker and download destination settings (§7); FS Access data
  root lands here at the latest (§8.2); extend the Item 52 backup with
  watches and the visited log; dead-flag on 404 wired to `mirrorFallback.ts`
  (§8.3).
- **Phase 5 — panel slim-down.** Move queue-full/bookmarks/history/backups
  per §4 after shared renderers are extracted.
- **Phase 6 — later.** Second sources (hitomi `galleries/<id>.js` metadata is
  the easiest next), mirror cross-linking by title, index delta updates,
  watch auto-refresh on alarms.

## 10. Open questions

1. **Crawl route A vs B** (§3) — decided for nhentai: Route A on the API v2.
   Route B stays the fallback for API-less sources. Open: whether existing
   foreign index dumps justify a converter script.
2. **Scale reality check for bulk runs:** `vanilla + english` is tens of
   thousands of galleries ≈ multi-TB of full-size pages. Bulk downloads stay
   per-tag slices with the size preview; the index filter is instant but the
   disk is not.
3. **Thumb extension guessing** — nhentai thumbs vary (`jpg/png/gif`); store
   `thumb_ext` from listing data where available, fallback chain otherwise.
4. **FS Access persistence details** — confirm persistent-permission
   behavior on extension pages across Chrome versions (122+ expected); ship
   the re-grant button regardless.
5. **Pagination cap verification** (§8.5) — confirm nhentai's ~25-page
   search depth against the live site at Phase 2 and design date-sliced
   queries if it holds.
6. **Firefox tree** — the library tab is Chromium-first; FS Access and
   persistent permissions are Chromium-only, so Firefox keeps OPFS/default
   downloads (§7). Parity lands in the usual catch-up releases.

