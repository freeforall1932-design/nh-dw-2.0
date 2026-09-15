# Next capture — one site, end to end

> **Superseded for capture instructions: see `CAPTURE_GUIDE.md`.**
> This file keeps the *rationale* (why hentaiera first, the adapter contract,
> what can be built offline). The how-to and the per-site list moved to
> `CAPTURE_GUIDE.md` once HAR replaced the three-file approach — one
> sanitized HAR per site, and the hentaiera gallery changed from `694109`
> (2 pages, too few) to **`694132`** (10 pages).

**Target: `hentaiera.to`.** (Superseded — hentaiera is resolved; see the banner
above and `CAPTURE_GUIDE.md`. Kept only for the adapter-contract rationale.)

Scope discipline (your call, 2026-09-15): no cross-mirror fallback, no
multi-site panel, no hitomi. One site downloading exactly the way nhentai does
today, then stop and look at it.

---

## Why hentaiera and not one of the others

Measured, not preference:

| Reason | Measurement |
|---|---|
| **Its image path already passes the existing regex** | `cdnConfig.ts` `ALLOWED_IMAGE_PATH = /^\/galleries\/[0-9]+\/[0-9]+\.(jpg\|jpeg\|png\|gif\|webp)$/i` — `https://hentaiera.site/galleries/4182258/1.webp` → **PASS**, unmodified. hentaifox `/005/<id>/1.jpg`, imhentai and hentaienvy `/033/<token>/2.webp` → **FAIL** |
| Server-rendered, so `view-source:` works | The captured homepage holds 25 real cards in the raw HTML. hitomi's holds 0 — it renders client-side |
| The listing already carries everything except the extension | 25/25 cards parsed from the file already committed: gallery id, `media_id`, page count, title |
| Smallest permission surface | Two hosts: `hentaiera.to` (pages) + `hentaiera.site` (images) |
| webp thumbs already | Matches nhentai's current type code `w`; no new plumbing |

Alternative if you would rather unlock two sites at once: **imhentai**. It
shares its content store with hentaienvy, so doing imhentai makes hentaienvy
nearly free later. The cost is a new path regex for `/033/<token>/`. Say the
word and this checklist becomes an imhentai one instead — the three items are
the same three items.

---

## The contract the adapter has to satisfy

Read out of `src/parsing/GalleryEmbed.ts` and `src/background/Downloader.ts`
(lines 496–527), not assumed. A new site must produce:

```
{
  id,            media_id,
  title:         { pretty, english, japanese },
  images:        { pages: [ { t: "j"|"p"|"g"|"w", w, h }, … ] },
  num_pages
}
```

`Downloader.#downloadPageInternalAsync` turns `t` into an extension, builds
`(currPage + 1) + format` — **unpadded**, so page 2 is `2.webp` — and hands it
to `source.getImageUrls(media_id, "2.webp")`. Zero-padding (`002.webp`) happens
only in the saved filename, never in the URL.

That matches your live note exactly: you recorded
`https://m11.hentaienvy.com/033/fdz7b2qj13/2.webp` as "page 2, named 2.webp".
Same rule, so the pipeline needs no change — only the adapter.

`t` is the one field that cannot be guessed: `Downloader.ts:517` throws
`"Unknown page format " + page.t` on anything outside `j`/`p`/`g`/`w`, and `0`
means "skip this page". `w` and `h` are carried in the shape but **nothing in
`src/` reads them** — they are only ever written, in `GalleryEmbed.ts:61,68,69`
(checked by grep across all `.ts`). Safe to emit as `0`; do not spend capture
effort on dimensions.

**That single field is what is missing.** nhentai ships a per-page type map
(`j`/`p`/`g`/`w` per page). Whether hentaiera varies per page, or is uniformly
webp, decides whether the adapter needs a real map or one constant.

---

## The three captures

### 1. One gallery page — the important one

```
https://hentaiera.to/gallery/694132/  (10 pages)
```

Use **that exact id**. I already extracted its `media_id` from the listing
(`4182258`, 396 pages), so the gallery page can be cross-checked against a
number I have rather than trusted.

If 694133 is too big to be pleasant, `694109` is the smallest on the captured
front page (2 pages, `media_id` 4182156) — a 2-page gallery makes item 2
trivial. Either is fine; say which you used.

### 2. Three page-image URLs from the Network tab

Open that gallery's reader, open DevTools → Network → filter **Img**, turn to
page 1, then page 2, then page 3. Copy the three URLs.

This answers two questions at once: the numbering (`1.webp`, `2.webp`,
`3.webp`?) and whether the extension is constant. One URL is not enough — n=1
is how a wrong assumption gets baked in.

### 3. One `Content-Type` response header

Click any one of those image requests → Headers → Response Headers → copy the
`Content-Type` line.

The existing fetch pipeline validates content type against the extension. If
hentaiera serves `image/webp` for a `.webp` URL, nothing changes. If it serves
something else (`image/jpeg` for a `.webp` name happens), the validation needs
to know before it starts rejecting good pages.

---

## Not needed now

Deliberately out of scope until one site downloads end to end:

- The download button's URL/POST and its cooldown message — that is Strategy B,
  and Strategy A (reader pages) is what we are building.
- A button-downloaded zip — Strategy C's sample. Your live note already reached
  the conclusion C existed to test (reader-mode wins; imhentai/hentaienvy/
  hentaiera zips byte-identical), so it is not blocking.
- Cross-mirror fallback. Held back by your call. Note for later: imhentai and
  hentaienvy share 19/19 content paths but 0/19 gallery ids, so fallback there
  is a host swap on the token, never an id lookup.
- hitomi. Client-rendered and its CDN moved to
  `ltn.gold-usergeneratedcontent.net`; it is the hardest of the five and there
  is no reason to start there.

---

## What gets built while you capture — needs no site access

The listing parser is already proven against your real capture: a four-group
regex pulled **25/25** cards (gallery id, `media_id`, page count, title) from
`5 website page source`. So these can land and be tested offline right now:

- **`CardParsing` for hentaiera** — written and verified against the capture.
- **Paste box** — `/gallery/<numeric>/` confirmed with zero exceptions across
  all four mirror sites, so `matchesUrl` / `getGalleryId` / `getGalleryUrl`
  are writable and pinnable by tests today.
- **`cdnConfig` per-adapter allowlists** — the two nhentai-only regexes become
  adapter-owned. Pure refactor, fully testable.
- **Site slugs in `siteKeys`** — the contract already allows numeric ids and
  forbids `:`.
- **`host_permissions`** — `hentaiera.to` + `hentaiera.site`.

The only piece that waits on your three files is `getImageUrls`.
