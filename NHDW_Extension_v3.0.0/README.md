# NHDW_Extension_v3.0.0 — Chrome MV3 source tree

This folder is the **TypeScript source of truth** for the Chrome/Edge/Brave
build of NHentai Downloader (v3.10.0). It is not the installable package —
users load `NHDW_Release_v3.0.0/` (built output, kept byte-synced with this
tree's `js/`, `css/`, HTML and manifest).

- **User docs:** root [`README.md`](../README.md) (features, install, usage, FAQ).
- **Working rules:** [`SESSION_HANDOFF.md`](../SESSION_HANDOFF.md) (invariants + Do-not list) · [`WORKLIST.md`](../WORKLIST.md) (what's next) · [`IMPROVEMENT_BACKLOG.md`](../IMPROVEMENT_BACKLOG.md) (full specs + history).
- **Multi-site adapter reference:** [`ADAPTER_WIRING_PLAN.md`](../ADAPTER_WIRING_PLAN.md).
- **CI rules:** [`ci/README.md`](ci/README.md) (workflow files are manual-commit only).

```bash
npm ci
npm run build     # webpack -> js/ (then run the exhaustive release-folder sync loop)
npm test          # unit suites (explicit mocha file list in package.json — append new test files there)
npm run test:smoke
npm run test:e2e  # offline window-less harnesses against the built bundles
```

The historical upstream readme (Xwilarg's NHentaiDownloader 2.2.0, MV2 era)
is preserved in the inactive archive folder
`NHDW_Source_v3.0.0/NHentaiDownloader-2.2.0/README.md`.
