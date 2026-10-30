# Archived effort — "use the site's own Download control"

**Status: dropped for nhentai only (owner decision, 2026-10-30).** The owner's
words: *for the dropped download button I only drop it for nh — for other
supported and in-progress sites, if it is hard, focus on the "on-site" downloader
by extracting the page itself.*

So there are two separate answers, and this file keeps them apart:

| Site | Route |
| --- | --- |
| **nhentai** | The API-key archive path, as already implemented. The site's own Download control is **not** pursued. |
| **Other supported / in-progress sites** (Sasangeyou, Tailspace, DoujinDesu, …) | **On-site page extraction**: read the chapter's page images from the site itself and build the archive locally. No clicking through mirror links or ad-link shorteners. |

## Part A — nhentai: what was dropped and why

What was proposed: find nhentai's own "Download" anchor, require an `https:` URL on
`nhentai.net`, and hand it to `chrome.downloads` with strict completion tracking
instead of using the API.

Why it was dropped:

- **It cannot be observed from here.** `https://nhentai.net/` renders gallery
  cards with no Download control in fetched content, and the old test gallery
  (`/g/177013/`) now returns 404. The uploaded "5 website page source" capture is a
  **hentaifox home page**, not a gallery or reader. Every claim about the
  control's markup, label or click flow is unconfirmed.
- **Text matching alone is unsafe.** These sites routinely carry "Download
  app"/"Download manager" ads; the project rule is to refuse ambiguous markup, not
  to guess.
- **The API path already covers the goal.** `GET /api/v2/galleries/{id}/download?format=`
  is implemented, gated and documented, and works once a real key is supplied. It
  stays the supported route and stays **off by default** until real delivery is
  verified.
- **The owner's live observation remains evidence, not verification.** Equal file
  size and byte-identical unpacked images are consistent with the API path using
  the same source, but they do not exercise delivery, CORS or the native click
  flow. Do not cite them as proof.

No code was written for the native-control idea; nothing is half-wired.

## Part B — other sites: the on-site extraction route

This is what the chapter tool already is, and what stays in scope:

1. **Title page → pseudo-batch.** Scan the title/list page for chapter links, tick
   the chapters you want, state the list's order. This is a pseudo-batch: one
   action produces one archive per chapter, without following the site's batch
   button into a `mirrored.to` directory or any shortener.
2. **Chapter page → page images.** For each chapter, read the page images from the
   reader (static HTML when the reader ships URLs in the HTML; the open page when
   the reader builds them with JavaScript).
3. **Local archive.** Ordered pages, signature and dimension checks, one CBZ/ZIP
   per chapter, optional `ComicInfo.xml`.

Explicitly **not** in this route: clicking a mirror/shortener chain, resolving
hosted-file pages, handling captchas or premium doors, or automating a file
host. The tool stops at "these are the images the site served" — and at "here is
the site's own download page" if a later helper ever goes that far.

### The numbering caveat (the one real weakness)

A pseudo-batch is only as good as the page order it can prove:

- **Clear numbering** — `?page=N` in the reader links, `data-page`, a caption
  ("page 7"), or numbered file names — can be ordered explicitly, and the tool
  says which strategy it used and whether that order differed from the reader's.
- **Jumbled or hashed names** (e.g. `a1B2c3D4e5F6g7H8-mini.jpg`, the Tailspace
  style) cannot be sorted by name. Then the only trustworthy order is the reader's
  own DOM order, which the tool applies only for a **top-down reader** (page 1 is
  the first image) after a scroll sweep, and it compares the result with any page
  total the reader advertises.
- **Neither available** — the tool refuses that strategy and says so, rather than
  producing a plausibly ordered but wrong archive. That refusal is the intended
  behaviour, not a defect to work around.

### What would reopen the site-control route for another site

Both of these, together:

1. A sanitized capture of that site's own control (tag, attributes, whether a
   script handler is required, whether the `href` exists before a click), obtained
   under [DATA_COLLECTION_GUIDE.md](DATA_COLLECTION_GUIDE.md) rules — no cookies,
   no signed URLs; **and**
2. An explicit owner decision to build it for that site, accepting that it would be
   per-site and refused everywhere else.

Without both, do not re-propose it for any site.

## Do not retry

- Do not re-fetch `https://nhentai.net/g/177013/` (404), and do not expect the
  nhentai home page to show a Download control.
- Do not treat the hentaifox home-page source capture as evidence about any site's
  download button.
- Do not implement an anchor-text match and call it "the site's own download".
- Do not add mirror/shortener resolution to the chapter path; the on-site
  extraction route deliberately has none.
