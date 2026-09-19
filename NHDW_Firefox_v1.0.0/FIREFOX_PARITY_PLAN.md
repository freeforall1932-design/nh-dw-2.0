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
