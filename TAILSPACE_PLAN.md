# Tailspace — the current focus

DoujinDesu and Sasangeyou are on hold (see the likelihood table in
[EXTENSION_PARSER_RESEARCH.md](EXTENSION_PARSER_RESEARCH.md#6-how-likely-is-each-site-now)).
Tailspace is the site this build is aimed at.

**Status (2026-11-25):** a dedicated reader is built and tested offline in both
trees (Chromium and Firefox). It reads the site's own page data instead of the
rendered reader. It is **still unverified against the live site**, because the
sandbox cannot reach `tailspace.com`. Section *One live check* below is what remains.

## What changed since 2026-10-31

The 2026-10-31 note "no extension exists in `keiyoushi/extensions-source`" was
true then. It stopped being true the next day:

| Source | What it is | Licence | How it is used here |
| --- | --- | --- | --- |
| [keiyoushi/extensions-source `src/en/tailspace`](https://github.com/keiyoushi/extensions-source/tree/main/src/en/tailspace) | Mihon/Tachiyomi plugin (Kotlin, Android). PR #19941, merged 2026-11-01, 472 lines. The maintainer asked for changes, then approved. The author says it was AI-assisted and manually reviewed and tested. | Apache-2.0 | Facts re-implemented in TypeScript, credited in `THIRD_PARTY_NOTICES` and in `src/utils/routeData.ts`. No code copied. |
| [cofob/memesave-bot `scraper/src_tailspace.go`](https://github.com/cofob/memesave-bot) | Independent Go scraper (pushed 2026-11-12). | none stated | Facts only, as a second witness. No code used. |

The plugin cannot be "used" directly. It is Kotlin compiled into an Android APK
for the Mihon app, using that app's own HTTP stack, so a browser extension
cannot load it. What carries over is what it documents about the site.

Both sources agree on:

| Fact | Consequence |
| --- | --- |
| The site is React Router 7. Every page's data is at `<path>.data`; the comic is at `/c/<name>.data?_routes=routes/pages/comic/ComicPage` | one request per comic gives the complete, ordered page list. There is no scrolling, lazy loading or DOM guessing |
| `comic.pages[]` = `{token, pageNumber, fileType?}`; the image is `https://pics.tailspace.com/comics/<comic id>/<token>.<fileType, else jpg>` | full-size files by construction, so `-mini` thumbnails never come into play |
| `comic.numberOfPages` | the site's own total, cross-checked in the review |
| `comic.previousComic` / `nextComic` `{slug}` | a "title" is a chain of comics; every part is reachable from any part |
| Old comics (from the site's yiffer.xyz past) have no `fileType` | default to `.jpg` |
| Both send `Referer: https://tailspace.com/` for images | probably needed; see below |
| Keiyoushi throttles to 5 requests/second | this tool is slower anyway: one request at a time with pauses |

This also resolves two old unknowns. `/c/<name>?page=N` is a **reader
position inside one comic**, not a list page and not a chapter number. A
"7-page title" is one comic with 7 images. A multi-part story is a chain of
comics.

## What the build now does

Code: `src/utils/routeData.ts` (a general React Router `.data` decoder plus the
Tailspace recipe), `src/content/universalChapterProbe.ts`,
`src/chapters/chapters.ts`. Full description:
[UNIVERSAL_CHAPTER_TOOL.md](UNIVERSAL_CHAPTER_TOOL.md#react-router-sites-page-data-at-pathdata-tailspace).

1. **Scan from any part.** Open any comic, open Chapters ↗, press *Scan / add
   title page*. The tool walks `previousComic`/`nextComic` in both directions and
   lists every part oldest first (order preset, still changeable). It makes one
   `.data` request per part, with pauses, capped at 200 and loop-safe.
2. **Inspect without a second request.** The decoded data is reused. The
   review says the pages were read from the site's own page data, and flags a
   part whose listed pages disagree with its stated total.
3. **Approve `pics.tailspace.com` once, save.** It saves one CBZ per part with
   the pages in `pageNumber` order. The existing resume, partial-archive naming,
   128 px gate and image-signature checks all still apply.
4. **Fallback.** If the data request fails or the site changes shape, the normal
   reader paths run exactly as before (selector, scroll sweep, suffix rule,
   remembered settings). All the October work is still there.

## One live check (owner, ~5 minutes)

1. Load the unpacked build. Open `https://tailspace.com/c/Scale%20Train` (or any
   multi-part comic) and press *Chapters ↗*.
2. Press **Scan / add title page**. Expected: every part is listed, oldest first,
   with the status "Read N linked part(s) of this series from the site's own
   page data (oldest first)". If it says "Collected 0 candidate(s)" instead, the `.data` request was refused. Send me
   the log from **Run benchmark and save log**.
3. Select the parts, **Inspect**, approve `pics.tailspace.com`, **Download**.
4. If pages fail, tick **Send this site's address (origin only) as the referrer
   when fetching page images** in step 02 and try again. The tool suggests this after a Tailspace
   scan but never ticks it for you. If it still fails, the log will show a
   CORS refusal. That would mean the image server does not allow extension
   reads, and that is a real "not supported" without a header rule (a
   separate owner decision, not taken).

## Still unknown

- **Content-Type and access of `.data` for a browser extension.** React Router
  serves `text/x-script`. The probe accepts the body as text from the same
  origin, but a bot challenge or Cloudflare page would make it fall back.
- **CORS on `pics.tailspace.com`.** Neither reference project runs in a
  browser, so neither ever meets CORS. This is the one thing they cannot tell us.
- **The referrer requirement.** Both send it. Whether the server enforces it is
  unknown.
- **Whether the data shape changes.** The site was renamed recently. Any drift
  makes the recipe give nothing (never wrong pages), and the reader fallback
  takes over.

## Deliberately not part of this

No mirror/shortener handling, no premium or logged-in material, no bypasses, no
forged headers, no automatic referrer, and no guessed URL patterns (no
automatic `-mini` stripping, no synthesised page numbers). Page order comes
from the site's own `pageNumber`; part order comes from the site's own
previous/next links.

## How this was found (repeatable for the next site)

`node tools/find-site-references.js tailspace.com` runs two GitHub code searches
through the signed-in `gh` CLI. It labels each hit as reusable with attribution
(Apache/MIT/Unlicense) or facts only (GPL, or no licence). On 2026-11-25 it
returned the Keiyoushi source and the memesave-bot scraper. Run it before
asking for a manual capture. See
[UNIVERSAL_CHAPTER_TOOL.md](UNIVERSAL_CHAPTER_TOOL.md#react-router-sites-page-data-at-pathdata-tailspace).
