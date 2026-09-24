# Worklist — nh-dw-2.0

**Live, ordered. Updated 2026-09-24** (session `arena/01a0cdce-nh-dw-2-0`:
items **39/45/51** landed with PR #48, the mandatory review pass fixed eight
defects in them (Firefox cancel-UI parity, cancel-mark lifecycle, cross-site
cancel identity, done-row guard, OPFS cleanup hardening, stale docs), captures
+ notes were **sanitized** on owner request (dummy titles/tags, ad blocks
stripped, website naming schemes kept; originals only in git history), and the
docs were consolidated — `SESSION_HANDOFF.md` slimmed to operating rules,
completed-work detail lives in `IMPROVEMENT_BACKLOG.md`;
`BOOKMARK_QUEUE_PLAN.md`, `NEXT_CAPTURE.md` and `SITE_CAPTURE_AUDIT.md` were
deleted as complete/superseded.)

This is the single place to look for *what to do next*.

| Document | What it is for |
|---|---|
| **`WORKLIST.md`** (this file) | Ordered, statused list of open work. Start here. |
| **`SESSION_HANDOFF.md`** | Operating rules: current state, structural invariants, real-browser checklists, the full Do-not list. Read before touching code. |
| **`IMPROVEMENT_BACKLOG.md`** | The improvement log: full specs + session logs for every numbered item. The keeper of completed-work history. |
| **`MULTISITE_V4_PLAN.md`** | Multi-site decision record, cooldown strategies (C pending owner), bucket list. |
| **`ADAPTER_WIRING_PLAN.md`** | Per-site contract matrix + adapter interface — the reference for site #7+. |
| **`CAPTURE_GUIDE.md`** | How to capture samples for a NEW site. |
| **`CANDIDATE_SITES.md`** | Candidate analysis for site #7+ (tiers, onboarding checklist, the 2026-09-24 swap decision). The canonical URL roster lives in `new domain candidate` on main. |

Item numbers are shared with `IMPROVEMENT_BACKLOG.md` and are never reused.

---

## Mandatory first step, every session

**Review the previous session's diff before writing new code.** Hunt for
(1) **missing logic** — a handler with no caller, a setting with no reader, a
notice promising what the code never does; (2) **misaligned code** — a guard in
one path but not its sibling, a default contradicting its own comment;
(3) **broken code** — a state read clobbering a concurrent write, an optimistic
update wiped by the next refresh. Then write a test that **fails on the
pre-fix build**. This rule has paid for itself four times (3.7.0: six defects;
2026-09-05: eight; PR #44 review; PR #48 review: eight more — including a
whole feature's UI missing from one tree).

Two cheap checks that have caught real bugs here:
- `grep -rn <exportedName> src/ scripts/ test/` — an export with one hit (its own declaration) is dead code; a message action with a handler but no sender is dead too (check BOTH trees — that was PR #48's defect 1).
- For any guard you add, grep every caller of the unguarded original and ask whether each is safe by construction or by accident.

---

## Open, in the order I would take them

### 42/58. Real-browser + Android device passes, then signing — **owner-only, top of the queue**

The only unverifiable-here claims left. Chrome: the Queue-tab checklist, the
naming-guard probes (0A–0E), list-mode/formats steps and the new PR #48 items
(per-row Cancel mid-batch + retry-after-cancel, late-cancel done guard, real
OPFS streaming on a large gallery). Firefox desktop pass + Android matrix,
then `npm run sign:firefox` (AMO keys via env). **Full step-by-step checklists:
`SESSION_HANDOFF.md` → "Required real-browser verification".** `npm run
test:browser` has never run in any agent sandbox.

### 40. Popup harness does not bootstrap a listing page — offline-feasible

Item 59 delivered `getGalleries` directly to test format rendering, but page
injection/bootstrap, pagination, listing-job/PDF-merge and similar-gallery
workflows are still only covered by the content-script harnesses
(`e2e-list-controls.js`). Extending `scripts/e2e-popup.js` means stubbing
`getGalleries` + `activeTabGallery` — a real piece of work; both trees.

### Pending on the OWNER (nothing here is scheduled until they act)

- [ ] **⏳ Strategy C go-ahead (item 50 follow-up).** Chosen and recorded, but
      execution waits for the owner's explicit confirmation (other projects
      running). The owner's own live-testing note already leans Strategy A
      (reader-mode pages won the quality comparison; mirror zips were
      byte-identical), but C is the recorded decision path. A/B/C descriptions:
      `MULTISITE_V4_PLAN.md` §3.
- [ ] **⏳ Site #7 pick.** The 2026-09-24 owner-directed swap landed:
      `new domain candidate` on main now carries the reference roster
      (Tier 1: asmhentai, e-hentai, pururin, simply-hentai, myreadingmanga,
      nhentai.com; Tier 2 boorus), matching `CANDIDATE_SITES.md` §2/§3 1:1 —
      no double entries. The chapter-based webtoon/manhwa picks (tailspace,
      mangak.io, omegascans) swapped to the desktop archiver project. When
      the owner picks one: capture per `CAPTURE_GUIDE.md` (one sanitized HAR,
      or gallery+reader HTML and 3 image URLs), then implement against
      `ADAPTER_WIRING_PLAN.md` §1/§3/§4/§6.
- [ ] **Merge PR #48** (items 39/45/51 + review fixes; CI green; mergeable).
- [ ] **Cross-mirror fallback chains** from the owner's live-testing note
      (throttle-route imhentai↔hentaienvy via the shared `/033/<token>/` store
      by host swap — never by id; hentaiera→hentaienvy→imhentai and
      hentaiera-first chains by title match): deliberately deferred (owner's
      2026-09-15 call: one site at a time, no cross-mirror fallback yet).
      Recorded in `MULTISITE_V4_PLAN.md` §2.2 so it is not re-derived.

---

## Done (one line each — details in `IMPROVEMENT_BACKLOG.md` session logs)

- **39/45/51 (2026-09-24, PR #48):** empty-token filename cleanup ·
  per-row Cancel of in-flight downloads · constant-memory streaming ZIP writer
  (OPFS + memory fallback). Review pass fixed 8 defects (Firefox UI parity,
  cancel-mark lifecycle, composite cancel identity, done-row guard, OPFS
  delayed-unlink + orphan sweep, channel hygiene, stale READMEs, DEFLATE
  honesty). Chrome 519 / Firefox 595 units; e2e 143/175 PASS; CI green.
- **48 (2026-09-23, PR #47):** per-site jobs — a `site:id` queue row is
  downloadable; mixed selections split one job per site; per-adapter metadata
  resolution; bare-id file names; composite history/retry keys.
- **43/44/52/41 (2026-09-23, PR #47):** panel + similar-row bookmark toggles ·
  drag-reorder (order = download order) · queue+history JSON export/import
  (union, local wins, never deletes) · `isCanonicalTemplate()` odd-separator gate.
- **Bookmark icon + gallery-page Bookmark button (2026-09-23, 3.9.0/FF 1.3.0):**
  SVG bookmark on cards; blue Bookmark button on all six sites' gallery pages.
- **49/50/53 (2026-09-22/23, 3.9.0/FF 1.3.0):** hitomi adapter (`gg.js`
  dynamic resolver, default raw) + mirror-network adapters (hentaiera,
  imhentai, hentaienvy) + hentaifox — all six sites shipping.
- **47 (2026-09-14, 3.8.0):** composite `(site,id)` keys everywhere; `cin.*`
  viewer-mirror paste shapes pinned.
- **59 (2026-09-21, Firefox-scoped):** saved list-format reads fixed across
  the three shared readers (explicit optional-key request, no ZIP default,
  inheritance intact; 36-case matrix).
- **Dependency maintenance (2026-09-21):** Mocha 12.0.2 both trees; web-ext
  10.6.0 + scoped addons-linter override (FF); audits 16→0 / 5→0; two honest
  upstream warnings remain (`DEPENDENCY_MAINTENANCE.md`).
- **38 (2026-09-21, Firefox-scoped):** options-page offline harness (33 tests)
  + narrow `options.ts` regression fixes.
- **56/57 (2026-09-20, FF 1.2.0):** website-embedded UI — header invoker +
  settings/queue drawer on nhentai; popup demoted to fallback (Download tab
  kept); PR #44 review fixes (source-tab context, renderer CSS, drawer
  lifecycle).
- **46/37/55/54 (2026-09-19, FF 1.0.0/1.1.0):** Android snapshot; parity
  elevation rebase (Firefox = Chrome src + audited delta); Firefox panel harness.
- **3.7.0 (2026-09-08):** bookmark queue (Queue tab, ☆ on cards, paste box,
  dock, auto-capture off-by-default); six-defect self-review.
- **3.6.0–3.6.4 (2026-09-04/05):** named failures + Retry failed; raw
  completion tracking; `[object Object]` sweeps; shared batch pipeline;
  one format decision per job; review items 28–36 closed.
- **3.5.0 (2026-09-04):** download history, verify-then-redownload, merged
  warn-first naming (`_DDMMYYYY`, `_partN`).
- **3.4.0/3.4.1 (2026-09-03/04):** list-mode parity (four formats everywhere,
  separate/batch, list template, folder wrap), side panel, in-page card
  controls; filename-guard listener lifetime (reference-counted).

---

## Harness notes that will cost you a round if you miss them

- **CI runs Node 22; the agent sandbox often runs Node 20.** Node 21+ has a
  getter-only global `navigator` — stub via `Object.defineProperty`, never
  plain assignment (this broke CI once: OPFS sink tests). **Mocha's exit code
  is its failure count** ("exit code 3" = 3 failing tests). Check-run
  annotations + jobs/steps APIs are readable from the sandbox; raw log
  downloads are not.
- **Bare `npx mocha test/x.test.js` uses a stale `build/test/`.** Only
  `npm test` runs `build:test` first — a brand-new export looks "not a
  function" purely because `tsc` never re-ran.
- **A new `test/*.test.js` must be appended to the explicit mocha list in
  `package.json`'s `test` script** (both trees), or it silently runs nothing.
- **`npm run test:e2e` is 8 scripts (Chrome) / 12 (Firefox), each with its own
  hand-rolled DOM/chrome stub.** Read the header of the one you edit — the stub
  traps in `scripts/e2e-popup.js` each cost a debugging round when written.
  Storage stubs must be key-scoped and async (a whole-store merge mock once hid
  the item-59 defect).
- **`js/` is committed, not ignored.** After any `npm run build`, run the
  exhaustive release-folder sync loop (`SESSION_HANDOFF.md` → Repository and
  branch). `test/manifest.test.js` asserts the two manifests' versions match.
- **`node_modules` does not persist between sessions** — `npm install` first
  in whichever tree you touch.
- **Captures are sanitized working-tree files.** Do not resurrect original
  titles from git history into any file an agent will read (content filters
  hard-stop on them); when adding a NEW capture, sanitize it the same way
  first (dummy titles/artists/tags, strip ad blocks, keep website naming
  schemes) — the pattern lives in the 2026-09-24 backlog log.
