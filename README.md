<div align="center">

# 📚 NHentai Downloader

**Batch-download full-size doujinshi archives — straight from your browser.**

`ZIP` · `CBZ` · `PDF` · `Raw pages` · persistent queue · download memory

![Version](https://img.shields.io/badge/version-3.8.0-blue)
![Manifest](https://img.shields.io/badge/Manifest-V3-orange)
![Browser](https://img.shields.io/badge/Chromium-109%2B-yellow)
![License](https://img.shields.io/badge/license-MIT-green)

*Unpacked install — no Web Store, no external servers, everything happens locally in your browser.*

</div>

---

## 🌐 Sites

| Site | Status | Notes |
| :--- | :---: | :--- |
| **nhentai.net** | ✅ Shipped | Full support: single titles, listings, search / tag / artist pages, queue, history. |
| `cin.*` viewer links | ✅ Shipped | The paste box accepts every mirror of the viewer site (`cin.lat`, `cin.mom`, `cin.monster`, `cin.wiki`, `cin.wtf`, …) — URL shapes are matched, never hosts, because the site rotates TLDs. |
| **hitomi.la** | 🚧 Planned (v4) | Client-rendered; needs rendered-DOM + `gg.js` capture (`ADAPTER_WIRING_PLAN.md` §7). CDN moved to `ltn.gold-usergeneratedcontent.net`. |
| **imhentai.xxx / hentaienvy.com / hentaiera.com** | 🚧 Planned (v4) | Captures resolved (3 HARs); per-site adapters — two backends, four frontends, not one shared adapter. Wiring pending (`ADAPTER_WIRING_PLAN.md`). |
| **hentaifox.com** | 🚧 Planned (v4) | Needs 1–2 HARs (`ADAPTER_WIRING_PLAN.md` §7). |

The multi-site plan — decision record, cooldown analysis, per-site facts — lives in [`MULTISITE_V4_PLAN.md`](MULTISITE_V4_PLAN.md).

## ✨ Features

- 🗂️ **Four output formats** — `ZIP`, `CBZ`, `PDF`, or raw numbered pages (`001.jpg`…) in a titled folder under one master folder.
- 🖱️ **Works in the page** — every gallery card gets its own **Download** button and **Select** box; a floating bar batches your selection. No popup round-trips needed.
- 🚀 **Large-gallery safe** — archives are handed to Chrome through an MV3 *offscreen document*, so huge galleries never choke the service worker.
- ⭐ **Bookmark queue** — click ☆ on any card and the title waits in the **Queue** tab with its cover and page count. Survives closing the browser and restarting the PC. Collapses to a taskbar-style dock.
- 📋 **Paste anything** — ids, `nhentai.net/g/…` links, any `cin.*` mirror link, `?id=…` bulk strings, ranges like `366220-366224`, mixed freely. Bookmark them or download straight away.
- 🧠 **Remembers what you downloaded** — re-running the same search skips finished galleries, shows a ✓ badge with the saved file name, and offers per-gallery *Download anyway*. *Verify-then-redownload*: a deleted file is fetched again; a cancelled or partial download is never recorded.
- 🪟 **Dockable side panel** — the toolbar button opens a resizable side panel (popup still available in Settings).
- 🛡️ **Cloudflare-aware** — metadata and pages are fetched through your open gallery tab's session first. Not a bypass: a challenge page has no images, so complete it and retry.
- 🔁 **Retry that knows what failed** — every failure names the gallery and reason; **Retry failed** re-downloads exactly those titles with the same settings.
- 🦊 **Firefox desktop + Android build** — separate 1.2.0 build with an in-page drawer; tested offline, device verification/signing pending ([Firefox README](NHDW_Firefox_v1.0.0/README.md)).

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

### The Queue tab
- **☆** bookmark cards on any listing, or paste ids/links into the box and **Add to queue** / **Download now**.
- Tick rows → **Download N selected** → one file per title, in list order, named by the list-mode template.
- **Auto-capture** (Settings, off by default) bookmarks every card as you scroll.
- Rows report `bookmarked → downloading → done` (with the saved file name) `→ failed` (with the reason + retry).

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

- **Download history is local** — it lives in this browser profile, starts empty, and never syncs. `chrome.downloads` can only verify files this profile saved.
- **No per-item cancel in the queue** — global pause / clear exist; cancelling one specific in-flight gallery is recorded as future work.
- **Firefox device verification/signing is pending** — `NHDW_Firefox_v1.0.0` is now the separate 1.2.0 build with Queue, ☆ and list controls; offline checks do not replace the desktop/Android release gate (58).
- **A second extension can win filename fights** — Chrome gives the last-installed extension the final say on names.

## 🗺️ Roadmap — multi-site v4

One extension, several sites, one shared history. The full plan (merge-vs-fork decision record, cooldown strategies A/B/C, streaming ZIP writer, sample-capture checklist) lives in [`MULTISITE_V4_PLAN.md`](MULTISITE_V4_PLAN.md):

- [x] **Composite `(site, id)` keys** — landed in 3.8.0; every store is collision-proof for a second site.
- [ ] **hitomi.la adapter** — blocked on rendered-DOM / `gg.js` captures; sandbox egress (not DNS) is blocked (`ADAPTER_WIRING_PLAN.md` §7).
- [ ] **Multi-site side panel + site-aware paste box.**
- [ ] **Mirror-network sites** — reading-vs-zip comparison first (Strategy C, awaiting the owner's go).
- [ ] **Streaming ZIP writer** (OPFS / File System Access) — constant-memory archives for 1 GB-class galleries.
- [ ] **History export / import** (JSON) for cross-machine carry-over.

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
npm test          # 398 unit tests (builds test modules first)
npm run test:smoke
npm run test:e2e   # six offline e2e suites against the built bundles
npm audit
```

Dependency maintenance (2026-09-21): both maintained projects audit at **0
reported vulnerabilities**; Chrome installs without deprecation warnings.
Firefox's latest Mozilla validator still has **two upstream deprecation
warnings**; they are not suppressed or confused with runtime dependencies.
See [`DEPENDENCY_MAINTENANCE.md`](DEPENDENCY_MAINTENANCE.md) for versions,
remaining warnings, the scoped validator override, and npm/funding guidance.

Firefox-only item 59 (2026-09-21) fixes saved list-format reads across shared
Settings and download consumers. Saved ZIP/CBZ/PDF/raw wins; unset/invalid
values inherit the single-title choice without saving defaults. A 36-case
matrix covers the real reader and built popup/Full panel, page controls and
embedded Settings/Queue/gallery paths. Firefox checks: **474 passing / 4
opt-in live pending**, smoke and offline e2e green; lint **0 errors / 0
notices / 30 unchanged warnings**. Chrome and dependencies were unchanged by
this task; see the [Firefox README](NHDW_Firefox_v1.0.0/README.md) for scope and
remaining device/signing limits.

Internal documents: [`WORKLIST.md`](WORKLIST.md) (what's next) · [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md) (last session's rules) · [`IMPROVEMENT_BACKLOG.md`](IMPROVEMENT_BACKLOG.md) (full specs & history).

## 📝 Version history

| Version | Highlights |
| :--- | :--- |
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
