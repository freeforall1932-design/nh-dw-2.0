# Session Handoff — nh-dw-2.0 (NHentai Downloader v3.0.0 repair)

> Written 2026-08-20 (Asia/Bangkok) at the end of the arena session on branch
> `arena/01a01c83-nh-dw-2-0`. All work described here was merged into `main` via PR.
> Purpose: paste this file (or its sections) into a fresh session to continue exactly
> where this one left off.

---

## 1. TL;DR status

The extension was broken in three independent ways (every download failed); all three are
fixed, rebuilt, and shipped in `NHDW_Release_v3.0.0`. Two larger follow-ups (offscreen-document
ZIP delivery + offline test strategy) are also done. **The only item not fully closed is the
real Chrome/Brave end-to-end run** — it is fully automated (`scripts/e2e-browser.js` + a
ready-to-use CI workflow included at the end of this document) but could not be executed in
the sandbox (no extension-capable browser binary reachable; GitHub App token cannot write
`.github/workflows` files). One command on any normal machine closes it — see §6.

## 2. Repo map

| Path | What it is |
|---|---|
| `NHDW_Extension_v3.0.0/` | TypeScript source + webpack build. The development package (`npm run build`, `npm test`, ...). |
| `NHDW_Extension_v3.0.0/src/` | TS sources: `background/` (SW + Downloader), `offscreen/` (offscreen doc), `preview/` (popup), `content/` (page scripts), `parsing/`, `options/`, `utils/`. |
| `NHDW_Extension_v3.0.0/js/` | Webpack output (regenerate with `npm run build`). |
| `NHDW_Extension_v3.0.0/scripts/` | Test runners: `e2e-worker.js` (in-worker fallback), `e2e-offscreen.js`, `e2e-relay.js`, `e2e-content.js`, `e2e-browser.js` (real browser), `smoke-mv3.js`; `fixtures/` (test TLS cert). |
| `NHDW_Extension_v3.0.0/test/` | Mocha suites: `test.js` (opt-in live API), `parsing.test.js`, `downloader.test.js` (fixtures, no network). |
| `NHDW_Release_v3.0.0/` | **The folder users load** (`chrome://extensions` → Load unpacked). Must stay byte-synced with the Extension build outputs. |
| `NHDW_Source_v3.0.0/` | Upstream 2.2.0 source (Xwilarg/NHentaiDownloader, MIT) — used as the second verification source. |
| `IMPROVEMENT_BACKLOG.md` | Living backlog with per-item progress notes. |
| `SESSION_HANDOFF.md` | This file. |

## 3. What was changed (by commit)

1. **`c35bc02` — Fix broken MV3 service worker, popup, and content script; rebuild Release**
   * Deleted six legacy `window.* = background.*` lines in `background.ts` (2.2.0 MV2 leftovers).
     In an MV3 service worker the first line threw `ReferenceError: window is not defined`,
     so `chrome.runtime.onMessage.addListener` never ran and every popup message got no
     response. Proven by loading the old vs new bundle in a `window`-less VM.
   * `preview.ts`: tolerate a missing `isDownloadFinished` response (`if (!response || ...)`).
   * `content.ts` / `updateContent.ts`: guard pages without `.caption` cards (old code crashed
     with `captions[0]` undefined on single-gallery pages) and scope gallery IDs to each card's
     own link. (Later corrected from `querySelector` to `closest` — see `6d830b8`.)
   * `Downloader.ts` raw mode: Promise-wrapped `chrome.downloads.download` so failures feed
     the retry loop and error callback instead of being thrown inside a bare callback and
     silently dropped; fixed the raw-mode filename sanitizer (it was mangled and flattened
     folder paths); fixed a `this`→`self` bug in `startAsync`.
   * `background.ts` `downloadAllPages`: stopped mutating `pagesArr` while iterating
     (`curr = pagesArr[0]; splice(0,1)` made the "last page" check never fire, so the final
     ZIP was never downloaded).
   * Release folder: replaced the hand-written, broken `js/popup.js` + `index.html` with the
     webpack-built popup (`js/preview.js`); removed dangling `web_accessible_resources`
     entries (`js/jszip/...`, `js/FileSaver.js/...`).
   * README rewritten to match what the extension actually does (the old README advertised a
     "Download Full Archive" page button that was never built).

2. **`d7ed46e` — Move ZIP delivery to an MV3 offscreen document; add offline test suite**
   * New `src/offscreen/offscreen.ts` + `offscreen.html` (webpack `offscreen` entry): the
     download pipeline now runs in an MV3 offscreen document (`reasons: ["BLOBS"]`). The
     finished ZIP goes out via a real `URL.createObjectURL` (revoked after the download is
     accepted) — no more `String.fromCharCode`/`btoa` base64 round-trip (~2-3x peak memory
     on large galleries) — and offscreen documents are not subject to the SW idle timeout.
   * `Downloader.#downloadBlob`: object URL when `URL.createObjectURL` exists; the base64
     data-URL path remains only as the in-worker fallback for browsers without `chrome.offscreen`.
   * `background.ts`: relays popup commands to the offscreen document
     (`isDownloadFinished`, `downloadDoujinshi`, `downloadAllDoujinshis`, `downloadAllPages`,
     `goBack`, progress refresh), closes the document on `offscreenIdle` (60 s), keeps the
     in-worker downloader as fallback. Offscreen progress/error broadcasts are tagged
     `from:"offscreen"` so the SW does not loop them back into the relay.
   * Offline suites: `test/parsing.test.js`, `test/downloader.test.js` (fixtures via
     `tsconfig.test.json` + `tsc`), `scripts/{smoke-mv3,e2e-worker,e2e-offscreen,e2e-relay}.js`
     (built bundles in `window`-less VMs with chrome/fetch/URL stubs). `npm test` is now fully
     offline; live API check is opt-in (`npm run test:live`).
   * Release folder also got the correct `options.html`/`css/content.css` (the old hand-written
     ones didn't match `js/options.js` IDs / styled a nonexistent page button).

3. **`6bb4a46` — Add real-browser e2e test (CDP driver + CI on real Chrome and Brave)**
   * `scripts/e2e-browser.js`: zero-dependency CDP driver (Node `fetch` + `WebSocket`) that
     launches an extension-capable Chromium-family browser, loads `NHDW_Release_v3.0.0`, and
     verifies: SW registration + clean reload, popup rendering via the SW bridge, content
     scripts on nhentai-style pages, offscreen ZIP pipeline into real `chrome.downloads`,
     popup-UI-driven download, options page. nhentai.net is simulated with a local HTTPS
     fixture (`--host-resolver-rules` remap + `--ignore-certificate-errors` + test cert in
     `scripts/fixtures/`); a patched-fetch fallback exists for environments where the cert
     bypass does not apply to extension pages. Needs elevated privileges to bind port 443.
   * (The CI workflow that accompanied this commit was later moved out of git — see §7.)

4. **`6d830b8` — Fix content-script gallery lookup to match real nhentai DOM; test it**
   * Important correction: on nhentai the caption `<div>` sits INSIDE the gallery cover
     `<a class="cover" href="/g/.../">`, so the content scripts must find the link with
     `closest('a[href*="/g/"]')` (ancestor walk), not `querySelector(...)` (descendant).
     With `querySelector` no checkbox would ever be injected on the real site.
   * `scripts/e2e-content.js`: VM test for the built content bundles with a DOM stub that
     mirrors the real card markup. Wired into `npm run test:e2e`.

5. **Latest (this session's final commit) — Reject non-image responses from CDN mirrors**
   * `Downloader.#downloadPageInternalAsync` now rejects any `200` response whose
     `Content-Type` does not start with `image/` (a Cloudflare challenge page or error
     document falls through to the next mirror and surfaces `unexpected content-type ...`
     instead of being zipped as an image). Covered by two tests in `test/downloader.test.js`
     (single mirror HTML → fallback succeeds; all mirrors HTML → clear error, 90 attempts).
   * CI workflow file removed from git (sandbox token cannot push workflow files) — the full
     YAML is in §7 of this document. README/backlog updated accordingly.

## 4. What is verified, and how to run it

All in `NHDW_Extension_v3.0.0/` (Node 18+):

```bash
npm ci                       # once (package-lock is committed)
npm run build                # webpack -> js/*.js
npm test                     # 19 fixture tests + 1 pending (opt-in live), offline
npm run test:smoke           # 4 checks: SW + offscreen bundles in window-less VMs
npm run test:e2e             # 19 checks: worker fallback, offscreen pipeline, SW relay,
                             #           content-script injection (chrome/fetch/DOM stubs)
npm run test:live            # opt-in: real nhentai API check (needs open internet)
npm run test:browser         # REAL browser suite (see §6; needs Chrome/Brave/Chromium + sudo)
```

Expected current results: `19 passing / 1 pending` (npm test), 4 PASS (smoke), 19 PASS (e2e).

**Every change to `src/` requires:** `npm run build` → re-copy `js/*.js` + `*.LICENSE.txt` into
`../NHDW_Release_v3.0.0/js/` → rerun the suites. The Release folder must stay byte-identical
to the Extension build outputs (verify with md5sum like the previous sessions did).

## 5. What is unfinished / known problems

* **`[~]` Real Chrome/Brave e2e execution** — the suite exists and its harness plumbing was
  validated live (headless Chromium loaded the local HTTPS `https://nhentai.net/` fixture
  through host-remap + cert bypass; every CDP sequence used — attach/evaluate/waitFor/
  setDownloadBehavior — was exercised). But the sandbox could not run the extension:
  (1) egress limited to npm + github.com (nhentai.net, Debian mirrors, Google storage,
  GitHub release assets all blocked); (2) the only npm-reachable browser, `@sparticuz/chromium`,
  is compiled without extension support (verified with a minimal MV3 test extension — no SW
  target appears, `chrome://extensions` ignores it); (3) the GitHub App token lacks the
  `workflows` permission, so the CI YAML cannot be pushed from the sandbox.
* **Base64 fallback memory** — for browsers without `chrome.offscreen`, the in-worker fallback
  still uses the base64 data URL. Acceptable fallback; not the main path in Chrome/Brave/Edge.
* **nhentai Cloudflare** — API/gallery requests can be challenged (403/503 or an HTML
  challenge page). Mitigations in place: CDN mirror fallback, content-type rejection,
  `htmlParsing` setting, and the popup's active-tab `window._gallery` fallback
  (`getGalleryFromActiveTab`, `world:"MAIN"`). Not a guarantee; docs say so.
* **`HtmlParsing.GetJsonAsync`** is fragile by design (string-split on `window._gallery =
  JSON.parse("` ... `");` + `\uXXXX` unescape) — works for the embed format it was built for
  (verified with `\u0022` fixtures), breaks silently (`TypeError`) on other formats; acceptable
  as an opt-in fallback but worth hardening (find the actual script node via DOMParser instead).
* **Multi-download progress** — batch (`downloadAllDoujinshis`) and multi-page
  (`downloadAllPages`) flows send progress, but there is no persisted job state; if the
  offscreen document is killed mid-batch, the run is lost (backlog item 11 remains open).
* **Popup "many" flow** — `popup.ts updatePreviewAll` still parses `getHtml`-scraped HTML
  with regexes (backlog item 5 suggests DOM-based extraction). Works for standard listing
  markup; the checkbox sync depends on the content script having injected first.
* **Cancellation** — `goBack` sets `isAwaitingAbort` but in-flight `fetch`es are not aborted
  with `AbortController` (backlog item 15).
* **Raw mode** cannot verify content-type (Chrome performs the download itself); accepted
  trade-off, documented in code.

## 6. Closing the last item (real Chrome/Brave e2e) — one command

On any machine with Node 18+, Google Chrome/Chromium/Brave, and sudo:

```bash
cd NHDW_Extension_v3.0.0
npm ci
sudo node scripts/e2e-browser.js --extension ../NHDW_Release_v3.0.0 \
  --browser "$(command -v google-chrome || command -v brave-browser || command -v chromium)"
```

It loads the packed Release in the real browser and prints `[PASS]/[FAIL]` for: SW
registration + clean reload, popup rendering, content scripts on nhentai-style pages
(listing checkboxes; no crash on single-gallery pages), offscreen ZIP pipeline → real
`chrome.downloads` → ZIP entries/bytes verified on disk, popup-UI-driven download, options
page. `sudo` is only needed for the local nhentai fixture on port 443; without it the
content-script/real-fetch sections SKIP with a hint. Repeat with `--browser` pointing at
Brave to cover the Brave row of the backlog matrix (Shields/Tor/private-window variants
remain manual — note them as unsupported or validated in a note).

After a successful run, flip the backlog `[~]` line to `[x]` and record browser
name/version/OS in item 10.

## 7. CI workflow (add manually — the sandbox token cannot push `.github/workflows`)

Create `.github/workflows/e2e-browser.yml` at the repo root with this content, commit and
push with an account that has write access (this is the one piece deliberately left OUT of
`main` so you can add it yourself):

```yaml
# Real-browser end-to-end tests for the NHentai Downloader extension.
#
# Runs the packed NHDW_Release_v3.0.0 folder inside a REAL Google Chrome and a
# REAL Brave browser (the automated stand-in for the backlog's manual Chrome /
# Brave end-to-end download test): service worker startup, extension popup,
# content scripts on nhentai-style pages, the offscreen-document ZIP pipeline,
# chrome.downloads, and the produced ZIP are all exercised over the DevTools
# Protocol. nhentai.net itself is simulated locally by scripts/e2e-browser.js
# (the real site is Cloudflare-gated from CI), everything else is the real
# extension code.
#
# Also runs the offline unit/VM test suites.

name: browser-e2e

on:
  workflow_dispatch:
  push:
    paths:
      - 'NHDW_Release_v3.0.0/**'
      - 'NHDW_Extension_v3.0.0/scripts/**'
      - 'NHDW_Extension_v3.0.0/test/**'
      - 'NHDW_Extension_v3.0.0/src/**'
      - '.github/workflows/e2e-browser.yml'

jobs:
  unit:
    name: Offline suites (fixtures + window-less VM bundles)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci
        working-directory: NHDW_Extension_v3.0.0
      - name: Build (webpack)
        run: npm run build
        working-directory: NHDW_Extension_v3.0.0
      - name: Fixture tests
        run: npm test
        working-directory: NHDW_Extension_v3.0.0
      - name: Window-less VM smoke tests
        run: npm run test:smoke
        working-directory: NHDW_Extension_v3.0.0
      - name: Window-less VM e2e pipelines
        run: npm run test:e2e
        working-directory: NHDW_Extension_v3.0.0

  e2e-chrome:
    name: End-to-end in real Google Chrome
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci
        working-directory: NHDW_Extension_v3.0.0
      - name: Run the extension in real Chrome
        run: |
          CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium)"
          "$CHROME_BIN" --version
          sudo -E env "PATH=$PATH" node scripts/e2e-browser.js \
            --extension ../NHDW_Release_v3.0.0 \
            --browser "$CHROME_BIN"
        working-directory: NHDW_Extension_v3.0.0

  e2e-brave:
    name: End-to-end in real Brave
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci
        working-directory: NHDW_Extension_v3.0.0
      - name: Install Brave
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq libnss3 libasound2t64 libatk-bridge2.0-0 \
            libcups2 libgtk-3-0 libxkbcommon0 libgbm1 libxss1 unzip || true
          RELEASE=$(curl -s https://api.github.com/repos/brave/brave-browser/releases/latest)
          ASSET=$(echo "$RELEASE" | python3 -c "import sys,json;print([a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if 'linux-amd64' in a['name']][0])")
          echo "Brave asset: $ASSET"
          curl -sL "$ASSET" -o /tmp/brave.zip
          unzip -q /tmp/brave.zip -d /tmp/brave
          echo "BRAVE_BIN=$(find /tmp/brave -type f -name brave | head -1)" >> "$GITHUB_ENV"
      - name: Run the extension in real Brave
        run: |
          "$BRAVE_BIN" --version
          sudo -E env "PATH=$PATH" node scripts/e2e-browser.js \
            --extension ../NHDW_Release_v3.0.0 \
            --browser "$BRAVE_BIN"
        working-directory: NHDW_Extension_v3.0.0
```

## 8. Recommended next work (priority order)

1. **Run §6 on a real machine (or §7 CI) → close backlog item 10.** Highest value, zero code.
2. Backlog **item 11** — persist active-job state (`chrome.storage.session`) so popup close /
   SW restart does not strand a download; recover progress on popup reopen.
3. Backlog **item 15** — `AbortController` cancellation: abort in-flight fetches on `goBack`.
4. Backlog **item 5** — replace the popup's regex scraping of `getHtml` output with
   `DOMParser`-based extraction of `a[href*="/g/"]` cards.
5. Backlog **item 2** — detect Cloudflare challenges at the metadata layer too (status 403/503,
   `content-type: text/html`, challenge markers) and show the existing targeted message; add
   exponential backoff between retries.
6. Harden `HtmlParsing` (find the `_gallery` script node via `DOMParser` instead of string
   splitting) — optional; it is an opt-in fallback.
7. Backlog items 6/7 (selected-gallery queue; active-context resolver for result-page IDs).
8. Optional item 3 remainder: minimum-size guard for image responses (beware tiny-but-valid
   images; a very low threshold only).

## 9. Fresh-session quick start

```bash
git clone https://github.com/freeforall1932-design/nh-dw-2.0.git
cd nh-dw-2.0
git checkout -b arena/<new-id> main          # or work directly on main
cd NHDW_Extension_v3.0.0 && npm ci
npm run build && npm test && npm run test:smoke && npm run test:e2e   # expect 19/1, 4, 19
# then pick an item from §8
```

## 10. Sandbox quirks worth knowing (don't rediscover them)

* The arena sandbox egress allows npm registry + github.com only; nhentai.net, Debian/Ubuntu
  mirrors, storage.googleapis.com (Chrome for Testing), and GitHub release assets
  (`objects.githubusercontent.com`) are unreachable. `@sparticuz/chromium` runs (extract its
  `bin/al2023.tar.br` NSS libs into a dir and set `LD_LIBRARY_PATH`) but has extensions
  compiled out — good only for plumbing checks, not extension tests.
* The GitHub App token can push normal commits but rejects any push touching
  `.github/workflows/**` ("refusing to allow a GitHub App to create or update workflow ...
  without `workflows` permission") and cannot write via the Contents API either. Hence §7.
* Between turns the workspace may reset: `node_modules/` can disappear (re-run `npm ci`),
  background processes die, and `/tmp` may clear. Re-sync Release after any rebuild.
* After a `gh` workflow run: `workflow_dispatch` is configured, so it can be triggered
  manually from the Actions tab once the YAML is in place.
