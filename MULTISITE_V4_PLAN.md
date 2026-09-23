# Multi-site v4 plan

**Recorded:** 2026-09-14 (session `arena/01a09ee5-nh-dw-2-0`).
**Updated:** 2026-09-23 (session `arena/01a0cdce-nh-dw-2-0`).
**Status:** **Landed in Chrome 3.9.0 / Firefox 1.3.0.** M0 (composite keys),
M1 (hitomi adapter + resolver), M2 (per-site jobs + site-aware paste box),
M3 (mirror network & hentaifox adapters), M4 (streaming ZIP writer, 2026-09-24)
and M5 (Item 52 backup export/import)
have all shipped and are verified across 519 Chrome / 595 Firefox unit tests.
See `ADAPTER_WIRING_PLAN.md` for the wiring matrix and `WORKLIST.md` for remaining open items.

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
| nhentai.net | **Shipped** | Reference adapter + regression control. Keep. |
| hitomi.la | **Shipped (item 49, 3.9.0)** | Dynamic `gg.js` resolver, default format `raw`. See 2.1. |
| imhentai.xxx, hentaienvy.com, hentaiera.to | **Shipped (items 50/53, 3.9.0)** | Per-site adapters: imhentai+envy share a content store (not ids), hentaiera a separate backend. See 2.2. Strategy C still pending owner go. |
| hentaifox.com | **Shipped (item 50, 3.9.0)** | Its own platform (`g_th` type codes, `/004/`+`/005/` dirs). See 2.3. |

Per-site contract details (hosts, URL shapes, metadata sources, referer/CDN
behaviour) live in the **`ADAPTER_WIRING_PLAN.md` §1 matrix** — the operative
reference for site #7+. The owner's next-site picks: `CANDIDATE_SITES.md` §4a.

The **cin.* family** (cin.lat, cin.mom, cin.monster, cin.wiki, cin.wtf, …)
is NOT a new site: those are viewer mirrors of nhentai content. The paste
box already accepts every mirror — the parser matches URL *shapes*
(`/v/<id>`, `?id=…`), never the host, because the site rotates TLDs. Pinned
by tests since 3.8.0; no adapter work needed.

Explicitly out of scope: onion (stays dropped, backlog item 9), video sites,
and every site the user does not actually visit.

### 2.1 hitomi.la (shipped)

Durable facts the adapter is built on: the site's own in-browser download path
accumulates every page blob in the reader tab's heap (1 GB+ galleries crash
it — the reason this site defaults to **raw**, with the streaming ZIP writer
(item 51, landed) as the archive answer); metadata is a per-gallery JS file
(`galleries/<id>.js` on `ltn.gold-usergeneratedcontent.net`); image addressing
needs the runtime `gg.js` config (subdomains **rotate** — fetch at runtime,
cache with a TTL, never hardcode). Owner's live-testing note: reading-mode
originals are PNG/~10x webp size (possible pending avif conversion — avif
plumbing exists in the type-code map); the site's own zip button serves
**webp, not originals**.

### 2.2 The mirror network (imhentai / hentaienvy / hentaiera) (shipped)

The "identical frontend, one adapter" assumption was **false** (2026-09-15
captures): two storage backends, four frontends. imhentai + hentaienvy share
one content store (`/033/<token>/`) with **disjoint gallery-id spaces** (19/19
shared tokens, 0/19 matching ids) — cross-mirror fallback there is a host swap
on the token, never an id lookup. hentaiera is a separate backend
(`hentaiera.site`, numeric media ids, webp). They expose a server-side ZIP
button with a strict ~1-minute cooldown — see §3 (Strategy C still pending).

### 2.3 hentaifox.com (shipped)

Its own platform: `g_th` type-code map, CDN prefix varies per gallery
(`/004/` older vs `/005/` newer — read, never assumed). Its zip came out the
largest in the owner's comparison (~1-2% over the mirror baseline).

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

## 4. v4 architecture changes (items 47–48) — LANDED

Item 47 (composite `<site>:<id>` keys, `src/utils/siteKeys.ts`) landed as
3.8.0; item 48 (per-site jobs, site-aware paste box, per-adapter metadata
resolution, composite history/retry with bare-id names) landed in 3.9.0 /
FF 1.3.0 (PR #47). The operative rules now live in `SESSION_HANDOFF.md` →
"Structural invariants" and the Do-not list; implementation history is in
`IMPROVEMENT_BACKLOG.md` (2026-09-14…23 logs). The wider planning scope of
item 48 (adapter-interface v2 formalization, the lab clone's side-panel
rework merge) remains open — see §7.

## 5. Bucket list — worth keeping, not yet scheduled

- **Streaming ZIP writer (item 51) — LANDED 2026-09-24.** ZIP/CBZ today still *assembles* the
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

## 6. Milestones (all landed)

M0 item 47 composite keys (3.8.0) · M1 item 49 hitomi adapter+resolver ·
M2 item 48 per-site jobs + universal paste box · M3 items 50/53 mirror
network + hentaifox · M4 item 51 streaming ZIP writer (OPFS; 2026-09-24 incl.
review fixes) · M5 item 52 queue+history export/import. All in 3.9.0 /
FF 1.3.0 except M0 (3.8.0). Remaining gate: items 42/58 (device passes +
signing). Details: `IMPROVEMENT_BACKLOG.md`.

## 7. Open questions (still open after the 3.9.0 landing)

- Final merge call for the lab clone's panel rework (side-panel multi-site
  UI) — hitomi now works end-to-end offline; the call is the owner's.
- Does hentaifox share the mirror network's ~60 s zip cooldown mechanism?
  (Unmeasured; its adapter uses Strategy A like the others.)
- Reader vs zip quality on the mirror network (Strategy C) — chosen, awaiting
  the owner's go; the owner's live note already leans Strategy A.
- hitomi avif: the owner's note found PNG originals with avif conversion
  possibly pending; confirm on a fresh sample during a real-browser pass.
- Cross-mirror fallback chains (owner's live-testing note): deferred by the
  owner's 2026-09-15 call; token-host-swap design for imhentai↔hentaienvy is
  recorded in §2.2 so it is not re-derived.

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

## 8. Sample captures — DONE for all six sites; guide moved

All six initial sites are captured, audited and shipped (2026-09-15…23). The
capture method + handover rules for the NEXT site live in `CAPTURE_GUIDE.md`;
the candidate roster in `CANDIDATE_SITES.md`. Capture files in `captures/`
were sanitized 2026-09-24 (dummy titles/tags, ad blocks stripped, website
naming kept); originals only in git history — sandbox egress to these hosts
stays blocked, so new captures remain owner-owned.
