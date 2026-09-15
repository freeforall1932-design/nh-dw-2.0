# Multi-site v4 plan — planning mode, no code yet

**Recorded:** 2026-09-14 (session `arena/01a09ee5-nh-dw-2-0`).
**Status:** M0 (item 47, composite keys) landed the same day as **3.8.0**;
everything else below is planned, not scheduled. Item numbers 47–52 are registered in `IMPROVEMENT_BACKLOG.md`
and `WORKLIST.md`; this document carries the depth — the same role
`BOOKMARK_QUEUE_PLAN.md` plays for 3.7.0.

This document records four things so no future session has to re-derive them:

1. The merge-vs-new-repo decision and the working agreement with the user's
   lab clone of this repo.
2. The target site roster, with every fact labelled by how we know it.
3. The cooldown analysis for the mirror-network sites.
4. The v4 bucket list — features surfaced during planning that are worth
   keeping but not yet scheduled.

## 1. Decision record: one extension, this repo is the merge target

**Facts that forced the decision:**

- `chrome.storage` is scoped per **extension ID**. Two installed extensions =
  two histories, two bookmark queues, two dedupe stores. The user's original
  complaint about the reference desktop app was exactly "history doesn't
  carry over"; two extensions rebuilds that problem inside the browser.
- The reference desktop app (KurtBestor/Hitomi-Downloader, Python + Qt)
  **cannot be repackaged as an extension**. MV3 runs JS/TS/WASM only, and the
  one escape hatch (Native Messaging) means shipping and installing a native
  host program — which is the desktop app again. Only the *extractor
  knowledge* (URL shapes, metadata endpoints, CDN addressing) ports.
- Solo-dev reality: two repos means every core bug (offscreen pipeline,
  archive formats, history semantics) is fixed twice until one rots.

**Working agreement (what the user is doing and what this repo does):**

- The user's clone of this repo is an **experiment lab**: strip nhentai,
  rework the side panel for multi-site. It never ships as a second installed
  extension.
- This repo stays the **merge target / source of truth**; winning experiments
  land here.
- **The nhentai adapter is not deleted here.** It is the reference adapter
  and the regression control ("nhentai still downloads" is the proof a core
  change did not break the pipeline) until at least one other site downloads
  end-to-end. Removing nhentai entirely is a product decision to revisit
  after that, not an architecture step.
- **Rename/rebrand this repo once site #2 works.** GitHub redirects keep old
  links alive; the extension is unpacked-install anyway, so there is no store
  listing to re-point.
- Scope is deliberately **only the sites the user actually visits**. The
  1000-site goal of the reference app is explicitly rejected.

## 2. Target site roster

Fact labels: **[repo]** = verified in this codebase; **[user]** = reported by
the user from real usage; **[external]** = checked from public sources on
2026-09-14 (links in the backlog session log); **[spike]** = must be verified
in the implementation spike before relying on it. The sandbox has **no egress**
to these hosts (DNS resolves, but the TLS connect dies — the same for
`example.com`), so nothing site-specific was fetched locally; captures come
from the user. (An earlier draft mislabelled this a DNS failure.)

| Site(s) | Status | Notes |
|---|---|---|
| nhentai.net | Shipped (3.7.0) | Reference adapter. Keep. |
| hitomi.la | First new site (item 49) — scaffolded, **blocked on user-captured samples** (see section 8) | See 2.1. |
| imhentai.xxx, hentaienvy.com, hentaiera.com | Planned (item 50) — Strategy C chosen, awaiting the user's go | Per-site adapters: imhentai+envy share a store, hentaiera separate. See 2.2 (corrected). |
| hentaifox.com | Planned, pending spike (item 50) — samples pending | Separate platform unless the spike shows shared structure. See 2.3. |

The **cin.* family** (cin.lat, cin.mom, cin.monster, cin.wiki, cin.wtf, …)
is NOT a new site: those are viewer mirrors of nhentai content. The paste
box already accepts every mirror — the parser matches URL *shapes*
(`/v/<id>`, `?id=…`), never the host, because the site rotates TLDs. Pinned
by tests since 3.8.0; no adapter work needed.

Explicitly out of scope: onion (stays dropped, backlog item 9), video sites,
and every site the user does not actually visit.

### 2.1 hitomi.la — first new site, the architecture validator

- The site's own in-browser download path accumulates every page blob in the
  reader tab's heap and zips client-side; 2000-page gif/webp/avif galleries
  can reach 1 GB+ and crash the tab **[user]**. This is precisely the failure
  mode the offscreen pipeline + `chrome.downloads` exists to avoid.
- Metadata: the known shape from public extractors is a per-gallery JS file
  under `ltn.gold-usergeneratedcontent.net/galleries/<id>.js` (the captured shell
references that host, **not** `ltn.hitomi.la`); image addressing has historically
  required a small runtime config (`gg.js`) that maps image numbers to CDN
  subdomain prefixes and rotates over time. **Verify the current form in the
  spike** — never hardcode subdomains; fetch the config at runtime and cache
  it with a TTL, the way gallery-dl does.
- Originals reportedly include webp/gif and possibly avif **[user]** — avif
  plumbing (type-code map + `cdnConfig` path allowlist; the `image/*`
  content-type validation already accepts it) is part of item 49.
- Huge galleries: default format for this site is **raw** (or the streaming
  ZIP writer, item 51, once it exists), never an in-memory zip.

### 2.2 The mirror network (imhentai / hentaienvy / hentaiera)

- Strong indicators the three hosts are one operator/network: identical
  frontend, shared galleries **[user]**; traffic-analysis affinity
  **[external]**. Working assumption: **one adapter, parameterized by
  host**. Confirm in the spike; if they diverge, split then — not before.
- **Corrected 2026-09-15 (captures):** the "identical frontend / one adapter"
  assumption is false. imhentai+envy share one content store (`/033/<token>/`,
  0/19 matching gallery ids) but have different frontends (`thumbnail`/
  `gallery_title` vs BEM `hnv-*`, reader `#gimg` vs `#readerImg`, `/view/` vs
  `/g/`); hentaiera is a separate backend (`hentaiera.site`, numeric media
  ids, webp). Plan per-site adapters — `ADAPTER_WIRING_PLAN.md` §1.
- They expose a **server-side ZIP download button** (their bandwidth and
  CPU, not the user's RAM) with a **strict ~1 minute cooldown** between uses
  **[user]**.
- Reader pages are served individually from their CDN with no zip endpoint
  involved **[spike: confirm the reader CDN pattern]**.

### 2.3 hentaifox.com

Same category **[user]**, treated as its own platform until the spike shows
otherwise. Assume the same cooldown-queue treatment until measured.

## 3. Cooldown analysis (the four new sites)

**Decision (2026-09-14, settled with the user): Strategy C is chosen.**
Execution WAITS for the user's explicit go-ahead — they have other projects
running and will confirm when ready. Until then nothing here is scheduled.

The ~60 s cooldown is a **server-side rate limit** on their zip endpoint.
There is no legitimate client-side way around it, and this project will not
try — hammering a rate-limited endpoint is abuse and gets IPs banned. The
honest options, in plain language:

- **Strategy A — download the reading pages directly (no button at all).**
  What it actually does: the extension opens the gallery's pages one by one
  exactly like your browser does when you READ the gallery, grabs each page
  image from their CDN, checks it is a real image (the existing fetch →
  validate → retry pipeline), and saves it — ZIP/CBZ/PDF/raw, same as
  nhentai today. Your device does the zipping for archive modes (raw mode
  writes straight to disk). A small delay between page fetches keeps it
  polite. Effect: **the cooldown never applies**, because the zip button
  and its rate-limited endpoint are never touched. Cost: your bandwidth and
  (for ZIP/CBZ/PDF) your RAM for assembly — the streaming-ZIP writer
  (item 51) is the long-term answer for the RAM part.
- **Strategy B — use the site's own download button, but queue politely.**
  What it actually does: the extension clicks their server-side zip download
  for you, at most once per ~60+ seconds per site, and simply WAITS out the
  cooldown in between — with a visible countdown ("waiting for cooldown:
  43 s") in the Queue tab. You line up 20 titles, walk away, and they drip
  out one per minute: their server does all the zipping (zero load on your
  device — the reason the user likes the button), the extension just paces
  the requests and remembers when the last one was sent (survives restarts).
  Effect: same files the button gives you, no tab held open, no manual
  waiting. Cost: real time (1 title/minute) and it depends on their zip
  being the quality you want (that is what C tests).
- **Strategy C — the comparison test (CHOSEN, pending the user's go).**
  What it actually does: pick a handful of galleries on the mirror network;
  download each twice — once by reading-mode pages (Strategy A's path) and
  once via the site's own zip button (waiting out the cooldown manually);
  then compare the two copies page by page: byte-for-byte hashes, pixel
  dimensions, file sizes, image formats. Outcome A wins if the copies are
  identical or the reader pages are better (then the button is never needed
  and downloads are unlimited but device-side); outcome B wins if the zip
  contains better quality (then downloads are server-side but paced at one
  per minute). The user's stated suspicion is that the reading pages are the
  "original" size; C tests exactly that.

Order once the user confirms: build the reader-page path first (it also
  produces half of the comparison samples), run C on a few galleries, then
  keep A, switch to B, or run both as a per-site setting. **Do not skip C** —
  the whole A-vs-B choice hinges on it.

## 4. v4 architecture changes (items 47–48)

### 4.1 Composite (site, id) keys — item 47 — landed as 3.8.0 (2026-09-14)

Implemented by `src/utils/siteKeys.ts` + the store changes described in the
2026-09-14 implementation session log (`IMPROVEMENT_BACKLOG.md`). The
original spec follows.

Every persistent store is keyed by the bare numeric gallery id today:
download history (`downloadHistory.ts`), bookmark queue
(`bookmarkQueue.ts`), failed galleries (`failedGalleries.ts`) **[repo]**.
Ids collide across sites (nhentai #366224 ≠ another site's #366224), so
keys become `"<site>:<id>"`; existing rows migrate as `nhentai:<id>`. Small,
safe, worth doing even if the multi-site direction is later abandoned.

### 4.2 Adapter layer v2 + multi-site panel — item 48

Evolve `GallerySource` **[repo]** into a `SiteAdapter` that additionally
owns:

- metadata normalization into the internal gallery shape (the pattern
  already exists: `GalleryEmbed.normalizeGalleryV2` for the API-v2 path),
- per-page image URL lists incl. mirror/fallback ordering,
- URL parse/format registration for the **paste box** — today it accepts
  only `nhentai.net/g/<id>`, `cin.lat/v/<id>`, `cin.lat/bulk?id=…` and bare
  ids **[repo]**; one pattern per adapter makes it site-aware,
- a content-script DOM module per site (the in-page buttons / floating bar
  are nhentai-DOM-bound today),
- **site-aware worker messages** — `bookmarkAdd` / `bookmarkEnrich` /
  `bookmarkSelect` / `bookmarkRemove` and the failed-gallery retry & dismiss
  messages carry only bare ids today. The queue functions already compose
  both sides, so nothing is broken while only nhentai rows exist, but a
  non-default-site row could not be selected, retried or dismissed until the
  messages carry its site (found by the 2026-09-14 review pass; part of this
  item, not a separate one),
- **per-site job splitting — the last id-collision surface.** The composite
  keys made the *stores* collision-proof, but the *job payload* is still
  bare-id: `allDoujinshis` is `Record<bare gallery id, title>`, and the
  pipeline's skip guard composes every key with the default site
  (`toGalleryKey(key)` — `batchPipeline.ts`, marked by a comment). Two
  consequences once a second site exists: two same-numbered galleries from
  different sites in ONE batch would collapse into a single
  `allDoujinshis` entry, and a non-nhentai gallery would be skip-checked
  against `nhentai:<id>` history records (possible wrong skip / wrong
  redownload). A mixed-site batch becomes real the moment the bookmark queue
  holds rows from two sites and the user presses "Download N selected".
  **Chosen direction (item 48): one job per site** — the queue splits the
  selection into one `downloadAllDoujinshis` job per site before sending
  (jobs are single-site in practice anyway: a job's format, template and
  master folder resolve per site). Alternative, if a true mixed job is ever
  wanted: key the payload by composite id and thread per-gallery site
  through the pipeline — more invasive, no current need.
- per-site settings: default format (hitomi → raw), inter-page pacing,
  zip-button usage on/off,
- its manifest hosts (optional `host_permissions`, requested on use).

The side-panel multi-site rework being prototyped in the user's lab clone
lands here if merged: site sections/filters in Queue and history, per-site
defaults, and the site-aware paste box.

## 5. Bucket list — worth keeping, not yet scheduled

- **Streaming ZIP writer (item 51).** ZIP/CBZ today still *assembles* the
  archive in memory in the offscreen document — the object-URL handoff fixed
  the base64 round-trip, not the assembly — so a 1 GB archive means ~GBs of
  RAM. A streaming writer (zip.js-style) targeting an OPFS file, or a File
  System Access handle picked in the side panel and passed to the offscreen
  document (extension pages share one origin, so the handle transfers),
  keeps memory O(one page), and the disk-backed blob goes to
  `chrome.downloads` unchanged. This is the real "desktop-app-like"
  behaviour for 1 GB-class jobs.
- **History export/import, JSON (item 52).** Cross-machine carry-over.
  `chrome.storage.sync` is too small for history (~100 KB total cap vs
  ~60–70 KB per 10 000 entries already **[repo]**); a file round-trip is the
  honest answer.
- **Gallery size guard.** Estimate total bytes (page count × first-page
  content-length) before starting, and suggest raw/streaming mode when the
  in-memory zip would be 1 GB-class.
- **Per-site naming templates.** Metadata fields differ per site; templates
  should stay site-agnostic.
- **Repo rename/rebrand after site #2 works.** GitHub redirects preserve
  links.
- Deferred forever, recorded so it is not re-litigated: clipboard monitor
  (the paste box already covers it), user scripts, BitTorrent/M3U8 (video —
  out of category).

## 6. Milestones (order, if called)

1. **M0 — item 47: composite keys — landed as 3.8.0 (2026-09-14).**
2. **M1 — item 49:** hitomi spike — adapter, metadata, runtime subdomain
   config, content script, raw default. Validates the whole adapter
   contract. **Blocked on user-captured samples (section 8); the sandbox
   cannot reach hitomi hosts.**
3. **M2 — item 48:** panel v2 + site-aware paste box (merge the lab's
   rework here). Deliberately after M1, so the contract is proven before the
   UI bakes it in.
4. **M3 — item 50:** comparison task (Strategy C — chosen, waiting for the
   user's go-ahead), then the mirror-network adapter + pacing; hentaifox
   rides along if its spike shows the same shape.
5. **M4 — item 51:** streaming ZIP writer; hitomi (and the mirror network's
   A-path) switch to it for archives.
6. **M5 — item 52:** history export/import.
7. Rename/rebrand after M1 proves out.

## 7. Open questions

- Final merge call for the lab clone's panel rework — stays open until
  hitomi works end-to-end somewhere.
- Are the three mirror hosts byte-identical platforms (one adapter)?
- Does hentaifox share the cooldown mechanism?
- Reader vs zip quality on the mirror network (Strategy C).
- Does hitomi serve avif natively, and what is the current subdomain-config
  form? (Verify in the spike; sandbox egress to hitomi hosts is blocked.)

## Do-not rules (planning level)

- **Do not try to bypass server-side cooldowns.** Rate limiting is theirs to
  set; the plan works around it by not needing it (Strategy A) or by
  waiting politely (Strategy B).
- **Do not delete the nhentai adapter from this repo** before a second site
  downloads end-to-end.
- **Do not run the lab clone as a second installed extension** long-term —
  split history is the exact problem this direction exists to avoid.
- **Do not hardcode hitomi CDN subdomains** — they rotate; fetch the config
  at runtime and cache it.
- **Do not put site-specific logic in the core pipeline** — it goes in the
  adapter, or the adapter contract is wrong.

## 8. Sample-capture checklist (unblocks items 49 and 50) — PENDING, user-owned

The sandbox has no egress to these hosts (DNS resolves, TLS blocked), so the
extractors must be
written against real captures. The user grabs these; nothing below is
scheduled until they arrive. Save each item as a plain text / .html file and
drop them into a folder for a future session.

**hitomi.la (item 49):**
1. A gallery page's full HTML (e.g. `https://hitomi.la/galleries/<id>.html`).
2. The gallery's data JS from `ltn.hitomi.la` (view-source on the gallery
   page will show the `<script src=...galleries/<id>.js>` URL; save what it
   returns).
3. `https://ltn.hitomi.la/gg.js` (the subdomain configuration — small file).
4. One reader page's HTML (the URL the site uses when you read the gallery).
5. Two or three full image URLs as the network tab shows them (right-click a
   page image → copy image address), plus their `Content-Type` response
   headers if easy to grab.
6. One GIF or animated WebP gallery id if known — needed to confirm avif /
   animation handling.

**imhentai.xxx / hentaienvy.com / hentaiera.com / hentaifox.com (item 50):**
1. One gallery page's full HTML per site (they may differ in small ways).
2. One reader page's HTML per site.
3. Two or three page-image URLs per site as the network tab shows them
   (these reveal the CDN host pattern).
4. What the site's own download button actually does: the URL it opens /
   POSTs (visible in the network tab after clicking it once), and the
   cooldown message shown when clicked again too soon.
5. One zip downloaded via the button on ONE small gallery — kept unopened;
   it is Strategy C's comparison sample.

Everything on this list is page-source and URL capture only — no account,
no payment, nothing beyond what a normal browser visit produces.
