***

# 🚀 NHentai Downloader v3.0.0

A Chrome extension for batch downloading full-size image archives directly from nhentai.net.

## ✨ Key Features
* **Batch Download:** Grabs all full-size images from a gallery (not just thumbnails).
* **Seamless Integration:** Injects selection checkboxes directly onto nhentai.net listing pages.
* **Smart Scraping:** Automatically converts thumbnail URLs to high-quality, full-size images.
* **Client-Side Zipping:** Creates `.zip` archives locally without relying on external servers.
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
4. The extension fetches the full-size images, zips them locally, and hands the archive to Chrome's download manager (`[Title].zip`, or `.cbz` if configured).

### Search / category pages (batch)
1. On a search, tag, artist, or category page, each thumbnail caption gets an
   **"NHentai Downloader: Add to downloads"** checkbox (toggle in the extension options).
2. Tick the galleries you want, then click the extension icon.
3. The popup lists every gallery found on the page (pre-ticked from your selection).
   Use **Invert all** / **Clear all** as needed, set the save name, and click **Download**
   to get everything in a single archive. If the results span several pages you can use
   **Download all (N pages)**.

> **Note:** nhentai.net sits behind Cloudflare. If the metadata request is challenged,
> open the gallery page normally in the tab, complete any challenge, and retry — the
> extension falls back to reading the gallery data from the open page.

## ⚙️ Troubleshooting

| Issue | Solution |
| :--- | :--- |
| **"Service worker registration failed"** | Ensure you loaded the `NHDW_Release_v3.0.0` folder directly, not a subfolder. Check the Chrome console (F12) for specific errors. |
| **Popup shows "not on nhentai.net"** | The active tab must be on `nhentai.net` (gallery, search, tag, artist, or category page) when you open the popup. |
| **Download fails or empty ZIP** | Check your internet connection. Ad-blockers may block images; try disabling them for nhentai.net. |
| **Cloudflare / 403 errors** | Complete the browser challenge on the site first, then retry. Logging in to nhentai sometimes helps. |
| **Extension icon missing** | Click the "Puzzle Piece" icon in the Chrome toolbar and pin "NHentai Downloader". |

## 📝 Version History
* **v3.0.0:** Complete rewrite for Manifest V3. Fixed service worker errors, added batch downloading, integrated JSZip locally, and removed deprecated APIs.
* **v2.2.0:** *(Deprecated)* Original source code base.

## 🧪 Development: building and testing

From `NHDW_Extension_v3.0.0/` (Node 18+):

```bash
npm install        # once
npm run build      # webpack -> js/*.js (background, content, offscreen, popup, options...)
npm test           # fixture tests: parsers, filename utils, Downloader URL/ZIP/raw/object-URL logic
npm run test:smoke # load built bundles in a window-less VM (MV3 worker / offscreen document)
npm run test:e2e   # full download pipelines against chrome/fetch stubs, zero network access
npm run test:live  # opt-in live check against the real nhentai API
```

The test suite runs entirely offline (mocked `chrome`, `fetch`, `URL.createObjectURL`);
the single live API check is opt-in via `npm run test:live`.
