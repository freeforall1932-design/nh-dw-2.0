***

# 🚀 NHentai Downloader v3.0.0

A Chrome extension for batch downloading full-size image archives directly from nhentai.net.

## ✨ Key Features
* **Batch Download:** Grabs all full-size images from a gallery (not just thumbnails).
* **Seamless Integration:** Injects selection checkboxes directly onto nhentai.net listing pages.
* **Smart Scraping:** Automatically converts thumbnail URLs to high-quality, full-size images.
* **Client-Side Zipping:** Creates `.zip` archives locally without relying on external servers — or, if you prefer the old-school layout, **one folder of images per gallery** (Options → *Download format: Images in a folder*).
* **Large-gallery safe:** the finished archive is handed to Chrome through an MV3 *offscreen document* (real object URL), so huge galleries no longer go through a memory-hungry base64 round-trip in the service worker.
* **Manifest V3 Compliant:** Fully updated for the latest Chrome extension requirements.

## 📦 Prerequisites
* **Google Chrome** (Version 88 or higher recommended).
* The extracted extension folder: `NHDW_Release_v3.0.0`

## 🛠️ Installation
1. Open Chrome and navigate to `chrome://extensions/` (or go to **Menu > Extensions > Manage Extensions**).
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `NHDW_Release_v3.0.0` folder from your extracted files and click **Select Folder**.
5. **Verify:** Ensure "NHentai Downloader" v3.0.0 appears in your list without any red error messages.

## 🎮 How to Use

Open a page on nhentai.net, then click the **NHentai Downloader** icon in your Chrome toolbar. The popup handles both cases:

### Single gallery
1. Navigate to a gallery page (e.g., `https://nhentai.net/g/123456/`).
2. Click the extension icon. The popup shows the detected title and page count.
3. Optionally edit the save name/path, then click **Download**.
4. The extension fetches the full-size images, zips them locally, and hands the archive to Chrome's download manager (`[Title].zip`, `.cbz`, or a `[Title]/` folder of images if configured in Options).

### Search / category pages (batch)
1. On a search, tag, artist, or category page, each thumbnail caption gets an
   **"NHentai Downloader: Add to downloads"** checkbox (toggle in the extension options).
2. Tick the galleries you want, then click the extension icon.
3. The popup lists every gallery found on the page (pre-ticked from your selection).
   Use **Invert all** / **Clear all** as needed, set the save name, and click **Download**
   to get everything in a single archive. If the results span several pages you can use
   **Download all (N pages)**.

> **Note:** nhentai.net sits behind Cloudflare. If a request is challenged,
> open the **gallery page itself**, complete any challenge, and retry. Metadata
> is read from the open tab (`window._gallery`). ZIP pages are fetched through
> that tab when possible, then from the extension origin. Batch metadata and
> listing pages are also requested through your open nhentai tab's session
> before falling back to the extension origin. This is **not** a
> Cloudflare bypass — a “Just a moment…” interstitial has no gallery JSON and
> cannot supply image bytes. If the popup shows the gallery but the ZIP fails
> with an image error, keep the gallery tab open and try again.

## ⚙️ Troubleshooting

| Issue | Solution |
| :--- | :--- |
| **"Service worker registration failed"** | Ensure you loaded the `NHDW_Release_v3.0.0` folder directly, not a subfolder. Check the Chrome console (F12) for specific errors. |
| **Popup shows "not on nhentai.net"** | The active tab must be on `nhentai.net` (gallery, search, tag, artist, or category page) when you open the popup. |
| **Download fails or empty ZIP** | Check your internet connection. Ad-blockers may block images; try disabling them for nhentai.net. |
| **Cloudflare / 403 errors** | Complete the browser challenge on the site first, then retry. Logging in to nhentai sometimes helps. |
| **Extension icon missing** | Click the "Puzzle Piece" icon in the Chrome toolbar and pin "NHentai Downloader". |

## 📝 Version History
* **v3.0.0 (current):** Manifest V3 rewrite. Tab-first gallery metadata and tab-first image fetches (your open gallery tab is used for both), offscreen-document downloads that only ever use the APIs Chrome actually exposes there (object URLs in the document, `chrome.downloads` in the service worker), folder-of-images output option, CDN mirror fallback, and a real-browser e2e suite.
* **v3.0.0 (initial):** Complete rewrite for Manifest V3. Fixed service worker errors, added batch downloading, integrated JSZip locally, and removed deprecated APIs.
* **v2.2.0:** *(Deprecated)* Original source code base.

## 🧪 Development: building and testing

From `NHDW_Extension_v3.0.0/` (Node 18+):

```bash
npm install        # once
npm run build      # webpack -> js/*.js (background, content, offscreen, popup, options...)
npm test           # fixture tests: parsers, filename utils, Downloader URL/ZIP/raw/object-URL logic
npm run test:smoke # load built bundles in a window-less VM (MV3 worker / offscreen document)
npm run test:e2e   # full pipelines against chrome/fetch/DOM stubs (worker, offscreen,
                   # service-worker relay, content script injection), zero network access
npm run test:live  # opt-in live check against the real nhentai API
npm run test:browser  # REAL browser end-to-end: loads NHDW_Release_v3.0.0 in actual
                      # Chrome/Brave/Chromium and downloads a ZIP through the real
                      # extension (service worker, offscreen document, chrome.downloads)
```

The test suite runs entirely offline (mocked `chrome`, `fetch`, `URL.createObjectURL`);
the single live API check is opt-in via `npm run test:live`.

### Real-browser end-to-end test

`npm run test:browser` (or `sudo node scripts/e2e-browser.js --extension ../NHDW_Release_v3.0.0`)
launches a real Chromium-family browser with the packed extension loaded and drives it over
the DevTools Protocol: service worker startup, popup rendering, content scripts on
nhentai-style pages, the offscreen-document ZIP pipeline, and the produced ZIP on disk are
all verified. nhentai.net itself is simulated locally (HTTPS fixture + `--host-resolver-rules`),
so no real nhentai account or Cloudflare clearance is needed.

* Browser selection: `--browser /path/to/chrome` (or `BROWSER_BIN`), works with Google Chrome,
  Chromium, and Brave. Must be an extension-capable build (serverless builds such as
  `@sparticuz/chromium` have extensions compiled out and will fail the first check).
* Run with elevated privileges so the script can bind its local nhentai fixture to port 443
  (otherwise the content-script and real-fetch sections are skipped with a hint).
* CI: a ready-to-use GitHub Actions workflow that runs the offline suites plus the browser
  suite in real Google Chrome and real Brave on GitHub-hosted runners is included in
  `SESSION_HANDOFF.md` (the sandbox token cannot write `.github/workflows` files — copy
  the YAML to `.github/workflows/e2e-browser.yml` to enable it).
