# NHentai Downloader — Firefox + Firefox-for-Android build (v1.0.0)

**Updated:** 2026-09-19 · status: **Android-ready, package pipeline live**

This folder is the Firefox port of the Chrome MV3 extension
(`NHDW_Extension_v3.0.0`). It now targets **Firefox desktop AND Firefox for
Android** from one package. This README is the living document for the port:
what shipped, how the mobile UI works, how to test / package / sign, and what
remains. The original feasibility study is preserved in `PORTING_AUDIT.md`;
the Android migration plan and finished-product definition are below.

## Versioning (why 1.0.0, not 3.x)

The Firefox build is a **separate product line** with its own AMO version
sequence. `1.0.0` = the snapshot at Chrome **3.3.0** feature parity; Chrome
features added after that (bookmark queue, download history, verify/retry
pipeline — see Chrome's `src/utils/bookmarkQueue.ts` etc.) are **not** ported
yet and are follow-up work (see "Roadmap"). AMO only requires the version to
increase monotonically per add-on id, so this sequence starts at 1.0.0 and
bumps 1.0.1 / 1.1.0 from here.

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
  desktop popup DOM is byte-identical to the classic layout (audited with
  `git diff` against the pre-Android tree — `popup.ts` identical,
  `message.ts` additive-only, CSS pure additions); safe-area-inset aware;
- `index.html` / `options.html` now declare a device-width viewport meta.

This mirrors the Chrome build's own UI thinking: Chrome's side panel is the
same document with the fixed width dropped (`html.nhdwPanel`), and Chrome's
flagship mobile pattern is the in-page bottom action bar. Android has no
side-panel API, so the full-tab popup with the bottom bar is the native
equivalent. The Chrome-only **in-page card controls** (`listControls.ts`,
per-card Download/Select/☆ + floating bar) are not in this port yet — they
depend on the not-yet-ported utils (`downloadFormats`, `downloadHistory`,
`bookmarkQueue`, `siteKeys`) and are Roadmap item 1.

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
| F2 | Responsive portrait UI: fixed bottom action bar via runtime reflow, stacked columns, compact touch targets; desktop popup DOM byte-identical (audited); no horizontal scroll at 360px | ✅ shipped, reworked for desktop purity |
| F3 | Keep-alive alarm active only during jobs | ✅ shipped |
| F4 | First-run host-permission grant guard (Firefox MV3 semantics) | ✅ shipped |
| F5 | Manifest regression tests incl. Firefox guards (gecko.id, event page, no offscreen perm, viewport metas, icon files, host scoping, min-version, data declaration) | ✅ 9 new tests, suite green |
| F6 | Packaging: `npm run package:firefox` → clean zip (no src/test/scripts/build/node_modules/.git, no .ts/.map, no offscreen files) | ✅ 21 entries, 84 KB |
| F7 | Device-test + signing runbooks (below), incl. AMO content-policy caveat | ✅ this README |
| F8 | Chrome folders untouched; CI stays green (new lint step added to the Firefox job) | ✅ |

Out of scope by design: Chrome feature catch-up, new sites, offscreen
re-architecture.

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

The Firefox build lags Chrome substantially on desktop (see
`FIREFOX_PARITY_PLAN.md` §1–2 for the full gap matrix). Agreed sequencing:
Android plan first (done) → **rebase Firefox onto current Chrome src** with
the audited delta set → re-plan Android on the synced base.

1. **P1 rebase to Chrome parity**: in-page card controls (`listControls.ts`),
   bookmark queue, download history / verify / retry-failed, batch pipeline,
   list-mode settings, PDF-merge warning.
2. **P3 Android re-plan** on the synced base (the in-page floating bar is
   already the Android bottom-bar pattern).
3. Crisp master icons at 96/128 (current files are rescales of the 64px
   source via `Icon-*.png`).
4. Side-panel equivalent if Firefox ever ships `sidePanel` on Android.
