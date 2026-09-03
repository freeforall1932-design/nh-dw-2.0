# Folder-naming system — study, root cause, and fix (v3.3.1)

**Symptom (user report):** "the folder naming system doesn't work" — downloaded
artifacts do not appear under the configured names/folders (raw pages should
land in `Downloads/NHDW/<Title>/001.jpg…`, archives as `<Title>.zip/.cbz/.pdf`).

**Method:** the deprecated sources in `old deprecated source code/` were
unpacked (RAR) and studied for how the older, working projects named output
folders and files; the findings were combined with the Chromium API
documentation and bug tracker to explain why the current implementation can
still lose names in a real browser.

---

## 1. What the deprecated projects did

All archives were unpacked to a scratch directory with the pure-JS/WASM
`node-unrar-js` extractor (no system RAR tool was available):

| Archive | Project | Naming approach |
| :--- | :--- | :--- |
| `NHentaiDownloader-2.2.0.rar` | direct ancestor of this code base (2.2.0, MV2) | ZIP mode: one folder inside the ZIP named by the popup's path input (`self.#zip.folder(self.path)`). Raw mode: **flat** files in the Downloads root — `path.replace(/[\\\/:"*?<>|]/g, '') + "-" + page` → `Title-001.jpg`; all slashes (incl. `/`) were stripped, so no subfolders were ever requested. |
| `NHxD-1.0.0.9.rar` / `-master.rar` | C#/WinForms downloader (token system) | Template tokens (`{artist}`, `{title}`, …) plus `SanitizePath`/`SanitizeFileName` modifiers built on .NET's `Path.GetInvalidFileNameChars()`; invalid characters are **replaced with `_`** (not stripped) and trailing dots are eaten — the battle-tested Windows rules this repo's `cleanName`/`sanitizeArtifactFilename` already mirror. |
| `nhentai_archivist-3.10.0.rar` | Rust archiver | Configurable title type for folder names, optional library splitting; folder names come from a chosen title and rely on OS-validated writes with sanitized retries. Confirms the title→folder-name direction. |
| `GitHubFolderDownloader.V1.3.1.rar` | utility used to fetch the old sources from GitHub | Not naming-related. |

Key observation: the old 2.2.0 code handed **flat** names to
`chrome.downloads.download()` (`Title-001.jpg`). The 3.x redesign intentionally
upgraded raw mode to subfolder names (`NHDW/<Title>/001.jpg` — see README
"raw mode" and the 3.3.0 release notes). That upgrade is what the failure
report is about: **the subfolder naming never survived real-browser use**,
although every offline fixture test passes.

## 2. Root cause (outside sources)

The Chromium documentation for `chrome.downloads` states, in the
`FilenameSuggestion` section:

> "**filename is ignored if there are any onDeterminingFilename listeners
> registered by any extensions**"
> — https://developer.chrome.com/docs/extensions/reference/api/downloads

This is the long-standing **Chromium bug 579563** (open since 2016): the
`filename` passed to `chrome.downloads.download()` is only a *suggestion*, and
the moment **any** installed extension — a download manager (IDM, Free
Download Manager, JDownloader connector, Video DownloadHelper, some
antivirus/cloud-drive helpers) — registers an `onDeterminingFilename` listener,
Chrome silently discards the requested name/path of **every** other extension's
API downloads. References:

- Chromium bug tracker: https://issues.chromium.org/issues/579563
  (https://bugs.chromium.org/p/chromium/issues/detail?id=579563)
- Stack Overflow, "Specifying path/filename in downloads.download() api not
  working in Chrome but does in Firefox" —
  https://stackoverflow.com/questions/55991260/ (diagnosis + workaround:
  register your own `onDeterminingFilename` listener and re-suggest the name
  for the downloads you started yourself, matched by download id / extension id)
- Worked example of the URL→filename map pattern:
  https://note.com/st_dev0/n/na75e8e95cdd2

Consequences for this extension when such a helper is installed:

- **Raw mode** (`NHDW/<Title>/001.jpg`): Chrome falls back to the CDN URL's
  own basename → `1.jpg`, `2.jpg`, … land in the **root** of Downloads. The
  whole folder-naming system appears "broken".
- **ZIP/CBZ/PDF blob saves** that go through the worker relay
  (`saveDownload`) instead of the offscreen anchor: the title name is dropped
  in favor of the blob UUID.

The old 2.2.0 code did not dodge this — its flat names would equally degrade
to URL basenames — but flat degradation (`1.jpg` instead of `Title-001.jpg`)
is less visible than losing an entire folder structure, which is why the 3.x
"folder naming system" felt newly broken.

## 3. The fix (v3.3.1)

New module **`NHDW_Extension_v3.0.0/src/background/downloadNaming.ts`**:

- `recordDownloadRequest(url, filename)` — called **before** every
  `chrome.downloads.download()` (worker `saveDownload` relay and the worker
  fallback path in `Downloader.#saveArtifact`) and before every offscreen
  anchor save (new `recordDownloadName` relay message). The event can fire
  before the `download()` callback returns the downloadId, hence the URL-keyed
  map; `bindDownloadId(url, id)` adds the exact id match once known.
- `installDownloadFilenameGuard()` — registers our own
  `chrome.downloads.onDeterminingFilename` listener **synchronously at the top
  level of the service worker** (MV3 event-registration rule) and re-suggests
  `{filename, conflictAction: "uniquify"}` for downloads we recorded:
  - never touches downloads attributed to a *different* extension
    (`item.byExtensionId`);
  - blob:/data: matches are always ours (extension-origin artifacts);
  - unknown downloads get `suggest()` (default naming) — the guard never
    interferes with normal browsing;
  - names are mirrored into `chrome.storage.session` so a worker restart
    mid-gallery cannot lose the mapping, pruned on completion
    (`downloads.onChanged`) and at a 600-entry FIFO cap.
- Firefox: `onDeterminingFilename` does not exist there and Firefox never had
  the suppression bug, so the guard is a no-op (checked at runtime).

Wiring changes:

- `src/background/background.ts` — top-level `installDownloadFilenameGuard()`;
  `saveDownload` records + binds + passes `conflictAction: "uniquify"`;
  new `recordDownloadName` action for offscreen anchor saves.
- `src/background/Downloader.ts` — worker-fallback `#saveArtifact` records +
  binds + `conflictAction: "uniquify"` (also stops re-downloads from silently
  overwriting earlier ones).
- `src/offscreen/offscreen.ts` — `saveBlobViaAnchor` announces the blob's name
  to the worker before clicking the anchor.

## 4. Known limits (documented honestly)

- Chrome's override rule is "the **last installed** extension whose listener
  suggests a name wins". If a download manager that actively suggests names
  was installed **after** this extension, it can still outrank the guard;
  the guard deterministically fixes the far more common cases (helper merely
  *listening*, or installed before this extension). Disabling/removing the
  conflicting helper always restores naming.
- `conflictAction: "uniquify"` now applies uniformly, so re-downloading the
  same gallery yields `Title (1).zip`-style siblings instead of silent
  overwrites.

## 5. Verification

- `npm test` — 176 passing (10 new: `test/download-naming.test.js` covers
  re-assertion by URL/id, foreign-attribution exclusion, post-completion
  hygiene, session-mirror restart recovery, Firefox no-op, FIFO cap, missing-
  chrome resilience).
- `npm run test:smoke` — worker + offscreen bundles still load as MV3 contexts.
- `npm run test:e2e` — worker, offscreen, relay (incl. `saveDownload`),
  content scripts all green.
- Real-browser spot check (local machine, per README):
  1. install a download-manager extension that hooks downloads,
  2. raw-download a gallery → pages must land in `Downloads/NHDW/<Title>/`
     as `001.jpg`…,
  3. ZIP/CBZ/PDF must keep the title-based name.

Version bumped to **3.3.1** in `NHDW_Release_v3.0.0/manifest.json` and
`NHDW_Firefox_v1.0.0/manifest.json`; `js/` of both release folders re-synced
from the source build (`diff -rq` clean).
