# Firefox parity elevation plan ("elevation mode")

**Date:** 2026-09-19 · follows `PORTING_AUDIT.md` (feasibility) and `README.md`
(Android v1.0.0 shipped). Sequencing agreed with the owner: Android plan
first (done) → **elevate Firefox to Chrome feature parity** → re-plan the
Android part on top of the synced codebase.

**Latest checkpoint, 2026-11-24:** owner-requested catch-up (§13) brought
Firefox to Chrome 3.14.0 + everything after the 2026-10-20 sync (`5834582`):
Hitomi resolver, universal chapter tool / Chapters page / mangak, benchmark
log, archive/retry hardening, Tailspace site profiles, MangaThemesia fallback,
theme tokens. Firefox **1.7.0**. Source allowlist: nine changed existing files
+ two Firefox-only files (`listControls.ts` is byte-identical again).
Device verification/signing (58) remains pending; no automatic Chrome backport.

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
| `src/preview/preview.ts` | + `refreshHostNotice` (MV3 opt-in host grants), + runtime mobile action bar relocator, + `Chapters ↗` opens `chapters.html?tab=<source tab>` (no side panel to borrow the active tab from) | Firefox MV3 + Android UI + §13 |
| `src/preview/message.ts` | + `hostGrantNotice` | additive |
| `css/style.css` | Chrome's 3-way merge minus the renderer rules (extracted to `panelRenderers.css`) + phone media block (coarse-pointer gated, tokenised) incl. `#nhdwMobileBar` | Android UI + PR #44 review |
| `css/panelRenderers.css` (new) | Chrome's Settings/Queue/Bookmark declarations, scoped to their popup/drawer containers; imported by style.css and injected by manifest. Opens with a `#nhdwSiteUi` mirror of every `theme.css` token at its dark value (theme.css is never injected into websites), then drawer primitives; no per-theme `#htmlDark` pairs. Guarded by `test/theme-budget.test.js` | PR #44 review + §13 |
| `css/content.css` | byte-identical Chrome prefix, then a `FIREFOX-ONLY DELTA` marker and the embedded-UI / invoker / drawer block (item 56); the theme budget only checks the Chrome prefix | item 56 + §13 |
| `index.html` / `options.html` | + viewport metas | Android UI |
| webpack | + `listControls` + `siteUi` entries | parity + item 56 |
| `test/manifest.test.js` | Firefox-manifest describe block | guards |
| `package.json` / lockfile | Firefox-only web-ext 10.6.0 and scoped addons-linter 10.13.0 override; Mocha 12.0.2 / Node range shared with Chrome | owner-requested tooling maintenance |
| `src/utils/embeddedUi.ts` (new) | website-embedded UI contract | item 56/57, Firefox-first |
| `src/content/siteUi.ts` (new) | header invoker + drawer | item 56 |
| `src/background/background.ts` | + keep-alive **and** toolbar `onClicked` / per-tab `setPopup` / `siteUiOpenPanel`; no `ICON_THEMES` tryout map | Android + item 57 |
| e2e harness (`scripts/e2e-worker.js`, `e2e-popup.js`, `e2e-options.js`, `e2e-offscreen.js`, `e2e-relay.js`) | Firefox stubs: `moz-extension://<uuid>/` `getURL`, gecko `runtime.id`, single `localStore`, `tabs.create` capture; never copy the Chrome scripts over them | §13 |
| `src/preview/popupSettings.ts` | sidePanel filter, In-page panel preferences (gated on `shipsSiteUi()`), explicit optional list-format read; no logo-lab toolbar-icon tryout (Chrome-only owner experiment, its `assets/icons/` are not shipped) | Firefox + items 57/59 |
| `src/utils/listSettings.ts` | explicitly request optional `listFormat`, then merge only other defaults; no migration/write on read | approved item 59, Firefox-only |
| `src/content/listControls.ts` | same explicit optional-key read for card/bar settings | approved item 59, Firefox-only |
| `src/options/options.ts` | explicit optional list-format read, display-only normalization/capability gate, live and empty-template previews; + `applyDarkMode()` (Chrome themes options through the panel) | item 38 offline regressions; §13 |
| `src/preview/activeTabGallery.ts` | validated Full panel source-tab context; ordinary popup keeps active-tab behavior | PR #44 review |
| `src/preview/popup.ts` | script injection uses source context; retries use nhentai-guarded source | PR #44 review |
| `src/background/bookmarkService.ts` | optional source context for Full panel bookmark enrichment, validated before injection | PR #44 review |

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
Android re-plan). 1.2.0 = website-embedded UI (items 56/57); 1.3.0 =
bookmark icon + gallery-page Bookmark button + Queue-tab extras (Chrome 3.9.0);
1.6.0 = items 72-74 (Chrome 3.14.0); 1.7.0 = the 2026-11-24 catch-up (§13). Independent
sequence, never synced to Chrome's numbers.

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
then sign the current version (**1.3.0** as of 2026-09-23; it was 1.2.0 when
this plan was written). Nothing is lost; it is rescheduled, not skipped.

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


## 9. PR #44 review (2026-09-20, `arena/01a0bfa1-nh-dw-2-0`)

Fixed missing settings storage wiring/key reads, wrong storage-event arity,
missing shared renderer CSS and on-demand CSS injection, badge observer loop,
detached-drawer Queue loss, unanchored toolbar toggles, stale listing counts
and navbar-blocking backdrop. Full-panel tabs now carry a validated
`sourceTabId` through bootstrap/preview/retries/enrichment; failed tab creation
is reported, and sender-tab fallback excludes extension/foreign pages.

At this review checkpoint the `src/` diff was **seven changed existing + two new**:
background, bookmarkService, activeTabGallery, message, popup, popupSettings,
preview; plus siteUi and embeddedUi. This is additive to the historical
four-file P1 delta, not an invitation to overwrite Chrome. Other source files
remain byte-identical. No permissions or web-accessible resources added.

Firefox 431 unit tests / 4 pending; smoke + all offline e2e pass, including
11 site-UI Node tests, 11 toolbar-worker Node tests, the Full panel popup
variant and relay sender guards. Chrome 398 unit tests / 4 pending, no tracked
changes. Lint 0 errors / 0 notices (30 advisory warnings); clean 25-entry
unsigned package. Real Firefox/Android verification and signing still require
item 58. The then-proposed item 38 was subsequently approved and completed (§10).


## 10. Approved Firefox options harness (2026-09-21, same branch)

Item 38 adds `e2e-options.js` and a dependency-free DOM/storage helper reading
real `options.html`; runs the built options bundle, not duplicated application
logic. 33 tests cover storage/defaults, real select choices, explicit edits,
preview inheritance/empty templates, local credentials and history. It is in
`test:e2e` and also available as `test:options` after a build. The saved old
bundle fails 8 cases; the rebuilt bundle passes all 33.

Only newly changed production source: **`src/options/options.ts`**. Request
`listFormat` explicitly without defaulting an unset key; normalize legacy PDF
values for display only; remove unsupported side-panel choice without saving;
refresh inherited previews and honor empty templates. Generic option classes,
HTML, permissions and Chrome are unchanged. This is a regression-driven
Firefox delta, not a UI redesign or automatic Chrome backport.

**At the item-38 checkpoint: eight existing files + two new** (add options
to §9's list). Firefox build, 431/4 unit tests, smoke7, all offline e2e and
lint pass (0 errors / 0 notices / 30 warnings); clean 25-entry unsigned 1.2.0
package. Real-device/signing gate 58 remains open. Then-proposed item 59
recorded the same omitted-key defect in shared readers; those paths were NOT
fixed by this options-only task. They were later approved/fixed separately (§12).


## 11. Dependency maintenance (2026-09-21, same branch)

Owner asked about npm deprecations and authorized necessary upgrades. Both
maintained folders now use Mocha 12.0.2; Firefox uses web-ext 10.6.0 with
addons-linter 10.13.0 selected via a scoped security override. fast-uri updated
within its existing range. Full audits: Firefox 16→0 / Chrome 5→0; production
only: 0. Two upstream Firefox install deprecations remain (ESLint 9 legacy API
and Cheerio's older codec), honestly documented rather than suppressed.

Both builds/unit/smoke/offline e2e and Firefox lint/package pass. Source delta
remains **eight existing + two new**; all extension source, runtime dependency
versions/integrities and bundles unchanged by this task. Only tooling, Node
requirements and docs changed, not Chrome product features or the CI workflow.
See root `DEPENDENCY_MAINTENANCE.md` for the override's removal condition,
verified npm versions, remaining warnings and historical-snapshot exclusion.


## 12. Approved shared list-format readers (2026-09-21, same branch)

Item 59 fixes omitted-key reads in `utils/listSettings.ts`,
`preview/popupSettings.ts`, and the independently reading
`content/listControls.ts`. Request optional `listFormat` explicitly, then
merge other defaults. Do not add it to `LIST_MODE_DEFAULTS`: absence must
still inherit single-title format. Existing normalization handles all four
formats and legacy folder→PDF; reads/rendering remain write-free and explicit
edits persist without clobbering siblings. No UI redesign or new feature.

Updated unit/list-controls mocks no longer return the entire stored profile
for a key-scoped query; shared fixtures also cover async callbacks and cloned
values. The real reader and built consumers run the same **36-case** matrix.
Popup/Full panel Settings and Queue, in-page card/bar, and embedded Settings/
gallery/Queue are covered, plus listing-format rendering from a delivered
`getGalleries` message. Full listing bootstrap/pagination (40) is still open.

**Current source delta: ten changed existing files + two new**, verified
against Chrome (all other TS source byte-identical):

- background/background, background/bookmarkService;
- content/listControls;
- options/options;
- preview/activeTabGallery, preview/message, preview/popup,
  preview/popupSettings, preview/preview;
- utils/listSettings;
- new Firefox-only content/siteUi and utils/embeddedUi.

Only `listSettings` and `listControls` are newly added to the existing source
allowlist; `popupSettings` already differed. Rebuilt preview/siteUi/listControls
bundles only. Chrome, dependencies, manifest/permissions, HTML/CSS and CI
unchanged by 59; preserve the earlier separately approved tooling updates.

Focused units **59 pass / 20 fail → 79/79**, site UI **11/15 → 15/15**, old
popup and in-page bundles red. Firefox **474 unit pass / 4 pending**, smoke7,
all offline e2e (options33, toolbar11, both popup variants) green; lint **0
errors / 0 notices / 30 unchanged advisories**; unsigned **1.2.0 ZIP25**.
The four pending tests remain intentionally opt-in live checks. No live-site,
real-device or signing evidence; 58 remains the release gate.

## 13. Catch-up to Chrome (owner request, 2026-11-24, `arena/2943994c-nh-dw-2-0`)

Owner: "Do a catch up on Firefox all update that's been postponed on Firefox
part." This lifts, for this sync, the 2026-10-27 "Chromium-only for now"
deferral. Method: three-way `git merge-file` of every Chrome file changed
since `5834582` (base = Chrome at that commit, ours = Firefox, theirs = Chrome
HEAD); new Chrome files copied; conflicts resolved by keeping Chrome's logic
plus the §2 delta. No logic was rewritten for Firefox beyond the rows below.

Ported: Hitomi resolver (gg.js text parse, `galleries/{id}.js` metadata,
blocked-gallery 403 handling, DNR `Referer`/`Origin` session rules), the
universal chapter tool (`universalChapterProbe`, `chapters.html`, mangak
`__NEXT_DATA__`, MangaThemesia fallback, Tailspace `siteProfiles`), the
benchmark/extension log, archive/retry hardening, theme tokens, item 68/70/71.

Firefox-specific decisions:

- **DNR initiator.** Firefox matches an extension request by its
  `moz-extension://<uuid>` host, not the gecko id (`ExtensionDNR.sys.mjs`).
  Shared `siteHeaderRules.ts` now uses `extensionInitiatorHost()` (the
  `runtime.getURL` host) in both trees; Chrome still gets its extension id.
  Manifest gains `activeTab` + `declarativeNetRequestWithHostAccess`; host
  permissions equal Chrome's.
- **Chapters ↗.** Firefox has no side panel, so `preview.ts` passes the
  source tab id: `chapters.html?tab=<id>` (refuses an extension-page source).
- **Theme.** `theme.css` is linked by `index.html` and `options.html`;
  options applies dark mode itself; the website drawer gets the token mirror
  in `panelRenderers.css` (see §2).
- **Not ported:** the logo-lab toolbar-icon tryout (Chrome-only owner
  experiment).

Verification (offline only): `tsc` clean; **861 unit pass / 4 pending**
(+8 theme budget); build OK; smoke 7; `test:e2e` exit 0 (241 PASS:
worker 46, offscreen 29, relay 22, content 7, list-controls 36,
title-bookmark 14, bookmark-panel 22, popup 27 / Full panel 27, site-ui 9,
universal + chapter-relay); options 35/0, embedded toolbar 11/0; web-ext lint
**0 errors / 33 warnings** (32 before, the new one is webpack's
`new Function("return this")` global shim in `js/chapters.js`, identical to the
existing `js/background.js` one); unsigned ZIP `nhentai_downloader-1.7.0.zip`.
Chrome after the shared DNR change: 828 / 4, e2e 198, smoke 7.

No live-site, real Firefox desktop, Android or signing evidence; there was also
no visual check of the token theme. 58 remains the release gate.
