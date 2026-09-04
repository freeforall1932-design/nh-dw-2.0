# CI files that must be committed by hand

## The rule

**Nothing under `.github/workflows/` can be pushed by the Arena agent.**

The GitHub App the agent authenticates as does not carry the `workflows`
permission, so any push whose diff touches a workflow file is rejected by the
remote *before* any of the other commits land:

```
! [remote rejected] arena/<session> -> arena/<session>
  (refusing to allow a GitHub App to create or update workflow
   `.github/workflows/extension-tests.yml` without `workflows` permission)
error: failed to push some refs to 'https://github.com/freeforall1932-design/nh-dw-2.0.git'
```

This is not a transient failure and there is no flag that works around it. It
has always been the case in this repository: **workflow changes are a manual
commit**, made by a human either through the GitHub web UI or from a local
clone with a normal user credential. The 2026-09-01 CI cleanup (removing the
real-browser jobs) was done the same way.

## How this folder is used

Whenever an agent session wants a workflow change, it writes the **complete
intended workflow file** into `ci/pending-workflows/` instead of editing
`.github/workflows/` — that keeps the rest of the session's work pushable — and
records the pending change in `SESSION_HANDOFF.md`. A human then applies it.

To apply a pending file:

```bash
# from the repository root, with a normal (non-app) git credential
cp NHDW_Extension_v3.0.0/ci/pending-workflows/extension-tests.yml \
   .github/workflows/extension-tests.yml
git add .github/workflows/extension-tests.yml
git commit -m "ci: broaden extension-tests trigger paths"
git push
```

or paste the file's contents into the GitHub web editor at
`.github/workflows/extension-tests.yml` and commit from the browser.

Once a pending file has been applied and the workflow in `.github/workflows/`
matches it, the copy here is redundant — leave it in place as the readable
mirror of what CI runs, and update it in the same commit whenever the real
workflow changes.

## Currently pending

### `pending-workflows/extension-tests.yml` — broaden the trigger paths

Queued 2026-09-04, during the 3.4.0 list-mode parity work (PR #33).

`on.push.paths` currently only lists `NHDW_Release_v3.0.0/**` and the
`scripts/`, `test/` and `src/` subtrees of the extension. That means a commit
that changes only, say, `manifest.json`, `index.html`, `options.html` or
`css/**` does **not** trigger CI — and those are exactly the files that the
side-panel registration, the panel markup and the in-page card styling live in.
A broken manifest or a missing stylesheet could reach `main` with a green (i.e.
never-run) status.

The pending copy adds:

| Added path | Why it matters |
| --- | --- |
| `NHDW_Extension_v3.0.0/manifest.json` | `test/manifest.test.js` asserts permissions, `side_panel.default_path`, content-script registration and web-accessible resources |
| `NHDW_Extension_v3.0.0/package.json` | changes the test scripts themselves (`test:e2e` gained a 5th script) |
| `NHDW_Extension_v3.0.0/package-lock.json` | `npm ci` resolves against it |
| `NHDW_Extension_v3.0.0/index.html` | the popup/side-panel DOM contract `popup.ts` depends on |
| `NHDW_Extension_v3.0.0/options.html` | the settings DOM contract `options.ts` depends on |
| `NHDW_Extension_v3.0.0/offscreen.html` | hosts the offscreen document the packaging pipeline runs in |
| `NHDW_Extension_v3.0.0/css/**` | `style.css` (panel/list/modal) and `content.css` (card controls) |
| `NHDW_Extension_v3.0.0/webpack.config.js` | defines every bundle entry point |
| `NHDW_Extension_v3.0.0/tsconfig*.json` | drives both the build and `tsc --noEmit` |

Nothing else about the workflow changes: same single `unit` job, same Node 22,
same five steps, same `workflow_dispatch`.

**Diff against the live workflow** (the only hunk):

```diff
       - 'NHDW_Extension_v3.0.0/src/**'
+      - 'NHDW_Extension_v3.0.0/manifest.json'
+      - 'NHDW_Extension_v3.0.0/package.json'
+      - 'NHDW_Extension_v3.0.0/package-lock.json'
+      - 'NHDW_Extension_v3.0.0/index.html'
+      - 'NHDW_Extension_v3.0.0/options.html'
+      - 'NHDW_Extension_v3.0.0/offscreen.html'
+      - 'NHDW_Extension_v3.0.0/css/**'
+      - 'NHDW_Extension_v3.0.0/webpack.config.js'
+      - 'NHDW_Extension_v3.0.0/tsconfig*.json'
       - '.github/workflows/extension-tests.yml'
```

Verify after applying: push a commit that touches only `css/style.css` and
confirm the run appears in the Actions tab.
