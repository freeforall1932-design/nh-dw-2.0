***

# 🚀 NHentai Downloader v3.0.0

A Chrome extension for batch downloading full-size image archives directly from nhentai.net.

## ✨ Key Features
* **Batch Download:** Grabs all full-size images from a gallery (not just thumbnails).
* **Seamless Integration:** Injects a download button directly onto nhentai.net pages.
* **Smart Scraping:** Automatically converts thumbnail URLs to high-quality, full-size images.
* **Client-Side Zipping:** Creates `.zip` archives locally without relying on external servers.
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
You can download galleries using three different methods:

### Method A: Direct Download (Recommended)
1. Navigate to any gallery page on nhentai.net (e.g., `https://nhentai.net/g/123456/`).
2. Click the green **"Download Full Archive"** button injected near the title/options bar.
3. The extension will scrape, zip, and trigger the download for `[ID] Title.zip`.

### Method B: Extension Popup
1. While on a gallery page, click the **NHentai Downloader** icon in your Chrome toolbar.
2. Verify the detected Gallery ID and Title in the popup.
3. Click **Start Download**.

### Method C: Quick Download (Search Results)
1. On search or category pages, look for the small download icons overlaid on gallery thumbnails.
2. Click an icon to instantly download that specific gallery without opening it.

## ⚙️ Troubleshooting

| Issue | Solution |
| :--- | :--- |
| **"Service worker registration failed"** | Ensure you loaded the `NHDW_Release_v3.0.0` folder directly, not a subfolder. Check the Chrome console (F12) for specific errors. |
| **Button not appearing on website** | Refresh the page (F5). Ensure you are on a valid gallery URL (must contain `/g/`). |
| **Download fails or empty ZIP** | Check your internet connection. Ad-blockers may block images; try disabling them for nhentai.net. |
| **Extension icon missing** | Click the "Puzzle Piece" icon in the Chrome toolbar and pin "NHentai Downloader". |

## 📝 Version History
* **v3.0.0:** Complete rewrite for Manifest V3. Fixed service worker errors, added batch downloading, integrated JSZip locally, and removed deprecated APIs.
* **v2.2.0:** *(Deprecated)* Original source code base.
