# Visual asset plan — NHentai Downloader

**Status: planning only.** No new visual asset is approved or installed.
Repository: <https://github.com/freeforall1932-design/nh-dw-2.0>.
**Current task: logo concepts and a web preview only.** Background art and
button animation are later options; do not redesign the download engine or
change site adapters. This document holds the project context and acceptance
criteria for an asset-making agent.

## Where things live now

- **Chrome/Edge/Brave:** `NHDW_Extension_v3.0.0/` is both the source tree and
  the folder to select in **Load unpacked**. `src/` is TypeScript, `js/` holds
  committed webpack output, `manifest.json` and the HTML/CSS/icons at its root
  are the runtime. `npm run package:chrome` makes an ignored runtime-only ZIP
  under `dist/` for distribution; do not commit a second copy of the runtime.
- **Firefox desktop/Android:** `NHDW_Firefox_v1.0.0/` is a separate MV3 build
  with its own manifest, mobile CSS, website drawer and signing gate. Follow
  `FIREFOX_PARITY_PLAN.md` §2/§3 and `SESSION_HANDOFF.md` before sharing a design
  with Firefox. `npm run package:firefox` packages it; **do not sign until the
  real Android pass (WORKLIST.md item 58) is complete**.
- Existing reference: `NHDW_Extension_v3.0.0/Icon.png` (hot pink + bright
  green silhouette), `Icon-grey.png` (inactive),
  `NHDW_Extension_v3.0.0/Preview/` (screenshots), `css/style.css` (popup/panel),
  `css/content.css` (card controls + floating bar), and Firefox's
  `css/panelRenderers.css` (shared drawer/Bookmark presentation).
- Product: six supported sites; Download, Bookmark, Settings; listing-card
  controls and a fixed floating bar including Harvest/Stop. Popup is about
  500px wide on desktop; test Firefox Android around 360px, including coarse
  pointer and an open keyboard. Colors used now: pink `#e31b53`, dark
  blue-gray `#202a34`, and a bright green detail in the legacy icon. Keep
  button labels readable in both themes.
- Real UI labels to preview alongside a proposed logo: a card's **Download**
  (`src/content/listControls.ts`, `css/content.css`); the listing bar's
  **Select all**, **Download** and **Harvest / Stop harvest**; the gallery
  preview's **Save offline** (`src/preview/message.ts`); and the multi-page
  panel's **Download range now** (`src/preview/popup.ts`). The old blanket
  “Download all (N pages)” action was retired (WORKLIST.md item 71): do not
  reintroduce it simply to make a mockup look familiar.

## Candidate assets (pick ONE to start, then review before integration)

| Priority | Asset | Suggested delivery | Check before approval |
|---|---|---|---|
| 1 | Toolbar logo + inactive variant | Original flat vector master, transparent PNGs at 16/32/48/96/128px; map to `Icon.png`/`Icon-grey.png` only after approval | Recognizable at 16px on light/dark browser chrome; inactive state not mistaken for disabled download |
| 2 | Quiet panel backdrop | Light/dark locally bundled SVG or compressed WebP in `NHDW_Extension_v3.0.0/assets/`; no large screenshot textures | Text contrast, 500px popup and 360px drawer, battery/size budget, no busy area behind controls |
| 3 | Button microinteraction | CSS in existing stylesheets, **not** a video/GIF or external JS library | Keyboard focus and touch, `prefers-reduced-motion`, no downloads triggered twice, no hover-only cues |

Do not add images to the manifest or overwrite the current icons until an
actual concept is chosen. Generated output should be reviewed at native size,
not just at a large mockup. Prefer a small local SVG/PNG/CSS over a remote URL;
no third-party fetch, copyrighted site logo, sexually explicit illustration,
watermark, embedded text, or copied gallery artwork. Do not include original
page captures or unsanitized gallery metadata in model prompts.

## Concept preview (before integrating a chosen logo)

Keep concept work under `NHDW_Extension_v3.0.0/Preview/logo-lab/`: a local
preview HTML page and candidate exports. `Preview/` is excluded from the
`npm run package:chrome` runtime ZIP. This is not a second extension folder
and must not overwrite `Icon.png` or `Icon-grey.png` before approval.

The preview should compare current and candidate icons at **actual 16px**
and 128px on dark/light browser toolbar backgrounds, then show each candidate
next to the real controls named above in a ~500px panel and ~360px phone
layout. A static design preview is not proof of a real Firefox Android pass.
Prefer a runnable local web page and a shareable preview URL; keep the HTML
usable on its own if hosting is unavailable. Use dummy gallery labels, no
external images/fonts/CDNs, no copyrighted site logos or adult imagery.
After the owner chooses one, integrate only that candidate into the runtime.

## Integration checklist after selection

1. Save the chosen masters and exports as local, reasonably small files. Verify
   icon transparency, visual contrast and license/provenance before replacing
   any existing asset. Keep a way to revert to `Icon.png`/`Icon-grey.png`.
2. Wire only actual runtime paths. Keep a single source of truth: Chrome tree
   and generated `dist/` ZIP, Firefox tree with its audited mobile delta. A
   new runtime asset under `assets/` is included by `scripts/package-chrome.js`
   but must still be explicitly referenced by the UI/manifest if used.
3. Check dark/light, 16px browser toolbar, 500px popup/side panel and Firefox
   Android 360px. Do not claim a real-device pass from static screenshots.
4. Run `npm run build`, `npm test`, `npm run test:smoke`, `npm run test:e2e`,
   `npm run package:chrome` in the Chrome tree; repeat Firefox checks when
   Firefox files change. Check that ZIPs contain only runtime files.
5. Do not edit `.github/workflows/**` from an agent session; stage any
   trigger-path change in `ci/pending-workflows/` and tell the owner to apply
   it manually (see `ci/README.md`).
