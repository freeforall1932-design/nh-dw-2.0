# Worklist — nh-dw-2.0

**Live, ordered. Updated 2026-09-08** (session `arena/01a07d48-nh-dw-2-0`,
3.7.0, merged as PR #40).

This is the single place to look for *what to do next*. The other two documents
carry the depth:

| Document | What it is for |
|---|---|
| **`WORKLIST.md`** (this file) | Ordered, statused list of open work. Start here. |
| **`SESSION_HANDOFF.md`** | What the last session changed and why, the "Do not" rules, real-browser verification steps. Read its top block before touching code. |
| **`IMPROVEMENT_BACKLOG.md`** | Full specs and history for every numbered item, oldest first. |
| **`BOOKMARK_QUEUE_PLAN.md`** | Design and rationale for the 3.7.0 bookmark queue specifically. |

Item numbers are shared with `IMPROVEMENT_BACKLOG.md` and are never reused.

---

## Mandatory first step, every session

**Review the previous session's diff before writing new code.** This is a rule,
not a suggestion — it is recorded in `SESSION_HANDOFF.md` and it has paid for
itself twice. Hunt for three specific things:

1. **Missing logic** — a message handler with no sender, a setting with no
   reader, a UI notice that promises something the code never does.
2. **Misaligned code** — a guard applied in one path but not its sibling; a
   default that contradicts its own comment; a documented behaviour that is dead
   in every code path.
3. **Broken code** — a state read that clobbers a concurrent write; an
   optimistic UI update wiped by the next refresh; a listener registered in the
   wrong scope.

Then write a test that **fails on the pre-fix build** for anything found. The
3.7.0 session ran this on its own output and found **six** defects (five of them
in code written hours earlier in the same session). The 2026-09-05 session found
**eight** across four passes.

Two cheap checks that have caught real bugs here:

- `grep -rn <exportedName> src/ scripts/ test/` — an export with one hit (its own
  declaration) is dead code.
- For any guard you add, `grep` for every caller of the unguarded original and
  ask whether each one is safe by construction or by accident.

---

## Open, in the order I would take them

### 42. Real-browser pass for the Queue tab — **highest priority**

**Why first:** 3.7.0 shipped on offline evidence. `npm run test:browser` has
**never** run in this environment, so every claim about rendering, restart and
the side-panel API is a VM result or an expectation.

Verify in a real Chrome 116+ profile:

- [ ] Bookmark three cards → close the browser → **restart the machine** →
      reopen → the list, its ticked rows and its collapsed state are identical.
- [ ] Thumbnails actually paint from `t.nhentai.net` (no host permission is
      involved; confirm that is true and not a silent CSP block).
- [ ] "Open docked ↗" opens the side panel **from the popup**, and is **hidden**
      when the document already is the panel.
- [ ] Paste `366224,177013` → **Download now** → both files land, named by the
      list-mode template.
- [ ] **Add to queue** with no nhentai tab open shows the "Open an nhentai.net
      tab" notice, and with one open resolves titles and covers.
- [ ] Auto-capture on a real infinite-scroll page: cards collect as they render,
      and turning it on mid-page collects what is already there.
- [ ] The ☆ survives nhentai's own re-renders without duplicating.

Then add the steps to "Required real-browser verification before PR" in
`SESSION_HANDOFF.md`.

### 43. ☆ on the single-title preview and on similar-gallery rows

**Cost: low.** The worker side is already done — `bookmarkAdd` accepts
`source: "page"` and `"similar"`, and `thumbnailUrlFromGallery` derives a cover
from a resolved `media_id`. Only two render sites are missing:
`popup.ts #doujinshiPreviewAsync` (single title) and the similar-galleries list
built by `message.similarList`.

Decision needed: use the derived `media_id` thumbnail (the metadata is already in
hand at both sites) rather than leaving the row coverless until enrichment.
Recommend yes.

### 44. Drag-reorder the bookmark list

**Cost: low.** `planBookmarkDownload` already emits ids **in list order**, so
reordering the list already reorders the batch — only the affordance is missing.
Order is already implicit in the stored array; add **no** new field. Must not
fight the row's checkbox / Download / Remove hit targets.

### 45. Per-row cancel of an in-flight download — **the surviving half of P3**

**Cost: high, structurally blocked.** The old "P3 queue UI" item is now split:
the bookmark half shipped in 3.7.0; this half did not, because the blocker was
always about the *job* queue. It still lives as `queuedJobs` inside the offscreen
document and is surfaced only as a count.

Cancelling one specific gallery needs the worker to mirror job state into
`chrome.storage.session` with per-item identity, and the offscreen loop to check
it between pages.

**Do not** solve this by growing the bookmark list into a job queue — see the
"Do not" rules in `SESSION_HANDOFF.md`. Until it lands, the existing global
pause / resume / `clearQueue` are the only stop controls.

### 46. Firefox port of the bookmark queue

**Blocked behind 37.** `NHDW_Firefox_v1.0.0` is untouched by 3.7.0 and still
lags at 3.3.1. `chrome.sidePanel` has no Firefox equivalent — the analogue is
`sidebar_action`, and "Open docked ↗" must degrade to a message rather than a
failed call. Everything else ports directly: `bookmarkQueue.ts` is
storage-agnostic, and the worker messages and content-script star are ordinary
WebExtension APIs.

Without item 37 there is no way to verify the port, which is why 37 comes first.

---

## Carried over from the 2026-09-05 review (unchanged)

- [ ] **37. Firefox panel harness.** That tree has no offline coverage of its
      popup/Settings pane at all. Port `scripts/e2e-popup.js` (its DOM stub is
      reusable verbatim) and wire it into its `npm run test:e2e`. **Blocks 46.**
- [ ] **38. Options-page harness.** `js/options.js` has no VM harness, so
      `options.ts`'s DOM wiring is only typechecked. Needs a stub modelling
      `<select>.options` / `selectedIndex` plus the real `options.html` lists.
- [ ] **39. Decide the empty-token separator — needs a human call, not code.**
      `{id} - {pretty} - {language}` with no language tag produces
      `"123456_- "`. The empty-token behaviour is pinned on purpose by
      `test/parsing.test.js`, so this is a contract, not a bug. Two options,
      both with costs; deliberately undecided.
- [ ] **40. Popup harness does not bootstrap a listing page.** So the panel's
      list-job / PDF-merge / similar-galleries paths are covered only by the
      equivalent content-script phases. Extending it means stubbing
      `getGalleries` + `activeTabGallery`.
- [ ] **41. Non-canonical separators are canonicalised on tick (UX decision).**
      `isTokenOnlyTemplate("{pretty}_{id}")` is `true`, so the first tick
      rewrites it to `"{pretty} - {id}"`. Suggested: an `isCanonicalTemplate()`
      gate routing odd separators to the manual input.

Also carried, older: raw retry-policy follow-ups, raw list-mode verification in
a browser, and the standing fact that **no real-browser verification has ever
run in this environment**.

---

## Done recently

- [x] **3.7.0 (2026-09-08) — bookmark queue.** New tab, persistent
      `chrome.storage.local` list, per-card ☆ with cover capture, collapsible
      dock, paste-by-id (single or batch, bookmark or download-now),
      off-by-default auto-capture, dockable-panel launcher. Six review defects
      found and fixed. `npm test` 310 → **366 passing**; e2e 101 → **117 PASS**.
      Details: `BOOKMARK_QUEUE_PLAN.md`, and the 2026-09-08 session log in both
      other documents.
- [x] **3.6.4 (2026-09-05) — item 33**, one format decision per job
      (`resolveJobFormat`), plus four review passes closing items 28–36.
- [x] **3.6.3 (2026-09-05) — item 32**, one shared batch pipeline
      (`src/utils/batchPipeline.ts`).
- [x] **3.6.2 (2026-09-05) — items 28–31, 34.**

---

## Harness notes that will cost you a round if you miss them

- **Bare `npx mocha test/x.test.js` uses a stale `build/test/`.** Only
  `npm test` runs `build:test` first. A brand-new export will look like
  "not a function" purely because `tsc` never re-ran.
- **A new `test/*.test.js` must be appended to the explicit mocha list in
  `package.json`'s `test` script.** The list is explicit; a new file silently
  runs nothing and the suite still reports success.
- **`npm run test:e2e` is six scripts, each with its own hand-rolled DOM/chrome
  stub.** Read the header of the one you are editing — the stub traps in
  `scripts/e2e-popup.js` each cost a debugging round when they were written.
- **`js/` is committed, not ignored.** After any `npm run build`, copy the
  changed bundles into `NHDW_Release_v3.0.0/` — that is the folder users load.
  `test/manifest.test.js` asserts the two manifests' versions match.
