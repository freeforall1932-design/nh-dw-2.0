# Tailspace — the current focus

DoujinDesu and Sasangeyou are on hold (see the likelihood table in
[EXTENSION_PARSER_RESEARCH.md](EXTENSION_PARSER_RESEARCH.md#6-how-likely-is-each-site-now)).
Tailspace is the site this build is aimed at.

**Status (2026-11-25, Chromium 3.15.0 / Firefox 1.8.0):** Tailspace is a
**built-in site**, like nhentai, Hitomi, IMHentai, HentaiEnvy and HentaiFox.
Open a comic, open the panel, press **Download**: you get a CBZ (or whatever
format is chosen). Errors show in the panel in words. It is tested offline in
both trees but **still unverified against the live site**, because the sandbox
cannot reach `tailspace.com`. Section *Live check* below is what remains.

The earlier route (Chapters ↗ → Scan → Inspect → approve → Download) still
works and is now the fallback.

## Using it (built-in site)

| Where | What happens |
| --- | --- |
| **A comic page** (`tailspace.com/c/<name>`, with or without `?page=N`) | The panel reads the comic's own page data (one request) and shows the usual Download view: title, page count, file name, format, Download, Bookmark. A part whose listed pages disagree with the site's stated total gets a warning line above the button. |
| **Series column** (right side, replaces nhentai's "similar") | **Find all parts** walks the comic's previous/next links in both directions (one request per part, 300 ms apart, max 200, loop-safe), lists every part oldest first, marks the open one, and leaves already-downloaded parts unticked. **Download selected** sends the ticked parts as one batch: one file per part, oldest first. |
| **Any other Tailspace page** (browse, search, home) | The panel says to open a comic. There is no listing mode, because no card markup has been sampled. |
| **Queue tab paste box** | Accepts `https://tailspace.com/c/<name>` links and `tailspace:<name>` keys. **Add** bookmarks them and fills in title, cover and page count straight from the site; no tab is needed. **Download now** sends one job per site. |
| **Bookmark button / filter** | The panel's Bookmark button works; the per-site filter has a Tailspace entry. There is no on-page bookmark button (Tailspace is panel-only, see `TITLE_BOOKMARK_PANEL_ONLY`). |
| **History** | Keys are `tailspace:<encoded name>`, e.g. `tailspace:Scale%20Train`, so a re-download is recognised and never collides with another site's numbers. |

**Ids.** Tailspace addresses comics by name, not number. The extension's id is
the name as one encoded URL segment (`Scale%20Train`), canonical (one name, one
id), and never contains `:` or spaces. The numeric comic id from the data is
only used for image addresses. Code: `src/utils/tailspaceIds.ts`.

**Images.** `https://pics.tailspace.com/comics/<comic id>/<token>.<type>`, full
size by construction (the `-mini` thumbnails in the page markup are never
used). In an open Tailspace tab the image is read through the tab first;
otherwise, or when the tab read is refused, the extension fetches it itself.
For **this extension's own requests to `pics.tailspace.com` only**, a session
header rule sets `Referer: https://tailspace.com/` (no Origin). That is what
the site's own reader sends and what both reference projects send. The user's
own browsing is never touched. This is the same mechanism the approved Hitomi
fix uses (`src/background/siteHeaderRules.ts`, rule ids 48100+).

**Permissions.** Exactly `https://tailspace.com/*` and
`https://pics.tailspace.com/*`, no wildcard. Firefox asks for them in the
popup's host-grant notice, and only when the active tab is on tailspace.com.

**When something fails** (each case is tested):

| What you see | Meaning |
| --- | --- |
| *Could not read this comic from Tailspace. Tailspace has no comic at this address (HTTP 404).* | Wrong or deleted comic. |
| *... the site says this comic does not exist.* | The data answered, but with no comic. |
| *... refused the request (HTTP 403)* / *is limiting requests right now (HTTP 429)* | Blocked or rate-limited; wait, reload the comic, try again. |
| *... the site answered with a web page that carries no comic data (a login, error or challenge page?)* | Log in or pass the check in the tab, then reopen the panel. |
| *... the page data has no comic in it (the site may have changed)* / *a page entry ... was not in the expected form* | The site changed shape. This message is what to report. |
| *Failed to fetch original image ... (403 ...). Tailspace refused the page images. Open the comic on tailspace.com in a tab ...* | Image server refused. Press Download from the comic's own tab. |
| *The linked part "..." could not be read (HTTP 503 ...). The list below may be incomplete.* | Series walk stopped at that part; the parts found so far are still listed. |
| A failed part in a batch | Appears in the batch summary with its reason and a Retry button, like any other site. |

## Live check (owner, ~5 minutes)

1. Reload the unpacked build (Chromium 3.15.0 or Firefox 1.8.0). On Firefox,
   open the popup on a Tailspace tab and accept the host grant if asked.
2. Open a multi-part comic, e.g. `https://tailspace.com/c/Scale%20Train`, and
   open the panel. Expected: the Download view with the right title and page
   count, and a **Series** column with **Find all parts**.
3. Press **Download**. Expected: a CBZ with every page, in order, full size.
4. Press **Find all parts**, then **Download selected**. Expected: one file per
   part.
5. If anything fails, the panel says why. Send me that text (and, for a
   download failure, the batch summary line). The likeliest real-site
   surprises are listed under *Still unknown*.

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

## The Chapters ↗ route (still available, now the fallback)

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

## Chapters ↗ live check (only if the built-in route fails)

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
- **The referrer requirement.** Both send it, and the built-in site now sends
  it too (header rule). Whether the server enforces it is unknown.
- **Comics behind a login.** Page data is fetched without cookies, like the
  reference projects do. A comic that needs a login would show the
  "web page that carries no comic data" message. Not observed yet.
- **Whether the data shape changes.** The site was renamed recently. Any drift
  makes the recipe give nothing (never wrong pages), and the reader fallback
  takes over.

## Deliberately not part of this

No mirror/shortener handling, no premium or logged-in material, no bypasses,
and no guessed URL patterns (no
automatic `-mini` stripping, no synthesised page numbers). Page order comes
from the site's own `pageNumber`; part order comes from the site's own
previous/next links.

The one header the built-in site sets is the image Referer described above,
for the extension's own requests to `pics.tailspace.com` only. The Chapters ↗
route still never sets a referrer on its own (its opt-in checkbox stays
unticked unless you tick it).

## How this was found (repeatable for the next site)

`node tools/find-site-references.js tailspace.com` runs two GitHub code searches
through the signed-in `gh` CLI. It labels each hit as reusable with attribution
(Apache/MIT/Unlicense) or facts only (GPL, or no licence). On 2026-11-25 it
returned the Keiyoushi source and the memesave-bot scraper. Run it before
asking for a manual capture. See
[UNIVERSAL_CHAPTER_TOOL.md](UNIVERSAL_CHAPTER_TOOL.md#react-router-sites-page-data-at-pathdata-tailspace).
