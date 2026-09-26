# Design reference — technique, sources, and the logo workflow

**Purpose:** preserve the method that produced the approved-direction icon
concepts (2026-09-26 logo-lab round) so every future asset round reaches the
same "this is it" bar instead of generic streamline icons. Companion to
`ASSET_PLAN.md` (scope + acceptance); this file is *how to think and where to
look*. Owner note: the AI-generated 3-icon NH blackwing set met the bar —
keep this workflow as the house style for making marks.

## Where to look (borrow technique, never assets)

Copying any mark from these into our icons is forbidden (transformative rule
in `ASSET_PLAN.md`); study their *methods*.

| Source | URL | What to take from it |
|---|---|---|
| edent/SuperTinyIcons | <https://github.com/edent/SuperTinyIcons> | The discipline that keeps marks readable at favicon size: 512 viewbox, documented safe zone (`rx="50%"` circle check — main body in the green zone), 0-decimal path precision, solid colors only, hand minification via SVGO/svgcleaner. Average file under ~534 bytes and still instantly recognizable — the exact anti-generic bar for the site sigils. |
| simple-icons/simple-icons | <https://github.com/simple-icons/simple-icons> | How far a brand silhouette can be reduced — ONE color, ONE path — while staying identifiable. Use when a sigil feels over-detailed: keep deleting until recognition almost breaks, then stop one step earlier. |
| gilbarbara/logos | <https://github.com/gilbarbara/logos> | Curve quality and optical correction in pro-grade SVG masters. Geometry reference only: straight lines that *look* straight, balanced counters, optically centered arrows. |
| lucide · phosphor · tabler | <https://lucide.dev> · <https://phosphoricons.com> · <https://tabler.io/icons> | Consistent stroke systems for functional glyphs (tab icons, button icons). Pick ONE system per product surface; never mix stroke weights. These are for UI glyphs, NOT for the identity marks — identity is always custom. |
| svg/svgo | <https://github.com/svg/svgo> | The export pipeline for every final vector; run it, then re-check at 16px because aggressive precision trimming can mush small shapes. |
| gorhill/uBlock | <https://github.com/gorhill/uBlock> | Dense popup/panel information design inside a fixed extension width: hierarchy, zero wasted pixels, functional austerity. |
| darkreader/darkreader | <https://github.com/darkreader/darkreader> | The gold standard for CSS that must survive inside hostile third-party pages (our floating bar + card controls): hard containment, defensive specificity, no global resets leaking either direction. |
| RealFaviconGenerator | <https://realfavicongenerator.net> | The transparent-margin/safe-zone checklist for 16px toolbar legibility; run the mental checklist before exporting any PNG set. |

## UI styling (non-identity) — native, light, readable

Different game from the marks: panel CSS must feel like browser chrome, not
a poster. Pool added 2026-09-26: seated browser-tab pattern (active tab
fuses with the pane — rounded top, shared background, divider hairline
vanishing beside it; see the KiroCrew side-panel tab-strip write-up and
classic Chrome-like tab CSS), Firefox Proton's `--tab-line-color` active
accent, MDN `color-scheme`/system colors for near-free native form theming,
and uBlock/Dark Reader (already catalogued) for density and containment.
**Style budget law (owner constraint):** one `css/theme.css` with ≤ 15
custom properties + small primitives; existing files get value swaps only;
any surface restyle beyond ~40 lines is over-dressed — cut back. Light
enough to review in one screen: that is the point.

## The logo workflow that worked (house method)

Round 1 produced three concepts the owner called satisfactory on first
delivery. This is the recipe, in order — do not skip steps:

1. **Read the legacy artifact like an artifact.** Before drawing, name what
   every existing shape *means*. For the legacy `Icon.png`: the horned,
   winged demon = the site the extension was born on (nhentai); the downward
   arrow = the job it does (download). Two ideas welded into one silhouette.
2. **Extract the DNA, keep it, mutate around it.** The new system is the
   same weld — identity + function in one mark — extended per site. One
   master geometry (wings + arrow); each site gets exactly ONE signature
   mutation + ONE accent color (table in `ASSET_PLAN.md` family 1). First
   approved direction: nhentai = **black demon wings + red down-arrow**.
3. **Constraints are the style.** Solid colors, no gradients, no text, no
   extra ornament; if the mutation dies at 16px it was too small — enlarge or
   simplify. The constraint list is what keeps the result from looking like
   clip-art.
4. **Concept rasters from OUR OWN reference only.** The generator's only
   image input was our legacy `Icon.png` — never gallery captures, never the
   sites' real logos, never someone else's icon set. Three quick rasters
   (active A, active B, inactive grey), reviewed as images, not vectors.
5. **Owner review at real size.** Judge at 16px and 128px, active + grey,
   dark + light toolbar. This round: all three passed; A vs B kept open for a
   live toolbar tryout (Settings → Toolbar icon select; default stays
   classic). **v5/v7 law (owner notes, v6 correction folded in):** review
   ALSO happens composited on `#202a34` **and** `#f5f5f5`. Every raster
   entering `assets/icons/` is background-free (corner-seeded floodfill
   only), and the interior **keeps the original painted coloring —
   intentional white/pale detail stays** (fox-tail inner, wing-bone
   lattice, mimic feathers, hitomi eye-ring); only trapped background
   blocks (enclosed white regions disconnected from the canvas edge, e.g.
   the crow's mist block) get keyed, and only from the **uncompressed
   white-background originals** in `site-sigils/`. v6 lesson, now law:
   never re-key the compressed runtime copies in place — double-processing
   invented tint artifacts and ate the owner's tail/bone detail; and when
   the owner says "except X", X is kept, not removed. Pre-edit states live
   in `Preview/logo-lab/alt-states/` (v5 compressed-preserved + v6
   whites-keyed). A visible white/black box around the mark = fail; one
   specific interior white the owner names = key that patch from the
   original, never blanket-key. **v8 owner corrections, folded in:** horn
   law is enforced on the renders, not just on paper (plain hitomi carried
   NH's horns — rendered horns are pipeline bugs, removed surgically at the
   uncompressed source; twins must be structurally identical except the
   stated delta), and the shared grey inactive must sit in the classic
   inactive band (`#686868`…`#ABABAB`) — a bright silver "grey" reads as an
   active icon on the dark panel. **v9 owner notes, folded in:** the halo is
   an angel's ring — gold/yellow, and its middle is see-through, never a
   white pill (white pills read as white space); a de-horn leaves the head
   ROUND (erase spikes, never leave a flat-top); grey-inactive iterations
   keep their fallbacks in `alt-states/` — the owner picks which iteration
   wins; and the balloon law for experimentals: bucket-fill INSIDE the skin
   only — skin line and the red arrow are sacred (flood-fill fuzz eats red
   at ≥ ~40%, 21% is the proven setting). **v10 owner notes:** the shared
   inactive grey is the **a3 desaturation** (natural luminance, not the
   silver render, not the band retone); and when a fill eats the rim, draw
   the line back like a subtitle stroke — erode the alpha mask, rim =
   mask − erosion, paint black into the rim (disk 12 at 1024 ≈ 1.5px at
   128). **v12 law — the eye is the state marker:** on the crow master the
   eye pixel glows arrow-red when the tab is a supported site and
   balloon-blue when it is not; an inactive eye never goes plain grey — the
   state must stay readable, so only the body desaturates.
5b. **Pixel-art marks (the crow master, owner concept):** chunky visible
   blocks, silhouette-first, no anti-aliased curves; dissolves/mist read as
   scattered shrinking squares thinning downward. The crow's one-sentence
   philosophy: *"no single site owns this creature — it turns to mist and
   crosses between all six."* Stability posture while deciding: `classic`
   stays the shipping default and permanent fallback; a new master replaces
   it only after vectorization + changelog, never silently.
6. **Hand-vectorize only the approved concept.** Redraw as a true flat SVG
   master (Inkscape/Illustrator or hand-authored paths), SVGO it, run the
   safe-zone circle check, export transparent PNG 16/32/48/96/128. Raster
   concepts never ship as final icons (the tryout copies under
   `assets/icons/` are 128px alpha-real rasters — still concepts pending
   the approved vector remake).

## The satisfactory bar (and what to do when a round misses)

A mark passes only when it is **unique, creative, and carrying a philosophy
that can be said out loud in one sentence** (ours: "the demon's wings are
where it came from; the arrow is what it does"). Generic streamline icons —
the default icon-font look, soulless rounded arrows — fail by definition.

**2026-09-26 owner correction, now law:** I broke this myself in the first
family pass. To unify the mirror trio I flattened a structural mutation
(HentaiEra's chalice-arrow) into a plain arrow and called the recolored
siblings "consistent" — recolor-only sameness is exactly the corporate-slop
failure mode. Rules derived from the correction:

1. **Recolor ≠ mutation.** Sibling sigils may share geometry ONLY when the
   shared part is the site's shared story (the trio's underline filename
   quirk); each sibling still needs its own structural mutation. If two
   sigils differ only by accent, one of them is not designed yet.
2. **Detail floor: the grey inactive icon.** Its layered-membrane wing
   detail is the minimum richness for ACTIVE marks, not the exception.
   Streamlining active marks below the inactive one's detail is backwards.
3. **"You think it's good" is not QA.** A generator's self-review doesn't
   count — every mutation must pass the owner at review size AND at 16px,
   with its one-sentence difference from its siblings said out loud.
4. **Owner-origin concepts on record:** the diving-fox arrow (fox parts live
   ON the arrow — ears at the arrowhead shoulders, tail streaming from the
   shaft top, white tail tips) and its heart-shaped twin-tail variant, and
   the restored HentaiEra chalice, came from the owner's direction. When the
   owner sees a first-pass mutation and names it "unique", keep it — do not
   "fix" it flat.

**2026-09-26 refinement pass 2 (owner direction, now law):**

1. **Detail has an address: the WINGS.** Wing detail (layered membrane,
   grey-icon style) is preserved; the demon HEAD stays as clean and simple
   as the original blackwing A. Texturing the head turned it into "an ugly
   demon" — richness migrates to the wings, never to the face.
2. **Wings are lineage, not uniform.** The wing mandate applies ONLY to the
   NH demon lineage. Other sites need their own language around the one
   shared DNA: the downward arrow. Family law updated — shared = the
   download arrow; per-site = its own world (wings optional, meaning first).
3. **Hitomi ascends (owner concept):** the pupil "O" becomes a HALO — the
   Hitomi sigil is an ANGEL: feathered wings, halo ring resting at the
   shaft, magenta. It is the demon's deliberate counterpoint: black demon
   vs. light angel. The eye-arrowhead version stays as a variant.
4. **ImHentai stops wearing NH's silhouette:** twin mirrored arrows
   descending onto ONE shared underscore platform — the byte-identical
   mirrors landing the same file; the trio's underline quirk preserved as
   the platform itself, not a floating notch.
5. **Anti-inbreeding rule (owner challenge: "is there no more
   inspiration?"):** a round that iterates only on our own legacy icon
   inbreeds. Every round MUST actively consult the reference table (and new
   sources when it runs dry) and NAME which technique was borrowed and from
   where: safe-zone circle check (SuperTinyIcons), single-color distillation
   (simple-icons), stroke consistency (the chosen glyph system), duotone
   layering (see next entry). No named borrow = the round isn't done.
6. **Expanded pool 2026-09-26:** <https://game-icons.net> (Delapouite, Skoll
   & friends — thousands of single-color fantasy silhouettes: demons, wings,
   angels, foxes, chalices — exactly our subject matter, drawn to survive
   one-color reduction; CC-BY, study the silhouettes, never ship the paths)
   and <https://github.com/iconaut-design/icons> ("one shape each, sharp at
   every size": one closed vector shape per mark, drawn natively at
   12/16/20/24px; duo = 25% fill + stroke — a concrete recipe for layered
   wings without noise), plus Feather Icons' 24px-grid discipline from the
   inspiration list <https://github.com/alptekinenes/inspiration-list>.

**2026-09-26 refinement pass 3 (owner direction, now law):**

1. **Additions are additions.** When the owner says "add X" (the halo), ADD
   it to the existing mark — never strip what already made the mark unique
   (Hitomi's chunky squared wings and eye-ring arrowhead). Substituting
   instead of adding is a regression even when the new thing is prettier.
   Surgical mutation over wholesale redesign.
2. **The horn signature — assigned randomness, not random sameness.** Demons
   must not share one horn silhouette. Horn count/placement/length is a
   variation axis ASSIGNED per site, deliberately: count (0/1/2), placement
   (center/side), length (tall/stubby). See the table in ASSET_PLAN.md.
   "Same with slight variation" earns a pass only when each result is
   independently good — consistency is a crutch, never the goal.
3. **The glyph-read test.** If a candidate reads as a common UI glyph
   (the twin arrows read as a recycle/trash icon — killed), it fails
   uniqueness no matter how clean it is. Say the wrong-read out loud before
   shipping a concept.
4. **Resolve the contradiction honestly:** the owner allows family
   consistency ONLY as a side effect of good marks, never as a substitute
   for them. When in doubt: make it good first, make it match later.



If a round misses the bar:

1. Say *why* it feels generic (silhouette common? idea count = 0? no tension
   between shapes?) and write that down before regenerating.
2. Go back to step 1 with the specific SITE, not the drawer: re-read what the
   site means to a user (mirrors, underline filenames, PNG-max-quality,
   fox…), and mutate from that story.
3. Explore sideways: same DNA, different weld (frame instead of overlay;
   negative space instead of solid; arrow interrupts the wing instead of
   sitting on it). Keep the constraint list untouched.
4. Stop when a concept produces the "this is it" reaction at 16px — not at
   full screen. Anything that only looks good big is not an icon.

## Preview hosting lesson (2026-09-26)

A `*.trycloudflare.com` quick-tunnel URL dies with its session (the
`harvest-combining-fingers-understanding` tunnel is already gone); the
Arena-published `*.arena.site` link persists. Publish previews to the
persistent host and record the URL in the session handoff.

## Where things live

- Tryout raster set (this round): `NHDW_Extension_v3.0.0/assets/icons/`
  (classic, classic-grey, sigil-nh-blackwing-a, sigil-nh-blackwing-b,
  sigil-nh-wings-grey-inactive) — consumed by the Settings tryout switcher.
- Concept masters + previews: `NHDW_Extension_v3.0.0/Preview/logo-lab/`
  (excluded from the packaged ZIP).
- Final approved assets: `assets/` wired per `ASSET_PLAN.md` integration
  checklist; manifest icons map only to the approved master + grey.
