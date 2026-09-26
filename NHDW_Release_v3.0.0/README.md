# NHentai Downloader — Manifest V3

A Chrome/Edge/Brave extension to download doujinshi from [nhentai.net](https://nhentai.net).  
Updated for **Manifest V3** with an offscreen document for reliable ZIP downloads, active-tab Cloudflare fallback, and deterministic fixture tests.

[![CI](https://github.com/Xwilarg/NHentaiDownloader/workflows/CI/badge.svg)](https://github.com/Xwilarg/NHentaiDownloader/actions)

---

## Features

- **Single download** — Open a gallery page, click the extension icon, and download as ZIP, CBZ, PDF, or raw images. The popup is split in two columns: the current gallery (format picker, filename, Download) on the left and a **Similar galleries** picker on the right.
- **Similar galleries** — On a gallery page, the popup's right column loads nhentai's related recommendations as a checkbox list; pick the ones you want and each selected gallery downloads as its own titled file (ZIP/CBZ/PDF/raw per the same format picker).
- **List mode (3.4.0)** — On search, tag, artist, category, or favorites pages the panel offers the *same four formats* as a single title plus an explicit **output mode**: **Separate files (one per title)** — the new default, each file named from the list-mode template and that gallery's own metadata — or **Single merged file (all titles)**, the previous behaviour. The master-folder wrap is an optional checkbox that applies to archives and raw alike. Merging several *different* titles into one PDF always asks for confirmation first (a batch PDF is one continuous tankoubon-style document that cannot be split afterwards), with "one PDF per title" as the default answer; this stacks on top of the existing "you are going to download N pages" confirmation.
- **In-page card controls (3.4.0, all six sites in 3.10.0; listing pages only since 3.10.1)** — Every gallery card on a listing page gets a **Download** button, a **Select** box and a bookmark icon, with a floating bar showing `N selected -> format -> output -> Download` plus **Select all**. The bar is visible whenever the page has listing cards, and each site's own card markup is matched by its own selector row (nhentai, hentaiera, imhentai, hentaienvy, hentaifox, hitomi). Selection is shared with the panel in both directions and survives infinite scroll. Toggle: Settings -> *Download / Select buttons on listing cards*.
- **Side panel (3.4.0)** — The toolbar button opens a dockable, resizable `chrome.sidePanel` instead of the hovering popup; both render the same view. Settings -> *Interface* -> **Toolbar click opens** switches back to the popup, which is also the automatic fallback on Chrome < 114.
- **Download memory (3.5.0)** — Re-running a listing skips galleries this browser already recorded: already-downloaded cards show a ✓ with the saved file name and a *Download anyway* link, and skipped galleries cost zero API calls. Verify-then-redownload: a record only counts while its file still exists on disk, so a deleted file is fetched again on the next run.
- **Failure naming & retry (3.6.0)** — Every failure names the gallery (title, id, reason) and stays listed with *Retry* / *Dismiss*; **Retry failed** re-downloads exactly those titles with the same format, master folder and name template. A partial gallery is never recorded as downloaded.
- **Bookmark queue (3.7.0, icon + page button in 3.9.0)** — Click the **bookmark icon** on any gallery card, or the blue **Bookmark** button on a gallery page (all six supported sites), and the title waits in the **Queue** tab with its cover, page count and origin page — surviving browser closes and PC restarts. A paste box takes ids, `nhentai.net` links, any `cin.*` viewer-mirror link (`cin.lat`, `cin.mom`, `cin.monster`, `cin.wiki`, `cin.wtf`, …), `?id=…` bulk strings and ranges like `366220-366224`, and either bookmarks them or downloads them straight away. **Auto-capture** (panel Settings → *Bookmark queue*, off by default) bookmarks every card as you scroll. The tab collapses to a one-bar dock.
- **Bookmark tab extras (3.9.0)** — The panel's own **Bookmark** toggle sits beside **Download** on the single-title preview and on every *Similar galleries* row (the row's own toggle, outside its checkbox, so clicking it never ticks that gallery). **Drag a row by its handle to reorder the queue** — the list downloads in exactly that order. **Export backup** writes the queue *and* the download history to one readable JSON file, and **Import backup** merges a file back in: union, your existing rows win, and nothing is ever deleted, so a wrong file cannot wipe the list. A row that is **downloading** shows a red **Cancel** button: it stops just that title (the rest of the batch continues) and the row can be retried right away.
- **Bookmark search & re-download marks (3.10.5)** — The Bookmark tab gained a **search box** (title, id or tag; every typed word must match) plus **state** (any / not downloaded / ticked / done / failed / downloading) and **date added** (today / last 7 days / last 30 days / older) filters that compose with the per-site select into one view — the stored list is never rewritten and the header counts stay whole-list. The list renders a **200-row window with "Show more (N of M)"**, so tens of thousands of rows stay smooth (`MAX_BOOKMARK_ITEMS` is unchanged, as the item says). Every row the **download history** records carries a **green ✓** whose tooltip is the saved file name; a "N already downloaded" counter sits beside the filter line and the Download button's tooltip says how many of the rows on screen are already on disk **before** the batch runs. The ✓ follows the file, not the row: a row that only claims "done", or that failed after an earlier success, is never mislabelled, and **Select all / Select none follow the whole search** (composite keys of every matching row).

- **Live harvest (3.10.5)** — On any listing page the floating bar has a **Harvest** button: one click collects every gallery card the tab has **already rendered**, keeps collecting through a MutationObserver as the site appends more (infinite scroll, pagination, late chunks — each card once), and ticks them into the same selection the bar downloads. **Stop harvest** ends it authoritatively; an optional **Scroll for me** box (remembered, off by default) scrolls the page for you in bounded steps — 700 ms rounds, 40 rounds, 2000 items — and stops itself at the end of the page saying which limit it hit ("N collected · reached the end of the page"). The collected titles are stored in `chrome.storage.local` and merged back into the selection after a **reload** (this page's site only, no duplicates); the run itself never resumes on its own.

- **Smart Download (3.10.0)** — The panel preview and every supported gallery page carry a **Save offline** control: one click downloads the title with your list-mode format, name template and master folder (asking first if it is already in the download history); hold **Alt** — or use the panel's own form — to review format and file name before starting. On a **gallery page** a **Select** control sits beside it and adds that title to the same selection the listing cards use.
- **Batch download** — On search, tag, artist, category, or favorites pages, check the boxes injected next to each gallery card and download them all at once.
- **Multi-page download** — From listing pages with pagination, download galleries across several pages in one operation.
- **Name templates** — Pick what goes into filenames with simple checkboxes (pretty title, `{english}`, `{japanese}`, `{id}`, `{artist}`, `{group}`, `{character}`, `{language}`); custom placeholder strings are still supported as a manual fallback.
- **Duplicate handling** — Choose whether to auto-rename or ignore duplicate titles in batch downloads.
- **Concurrent downloads** — Adjust the number of parallel image fetches (1–15) to balance speed against server errors.
- **Cloudflare resilience** — If the extension-origin API request is blocked, metadata is retrieved from the already-open browser tab (same-origin, with Cloudflare clearance cookies).
- **HTML parsing fallback** — When the JSON API is unavailable, extract gallery metadata from the page HTML.

---

## Screenshots

| Single gallery | Batch listing | Multi-page |
|---|---|---|
| ![Single download](Preview/Folder.png) | ![Batch download](Preview/Overview-many.png) | ![Multi-page](Preview/Overview-pages.png) |

---

## How it works

1. **Popup / panel** — Clicking the extension icon on an nhentai page opens the panel with three tabs: **Download** (detects a single gallery vs a listing page), **Queue** (the persistent bookmark list — see the bookmark queue feature below) and **Settings** (paste/save/remove the API key and set the file-name template on the fly, without opening a separate page).
2. **Metadata** — Gallery info comes from nhentai's API v2 (`nhentai.net/api/v2/galleries/<id>`), from the SvelteKit JSON payload embedded in the open gallery page, or from the legacy `window._gallery` embed. In **API key mode** (see below) the official keyed API is tried first; otherwise metadata resolves through the active browser tab's page context.
3. **Checkboxes** — On listing pages the content script injects checkboxes next to each gallery card. Tick the ones you want and press **Download** in the popup.
4. **Download engine** — Images are fetched through the open nhentai tab when a tab id is available (page origin and cookies), then from the extension origin. The image server list is resolved per session from `nhentai.net/api/v2/cdn` (validated HTTPS `*.nhentai.net` origins, API order first), with automatic fallback through the built-in mirrors (`i.nhentai.net`, `i1`–`i4`). If nhentai reports image hosts the extension has no permission for, the popup offers a one-click **Grant image host access** (optional `https://*.nhentai.net/*` permission — downloads keep working on the permitted hosts either way). HTML challenge responses are rejected so they never end up inside a ZIP.
5. **Archive / PDF output** — ZIP and CBZ archives are named after the gallery with the numbered pages directly at the archive root (no double `Title/Title` folder when extracting). **PDF** assembles the same pages into one `<Title>.pdf` (JPEG pages are embedded as-is; other formats are converted). In supported browsers an **offscreen document** assembles the result (and creates the real object URLs, no base64 memory blow-up) and survives service-worker idle timeouts; ZIP/CBZ assembly streams page by page to disk through the **Origin Private File System** (a constant-memory writer, with an in-memory fallback where OPFS is unavailable), so even 1 GB-class archives never accumulate in RAM. Raw mode saves the numbered pages (`001.jpg`, `002.png`, …) inside a per-gallery folder grouped under one master folder — `Downloads/NHDW/<Title>/…` by default. The master folder name is configurable in Options (*Folder for raw downloads*; empty it to get plain `Downloads/<Title>/…`, or use slashes for deeper nesting like `NHDW/raw`).
6. **Saving** — The offscreen document only uses the APIs Chrome actually exposes there (`chrome.runtime`); finished objects are saved by the **service worker** via `chrome.downloads` (raw mode hands the original CDN URL to the same download manager).

---

## 403 / Cloudflare errors

nhentai uses Cloudflare, which may challenge requests that appear automated. The extension mitigates this by:

- Retrieving metadata from the **active browser tab** (`window._gallery` / embedded JSON) instead of hitting `/api/gallery` from the extension origin first.
- Fetching ZIP pages through that **same open tab** when possible, then falling back to an extension-origin CDN request.
- Requesting batch metadata and listing pages through the **open nhentai tab's session** (which carries any completed challenge clearance) before falling back to the extension origin.
- Offering an **HTML parsing** option (Settings → Advanced → Use HTML to get API info) that extracts gallery data from the rendered page.
- Falling back through CDN mirrors when an image server returns a non-image response, and never adding HTML or tiny bodies to the ZIP.
- Resolving the current image server list from `GET /api/v2/cdn` once per session (through the open tab's session when possible) instead of trusting one hardcoded mirror; anything that is not an HTTPS nhentai-owned origin is rejected.

This is **not** a Cloudflare bypass. If the tab is still “Just a moment…”, there is no gallery JSON and no image bytes to read. If metadata succeeds but images fail, keep the gallery tab open after the challenge and try again.

If you still see 403 errors:
- Make sure you are logged into nhentai in the active tab.
- Try again with a different VPN/proxy endpoint.
- Or switch to **API key mode** (next section), which uses nhentai's official API authentication for third-party clients.

---

## API key mode (optional)

nhentai's official API v2 documents API keys as the authentication method for third-party clients: generate one at **nhentai.net → account settings → API keys** and it is sent as `Authorization: Key YOUR_API_KEY`.

On first use the popup shows a gate with two explicit exits:

- **Submit key** — enters **API key mode**.
- **Continue without API key** — enters **open tab mode** (the previous behaviour). The choice is remembered; the key can later be set or cleared in the extension options.

### Mode boundaries

| Concern | API key mode | Open tab mode (no key) |
|---|---|---|
| Metadata route order | keyed official API → open-tab read → plain fetch | open-tab read → plain fetch (unchanged) |
| `Authorization` header | `Key <key>` on `nhentai.net/api/` requests only | never created |
| `429` handling | honoured with `Retry-After` backoff | n/a |
| Batch downloads | do not depend on reading the open tab | resolve through the open NHentai tab only |
| One-shot server archives | available (opt-in) | not available (endpoint requires auth) |

**Shared by both modes** (unified core): the download engine (page queue, retries, exponential backoff, ZIP/CBZ assembly, raw and folder outputs, object-URL delivery), parsing/normalisation, Cloudflare-challenge detection, content scripts, popup UI, progress/summary messages, and the hidden same-tab fallback frame.

Notes:

- The key is stored in `chrome.storage.local` only — it never syncs to other devices, never reaches content scripts, and is only ever attached to `nhentai.net/api/` URLs (never to CDN media URLs).
- The key (and the gate decision / archive toggle) is persistent: it survives closing the browser, browser restarts, and disabling/re-enabling the extension. Only **Clear key** in the options, uninstalling the extension, or wiping the browser's extension data removes it.
- An invalid key can never break a download: a failing keyed request falls through to the open-tab routes.
- This is not a Cloudflare bypass; it is the site's official API contract for clients.

### One-shot server archive downloads (experimental)

With an API key, the extension can ask `POST /api/v2/galleries/<id>/download?format=zip|cbz` for a ready-made archive instead of fetching every page (the API docs designate this endpoint for full-gallery archives). Enable it in the options (**Use one-shot server archive downloads**). It applies to ZIP/CBZ output only, and any failure (invalid key, feature flag off, rate limit, network error) automatically falls back to the page-by-page pipeline.

---

## Installation

### From the Release folder (development build)

1. Go to the extension's folder (`NHDW_Release_v3.0.0`).
2. Open `chrome://extensions/` in Chrome/Brave/Edge.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `NHDW_Release_v3.0.0` folder.

### Firefox

Firefox (desktop and Android) is fully supported via the separate `NHDW_Firefox_v1.0.0` package (v1.4.3). It uses Firefox MV3 event pages (`background.scripts`), the website-embedded header UI drawer, and full parity with Chrome's multi-site download pipeline. See [`NHDW_Firefox_v1.0.0/README.md`](../NHDW_Firefox_v1.0.0/README.md).

---

## Options

The most-used settings — the nhentai API key and the file-name template — are also available inside the popup's **Settings** tab, so you can change them on the fly. The full options page (below) stays available for everything else.

| Setting | Description |
|---|---|
| **Download format** | ZIP, CBZ, PDF, or Raw (numbered images in a titled folder, grouped under a configurable master folder) |
| **Display checkboxes** | Show/hide selection checkboxes on listing pages |
| **Dark mode** | Dark theme for the popup |
| **Duplicate behaviour** | Rename = keep both (adds the gallery ID to the duplicate); Ignore = skip the duplicate, existing file untouched |
| **Download separately** | Each selected gallery as its own archive |
| **HTML parsing** | Use page HTML instead of the API for metadata |
| **Max concurrent downloads** | Parallel image fetches (1–15) |
| **nhentai API key** | Optional key for API key mode (stored locally, never synced) |
| **Server archive downloads** | Experimental one-shot ZIP/CBZ via the API (requires key) |
| **Name template** | Checkboxes for each part of the filename (see below); manual input only for custom templates |
| **Replace spaces** | Replace spaces with underscores in filenames |

### Name template placeholders

| Placeholder | Description |
|---|---|
| `{pretty}` | Pretty title |
| `{english}` | English title |
| `{japanese}` | Japanese title |
| `{id}` | 6-digit gallery ID |
| `{artist}` | Artist name(s) |
| `{group}` | Group/circle name(s) |
| `{character}` | Character name(s) |
| `{language}` | Language tag |

---

## Building from source

```bash
cd NHDW_Extension_v3.0.0
npm install
npm run build        # produces js/*.js
```

The built files go into `js/`. Copy them to the release folder:

```bash
cp -a js/. ../NHDW_Release_v3.0.0/js/
```

### Running tests

```bash
npm test                          # 587 unit tests (offline, Chrome tree)
npm run test:smoke                # smoke checks for background + offscreen
npm run test:e2e                  # window-less end-to-end pipeline tests
npm run test:live                 # optional live nhentai API test (anonymous)
NH_API_KEY=<key> npm run test:live  # + keyed checks: key verification, keyed
                                  #   metadata, archive-endpoint availability
```

---

## A quick note about the Chrome Web Store

This extension was removed from the Chrome Web Store on 04/12/2020 because it does not comply with the store's content policy (mature content).  
Over its 2-year store presence it had a rating of 4.3/5 and 12 858 users.

![Chrome Store stats](Preview/Chrome.png)

---

## License

MIT