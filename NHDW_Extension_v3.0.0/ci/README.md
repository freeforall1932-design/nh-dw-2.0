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

## Currently pending — one Chrome folder / future runtime assets

The live workflow still contains a path for the removed
`NHDW_Release_v3.0.0/**`. The complete intended replacement is in
`ci/pending-workflows/extension-tests.yml`. It removes that stale trigger and
adds paths for `NHDW_Extension_v3.0.0/js/**`, `assets/**` and `Icon*.png` so a
future icon or background-only change runs CI. All previously working source,
test, manifest, CSS and Firefox triggers remain unchanged. **The current live
workflow still runs on the existing source/test paths; only asset-only changes
may not trigger it until the owner applies this mirror manually.**

Do not attempt to edit `.github/workflows/**` in an agent push. The owner must
apply the pending mirror through their normal GitHub account (as above), then
verify that an icon-only change starts the offline-suites workflow.
