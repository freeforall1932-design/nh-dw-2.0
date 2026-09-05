# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-09-05 (session `arena/01a0701c-nh-dw-2-0`) — **3.6.4: item
33, one format decision per job.** `resolveJobFormat(override, stored)` in
`src/utils/downloadFormats.ts` is now the only place a job's output format is
decided; the worker fallback, the offscreen document, the history records,
the retry jobs and the merged artifact naming all read that one value. The
concrete defect this closes: `resolveMergedBatchName` computed its disk
candidates from the raw request (`formatOverride || "zip"`), so a merged job
with no explicit format looked for `.zip` while the artifact is `.cbz`/`.pdf`
— warn-first could never fire and re-runs grew `_partN` forever. All
numbered items from the 2026-09-05 review (28–34) are now closed. Remaining:
P3 queue UI, raw retry follow-ups, real-browser verification, Firefox port.

**Updated:** 2026-09-05 (session `arena/01a06fb0-nh-dw-2-0`) — **3.6.3: item
32, one shared batch pipeline.** Worker fallback and offscreen now wrap
`src/utils/batchPipeline.ts` (storage-free core, injected IO). Suggested
remaining order: **33** (fallback format default). P3 queue UI, Firefox port,
and real-browser verification are unchanged.

**Updated:** 2026-09-05 (session `arena/01a06fb0-nh-dw-2-0`) — **3.6.2: review
items 28–31 and 34 landed.** Follow-up to the 3.6.0/3.6.1 rewrite audit (PR
#37 already merged as `8e32768`). Concrete bugs M1–M3 and L1 plus the console
stringify sweep (L4) are fixed in both batch pipelines and covered by new
unit + e2e phases. Suggested remaining order: **32** (dedupe the twin
pipelines), then 33 (fallback format default). P3 queue UI, Firefox port, and
real-browser verification are unchanged.

**Updated:** 2026-09-05 (session `arena/01a06f95-nh-dw-2-0`) — **housekeeping +
full-code review after the 3.6.0/3.6.1 rewrite.** `new 19.txt` (a v3.4.1
raw-failure error log) was deleted from the tree — commit `83a13b7`, merged as
**PR #37**. The post-rewrite source was then reviewed end to end (worker +
offscreen batch pipelines, `downloadControl`, `failedGalleries`,
history/verify, popup/retry UI, `Downloader`, parsers, naming guard) and the
verification suite re-run: webpack rebuild reproduces the committed/release
`js/` byte-identically. Verdict: the 3.6.0/3.6.1 code is a real fix, not
garbage. The review found **four concrete bugs (M1–M3, L1) and three
hardening/structural items** — recorded as **backlog items 28–34** (28–31 and
34 are done in 3.6.2; 32–33 remain). Full specs in IMPROVEMENT_BACKLOG.md,
session log 2026-09-05.

**Updated:** 2026-09-05 — **3.6.1 follow-up (review of 3.6.0 against a live
report): raw-mode failures no longer render "Error: [object Object]".** The
user's report was `Failed to download original image (Error:
[object Object]).` for raw pages 2/3. Root cause: the OLD (pre-3.6.0) path
stringified the browser's `lastError` object (`String({message})` →
`Error("[object Object]")`) and the raw catch then stringified that Error
(`"(" + error + ")"` → the exact report). 3.6.0 fixed those two spots in the
Chrome tree, but the review found the same pattern still reachable through
object-shaped errors at two other boundaries + the stale
`NHDW_Firefox_v1.0.0` snapshot (3.3.1, still carries the old code and its
built js; documented as lagging). Hardened message-first everywhere:
`downloadControl.interruptedMessage` + `startBrowserDownload` catch,
`background.ts` saveDownload reply, offscreen `saveViaServiceWorker` /
`awaitDownloadViaServiceWorker` (uses `errorMessage`, never `String`), and the
Firefox snapshot equivalents. New tests: unit (object lastError → readable,
sync object throw → readable, `interruptedMessage` object shapes) + e2e
offscreen phase where `saveDownload` answers an Error instance (asserts
`Invalid filename (fixture)` survives and `[object Object]` never appears).
**258 passing / 4 pending**, smoke 7 PASS, e2e all PASS (new phase included);
Firefox snapshot 166 passing / 4 pending. Manifests bumped to **3.6.1** in
Extension + Release; README / backlog updated. Session branch:
`arena/01a06f6b-nh-dw-2-0` (from `main` c1fca03, the 3.6.0 merge, PR #35).

**Updated:** 2026-09-04 — **3.6.0: named failures + Retry; raw mode waits for
every page.** Triggered by a live report: two galleries failed in a batch, the
notice said only "2 galleries failed" (no names), there was no retry button,
and — the deeper bug — raw mode counted a page as saved the moment
`chrome.downloads.download()` *started* it, so a page interrupted afterwards
went unnoticed and the gallery was recorded in the download history with a page
missing; nothing throttled raw either (200 pages = 200 simultaneous browser
downloads). See "Failed-gallery reporting + raw completion tracking (3.6.0 —
newest)" below. Manifest bumped to 3.6.0 in both folders. Verification on this
branch: webpack clean, `npm test` **256 passing / 4 pending**, smoke **7 PASS**,
`npm run test:e2e` all PASS (new phases: offscreen raw interrupted→retry /
defective→named failure / raw batch summary; worker phase 3 names the gallery,
phase 5 names the failed title, phase 5a retry clears it; relay §11 awaitDownload
+ §12 failed-gallery memory). Session branch: `arena/01a06bf0-nh-dw-2-0` (from
`main` 05a1a31, the 3.5.0 follow-up, PR #34).

**Updated:** 2026-09-04 — **3.5.0 follow-up complete and reviewed: verify-before-skip
+ merged date/part naming.** The user's settled decisions (verify-then-redownload
toggle for separate mode default ON; merged mode warns only and never skips;
`_DDMMYYYY` + `_partN` merged naming with verify deciding name reuse vs part
growth) are implemented end-to-end, reviewed, and shipped from this session
branch as a merge-commit PR. Final verification before the merge: webpack build
clean, `tsc` test config clean, `npm test` **233 passing / 4 pending**, smoke
**7 PASS**, `npm run test:e2e` **73 PASS / 0 FAIL**, and the push-triggered
`extension-tests` GitHub Action passed the same offline suites. Commits on
`arena/01a06b6f-nh-dw-2-0`: `57c5a87` (base history feature), `8fde409` (review
pass), `7d429c5` (this follow-up). Main was at `7aa438e` (3.4.1, PR #33) when
the branch started; the docs below intentionally remove none of the earlier
decisions.

**Updated:** 2026-09-04 — **3.5.0: persistent download history landed.** The
extension now remembers every successfully downloaded gallery (keyed by gallery
ID in `chrome.storage.local`) and skips it when the same listing is re-run, so
re-downloads no longer produce `Title (1).zip`, `Title (2).zip` ... See
"Download history (3.5.0 — newest)" below. Manifest version bumped to 3.5.0.
Session branch: `arena/01a06b6f-nh-dw-2-0` (from `main` 7aa438e — the 3.4.1
work, PR #33 merged).

**Updated:** 2026-09-04 — **3.4.1: cross-extension naming leak closed.** The
3.3.1 folder-naming guard registered Chrome's profile-wide
`onDeterminingFilename` at worker startup and never released it, so this
extension sat in the filename-decision chain for every download in the browser
and could be blamed for other extensions' files. The listener is now
reference-counted against our own pending downloads — see "Filename-guard
listener lifetime (3.4.1 — newest)" below. Manifest version bumped to 3.4.1.

**Updated:** 2026-09-04 — **3.4.0 landed: list mode reaches parity with
single-title mode.** Format choice (zip/cbz/pdf/raw) + explicit output mode
(separate files vs one merged file, separate is now the default) + list-mode
file-name template + PDF-merge confirmation, plus the P1 side panel and the P2
in-page card controls. Details in "List mode parity (3.4.0 — newest)" below.
Session branch: `arena/01a06a75-nh-dw-2-0`. Landed as PR #33 (CI green).
**One change from that session could not be pushed and is waiting for a human:**
a broader `on.push.paths` list for `.github/workflows/extension-tests.yml`. The
complete intended file is parked in
`NHDW_Extension_v3.0.0/ci/pending-workflows/extension-tests.yml` — see
"CI and workflow files (manual-commit only)" below.

**Updated:** 2026-09-03 — worklist extended with backlog item 27
(Firefox port; docs-only change). Feasibility audit:
`NHDW_Firefox_v1.0.0/PORTING_AUDIT.md`.

**Updated:** 2026-09-01 (after the CI cleanup landed: the failing
real-browser GitHub Actions jobs were removed via the web UI, replaced by
`.github/workflows/extension-tests.yml` — first run **green** (~1m, 163
mocha fixtures + smoke + VM e2e); docs companion PR #29 merged; README CI
bullet fixed in PR #30)

- Session branch of the current session: `arena/01a06a75-nh-dw-2-0`. Always
  use the current session branch (check `git branch --show-current`). The
  previous session branch `arena/01a023e5-nh-dw-2-0` is **merged and closed**
  (final PR #29); before that sessions used `arena/01a027b3-…`,
  `arena/01a02b04-…`, `arena/01a02397-…`. Do not trust older branch names in
  historic handoff text.
- Merged since the 2026-08-26 update: PR #23 (handoff records PR #22's merge
  commit), PR #24 (keyed live-API probes in the opt-in suite — archive
  availability is headlessly checkable), PR #25 (**hotfix 3.1.1** — remove
  the invalid `permissions` permission that made the extension fail to
  load), PR #26 (**3.2.0** settings inside the popup), PR #27 (**3.2.1**
  title-named blob saves instead of UUID), PR #28 (**3.2.2** mojibake fix in
  UI strings: charset + ASCII-safe text), PR #29 (document the real-browser
  CI removal). Version on `main`: **3.2.2**; this session branch carries **3.3.0**
  (raw master-folder option — see "Archive naming and structure") pending the PR merge.
- CI state: the only workflow is `.github/workflows/extension-tests.yml`
  (offline suites: webpack build → mocha fixtures → smoke → window-less VM
  e2e; triggers on pushes touching the extension/release dirs or the
  workflow itself, plus manual `workflow_dispatch`). The real-browser suite
  stays **local-only** (`npm run test:browser`) — see backlog item 10 for why
  a GitHub-hosted real-browser job can never work.
  **Workflow files are always a manual commit** — the agent's GitHub App has no
  `workflows` permission, so any push touching `.github/workflows/**` is
  rejected outright and takes the whole push with it. Agents must write the
  intended workflow into `NHDW_Extension_v3.0.0/ci/pending-workflows/` instead;
  see "CI and workflow files (manual-commit only)" below.
- PR #22 ("Add optional nhentai API key mode with first-run gate and one-shot
  archive downloads") was merged on 2026-08-26T08:38:07Z as merge commit
  `05cd7c5` (full: `05cd7c537f39d091b01a458519acdd7742051cd7`) —
  https://github.com/freeforall1932-design/nh-dw-2.0/pull/22.
  It incorporated the mid-flight merge of `origin/main` (PRs #18–#21: queue
  controls, pause/resume, popup split + similar galleries, title-named
  archives, PDF output, CDN hardening) and re-validation of the combined
  tree (149 passing / 1 pending, all smoke + e2e green). Follow-up work
  starts from `main` on a fresh session branch.

## Repository and branch

- Checkout: `/home/user/nh-dw-2.0`
- **Only use the current session branch** (check `git branch --show-current`; earlier sessions used `arena/01a027b3-nh-dw-2-0` then `arena/01a02b04-nh-dw-2-0`). Do not trust older branch names in historic handoff text.
- Source: `NHDW_Extension_v3.0.0/`
- Loadable unpacked build: `NHDW_Release_v3.0.0/`
- These are distinct folders. Source contains TypeScript/tests; release is the browser-loadable package. After every build: `cp js/*.js ../NHDW_Release_v3.0.0/js/`, verify `diff -rq js ../NHDW_Release_v3.0.0/js`, and also sync `index.html`, `options.html`, `css/*`, `manifest.json` when they change (the release README intentionally differs).

## Current implemented work

### Job format resolution (3.6.4 — newest)

Item 33: one job, one format decision. `resolveJobFormat(override, stored)`
(+ the moved `normalizeFormatOverride`) lives in `src/utils/downloadFormats.ts`
and is the only place the per-job override, the stored default and the zip
fallback are combined.

- **The bug that was real.** `resolveMergedBatchName` resolved the format from
  the raw request: `normalizeFormat(relayedMessage.formatOverride || "zip")`.
  A merged job with no explicit override whose stored default is cbz/pdf
  computed `.zip` candidates, so `presentBatchFilenames` /
  `pickFreeBatchFilename` never saw the real artifact: the *you already have
  this file* warning could not fire and every re-run grew another `_partN`.
  The function now reads the job's resolved format (relay path) or resolves
  override → stored `useZip` → zip itself, and the storage read moved above
  the early `raw`/separate bail-out.
- **Worker fallback single-title** (`downloadDoujinshi`) resolves the format
  in its existing `chrome.storage.sync.get` (`useZip` added to the defaults)
  and **always** sets `settings.useZip` + the concurrency caps, so the
  Downloader never falls back to its own storage read and the record, retry
  job and file are the same format by construction.
- **Relay path** (`startRelayedJob`) sets `options.useZip =
  resolveJobFormat(relayedMessage.formatOverride, options.useZip)`
  unconditionally — the offscreen document has no `chrome.storage`, so it must
  always receive a concrete format.
- **Batch core** (`batchPipeline.ts`) resolves once and hands the *normalized*
  format to the Downloader (`gallerySettings.useZip = format`), so
  normalization happens once instead of again inside every Downloader;
  `buildRetryJob` and the paged path use the same helper.
- **Offscreen single-title** builds `jobFormat` once and uses it for the
  Downloader settings, the history record and the retry job.
- `background.ts` no longer carries its own copy of `normalizeFormatOverride`
  (it was the second definition of the same rule).

**Tests.** `test/list-mode.test.js` (5 cases: override wins, stored fallback,
legacy `folder` on both sides, zip last resort, unusable override stays out);
`test/batch-pipeline.test.js` "job format contract" (record + Downloader
settings + `retryJob.formatOverride` agree for zip/cbz/pdf/raw/`folder`/none);
`scripts/e2e-worker.js` phase 5i (stored cbz and legacy `folder` name both the
artifact and the record with no override sent) and phase 5j (merged job with
no override: artifact, record and warn-first all use `.cbz` — **fails on the
pre-fix code**, verified by reverting the resolver line). Manifests 3.6.4.
Verification this session: webpack clean, `tsc` both configs clean,
`npm test` **291 passing / 4 pending**, smoke 7 PASS, `npm run test:e2e` all
PASS; source `js/` byte-identical to `NHDW_Release_v3.0.0/js/`.

**Scope note (honest):** the record/artifact mismatch the item described was
already closed for single-title and batch jobs by 3.6.3's
`resolveWorkerBatchOptions` (both derive from the same resolved value); the
merged-naming pass was the live gap, and it was latent because every current
UI caller sends `formatOverride`. The rest of this drop is the structural
half: one resolution point, so the mismatch cannot come back.

### Post-3.6.4 self-review — `[object Object]` was NOT swept (3.6.4)

Reviewing this session's own change found a **live bug the previous two
sessions' claims missed**. 3.6.1 states raw-mode failures no longer render
`Error: [object Object]` and item 34 (3.6.2) states the message-first sweep is
done. Neither covered the **batch-level catch**, which is the outermost
user-facing error path in both pipelines:

- `background.ts` `downloadAllDoujinshis` / `downloadAllPages` `.catch` and
  `offscreen.ts`'s two equivalents all did `errorCallback(String(error))`;
- `askOffscreen`'s two failure replies did `{ result: false, error:
  String(error) }`, which the relay turns into the popup's `downloadError`.

Proven, not theoretical: `scripts/e2e-worker.js` phase 12c makes the batch
pipeline reject (the harness throws from `chrome.runtime.sendMessage` during
`batchProgress`) and asserts what the popup receives. On the pre-fix bundle
that assertion fails with **`got "[object Object]"`** — the exact string from
the original 3.6.1 user report. Post-fix it is the thrown message alone, for
both an object shape and an `Error` instance (no `Error: ` prefix either).

Also hardened in the same pass (same class, lower reach): `popup.ts` preview
`statusText` (2 sites), `options/apiKey.ts` verification failure, and
`message.downloadError`'s own render. `errorMessage()` already existed in
`utils/utils.ts` and was already imported in both bundles — the sweep had
simply stopped short of these paths.

**Remaining `String(error)` sites, intentionally:** `utils.ts` inside
`errorMessage` itself (the documented fallback for a shapeless object — now
pinned by a test) and `background.ts:954` / `downloadControl.ts:122`, which
read `.message` after a guard.

**Alignment fixes found in the same review:** `resolveWorkerBatchOptions`
passed the *raw* stored `useZip` (so a legacy `"folder"` travelled unnormalized
into the pipeline), and three consumers re-derived the format with
`normalizeFormat(...)` instead of `resolveJobFormat(...)`
(`background.ts` retry job, single-title record, fallback batch record). All
five now go through the single resolver.

### Deeper review of 3.6.0 / 3.6.1 / 3.5.0 / 3.4.x code (3.6.4)

The first review pass only covered the 3.6.4 change surface plus the
`String(error)` class. A second pass read the earlier sessions' modules end to
end. **Found clean, with the specific reason:**

- `downloadControl.ts` (3.6.0): `signal.aborted` is checked *before* the
  listener is registered (no missed-abort hang); `waiters` supports several
  waiters per id and `settle` removes only itself, so the worker's 45 s
  `awaitDownload` slices can hand over to the next slice without losing a
  terminal event that lands in between (it is parked in `recentTerminal`);
  first empty `search` tolerated, later empty = erased; timeout cancels then
  reports; `onTimeout:"report"` answers `pending` and leaves it running;
  `recentTerminal` is FIFO-capped at 200.
- `failedGalleries.ts` (3.6.0): `queue()` serializes read-modify-write and
  swallows storage errors; `mergeFailures` replaces same-id entries and
  `slice(merged.length - cap)` keeps the NEWEST; `readPendingFailuresSettled`
  waits for in-flight writes so a popup asking right after a job sees them.
- `downloadVerify.ts` / `downloadHistory.ts` (3.5.0): `recordedFilenameRegex`
  escapes and anchors with a separator boundary (so `MyNHDW/Title.zip` cannot
  match `NHDW/Title.zip`); `normalizeHistory` cannot throw on malformed
  stored data; `historyRecords` returns `[]` for an unclean merged job;
  `applyBatchDate` never double-stamps; `pickFreeBatchFilename` falls through
  to Chrome's `uniquify` past 10 parts.
- `downloadNaming.ts` (3.4.1): all five documented drain paths exist and each
  ends in `persistSession()` + `syncListener()` — suggestion consumed (`:237`),
  TTL prune (`:134`), FIFO cap (`:142`), `discardDownloadRequest` (`:321`),
  `forgetDownload` (`:332`, called from the `onChanged` hygiene listener at
  `:412`).
- Offscreen `awaitDownloadViaServiceWorker` (3.6.0/3.6.1): re-asks while
  `pending`, gives up at 4 min with `cancelDownload`, treats a missing /
  non-`result:true` answer as "older worker, assume saved".
- `selectedGalleryResolver.ts` (item 7): sequential same-tab resolution, no
  tab creation anywhere in `src/`.

**Two defects found and fixed here:**

1. **Item 7's backlog text described code that does not exist.** It claimed
   the popup opens "one bounded temporary tab at a time" and closes each one,
   and that `test/resolver.test.js` verifies "sequential tab usage, cleanup".
   There is no `chrome.tabs.create` / `tabs.remove` in `src/` at all, and the
   test asserts the opposite (*"without creating or navigating tabs"*). A
   future session could have "fixed" tab cleanup that was never missing.
   Item 8's "temporary-tab resolver" reference was stale for the same reason.
   Both corrected; the original plan is kept but marked superseded.
2. **`attachHistoryOverrides` had no failure path at two of its three call
   sites.** The relay path already fell back to an empty history list, but the
   two worker-fallback handlers chain straight off the promise with no
   `.catch`, so a rejection would leave `sendResponse` uncalled — Chrome logs
   "message channel closed" and the job never starts. The fallback now lives
   inside `attachHistoryOverrides` itself, so the invariant holds for every
   caller. **Honest severity: unreachable today** — `readHistory`,
   `readVerificationSetting` and `verifyHistoryOnDisk` all resolve rather than
   reject, so this is insurance against a future change, and it is therefore
   not covered by a test. The relay path's now-redundant `.catch` was left in
   place rather than removed.

### Third pass — list mode, PDF-merge guard, retry UI, CDN service (3.6.4)

The modules the second pass listed as unreviewed have now been read.

**Defect found and fixed — the PDF-merge downgrade skipped the history guard.**
Merged mode deliberately keeps every selected title, so the 3.5.0
already-downloaded filter is applied *only* when the job is separate. But the
PDF-merge warning can turn a merged job into a separate one **after** that
filter has run (`mode = "separate"` in `listControls.startDownload`,
`outputMode = "separate"` in the popup's `buildJobOptions`). The job then went
out in separate mode still carrying recorded galleries, so:

- `resolveSelectedGalleries` resolved metadata for galleries the worker was
  about to skip — the exact API calls the skip exists to avoid ("skipped ids
  are removed before metadata resolution so they cost ZERO API calls", 3.5.0);
- the panel/page counts (`N selected · M already downloaded · K will
  download`, the button label, the in-page flash) described a different job
  than the one sent.

Three call sites, all fixed by applying the partition after the warning:
`listControls.ts` `startDownload`, `popup.ts` "Download selected", `popup.ts`
"Download all (N pages)" (where an empty result is still allowed — other pages
may have work). Reachable by: list mode = PDF + *Single merged file*, select
titles including already-downloaded ones, then choose **Switch to separate
files**. Proven by test — the new `e2e-list-controls` phase fails on the
pre-fix bundle with `a separate-mode job must not carry the already-downloaded
title, got {"111111":"Title 1","222222":"Title 2","333333":"Title 3"}`. A
second new phase pins the other direction: confirming the merge still keeps the
recorded title, because the skip belongs to separate mode only.

**Defect found and fixed — the failed-gallery notice vanished on a failed
retry.** `retryFailedGalleries` hides `#failedNotice` when the first retry
command is sent, before knowing whether it started. If the worker answered
`error` (e.g. "Unable to start the offscreen download document"), the panel was
left with no failed list and no Retry button until it was closed and reopened —
even though the worker still holds the failures. The `error` branch now calls
`refreshFailedNotice()`.

**Read and found clean:** `pdfMergeWarning.ts` (safe button focused so Enter
picks one-PDF-per-title; "don't warn me again" honoured only when the user
proceeds; Escape/overlay cancel; `settled` guard; keydown listener removed and
overlay detached on close); `listSettings.ts`; `cdnConfigService.ts` (memory
then session cache, in-flight dedupe, 6 s timeout, permission filtering, stale
cache kept on failure); `groupRetryMessages` (per-settings batching, forced
`redownloadIds`, active tab preferred over the original).

**Noted, deliberately not changed:** `retryFailedGalleries` keeps sending the
remaining grouped commands after one answers `error` (a partially-failed retry
still queues the rest — matches the batch continue-after-failure rule);
`wireRetryButton` leaves its button disabled if `groupRetryMessages` produces
nothing, which needs an entry with no id to happen.

**Verification gap closed the same session — `scripts/e2e-popup.js` (new).**
The panel's message -> UI layer had no offline coverage at all (only the
real-browser `e2e-browser.js`), which is exactly where item 29 and the
failed-notice defect lived. The new harness loads the built `js/preview.js` in
a VM with a DOM stub and drives it with the messages the worker/offscreen
document send, then clicks the buttons those messages render. Five phases:

1. an object-shaped `downloadError` renders its message (never
   `[object Object]`) with Retry + Go Back;
2. a batch-level error still leaves a clickable Go Back (item 29, at bundle
   level rather than only in `test/message.test.js`);
3. a `batchSummary` names the failed galleries and offers `Retry failed (N)`;
4. clicking Retry re-sends exactly those ids with the failed job's settings as
   separate files, and when the worker answers `error` the failed notice comes
   **back** — this is the regression test for the notice defect, and it fails
   on the pre-fix bundle with `a refused retry must restore the failed notice,
   got hidden=true`;
5. Dismiss asks the worker to forget the list and hides the notice.

Added to `npm run test:e2e`. Two harness notes so nobody mistakes its limits:
the panel registers **two** `onMessage` listeners (`popup.ts` and
`preview.ts`), so the harness delivers to all of them — keeping only the last
silently tests the wrong half; and the stub keeps one node per id, so
"click the current button" means the last listener wired for it (a real
`innerHTML` re-render destroys the old element). It does **not** bootstrap a
listing page, so the popup's list-job / PDF-merge / similar-galleries paths
are still only covered by the equivalent content-script phases.

**Found by that harness, and fixed:** `popup.ts` did
`message.downloadError(String(request.error), …)` — the last hop before the
user, stringifying an error that `message.downloadError` already knows how to
unwrap. Latent (every sender upstream sends `errorMessage(error)`), but it is
the same class the 3.6.1/3.6.4 sweeps targeted, and phase 1 now pins it.

**`NHDW_Firefox_v1.0.0` error parity backported.** Its seven user-facing
`String(error)` sites (`background.ts:281,423,506,725,737`,
`offscreen.ts:470,547,616`) plus `options/apiKey.ts` and the two popup
`statusText` sites now use `errorMessage()`, added to its `utils/utils.ts`
verbatim from the Chrome tree. Its own suite passes: **166 passing / 4
pending**, smoke 5 PASS, e2e exit 0, including a backported worker phase 11
that fails on the pre-backport bundle with `got "[object Object]"`. Its
manifest still says 3.3.1 and it still lacks all 3.4.0+ work — item 27.

**Review pass 4 — the two modules with zero test references
(`src/preview/popupSettings.ts`, 551 lines, and `src/utils/downloadVerify.ts`).**
`grep -rl popupSettings test/ scripts/` returned nothing before this pass;
`downloadVerify.ts` is called from `background.ts` (`verifyHistoryOnDisk`,
`presentBatchFilenames`) but had no test either. Two real defects came out of
the settings pane, both found by extending `scripts/e2e-popup.js` to render
it (new phases 6-8):

1. **Opening the Settings tab rewrote the file-name template.** The
   file-name section's `renderNamePreview()` both saved and previewed, and it
   ran on first paint. `buildTemplate` always emits the canonical order with
   `" - "` separators, and `isTokenOnlyTemplate("{id} - {pretty}")` is `true`
   (the leftover `" - "` matches its separator class), so a user-ordered
   template was silently rewritten to `"{pretty} - {id}"` by merely opening
   the tab. Fixed with a `persist` flag: only a checkbox `change` writes.
   Phase 6 fails on the pre-fix bundle with `opening the Settings tab must not
   rewrite downloadName, it wrote [{"downloadName":"{pretty} - {id}"}]`;
   phase 7 pins that an explicit tick still saves (the fix must not make the
   section read-only).
2. **Both settings panels advertised a list format that was not the one in
   use.** `listFormat` has no stored value until the user sets one, and list
   mode then inherits the single-title format — that chain lived inline in
   three places (`listSettings.buildListSettings`, `listControls.ts:107`,
   `popupSettings.ts`) and both panels defeated it by passing
   `listFormat: "zip"` as a `chrome.storage.get` **default**, which erases the
   difference between "never set" and "deliberately zip". With `useZip: "cbz"`
   the panels showed ZIP while `listControls`/`buildListSettings` used CBZ for
   the same storage. Fixed by extracting `resolveListFormat(storedListFormat,
   storedUseZip)` into `downloadFormats.ts` (the same shape as the existing
   `resolveListTemplate`), using it in all four places, and dropping the
   `listFormat` default from both panels' `get()` calls. Covered by five new
   fixtures in `test/list-mode.test.js` ("list format inheritance") and by
   phase 8, which fails on a bundle with only that fix reverted with
   `must show the inherited format cbz, got zip`.
3. `src/options/options.ts` ended `initNameTemplate` with
   `saveTemplate(storedTemplate)` — writing the stored value straight back on
   every page open, firing `storage.onChanged` for a value nobody changed.
   Split into `renderTemplatePreview` + `saveTemplate`; only a change writes.

**Harness additions needed to reach the settings pane** (all now in
`scripts/e2e-popup.js`, so the next reader does not rediscover them):
`classList.toggle`, a `chrome.storage.sync` that actually stores what it is
given (plus a `syncWrites` log), and — the important one — assigning `.id` on
a `createElement` node must register it with `getElementById`, because
`popupSettings` builds its checkboxes that way and then looks them up by id.
Registration is last-write-wins, matching a real document after a re-render.

**Noted, deliberately not changed:** with `{language}`/`{group}`/`{artist}` in
the template and no matching tag, the token resolves to empty and the
separator survives — `getDownloadName("{id} - {pretty} - {language}", …, [])`
yields `"123456 - 123456 - "`, which `cleanName` trims to a dangling
`"123456_-"`. The empty-token behaviour is pinned on purpose by
`test/parsing.test.js` ("leaves placeholders empty when tags are absent",
asserting `"Pretty||"`), so this is a naming-engine contract, not an oversight
in the panel; changing it would mean changing that test.
`archiveLayout`/`archiveMasterFolder` have no UI by design —
`background.ts:278` sets `archiveLayout: "flat"` for single-title jobs and
`jobOverridesFromRequest` maps `request.masterFolder` onto both master-folder
keys, so the panel's example path is right for raw and archive alike.

**Firefox snapshot:** defect 1 exists verbatim there
(`NHDW_Firefox_v1.0.0/src/preview/popupSettings.ts`) and the same `persist`
fix is backported, together with the `options.ts` preview/save split. It has
no list mode (3.3.1), so defect 2 does not apply. That tree has **no** panel
harness, so the backport is verified only by a clean build plus its existing
suite (166 passing / 4 pending, smoke 5 PASS, e2e exit 0) and by the code
being identical to the Chrome fix that phase 6 pins — recorded here as an
open gap rather than claimed as tested.

**`downloadVerify.ts` pinned.** It was the other zero-reference module. Its
pure logic is now covered by `test/download-verify.test.js` (10 tests): the
tail-anchored regex matches on POSIX and Windows separators, refuses
`MyNHDW/Title.zip` and `NHDW-old/Title.zip`, is anchored at the end, escapes
metacharacters; `fileExistsOnDisk` resolves `false` (never throws, never
blocks a download) when `chrome.downloads` is missing or throws;
`verifyHistoryOnDisk` returns exactly the ids still on disk and skips empty
records; `presentBatchFilenames` reports the taken `_part2/_part3` candidates.
Removing the `(?:^|[\\/])` anchor from the compiled helper fails the
lookalike-parent test, so the suite is not vacuous.

**Gotcha worth remembering:** the `test` script in `package.json` lists mocha
files **explicitly** — adding `test/foo.test.js` without adding it there
silently runs nothing (the count stays put and the suite still passes). New
fixture files must be appended to that list.

### Shared batch pipeline (3.6.3)

Item 32: one storage-free `downloadAllDoujinshis` core used by the worker
fallback and the offscreen document, so the two copies cannot drift again.

- **Core** (`src/utils/batchPipeline.ts`): `runBatchDownload`,
  `runPagedBatchDownload`, `resolveGalleryMetadata`, `getGalleryViaTab`,
  `tryParseGalleryText`, `buildRetryJob`. Hosts inject parsing, abort,
  `sendMessage`, `fetchUrlFromTab`, `fetchImpl`, `newZip`, `downloadGallery`.
  The core does **not** import `chrome.storage` / `chrome.downloads` (and
  does not import `Downloader` or `tabImageFetch` — those stay at the host).
- **Unify on the richer routes:** pre-resolved metadata → keyed official API
  first (`Authorization: Key` iff `apiKey`) → `getGalleryViaTab`
  (`parsing.GetUrl`, clearnet api/gallery/page) → tab refetch of
  `parsing.GetUrl` then `fetchImpl` with Authorization iff keyed. Keyed `{}`
  is `requireGallery` → `countFailure` (no fall-through). HTML second-chance
  reads the body **once** (replayable Response).
- **Worker:** `makeFallbackBatchHost` + `resolveWorkerBatchOptions` then
  core. `rememberFailedGalleries` on both `downloadAllDoujinshis` **and**
  `downloadAllPages` (paged used to drop the list). History via
  `historyRecords` / `recordHistory`.
- **Offscreen:** `makeOffscreenBatchHost` (`saveUrl = saveArtifactSmart`,
  extras `{from:"offscreen", queued}`). History via `collectHistoryRecords`.
  Idle / queue / pause / save-via-worker unchanged.
- **Effective separate** is still `downloadSeparately || format === "raw"`;
  `archiveLayout` is still `downloadSeparately ? flat : nested`.

**Tests.** `test/batch-pipeline.test.js` (keyed auth, keyless no auth, HTML
second-chance, fail-one, merged/separate ignore, history skip, extras,
paged listing, aggregated paged failures). Manifests 3.6.3. Verification
this session: webpack clean, `npm test` **277 passing / 4 pending**, smoke
7 PASS, `npm run test:e2e` all PASS; source `js/` byte-identical to
`NHDW_Release_v3.0.0/js/`.

**Not in this drop:** item 33 (fallback format default — theoretical; all
current callers send `formatOverride`).

### Batch metadata + error UI + history names + merged duplicates (3.6.2)

Four follow-ups from the 2026-09-05 rewrite audit (items 28–31, 34).

- **28 (M1).** After every metadata route, `requireGallery(json)` (in
  `GalleryEmbed.ts`) coerces then demands `looksLikeGallery` before
  `json.title` is read. Failure is `countFailure` + named `errorCallback` +
  `continue`, same as the metadata-parse catch. A batch whose one gallery
  resolves to `{}` keeps going, names that gallery, and records nothing for
  it. Applied in **both** worker and offscreen loops.
- **29 (M2).** `message.downloadError` always renders **Go Back**; Retry stays
  only when `canRetry`. The popup always wires `#buttonBack` on a
  `downloadError`, so a batch-level error is no longer a zero-button dead-end.
- **30 (M3).** `sanitizeArtifactFilename` lives in `src/utils/artifactName.ts`
  (Downloader re-exports it). `artifactRecordFilename` runs the same sanitizer
  the save path uses, so verify-before-skip can match files whose master
  folder or name contained `:`, trailing dots/spaces, or over-long segments.
- **31 (L1).** Merged jobs never honour "ignore" by dropping a gallery:
  duplicate titles are id-suffixed (`title (id)`) so the archive still
  contains every selected title. Separate-mode "ignore" still skips, but the
  skip is counted in `skipped` so the summary stays honest.
- **34 (L4).** Downloader retry / server-archive `console.warn` paths go
  through `errorMessage()` (user-facing paths were already clean in 3.6.1).

**Tests.** `requireGallery` + classifyError in `test/parsing.test.js`;
sanitized records in `test/download-history.test.js`; Go Back always present
in `test/message.test.js`; worker e2e phases 11 / 12a / 12b; matching
offscreen phases. Manifests 3.6.2. Verification this session: webpack clean,
`npm test` **261 passing / 4 pending**, smoke 7 PASS, `npm run test:e2e` all
PASS; source `js/` byte-identical to `NHDW_Release_v3.0.0/js/`.

**Not in this drop (3.6.2):** item 32 (dedupe the twin pipelines —
structural; done in 3.6.3), item 33 (fallback format default — theoretical;
all current callers send `formatOverride`).

### Raw-mode error readability (3.6.1)

**Report.** Live raw download (separate file/folder): pages 2 and 3 failed with
`Error while downloading <title>/2: Failed to download original image (Error:
[object Object])., tries remaining: 1` from `js/offscreen.js`. The [object
Object] hid the real browser reason.

**Confirmed build (fingerprint).** The full log was later uploaded to `main`
(`new 19.txt`, commit `54b03d9`; it is safe — this branch's commits never
touched `main`, which only gained that file). The minified `offscreen.js`
embedded in the error page is **byte-identical** (sha256 body match) to
`NHDW_Extension_v3.0.0/js/offscreen.js` at commit `7aa438e4` — i.e. the
failing install was **v3.4.1** (the 3.4.1 merge, pre-3.5.0/pre-3.6.0). The
log exercises none of the 3.6.0/3.6.1 code: no `failedGalleries`, no
`awaitDownload` relay, and the old `String(…lastError…)` save path is present.
Upgrading to 3.6.1 (this branch) is the fix; with 3.6.1 the same situation
reports the REAL `lastError` string instead.

**Exact old chain (matches the report byte for byte).** `chrome.downloads.download`
callback → `downloadId === undefined` → old worker replied
`String(chrome.runtime.lastError || …)`; `lastError` is an object `{message}`,
so it became the string `[object Object]`; the old offscreen wrapped it in
`new Error("[object Object]")`; the old raw catch did
`throw "Failed to download original image (" + error + ")."` — stringifying
the Error added `Error: `. The 3.6.0 session fixed exactly this in the Chrome
tree (`lastErrorMessage`, `.message` extraction) but the defect was still
possible wherever a non-string error object crossed a boundary, and the
`NHDW_Firefox_v1.0.0` snapshot (3.3.1, byte-identical old code, loadable as a
Chrome unpacked extension via its Chrome-style `manifest.json`) still contains
the old chain — the most plausible source of this log.

**Fix (message-first at every boundary, never `String(plainObject)`).**
- `downloadControl.ts`: `interruptedMessage()` unwraps `reason.message`
  (object-shaped download errors) and falls back to `Download interrupted`;
  `startBrowserDownload` sync `catch` unwraps a thrown object's `.message`, or
  `Unable to start download` — no `Error("[object Object]")`.
- `background.ts` `saveDownload` reply: same unwrap before `sendResponse`
  (the offscreen document only ever sees this string).
- `offscreen.ts`: `saveViaServiceWorker` / `awaitDownloadViaServiceWorker`
  now use `errorMessage()` (already imported) instead of `String()` so even an
  Error INSTANCE crossing the channel shows its message, never
  `Error: [object Object]` after the Downloader wraps it.
- `NHDW_Firefox_v1.0.0` (snapshot, for parity while it lags): same unwrapping
  in its `Downloader.#saveArtifact` callback, raw-mode catch (`.message`),
  `background.ts` saveDownload reply and its offscreen `saveViaServiceWorker`
  (`errorText` helper); its built `js/` rebuilt.

**Tests.** `test/download-control.test.js`: `interruptedMessage({message:
'NETWORK_FAILED'})`, shapeless object → `Download interrupted`, sync object
throw → `.message` / fallback (never `[object Object]`).
`test/downloader.test.js`: raw with `chrome.downloads.download` throwing a
bare object — final callback error contains the object's message and no
`[object Object]` / `Error:` wrap. `scripts/e2e-offscreen.js`: new phase with
`saveDownload` answering `{result:false, error: new Error('Invalid filename
(fixture)')}` — asserts the exact old report shape cannot come out and the
message survives. **258 passing / 4 pending**, smoke 7 PASS, e2e all PASS
(new phase included). Manifests 3.6.1 in Extension + Release (both files
synced). Known-review note: the 3.6.0 "no more [object Object]" claim was only
true for the creation-failure path it fixed (and only while worker and
offscreen are the same lockstep build); these boundary hardenings remove the
mixed-version footgun.

**Correction (3.6.4):** that note still understated it. The **batch-level
catch** in both pipelines (`downloadAllDoujinshis` / `downloadAllPages` in the
worker fallback and in the offscreen document) kept doing
`errorCallback(String(error))`, so a batch failure with an object-shaped
reason rendered `[object Object]` in the popup — reproduced on the pre-fix
bundle by worker e2e phase 12c. Fixed in 3.6.4; see "Post-3.6.4
self-review" above.

### Failed-gallery reporting + raw completion tracking (3.6.0 — newest)

**Symptoms fixed.** (a) A failure notice with no gallery names and no way to
re-add the failed titles. (b) Raw mode ("separate file/folder") treating a
gallery with an interrupted page as complete — and recording it in the
download history, so the next listing run skipped it. (c) Raw mode ignoring
every concurrency cap.

**Root cause of (b)/(c).** `Downloader.#saveArtifact` resolved as soon as
`chrome.downloads.download()`'s callback returned a `downloadId`. That callback
fires when the download *item is created*, not when the file is written. An
interruption after that point (network drop, disk full, the user cancelling in
the shelf, the naming guard losing to another extension and Chrome erroring)
was invisible to the retry loop. Because every save "finished" instantly, the
page-batch loop released the whole gallery in milliseconds.

**Design (all four formats).**

- `src/background/downloadControl.ts` (new, worker + Downloader; touches only
  `chrome.downloads` / `chrome.runtime.lastError`, never storage):
  `awaitDownloadCompletion(id, {pollMs, maxWaitMs, onTimeout, signal,
  cancelOnAbort})` resolves (never rejects) with `{ok, state, error}` when the
  download reaches `complete` / `interrupted`. Sources: `downloads.onChanged`
  (listener installed once at worker load; terminal events that arrive before
  anyone waits are parked in a 200-entry map) plus a slow `downloads.search`
  poll (missed-event safety net + MV3 keep-alive; the first empty `search`
  answer is tolerated because a fresh item may not be searchable yet, a later
  one means "erased" → lost). `onTimeout:"cancel"` (default, 4 min) cancels the
  download and reports `timeout` ("… was stopped" — the word "cancel" would
  make `classifyError` label it a user cancellation); `onTimeout:"report"`
  answers `state:"pending"` and leaves it running. Abort: stop waiting; cancel
  the browser download only when `cancelOnAbort` (raw pages — worthless
  half-done; never a finished archive). **Contexts without `onChanged`** (unit
  stubs, the e2e harnesses, browsers lacking the event) answer
  `{ok:true, state:"unknown"}` — the pre-3.6.0 "started = saved" semantics —
  so nothing that used to work can hang. `startTrackedDownload(url, filename,
  opts)` = record name for the filename guard → `download()` → bind id →
  await completion; rejects with the reason. `normalizeRawConcurrency` (1..10,
  default 3).
- `Downloader.#saveArtifact` (direct path, fallback worker) uses
  `startTrackedDownload` with `cancelOnAbort: useZip === "raw"`. Raw mode's
  batch size is now `rawMaxConcurrent` (new sync key, options page select,
  default 3) instead of `maxConcurrentDownloads` (up to 15, meant for
  archive-mode fetches). The error string keeps its shape
  (`Failed to download original image (<reason>).`) so `classifyError` still
  reports `image`; `lastError` objects are unwrapped (no more `[object Object]`).
- Offscreen path: `saveViaServiceWorker` → `saveDownload` answers the numeric
  `downloadId` at creation → `awaitDownloadViaServiceWorker` loops
  `awaitDownload` (worker answers within `AWAIT_DOWNLOAD_SLICE_MS` = 45 s,
  `onTimeout:"report"`, so no single message channel is held open near the
  5-minute MV3 limit; the document re-asks while `pending`, gives up after
  4 min with `cancelDownload`). A missing / non-`result:true` answer (older
  worker, harness stubs) = success. Blob artifacts (zip/cbz/pdf) still go
  through the anchor mechanism and are not awaited (unchanged).
- Failure identity: every pipeline reports `failedGalleries: [{id, name,
  error}]` + a compact `retryJob {formatOverride, tabId?, nameTemplate?,
  masterFolder?}` in `batchSummary` (offscreen + fallback; also in
  `BatchOutcome`), and `galleryId / galleryName / retryJob` on single-title
  `downloadError`. The fallback single-title job builds its retryJob at
  failure time (the Downloader has resolved the effective format by then).
- `src/utils/failedGalleries.ts` (new): pure `mergeFailures` (replace same id,
  cap 200 oldest-first), `dropFailures`, `groupRetryMessages(entries, tabId)`
  → one `downloadAllDoujinshis {allDoujinshis, galleryMetadata:{},
  finalName:"Retry", separate:true, redownloadIds, formatOverride?,
  nameTemplate?, masterFolder?, tabId?}` per distinct settings (a retry never
  merges failed titles into a second partial archive; failed ids bypass the
  history guard; the *active* tab wins over the original one). Storage:
  `chrome.storage.session` key `nhdwFailedGalleries`, worker is the only
  writer (serialized read-modify-write; `set` handles callback and promise
  flavours). Worker: remembers from offscreen `batchSummary` / `downloadError`
  broadcasts (bookkeeping only — they still reach the popup directly, return
  `false`) and from the fallback callbacks; forgets ids on `recordHistory`
  (`jobFinished` records, fallback `.then(outcome)`); popup messages
  `getFailedGalleries` → `{result:"success", failed}` and
  `forgetFailedGalleries {ids?}` (no ids = clear).
- UI: `message.batchSummary(..., failedGalleries, canRetry)` lists names +
  reasons + `Retry failed (N)`; `message.downloadError(error, galleryName,
  canRetry)` names the title with `Retry`; `#failedNotice` (index.html, above
  `#action`) is filled by `refreshFailedNotice()` at every bootstrap with
  `Retry failed (N)` / `Dismiss`; `retryFailedGalleries()` in popup.ts sends
  the grouped commands sequentially (handles `queued`). `escapeHtml` and
  `errorMessage` moved to `utils/utils.ts` (shared by message.ts / popup.ts /
  offscreen / worker).

**Decisions.** Partial galleries are still never recorded (unchanged rule). A
defective raw folder is not deleted: the pages that arrived stay, a retry saves
the gallery again (`uniquify` → `001 (1).jpg`) — deleting user files from an
extension was judged worse than a duplicate. Raw batch size and archive fetch
concurrency are separate settings on purpose. The offscreen document still
uses `chrome.runtime` only (`scripts/e2e-offscreen.js` enforces it).

**Tests.** `test/download-control.test.js` (new; in the mocha list):
complete / interrupted / unrelated events / early event / missed event via
search / erased / timeout-cancel / report-pending / abort (+ archive not
cancelled) / no-onChanged fallback / `startTrackedDownload` / lastError
unwrapping / concurrency normalization; failedGalleries pure helpers.
`test/downloader.test.js`: raw with a scripted `onChanged` stub — interrupted
page retried and gallery succeeds, page that keeps failing fails the gallery
with the reason, `rawMaxConcurrent` cap (max in flight = 2 with archive
setting 15), relayed `rawMaxConcurrent`, abort cancels loose pages; the
legacy raw tests (no `onChanged`, 3×6 attempts) are untouched. Harnesses:
`e2e-offscreen.js` scripts `awaitDownload` per filename/attempt
(`rawDownloadScript`, ids ≥ 100; legacy `{result:7}` otherwise);
`e2e-worker.js` phase 3 / 5 / 5a; `e2e-relay.js` §11 / §12 (its
`storage.session.set` stub now calls the callback).

**Still to verify in a real browser (not possible offline).** A raw gallery
with a page cancelled in the download shelf → retry → gallery fails by name and
is NOT recorded; `Retry failed` from the summary and from the persistent notice
(popup + side panel); the notice survives closing/reopening the panel; a 200+
page raw gallery keeps ≤ `rawMaxConcurrent` items active in the shelf; a slow
page (> 45 s) completes without the worker being killed (the relay re-asks).

### Download history (3.5.0)

Skipping already-downloaded galleries when a listing is re-run (search / tag /
artist / homepage), instead of downloading everything again and uniquifying
into "Title (1).zip", "Title (2).zip" ...

- **Storage:** `chrome.storage.local`, one key `downloadHistory`, shaped
  `{ [galleryId]: { filename, when } }`. Sync is unusable (100 KB / 512 items).
  Keyed on ID, never title: it survives template changes, title/language
  edits, uniquify renames and browser-history clears. Only weakness: starts
  empty, so pre-3.5.0 downloads are not remembered.
- **Module:** `src/utils/downloadHistory.ts`. Pure helpers (normalize,
  `historyIds`, `countHistory`, `partitionKnown`, `artifactRecordFilename`,
  `historyRecords` + `BatchOutcome`) are imported by the offscreen document;
  the storage functions (`readHistory`, `recordHistory`, `clearHistory`) are
  **worker / popup / options only** — the offscreen document still touches
  `chrome.runtime` alone, as `e2e-offscreen.js` enforces with its forbidden
  storage/downloads/scripting counter.
- **Recording:** on SUCCESSFUL completion only, never on enqueue. Separate
  mode records each gallery that fully succeeded (raw counts as separate — no
  container to merge). Merged mode records ALL of the job's ids together ONLY
  if the whole job succeeded (every gallery + the artifact save); a failed or
  cancelled merge records nothing, so the merge can be re-run. Partial
  galleries (any page failed) are never recorded — nhentai publishes no
  content hash, so byte identity cannot be verified, and a broken file would
  otherwise be skipped forever (user's decision; not re-litigate).
- **Hook points (both, per user):**
  1. UI pre-check: popup rows get a ✓ badge + file name and a per-row
     *Download anyway* link (`redl_<id>`); summary line "N selected · M
     already downloaded · K will download" and the Download button shows the
     real count; skipped ids are removed before metadata resolution so they
     cost ZERO API calls. In-page bar (`listControls.ts`) shows the same
     counts, per-card "Downloaded" labels (clicking an already-downloaded
     card asks *Download again?*), and a bulk `Include already downloaded`
     checkbox.
  2. Authoritative pipeline guard (offscreen + worker fallback): the worker
     reads history and relays `alreadyDownloadedIds` + `redownloadIds` with
     each job; the pipeline skips recorded galleries (separate mode) before
     fetching metadata and counts them in `batchSummary.skipped`.
- **Escape hatches:** per-download override (per-row link / per-card
  confirmation / bulk include) and *Clear history* in popup Settings and the
  options page. No export/import (user declined). No new permissions.
- **Verify before skip (separate mode, 3.5.0 follow-up):** a recorded gallery
  is skipped only when `chrome.downloads.search` confirms the artifact still
  exists on disk (default ON, `verifyDownloadedFiles` in `chrome.storage.sync`
  — checkbox in popup Settings + options page). Copying a file in by hand,
  moving it after Chrome recorded its path, or clearing the browser's download
  history counts as missing, so that gallery is downloaded again; the record
  itself is the durable link. Toggle OFF = record-only skip (pre-3.5.0
  semantics, fastest). Worker-side only: `src/utils/downloadVerify.ts` is
  **never imported by the offscreen document** (no chrome.downloads there).
- **Merged mode: never skip, warn only.** A merged job always keeps every
  selected title; when its (dated) artifact already exists on disk and the
  user has not confirmed yet, the worker answers `{result:"existing",
  filename}` instead of starting, the UI `window.confirm`s ("you already have
  … creates a NEW copy / gets _part2…") and re-sends with
  `existingConfirmed: true` (user's explicit choice, do not re-litigate).
  Both pipelines (offscreen relay + worker fallback, `downloadAllDoujinshis` +
  `downloadAllPages`) resolve the name via `resolveMergedBatchName` before
  starting and clear the job marker on the "existing" stop.
- **Merged naming (default ON, `batchNameDate` in sync):** the base name gets
  `_DDMMYYYY` (`search_31082026.zip`; `applyBatchDate` never double-stamps),
  history records the dated name, and the same title+date again becomes
  `_part2`, `_part3` … (`batchCandidateNames` caps at 10, Chrome
  `conflictAction` uniquifies beyond). With verify ON a deleted file REUSES
  its old name instead of growing part numbers forever; with verify OFF the
  history record decides. Multi-page merged jobs keep the part number on the
  base, before the trailing ` (lastPage)` marker
  (`PagesAll_31082026_part2 (2).zip`) and record that exact artifact name.
- **Recording transport:** offscreen accumulates `pendingHistoryRecords` and
  sends them with the FINAL `jobFinished` (queued jobs ride along); the
  worker's `jobFinished` branch writes them. `downloadAllPages` aggregates
  per-page outcomes; merged mode requires every page fetched and clean.
- **Tests:** `test/download-history.test.js` (18 cases: normalize/count/
  partition/record-filename/clean-vs-dirty merged/record+clear via a
  `chrome.storage.local` stub, plus date-stamp / no-double-stamp /
  part-candidates / record-only-vs-verify picker / multi-page suffix).
  Worker e2e adds phases 1b/1c (record on success, never on failure), 5b–5e
  (unclean merged records nothing, clean merged records all, skip with zero
  API calls, redownload override) and 5f–5h (verify-before-skip re-downloads
  the deleted file; merged date stamp + part-2 + warn-first; multi-page
  merged naming keeps `_part2` on the base). Offscreen e2e adds the guard
  phase (skip before fetch, `skipped:1`, records in `jobFinished`, merged
  never skips) and a multi-page merged phase (clean pages 1+2 → one artifact
  `path (2)` + both ids recorded — the regression that caught the
  `finalSaveOk`-on-every-page bug). List-controls e2e adds counts/labels/
  bulk override/per-card confirmation/merged-keeps-all. `npm test` now 233
  passing / 4 pending; smoke 7 PASS; `npm run test:e2e` 73 PASS, 0 FAIL.
  Known review bug fixed along the way: `formatExtension` returns ".zip"
  (with the dot), so merged disk candidates were double-dotted and warn-first
  could never fire — `resolveMergedBatchName` strips the dot before handing
  the extension to the naming helpers.
- **Review fixes after the first pass:** merged `downloadAllPages` in both
  pipelines required `finalSaveOk` on EVERY page, so a fully clean multi-page
  merged job could never be recorded (only the final page owns the save) —
  now `clean = failed===0 && batchKeys>0 && (!downloadAtEnd || finalSaveOk)`.
  Popup merged-mode button count used `willDownload` (subtracting already-
  downloaded) although merged never skips — now the full selection count.
  `partitionKnown` is now actually used by both UI pre-checks (popup +
  listControls) instead of existing only for tests.
- **Version:** manifest 3.5.0 in source + release; README feature bullet,
  FAQ row and changelog entry added; backlog marked `[x]`.

### Filename-guard listener lifetime (3.4.1 — newest)

Symptom reported by the user, from a multi-extension Chrome profile:

```
This extension failed to name the download "Kodomo_Idol.pdf"
because another extension determined a different filename ""
```

The blamed extension was a downloader for a *different* site. The audit asked
whether THIS extension leaks naming authority across products. **It did.**

`chrome.downloads.onDeterminingFilename` is a global naming-decision event.
Registering it puts the extension into the filename chain for **every** download
in the profile. `host_permissions` and content-script `matches` do not scope it,
and returning early for a foreign item does **not** remove you from the chain —
participation itself is what lets Chrome name you in that error.

Up to 3.4.0, `installDownloadFilenameGuard()` ran at worker module evaluation
and added the listener unconditionally, forever. Classification: **LEAK**
(criteria: registered at startup and never removed; remains registered after
its own work finishes; participates globally even when the UI is nowhere near
nhentai).

Fix in `src/background/downloadNaming.ts` — reference-counted lifetime:

- `recordDownloadRequest(url, name)` attaches the listener when the pending map
  goes from empty to non-empty.
- The listener is detached the instant the map drains. Every drain path is
  covered: suggestion consumed, `onChanged` complete, `onChanged` interrupted /
  cancelled, `discardDownloadRequest()` when `downloads.download()` fails to
  produce an id, a 30-minute per-entry TTL, and the 600-entry FIFO cap.
- Idle worker ⇒ not in the chain at all.
- While attached, an item that is not ours gets a bare `suggest()` — never a
  filename, never `""`. `suggest()` is called exactly once per event.
- `installDownloadFilenameGuard()` now installs only the `onChanged`
  bookkeeping listener (no naming authority) and re-attaches the naming
  listener after a worker restart **only if** the session mirror still lists
  work in flight.
- New exports: `discardDownloadRequest`, `isFilenameListenerRegistered`,
  `pendingDownloadNameCount`. Session mirror moved to
  `{ v: 2, pending: {url: {filename, at}}, idToUrl, order }`; the legacy
  `{ byId, byUrl }` shape from 3.3.1/3.4.0 is still read on load.

Product behaviour deliberately unchanged: master folder, per-title folders,
list/single templates, archive names, `conflictAction: "uniquify"`, blob and
raw-CDN paths, and the offscreen `recordDownloadName` relay all behave exactly
as in 3.4.0.

Regression coverage: `test/download-naming.test.js` now has a
`global listener lifetime` block (idle ⇒ no listener; lazy attach on first own
download; stays attached while any is pending; detach on complete, on
interrupted, on failed creation, on consumption; restart re-attaches only with
outstanding work; TTL sweep releases a stuck entry; Firefox no-op). 19 tests in
that file. `scripts/smoke-mv3.js` additionally asserts that the **shipped
bundle** registers zero `onDeterminingFilename` listeners at load time, for
every worker variant it loads.

Not cleared: `NHDW_Firefox_v1.0.0/js/background.js` still contains the 3.3.1
guard. Firefox does not implement `onDeterminingFilename`, so it is inert
there, but that port has not been audited.

### List mode parity (3.4.0)

User report, in their words: single-title pages could do "4 zip cbz pdf and
raw", but "when I go to homepage or search or any artist or genre it's all
about the list with a default of zip and the naming system is the website url
itself"; the folder wrap "work just like the other but I want that to be
optional"; and the hovering popup could not be repositioned unlike their other
repo's side panel. Everything below is the answer to that report.

**Shared registry (the anti-drift rule).** `src/utils/downloadFormats.ts` is now
the single definition of the four formats, of the retired `"folder" -> "pdf"`
mapping, of the output mode, and of the PDF-merge condition. The panel, the
in-page card controls, the options page, `background.ts` (`normalizeFormatOverride`)
and the offscreen document all import it. List mode does **not** fork the
download logic: it calls the same `downloadAllDoujinshis` pipeline with per-job
options, so single-title and list mode cannot diverge again.

**1. Format selection in list mode.** The listing panel, the in-page floating
bar and the options page all expose zip/cbz/pdf/raw. The last-used list format
is persisted under its own key (`listFormat`) — never `useZip`, which stays the
single-title default. Raw is shipped enabled but labelled *"(testing)"* via
`formatLabel()` rather than silently missing (it is still on the open-items
list below).

**2. Separate files vs. batch — the actual must-have.** New explicit output
mode, independent of the format:
- `separate` (**the default in list mode**) — one archive, or one folder for
  raw, per title.
- `batch` — the previous behaviour, every title merged into one file. Opt-in.
Raw can never merge (no container), so `effectiveOutputMode()` forces it to
`separate` and the merge option is disabled in the UI. Relay fix: the worker
used to honour only `separate: true` (`if (relayedMessage.separate)`), which
made "batch" unrequestable from a UI whose default is separate; it now honours
an explicit `false` as well.

**3. List-mode filenames.** Root cause of "the naming system is the website url
itself": in batch mode the produced archive is named `finalName`, which the
popup derived from `document.location`, and batch was the only available mode.
Two fixes: separate mode is now the default (each file is named from the
gallery's OWN metadata through the template), and list mode got its own
template setting `listDownloadName`, defaulting to the sentinel `@inherit`
= "follow the single-title template". The resolved template is relayed as
`options.downloadName` for that job only. Also fixed: separate-mode archive
names now go through `utils.cleanName(...)` exactly like single-title
downloads (they previously used the raw title, so `replaceSpaces` did not
apply — `Test Two.zip` instead of `Test_Two.zip`).

**4. PDF-merge warning (hard requirement).** `shouldWarnPdfMerge(format, mode,
titleCount)` is true only for `pdf` + effective `batch` + more than one title.
The panel shows a modal (`src/preview/pdfMergeWarning.ts`) whose focused,
default button is **Switch to separate files**; the other buttons are *Merge
anyway* and *Cancel*. The "don't warn me again" checkbox writes
`pdfMergeWarnDismissed` in storage.local and is scoped to this exact
combination only (and only when the user actually proceeded). The existing
large-batch "you are going to download N pages" confirmation is untouched and
fires first — the two stack. The in-page bar has no room for the modal, so it
uses a native confirm with the same copy, defaulting to separate files.

**5. Optional folder wrap.** `listMasterFolder` (default on) decides whether
list downloads are wrapped. It drives BOTH `rawMasterFolder` (existing
behaviour) and the new `archiveMasterFolder`, so zip/cbz/pdf can finally be
grouped the same way raw is — this also closes backlog item 26. `""` means no
wrap. `Downloader.#archiveArtifactName()` applies it in `#downloadBlob`, the
single funnel for every archive artifact (server archive, zip/cbz, pdf).

**6. Side panel (P1).** `sidePanel` permission + `side_panel.default_path:
"index.html"`. The panel and the popup render the SAME document — one rendered
view, no duplicated markup. A `uiMode` setting (default `sidepanel`) picks what
a toolbar click opens; the worker applies it with
`chrome.sidePanel.setPanelBehavior({openPanelOnActionClick})` plus
`chrome.action.setPopup("")`/`("index.html")` (an action popup always beats the
panel behaviour, so it must be cleared). Everything is feature-detected: on
Chrome < 114 and on Firefox the popup simply stays. `preview.ts` re-bootstraps
on tab activation/navigation because the panel outlives a tab switch, and adds
an `.nhdwPanel` class that drops the popup's fixed 500px width.

**7. In-page card controls (P2).** New content script
`src/content/listControls.ts` (+ `css/content.css`) puts a **Download** button
and a **Select** box on every listing card and a floating bar with
`N selected -> format -> output -> Download / Clear`. Injection is idempotent
(`data-nhdw-controls` marker) and driven by a debounced `MutationObserver`, so
infinite scroll and pagination are covered. Selection uses the SAME
`chrome.storage.local.allIds` list the panel reads, and `storage.onChanged`
mirrors panel changes back into the page. Content-script jobs carry no tab id,
so `resolveTabId()` in the worker falls back to `sender.tab.id` — the
source-tab requirement still holds. The legacy caption checkbox is wrapped in
`.nhdw-legacy-check` and hidden while these controls are on; the toggle is
`inPageControls` (default on).

New/changed settings keys (all `chrome.storage.sync` unless noted):
`listFormat`, `listOutputMode`, `listMasterFolder`, `listDownloadName`,
`uiMode`, `inPageControls`; `pdfMergeWarnDismissed` in `chrome.storage.local`.

Tests: `test/list-mode.test.js` (+27 cases), archive-master-folder cases in
`test/downloader.test.js` (+5), side-panel/content-script cases in
`test/manifest.test.js` (+2), new relay phases in `scripts/e2e-relay.js`
(list-mode option relay, explicit `separate:false`, sender-tab fallback,
UI-mode popup fallback) and a whole new VM suite
`scripts/e2e-list-controls.js`. `scripts/e2e-offscreen.js` expectation updated
to the corrected `cleanName` behaviour. Totals: **205 mocha passing / 4
pending**, smoke green, e2e green (57 PASS lines).

### Folder-naming guard (3.3.1)

User report: "the folder naming system doesn't work". Investigation method:
the deprecated RAR archives in `old deprecated source code/` were unpacked
(node-unrar-js; NHentaiDownloader 2.2.0, NHxD, nhentai_archivist) and the
Chromium docs/bug tracker consulted. Root cause: **Chromium bug 579563** —
`chrome.downloads.download()`'s `filename` is *ignored* whenever ANY other
extension registers an `onDeterminingFilename` listener (download managers,
antivirus, cloud-drive helpers), so raw pages fell into the Downloads root as
`1.jpg`, `2.jpg`… instead of `NHDW/<Title>/001.jpg`. Full study:
`FOLDER_NAMING_STUDY.md`.

Fix (v3.3.1): `src/background/downloadNaming.ts` records every requested
artifact name (worker `saveDownload` relay, worker fallback `#saveArtifact`,
offscreen anchor saves via the new `recordDownloadName` message) BEFORE the
download starts and re-asserts it through the extension's own
`onDeterminingFilename` listener, registered synchronously at worker top
level. Foreign-extension downloads are never touched; blob:/data: matches are
always asserted; entries live in chrome.storage.session (worker-restart safe)
and are pruned on completion (600-entry FIFO). `conflictAction: "uniquify"` is
now uniform (re-downloads produce `Title (1).zip` instead of overwriting).
Firefox: no-op (the event doesn't exist there and the bug doesn't either).
Known limit: a download manager installed AFTER this extension that actively
suggests names still wins per Chrome's "last installed" rule — documented in
README troubleshooting.

Tests: `test/download-naming.test.js` (+10 cases, 176 total). All suites
green (fixtures, smoke, e2e). Both release folders re-synced from source
(`diff -rq` clean); manifests bumped to 3.3.1 (source, release, Firefox).

### Popup split + similar-gallery selection (newest)

- Single-gallery popup is two columns: **left** = current gallery (title, page count, ZIP/CBZ/PDF/raw picker, path input, Download); **right** = **Similar galleries** panel.
- The panel fetches `GET /api/v2/galleries/{id}/related` only when the user clicks *Show similar galleries*, then renders a checkbox list (title + page count; `(Non-titled) #id` fallback), **All/None** toggles, and **Download selected (n)**.
- Selections send `downloadAllDoujinshis` with `separate: true` → **one archive per selected gallery**, each named after its title (flat layout). The per-job `formatOverride` from the left picker applies. `separate` overrides the stored *download each file separately* option for that job only.
- Untitled related cards use `(Non-titled) #id` (matches nhentai's own display) so files remain traceable.

### Archive naming and structure (newest)

- **Single-gallery ZIP/CBZ/PDF**: named `<clean title>.zip|.cbz|.pdf` with pages at the archive **root** (`001.jpg`, `002.png`, …) — no `Title/Title` double folder. Implemented via `Downloader` setting `archiveLayout: "flat"`.
- **Shared batch archive** (listing-page batches, multi-page batches, non-separate similar): unchanged shape — one folder per gallery inside the single archive (`archiveLayout: "nested"`, the default when unset).
- **Raw mode**: pages now save as `Downloads/<Title>/001.jpg` (titled folder + zero-padded numbering) instead of flat `Title-001.jpg`. Since **3.3.0** the titled folder lives inside a master folder by default — `Downloads/NHDW/<Title>/001.jpg` — via the `rawMasterFolder` option (Options → "Folder for raw downloads"; empty string disables, slashes nest deeper, sanitized per segment). Scope notes from review: raw only — ZIP/CBZ/PDF archives still land directly in the download folder (one file per gallery doesn't pile up the same way; a matching archive master folder is tracked as backlog item 26); `replaceSpaces` intentionally does not rewrite the user-typed folder name.
- **Last-mile filename hardening**: `sanitizeArtifactFilename` (exported from `Downloader.ts`) runs inside `#saveArtifact` for every artifact — strips control/reserved characters per path segment, leading dots, trailing dots/spaces, caps segment length, never returns empty. This addresses downloads landing under blob-UUID/number names when Chrome discards an invalid requested filename.

### PDF output format (replaced the folder mode)

- `src/utils/pdfBuilder.ts`: dependency-free PDF 1.4 writer. `jpegInfo(bytes)` parses SOF0/SOF2 frames (dimensions + component count, skips APPn thumbnails); `buildPdfDocument(images)` emits catalog/pages/page/content/image objects with DCTDecode XObjects and a byte-exact xref table.
- `Downloader` `useZip: "pdf"`: collects validated page bytes in order, embeds RGB JPEGs verbatim (no re-encode), re-encodes grayscale/CMYK JPEGs and PNG/GIF/WebP via `createImageBitmap` + `OffscreenCanvas` (white-flattened) when available, delivers `<title>.pdf` through the same object-URL/data-URL path as ZIP.
- **"folder" is retired**: options select and popup pickers now offer zip/cbz/pdf/raw; every legacy `"folder"` value (stored settings, format overrides) maps to `"pdf"` (`Downloader` whitelist, `normalizeFormatOverride` in background.ts, popup extension hints).
- The offscreen document still uses **only** `chrome.runtime`; PDF assembly happens in the same context as ZIP assembly.

### CDN configuration hardening (previous session)

- `src/sources/cdnConfig.ts` is the shared image-server configuration (validated HTTPS `*.nhentai.net` origins only); `src/background/cdnConfigService.ts` resolves `GET /api/v2/cdn` once per session (source-tab first, 6s timeout, cached in memory + `chrome.storage.session`, 1h TTL) and permission-filters the list.
- Manifest: static `host_permissions` unchanged + `optional_host_permissions: ["https://*.nhentai.net/*"]` + `permissions` API. Popup `getCdnStatus` notice with a one-click **Grant image host access** when nhentai reports ungranted hosts; downloads keep using permitted hosts meanwhile.
- Offscreen applies relayed `options.imageServers` per job.

### Download lifecycle (unchanged)

- MV3 worker relays downloads to the offscreen document; offscreen owns fetch/ZIP/PDF work, worker owns storage/downloads/scripting/permissions.
- Queue serialization, session pause/resume, queue/cancel controls, batch summary — all as before. Job start resolves CDN config first; the job marker goes up synchronously when the job is accepted.
- Session-only pause/resume: no durable restart resume — do not claim it.

### Source-tab requirement

- The source nhentai gallery tab must stay open (may be backgrounded; user whitelisted nhentai.net in their suspender) until its job completes; tab-context image fetch and the CDN config fetch prefer its Cloudflare-cleared session.

### API key

- Options page: optional user-pasted key, verified via third-party-safe `GET /api/v2/user` with `Authorization: Key <key>` only. Stored in `chrome.storage.local`, never rendered back. Never use `/api/v2/auth/*`.

### Options-page UX pass (2026-08-26, user live-test feedback)

- API key field now supports explicit paste (intercepted `paste` event; some
  browsers offer no right-click menu on extension pages) — in both the
  options page and the popup gate, with a visible Ctrl+V hint.
- Plain-language explanations for every option: what ZIP/CBZ/PDF/raw
  produce, exactly what Duplicate rename/ignore do, what the server-archive
  toggle does (no programmer-speak), one-line format hints.
- Name template is now **checkboxes** (one per placeholder, canonical order,
  " - " separator) instead of manual typing; stored format unchanged
  (`{pretty} - {id}`) so the engine and old templates are untouched; custom
  templates fall back to the manual input (`src/options/nameTemplate.ts` +
  `test/name-template.test.js`).
- **Settings inside the popup (3.2.0)**: the popup has two tabs, Download |
  Settings. The Settings tab (`src/preview/popupSettings.ts`) reuses
  `options/apiKey.ts` + `options/nameTemplate.ts`: paste-aware API key input
  with Save & verify / Remove, a saved-state status line ("A key is saved —
  API key mode is active"), and the name-template checkboxes with a live
  "Example file name" preview so the naming result is visible before
  downloading. The full options page remains as the fallback.

### Two-mode API access (2026-08-26, PR #22)

Boundary table — **API key mode** (a key is stored) vs **open tab mode**
(no key; byte-for-byte the pre-key behaviour):

| Concern | API key mode | Open tab mode |
|---|---|---|
| Metadata route order | keyed official API → open-tab read → plain fetch | open-tab read → plain fetch |
| `Authorization` header | `Key <key>` on `nhentai.net/api/` URLs only | never created |
| `429` handling | `Retry-After` backoff (clamped 0.25–15 s, max 2 retries) | n/a |
| Batch downloads | independent of the open tab's session | resolve through the open tab only |
| One-shot server archives | available (opt-in) | not available (endpoint requires auth) |

- **First-run gate** (popup): a box asks for the key with two explicit exits,
  **Submit key** / **Continue without API key**; the decision is remembered
  (`apiKeyGate` in storage.local). Mode badges ("API key" / "open tab") show
  in single and batch previews. Saving a key in options withdraws a previous
  skip; removing the key re-arms the gate.
- **Keyed routes**: `fetchNhentaiApi()` in `src/utils/apiAuth.ts` (headers
  only for `https://nhentai.net/api/`, best-effort descriptive User-Agent,
  429 backoff). Wired into popup preview, worker batch, offscreen batch —
  always falling through to the keyless routes on failure, so an invalid key
  can never break a download.
- **One-shot server archives** (experimental, opt-in toggle
  `useServerArchive`): `POST /api/v2/galleries/<id>/download?format=zip|cbz`
  (keyed; returns `{ url, expires_at }`) — `src/background/ArchiveDownload.ts`
  + `Downloader.#tryServerArchiveAsync()`. Runs only when this gallery owns
  the whole archive (never mid-shared-batch), only for ZIP/CBZ, and any
  failure (401/403/503/429/network/malformed) falls back to page-by-page.
  The signed delivery URL is fetched **without** the key.
- **Persistence fix**: the popup bootstrap used `storage.local.clear()` on
  URL changes, which would wipe the key — replaced with targeted
  `remove("allIds")`. Guarded by a test asserting the popup bundle never
  contains `storage.local.clear()`.

## CI and workflow files (manual-commit only)

`.github/workflows/**` is **outside what any agent session can push.** The
GitHub App used for `git push` in Arena sessions is not granted the `workflows`
permission, so the remote rejects the push before anything lands:

```
! [remote rejected] arena/<session> -> arena/<session>
  (refusing to allow a GitHub App to create or update workflow
   `.github/workflows/extension-tests.yml` without `workflows` permission)
```

It rejects the **entire push**, not just that file, so a workflow edit sitting
in a session commit blocks every other change too. This is permanent, not
flaky. Workflow changes in this repository have always been made by hand —
through the GitHub web editor or a local clone with a normal user credential
(that is how the 2026-09-01 real-browser-job removal was done).

**Procedure for agents:** never edit `.github/workflows/`. Write the complete
intended workflow file into `NHDW_Extension_v3.0.0/ci/pending-workflows/`,
describe it in `NHDW_Extension_v3.0.0/ci/README.md`, and list it here. If a
workflow edit has already been committed, drop it with
`git checkout HEAD~1 -- .github/workflows/<file>` and amend before pushing.

### Pending, waiting for a human

**PR #37 is merged** (2026-09-05, merge commit `8e32768`): it deleted
`new 19.txt` from `main` and recorded the 2026-09-05 review findings as
backlog items 28–34. **PR #38 is merged too** (merge commit `08148a6`): it
landed 3.6.2 + 3.6.3 (items 28–32 and 34) on `main`. Both are noted here
because earlier revisions of this document stopped at PR #37 and a reader
could otherwise assume the 3.6.2/3.6.3 work was still unmerged.
Nothing else is pending on the CI/workflow side: the
queued trigger-paths change was applied by the user through the GitHub web
editor on 2026-09-04 as commit `840d79e` ("Add additional files to extension
tests workflow"); the live workflow and
`NHDW_Extension_v3.0.0/ci/pending-workflows/extension-tests.yml` are
byte-identical. Keep the copy in `ci/pending-workflows/` in sync whenever the
live workflow changes, and add a row back to this table for any future
workflow edit.

## Required real-browser verification before PR

Reload unpacked `NHDW_Release_v3.0.0` through `chrome://extensions` or `brave://extensions`.

### 3.4.1 — cross-extension naming leak (do these FIRST: they need a second
### extension installed, and they are the only checks that can regress silently)

0A. **The blame message is gone.** Install at least one other downloader or
    download manager that hooks Chrome's naming (the user's original report
    involved a downloader for another site). Download something with that
    other extension while NHDW is installed but idle. The Chrome notification
    *"This extension failed to name the download ... because another extension
    determined a different filename"* must no longer name NHDW. If it names
    the other extension, that is the other extension's own bug, not ours.
0B. **Idle worker holds no listener.** `chrome://extensions` -> NHDW ->
    "service worker" -> Console. With no download running, the worker must not
    be in the filename chain. `chrome.downloads.onDeterminingFilename.hasListeners()`
    should report `false`.
0C. **Listener appears and disappears around a job.** Start a raw gallery
    download; re-run the `hasListeners()` check mid-download -> `true`. Let it
    finish, wait for the shelf to settle, re-run -> `false` again. Repeat for a
    ZIP job (blob artifact path) and for a cancelled job (cancel from the
    Downloads shelf -> must return to `false`).
0D. **Naming still correct under a competing extension.** With the other
    extension still installed, run a raw gallery: pages must land in
    `NHDW/<Title>/001.jpg`, not as `1.jpg` in the Downloads root. Run a ZIP:
    it must be `<Title>.zip`, not a blob UUID. This is the 3.3.1 behaviour the
    3.4.1 refactor must not have broken.
0E. **Worker-restart recovery.** Start a large gallery, then stop the service
    worker from `chrome://extensions` mid-download. The browser keeps
    downloading. Remaining files must still get their proper names (the guard
    re-attaches from the session mirror). Known and accepted gap: a
    determining-filename event that fires in the few milliseconds before the
    async `storage.session` read completes will get Chrome's default name for
    that one file — see "Open questions and things that still need review".

### 3.4.0 additions

0a. **List mode, separate files (the headline fix).** On a search / artist /
    tag page: select several galleries, Format = ZIP, Output = *Separate files*
    -> one `.zip` per title, each named from the template and the gallery's own
    metadata, NOT from the page URL. Repeat with CBZ and PDF.
0b. **List mode, merged file.** Output = *Single merged file* -> exactly one
    archive named after the box under the picker.
0c. **PDF-merge guard.** Format = PDF, Output = *Single merged file*, more than
    one title selected -> the modal appears, **Switch to separate files** is
    focused and pressing Enter produces one PDF per title. Check *Merge anyway*
    still merges, *Cancel* does nothing, and that "don't warn me again" only
    silences this exact combination (zip batch and single-title PDF must be
    unaffected). With a multi-page listing, confirm the count warning appears
    FIRST and the merge warning after it.
0d. **Optional folder wrap.** Ticked -> `Downloads/NHDW/<name>.zip` and
    `Downloads/NHDW/<Title>/001.jpg`. Unticked -> straight into Downloads for
    both. Emptying the folder name in Options behaves like unticked.
0e. **List-mode template.** Settings -> List mode -> untick "same as single
    title", change the tokens, confirm the live preview and then the real file
    name follow it while single-title downloads keep the old template.
0f. **Raw in list mode.** Still the open item below: confirm one real folder per
    title with loose `001.jpg…` inside, and that the merge option stays disabled.
0g. **Side panel.** Toolbar click opens the docked panel; it resizes; it follows
    tab switches and navigation (gallery page <-> listing page). Switch
    Settings -> Interface -> Popup and confirm the toolbar click goes back to the
    hovering popup. On a Chrome < 114 build confirm the popup is used silently.
0h. **In-page card controls.** Download button on a card downloads that gallery;
    Select boxes raise the floating bar with the right count; the count survives
    scrolling to newly loaded cards (infinite scroll); selection made in the page
    shows up in the panel and vice versa; turning the setting off removes both
    the buttons and the bar after a reload, leaving the legacy checkbox.

1. Single-gallery ZIP download: file named exactly the gallery title, pages at the ZIP root (no inner title folder). Repeat for CBZ.
2. **PDF**: same title naming; open the produced PDF — every page present, correct order, correct orientation/aspect.
   2b. **3.3.1 naming guard (new)**: with a download-manager extension installed and enabled, raw-download a gallery — pages must still land in `Downloads/NHDW/<Title>/` as `001.jpg`… (guard re-asserts names; see `FOLDER_NAMING_STUDY.md`). If the manager was installed after NHDW and still wins, note it — Chrome's "last installed listener wins" rule is documented as a known limit, not a bug to chase.
3. Raw: pages land in `Downloads/NHDW/<Title>/` as `001.jpg`… (3.3.0 master folder; emptying the Options "Folder for raw downloads" box restores plain `Downloads/<Title>/`) — no bare-number filenames anywhere.
4. Popup layout: left column downloads the current gallery; right column *Show similar galleries* lists related titles with checkboxes; uncheck a few; *Download selected (n)* produces one titled file per selected gallery.
5. Similar download with an untitled related gallery → file shows `(Non-titled) #id`-derived name, not a bare random number.
6. Queue two or more jobs; serial order, queue count, Clear queue, Cancel current; pause/resume across popup close/reopen.
7. API key: valid, invalid, remove; saved key never appears in the input. Download similar anonymously and with the key.
8. Keep the source gallery tab backgrounded on another site; confirm completion.
9. CDN hardening: `/api/v2/cdn` fetched once per session (worker console); `chrome.storage.session.get("cdnConfig")` shows the merged list; grant-notice flow when a host lacks permission.

## Review log — 3.6.0/3.6.1 rewrite audit (2026-09-05)

Trigger: user asked to verify the previous session's fix against `new 19.txt`
and then audit the whole codebase for breakage after the 3.6.0 rewrite (2
sessions back). Outcome: the fix is real and the rewrite is sound — no
garbage code. The audit found genuine defects, tracked as **backlog items
28–34** (full specs in IMPROVEMENT_BACKLOG.md, session log 2026-09-05). 3.6.2
landed 28–31 and 34. Remaining: **32** then 33.

| Item | Finding | Severity | Evidence |
| --- | --- | --- | --- |
| **28 (M1)** | Batch metadata that resolves to non-gallery JSON (e.g. `{}`, an error object) crashes `json.title.pretty` *outside* the try → the whole batch rejects, remaining titles are skipped, `failedGalleries` is never reported or remembered, popup dead-ends | High — can eat an entire batch and its failure report | worker `background.ts:648` (try) vs `:657` (deref outside); offscreen `offscreen.ts:596` vs `:614`. `ApiParsing.GetJsonAsync` returns non-gallery JSON as-is (`coerceGallery(parsed) || parsed`) |
| **29 (M2)** | Non-retryable `downloadError` renders with **zero buttons** (Go Back only exists when `canRetry`) → popup stuck until reopened | Medium — UX dead-end on batch-level errors | `src/preview/message.ts:264-279`; `popup.ts` `downloadError` branch wires buttons only when retryable |
| **30 (M3)** | History records store the *unsanitized* filename while saves sanitize → "verify before skip" (`chrome.downloads.search`) can never match → repeat downloads + `(1)`/`(2)` growth whenever a master folder/name sanitizes | Medium — silent re-download loop (edge cases: master folders with `:` / trailing dot-space / >120 chars) | records at `background.ts:388,708`, `offscreen.ts:382,660` vs `sanitizeArtifactFilename` at save (`Downloader.ts` `#saveArtifact`, raw path) |
| **31 (L1)** | Merged job + `duplicateBehaviour = "ignore"` + two *different* galleries sharing a title → second is silently dropped (no counter) and the archive can be recorded complete while missing titles | Medium — incomplete merged archive recorded as clean | `background.ts:661`, `offscreen.ts:618` (`continue` uncounted); merged-clean logic needs `failed === 0` only |
| **32 (L2)** | The worker and offscreen batch pipelines are maintained as twins and have already drifted (offscreen gained an HTML second-chance parse + tab refetch + `queued` field; the worker lacks them and drops the `Authorization` header on its direct fetch). Every fix must be applied twice — this is how 28 exists in one copy while the other was partially patched | Structural — drift source | `downloadAllDoujinshisAsync` in `background.ts` vs `offscreen.ts` (~17 KB vs ~21 KB, whitespace-normalized diff) |
| **33 (L3)** | No-offscreen fallback records/retry with `normalizeFormat(options.useZip ?? "zip")` while Downloaders read the *stored* format when no override is sent → record/extension mismatch for any caller that omits `formatOverride` (today all callers send it — theoretical) | Low | `downloadAllDoujinshis` record block vs `Downloader.startAsync` storage default |
| **34 (L4)** | Console/internal stringify spots remain: `Downloader.ts:278` retry `console.warn` and `:242` server-archive warn still concatenate a raw error, so object-shaped errors can still print `[object Object]` in the *console* (never in user-facing messages since 3.6.1) | Cosmetic | `Downloader.ts:242,278` |

**Found clean during the same sweep** (no action needed): raw completion
tracking + concurrency + abort-cancels-loose-pages; the failed-gallery session
store (serialized writes, cap, dedupe, drop-on-success); the retry round-trip
(popup → `groupRetryMessages` → worker → offscreen → `jobFinished` → history);
history/verify semantics and merged naming (date + part); download-name
sanitization and the `onDeterminingFilename` guard lifetime; PDF merge guard;
raw master-folder parity; CDN/image-URL validation; and build reproducibility
(source → committed js → release js are byte-identical). 3.6.1 itself needed
no follow-up code change.

Also noticed (already tracked elsewhere, no new item): the Firefox snapshot's
manifest still says 3.3.1 although its content received the 3.6.1 error-parity
backports — see structural open question 9 and backlog item 27.

## Open questions and things that still need review

Nothing here is known to be broken. These are the places where the current
implementation rests on a judgement call, an untested assumption, or a
deliberate trade-off, and a reviewer should decide whether they are acceptable.

### From the 3.4.1 naming-guard rewrite

1. **Restart race (accepted trade-off, unverified in a real browser).** When the
   MV3 worker restarts mid-gallery the naming listener is re-attached only
   after an async `chrome.storage.session` read. An event firing inside that
   window is not intercepted and that single file keeps Chrome's default name.
   The alternative — registering synchronously at startup — is precisely the
   leak that was just removed, so the race was chosen deliberately. Open
   question: how wide is the window in practice, and is one mis-named file per
   worker restart acceptable? Verification step 0E probes it.
2. **TTL value is a guess.** `ENTRY_TTL_MS` is 30 minutes. Too short and a very
   slow download loses its name; too long and a stuck entry keeps the global
   listener attached. Nobody has measured the slowest realistic gallery. Needs
   a real-world data point, not a debate.
3. **`hasListeners()` is the only observation method.** There is no supported
   API for "which extensions are in the naming chain", so 0B/0C rely on
   `chrome.downloads.onDeterminingFilename.hasListeners()` from the worker's
   own console. That proves our own state, not that Chrome has dropped us from
   its chain. If someone knows a stronger check, use it.
4. **Manual saves of an in-flight image.** If the user manually saves the exact
   image URL we are downloading, our recorded name wins for that save. Judged
   harmless (`uniquify` prevents overwrites, the entry clears on completion)
   but never observed in practice.
5. **The URL-keyed map assumes URLs are unique per artifact.** True for CDN page
   URLs and blob URLs today. If a future change ever reuses a URL across two
   concurrent jobs, the second would inherit the first's name. No guard exists
   for that.

### Carried over from 3.4.0, still unverified

6. **raw format** ships behind a "(testing)" label. Folder creation
   (one folder of loose images per title) has never been confirmed in a real
   browser. Until step 0f passes, the label stays.
7. **Download All across paginated listings** — that it walks every page and
   that the 2-page count warning fires is asserted by e2e stubs only.
8. **The original naming clash** with the user's other extension is expected to
   be gone now that list mode shares the single pipeline *and* the guard no
   longer participates when idle, but the two fixes have never been observed
   together on a real profile.

### Structural

9. **`NHDW_Firefox_v1.0.0` is not cleared.** It still ships the 3.3.1 guard in
   its built `js/background.js` and lags at 3.3.1 overall. Firefox does not
   implement `onDeterminingFilename`, so the guard is inert there and this is
   not a live bug — but that port has had no independent audit and none of the
   3.4.0/3.4.1 work has been ported.
10. **No other repository was audited or cleared.** The naming audit covered
    this workspace only.
11. **P3 queue UI is untouched.** Thumbnails, per-item progress and states,
    cancel/retry, concurrency limit, retry-with-backoff — all still backlog.
12. **`@types/chrome` is pinned at 0.0.154 (2021).** `chrome.sidePanel` and
    `chrome.storage.session` are both reached through `(chrome as any)`. A
    dependency bump would restore type safety on those paths but risks
    unrelated type churn.
13. **`npm run test:browser` has never run in this environment.** Every
    real-browser claim in this document is an expectation, not an observation.

## Next backlog (worklist — statuses as of 2026-09-05)

Newest additions first (from the 2026-09-05 codebase review; full specs in
IMPROVEMENT_BACKLOG.md session log 2026-09-05). **28–34 are all done**
(3.6.2 / 3.6.3 / 3.6.4). Nothing from that review is open any more.

- [x] **28. Batch metadata: non-gallery JSON must fail ONE gallery, not the
  whole batch (review finding M1, high).** DONE in 3.6.2 (`requireGallery`
  after every metadata route in both pipelines; worker e2e phase 11).
- [x] **29. Popup error state must always leave an action (M2, medium).**
  DONE in 3.6.2 (Go Back always rendered + wired; `test/message.test.js`).
- [x] **30. History records must mirror the sanitized on-disk filename (M3,
  medium).** DONE in 3.6.2 (`artifactName.ts` + `artifactRecordFilename`
  sanitizes).
- [x] **31. Merged jobs must not silently drop duplicate-titled galleries
  under "ignore" (L1, medium).** DONE in 3.6.2 (merged id-suffixes; separate
  counts `skipped`; worker e2e 12a/12b).
- [x] **32. Deduplicate the twin worker/offscreen batch pipelines (L2,
  structural).** DONE in 3.6.3 (`src/utils/batchPipeline.ts` storage-free
  core; worker `makeFallbackBatchHost` + offscreen `makeOffscreenBatchHost`;
  `test/batch-pipeline.test.js`). The core never imports `chrome.storage` /
  `chrome.downloads`. Paged jobs remember failed galleries the same way a
  selected-gallery batch does.
- [x] **33. Fallback-path format must not silently default to zip (L3, low).**
  DONE in 3.6.4. `resolveJobFormat(override, stored)` in
  `src/utils/downloadFormats.ts` is the single resolution point; the worker
  fallback always sets `settings.useZip` + caps, the relay always sends a
  concrete format, the batch core hands the normalized format to the
  Downloader, and `resolveMergedBatchName` names candidates from the job's
  resolved format (the live gap: merged warn-first searched `.zip` for a
  `.cbz` artifact). Tests: resolver units, the batch "job format contract"
  block, worker e2e 5i/5j (5j fails on the pre-fix code).
- [x] **34. Message-first sweep for remaining console paths (L4, cosmetic).**
  DONE in 3.6.2. Downloader retry / server-archive `console.warn` use
  `errorMessage()`.
- [x] Housekeeping note: merge **PR #37** (`new 19.txt` deletion + this
  audit's doc updates) — merged as `8e32768`.

- [ ] **P3 — queue UI with thumbnails (carried over from the user's brief, not
  started).** Replace the name-only queue list with a Twitter/X- or
  rule34-style list: thumbnail, title, per-item progress bar, status and
  cancel/retry per item. Per-item states: `queued`, `fetching metadata`,
  `downloading (x/y pages)`, `packaging`, `done`, `failed`. Needs a concurrency
  limit and retry-with-backoff at the queue level (the per-image retry already
  exists in `Downloader`). Today the queue lives in the offscreen document
  (`queuedJobs` in `src/offscreen/offscreen.ts`) and only reports a count plus
  "Clear queue" — a real UI needs the worker to mirror queue entries into
  `chrome.storage.session` so the panel can render them after a worker restart.
  Thumbnails are available without extra requests: `t.nhentai.net` covers are
  derivable from `media_id`, and the listing cards already have them in the DOM.
- [ ] **Raw retry policy follow-ups (3.6.0 left these open on purpose).**
  A retried raw gallery is saved next to the defective folder's pages
  (`uniquify`); an option to *remove the partial folder before retrying*
  (`chrome.downloads.removeFile` on the pages this job created) and per-page
  resume (re-download only the missing page numbers) are possible but need a
  real-browser check of `removeFile` semantics first. Also consider surfacing
  the failed list in the in-page floating bar (it only `flashStatus`es today).
- [ ] **Raw list-mode verification (blocks flipping the "(testing)" label).**
  `formatLabel("raw")` currently returns "Raw images (testing)". Once a real
  browser confirms one real folder per title with loose images, drop
  `RAW_IS_EXPERIMENTAL` in `src/utils/downloadFormats.ts`.
- [ ] **Firefox port folder is now behind (item 27).** `NHDW_Firefox_v1.0.0/`
  still carries 3.3.1 and none of the 3.4.0 work. Extra porting notes:
  `chrome.sidePanel` does not exist in Firefox — the equivalent is
  `sidebar_action` (different manifest key, different open semantics, no
  `setPanelBehavior`), so `applyUiMode()` needs a Firefox branch; and the new
  `js/listControls.js` content script has to be added to the Firefox manifest.

- [ ] **27. Port the extension to Firefox (added 2026-09-03; working folder
  `NHDW_Firefox_v1.0.0/`).** Feasibility audit done — port is possible.
  Evidence table and required-change list:
  `NHDW_Firefox_v1.0.0/PORTING_AUDIT.md`. Work order: (1) Firefox manifest
  (`background.scripts` event page, drop `offscreen` permission, add
  `browser_specific_settings.gecko`, min Firefox 128) → (2) close
  fallback-path parity gaps (pause/resume/clearQueue exist only on the
  offscreen branch, `background.ts:976-982`; the non-offscreen fallback at
  `background.ts:~1052` never answers them) → (3) repoint test path
  assumptions + extend `.github/workflows/extension-tests.yml` paths →
  (4) `web-ext lint` + real-Firefox load → (5) real-browser pass
  (blob download naming, queue controls, batch, PDF, raw, CDN grant flow).
  Full task definition: IMPROVEMENT_BACKLOG.md session log 2026-09-03.
- [x] ~~Server-side ZIP/CBZ endpoint with API key; fall back on 429/503~~ — DONE
  (PR #22, opt-in `useServerArchive` toggle with page-by-page fallback).
- [ ] **Server-archive availability check (pending — user side, no browser
  needed):** does the account actually get a usable URL from
  `POST .../download` (`allow_downloads` feature flag / tier)? Answer with
  `NH_API_KEY=<key> npm run test:live` — it probes the keyed profile
  endpoint, keyed metadata (through the real normalizer), and the archive
  endpoint, then reports availability (200 + ZIP magic) vs gated
  (401/403/503/429). Then make the keep-or-remove decision for the
  `useServerArchive` toggle (backlog item 17).
- [ ] **Real-browser run of `npm run test:browser`** on a machine with a
  full Chrome/Brave build (`sudo` so the fixture binds port 443) — the only
  remaining blocker for flipping backlog item 10 from `[~]` to `[x]`.
- [ ] **Real-browser regression pass after 3.2.1/3.2.2** — confirm a real
  blob save lands with the title-based name (the 3.2.1 anchor-`download`
  fix could be a silent no-op in a browser build that blocks programmatic
  downloads from hidden offscreen pages; nothing lands → revert to the
  worker relay) and spot-check that UI strings render clean after the 3.2.2
  mojibake fix.
- [ ] Real-browser verification of the keyed route winning in the worker console
  (previous open question: is a same-tab/worker fetch of `/api/v2/galleries`
  challenged? With a key it uses the official contract).
- [x] ~~**Optional: master folder for single-file archives (backlog 26)**~~ —
  DONE in 3.4.0 via `archiveMasterFolder` + the `listMasterFolder` checkbox.
  Single-title downloads still default to no wrap; list mode wraps by default
  and the checkbox turns it off.
- [ ] Optional: sync the API key across the user's own devices
  (`chrome.storage.sync`) — deliberately local-only today; needs an explicit
  user decision (secret syncing).
- [ ] Optional: force the descriptive `User-Agent` via `declarativeNetRequest`
  (fetch() forbids it in some contexts) — deferred, adds a permission.
- [ ] Persistent restart-safe resume (checkpoint/rebuild strategy).
- [ ] Search/favorites/blacklist/comments API UI features.
- [ ] PDF niceties (not required): PDF/AV viewers validate fine, but consider a
  cover/thumbnail entry or bookmarks outline if ever requested.
- [x] ~~Enable a GitHub Actions workflow for the real-browser suite~~ —
  RESOLVED by removal (2026-09-01): GitHub-hosted runners cannot launch the
  MV3 harness (Chrome `Runtime.enable` timeout / Brave SIGTRAP, failed on
  every run since introduction). CI is offline-suites-only
  (`extension-tests.yml`); the real-browser suite stays local
  (`npm run test:browser`). See backlog item 10.

## Do not

- Do not switch branches or push to a branch other than the current session branch.
- Do not treat `chrome.downloads.download()`'s callback as "file saved" again.
  It only means the item was created; use `startTrackedDownload` /
  `awaitDownloadCompletion` (`src/background/downloadControl.ts`) or the
  offscreen `saveViaServiceWorker` relay, which awaits completion. Do not hold
  one `awaitDownload` message open longer than `AWAIT_DOWNLOAD_SLICE_MS` (MV3
  kills the worker at 5 minutes per in-flight event).
- Do not delete user files from a defective raw folder automatically, and do
  not record a gallery in the download history unless every page completed.
- Do not register `chrome.downloads.onDeterminingFilename` at worker startup or
  leave it registered while idle. It is a profile-wide event: participation
  alone makes Chrome able to blame this extension for other extensions'
  downloads. Attach it only while our own filenames are pending and detach on
  every drain path (see "Filename-guard listener lifetime"). Never call
  `suggest({ filename: "" })`, and never call `suggest` more than once per
  event.
- Do not edit `.github/workflows/**` from an agent session. The push will be
  rejected for the whole branch (`without \`workflows\` permission`). Put the
  intended file in `NHDW_Extension_v3.0.0/ci/pending-workflows/` and record it
  under "CI and workflow files (manual-commit only)" so a human can commit it.
- Do not fork the download logic for list mode. List mode must keep calling the
  same `downloadAllDoujinshis` pipeline with per-job options; the formats and
  the output mode must keep coming from `src/utils/downloadFormats.ts`. Two
  copies of "what a format is" is exactly how list mode ended up stuck on ZIP.
- Do not make the master-folder wrap mandatory again, and do not let list mode
  fall back to the page URL for a file name in separate mode.
- Do not remove or weaken the PDF-merge confirmation, and do not widen its
  "don't warn me again" flag beyond `pdf + batch + more than one title`.
- Do not drop `action.default_popup` from the manifest: the popup is the
  documented fallback for builds without `chrome.sidePanel` and for users who
  prefer it.
- Do not put `chrome.storage`, `chrome.downloads`, `chrome.scripting`, or `chrome.permissions` in the offscreen document.
- Do not use `/api/v2/auth/*` or `/api/v2/user/keys`.
- Do not remove tab-first fetching or claim Cloudflare bypass.
- Do not run `npm audit fix --force`.
- Do not expand web-accessible resources.
- Do not add `<all_urls>` (or any non-nhentai host) to host/optional-host permissions; all image hosts must validate as HTTPS `*.nhentai.net` origins.
- Do not reintroduce the "folder" output mode; PDF replaced it (legacy `"folder"` values must keep mapping to `"pdf"`).
- Do not re-add real-browser (real Chrome / real Brave) jobs to GitHub Actions — they failed on 100% of runs because hosted runners cannot launch the MV3 extension harness (backlog item 10). CI is offline-suites-only; real-browser verification is local `npm run test:browser`.
