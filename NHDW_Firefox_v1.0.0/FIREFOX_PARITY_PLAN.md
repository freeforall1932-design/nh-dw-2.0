# Firefox parity elevation plan ("elevation mode")

**Date:** 2026-09-19 · follows `PORTING_AUDIT.md` (feasibility) and `README.md`
(Android v1.0.0 shipped). Sequencing agreed with the owner: Android plan
first (done) → **elevate Firefox to Chrome feature parity** → re-plan the
Android part on top of the synced codebase.

## 1. Why elevation, not patching

The Firefox folder was forked from Chrome at 3.3.0 and then diverged.
Chrome kept evolving (bookmark queue, history/verify, retry-failed, batch
pipeline, in-page list controls, hentaiera adapter…). Patching the Firefox
tree feature-by-feature would re-derive hundreds of lines Chrome already
has. The low-risk strategy is a **rebase**: make the Firefox folder equal to
the current Chrome `src/` + a small, known, audited delta set, then keep the
two trees diff-tracked so future syncs are cheap.

## 2. Chrome→Firefox delta set (the only things that may differ)

| Area | Delta | Reason |
|---|---|---|
| `manifest.json` | gecko.id, `background.scripts` (no service_worker), no `offscreen`/`sidePanel` perms, min 142.0 + data_collection_permissions, icons 48/96/128, content_scripts gains `js/listControls.js` after rebase | Firefox platform |
| `src/background/background.ts` | + job keep-alive alarm (Android event-page suspension); sidePanel/offscreen code stays (feature-detected, unreachable/optional on Firefox) | Android robustness |
| `src/preview/preview.ts` | + `refreshHostNotice` (MV3 opt-in host grants), + runtime mobile action bar relocator | Firefox MV3 + Android UI |
| `src/preview/message.ts` | + `hostGrantNotice` | additive |
| `css/style.css` | + phone media block (coarse-pointer gated) incl. `#nhdwMobileBar` | Android UI |
| `index.html` / `options.html` | + viewport metas | Android UI |
| webpack | + `listControls` entry | parity feature |
| `test/manifest.test.js` | Firefox-manifest describe block | guards |

Everything else must be **byte-identical to Chrome** after the rebase.

## 3. Desktop/mobile separation rules (owner mandate)

- **R1** Mobile-only behaviour is gated at runtime (`matchMedia
  (max-width:640px) and (pointer:coarse)`) or inside that CSS media query.
  Shared DOM is never restructured for mobile (the v1.0.0 `.nhdwActionBar`
  wrapper experiment violated this and was reworked into the runtime
  relocator — see README "Android UI").
- **R2** Parity features land desktop-identical to Chrome first; the mobile
  adaptation layer is applied afterwards, additively.
- **R3** Every rebase PR verifies: `diff -rq` Chrome/src vs Firefox/src
  shows only the delta set; `npm test` green in both folders; `web-ext lint`
  0 errors; Chrome folder untouched.

## 4. Phases

- **P0 (done):** Android v1.0.0 shipped; desktop-violation rework; separation
  rules codified.
- **P1 rebase (done 2026-09-19, v1.1.0):** Firefox folder now equals Chrome
  `src/**` + the 4-file delta (background/preview/message/popupSettings —
  verified additive except the two sidePanel-gate lines), Chrome css/html +
  media-gated mobile block, Chrome test suites wired into `npm test`
  (406 passing), smoke/e2e incl. `e2e-list-controls` + `e2e-popup` green,
  `web-ext lint` 0 errors/0 notices, package ships `js/listControls.js`
  (23 entries). `diff -rq` against Chrome shows only the audited delta set.
  New delta discovered during rebase and added to section 2:
  `popupSettings.ts` hides the side-panel option when `chrome.sidePanel`
  is absent.
- **P2 Firefox-runtime verification:** desktop Firefox manual pass (side
  panel code path inert, popup/queue/history/☆ work); keep-alive + host
  notice verified; `web-ext lint` + package.
- **P3 Android re-plan on synced base:** re-derive the mobile UI plan with
  the in-page list controls now present (the floating `.nhdw-action-bar` is
  *already* the Android bottom-bar pattern — on phones it only needs the
  coarse-pointer compact tweaks); device test matrix; sign as 1.1.0.

## 5. Versioning

1.0.0 = Android-ready snapshot (shipped). 1.1.0 = parity elevation (+ its
Android re-plan). Independent sequence, never synced to Chrome's numbers.

## 6. P1 review (2026-09-19, same session) — results

Owner-mandated hunt for truncated/broken code after the rebase. Findings:

1. **popupSettings select drift (fixed):** stored `uiMode:"sidepanel"` left the
   Firefox select (which no longer offers the option) value-less. Delta now
   normalizes to `"popup"` when `chrome.sidePanel` is absent.
2. **`chrome.windows.getCurrent` (2 call sites — safe):** both are inside the
   `sidePanel.open` feature gate + try/catch (`bookmarkPanel.ts`,
   `popupSettings.ts`); unreachable on Firefox/Android. Left as Chrome code
   per the rebase philosophy.
3. **`chrome.offscreen` / `chrome.sidePanel` refs:** all feature-detected,
   gated, or in comments. No unguarded Chromium-only call survives.
4. **Dynamic-id false alarms:** `getElementById` refs not present in
   `index.html`/`options.html` are all runtime-created (message strings,
   bookmark panel, template checkboxes) — verified, not defects.
5. **`node_modules` is not snapshot-persisted** — run `npm install` first
   thing every new session (webpack/mocha absent otherwise).
6. Everything else green: 406 tests, smoke 7/7, e2e (incl. list-controls +
   popup harnesses), lint 0 errors/0 notices, 23-entry v1.1.0 package with
   `js/listControls.js`.

## 7. P2 status

Real desktop-Firefox + Android-device verification cannot run in this
sandbox (no browser/device). **P2 is folded into item 58**: one combined
verification session after the embedded-UI work, covering both surfaces,
then sign 1.2.0. Nothing is lost; it is rescheduled, not skipped.

## 8. P4 — website-embedded UI (owner direction, 2026-09-19)

Owner intent: the integrated (in-page) UI becomes the PRIMARY surface; the
toolbar popup/side-panel equivalent is demoted to "settings / paste API key"
fallback; the invoker that opens extension UI should be baked into the
website; ideally ALL settings live in-page so the tool feels like part of
nhentai.net. Scope: **nhentai only** (multi-site stays parked).

### 8.1 Feasibility (from the in-repo capture `5 website page source`)

nhentai's header is the one layout-stable region and it exists in ALL three
captured layout generations:

- `.navbar` container; `.navbar_left` holds the logo, `#drop_btn` (dropdown
  with Home/Random/Tags/…) and `#nav_btn` — the 3-line hamburger
  (`.navbar-toggle` with three `.icon-bar`s); `.navbar_search` (`#q`);
  `.navbar_right` (Login/Register).

Conclusion: **feasible**. Hook points, in preference order:
1. a dedicated invoker button injected next to `#nav_btn`/`#drop_btn`
   (mobile: header always shows these; desktop: same row);
2. an extra `<li>` inside `#dropdown_menu` ("Downloader settings");
3. `.navbar_right` as a desktop secondary slot.
Injection must be idempotent + MutationObserver-guarded (same pattern as
`listControls.ts`), anchored ONLY to `.navbar` (never to the changing page
body), and themed to match the site (dark navbar).

### 8.2 Design sketch (item 56)

- New content module (e.g. `src/content/siteUi.ts`, webpack entry
  `siteUi.js`, added to `content_scripts`) OR an extension of
  `listControls.ts`: injects invoker + a slide-down **settings drawer**
  under the navbar.
- The drawer reuses the EXISTING renderers against its own container —
  `renderSettings(container)` (popupSettings) and the queue renderer from
  `bookmarkPanel.ts` — so no duplicated settings logic; content scripts have
  `chrome.storage` access for persistence and message the worker for
  downloads/bookmarks exactly like today.
- Popup demotion (item 57): keep `index.html` (it already IS tabbed
  Download/Queue/Settings) but treat it as fallback; evaluate hiding the
  Download tab in-page when the embedded UI is active (storage flag) —
  decision deferred to implementation.
- Toolbar button on Android: with the invoker in-page, evaluate
  `action.setPopup("")` + `onClicked → scripting.executeScript` toggling the
  drawer, so the toolbar also feels baked-in (desktop keeps the popup).
