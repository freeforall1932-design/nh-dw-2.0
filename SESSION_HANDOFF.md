# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-09-01 (after the CI cleanup landed: the failing
real-browser GitHub Actions jobs were removed via the web UI, replaced by
`.github/workflows/extension-tests.yml` — first run **green** (~1m, 163
mocha fixtures + smoke + VM e2e); docs companion PR #29 merged; README CI
bullet fixed in PR #30)

- Session branch of the current session: `arena/01a05a41-nh-dw-2-0`. Always
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

## Validation

```bash
cd NHDW_Extension_v3.0.0
npm ci
npm run build
npm test              # 166 passing, 4 pending (pending = live checks; opt in with RUN_LIVE_TESTS=1 / NH_API_KEY=<key>)
npm run test:smoke
npm run test:e2e      # worker (incl. PDF + CDN phases), offscreen (incl. PDF + CDN), relay, content
cp js/*.js ../NHDW_Release_v3.0.0/js/
diff -rq js ../NHDW_Release_v3.0.0/js
# also diff index.html / options.html / css / manifest.json when they change
```

`npm run test:browser` needs a full Chrome/Brave build (serverless `@sparticuz/chromium` has extensions compiled out). `NHDW_CHROME_EXTRA_ARGS` exists as an escape hatch. The real-browser CI jobs were **removed** (they could never launch on GitHub Actions runners — Chrome `Runtime.enable` timeout / Brave SIGTRAP); CI now runs only the offline suites via `.github/workflows/extension-tests.yml`, and the real-browser suite stays a manual `npm run test:browser` on a developer machine.

## Required real-browser verification before PR

Reload unpacked `NHDW_Release_v3.0.0` through `chrome://extensions` or `brave://extensions`.

1. Single-gallery ZIP download: file named exactly the gallery title, pages at the ZIP root (no inner title folder). Repeat for CBZ.
2. **PDF**: same title naming; open the produced PDF — every page present, correct order, correct orientation/aspect.
3. Raw: pages land in `Downloads/NHDW/<Title>/` as `001.jpg`… (3.3.0 master folder; emptying the Options "Folder for raw downloads" box restores plain `Downloads/<Title>/`) — no bare-number filenames anywhere.
4. Popup layout: left column downloads the current gallery; right column *Show similar galleries* lists related titles with checkboxes; uncheck a few; *Download selected (n)* produces one titled file per selected gallery.
5. Similar download with an untitled related gallery → file shows `(Non-titled) #id`-derived name, not a bare random number.
6. Queue two or more jobs; serial order, queue count, Clear queue, Cancel current; pause/resume across popup close/reopen.
7. API key: valid, invalid, remove; saved key never appears in the input. Download similar anonymously and with the key.
8. Keep the source gallery tab backgrounded on another site; confirm completion.
9. CDN hardening: `/api/v2/cdn` fetched once per session (worker console); `chrome.storage.session.get("cdnConfig")` shows the merged list; grant-notice flow when a host lacks permission.

## Next backlog (worklist — statuses as of 2026-09-01)

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
- [ ] **Optional: master folder for single-file archives (backlog 26)** — user
  to decide whether ZIP/CBZ/PDF should also group under `NHDW/` (they save one
  file per gallery straight into the download folder today, e.g.
  `Downloads/<Title>.zip`).
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
- Do not put `chrome.storage`, `chrome.downloads`, `chrome.scripting`, or `chrome.permissions` in the offscreen document.
- Do not use `/api/v2/auth/*` or `/api/v2/user/keys`.
- Do not remove tab-first fetching or claim Cloudflare bypass.
- Do not run `npm audit fix --force`.
- Do not expand web-accessible resources.
- Do not add `<all_urls>` (or any non-nhentai host) to host/optional-host permissions; all image hosts must validate as HTTPS `*.nhentai.net` origins.
- Do not reintroduce the "folder" output mode; PDF replaced it (legacy `"folder"` values must keep mapping to `"pdf"`).
- Do not re-add real-browser (real Chrome / real Brave) jobs to GitHub Actions — they failed on 100% of runs because hosted runners cannot launch the MV3 extension harness (backlog item 10). CI is offline-suites-only; real-browser verification is local `npm run test:browser`.
