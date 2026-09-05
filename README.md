***

# 🚀 NHentai Downloader v3.0.0

A Chrome extension for batch downloading full-size image archives directly from nhentai.net.

## ✨ Key Features
* **Batch Download:** Grabs all full-size images from a gallery (not just thumbnails).
* **Seamless Integration:** Injects selection checkboxes directly onto nhentai.net listing pages.
* **Smart Scraping:** Automatically converts thumbnail URLs to high-quality, full-size images.
* **Client-Side Archiving:** Creates `.zip`/`.cbz` archives or a single high-quality `.pdf` locally without relying on external servers — or get the loose images instead: **raw mode** saves each gallery as numbered pages (`001.jpg`…) in a titled folder, grouped under one configurable master folder (Options → *Folder for raw downloads*, default `NHDW/`).
* **Large-gallery safe:** the finished archive is handed to Chrome through an MV3 *offscreen document* (real object URL), so huge galleries no longer go through a memory-hungry base64 round-trip in the service worker.
* **Same four formats everywhere (3.4.0):** ZIP / CBZ / PDF / raw are now offered on listing pages too (homepage, search, artist, tag, genre), not just on a single title.
* **Separate files or one merged file (3.4.0):** list downloads default to **one file per title**, named from the gallery's own metadata. The old "everything in one archive" behaviour is still there as an explicit opt-in.
* **Never an accidental tankoubon (3.4.0):** merging several *different* titles into one PDF always asks for confirmation first, with "one PDF per title" as the default answer.
* **Side panel (3.4.0):** the toolbar button opens a dockable, resizable side panel instead of the hovering popup. The popup is kept as a fallback and you can switch back in Settings.
* **In-page Download / Select buttons (3.4.0):** every gallery card on a listing page gets its own Download button and Select box, plus a floating bar showing "N selected -> format -> Download" — so you never have to open the extension.
* **Remembers what you downloaded (3.5.0):** re-running the same listing (search / tag / artist / homepage) skips galleries that finished downloading before, so you stop getting "Title (1).zip", "Title (2).zip" duplicates. Already-downloaded rows show a ✓ badge with the saved file name and their own *Download anyway* link; the in-page bar shows "N selected · M already downloaded · K will download" and skipped galleries cost **zero** API calls. Skipping is **verify-then-redownload**: a recorded gallery is only skipped while its file still exists on disk (Settings → *Verify downloaded files exist*, default ON), so a deleted file is fetched again on the next run. A single-file (merged) job never skips — one archive needs every selected title — and it is remembered only when the whole job finished; if the merged file already exists it warns first and then saves a new copy as `_part2`, `_part3` …. Merged / batch names carry the date stamp (`search_31082026.zip`, Settings → *Date in merged names*, default ON) and the history records that exact dated file name. The list lives in this browser only, and Settings has a *Clear history* button.
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
4. The extension fetches the full-size images, packs them locally, and hands the result to Chrome's download manager (`[Title].zip`, `[Title].cbz`, `[Title].pdf`, or numbered raw pages under `NHDW/[Title]/` if configured in Options).

### Search / category pages (list mode)

You can work either from the page itself or from the panel — both do exactly the same thing.

**From the page (no panel needed):**
1. Hover a gallery card: a **Download** button and a **Select** box appear on it.
2. **Download** grabs that one gallery immediately, using the list-mode settings.
3. Ticking **Select** on several cards raises a floating bar at the bottom of the
   page: `N selected` + a **format** picker + an **output** picker + **Download**.
4. Turn the whole thing off in Settings -> *Download / Select buttons on listing cards*.

**From the panel:**
1. Click the extension icon (side panel by default). It lists every gallery found
   on the page, pre-ticked from your selection.
2. Choose the **Format** (ZIP / CBZ / PDF / Raw) and the **Output**:
   * **Separate files (one per title)** — the default. One archive, or one folder for
     raw, per title, named from the list-mode file-name template and that gallery's
     own metadata.
   * **Single merged file (all titles)** — the old behaviour: everything in one
     archive, named after the box below the picker.
3. Optionally untick **Put everything in the Downloads/NHDW/ folder** to save straight
   into the download folder. The wrap is a choice, not something forced on you.
4. Use **Invert all** / **Clear all** as needed and press **Download selected**. If the
   results span several pages, **Download all (N pages)** walks them.

> **Merging different titles into one PDF** produces a single continuous document,
> like a tankoubon — the individual titles cannot be separated afterwards. That
> combination (PDF + *Single merged file* + more than one title) always asks first,
> with **Switch to separate files** as the default answer. It is independent of the
> existing "you are going to download N pages" confirmation; both can appear.

### Where the list-mode settings live

Settings tab of the panel (or the full Options page) -> **List mode**:

| Setting | Default | What it does |
| :--- | :--- | :--- |
| Format | ZIP | Which of the four formats list downloads use. Stored separately from the single-title format, so changing one never changes the other. |
| Output | Separate files | One file per title, or one merged file for everything. |
| Master folder | On | Wrap list downloads in `Downloads/NHDW/` (the folder name is the one under *Folder for raw downloads*). |
| List-mode file name | Same as single title | Its own template with the same tokens. Resolved per gallery from that gallery's metadata — never from the page URL. |

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
| **Files land in the Downloads root as `1.jpg`, `2.jpg`… or under random UUID names** | Another extension (download manager, antivirus, cloud-drive helper) that hooks Chrome's download naming makes Chrome ignore the requested file names/folders (Chromium bug 579563). v3.3.1 added a filename guard that re-asserts the requested names for this extension's downloads. If a download manager installed *after* this extension still wins, disable it — Chrome gives the last-installed extension's listener the final say. |
| **Chrome says *another extension determined a different filename* for a download that has nothing to do with nhentai** | Fixed in v3.4.1. Up to 3.4.0 this extension stayed registered on Chrome's profile-wide filename event even when idle, so it could be named in that message for another site's downloads. It now joins that event only while its own downloads are running. If you still see the message, the extension named in it is a different one. |
| **Cloudflare / 403 errors** | Complete the browser challenge on the site first, then retry. Logging in to nhentai sometimes helps. |
| **Extension icon missing** | Click the "Puzzle Piece" icon in the Chrome toolbar and pin "NHentai Downloader". |
| **Toolbar click opens nothing / I want the old popup back** | Settings -> *Interface* -> **Toolbar click opens**. `Side panel` needs Chrome 114+; on older builds the popup is used automatically. |
| **Two checkboxes on each gallery card** | The legacy caption checkbox is hidden while the in-page card controls are on. If both show, reload the nhentai page; to keep only the old one, turn off Settings -> *Download / Select buttons on listing cards*. |
| **A list download is named after the page URL** | That was the pre-3.4.0 behaviour of the merged single-file mode. Switch **Output** to *Separate files* (the new default) — each file is then named from the list-mode template and that gallery's own metadata. |
| **A download failed but the notice did not say which gallery, and there was no way to retry** | Fixed in v3.6.0. Every failure now names the gallery (title + id + reason) and the panel offers **Retry failed**, which re-downloads exactly those titles with the same format / master folder / name template as one file per title. Failed galleries stay listed at the top of the panel (with *Retry* / *Dismiss*) until you deal with them or close the browser, so closing the panel mid-batch no longer loses them. Failed galleries are never marked as downloaded. |
| **Raw mode: a gallery was "complete" but a page was missing (or Chrome showed 200 downloads at once)** | Fixed in v3.6.0. Raw pages go through Chrome's download manager, and the extension used to count a page as saved the moment the download *started*, so a page interrupted afterwards (network drop, disk full, cancelled in the download shelf) went unnoticed and the gallery was recorded as downloaded with a page missing. Each file is now followed until it is actually written: an interrupted page is retried (up to 5 times), and if it still fails the gallery is reported as failed and **not** recorded, so the next run of the same listing fetches it again. Raw mode also has its own cap on simultaneous downloads (Settings → *Raw images: files saved at the same time*, default 3) instead of flooding the download shelf. |
| **Re-running a search re-downloads everything I already got (or makes "Title (1).zip")** | Fixed in v3.5.0: the extension remembers every gallery that downloaded successfully in this browser and skips it on listing pages. Each already-downloaded row has a ✓ badge with its file name and a *Download anyway* link if you want it again; Settings → *Download history* → *Clear history* forgets everything. Galleries downloaded before v3.5.0 are not remembered automatically — the first run after updating still downloads them. Skipping is *verify-then-redownload* by default: the file is only treated as already-downloaded while it still exists on disk, so a deleted file is fetched again on the next run (Settings → *Verify downloaded files exist* to turn that off). A *Single merged file* job never skips; when the dated merged file already exists it asks first and then saves `_part2`, `_part3` …. |

## Known limitations and things still under review

* **`raw` format is labelled "(testing)".** It writes one folder of loose
  images per title and always behaves as *Separate files*, but folder creation
  has not yet been confirmed across every platform. Prefer ZIP/CBZ/PDF if you
  need certainty. Since v3.6.0 a raw gallery with a page that could not be
  written is reported as failed (by name, with *Retry*) rather than recorded as
  complete; the pages that did arrive stay in the folder and a retry saves the
  gallery again next to them (`uniquify`: `001 (1).jpg`), it does not delete
  the defective folder.
* **Service-worker restarts during a very large gallery.** Chrome may shut the
  extension's worker down mid-download and the browser keeps downloading
  without it. Names are restored from a session mirror when the worker wakes,
  but a file that Chrome names in the split second before that happens can keep
  its default name. Re-downloading that one page fixes it.
* **Filenames while another download manager is installed.** Since v3.4.1 this
  extension only takes part in Chrome's filename decision while its own
  downloads are running. If a download manager installed *after* it still wins
  a name, Chrome gives the last-installed extension the final say — disable it
  for the duration of the download.
* **The Firefox port lags.** `NHDW_Firefox_v1.0.0` is still at 3.3.1 and has
  none of the 3.4.0 list-mode or 3.4.1 naming work. It received the 3.6.1
  error-message hardening so a failed raw page shows its real reason instead
  of `[object Object]`, but the 3.6.0 completion tracking and retry UI are not
  ported there yet.
* **The queue list is still name-only.** Thumbnails, per-item progress, and
  per-item cancel/retry are planned, not built.
* **Download history is local and starts empty.** The remembered list lives
  in `chrome.storage.local` of this browser (never synced) and only knows
  downloads that finished after v3.5.0 was installed. Re-installing the
  extension or clearing site data clears it too. With *Verify downloaded
  files exist* on, `chrome.downloads` can only see files this browser profile
  downloaded: a file copied in by hand, moved after Chrome recorded its path,
  or a cleared browser download history counts as missing and is downloaded
  again (you keep the newest copy). The record itself is the durable link.

## 📝 Version History
* **v3.6.4 (current): one format decision per job.**
  A download job's output format used to be derived in several places from
  several inputs (per-job override here, stored default there, `"zip"` as a
  last resort). One real consequence: a merged (single-file) batch with no
  explicit format choice computed its disk candidates and part numbering for
  `.zip` while the archive on disk was `.cbz`/`.pdf` — so the *you already
  have this file* warning could never match, and every re-run grew another
  `_partN`. The format is now resolved **once** per job
  (`resolveJobFormat`: per-job override → stored default → zip) and that one
  value is used for the Downloader settings, the history record, the retry job
  and the merged artifact name. Retired `"folder"` settings map to PDF on both
  sides. Tests: unit cases for the resolver plus a batch-level contract (the
  record, the Downloader settings and the retry job must all agree for every
  format, including when no format is sent) and two end-to-end worker phases
  (stored CBZ names both the file and the record; a merged re-run warns with
  the real `.cbz` name instead of starting a duplicate).
  A self-review of this change also closed a gap two earlier releases missed:
  the **batch-level** error path (`downloadAllDoujinshis` /
  `downloadAllPages`, worker fallback *and* offscreen, plus the
  "unable to start the offscreen document" reply) still stringified its error,
  so an object-shaped batch failure rendered `[object Object]` in the popup —
  the same report shape 3.6.1 removed elsewhere. Those paths, the popup
  preview status line, the API-key verification failure and the error panel
  itself are message-first now; a worker e2e phase reproduces the old
  `[object Object]` output on the pre-fix build.
* **v3.6.3: one shared batch pipeline.**
  The worker fallback and the offscreen document used to each keep a copy of
  `downloadAllDoujinshisAsync`; they had already drifted (HTML second-chance
  parse, tab refetch, `Authorization` on the direct fetch, queued progress).
  Both now wrap one storage-free core (`src/utils/batchPipeline.ts`) with
  injected IO, so metadata validation, retry jobs and history records cannot
  diverge again. The core never touches `chrome.storage` / `chrome.downloads`
  (offscreen still uses `chrome.runtime` only). Download-all-pages now
  remembers failed galleries the same way a selected-gallery batch does.
* **v3.6.2: batch metadata, error UI, history names, merged duplicates.**
  Four follow-ups from the 3.6.0/3.6.1 review. (1) A metadata route that
  returns 200 with non-gallery JSON (`{}`, `{error:…}`) now fails **that
  gallery only** — remaining titles continue, the summary names it, and
  nothing is recorded for it; previously `json.title.pretty` threw outside
  the per-gallery try and killed the whole batch. (2) A popup error always
  offers **Go Back** (Retry still only when the gallery can be re-added), so
  a batch-level failure no longer leaves the panel with zero buttons.
  (3) History records now use the same filename sanitizer as the save path,
  so verify-before-skip can match files whose master folder or name contained
  `:`, trailing dots/spaces, or over-long segments. (4) Merged jobs never
  silently drop a duplicate-titled gallery under *Ignore* — the second title
  is id-suffixed so the archive still contains every selected gallery;
  separate-mode Ignore counts the skip in the summary. Console retry/archive
  warnings also unwrap object errors (no more `[object Object]` in the log).
* **v3.6.1: raw-mode failures always show their real reason.**
  A raw page that Chrome refuses to start used to surface as
  *Failed to download original image (Error: [object Object])* — the browser's
  error object was stringified (`[object Object]`), wrapped in an `Error`, and
  then stringified again (adding `Error:`). Every boundary in the save path
  (worker → offscreen relay → Downloader) now unwraps the error's `.message`
  first and falls back to readable text, so the retry loop and the panel name
  the actual reason (invalid filename, permission, disk error …). The stale
  `NHDW_Firefox_v1.0.0` snapshot received the same hardening. *If you ever see
  this `[object Object]` message, the extension you ran was **older than
  3.6.0** — reload the current build; the error itself was reported from
  exactly the v3.4.1 `offscreen.js` in the filed log.*
* **v3.6.0: Named failures with Retry; raw mode waits for every page.**
  Every failed gallery is now reported **by name** (title, id and the reason)
  — in the single-title error, in the end-of-batch summary and in a notice at
  the top of the panel that persists for the browser session (the worker keeps
  the list in `chrome.storage.session`), so closing the panel mid-batch no
  longer loses track of what did not download. **Retry failed** re-sends exactly
  those titles with the settings they ran under (format, master folder, name
  template) as separate files, bypassing the history guard; *Dismiss* forgets
  them; a title that later succeeds drops off the list automatically. Failed
  galleries are still never recorded in the download history. Raw mode (one
  browser download per page) used to treat "download started" as "page saved",
  so a page interrupted afterwards (network drop, disk full, cancelled in the
  shelf) went unnoticed and the gallery was recorded complete with a page
  missing — and nothing throttled it, so a large gallery became hundreds of
  simultaneous downloads. Each browser download is now followed to its terminal
  state (`chrome.downloads.onChanged` + a slow `search()` poll as a safety net;
  the offscreen document asks the worker in bounded 45-second slices so no MV3
  message is held open long enough to get the worker killed; a download that
  never finishes is stopped after 4 minutes and counted as failed). An
  interrupted page goes through the existing retry loop; when the retries are
  exhausted the gallery fails and is listed by name. A new *Raw images: files
  saved at the same time* setting (1–10, default 3) caps in-flight raw
  downloads independently of the archive fetch concurrency. Browsers whose
  downloads API lacks `onChanged` keep the previous behaviour.
* **v3.5.0: Persistent download history — "already downloaded" is skipped.**
  The extension now remembers every gallery that downloaded successfully
  (keyed by gallery ID, in `chrome.storage.local`) and skips it when the same
  listing is re-run (search / tag / artist / homepage). The panel shows a ✓
  badge with the saved file name per row, live counts ("N selected · M already
  downloaded · K will download") before committing, and a per-row *Download
  anyway* override; the in-page floating bar shows the same counts and a bulk
  *Include already downloaded* toggle. Skipped galleries cost zero metadata or
  API calls — the UI filters them out before enqueuing, and the offscreen
  pipeline re-checks the same recorded list as an authoritative guard (via the
  worker, which owns `chrome.storage.local`; the offscreen document still
  touches `chrome.runtime` only). Records are written on successful completion
  only, never on enqueue: per-gallery records in separate mode, and a merged
  single-file job records all of its titles only when the whole job succeeded
  (a failed or cancelled merge records nothing, so it can be re-run cleanly).
  Partial galleries (any failed page) are never recorded — nhentai publishes no
  content hash, so byte identity cannot be verified. *Clear history* lives in
  Settings (popup tab and options page). Two refinements follow the user's
  decisions: **separate-mode verify-before-skip** (default ON, Settings →
  *Verify downloaded files exist*) only skips a recorded gallery when
  `chrome.downloads.search` still finds its file — deleted files are
  downloaded again automatically, and the toggle OFF restores record-only
  skipping; **merged mode never skips** — one archive needs every title, so
  when the file already exists it warns first, then proceeds on confirmation
  (no automatic overwrite). **Merged/batch names get the date** (*Settings →
  *Date in merged names*, default ON): a merged listing save is
  `search_31082026.zip`, the history records that dated name, and the same
  title+date again becomes `_part2`, `_part3` … (a deleted file's old name is
  reused instead of growing part numbers forever).
* **v3.4.1:** Cross-extension naming-leak fix. The 3.3.1 folder-naming guard registered Chrome's global `onDeterminingFilename` event at worker startup and never released it. That event is profile-wide: registering it made this extension a participant in the filename decision for **every** download, so Chrome could blame it for files started by unrelated extensions (*"failed to name the download ... because another extension determined a different filename"*). Returning early for a foreign download does not help — participation is what counts. The listener is now reference-counted against this extension's own pending downloads: attached when the first filename is recorded, detached as soon as the pending set drains (suggestion consumed, download complete, interrupted, cancelled, failed to start, 30-minute TTL, or FIFO eviction). An idle worker is no longer in the chain at all, and while it is, downloads it did not start get an untouched pass-through — never an empty name. Own filenames, folders, master-folder wrapping and `uniquify` behaviour are unchanged.
* **v3.4.0:** List mode gets everything single-title mode had. The four formats (ZIP/CBZ/PDF/raw) come from one shared registry used by the panel, the in-page card buttons and the download pipeline, so the two paths cannot drift. New explicit **output mode** — *Separate files* (one archive, or one folder for raw, per title) is the default and *Single merged file* is the opt-in. List mode has its **own file-name template** (defaults to following the single-title one) resolved per gallery instead of falling back to the page URL, and the master-folder wrap became an **optional checkbox** that now also applies to archives, not just raw. A **PDF-merge confirmation** blocks accidentally concatenating different titles into one tankoubon-style document. UI: a dockable **side panel** (`chrome.sidePanel`) sharing one rendered view with the popup fallback, plus **Download / Select buttons on every listing card** with a floating selection bar.
* **v3.3.1:** Folder-naming guard. When any other extension hooks Chrome's download naming (`onDeterminingFilename`, Chromium bug 579563), Chrome used to silently discard the requested names — raw pages fell into the Downloads root as `1.jpg`, `2.jpg`… and archives could land under blob UUIDs. The new guard (`src/background/downloadNaming.ts`) records every requested name before the download starts and re-asserts it via the extension's own `onDeterminingFilename` listener (session-mirror-backed, restart-safe; no-op on Firefox where the bug doesn't exist). Re-downloads now uniquify (`Title (1).zip`) instead of overwriting.
* **v3.3.0:** Raw master folder (Options → *Folder for raw downloads*, default `NHDW/`), settings inside the popup (3.2.0–3.2.2 line), PDF output, API key mode with first-run gate.
* **v3.0.0:** Manifest V3 rewrite. Tab-first gallery metadata and tab-first image fetches (your open gallery tab is used for both), offscreen-document downloads that only ever use the APIs Chrome actually exposes there (object URLs in the document, `chrome.downloads` in the service worker), folder-of-images output option, CDN mirror fallback, and a real-browser e2e suite.
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
* CI: GitHub Actions runs only the offline suites (`.github/workflows/extension-tests.yml`).
  The real-browser suite is local-only — GitHub-hosted runners cannot launch the MV3
  extension harness (Chrome `Runtime.enable` timeout / Brave SIGTRAP, on every run since it
  was introduced; see `IMPROVEMENT_BACKLOG.md` item 10). Run `npm run test:browser` on a
  machine with a full Chrome/Brave build instead.
