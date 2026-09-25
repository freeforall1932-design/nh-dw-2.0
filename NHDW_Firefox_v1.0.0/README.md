# NHentai Downloader — Firefox + Firefox-for-Android build (v1.4.3)

**Updated:** 2026-09-26 · status: **website-embedded UI + PR #44 review fixes
(items 56/57), options harness/fixes (38), shared list-format fix (59) and the
Chrome-3.9.0 backport — bookmark icon, gallery-page Bookmark button, Queue-tab
markup (43), drag-reorder (44), backup import/export (52), canonical-separator
gate (41) — complete, plus the **Chrome-3.10.0 listing backport (v1.4.0), the
v1.4.1 review fixes and the v1.4.2 Bookmark-tab rename** — merged to main in
PR #50; real-device verification + signing remain pending (58)**

v1.4.3 = the panel list's shared-selection pointer and the List-mode hint
(item 71), plus the skip-guard identity fix (a recorded bare id is the default
site's record, never this job's). v1.4.2 = the panel's third tab is labelled
**Bookmark** (item 65, UI-only: the
`bookmarkQueue` storage key, `#tabQueue` / `#queuePane` ids, message actions and
the export format are unchanged). v1.4.1 = v1.4.0 plus the 2026-09-26 review fixes (listing-only guard for card
controls, `allIdsSite` requested by the bar reader, nhentai-only legacy
checkbox). v1.4.0 = the Chrome 3.10.0 listing work, ported: card controls
(Select + Bookmark + Download) now render on **all six sites'** listing pages
from a per-site selector table in `src/utils/listCards.ts` (a second
`content_scripts` block covers the five non-nhentai listing hosts), every
gallery page carries a **Save offline** button beside Bookmark plus a **Select**
control, and the floating bar offers **Select all** and stays visible while the
page has cards. Selection is wiped per-site (new `allIdsSite` key) instead of
globally.

v1.3.0 = the Chrome 3.9.0 bookmark work, ported: the card control is a real
bookmark glyph, every single-gallery page (all six sites) carries a blue
**Bookmark** button, the Queue tab's rows drag-reorder, a downloading row shows
a red **Cancel** button (per-row cancel, item 45), and the tab can export and
import the queue + history as one JSON file. The Chrome 3.9.0 filename
template cleanup (item 39) and the constant-memory streaming ZIP writer
(item 51) are ported too.

v1.2.0 = the in-page drawer is the primary surface on nhentai.net. A
**Downloader** button sits in the site header next to the hamburger; it opens
a slide-down panel with This page / Queue / Settings (reusing the existing
renderers, no duplicated logic). The toolbar popup is the fallback for
progress, similar galleries, retry-failed and the API key. Phones open the
drawer from the toolbar button; desktop keeps the popup unless you change
Settings → In-page panel.

v1.1.0 was the parity elevation: this folder equals the current Chrome `src/`
plus an audited delta (see `FIREFOX_PARITY_PLAN.md`). The Firefox offline
suite now has **620** passing / 4 deliberately opt-in live tests pending
(including the Item 48 multi-site batch download suite and all 6 site adapters).

Review fixes include working embedded settings, shared Settings/Queue layout
CSS, safe reattachment/live updates, and a Full panel tab bound to the nhentai
page that opened it (including retries and pasted-bookmark metadata). Offline
tests cover these paths; this is **not** a claim of Firefox/Android device
verification. Manifest is **1.4.3** (1.4.3 = the item-71 pointer + guard fix,
same as Chrome 3.10.3; 1.4.2 = the Bookmark-tab rename, same as
Chrome 3.10.2; 1.4.0 = the per-site listing card controls, the
gallery-page Save offline / Select controls and Select all, backported from
Chrome 3.10.0; 1.4.1 = the same review fixes as Chrome 3.10.1); no signing run
has been performed.

Item 38 adds **33 offline options-page tests**, using the actual HTML and built
bundle. Options now restore saved list formats, display legacy PDF values,
hide an unavailable side-panel choice, and keep inherited/empty-template
previews accurate without writing on load.

**Item 59 is now complete in both trees** (the Chrome readers were ported
2026-09-25 — merged to main in PR #50): shared settings and download readers
explicitly request the saved list-format key. Saved ZIP/CBZ/PDF/raw overrides single-title
format in the popup/Full panel, embedded Settings/Queue/gallery and in-page
card/bar controls. Unset/null/blank/invalid values inherit; neither usable
means ZIP; legacy `folder` still means PDF. Reads do not write defaults or
migrate preferences; explicit changes persist and survive reopening. A
36-case matrix tests the real reader and affected built bundles, offline.
Chrome was not changed or backported by this Firefox-only task.

This folder is the Firefox port of the Chrome MV3 extension
(`NHDW_Extension_v3.0.0`). It now targets **Firefox desktop AND Firefox for
Android** from one package. This README is the living document for the port:
what shipped, how the mobile UI works, how to test / package / sign, and what
remains. The original feasibility study is preserved in `PORTING_AUDIT.md`;
the Android migration plan and finished-product definition are below.

## Versioning (why 1.0.0, not 3.x)

The Firefox build is a **separate product line** with its own AMO version
sequence. `1.0.0` = the Android-ready snapshot of the old 3.3.0-era fork;
`1.1.0` = the parity elevation (P1 rebase onto the current Chrome tree);
`1.2.0` = website-embedded UI. AMO only requires the version to increase
monotonically per add-on id, so this sequence never tracks Chrome's numbers.

## Manifest facts (audited against MDN/BCD, 2026-09)

- `manifest_version: 3`, `background.scripts` (Firefox MV3 event pages —
  Firefox has **no** `background.service_worker`).
- `browser_specific_settings.gecko.id` = `nhentai-downloader-firefox@freeforall1932.design`
  (required for signing + stable storage).
- `strict_min_version: 142.0` — the floor dragged in by the
  `data_collection_permissions` declaration (desktop 140 / Android 142);
  today's Firefox release is ≈154, so no release-channel user is lost.
- `data_collection_permissions: { required: ["none"] }` — required for new
  AMO listings since Nov 2025; truthfully: nothing leaves the device.
- `alarms` keep-alive (see "Background robustness" below).
- No Chromium-only permission; `offscreen` is Chrome-only and only exists in
  the Chrome manifest. The `chrome.offscreen` call sites are feature-detected
  and unreachable on Firefox (the full fallback path runs instead, and in
  Firefox's document-based event page `URL.createObjectURL` exists, so the
  memory-friendly blob path is used — not the base64 one).
- Firefox MV3 does **not** grant `host_permissions` at install; the popup
  shows a first-run "Enable site access" grant notice (`refreshHostNotice`
  in `src/preview/preview.ts`, one-tap `permissions.request`).
- `offscreen.html` / `js/offscreen.js` are excluded from the packaged
  artifact (dead code on Firefox).

## Android UI (portrait-first, compact)

On Firefox for Android the action popup opens **in a full tab**, so the
document is the whole UI. The layout is responsive, gated by
`@media (max-width: 640px) and (pointer: coarse)` — the extra
`pointer: coarse` matters because the *desktop popup itself* is 500px wide
and must keep its classic look. On phones:

- single tall column (`.popupColumns` stacks), long titles wrap;
- inputs/selects full-width, 16px font (prevents Android focus-zoom),
  ≥42–44px touch targets, larger checkboxes;
- **fixed bottom action bar**: `preview.ts` relocates the current state's
  primary buttons (`Download`, `Download all`, `Pause/Resume`, `Clear queue`,
  `Cancel`, API-key gate, host/CDN grant) into a `#nhdwMobileBar` footer at
  **runtime**, and only while
  `matchMedia("(max-width:640px) and (pointer: coarse)")` matches. The
  desktop popup markup keeps the classic layout (`message.ts` additive-only;
  the later PR #44 review changes `popup.ts` source-tab routing, not its
  renderer markup); safe-area-inset aware;
- `index.html` / `options.html` now declare a device-width viewport meta.

This mirrors the Chrome build's own UI thinking: Chrome's side panel is the
same document with the fixed width dropped (`html.nhdwPanel`), and Chrome's
flagship mobile pattern is the in-page bottom action bar. Android has no
side-panel API, so the in-page header invoker + drawer (v1.2.0) is the
native equivalent, with the full-tab popup as fallback. In-page card
controls (`listControls.ts`) shipped in v1.1.0.

## Background robustness on Android

Firefox suspends idle event pages (~30 s; more aggressively on Android under
RAM pressure). `background.setJobMarker`/`clearJobMarker` now also
create/clear a 1-minute-period `nhdw-keepalive` alarm while a download job is
active — each tick is an event the page is woken for, so multi-minute ZIP
builds survive; when nothing is downloading, idle suspension still applies.

## Finished-product definition (acceptance criteria)

| # | Criterion | Status |
|---|---|---|
| F1 | Canonical Firefox `manifest.json` (MV3, gecko.id, min 142.0, data-collection declaration, icons 48/64/96/128 with true-size PNGs) | ✅ shipped + tested |
| F2 | Responsive portrait UI: fixed bottom action bar via runtime reflow, stacked columns, compact touch targets; desktop popup markup unchanged; no horizontal scroll at 360px | Implemented; real-device/360px verification pending under 58 |
| F3 | Keep-alive alarm active only during jobs | ✅ shipped |
| F4 | First-run host-permission grant guard (Firefox MV3 semantics) | ✅ shipped |
| F5 | Manifest regression tests incl. Firefox guards (gecko.id, event page, no offscreen perm, viewport metas, icon files, host scoping, min-version, data declaration) | ✅ 9 new tests, suite green |
| F6 | Packaging: `npm run package:firefox` → clean zip (no src/test/scripts/build/node_modules/.git, no .ts/.map/logs, no offscreen files) | ✅ entries reviewed in 1.2.0, including shared renderer CSS; re-run before signing 1.3.0 |
| F7 | Device-test + signing runbooks (below), incl. AMO content-policy caveat | ✅ this README |
| F8 | Chrome folders untouched; CI stays green (new lint step added to the Firefox job) | ✅ |

Out of scope for this review: new sites, Chrome changes and offscreen
re-architecture. Chrome feature catch-up already landed in v1.1.0.

## Offline verification

Use a maintained Node 22/24 LTS installation (tooling requirement:
`^20.19.0 || ^22.13.0 || >=24.0.0`). Tested on Node 22.22.3 with clean installs
under npm 10.9.8 and 12.0.2. From this folder:

```sh
npm ci --no-fund
npm audit
npm run build
npm test
npm run test:smoke
npm run test:e2e
npm run lint:firefox
# Focused options-only rerun (uses the bundle from the build above):
npm run test:options
```

Current evidence: **474 unit tests / 4 pending**, smoke7, all offline e2e
(including 15 site-UI, 11 toolbar and 33 options tests, plus normal/Full panel
format/Queue checks), lint **0 errors / 0 notices / 30 existing warnings**.
The four pending tests are intentionally opt-in live API checks, not failures.
Item 59's focused reader tests are **79/79** (the baseline fails 20); the
format matrix also checks read-only rendering and independent saved edits.
Storage reads are asynchronous, cloned and key-scoped; fetches are mocked,
no real key or website is needed. These tests do not verify browser layout,
Firefox APIs on-device, Android behavior or signing. The directly delivered
listing-format message is not the full listing-bootstrap harness (item 40).

Dependency maintenance (2026-09-21) updates Mocha to 12.0.2 and web-ext to
10.6.0; a scoped override selects patched addons-linter 10.13.0. Full and
runtime-only audits report **0 vulnerabilities**. The current Mozilla tooling
still emits **two install deprecations** (ESLint 9 and whatwg-encoding); forcing
incompatible transitive upgrades just to silence them is intentionally avoided.
These are development dependencies, not shipped extension code. Details and
recheck commands: [`DEPENDENCY_MAINTENANCE.md`](../DEPENDENCY_MAINTENANCE.md).

## Local load (developer, desktop)

1. `npm ci && npm run build`
2. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** → select `manifest.json`.
3. `npm run lint:firefox` — Mozilla's validator over the packaged file set
   (0 errors; remaining warnings are advisory innerHTML/webpack false
   positives plus the guarded offscreen probe, acceptable for review).

## Test on Firefox for Android

Requirements: Android platform-tools on PATH (`adb`), USB debugging enabled,
Firefox for Android installed (release/beta/nightly), device or emulator
visible in `adb devices`.

```bash
npm run run:android        # = web-ext run --target=firefox-android --firefox-apk org.mozilla.firefox
# variants:
npx web-ext run --target=firefox-android --firefox-apk org.mozilla.firefox_beta
npx web-ext run --target=firefox-android --android-device <serial>
```

Device test matrix: (a) install → first-run "Enable site access" grant
prompt; (b) toolbar action opens the popup as a full-width tab, single
column, bottom bar visible; (c) single-gallery ZIP download survives app
switching and 60s+ zip time (keep-alive); (d) progress state shows
Pause/Cancel in the bottom bar; (e) content-script checkboxes appear on
nhentai.net listings; (f) queue/history (storage) survive browser restart.

## Package & sign (self-distribution)

```bash
npm run package:firefox      # → dist/nhentai_downloader-<version>.zip  (valid XPI format)
```

Signing for self-distribution (unlisted — never listed on AMO; users install
the signed .xpi directly; on Android: download the file and open it in
Firefox):

```bash
# One-time: AMO developer account → API keys. Keys live ONLY in env vars,
# never in the repo: WEB_EXT_API_KEY (JWT issuer), WEB_EXT_API_SECRET.
npm run sign:firefox         # = web-ext sign --channel unlisted --artifacts-dir dist
```

- Bump `version` in `manifest.json` before every sign run (AMO rejects
  duplicates).
- ⚠️ **Content-policy caveat:** even unlisted signing goes through AMO's
  pipeline, and Mozilla restricts sexually explicit content. Reviewers see
  the target sites; if a submission is rejected on those grounds, the tester
  fallback is temporary unsigned install via Firefox Nightly/Beta on Android
  (`xpinstall.signatures.required=false` — not possible on release).

## Roadmap (post-1.0.0) — "elevation mode"

The Firefox build originally lagged Chrome substantially (historical rationale
in `FIREFOX_PARITY_PLAN.md` §1–2). The parity elevation is now complete; the
agreed sequencing was:
Android plan first (done) → **rebase Firefox onto current Chrome src** with
the audited delta set → re-plan Android on the synced base.

1. **P1 rebase to Chrome parity** — ✅ done in v1.1.0: in-page card controls
   (`listControls.ts`), bookmark queue, download history / verify /
   retry-failed, batch pipeline, list-mode settings, PDF-merge warning.
2. **P2 desktop verification** (manual Firefox-desktop pass) and **P3 Android
   re-plan** on the synced base — the in-page floating `.nhdw-action-bar` is
   already the Android bottom-bar pattern and only needs the coarse-pointer
   compact tweaks.
3. Crisp master icons at 96/128 (current files are rescales of the 64px
   source via `Icon-*.png`).
4. Side-panel equivalent if Firefox ever ships `sidePanel` on Android.
