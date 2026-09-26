# Visual asset plan — NHentai Downloader

**Status: planning only.** No new visual asset is approved or installed.
Repository: <https://github.com/freeforall1932-design/nh-dw-2.0>.
**Current task (owner directive, 2026-09-26): build the FULL visual system in
ONE shot.** One build cycle, one combined preview page, one review. The six
families below — multi-site logo system, backdrop, tabs, buttons, injected
page bar, and status UI — are all made together, not sequenced. Do not
redesign the download engine or change site adapters. This document holds the
complete plan and acceptance criteria for the asset-making agent; when it is
followed end to end, every visual surface ships in a single pass.

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
- Product: six supported sites — **nhentai.net, hentaifox, imhentai,
  hentaiera, hentaienvy, hitomi.la** (`src/sources/*Source.ts`); Download,
  Bookmark, Settings; listing-card controls and a fixed floating bar including
  Harvest/Stop. Popup is about 500px wide on desktop; test Firefox Android
  around 360px, including coarse pointer and an open keyboard. Colors used
  now: pink `#e31b53`, dark blue-gray `#202a34`, and a bright green detail in
  the legacy icon. Keep button labels readable in both themes.
- Real UI labels to preview alongside proposed art: a card's **Download**
  (`src/content/listControls.ts`, `css/content.css`); the listing bar's
  **Select all**, **Download** and **Harvest / Stop harvest**; the gallery
  preview's **Save offline** (`src/preview/message.ts`); and the multi-page
  panel's **Download range now** (`src/preview/popup.ts`). The old blanket
  “Download all (N pages)” action was retired (WORKLIST.md item 71): do not
  reintroduce it simply to make a mockup look familiar.

## The one-shot scope — six families, one cycle

| # | Family | Delivery in this cycle |
|---|---|---|
| 1 | Multi-site logo system | Master mark + inactive grey + six site sigils (below) |
| 2 | Quiet panel backdrop | Dark/light SVG (or compressed WebP) behind popup/drawer |
| 3 | Popup tabs | Restyled Download / Bookmark / Settings bar, opt. 16px glyphs |
| 4 | Buttons & microinteractions | Full state matrix + Harvest→Stop morph, CSS-only |
| 5 | Injected page UI | Floating action bar + listing-card controls refresh |
| 6 | Status & feedback | Badges, empty state, modals |

Everything lands in one preview and one review; see
[The one-shot specimen page](#the-one-shot-specimen-page) and
[One-shot build order](#one-shot-build-order-single-cycle).

## Family 1: multi-site logo system ("site sigils")

The legacy icon is worth reading before drawing anything (see attached
`Icon.png`): a **winged, horned demon silhouette** (the site the extension was
born on — nhentai) fused with a **downward arrow** (the job it does —
download). Two ideas welded into one mark. The new system keeps that DNA and
extends it across all six sites instead of discarding it.

**Design principle — one arrow, six worlds.** The shared DNA is the
downward arrow (the job: download); the wings belong ONLY to the NH demon
lineage (the heritage: where it was born). Every site builds its own world
around the arrow with ONE structural mutation + ONE accent color, the same
way the original twisted "demon + download" into a single silhouette. The
twist must be *transformative* (our geometry speaking about the site), never
a copy or trace of the site's actual logo asset or trademark art. (Owner
refinement 2026-09-26: wings are no longer the family uniform.)

| Site | Sigil twist | Accent |
|---|---|---|
| nhentai.net | **OWNER DIRECTIVE: black demon wings + red downward arrow.** Detail law: layered membrane detail lives on the WINGS only; the head stays clean and simple (A3). Horn signature: **two tall horns** (the heritage crown). The pink + bright-green original is preserved as the "classic" variant. | Deep red on black |
| hentaifox | **OWNER REDESIGN: the arrow IS the fox** — ears at the arrowhead's side shoulders, tail streaming from the shaft top with white tips. Horn signature: **ears, not horns** (it is a fox). | Ember orange on black |
| hitomi.la | Chunky squared wings + eye-ring arrowhead (KEEP — the unique parts), **with the "O" echoed as a halo ring floating above the head** (owner's halo request: an addition, not a substitution). Horn signature: **hornless** (the angelic one). | Magenta/violet |
| imhentai | **The mimic** — mismatched wings (left bat-membrane, right feathered: a mirror copy assembled from its parents), side horns, teal arrow + underline platform. (The twin-arrow draft read as a recycle glyph and was killed.) | Teal |
| hentaiera | Chalice-arrow + underline (restored first-pass mutation — do NOT flatten). Horn signature: **single center horn** (the chalice-bearer). | Antique gold |
| hentaienvy | Hunched posture (head lowered, wingtips drooping) + underline. Horn signature: **short stubby side horns** (the envious sibling hunches). | Violet |

Sibling law (owner correction 2026-09-26): recolor ≠ mutation — siblings may
share geometry only where the shared part is the shared story (the trio's
underline filename quirk); each sibling keeps its own structural mutation.
Horn signature table: NH = two tall horns; Hitomi = hornless + halo;
HentaiFox = ears; ImHentai = side horns + mismatched wings; HentaiEra =
single center horn; HentaiEnvy = short stubby side horns.

**Project master candidate — the crow (owner concept 2026-09-26):** a bird
NO single site owns, since the extension grew past nhentai — a raven head in
profile whose lower body dissolves downward into black-mist pixels
(pixel-art, chunky blocks, semi-simple like Hitomi's chunky wing; references
the owner's two concept captures: crow capture + mist-dissolve emblem).
Variants staged in the switcher: `crow-mist` (pure), `crow-mist-redeye`
(owner v12: **the eye is the state marker** — arrow-red on supported sites,
balloon-blue on unsupported tabs; body desaturates normally but the
inactive eye never goes plain grey), and `crow-mist-arrow` (the mist
regathers into the red download arrow, keeping the family DNA). Every line
carries its own grey twin; the plain pair stays preserved untouched.
**Compare-by-rename (owner request, v6):** alpha-real copies also ride at
the extension root as `Icon-crow-*.png` (color + grey twins for every crow
line), right beside the real `Icon.png` — in the source tree AND in the
shipped ZIP (`scripts/package-chrome.js` `CORE`). To compare in a live
extension: rename one to `Icon.png` — no rebuild, no switcher needed.
**Stability posture (owner question, answered):** `classic` stays the
shipping default **and** the permanent fallback through the tryout era —
recognition for existing users is worth more than novelty; if the crow is
crowned it replaces `Icon.png` only with vectorization + a changelog entry,
while classic stays selectable forever in the switcher.

Rules for the sigils:

1. Readable as a silhouette at **16px**; if the mutation disappears at 16px it
   is too small — enlarge or simplify until it survives.
2. Every sigil ships as original flat vector master + **transparent** PNGs
   at 16/32/48/96/128px, active **and** inactive-grey variants (same
   treatment as `Icon.png`/`Icon-grey.png`). Under ~1 KB per SVG master
   where possible. **Alpha law (owner notes, v5→v7 final):** every raster
   entering `assets/icons/` is background-free (corner-seeded floodfill of
   the outer white), **but the interior keeps the original painted
   coloring — intentional white/pale detail STAYS**: fox-tail inner white,
   the wing-bone lattice ("inner devil wing aka bone"), mimic feather
   strokes, hitomi eye-ring. The only interior pixels that may be removed
   are **trapped background blocks** (white regions enclosed by the mark,
   disconnected from the canvas edge — e.g. the crow mist block), keyed
   with a pure-white fuzz on the **uncompressed white-background render**
   in `Preview/logo-lab/site-sigils/`. v6 owner correction, now law: never
   re-key the compressed 128px runtime copy in place (double-processing
   invents tint/softness artifacts and made me eat the tail and bone) —
   always re-derive from the originals. Pre-edit states are preserved on
   disk: `Preview/logo-lab/alt-states/v5-whites-preserved-from-compressed/`
   and `v6-whites-keyed/`. QA = composite on `#202a34` **and** `#f5f5f5`
   + 16px magnified row; a visible white/black box around the panel = fail,
   any interior white the owner calls out = keyed from the original.
   (Tryout state as of 2026-09-26: blackwing A/B + grey-wings rasters AND the
   five other site sigils — fox, eye-arrow, and the underline-notch trio with
   proposed teal/gold/violet accents — AND the two crow master candidates,
   all staged alpha-real at 128px under
   `NHDW_Extension_v3.0.0/assets/icons/` next to the classic pair, and a
   **Settings → "Toolbar icon" select** applies them live via
   `chrome.storage.sync` `toolbarIcon` + the theme map in
   `src/background/background.ts` — the approval vehicle for A vs B and the
   sigils. Review sheet with dark/light rows + the 16px magnified row:
   `NHDW_Extension_v3.0.0/Preview/logo-lab/sigil-wall-v7.png`. Default stays
   `classic`; the trio's raster geometry will be unified into one SVG master.
   Method reference: `DESIGN_REFERENCE.md`.)
3. Only the **master mark and its grey variant** may ever map to the
   manifest icons (`Icon.png`/`Icon-grey.png`), and only after approval. The
   master is the family "spine" — the nhentai black-wing/red-arrow sigil is
   the leading candidate for it, decided in the one-shot review.
4. Site sigils render in the preview, and later as decoration in Settings /
   per-site rows after approval. **Optional payoff (separate approval, this
   cycle plans it, does not wire it):** per-tab toolbar swap via
   `chrome.action.setIcon({tabId})` so the toolbar shows that site's sigil
   while browsing it. Baseline manifest icon stays the master mark.
5. No gradients or fades in masters; solid colors only. No text, no letters,
   no watermarks inside the mark.

## Reference repositories to elevate the design (borrow technique, not assets)

Study these before drawing. Their *methods* are the point; copying their marks
is forbidden by the transformative rule above.

- **edent/SuperTinyIcons** — <https://github.com/edent/SuperTinyIcons>.
  Hand-tuned brand SVGs averaging under ~534 bytes, each readable at favicon
  size. Steal the method: 512-viewbox with a documented safe zone
  (`rx="50%"` circle check), 0-decimal path precision, solid colors, hand
  minification via SVGO/svgcleaner. This is the exact discipline the sigils
  need to stay recognizable at 16px instead of generic.
- **simple-icons/simple-icons** — <https://github.com/simple-icons/simple-icons>.
  Thousands of brands distilled to ONE color and ONE path. Reference for how
  far a silhouette can be simplified while staying identifiable — the bar the
  six sigils must clear.
- **gilbarbara/logos** — <https://github.com/gilbarbara/logos>. Full-color
  pro-grade SVG logo masters; study curve quality and optical correction, not
  the marks themselves.
- **lucide / phosphor / tabler** — <https://lucide.dev>,
  <https://phosphoricons.com>, <https://tabler.io/icons>. Consistent stroke
  icon systems for the optional 16px tab glyphs and button icons. Pick ONE
  system for the whole extension; never mix stroke weights.
- **svg/svgo** — <https://github.com/svg/svgo>. The optimization pipeline for
  every final vector: run it, then eyeball at 16px again.
- **gorhill/uBlock** — <https://github.com/gorhill/uBlock>. The reference for
  dense popup/panel UI inside a fixed extension width: panel info hierarchy,
  no-wasted-pixel toolbar rows.
- **darkreader/darkreader** — <https://github.com/darkreader/darkreader>.
  Gold standard for styling that must survive inside hostile third-party
  pages (family 5): hard containment, inline-style guards, no global resets
  leaking in or out.
- **RealFaviconGenerator** — <https://realfavicongenerator.net>. Its
  transparent-margin/safe-zone checklist for 16px toolbar legibility; apply
  before exporting any PNG set.

## Shared baseline for all six families

- **Design tokens already in use:** pink `#e31b53`, dark blue-gray `#202a34`,
  bright green accent from the legacy icon. Derive hover/active/disabled
  shades from these; a new color needs a documented role and a contrast check
  in both themes. The logo system adds: sigil black, sigil red, and the
  per-site accents above.
- **Surfaces and sizes:** desktop popup ~500px (`css/style.css`), Firefox
  Android drawer ~360px with coarse pointer and open keyboard
  (`NHDW_Firefox_v1.0.0/css/panelRenderers.css`), injected page UI on
  third-party sites (`css/content.css`). Everything holds in dark and light.
- **Delivery format:** local files only (SVG/WebP/PNG/CSS under
  `NHDW_Extension_v3.0.0/assets/` or existing stylesheets). No remote URLs,
  fonts, CDNs, JS animation libraries, videos, or GIFs.
- **Accessibility floor:** visible keyboard focus, no hover-only cues,
  `prefers-reduced-motion` honored, AA text contrast, 44px-class touch
  targets on the phone drawer.
- **Prohibited inputs:** no third-party fetch, copyrighted site logo,
  sexually explicit illustration, watermark, embedded text, or copied gallery
  artwork. Do not include original page captures or unsanitized gallery
  metadata in model prompts.

## Family 2: quiet panel backdrop (background)

- **Where it lands:** popup background behind the Download/Bookmark/Settings
  columns (`index.html`, `css/style.css`), the Firefox drawer, optionally the
  options page (`options.html`). Never behind dense controls like the listing
  bar's format row.
- **Direction — native, not stiff (owner note 2026-09-26):** near-flat with
  an *extremely* quiet accent — a 2–4% opacity ghost-wing watermark anchored
  in one corner (derived from the chosen sigil), or a 2–3% vertical tint
  shift from the top-chrome color. It should read as "the extension has a
  body", never as art. Token colors only (`#202a34` family via `color-mix`
  tints; no new hues).
- **Constraint check:** AA text contrast measured over every region in
  dark/light (not eyeballed); no texture behind buttons, inputs, or the
  Bookmark list; tiles/scales cleanly 360→500px+; collapses to flat color
  under OS forced-colors.
- **Budget:** a pure-CSS gradient is preferred (zero bytes); ONE SVG ≤ 20 KB
  only if CSS demonstrably can't do it. No WebP round trip.
- **Acceptance:** legibility unchanged vs. flat (side by side 500px/360px);
  if the effect is obvious at arm's length it is too loud; never reads as
  interactive.

## Family 3: popup tabs (Download / Bookmark / Settings)

- **Where they live:** `index.html` — `#tabDownload`, `#tabQueue`, `#tabSettings`
  (`.popupTabs`/`.popupTab`, `css/style.css`); shared with the Firefox drawer
  via `panelRenderers.css`.
- **Direction — the seated browser tab (owner note: "look like browser tab
  on chromium or others", not a stiff button row):** the active tab **fuses
  with the pane below** — same background as the content area, rounded TOP
  corners (~8px), square bottom corners, strip bottom-aligned, so tab and
  content read as one surface. Inactive tabs lose their fill: quiet text on
  the strip, inset hover wash. Divider hairline between tabs **vanishes next
  to the active tab**; active tab may carry a `#e31b53` top hairline
  (Firefox's `--tab-line-color` convention) for identity. Reference
  implementations to study (not copy): the KiroCrew side-panel tab-strip PR
  (active chip fusing with the body, transparent-not-zero-width bottom
  border, hairline surviving equal-token themes) and classic Chrome-like tab
  CSS (rounded-top fused seam). Optional 16px glyphs from ONE icon system;
  the count badge sits on Bookmark via `.nhdwBmCounts`.
- **Constraint check:** labels stay real text; focus ring survives
  (`:focus-visible`, never removed); no layout shift on tab switch; full-
  height touch hit area; identical treatment in `panelRenderers.css`.
- **Acceptance:** current tab obviously "seated" at a glance in both themes;
  strip reads as browser chrome, not web-page buttons; glyphs (if any)
  recognizable at 16px with text-only fallback.

## Family 4: buttons and microinteractions

- **Where they live:** popup CTAs (`.nhdwBmPrimary`, `.nhdwBmDownload`,
  `.nhdwBmRemove`, `.nhdwBmDanger`); options page (`Save & verify`,
  `Remove key`, `Clear history`); listing cards (`.nhdw-card-controls`);
  floating bar (`.nhdw-action-bar`: Select all, Download, Harvest / Stop,
  format toggles ZIP/CBZ/PDF/Raw); **Save offline**; **Download range now**.
- **Direction — native tonal buttons (flat + one hover step):** 6–8px
  radius, flat fills, hover = quiet ~6–8% `color-mix` wash, pressed = one
  step darker (no squish transforms), focus = 2px `:focus-visible` outline
  with 2px offset. Pink `#e31b53` reserved for the ONE primary action per
  surface; the rest are neutral surface-2 fills. No gradients, no heavy
  shadows — the Chromium/Firefox look.
- **State matrix per button family:** default, hover (desktop), focus
  (keyboard-visible), pressed, disabled (muted, never confused with the
  inactive-icon grey), busy (opacity pulse or CSS dot-spin; label kept). The
  **Harvest → Stop harvest** morph stays CSS-only and instant.
- **Hard rules:** transitions 120–200 ms ease-out on shared motion tokens;
  `prefers-reduced-motion` collapses all of it; nothing hover-only; no
  animation may delay or double-trigger a download.
- **Acceptance:** every state distinguishable in both themes; responsive on
  the 360px drawer without motion; no repaint jank over third-party pages.

## Family 5: injected page UI (floating bar + card controls)

- **Where it lives:** `css/content.css` — `.nhdw-card`, `.nhdw-card-controls`,
  `.nhdw-controls-on`, `.nhdw-action-bar`, rendered **inside six other
  people's websites**.
- **Scope:** bar container (radius, shadow, opacity), card control strip,
  selected-card treatment, counters, "Scroll for me", Ready/status styling —
  aligned to the new tokens and, subtly, the sigil geometry language.
- **Hard rules:** containment first per the Dark Reader method — specificity
  and resets stay as-is, only values change; bar stays dismissible, never
  covers site navigation; z-index/fixed positioning untouched.
- **Acceptance:** same-scroll before/after screenshots on a dense listing page
  and a gallery page; contrast on light and dark hosts; no measurable host
  reflow on mount.

## Family 6: status and feedback ("others")

- **Where they live:** `.nhdwBmStatusBadge-done/-downloading/-failed`,
  `.nhdwBmEmpty`, `.nhdwBmError`, `.nhdwBmNotice`, `.nhdwBmDrag`,
  `.nhdwModal` / `.nhdwModalOverlay`, options-page verify feedback.
- **Direction — the "little bit of style" layer (owner note: every other
  function gets a light, even treatment, never a redesign):** badges become
  small rounded chips (10px radius, 1px tinted border, shape + color so the
  three states separate without color-alone); toasts/notes reuse the same
  chip language; the modal gets a 40% dim, 8px radius, soft single shadow
  and family-4 buttons; scrollbars slim down via `::-webkit-scrollbar` only
  (no JS); focus/hover states come from the shared tokens, not per-surface
  invention. Empty-state slot stays (small local SVG, sigil-geometry resting
  wing).
- **Acceptance:** three badge states separable by shape or icon in both
  themes; empty state clean at 360px and 500px; modal focus trap and Escape
  keep working (style only, no behavior change); the added CSS honors the
  style budget below.

## Style budget (owner constraint 2026-09-26 — style must stay light enough
to read, never a context-flood)

One new file, `css/theme.css` (linked from `index.html` and `options.html`),
holds the whole layer so diffs stay localized and reviewable: ≤ 15 custom
properties (surface/surface-2, accent, accent-wash, border, radii sm/md,
3 motion timings, focus ring) and the small shared primitives (chip, tonal
button, seated-tab strip). Existing stylesheets get **value swaps only** —
no whole-file rewrites, no duplicated rules, no new selectors when a token
covers it. If a restyle needs more than ~40 new lines for one surface, it is
over-dressed: cut it back. This budget is the reason families 2–6 read as
"just enough" instead of a redesign.

## Inspiration queue (look later, before implementing each family)

Owner note: inspiration gathering for families 2–6 is deliberately queued,
not done now — consult when the family enters its build week:

- Chromium/Chrome tab geometry + seated-tab seam behavior (Chrome-like tab
  CSS discussions; the KiroCrew PR #6491 tab-strip write-up).
- Firefox Proton tab strip: `--tab-line-color` active accent convention
  (userChrome.css community).
- uBlock dashboard density (`gorhill/uBlock`) and Dark Reader containment
  (`darkreader/darkreader`) — already in the reference pool.
- MDN `color-scheme` / system-color notes for native form-control theming
  with near-zero code.
- Fluent/Proton screenshots for tonal-button state steps (hover/pressed
  deltas only — not their full token systems, which violate the budget).

## One-shot build order (single cycle)

Order inside the cycle — dependencies only, all six ship together:

1. **Tokens first** — draft the CSS custom properties (colors, shadows,
   motion timing) as the single source every family consumes.
2. **Logo system** — master mark, grey, six sigils; export 16–128px sets.
3. **Buttons** — state matrix as reusable classes (everything else composes
   from these).
4. **Tabs** — built on tokens + button states.
5. **Backdrop** — ghost wing pattern off the final sigil geometry.
6. **Injected bar + cards** — containment-checked application of the same
   system on dummy host pages.
7. **Status/feedback** — badges, empty state, modal, completing the system.
8. **Assemble the specimen page** (below) and hand it to the owner.

## The one-shot specimen page

Keep concept work under `NHDW_Extension_v3.0.0/Preview/logo-lab/` (excluded
from the `package:chrome` ZIP; never a second extension folder; never
overwrite `Icon.png`/`Icon-grey.png` before approval). The previous cycle's
convention of a self-contained page with state URLs
(`?concept=a&theme=dark&state=active`) worked — this page keeps that format
and extends it: `?site=nhentai|hentaifox|imhentai|hentaiera|hentaienvy|hitomi`
selects the sigil shown everywhere on the page.

One page, three sections:

1. **Sigil wall** — classic, master+grey, and all six sigils at real
   16/32/48/96/128px on dark and light toolbar strips; per-site switch via
   `?site=`; downloadable masters/PNG sets.
2. **Full popup specimen** — 500px desktop panel and 360px phone drawer with
   tabs restyled, backdrop in place, every button in every state
   (default/hover/focus/pressed/disabled/busy), the live Harvest→Stop morph,
   badges, empty state and modal rendered; keyboard-operable with a
   reduced-motion toggle to prove it's CSS-only.
3. **Injected UI specimen** — floating bar + listing cards over dummy
   light and dark host-page backgrounds at the same scroll position.

Same standing rules: dummy gallery labels only, no external
images/fonts/CDNs, no copyrighted site logos or adult imagery, usable
offline, reviewed at native size. A shareable preview URL is a bonus, not a
requirement — and per the 2026-09-26 incident: a Cloudflare quick-tunnel URL
(`*.trycloudflare.com`) dies with its session, while the Arena
(`*.arena.site`) link persists; publish the persistent one and note both in
the handoff.

## Integration checklist after selection

1. Save chosen masters and exports as local, reasonably small files. Verify
   icon transparency, visual contrast and license/provenance before replacing
   any existing asset. Keep a way to revert to `Icon.png`/`Icon-grey.png`;
   the legacy files move to `Preview/` as the "classic" variant, never
   deleted.
2. Wire only actual runtime paths. Keep a single source of truth: Chrome tree
   and generated `dist/` ZIP, Firefox tree with its audited mobile delta. A
   new runtime asset under `assets/` is included by `scripts/package-chrome.js`
   but must still be explicitly referenced by the UI/manifest if used.
   Manifest icons map ONLY to the approved master + grey; sigils wire to
   Settings/per-site decoration; per-tab `setIcon` swapping is a separate
   approved change.
3. Check dark/light, 16px browser toolbar, 500px popup/side panel and Firefox
   Android 360px. Do not claim a real-device pass from static screenshots.
4. Run `npm run build`, `npm test`, `npm run test:smoke`, `npm run test:e2e`,
   `npm run package:chrome` in the Chrome tree; repeat Firefox checks when
   Firefox files change. Check that ZIPs contain only runtime files.
5. Do not edit `.github/workflows/**` from an agent session; stage any
   trigger-path change in `ci/pending-workflows/` and tell the owner to apply
   it manually (see `ci/README.md`).
