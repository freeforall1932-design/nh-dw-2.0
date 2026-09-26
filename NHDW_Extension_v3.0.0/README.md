# NHDW_Extension_v3.0.0 — Chrome MV3 source + loadable folder

This folder is the **TypeScript source of truth** for the Chrome/Edge/Brave
build of NHentai Downloader (v3.10.6). **Load this folder directly** using
Chrome/Edge/Brave → Extensions → Developer mode → Load unpacked. The `js/`
bundles are committed here; no duplicate release folder needs syncing.
`npm run package:chrome` generates a runtime-only ZIP under ignored `dist/`
for distribution (unzip it before Load unpacked). **Existing users:**
changing the unpacked directory can change Chrome's extension ID and isolate
its local storage. Export the Bookmark backup from the old installation before
switching, import it in the new one and review Settings (API key/preferences
are not in that backup). See the root README for recovery instructions.

- **User docs:** root [`README.md`](../README.md) (features, install, usage, FAQ).
- **Working rules:** [`SESSION_HANDOFF.md`](../SESSION_HANDOFF.md) (invariants + Do-not list) · [`WORKLIST.md`](../WORKLIST.md) (what's next) · [`IMPROVEMENT_BACKLOG.md`](../IMPROVEMENT_BACKLOG.md) (full specs + history).
- **Multi-site adapter reference:** [`ADAPTER_WIRING_PLAN.md`](../ADAPTER_WIRING_PLAN.md).
- **Visual asset planning brief:** [`ASSET_PLAN.md`](../ASSET_PLAN.md).
- **CI rules:** [`ci/README.md`](ci/README.md) (workflow files are manual-commit only).

```bash
npm ci
npm run build     # webpack -> committed js/ in this same folder
npm run package:chrome  # rebuild and create ignored dist/nhdw-chrome-<version>.zip
npm test          # unit suites (explicit mocha file list in package.json — append new test files there)
npm run test:smoke
npm run test:e2e  # offline window-less harnesses against the built bundles
```

The historical upstream readme (Xwilarg's NHentaiDownloader 2.2.0, MV2 era)
is preserved in the inactive archive folder
`NHDW_Source_v3.0.0/NHentaiDownloader-2.2.0/README.md`.
