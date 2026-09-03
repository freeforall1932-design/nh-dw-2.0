# NHentai Downloader — Firefox port workspace (v1.0.0 target)

**Created:** 2026-09-03

This folder is the working copy for porting the Chrome extension to
Firefox. It was created by copying `NHDW_Extension_v3.0.0` (Chrome MV3
source, version 3.3.0) at the state of commit
`4f918c347fbb9c688ec8315d688f7f672dca8071` (branch
`arena/01a064e1-nh-dw-2-0`).

## State

- **Nothing ported yet.** All files are byte-identical to the Chrome source
  copy, including `manifest.json` (which is the Chrome manifest).
- The proposed Firefox manifest is `manifest.firefox.json` (draft, not
  runtime-verified).
- Feasibility analysis and the required-change list:
  `PORTING_AUDIT.md`.
- Tracked as backlog item 27 (IMPROVEMENT_BACKLOG.md, session log
  2026-09-03; SESSION_HANDOFF.md worklist).

## Folder mapping (same layout as the Chrome source folder)

| Path | Meaning |
|---|---|
| `src/**` | TypeScript source (port edits happen here) |
| `js/**` | webpack output (`npm run build` writes here) |
| `test/`, `scripts/` | offline suites (browser-free) and e2e harnesses |
| `manifest.json` | Chrome manifest (pre-port; not the Firefox one) |
| `manifest.firefox.json` | draft Firefox manifest (port step 1 applies it) |
| `index.html`, `options.html`, `css/` | popup / options / content styles |
| `offscreen.html`, `js/offscreen.js` | Chrome-only (unused by Firefox; see audit fact 1) |

## Target

Firefox 128+ (Manifest V3, event-page background). Version 1.0.0 of the
Firefox build corresponds to Chrome 3.3.0 feature parity.

## Local load (temporary, developer)

1. `npm ci && npm run build`
2. Copy `manifest.firefox.json` over `manifest.json` (or make the build
   emit it) — this is port step 1; do not do it before the fallback-path
   parity work if queue controls matter (audit fact 4).
3. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** → select `manifest.json`.
4. `npx web-ext lint` from this folder before packaging.

The Chrome folders (`NHDW_Extension_v3.0.0`, `NHDW_Release_v3.0.0`) are
not modified by any work done here.
