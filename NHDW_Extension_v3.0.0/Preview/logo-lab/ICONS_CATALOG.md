# Icon assets catalog — logo-lab tryout set

**Purpose:** single place that says what is inside
`NHDW_Extension_v3.0.0/assets/icons/`. The owner may delete candidates later —
the deletion recipe is at the bottom. For design law see `ASSET_PLAN.md`
(repo root) and `DESIGN_REFERENCE.md`; for review sheets see
`Preview/logo-lab/sigil-wall-v12.png`. **This catalog lives in `Preview/`, not
inside `assets/icons/`,** because the runtime ZIP allowlist
(`test/package-chrome.test.js`, "Unexpected runtime file") rejects doc files
under `assets/` — keep runtime folders code-and-assets only.

## What's inside (22 files)

**2026-09-26 (v7): background-free AND interior coloring preserved.** Every
raster was re-derived from the uncompressed white-background 1024px renders
under `site-sigils/` (the v6 in-place re-key of the compressed copies was
the tint-artifact mistake the owner called out). Per file: corner-seeded
floodfill removes only the outer background; interior painted detail —
fox-tail inner white, wing-bone lattice, mimic feathers, hitomi eye-ring —
stays exactly as rendered. Only trapped background blocks (enclosed white
disconnected from the canvas edge, e.g. the crow's mist block) are keyed,
from the original via pure-white fuzz. Trim → 128px → QA composited on
`#202a34` **and** `#f5f5f5`. Pre-edit states are preserved on disk in
`Preview/logo-lab/alt-states/` (`v5-whites-preserved-from-compressed/`,
`v6-whites-keyed/`); the owner decides per detail which side wins.
Classic pair is legacy and untouched; the grey-inactive was re-toned to the classic band in v8 (below).
**Compare-by-rename:** alpha-real crow copies also ride beside the real
extension icon at the extension root (`Icon-crow-mist.png`,
`Icon-crow-mist-arrow.png`, next to `Icon.png`) and ship in the ZIP via
`scripts/package-chrome.js` `CORE` — rename one to `Icon.png` to compare
live, no rebuild.

| File | Switcher key (`toolbarIcon`) | Switcher label | Status |
|---|---|---|---|
| `classic.png` | `classic` (active) | Classic (pink + green) | Live; duplicate of root `Icon.png` kept here at owner request (unwired) |
| `classic-grey.png` | `classic` (inactive) | — | Live; duplicate of root `Icon-grey.png` (unwired) |
| `sigil-nh-wings-grey-inactive.png` | — (legacy alternate) | — | Kept, unwired (v10: replaced by a3-grey as the shared inactive) |
| `sigil-nh-blackwing-a.png` | `blackwing-a` | Blackwing A (demon + red arrow) | Live candidate |
| `sigil-nh-blackwing-a3.png` | `blackwing-a3` | Blackwing A3 (clean head + layered wings) | Live candidate — current NH favorite direction |
| `sigil-nh-blackwing-b.png` | `blackwing-b` | Blackwing B (wings + red arrow) | Live candidate |
| `sigil-hentaifox.png` | `hentaifox` | Sigil: HentaiFox (fox head + tail, orange) | Live candidate |
| `sigil-hentaifox-dive-heart.png` | `hentaifox-heart` | Sigil: HentaiFox dive (heart twin-tail) | Live candidate — owner concept |
| `sigil-hentaifox-dive-body.png` | `hentaifox-body` | Sigil: HentaiFox dive (single tail) | Live candidate |
| `sigil-hitomi.png` | `hitomi` | Sigil: Hitomi (eye arrow, chunky wings) | Live candidate |
| `sigil-hitomi-halo.png` | `hitomi-halo` | Sigil: Hitomi + halo (hornless) | Live candidate — owner-requested addition |
| `sigil-imhentai-mimic.png` | `imhentai` | Sigil: ImHentai mimic (bat + feather wings) | Live candidate |
| `sigil-hentaiera-chalice-c1.png` | `hentaiera` | Sigil: HentaiEra chalice (center horn) | Live candidate — protected (owner named it unique) |
| `sigil-hentaienvy-hunch-short.png` | `hentaienvy` | Sigil: HentaiEnvy hunch (stub horns) | Live candidate |
| `sigil-crow-mist.png` | `crow-mist` | Master: Crow (black mist, pixel) | Live candidate — owner concept: the creature no single site owns; pixel-art |
| `sigil-crow-mist-arrow.png` | `crow-mist-arrow` | Master: Crow + arrow (black mist) | Live candidate — crow mist regathering into the red download arrow |
| `sigil-nh-blackwing-a-balloon.png` | `blackwing-a-balloon` | Blackwing A balloon (blue inside, experimental) | Live candidate — owner sketch: black skin, blue water interior (v9) |
| `sigil-nh-blackwing-a3-grey.png` | shared inactive for every non-classic, non-crow theme (owner pick, v10) | — | Live; replaced the silver file in the wiring |
| `sigil-crow-mist-grey.png` | `crow-mist` (inactive twin) | — | Live; natural-luminance grey of the crow (v11) |
| `sigil-crow-mist-arrow-grey.png` | `crow-mist-arrow` (inactive twin) | — | Live; grey of the crow + arrow (v11) |
| `sigil-crow-mist-redeye.png` | `crow-mist-redeye` (active) | Master: Crow redeye (red=site, blue=other tab) | Live candidate — eye is the state marker (v12) |
| `sigil-crow-mist-redeye-grey.png` | `crow-mist-redeye` (inactive twin) | — | Live; grey body, **blue** eye = unsupported tab (v12) |

Sigil order: nhentai (black wings + red arrow — owner directive) → hentaifox
(the arrow IS the diving fox) → hitomi (chunky wings + eye + halo) →
imhentai (mismatched mimic wings) → hentaiera (chalice) → hentaienvy
(hunched). Horn signature table in `ASSET_PLAN.md` family 1.

## Killed drafts (do not re-add here)

Twin arrows (read as recycle glyph), A2 textured head ("ugly demon"), angel
Substitutions, early trio recolors, first-pass streamlined trio. Their
full-size rasters remain in `Preview/logo-lab/site-sigils/` as history —
this folder holds **only live switcher candidates**.

## Deleting a candidate later (3 touch points)

1. Remove its entry from `ICON_THEMES` in `src/background/background.ts`
   (keep `classic` and the shared grey entries).
2. Remove its row from `iconThemes` in `src/preview/popupSettings.ts`.
3. Delete the PNG here (and optionally its 1024px master in
   `Preview/logo-lab/site-sigils/`).

Then `npm run build`, `npm test`, `npm run test:smoke`,
`npm run package:chrome` in `NHDW_Extension_v3.0.0/`. Adding a candidate is
the same three steps in reverse (file at 128px PNG, key, row).

## Known tryout-only artifacts

Concept renders, not final icons: single 128px masters (final sets are
16/32/48/96/128), one shared grey inactive for all sigils (per-sigil grey
variants come after selection), no SVG masters yet (the winner is
hand-vectorized per `DESIGN_REFERENCE.md` step 6). Interior-preserving alpha (background
AND interior kept) is delivered since v7; the white-background caveat
applies only to the historical 1024px renders under
`Preview/logo-lab/site-sigils/`, not to this runtime folder. If a stored
choice's PNG is deleted, the worker and the settings preview both fall back
to the classic icon automatically.

## v8 corrections (owner note)

- **Hitomi de-horned.** The plain `sigil-hitomi` render carried two tall
  horns — NH's signature, violation of the horn law (hitomi is hornless).
  Surgically removed at the uncompressed source (`site-sigils/sigil-hitomi.png`,
  background-colored rectangle — the horns floated free in background space,
  zero contact with wings/head), then re-derived. The horned pre-edit render
  lives in `alt-states/site-sigils-originals/`, the runtime copy in
  `alt-states/v7-pre-horn-grey-fix/`. `sigil-hitomi-halo` was already
  hornless; plain and halo twins are now structurally identical except the
  halo.
- **Grey-inactive toned to the classic family.** The shared inactive read as
  bright silver/white on the dark panel. Re-toned to the classic
  `Icon-grey.png` band (`#686868` dark … `#ABABAB` light, luminance remap
  only, alpha untouched — no white-keying involved). Known source quirk: in
  the uncompressed `nh-wings-grey-inactive.png` original, the white arrow's
  tip merges into the canvas background, so background-flood re-derivation
  eats the arrow — the grey-inactive asset therefore derives from the
  approved v5-era raster; the vector remaster must draw the arrow
  explicitly.

## v9 corrections + additions (owner notes)

- **`sigil-hitomi` head rounded.** The v8 de-horn left a flat-top head —
  the crown is now a true round dome (black ellipse painted at the
  uncompressed source, magenta column strip preserved byte-exact). Still
  hornless, still no halo on the plain variant.
- **`sigil-hitomi-halo` halo is now an angel's gold ring.** The pink-rim/
  white-pill halo (its white interior read as white space) became a gold
  ring with a **transparent hole** — the panel shows through the middle.
  Eye-ring untouched (protected).
- **Grey inactive reverted to the previous (silver) iteration.** The v8
  band-compressed retone read "corrupted"; the approved silver file is back
  as the shared inactive.
- **NEW `sigil-nh-blackwing-a3-grey.png`** — an all-grey inactive variant
  built from blackwing-a3 by pure desaturation (natural luminance band, NO
  compression: dark body, light bone lattice, mid arrow). Staged as an
  alternative inactive for owner judgment; not wired to a theme's grey yet.
- **NEW `sigil-nh-blackwing-a-balloon.png`** (switcher key
  `blackwing-a-balloon`, experimental) — owner sketch: "like a balloon —
  the skin is black, the inside is blue like water". Blackwing-A's black
  interior bucket-filled with vivid blue (`#1c3cf0`), dark outer line and
  red arrow untouched, pale wing streaks kept as texture. (Pipeline note:
  flood fill per-channel mean distance — fuzz ≥ ~40% would eat the red
  arrow; 21% is the sweet spot.)

## v10 (owner notes)

- **`sigil-nh-blackwing-a3-grey.png` is now THE shared inactive grey.** The
  owner picked it over the silver iteration; every non-classic theme's
  `grey` in `src/background/background.ts` points at it now (classic keeps
  `/Icon-grey.png`). `sigil-nh-wings-grey-inactive.png` stays on disk as the
  legacy alternate — unwired, kept per the keep-iterations law.
- **Balloon got its subtitle lining.** The first flood had eaten the dark
  rim, so the black "skin" read nowhere. Fixed with a mask-erode outline:
  erode the alpha silhouette at the uncompressed source (disk 12 ≈ 1.5px at
  128), rim = mask − erosion, paint black into the rim — an even black
  outline around the whole shape (wings, horns, arrow tip, bg bays), like a
  subtitle stroke: blue fill, black line, red arrow untouched. Pre-lined
  copies preserved in `alt-states/v9-balloon-noline/` and
  `site-sigils-originals/sigil-nh-blackwing-a-balloon-noline.png`.

## v11 (owner notes)

- **Balloon inner lining:** the red arrow now carries its own black inner
  stroke wherever it meets the blue (same erode-rim recipe on the red
  region, Disk 12) — subtitle logic inside AND outside: blue fill, black
  lines, red arrow outlined. Pre-inner-line copies in
  `alt-states/v10-balloon-outerline/`.
- **NEW `sigil-crow-mist-grey.png` + `sigil-crow-mist-arrow-grey.png`** —
  grey twins for both crow master candidates (natural-luminance
  desaturation, mist dissolve alpha preserved). Wired: the two crow themes'
  `grey` in `background.ts` now point at their own twins instead of the
  shared a3 inactive (a master candidate rides like the classic pair —
  color + matching grey). Copy also at the extension root
  (`Icon-crow-mist-grey.png`, `Icon-crow-mist-arrow-grey.png`, package
  `CORE`) so the rename-compare flow covers the grey side too. Note: like
  the a3-grey body they sit dark on the dark panel — say the word if a lift
  is wanted.

## v12 (owner note)

- **NEW `crow-mist-redeye` pair — the eye is the state marker.** The plain
  (no-arrow) crow gained a variant whose pixel-art eye glows **arrow-red on
  supported sites** (`sigil-crow-mist-redeye.png`) and **balloon-blue on
  unsupported tabs** (`sigil-crow-mist-redeye-grey.png` — the body desatu-
  rates to the standard inactive grey, the eye stays blue, never greyed).
  Two-block pixel eye: bright cube + darker shade cube for depth (probed
  from the uncompressed render at x512–545/y255–290, z31 shadow at
  x545–575/y290–325). The original plain crow-mist pair is preserved
  untouched, so the family is three lines: `crow-mist`, `crow-mist-redeye`,
  `crow-mist-arrow` (+ three grey twins). Root compare copies added
  (`Icon-crow-mist-redeye.png`, `Icon-crow-mist-redeye-grey.png`, package
  `CORE`).
