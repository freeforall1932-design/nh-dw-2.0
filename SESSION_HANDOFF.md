# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-09-04 — **3.4.1: cross-extension naming leak closed.** The
3.3.1 folder-naming guard registered Chrome's profile-wide
`onDeterminingFilename` at worker startup and never released it, so this
extension sat in the filename-decision chain for every download in the browser
and could be blamed for other extensions' files. The listener is now
reference-counted against our own pending downloads — see "Filename-guard
listener lifetime (3.4.1 — newest)" below. Manifest version bumped to 3.4.1.

**Updated:** 2026-09-04 — **3.4.0 landed: list mode reaches parity with
single-title mode.** Format choice (zip/cbz/pdf/raw) + explicit output mode
(separate files vs one merged file, separate is now the default) + list-mode
file-name template + PDF-merge confirmation, plus the P1 side panel and the P2
in-page card controls. Details in "List mode parity (3.4.0 — newest)" below.
Session branch: `arena/01a06a75-nh-dw-2-0`. Landed as PR #33 (CI green).
**One change from that session could not be pushed and is waiting for a human:**
a broader `on.push.paths` list for `.github/workflows/extension-tests.yml`. The
complete intended file is parked in
`NHDW_Extension_v3.0.0/ci/pending-workflows/extension-tests.yml` — see
"CI and workflow files (manual-commit only)" below.

**Updated:** 2026-09-03 — worklist extended with backlog item 27
(Firefox port; docs-only change). Feasibility audit:
`NHDW_Firefox_v1.0.0/PORTING_AUDIT.md`.

**Updated:** 2026-09-01 (after the CI cleanup landed: the failing
real-browser GitHub Actions jobs were removed via the web UI, replaced by
`.github/workflows/extension-tests.yml` — first run **green** (~1m, 163
mocha fixtures + smoke + VM e2e); docs companion PR #29 merged; README CI
bullet fixed in PR #30)

- Session branch of the current session: `arena/01a06a75-nh-dw-2-0`. Always
  use the current session branch (check `git branch --show-current`). The
  previous session branch `arena/01a023e5-nh-dw-2-0` is **merged and closed**
  (final PR #29); before that sessions used `arena/01a027b3-…`,
  `arena/01a02b04-…`, `arena/01a02397-…`. Do not trust older branch names in
  historic handoff text.
- Merged since the 2026-08-26 update: PR #23 (handoff records PR #22's merge
  commit), PR #24 (keyed live-API probes in the opt-in suite — archive
  availability is headlessly checkable), PR #25 (**hotfix 3.1.1** — remove
  the invalid `permissions` permission that made the extension fail to
  load), PR #26 (**3.2.0** settings inside the popup), PR #27 (**3.2.1**
  title-named blob saves instead of UUID), PR #28 (**3.2.2** mojibake fix in
  UI strings: charset + ASCII-safe text), PR #29 (document the real-browser
  CI removal). Version on `main`: **3.2.2**; this session branch carries **3.3.0**
  (raw master-folder option — see "Archive naming and structure") pending the PR merge.
- CI state: the only workflow is `.github/workflows/extension-tests.yml`
  (offline suites: webpack build → mocha fixtures → smoke → window-less VM
  e2e; triggers on pushes touching the extension/release dirs or the
  workflow itself, plus manual `workflow_dispatch`). The real-browser suite
  stays **local-only** (`npm run test:browser`) — see backlog item 10 for why
  a GitHub-hosted real-browser job can never work.
  **Workflow files are always a manual commit** — the agent's GitHub App has no
  `workflows` permission, so any push touching `.github/workflows/**` is
  rejected outright and takes the whole push with it. Agents must write the
  intended workflow into `NHDW_Extension_v3.0.0/ci/pending-workflows/` instead;
  see "CI and workflow files (manual-commit only)" below.
- PR #22 ("Add optional nhentai API key mode with first-run gate and one-shot
  archive downloads") was merged on 2026-08-26T08:38:07Z as merge commit
  `05cd7c5` (full: `05cd7c537f39d091b01a458519acdd7742051cd7`) —
  https://github.com/freeforall1932-design/nh-dw-2.0/pull/22.
  It incorporated the mid-flight merge of `origin/main` (PRs #18–#21: queue
  controls, pause/resume, popup split + similar galleries, title-named
  archives, PDF output, CDN hardening) and re-validation of the combined
  tree (149 passing / 1 pending, all smoke + e2e green). Follow-up work
  starts from `main` on a fresh session branch.

## Repository and branch

- Checkout: `/home/user/nh-dw-2.0`
- **Only use the current session branch** (check `git branch --show-current`; earlier sessions used `arena/01a027b3-nh-dw-2-0` then `arena/01a02b04-nh-dw-2-0`). Do not trust older branch names in historic handoff text.
- Source: `NHDW_Extension_v3.0.0/`
- Loadable unpacked build: `NHDW_Release_v3.0.0/`
- These are distinct folders. Source contains TypeScript/tests; release is the browser-loadable package. After every build: `cp js/*.js ../NHDW_Release_v3.0.0/js/`, verify `diff -rq js ../NHDW_Release_v3.0.0/js`, and also sync `index.html`, `options.html`, `css/*`, `manifest.json` when they change (the release README intentionally differs).

## Current implemented work

### Filename-guard listener lifetime (3.4.1 — newest)

Symptom reported by the user, from a multi-extension Chrome profile:

```
This extension failed to name the download "Kodomo_Idol.pdf"
because another extension determined a different filename ""
```

The blamed extension was a downloader for a *different* site. The audit asked
whether THIS extension leaks naming authority across products. **It did.**

`chrome.downloads.onDeterminingFilename` is a global naming-decision event.
Registering it puts the extension into the filename chain for **every** download
in the profile. `host_permissions` and content-script `matches` do not scope it,
and returning early for a foreign item does **not** remove you from the chain —
participation itself is what lets Chrome name you in that error.

Up to 3.4.0, `installDownloadFilenameGuard()` ran at worker module evaluation
and added the listener unconditionally, forever. Classification: **LEAK**
(criteria: registered at startup and never removed; remains registered after
its own work finishes; participates globally even when the UI is nowhere near
nhentai).

Fix in `src/background/downloadNaming.ts` — reference-counted lifetime:

- `recordDownloadRequest(url, name)` attaches the listener when the pending map
  goes from empty to non-empty.
- The listener is detached the instant the map drains. Every drain path is
  covered: suggestion consumed, `onChanged` complete, `onChanged` interrupted /
  cancelled, `discardDownloadRequest()` when `downloads.download()` fails to
  produce an id, a 30-minute per-entry TTL, and the 600-entry FIFO cap.
- Idle worker ⇒ not in the chain at all.
- While attached, an item that is not ours gets a bare `suggest()` — never a
  filename, never `""`. `suggest()` is called exactly once per event.
- `installDownloadFilenameGuard()` now installs only the `onChanged`
  bookkeeping listener (no naming authority) and re-attaches the naming
  listener after a worker restart **only if** the session mirror still lists
  work in flight.
- New exports: `discardDownloadRequest`, `isFilenameListenerRegistered`,
  `pendingDownloadNameCount`. Session mirror moved to
  `{ v: 2, pending: {url: {filename, at}}, idToUrl, order }`; the legacy
  `{ byId, byUrl }` shape from 3.3.1/3.4.0 is still read on load.

Product behaviour deliberately unchanged: master folder, per-title folders,
list/single templates, archive names, `conflictAction: "uniquify"`, blob and
raw-CDN paths, and the offscreen `recordDownloadName` relay all behave exactly
as in 3.4.0.

Regression coverage: `test/download-naming.test.js` now has a
`global listener lifetime` block (idle ⇒ no listener; lazy attach on first own
download; stays attached while any is pending; detach on complete, on
interrupted, on failed creation, on consumption; restart re-attaches only with
outstanding work; TTL sweep releases a stuck entry; Firefox no-op). 19 tests in
that file. `scripts/smoke-mv3.js` additionally asserts that the **shipped
bundle** registers zero `onDeterminingFilename` listeners at load time, for
every worker variant it loads.

Not cleared: `NHDW_Firefox_v1.0.0/js/background.js` still contains the 3.3.1
guard. Firefox does not implement `onDeterminingFilename`, so it is inert
there, but that port has not been audited.

### List mode parity (3.4.0)

User report, in their words: single-title pages could do "4 zip cbz pdf and
raw", but "when I go to homepage or search or any artist or genre it's all
about the list with a default of zip and the naming system is the website url
itself"; the folder wrap "work just like the other but I want that to be
optional"; and the hovering popup could not be repositioned unlike their other
repo's side panel. Everything below is the answer to that report.

**Shared registry (the anti-drift rule).** `src/utils/downloadFormats.ts` is now
the single definition of the four formats, of the retired `"folder" -> "pdf"`
mapping, of the output mode, and of the PDF-merge condition. The panel, the
in-page card controls, the options page, `background.ts` (`normalizeFormatOverride`)
and the offscreen document all import it. List mode does **not** fork the
download logic: it calls the same `downloadAllDoujinshis` pipeline with per-job
options, so single-title and list mode cannot diverge again.

**1. Format selection in list mode.** The listing panel, the in-page floating
bar and the options page all expose zip/cbz/pdf/raw. The last-used list format
is persisted under its own key (`listFormat`) — never `useZip`, which stays the
single-title default. Raw is shipped enabled but labelled *"(testing)"* via
`formatLabel()` rather than silently missing (it is still on the open-items
list below).

**2. Separate files vs. batch — the actual must-have.** New explicit output
mode, independent of the format:
- `separate` (**the default in list mode**) — one archive, or one folder for
  raw, per title.
- `batch` — the previous behaviour, every title merged into one file. Opt-in.
Raw can never merge (no container), so `effectiveOutputMode()` forces it to
`separate` and the merge option is disabled in the UI. Relay fix: the worker
used to honour only `separate: true` (`if (relayedMessage.separate)`), which
made "batch" unrequestable from a UI whose default is separate; it now honours
an explicit `false` as well.

**3. List-mode filenames.** Root cause of "the naming system is the website url
itself": in batch mode the produced archive is named `finalName`, which the
popup derived from `document.location`, and batch was the only available mode.
Two fixes: separate mode is now the default (each file is named from the
gallery's OWN metadata through the template), and list mode got its own
template setting `listDownloadName`, defaulting to the sentinel `@inherit`
= "follow the single-title template". The resolved template is relayed as
`options.downloadName` for that job only. Also fixed: separate-mode archive
names now go through `utils.cleanName(...)` exactly like single-title
downloads (they previously used the raw title, so `replaceSpaces` did not
apply — `Test Two.zip` instead of `Test_Two.zip`).

**4. PDF-merge warning (hard requirement).** `shouldWarnPdfMerge(format, mode,
titleCount)` is true only for `pdf` + effective `batch` + more than one title.
The panel shows a modal (`src/preview/pdfMergeWarning.ts`) whose focused,
default button is **Switch to separate files**; the other buttons are *Merge
anyway* and *Cancel*. The "don't warn me again" checkbox writes
`pdfMergeWarnDismissed` in storage.local and is scoped to this exact
combination only (and only when the user actually proceeded). The existing
large-batch "you are going to download N pages" confirmation is untouched and
fires first — the two stack. The in-page bar has no room for the modal, so it
uses a native confirm with the same copy, defaulting to separate files.

**5. Optional folder wrap.** `listMasterFolder` (default on) decides whether
list downloads are wrapped. It drives BOTH `rawMasterFolder` (existing
behaviour) and the new `archiveMasterFolder`, so zip/cbz/pdf can finally be
grouped the same way raw is — this also closes backlog item 26. `""` means no
wrap. `Downloader.#archiveArtifactName()` applies it in `#downloadBlob`, the
single funnel for every archive artifact (server archive, zip/cbz, pdf).

**6. Side panel (P1).** `sidePanel` permission + `side_panel.default_path:
"index.html"`. The panel and the popup render the SAME document — one rendered
view, no duplicated markup. A `uiMode` setting (default `sidepanel`) picks what
a toolbar click opens; the worker applies it with
`chrome.sidePanel.setPanelBehavior({openPanelOnActionClick})` plus
`chrome.action.setPopup("")`/`("index.html")` (an action popup always beats the
panel behaviour, so it must be cleared). Everything is feature-detected: on
Chrome < 114 and on Firefox the popup simply stays. `preview.ts` re-bootstraps
on tab activation/navigation because the panel outlives a tab switch, and adds
an `.nhdwPanel` class that drops the popup's fixed 500px width.

**7. In-page card controls (P2).** New content script
`src/content/listControls.ts` (+ `css/content.css`) puts a **Download** button
and a **Select** box on every listing card and a floating bar with
`N selected -> format -> output -> Download / Clear`. Injection is idempotent
(`data-nhdw-controls` marker) and driven by a debounced `MutationObserver`, so
infinite scroll and pagination are covered. Selection uses the SAME
`chrome.storage.local.allIds` list the panel reads, and `storage.onChanged`
mirrors panel changes back into the page. Content-script jobs carry no tab id,
so `resolveTabId()` in the worker falls back to `sender.tab.id` — the
source-tab requirement still holds. The legacy caption checkbox is wrapped in
`.nhdw-legacy-check` and hidden while these controls are on; the toggle is
`inPageControls` (default on).

New/changed settings keys (all `chrome.storage.sync` unless noted):
`listFormat`, `listOutputMode`, `listMasterFolder`, `listDownloadName`,
`uiMode`, `inPageControls`; `pdfMergeWarnDismissed` in `chrome.storage.local`.

Tests: `test/list-mode.test.js` (+27 cases), archive-master-folder cases in
`test/downloader.test.js` (+5), side-panel/content-script cases in
`test/manifest.test.js` (+2), new relay phases in `scripts/e2e-relay.js`
(list-mode option relay, explicit `separate:false`, sender-tab fallback,
UI-mode popup fallback) and a whole new VM suite
`scripts/e2e-list-controls.js`. `scripts/e2e-offscreen.js` expectation updated
to the corrected `cleanName` behaviour. Totals: **205 mocha passing / 4
pending**, smoke green, e2e green (57 PASS lines).

### Folder-naming guard (3.3.1)

User report: "the folder naming system doesn't work". Investigation method:
the deprecated RAR archives in `old deprecated source code/` were unpacked
(node-unrar-js; NHentaiDownloader 2.2.0, NHxD, nhentai_archivist) and the
Chromium docs/bug tracker consulted. Root cause: **Chromium bug 579563** —
`chrome.downloads.download()`'s `filename` is *ignored* whenever ANY other
extension registers an `onDeterminingFilename` listener (download managers,
antivirus, cloud-drive helpers), so raw pages fell into the Downloads root as
`1.jpg`, `2.jpg`… instead of `NHDW/<Title>/001.jpg`. Full study:
`FOLDER_NAMING_STUDY.md`.

Fix (v3.3.1): `src/background/downloadNaming.ts` records every requested
artifact name (worker `saveDownload` relay, worker fallback `#saveArtifact`,
offscreen anchor saves via the new `recordDownloadName` message) BEFORE the
download starts and re-asserts it through the extension's own
`onDeterminingFilename` listener, registered synchronously at worker top
level. Foreign-extension downloads are never touched; blob:/data: matches are
always asserted; entries live in chrome.storage.session (worker-restart safe)
and are pruned on completion (600-entry FIFO). `conflictAction: "uniquify"` is
now uniform (re-downloads produce `Title (1).zip` instead of overwriting).
Firefox: no-op (the event doesn't exist there and the bug doesn't either).
Known limit: a download manager installed AFTER this extension that actively
suggests names still wins per Chrome's "last installed" rule — documented in
README troubleshooting.

Tests: `test/download-naming.test.js` (+10 cases, 176 total). All suites
green (fixtures, smoke, e2e). Both release folders re-synced from source
(`diff -rq` clean); manifests bumped to 3.3.1 (source, release, Firefox).

### Popup split + similar-gallery selection (newest)

- Single-gallery popup is two columns: **left** = current gallery (title, page count, ZIP/CBZ/PDF/raw picker, path input, Download); **right** = **Similar galleries** panel.
- The panel fetches `GET /api/v2/galleries/{id}/related` only when the user clicks *Show similar galleries*, then renders a checkbox list (title + page count; `(Non-titled) #id` fallback), **All/None** toggles, and **Download selected (n)**.
- Selections send `downloadAllDoujinshis` with `separate: true` → **one archive per selected gallery**, each named after its title (flat layout). The per-job `formatOverride` from the left picker applies. `separate` overrides the stored *download each file separately* option for that job only.
- Untitled related cards use `(Non-titled) #id` (matches nhentai's own display) so files remain traceable.

### Archive naming and structure (newest)

- **Single-gallery ZIP/CBZ/PDF**: named `<clean title>.zip|.cbz|.pdf` with pages at the archive **root** (`001.jpg`, `002.png`, …) — no `Title/Title` double folder. Implemented via `Downloader` setting `archiveLayout: "flat"`.
- **Shared batch archive** (listing-page batches, multi-page batches, non-separate similar): unchanged shape — one folder per gallery inside the single archive (`archiveLayout: "nested"`, the default when unset).
- **Raw mode**: pages now save as `Downloads/<Title>/001.jpg` (titled folder + zero-padded numbering) instead of flat `Title-001.jpg`. Since **3.3.0** the titled folder lives inside a master folder by default — `Downloads/NHDW/<Title>/001.jpg` — via the `rawMasterFolder` option (Options → "Folder for raw downloads"; empty string disables, slashes nest deeper, sanitized per segment). Scope notes from review: raw only — ZIP/CBZ/PDF archives still land directly in the download folder (one file per gallery doesn't pile up the same way; a matching archive master folder is tracked as backlog item 26); `replaceSpaces` intentionally does not rewrite the user-typed folder name.
- **Last-mile filename hardening**: `sanitizeArtifactFilename` (exported from `Downloader.ts`) runs inside `#saveArtifact` for every artifact — strips control/reserved characters per path segment, leading dots, trailing dots/spaces, caps segment length, never returns empty. This addresses downloads landing under blob-UUID/number names when Chrome discards an invalid requested filename.

### PDF output format (replaced the folder mode)

- `src/utils/pdfBuilder.ts`: dependency-free PDF 1.4 writer. `jpegInfo(bytes)` parses SOF0/SOF2 frames (dimensions + component count, skips APPn thumbnails); `buildPdfDocument(images)` emits catalog/pages/page/content/image objects with DCTDecode XObjects and a byte-exact xref table.
- `Downloader` `useZip: "pdf"`: collects validated page bytes in order, embeds RGB JPEGs verbatim (no re-encode), re-encodes grayscale/CMYK JPEGs and PNG/GIF/WebP via `createImageBitmap` + `OffscreenCanvas` (white-flattened) when available, delivers `<title>.pdf` through the same object-URL/data-URL path as ZIP.
- **"folder" is retired**: options select and popup pickers now offer zip/cbz/pdf/raw; every legacy `"folder"` value (stored settings, format overrides) maps to `"pdf"` (`Downloader` whitelist, `normalizeFormatOverride` in background.ts, popup extension hints).
- The offscreen document still uses **only** `chrome.runtime`; PDF assembly happens in the same context as ZIP assembly.

### CDN configuration hardening (previous session)

- `src/sources/cdnConfig.ts` is the shared image-server configuration (validated HTTPS `*.nhentai.net` origins only); `src/background/cdnConfigService.ts` resolves `GET /api/v2/cdn` once per session (source-tab first, 6s timeout, cached in memory + `chrome.storage.session`, 1h TTL) and permission-filters the list.
- Manifest: static `host_permissions` unchanged + `optional_host_permissions: ["https://*.nhentai.net/*"]` + `permissions` API. Popup `getCdnStatus` notice with a one-click **Grant image host access** when nhentai reports ungranted hosts; downloads keep using permitted hosts meanwhile.
- Offscreen applies relayed `options.imageServers` per job.

### Download lifecycle (unchanged)

- MV3 worker relays downloads to the offscreen document; offscreen owns fetch/ZIP/PDF work, worker owns storage/downloads/scripting/permissions.
- Queue serialization, session pause/resume, queue/cancel controls, batch summary — all as before. Job start resolves CDN config first; the job marker goes up synchronously when the job is accepted.
- Session-only pause/resume: no durable restart resume — do not claim it.

### Source-tab requirement

- The source nhentai gallery tab must stay open (may be backgrounded; user whitelisted nhentai.net in their suspender) until its job completes; tab-context image fetch and the CDN config fetch prefer its Cloudflare-cleared session.

### API key

- Options page: optional user-pasted key, verified via third-party-safe `GET /api/v2/user` with `Authorization: Key <key>` only. Stored in `chrome.storage.local`, never rendered back. Never use `/api/v2/auth/*`.

### Options-page UX pass (2026-08-26, user live-test feedback)

- API key field now supports explicit paste (intercepted `paste` event; some
  browsers offer no right-click menu on extension pages) — in both the
  options page and the popup gate, with a visible Ctrl+V hint.
- Plain-language explanations for every option: what ZIP/CBZ/PDF/raw
  produce, exactly what Duplicate rename/ignore do, what the server-archive
  toggle does (no programmer-speak), one-line format hints.
- Name template is now **checkboxes** (one per placeholder, canonical order,
  " - " separator) instead of manual typing; stored format unchanged
  (`{pretty} - {id}`) so the engine and old templates are untouched; custom
  templates fall back to the manual input (`src/options/nameTemplate.ts` +
  `test/name-template.test.js`).
- **Settings inside the popup (3.2.0)**: the popup has two tabs, Download |
  Settings. The Settings tab (`src/preview/popupSettings.ts`) reuses
  `options/apiKey.ts` + `options/nameTemplate.ts`: paste-aware API key input
  with Save & verify / Remove, a saved-state status line ("A key is saved —
  API key mode is active"), and the name-template checkboxes with a live
  "Example file name" preview so the naming result is visible before
  downloading. The full options page remains as the fallback.

### Two-mode API access (2026-08-26, PR #22)

Boundary table — **API key mode** (a key is stored) vs **open tab mode**
(no key; byte-for-byte the pre-key behaviour):

| Concern | API key mode | Open tab mode |
|---|---|---|
| Metadata route order | keyed official API → open-tab read → plain fetch | open-tab read → plain fetch |
| `Authorization` header | `Key <key>` on `nhentai.net/api/` URLs only | never created |
| `429` handling | `Retry-After` backoff (clamped 0.25–15 s, max 2 retries) | n/a |
| Batch downloads | independent of the open tab's session | resolve through the open tab only |
| One-shot server archives | available (opt-in) | not available (endpoint requires auth) |

- **First-run gate** (popup): a box asks for the key with two explicit exits,
  **Submit key** / **Continue without API key**; the decision is remembered
  (`apiKeyGate` in storage.local). Mode badges ("API key" / "open tab") show
  in single and batch previews. Saving a key in options withdraws a previous
  skip; removing the key re-arms the gate.
- **Keyed routes**: `fetchNhentaiApi()` in `src/utils/apiAuth.ts` (headers
  only for `https://nhentai.net/api/`, best-effort descriptive User-Agent,
  429 backoff). Wired into popup preview, worker batch, offscreen batch —
  always falling through to the keyless routes on failure, so an invalid key
  can never break a download.
- **One-shot server archives** (experimental, opt-in toggle
  `useServerArchive`): `POST /api/v2/galleries/<id>/download?format=zip|cbz`
  (keyed; returns `{ url, expires_at }`) — `src/background/ArchiveDownload.ts`
  + `Downloader.#tryServerArchiveAsync()`. Runs only when this gallery owns
  the whole archive (never mid-shared-batch), only for ZIP/CBZ, and any
  failure (401/403/503/429/network/malformed) falls back to page-by-page.
  The signed delivery URL is fetched **without** the key.
- **Persistence fix**: the popup bootstrap used `storage.local.clear()` on
  URL changes, which would wipe the key — replaced with targeted
  `remove("allIds")`. Guarded by a test asserting the popup bundle never
  contains `storage.local.clear()`.

## CI and workflow files (manual-commit only)

`.github/workflows/**` is **outside what any agent session can push.** The
GitHub App used for `git push` in Arena sessions is not granted the `workflows`
permission, so the remote rejects the push before anything lands:

```
! [remote rejected] arena/<session> -> arena/<session>
  (refusing to allow a GitHub App to create or update workflow
   `.github/workflows/extension-tests.yml` without `workflows` permission)
```

It rejects the **entire push**, not just that file, so a workflow edit sitting
in a session commit blocks every other change too. This is permanent, not
flaky. Workflow changes in this repository have always been made by hand —
through the GitHub web editor or a local clone with a normal user credential
(that is how the 2026-09-01 real-browser-job removal was done).

**Procedure for agents:** never edit `.github/workflows/`. Write the complete
intended workflow file into `NHDW_Extension_v3.0.0/ci/pending-workflows/`,
describe it in `NHDW_Extension_v3.0.0/ci/README.md`, and list it here. If a
workflow edit has already been committed, drop it with
`git checkout HEAD~1 -- .github/workflows/<file>` and amend before pushing.

### Pending, waiting for a human

**Nothing pending.** The queued trigger-paths change was applied by the user
through the GitHub web editor on 2026-09-04 as commit `840d79e` ("Add
additional files to extension tests workflow"); the live workflow and
`NHDW_Extension_v3.0.0/ci/pending-workflows/extension-tests.yml` are now
byte-identical, and the run it triggered passed in 1m19s. Keep the copy in
`ci/pending-workflows/` in sync whenever the live workflow changes, and add a
row back to this table for any future workflow edit.

## Required real-browser verification before PR

Reload unpacked `NHDW_Release_v3.0.0` through `chrome://extensions` or `brave://extensions`.

### 3.4.1 — cross-extension naming leak (do these FIRST: they need a second
### extension installed, and they are the only checks that can regress silently)

0A. **The blame message is gone.** Install at least one other downloader or
    download manager that hooks Chrome's naming (the user's original report
    involved a downloader for another site). Download something with that
    other extension while NHDW is installed but idle. The Chrome notification
    *"This extension failed to name the download ... because another extension
    determined a different filename"* must no longer name NHDW. If it names
    the other extension, that is the other extension's own bug, not ours.
0B. **Idle worker holds no listener.** `chrome://extensions` -> NHDW ->
    "service worker" -> Console. With no download running, the worker must not
    be in the filename chain. `chrome.downloads.onDeterminingFilename.hasListeners()`
    should report `false`.
0C. **Listener appears and disappears around a job.** Start a raw gallery
    download; re-run the `hasListeners()` check mid-download -> `true`. Let it
    finish, wait for the shelf to settle, re-run -> `false` again. Repeat for a
    ZIP job (blob artifact path) and for a cancelled job (cancel from the
    Downloads shelf -> must return to `false`).
0D. **Naming still correct under a competing extension.** With the other
    extension still installed, run a raw gallery: pages must land in
    `NHDW/<Title>/001.jpg`, not as `1.jpg` in the Downloads root. Run a ZIP:
    it must be `<Title>.zip`, not a blob UUID. This is the 3.3.1 behaviour the
    3.4.1 refactor must not have broken.
0E. **Worker-restart recovery.** Start a large gallery, then stop the service
    worker from `chrome://extensions` mid-download. The browser keeps
    downloading. Remaining files must still get their proper names (the guard
    re-attaches from the session mirror). Known and accepted gap: a
    determining-filename event that fires in the few milliseconds before the
    async `storage.session` read completes will get Chrome's default name for
    that one file — see "Open questions and things that still need review".

### 3.4.0 additions

0a. **List mode, separate files (the headline fix).** On a search / artist /
    tag page: select several galleries, Format = ZIP, Output = *Separate files*
    -> one `.zip` per title, each named from the template and the gallery's own
    metadata, NOT from the page URL. Repeat with CBZ and PDF.
0b. **List mode, merged file.** Output = *Single merged file* -> exactly one
    archive named after the box under the picker.
0c. **PDF-merge guard.** Format = PDF, Output = *Single merged file*, more than
    one title selected -> the modal appears, **Switch to separate files** is
    focused and pressing Enter produces one PDF per title. Check *Merge anyway*
    still merges, *Cancel* does nothing, and that "don't warn me again" only
    silences this exact combination (zip batch and single-title PDF must be
    unaffected). With a multi-page listing, confirm the count warning appears
    FIRST and the merge warning after it.
0d. **Optional folder wrap.** Ticked -> `Downloads/NHDW/<name>.zip` and
    `Downloads/NHDW/<Title>/001.jpg`. Unticked -> straight into Downloads for
    both. Emptying the folder name in Options behaves like unticked.
0e. **List-mode template.** Settings -> List mode -> untick "same as single
    title", change the tokens, confirm the live preview and then the real file
    name follow it while single-title downloads keep the old template.
0f. **Raw in list mode.** Still the open item below: confirm one real folder per
    title with loose `001.jpg…` inside, and that the merge option stays disabled.
0g. **Side panel.** Toolbar click opens the docked panel; it resizes; it follows
    tab switches and navigation (gallery page <-> listing page). Switch
    Settings -> Interface -> Popup and confirm the toolbar click goes back to the
    hovering popup. On a Chrome < 114 build confirm the popup is used silently.
0h. **In-page card controls.** Download button on a card downloads that gallery;
    Select boxes raise the floating bar with the right count; the count survives
    scrolling to newly loaded cards (infinite scroll); selection made in the page
    shows up in the panel and vice versa; turning the setting off removes both
    the buttons and the bar after a reload, leaving the legacy checkbox.

1. Single-gallery ZIP download: file named exactly the gallery title, pages at the ZIP root (no inner title folder). Repeat for CBZ.
2. **PDF**: same title naming; open the produced PDF — every page present, correct order, correct orientation/aspect.
   2b. **3.3.1 naming guard (new)**: with a download-manager extension installed and enabled, raw-download a gallery — pages must still land in `Downloads/NHDW/<Title>/` as `001.jpg`… (guard re-asserts names; see `FOLDER_NAMING_STUDY.md`). If the manager was installed after NHDW and still wins, note it — Chrome's "last installed listener wins" rule is documented as a known limit, not a bug to chase.
3. Raw: pages land in `Downloads/NHDW/<Title>/` as `001.jpg`… (3.3.0 master folder; emptying the Options "Folder for raw downloads" box restores plain `Downloads/<Title>/`) — no bare-number filenames anywhere.
4. Popup layout: left column downloads the current gallery; right column *Show similar galleries* lists related titles with checkboxes; uncheck a few; *Download selected (n)* produces one titled file per selected gallery.
5. Similar download with an untitled related gallery → file shows `(Non-titled) #id`-derived name, not a bare random number.
6. Queue two or more jobs; serial order, queue count, Clear queue, Cancel current; pause/resume across popup close/reopen.
7. API key: valid, invalid, remove; saved key never appears in the input. Download similar anonymously and with the key.
8. Keep the source gallery tab backgrounded on another site; confirm completion.
9. CDN hardening: `/api/v2/cdn` fetched once per session (worker console); `chrome.storage.session.get("cdnConfig")` shows the merged list; grant-notice flow when a host lacks permission.

## Open questions and things that still need review

Nothing here is known to be broken. These are the places where the current
implementation rests on a judgement call, an untested assumption, or a
deliberate trade-off, and a reviewer should decide whether they are acceptable.

### From the 3.4.1 naming-guard rewrite

1. **Restart race (accepted trade-off, unverified in a real browser).** When the
   MV3 worker restarts mid-gallery the naming listener is re-attached only
   after an async `chrome.storage.session` read. An event firing inside that
   window is not intercepted and that single file keeps Chrome's default name.
   The alternative — registering synchronously at startup — is precisely the
   leak that was just removed, so the race was chosen deliberately. Open
   question: how wide is the window in practice, and is one mis-named file per
   worker restart acceptable? Verification step 0E probes it.
2. **TTL value is a guess.** `ENTRY_TTL_MS` is 30 minutes. Too short and a very
   slow download loses its name; too long and a stuck entry keeps the global
   listener attached. Nobody has measured the slowest realistic gallery. Needs
   a real-world data point, not a debate.
3. **`hasListeners()` is the only observation method.** There is no supported
   API for "which extensions are in the naming chain", so 0B/0C rely on
   `chrome.downloads.onDeterminingFilename.hasListeners()` from the worker's
   own console. That proves our own state, not that Chrome has dropped us from
   its chain. If someone knows a stronger check, use it.
4. **Manual saves of an in-flight image.** If the user manually saves the exact
   image URL we are downloading, our recorded name wins for that save. Judged
   harmless (`uniquify` prevents overwrites, the entry clears on completion)
   but never observed in practice.
5. **The URL-keyed map assumes URLs are unique per artifact.** True for CDN page
   URLs and blob URLs today. If a future change ever reuses a URL across two
   concurrent jobs, the second would inherit the first's name. No guard exists
   for that.

### Carried over from 3.4.0, still unverified

6. **raw format** ships behind a "(testing)" label. Folder creation
   (one folder of loose images per title) has never been confirmed in a real
   browser. Until step 0f passes, the label stays.
7. **Download All across paginated listings** — that it walks every page and
   that the 2-page count warning fires is asserted by e2e stubs only.
8. **The original naming clash** with the user's other extension is expected to
   be gone now that list mode shares the single pipeline *and* the guard no
   longer participates when idle, but the two fixes have never been observed
   together on a real profile.

### Structural

9. **`NHDW_Firefox_v1.0.0` is not cleared.** It still ships the 3.3.1 guard in
   its built `js/background.js` and lags at 3.3.1 overall. Firefox does not
   implement `onDeterminingFilename`, so the guard is inert there and this is
   not a live bug — but that port has had no independent audit and none of the
   3.4.0/3.4.1 work has been ported.
10. **No other repository was audited or cleared.** The naming audit covered
    this workspace only.
11. **P3 queue UI is untouched.** Thumbnails, per-item progress and states,
    cancel/retry, concurrency limit, retry-with-backoff — all still backlog.
12. **`@types/chrome` is pinned at 0.0.154 (2021).** `chrome.sidePanel` and
    `chrome.storage.session` are both reached through `(chrome as any)`. A
    dependency bump would restore type safety on those paths but risks
    unrelated type churn.
13. **`npm run test:browser` has never run in this environment.** Every
    real-browser claim in this document is an expectation, not an observation.

## Next backlog (worklist — statuses as of 2026-09-04)

- [ ] **P3 — queue UI with thumbnails (carried over from the user's brief, not
  started).** Replace the name-only queue list with a Twitter/X- or
  rule34-style list: thumbnail, title, per-item progress bar, status and
  cancel/retry per item. Per-item states: `queued`, `fetching metadata`,
  `downloading (x/y pages)`, `packaging`, `done`, `failed`. Needs a concurrency
  limit and retry-with-backoff at the queue level (the per-image retry already
  exists in `Downloader`). Today the queue lives in the offscreen document
  (`queuedJobs` in `src/offscreen/offscreen.ts`) and only reports a count plus
  "Clear queue" — a real UI needs the worker to mirror queue entries into
  `chrome.storage.session` so the panel can render them after a worker restart.
  Thumbnails are available without extra requests: `t.nhentai.net` covers are
  derivable from `media_id`, and the listing cards already have them in the DOM.
- [ ] **Raw list-mode verification (blocks flipping the "(testing)" label).**
  `formatLabel("raw")` currently returns "Raw images (testing)". Once a real
  browser confirms one real folder per title with loose images, drop
  `RAW_IS_EXPERIMENTAL` in `src/utils/downloadFormats.ts`.
- [ ] **Firefox port folder is now behind (item 27).** `NHDW_Firefox_v1.0.0/`
  still carries 3.3.1 and none of the 3.4.0 work. Extra porting notes:
  `chrome.sidePanel` does not exist in Firefox — the equivalent is
  `sidebar_action` (different manifest key, different open semantics, no
  `setPanelBehavior`), so `applyUiMode()` needs a Firefox branch; and the new
  `js/listControls.js` content script has to be added to the Firefox manifest.

- [ ] **27. Port the extension to Firefox (added 2026-09-03; working folder
  `NHDW_Firefox_v1.0.0/`).** Feasibility audit done — port is possible.
  Evidence table and required-change list:
  `NHDW_Firefox_v1.0.0/PORTING_AUDIT.md`. Work order: (1) Firefox manifest
  (`background.scripts` event page, drop `offscreen` permission, add
  `browser_specific_settings.gecko`, min Firefox 128) → (2) close
  fallback-path parity gaps (pause/resume/clearQueue exist only on the
  offscreen branch, `background.ts:976-982`; the non-offscreen fallback at
  `background.ts:~1052` never answers them) → (3) repoint test path
  assumptions + extend `.github/workflows/extension-tests.yml` paths →
  (4) `web-ext lint` + real-Firefox load → (5) real-browser pass
  (blob download naming, queue controls, batch, PDF, raw, CDN grant flow).
  Full task definition: IMPROVEMENT_BACKLOG.md session log 2026-09-03.
- [x] ~~Server-side ZIP/CBZ endpoint with API key; fall back on 429/503~~ — DONE
  (PR #22, opt-in `useServerArchive` toggle with page-by-page fallback).
- [ ] **Server-archive availability check (pending — user side, no browser
  needed):** does the account actually get a usable URL from
  `POST .../download` (`allow_downloads` feature flag / tier)? Answer with
  `NH_API_KEY=<key> npm run test:live` — it probes the keyed profile
  endpoint, keyed metadata (through the real normalizer), and the archive
  endpoint, then reports availability (200 + ZIP magic) vs gated
  (401/403/503/429). Then make the keep-or-remove decision for the
  `useServerArchive` toggle (backlog item 17).
- [ ] **Real-browser run of `npm run test:browser`** on a machine with a
  full Chrome/Brave build (`sudo` so the fixture binds port 443) — the only
  remaining blocker for flipping backlog item 10 from `[~]` to `[x]`.
- [ ] **Real-browser regression pass after 3.2.1/3.2.2** — confirm a real
  blob save lands with the title-based name (the 3.2.1 anchor-`download`
  fix could be a silent no-op in a browser build that blocks programmatic
  downloads from hidden offscreen pages; nothing lands → revert to the
  worker relay) and spot-check that UI strings render clean after the 3.2.2
  mojibake fix.
- [ ] Real-browser verification of the keyed route winning in the worker console
  (previous open question: is a same-tab/worker fetch of `/api/v2/galleries`
  challenged? With a key it uses the official contract).
- [x] ~~**Optional: master folder for single-file archives (backlog 26)**~~ —
  DONE in 3.4.0 via `archiveMasterFolder` + the `listMasterFolder` checkbox.
  Single-title downloads still default to no wrap; list mode wraps by default
  and the checkbox turns it off.
- [ ] Optional: sync the API key across the user's own devices
  (`chrome.storage.sync`) — deliberately local-only today; needs an explicit
  user decision (secret syncing).
- [ ] Optional: force the descriptive `User-Agent` via `declarativeNetRequest`
  (fetch() forbids it in some contexts) — deferred, adds a permission.
- [ ] Persistent restart-safe resume (checkpoint/rebuild strategy).
- [ ] Search/favorites/blacklist/comments API UI features.
- [ ] PDF niceties (not required): PDF/AV viewers validate fine, but consider a
  cover/thumbnail entry or bookmarks outline if ever requested.
- [x] ~~Enable a GitHub Actions workflow for the real-browser suite~~ —
  RESOLVED by removal (2026-09-01): GitHub-hosted runners cannot launch the
  MV3 harness (Chrome `Runtime.enable` timeout / Brave SIGTRAP, failed on
  every run since introduction). CI is offline-suites-only
  (`extension-tests.yml`); the real-browser suite stays local
  (`npm run test:browser`). See backlog item 10.

## Do not

- Do not switch branches or push to a branch other than the current session branch.
- Do not register `chrome.downloads.onDeterminingFilename` at worker startup or
  leave it registered while idle. It is a profile-wide event: participation
  alone makes Chrome able to blame this extension for other extensions'
  downloads. Attach it only while our own filenames are pending and detach on
  every drain path (see "Filename-guard listener lifetime"). Never call
  `suggest({ filename: "" })`, and never call `suggest` more than once per
  event.
- Do not edit `.github/workflows/**` from an agent session. The push will be
  rejected for the whole branch (`without \`workflows\` permission`). Put the
  intended file in `NHDW_Extension_v3.0.0/ci/pending-workflows/` and record it
  under "CI and workflow files (manual-commit only)" so a human can commit it.
- Do not fork the download logic for list mode. List mode must keep calling the
  same `downloadAllDoujinshis` pipeline with per-job options; the formats and
  the output mode must keep coming from `src/utils/downloadFormats.ts`. Two
  copies of "what a format is" is exactly how list mode ended up stuck on ZIP.
- Do not make the master-folder wrap mandatory again, and do not let list mode
  fall back to the page URL for a file name in separate mode.
- Do not remove or weaken the PDF-merge confirmation, and do not widen its
  "don't warn me again" flag beyond `pdf + batch + more than one title`.
- Do not drop `action.default_popup` from the manifest: the popup is the
  documented fallback for builds without `chrome.sidePanel` and for users who
  prefer it.
- Do not put `chrome.storage`, `chrome.downloads`, `chrome.scripting`, or `chrome.permissions` in the offscreen document.
- Do not use `/api/v2/auth/*` or `/api/v2/user/keys`.
- Do not remove tab-first fetching or claim Cloudflare bypass.
- Do not run `npm audit fix --force`.
- Do not expand web-accessible resources.
- Do not add `<all_urls>` (or any non-nhentai host) to host/optional-host permissions; all image hosts must validate as HTTPS `*.nhentai.net` origins.
- Do not reintroduce the "folder" output mode; PDF replaced it (legacy `"folder"` values must keep mapping to `"pdf"`).
- Do not re-add real-browser (real Chrome / real Brave) jobs to GitHub Actions — they failed on 100% of runs because hosted runners cannot launch the MV3 extension harness (backlog item 10). CI is offline-suites-only; real-browser verification is local `npm run test:browser`.
