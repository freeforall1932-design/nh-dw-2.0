# Adapter wiring plan — item 48, from captures to a working second site

**Recorded:** 2026-09-15 (session `arena/01a0a3d5-nh-dw-2-0`). **Planning mode —
no code.** This is the implementation plan for wiring the already-built adapter
cores (`src/sources/hentaieraSource.ts`, `src/parsing/hentaieraHtml.ts`, landed
this session with tests) into the live pipeline, and for adding imhentai. It is
the "how" companion to `MULTISITE_V4_PLAN.md` §4.2 (the "what").

Scope (user's call): make **hentaiera** and **imhentai** download like nhentai.
nhentai stays the regression control. No hentaienvy/hentaifox/hitomi yet, no
cross-mirror fallback, no panel rework. Those follow the same pattern later.

The cores are pure + tested (389→398 passing) but **deliberately not registered**
in `src/sources/index.ts`: registering now would let `popup.ts:428` resolve a
hentaiera id and feed it to the **nhentai** API (id collision → wrong-site
metadata). That registration must land *together* with the site-aware parsing
selection below. That coupling is the reason this is one milestone, not two.

---

## 1. The two adapters, as measured

Every field below comes from the user-captured material (2026-09-15):
`view-source era to gallery 694133 .txt`, `era to.zip` (hentaiera HAR),
`imhen xxx.zip` (imhentai HAR), all on `origin/main`. Nothing is assumed.

| contract field | hentaiera | imhentai | hentaienvy |
|---|---|---|---|
| page host | `hentaiera.to` | `imhentai.xxx` | `hentaienvy.com` |
| image host | `hentaiera.site` (different TLD) | `m11.imhentai.xxx` | `m11.hentaienvy.com` |
| gallery URL | `/gallery/<id>/` | `/gallery/<id>/` | `/gallery/<id>/` |
| reader URL (page n) | `/gallery/<id>/<n>/` | `/view/<id>/<n>/` | `/g/<id>/<n>/` ← third scheme |
| media address | numeric `media_id` | **token** | **token** (same store as imhentai) |
| gallery metadata | `ld+json` ImageGallery | `<title>` + `Pages: N` + thumb token | `<title>` + JSON API (`/api/gallery/<id>/…`) |
| reader full-image element | `#reader_img` | `#gimg` | `#readerImg` (the one you had to unblock) |
| per-page ext source | reader `src` | reader `src` | **`#readerPagesJson`** — full `{page,ext,w,h}` map |
| token exposed on reader | – | – | `data-reader-image-base="…/033/<token>"` |
| thumb ext vs page ext | equal | not equal | not equal (`t.jpg` vs `.webp`) |
| image path | `/galleries/<media>/<n>.<ext>` | `/033/<token>/<n>.<ext>` | `/033/<token>/<n>.<ext>` |
| passes existing `ALLOWED_IMAGE_PATH` | yes | no | no |
| `Referer` sent on images | yes | **no** | yes (origin) |
| Cloudflare | yes | yes | yes (`__cf_chl_rt_tk` hop you saw) |

Four facts force the contract shape:

1. **Reader markup and URL differ on every site** (`#reader_img`/`/gallery/`,
   `#gimg`/`/view/`, `#readerImg`/`/g/`) → the adapter must own both; there is
   no shared DOM helper and no single imhentai+envy scraper despite the shared
   store.
2. **Thumbs lie about the page extension** on imhentai and envy (`.jpg` thumb,
   `.webp` page) → never read the extension from the thumbnail strip. Envy is
   the exception that makes it easy: `#readerPagesJson` is a complete per-page
   map, exactly the shape nhentai's `images.pages` normalizes to.
3. **Referer is sent on hentaiera and envy but not imhentai** → per-site fetch
   strategy; default to tab-fetch.
4. **Envy has a JSON API family** (`/api/gallery/<id>/related`, `/comments`,
   `/adult-verification/context/`). A main `/api/gallery/<id>` is plausible but
   *not observed* in the HAR — do not build on it until captured; `#readerPagesJson`
   already makes it unnecessary.

---

## 2. SiteAdapter contract v2

Evolve `GallerySource` (`src/sources/GallerySource.ts`) into `SiteAdapter`,
adding the fields the captures proved necessary. nhentai's `clearnetSource`
implements them all, so it stays the reference adapter.

```
interface SiteAdapter extends GallerySource {
    readonly site: string;                       // "nhentai" | "hentaiera" | "imhentai"
    getReaderPageUrl(id: string, page: number): string;
    extractGallery(html: string): any | null;    // legacy shape; per-site
    extractReaderImage(html: string): string | null;  // per-site selector
    getImageHosts(): string[];                   // for manifest + allowlist
    needsTabFetch(): boolean;                    // hentaiera true, imhentai false
}
```

`getImageUrls(mediaId, filename)` already exists and returns a candidate list —
imhentai's token IS its `mediaId`, so no signature change.

`media_id` for imhentai is the token; the composite key (`siteKeys.ts`) is
unaffected (token contains no `:`).

---

## 3. The seams to change (site-aware selection)

These are the places that currently hard-assume nhentai; each gets a
site-aware branch. Order matters: build the registry first, then flip seams.

1. **Registry** `src/sources/index.ts`: add adapters to `sources[]`, add
   `getAdapterForUrl(url)` and `getParsingForUrl(url)` (returns the adapter's
   `extractGallery`-backed parsing, not the global nhentai `HtmlParsing`).
2. **Popup preview** `src/preview/popup.ts:428` `updatePreviewAsync`: after
   resolving `source`, route metadata through `source.extractGallery` for
   non-nhentai. **Guard:** only call the keyed nhentai API
   (`#doujinshiPreviewAsync`, `popup.ts:452`) when the adapter is nhentai.
3. **Worker** `src/background/background.ts:208/269/271`: choose parsing via
   `getParsingForUrl(tabUrl)` instead of the `htmlParsing` checkbox alone.
4. **Offscreen** `src/offscreen/offscreen.ts:44/125` and **preview**
   `src/preview/preview.ts:136`: same selection, threading the active site.
5. **Downloader** `src/background/Downloader.ts:527`: already calls
   `this.#source.getImageUrls(...)` — the source just has to be the right
   adapter, injected with the job. The `#downloadPageInternalAsync` type-code
   switch (`Downloader.ts:498-517`) needs the new per-page extension handling
   (decision D1).
6. **cdnConfig** `src/sources/cdnConfig.ts`: `IMAGE_SERVER_HOST` and
   `ALLOWED_IMAGE_PATH` are nhentai-only; become per-adapter allowlists fed by
   `getImageHosts()` + a per-site path regex (imhentai `/033/<token>/…`).

---

## 4. Open decisions (resolve before/while implementing)

- **D1 per-page extension.** Options: (a) fetch every reader page (accurate,
  N extra requests); (b) learn once from reader page 1 and assume per-gallery;
  (c) extension fallback chain in the candidate list (try webp→jpg→png→gif,
  404-driven). Recommend **(b) with (c) as the retry**, validated by the
  existing status/content-type checks.
- **D2 fetch strategy.** Default tab-fetch for all sites; allow bare fetch
  where the HAR proves no Referer (imhentai). Keep `tabImageFetch.ts` as the
  shared mechanism.
- **D3 job splitting.** From `MULTISITE_V4_PLAN.md` §4.2: one job per site once
  the queue can hold two sites. Defer until the queue actually holds a second
  site; single-site jobs are unaffected.
- **D4 paste box.** `/gallery/<id>/` is shared by hentaiera+imhentai; nhentai
  keeps `/g/<id>/`; add imhentai `/view/<id>/<n>/` as a reader alias. Disambiguate
  `/gallery/` by an explicit site prefix (the composite paste already supports
  `site:id` shapes conceptually).

---

## 5. Implementation order & verification

1. `SiteAdapter` interface + registry (no behaviour change; nhentai-only tests
   still pass).
2. imhentai adapter (`src/sources/imhentaiSource.ts` +
   `src/parsing/imhentaiHtml.ts`), fixtures from `imhen xxx.zip`.
3. Flip seams §3 one at a time, each with a failing-first test; keep
   "nhentai still downloads" green as the control.
4. cdnConfig per-adapter allowlists.
5. Paste box + manifest `host_permissions` (add the four new hosts).
6. `npm run test:e2e` (six offline suites) + smoke; then **real-browser** spot
   check on hentaiera and imhentai — the one verification this environment has
   never run, and the reason the plan stops short of claiming "done" until it
   passes.

**Risks:** id collision if any seam is flipped without the registry guard;
imhentai Cloudflare challenge on worker fetch (mitigated by tab-fetch); the
two-host manifest for hentaiera (`hentaiera.to`+`hentaiera.site`); hentaienvy's
script-gated reader is out of scope here.

---

## 7. Capture status — what the three HARs settled, and the two left

**The three HARs ARE enough, each for its own site.** `era to.zip` → hentaiera,
`imhen xxx.zip` → imhentai, `envy com.zip` → hentaienvy. Each supplies gallery
page, reader page(s), full-page URLs + content types, Referer behaviour, and the
per-page extension source. No further capture is needed for those three. What
remains is **hentaifox** and **hitomi**, which have no HAR and whose homepages
are the only material on hand.

### hentaifox.com — one HAR (plus one optional second)

Already known from the homepage capture: CDN `i3.hentaifox.com`, numeric media
id in the listing, path `/004/` or `/005/<numid>/`, jpg thumbs, `/gallery/<id>/`
page URL. Unknown: reader URL scheme, reader image selector, full-page
extension, and any JSON embed. A single HAR answers all of them.

1. Dismiss the **age modal first** (`window.__GEO__ = "ID"` is not in
   `allowedGeos = ['US','FR','IT','GB']`, so it fires for you).
2. DevTools → Network, tick Keep log + Disable cache, F5 on
   `https://hentaifox.com/gallery/173098/`.
3. Open the reader, turn to pages 1, 2, 3.
4. Save HAR (sanitized, no content).

That yields the reader scheme, the `#…img` selector, the full-page extension,
and whether the prefix is `/005/`. A **second HAR from an older gallery that
uses `/004/`** pins the per-gallery prefix (your homepage capture showed both
`/004/` and `/005/`). If you can only send one, send the `/005/` one.

### hitomi.la — a HAR is NOT enough; it needs 4 files

hitomi renders client-side, so a HAR's raw document is the empty pre-JS shell
(0 galleries, 0 media paths — measured in `SITE_CAPTURE_AUDIT.md`). It needs:

1. **A HAR** anyway (gallery → reader → pages 1–3) for the image URLs, content
   types, and Referer.
2. **The gallery page's rendered DOM** — DevTools → Elements → right-click
   `<html>` → Copy → Copy outerHTML (or Save As "Webpage, Complete").
3. **The gallery data JS** — in the HAR/Network → JS filter, the request whose
   name contains the gallery id (historically `galleries/<id>.js`); read the
   path off the capture, don't guess.
4. **`gg.js` contents** — open `//ltn.gold-usergeneratedcontent.net/gg.js` and
   save the text; it maps image numbers to CDN subdomains and rotates.

Ignore the obfuscated WASM/URL-randomizer script and `glimmersmugglingsullen.com`
/ `js.wpadmngr.com` — ad network noise, not anti-bot.

---

## 8. Next step

Captures: **done for hentaiera, imhentai, hentaienvy**; fox = 1–2 HARs, hitomi =
HAR + 3 files (§7). Code: implement §5 in order — registry, imhentai adapter,
flip seams (with the nhentai-API collision guard), cdnConfig allowlists, paste
box + manifest hosts, e2e, then the real-browser check. The three captured sites
can be wired now; fox and hitomi join when their captures land.
