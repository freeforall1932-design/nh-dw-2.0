# NHentai Downloader — Manifest V3

A Chrome/Edge/Brave extension to download doujinshi from [nhentai.net](https://nhentai.net).  
Updated for **Manifest V3** with an offscreen document for reliable ZIP downloads, active-tab Cloudflare fallback, and deterministic fixture tests.

[![CI](https://github.com/Xwilarg/NHentaiDownloader/workflows/CI/badge.svg)](https://github.com/Xwilarg/NHentaiDownloader/actions)

---

## Features

- **Single download** — Open a gallery page, click the extension icon, choose a filename, and download as ZIP, CBZ, or raw images.
- **Batch download** — On search, tag, artist, category, or favorites pages, check the boxes injected next to each gallery card and download them all at once.
- **Multi-page download** — From listing pages with pagination, download galleries across several pages in one operation.
- **Name templates** — Customise filenames with placeholders: `{pretty}`, `{english}`, `{japanese}`, `{id}`, `{artist}`, `{group}`, `{character}`, `{language}`.
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

1. **Popup** — Clicking the extension icon on an nhentai page opens a popup that detects whether you are on a single gallery or a listing page.
2. **Metadata** — Gallery info is fetched from `nhentai.net/api/gallery/<id>` or, if Cloudflare blocks the request, from the active browser tab's page context.
3. **Checkboxes** — On listing pages the content script injects checkboxes next to each gallery card. Tick the ones you want and press **Download** in the popup.
4. **Download engine** — Images are fetched through the open nhentai tab when a tab id is available (page origin and cookies), then from the extension origin against the canonical CDN (`i.nhentai.net`) with automatic fallback through numbered mirrors (`i1`–`i4`). HTML challenge responses are rejected so they never end up inside a ZIP.
5. **ZIP creation** — For ZIP/CBZ formats, pages are collected in memory and archived via JSZip. In supported browsers an **offscreen document** creates a real object URL for the ZIP (no base64 memory blow-up) and survives service-worker idle timeouts.
6. **Raw mode** — Each gallery page is downloaded individually through the browser's own download manager.

---

## 403 / Cloudflare errors

nhentai uses Cloudflare, which may challenge requests that appear automated. The extension mitigates this by:

- Retrieving metadata from the **active browser tab** (`window._gallery` / embedded JSON) instead of hitting `/api/gallery` from the extension origin first.
- Fetching ZIP pages through that **same open tab** when possible, then falling back to an extension-origin CDN request.
- Offering an **HTML parsing** option (Settings → Advanced → Use HTML to get API info) that extracts gallery data from the rendered page.
- Falling back through CDN mirrors when an image server returns a non-image response, and never adding HTML or tiny bodies to the ZIP.

This is **not** a Cloudflare bypass. If the tab is still “Just a moment…”, there is no gallery JSON and no image bytes to read. If metadata succeeds but images fail, keep the gallery tab open after the challenge and try again.

If you still see 403 errors:
- Make sure you are logged into nhentai in the active tab.
- Try again with a different VPN/proxy endpoint.

---

## Installation

### From the Release folder (development build)

1. Go to the extension's folder (`NHDW_Release_v3.0.0`).
2. Open `chrome://extensions/` in Chrome/Brave/Edge.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `NHDW_Release_v3.0.0` folder.

### Firefox

The original extension supported Firefox; the MV3 version requires `chrome.offscreen` and `chrome.scripting` APIs that are not available in Firefox. Use the [legacy release](https://github.com/Xwilarg/NHentaiDownloader/releases) for Firefox.

---

## Options

| Setting | Description |
|---|---|
| **Download format** | ZIP, CBZ, or Raw (images downloaded individually) |
| **Display checkboxes** | Show/hide selection checkboxes on listing pages |
| **Dark mode** | Dark theme for the popup |
| **Duplicate behaviour** | Rename duplicates with a suffix or ignore them |
| **Download separately** | Each selected gallery as its own archive |
| **HTML parsing** | Use page HTML instead of the API for metadata |
| **Max concurrent downloads** | Parallel image fetches (1–15) |
| **Name template** | Filename with placeholders (see below) |
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
npm test                          # 28+ fixture tests (offline)
npm run test:smoke                # smoke checks for background + offscreen
npm run test:e2e                  # window-less end-to-end pipeline tests
npm run test:live                 # optional live nhentai API test
```

---

## A quick note about the Chrome Web Store

This extension was removed from the Chrome Web Store on 04/12/2020 because it does not comply with the store's content policy (mature content).  
Over its 2-year store presence it had a rating of 4.3/5 and 12 858 users.

![Chrome Store stats](Preview/Chrome.png)

---

## License

MIT