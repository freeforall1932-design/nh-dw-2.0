<div align="center">

# 📚 NHentai Downloader

**Batch-download full-size doujinshi archives — straight from your browser.**

`ZIP` · `CBZ` · `PDF` · `Raw pages` · persistent queue · download memory

![Version](https://img.shields.io/badge/version-3.10.3-blue)
![Firefox](https://img.shields.io/badge/Firefox-1.4.3-orange)
![Manifest](https://img.shields.io/badge/Manifest-V3-brightgreen)
![Browser](https://img.shields.io/badge/Chromium-109%2B-yellow)
![License](https://img.shields.io/badge/license-MIT-green)

*Unpacked install — no Web Store, no external servers, everything happens locally in your browser.*

</div>

---

## 🌐 Sites

| Site | Status | Notes |
| :--- | :---: | :--- |
| **nhentai.net** | ✅ Shipped | Full support: single titles, listings, search / tag / artist pages, queue, history. |
| `cin.*` viewer links | ✅ Shipped | The paste box accepts any mirror or domain of the viewer site (`cin.lat`, `cin.mom`, `cin.monster`, `cin.wiki`, `cin.wtf`, `cin.red`, …) — URL shapes (`/v/<id>`, `?id=…`) are matched rather than fixed hosts, so newly rotating TLDs work automatically. |
| **hentaiera.to** (`.com`, `.site`) | ✅ Shipped | Full support: gallery & reader pages, `application/ld+json` ImageGallery parsing, numeric media addressing, `/galleries/<media>/<n>.<ext>` image fetches. |
| **imhentai.xxx** (`.org`, `.net`) | ✅ Shipped | Full support: gallery HTML parsing, unpadded `/033/<token>/<n>.<ext>` CDN image mirror downloads. |
| **hentaienvy.com** | ✅ Shipped | Full support: Tailwind BEM parsing, `#readerPagesJson` reader metadata, shared `/033/<token>/` content store. |
| **hentaifox.com** | ✅ Shipped | Full support: gallery page metadata, `g_th` type code mapping, `/004/` and `/005/` numeric media directories. |
| **hitomi.la** | ✅ Shipped | Full support: `galleries/<id>.js` galleryinfo metadata, dynamic hash path & subdomain math (`gg.js`), direct CDN image fetching (`gold-usergeneratedcontent.net`), default format `raw` to prevent tab RAM exhaustion. |

The multi-site plan — decision record, cooldown analysis, per-site facts — lives in [`MULTISITE_V4_PLAN.md`](MULTISITE_V4_PLAN.md).

## ✨ Features

- 🗂️ **Four output formats** — `ZIP`, `CBZ`, `PDF`, or raw numbered pages (`001.jpg`…) in a titled folder under one master folder.
- 🖱️ **Works in the page — on all six sites** — every gallery card gets its own **Download** button, **Select** box and bookmark icon, and the floating bar batches your selection (*Select all* included). No popup round-trips needed.
- ⚡ **Smart Download** — the panel preview and every gallery page carry a **Save offline** control that downloads straight away with your list-mode format, template and folder; hold **Alt** (or use the panel form) to review name/format first. On gallery pages it sits beside our blue **Bookmark**, visually and verbally distinct from the site's own Download button.
- 🚀 **Large-gallery safe** — archives are handed to Chrome through an MV3 *offscreen document*, and a constant-memory **streaming ZIP writer** streams pages straight to disk (OPFS), so even 1 GB-class galleries never pile up in RAM.
- ⭐ **Bookmark queue across 6 sites** — click the bookmark icon on any card, or the blue **Bookmark** button on a gallery page (next to the site's own Favorite/Download buttons, all six supported sites), and the title waits in the **Queue** tab with its cover and page count. Survives closing the browser and restarting the PC. Collapses to a taskbar-style dock.
- ⏹️ **Per-row cancel (Item 45)** — stop one in-flight gallery from its Queue row; the rest of the batch carries on, and the cancelled title can be retried straight away.
- 🔀 **Per-site job dispatching (Item 48)** — mixed queues containing titles from different websites automatically split into discrete jobs per site. Each job fetches from its own site's CDN with clean bare-ID naming (`001.jpg`, `Title [123456].zip`) and composite keys (`site:id`) in history and retry queues.
- ↕️ **Drag-and-drop queue reordering (Item 44)** — grab handles let you manually reorder the bookmark queue to set your exact download order.
- 💾 **Export / Import backups (Item 52)** — export queue and download history into a single clean JSON backup (`nh-downloader-transfer`). Import merges with union policy (local wins, never deletes).
- 📋 **Paste anything** — bare IDs, `site:id` composite keys, `nhentai.net/g/…` links, any `cin.*` mirror link (e.g. `cin.lat`, `cin.red`), mirror network links (`hentaiera`, `imhentai`, `hentaienvy`, `hentaifox`, `hitomi`), `?id=…` bulk strings, ranges like `366220-366224`, mixed freely. Bookmark them or download straight away.
- 🧠 **Remembers what you downloaded** — re-running the same search skips finished galleries, shows a ✓ badge with the saved file name, and offers per-gallery *Download anyway*. *Verify-then-redownload*: a deleted file is fetched again; a cancelled or partial download is never recorded.
- 🪟 **Dockable side panel** — the toolbar button opens a resizable side panel (popup still available in Settings).
- 🛡️ **Cloudflare-aware** — metadata and pages are fetched through your open gallery tab's session first. Not a bypass: a challenge page has no images, so complete it and retry.
- 🔁 **Retry that knows what failed** — every failure names the gallery and reason; **Retry failed** re-downloads exactly those titles with the same settings.
- 🦊 **Firefox desktop + Android build** — separate 1.3.0 build with an in-page drawer and full parity ([Firefox README](NHDW_Firefox_v1.0.0/README.md)).

## 📦 Installation

1. Open `chrome://extensions/` (Chrome / Brave / Edge — any Chromium 109+).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the **`NHDW_Release_v3.0.0`** folder.
4. Pin 📚 **NHentai Downloader** from the puzzle-piece menu.

> The side panel dock needs Chrome 116+; older builds fall back to the popup automatically.

## 🎮 Usage

### Single title
Open a gallery page → click the extension icon → edit the save name if you like → **Download**.

### Listing pages (search / tag / artist / homepage)
- Hover a card → **Download** grabs just that title with the list-mode settings.
- Tick **Select** on several cards → the floating bar shows `N selected · M already downloaded · K will download` → pick format → **Download**.
- Or do the same from the side panel, which lists every gallery on the page and can walk all result pages.

### The Bookmark tab
- **Bookmark** any card from its icon, any gallery page from its blue **Bookmark** button, or paste ids/links into the box and **Add to queue** / **Download now**.
- Tick rows → **Download N selected** → one file per title, in list order, named by the list-mode template.
- **Auto-capture** (Settings, off by default) bookmarks every card as you scroll.
- Rows report `bookmarked → downloading → done` (with the saved file name) `→ failed` (with the reason + retry); a downloading row shows **Cancel**, which stops just that title and lets the rest of the batch continue.

> **Merging different titles into one PDF** always asks first — a merged PDF is a tankoubon and can't be taken apart afterwards. *Switch to separate files* is the default answer.

### Where files land
Archives: `Downloads/NHDW/[Title].zip` (master folder configurable). Raw: `Downloads/NHDW/[Title]/001.jpg …`. List downloads are named from a per-gallery metadata template — never from the page URL.

## ⚙️ Settings highlights

| Setting | Default | What it does |
| :--- | :--- | :--- |
| Format (list mode) | ZIP | ZIP / CBZ / PDF / Raw, stored separately from the single-title format. |
| Output | Separate files | One file per title, or one merged archive for everything. |
| Master folder | On | Wrap downloads in `Downloads/NHDW/`. |
| Name template | `{pretty}` | Tokens like `{pretty}`, `{id}` — resolved from each gallery's own metadata. |
| Verify downloaded files exist | On | A recorded gallery is only skipped while its file is still on disk. |
| Auto-capture | Off | Bookmark every card as you scroll. |
| Toolbar click opens | Side panel | Switch back to the classic popup. |

## ❓ Troubleshooting

| Issue | Fix |
| :--- | :--- |
| **"Service worker registration failed"** | Load the `NHDW_Release_v3.0.0` folder itself, not a subfolder. Check the extensions console (F12). |
| **Popup says "not on nhentai.net"** | The active tab must be on `nhentai.net` when you open it. |
| **403 / Cloudflare errors** | Open the gallery page itself, complete the challenge, retry. This is not a bypass. |
| **Empty ZIP / failed pages** | Keep the gallery tab open and retry; disable ad-blockers for the site. |
| **Files land in Downloads root as `1.jpg` / UUID names** | Another extension (download manager, antivirus, cloud-drive) is winning Chrome's filename decision — disable it for the download. |
| **Re-running a search re-downloads everything** | Fixed in 3.5.0 — finished galleries are skipped (✓ badge, *Download anyway* link). Pre-3.5.0 downloads aren't remembered. |
| **Raw mode labelled "(testing)"** | Raw is stable day-to-day (interrupted pages are retried and failed galleries never recorded), but folder creation isn't confirmed on every platform. |

## ⚠️ Known limitations

- **Download history is local** — it lives in this browser profile, starts empty, and never syncs via browser cloud accounts. Use **Export / Import backup** in the Bookmark tab to migrate history between machines.
- **Firefox device verification/signing is pending** — `NHDW_Firefox_v1.0.0` is now the separate 1.4.3 build with the **Bookmark** tab, the bookmark icon, list controls, per-site card controls and multi-site download support; offline checks do not replace the desktop/Android release gate (58).
- **A second extension can win filename fights** — Chrome gives the last-installed extension the final say on names.

## 🗺️ Roadmap — multi-site v4

One extension, several sites, one shared history. The full plan lives in [`MULTISITE_V4_PLAN.md`](MULTISITE_V4_PLAN.md) and [`ADAPTER_WIRING_PLAN.md`](ADAPTER_WIRING_PLAN.md):

- [x] **Composite `(site, id)` keys (Item 47)** — landed in 3.8.0; all stores collision-proof across sites.
- [x] **Multi-site adapters (Items 49, 50, 53)** — landed in 3.9.0 / FF 1.3.0 for `hentaiera`, `imhentai`, `hentaienvy`, `hentaifox`, and `hitomi`.
- [x] **Site-aware universal paste box & per-site job splitting (Item 48)** — landed in 3.9.0 / FF 1.3.0.
- [x] **History & queue export / import JSON (Item 52)** — landed in 3.9.0 / FF 1.3.0.
- [x] **Streaming ZIP writer (Item 51)** — landed in 3.9.0 / FF 1.3.0: OPFS-backed constant-memory archives (memory sink fallback where OPFS is absent).
- [x] **Card controls on all six sites (Item 63)** — landed in 3.10.0 / FF 1.4.0: per-site listing-card selectors, site-aware history skip and composite bookmark identity on every listing page.
- [x] **Smart Download control beside Bookmark (Item 62)** — landed in 3.10.0 / FF 1.4.0: **Save offline** in the panel preview and on every supported gallery page (Alt opens the existing form).
- [x] **Select all + title-page select (Item 64)** — landed in 3.10.0 / FF 1.4.0: the floating bar selects a whole page, and a gallery page's **Select** writes into the same shared selection the cards use.
- [ ] **Combined device verification & Firefox signing (Items 42/58)** — real-browser and Android checks.

## 🧪 Development

```
NHDW_Extension_v3.0.0/   TypeScript source, tests, e2e harnesses
NHDW_Release_v3.0.0/     The loadable, built package (what you install)
NHDW_Firefox_v1.0.0/     Firefox desktop/Android build (see its README)
```

Use a maintained Node 22/24 LTS installation. The tooling requires
`^20.19.0 || ^22.13.0 || >=24.0.0`; verification used Node 22.22.3, with clean
installs under npm 10.9.8 and 12.0.2.

```bash
cd NHDW_Extension_v3.0.0
npm ci
npm run build     # webpack -> js/ (copy changed bundles to the release folder)
npm test          # 587 passing unit tests (Chrome)
npm run test:smoke
npm run test:e2e   # offline e2e suites against the built bundles
npm audit
```

For Firefox:
```bash
cd NHDW_Firefox_v1.0.0
npm ci
npm run build     # webpack -> js/
npm test          # 634 passing unit tests (Firefox)
npm run test:smoke
npm run test:e2e
```

Dependency maintenance (2026-09-21): both maintained projects audit at **0
reported vulnerabilities**; Chrome installs without deprecation warnings.
Firefox's latest Mozilla validator still has **two upstream deprecation
warnings**; they are not suppressed or confused with runtime dependencies.
See [`DEPENDENCY_MAINTENANCE.md`](DEPENDENCY_MAINTENANCE.md) for versions,
remaining warnings, the scoped validator override, and npm/funding guidance.

Item 59's list-format fix now lives in BOTH trees (it shipped Firefox-only on
2026-09-21 and was ported to Chrome on 2026-09-25): every reader asks storage
for the optional `listFormat` key, so a saved ZIP/CBZ/PDF/raw wins while an
unset or invalid value inherits the single-title choice without writing
defaults back. A 36-case matrix covers the real reader, the built
popup/panel Settings and the in-page card + bar controls in both trees.

Internal documents: [`WORKLIST.md`](WORKLIST.md) (what's next) · [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md) (last session's rules) · [`IMPROVEMENT_BACKLOG.md`](IMPROVEMENT_BACKLOG.md) (full specs & history).

## 📝 Version history

| Version | Highlights |
| :--- | :--- |
| **3.10.3** | Item 71: the panel's list says out loud what replaced the retired "Download all (N pages)" button — ticking a row and ticking a card on the page are one selection, and the range block covers the listing's other pages; the List-mode hint names the range block too. Behind that, the pipeline's skip guard now reads a recorded bare id as the **default site's** record instead of this job's site, so a legacy nhentai record can no longer mask a same-numbered gallery on another site (a real skip-the-download bug on the five added hosts for history from before 3.8.0). |
| **3.10.2** | Item 65: the panel's third tab is labelled **Bookmark** and every tooltip/hint that called it a "Queue" follows (storage key `bookmarkQueue`, `#tabQueue` id, message actions and the export format are unchanged on purpose); Firefox 1.4.2 carries the same rename. Ships in **PR #51** together with the **3.10.1** review fixes below. |
| **3.10.1** | Review pass on the 3.10.0 work: listing card controls honour the tested listing-only guard (`resolveListCardPage`), so a gallery page's related-gallery cards are never decorated and the floating bar stays hidden there; the bar's `allIdsSite` read asks storage for the key, so another site's selection can no longer appear selected; the legacy nhentai caption checkbox is gated to nhentai instead of also firing on the five added hosts. |
| **3.10.0** | Card controls on all six sites (item 63): per-site listing-card selector table, site-aware history skip and composite bookmark identity; Smart **Save offline** control in the panel preview and beside the gallery-page Bookmark (62), Alt = open the existing form; **Select all** in the floating bar and a gallery-page **Select** feeding the shared selection (64); the boolean side of the floating bar stays visible while cards exist; item 59's saved-list-format fix ported from Firefox into Chrome. Merged to
main in **PR #50** (2026-09-25). |
| **3.9.0** | Per-site jobs & multi-site download pipeline (item 48): non-nhentai rows downloadable across 6 sites (nhentai, hentaiera, imhentai, hentaienvy, hentaifox, hitomi); real bookmark SVG icon on cards (was ☆); blue **Bookmark** button on every gallery page of all six sites; panel & similar bookmark toggles (43); drag-and-drop queue reordering (44); queue + history export/import JSON (52); template odd-separator gate (41); empty-token filename cleanup (39); per-row Cancel of an in-flight download (45); constant-memory streaming ZIP writer via OPFS (51). |
| **3.8.0** | Composite `(site, id)` keys — multi-site groundwork; viewer-mirror (`cin.*`) paste support pinned by tests. |
| **3.7.0** | Bookmark queue: ☆ on cards, persistent Queue tab, paste box, dock, auto-capture. |
| **3.6.x** | Failure tracking by name + *Retry failed*, error-message hardening, one format decision per job. |
| **3.5.0** | Download history: verify-then-redownload, ✓ badges, zero API calls for skipped galleries. |
| **3.4.x** | List-mode parity (ZIP/CBZ/PDF/raw everywhere), side panel, in-page card controls. |

Full history: session logs in [`IMPROVEMENT_BACKLOG.md`](IMPROVEMENT_BACKLOG.md).

## ⚖️ License & responsible use

MIT — see [LICENSE](LICENSE). For personal archival of content you have the right to keep. Be polite to the sites you download from: the extension paces its requests, never bypasses rate limits or paywalls, and removes nothing from any server.

<div align="center">

*Built as a Chrome MV3 extension — no native app, no accounts, no telemetry.*

</div>
