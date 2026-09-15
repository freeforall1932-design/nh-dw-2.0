# Capture guide — how to harvest, and the per-site list

**First, a problem:** the `view-source era to gallery 694133 .txt` you attached
**did not reach the sandbox**. I searched the whole filesystem — there is no
`/home/user/uploads/` directory and no file anywhere containing `694133` except
my own split copy of the homepage. So I have not read it and I will not guess
at its contents. Two ways to get it to me:

- **Re-attach** it (sometimes a retry is all it takes), or
- **Drop it in the repo** the way you did with `5 website page source` — save it
  as `NHDW_Extension_v3.0.0/../captures/hentaiera-694133.txt` (or anywhere under
  `/home/user/nh-dw-2.0/`) and tell me the name. Files in the repo I can always
  read.

---

## Part A — harvesting #2 (image URLs) and #3 (Content-Type)

### Good news first: #3 is nearly optional

I checked how strict the validation actually is. `Downloader.ts:588`:

```js
if (contentType !== null && !contentType.toLowerCase().startsWith("image/"))
```

That is the whole rule: reject only if the type exists **and** doesn't start
with `image/`. A missing header passes. So #3 matters only in the unlikely case
hentaiera serves something like `application/octet-stream` for a `.webp`. Grab
it if it's free; don't go out of your way.

**#1 and #2 are the ones that matter.**

### A1. Desktop — the 60-second version (Chrome / Brave / Edge)

1. Open the gallery: `https://hentaiera.to/gallery/694132/`
   (10 pages — quick to read, and long enough to give three page requests)
2. Press **F12** → **Network** tab.
3. Click the **Img** filter button (top of the request list). If you don't see
   it, click the funnel icon and pick **Images**.
4. Tick **Disable cache** (small box above the list). This matters — cached
   images don't re-request and won't appear.
5. **Reload** the page (F5). The thumbnail requests appear.
6. Open the **reader** (click the cover / first page). Page images now appear in
   the same list.
7. Read the URLs straight out of the **Name** column — hover shows the full URL,
   or right-click the row → **Copy → Copy URL**.

Grab pages 1, 2, 3. Three, not one — I need to know whether the extension is
constant across a gallery.

For #3, while you're there: click one image row → **Headers** → scroll to
**Response Headers** → copy the `content-type:` line.

### A2. The console one-liner — faster, gets everything at once

On the reader page, F12 → **Console**, paste this, press Enter:

```js
copy([...document.querySelectorAll('img')].map(i=>i.currentSrc||i.src).filter(u=>/^https?:/.test(u)).join('\n'))
```

All image URLs are now on your clipboard — paste them straight to me.
`currentSrc` is deliberate: it resolves the real URL behind `srcset` and
lazy-loading, which is what these sites use.

If the reader builds images outside `<img>` (canvas, CSS backgrounds), this
returns nothing — fall back to A1, and tell me it returned nothing, because
that itself is a finding.

### A3. Phone

No DevTools on mobile, so:

- **#2 is easy:** long-press the page image → **Open image in new tab** → copy
  the URL from the address bar. Repeat for pages 2 and 3. This is exactly the
  gesture you already used in your live testing note, where you got
  `https://m11.hentaienvy.com/033/fdz7b2qj13/2.webp`.
- **#3 has no easy phone path.** Skip it — see above, it's low-value.
- If you want full DevTools on the phone: Android + USB cable → enable USB
  debugging → desktop Chrome → `chrome://inspect` → **inspect** next to the
  phone's tab. Full Network panel, on the phone's session. Worth it for
  hentaienvy, where the reader is script-gated.

### A4. HAR — yes, do this. One file per site, and it beats the txt files

**Revised again, and this is the version to follow.** I first suggested HAR,
then withdrew it over the logged-in cookie risk. Your counter is correct: you
wouldn't be logged in, and at that point the risk mostly evaporates while the
value goes up a lot. Details below.

**Why a logged-out HAR is low-risk.** The sensitive items in a HAR are account
session cookies and a live `csrf-token`. Logged out, there is no account
session, and a CSRF token with no session behind it is inert. The cookies that
do get sent are Cloudflare's (`cf_clearance`, `__cf_bm`) and the sites'
age-verification flags — `cf_clearance` is bound to your IP and user agent, so
it is not usefully portable by anyone else.

**Two settings that matter:**

1. **If your browser offers "Save all as HAR (sanitized)", use that.** It
   strips `Cookie`, `Set-Cookie` and `Authorization` by design — built for
   exactly this. Recent Chrome and Chromium-based Brave have it alongside
   "with content". If yours doesn't, capture logged out and the plain option is
   fine.
2. **Do NOT use "Save all as HAR with content".** That base64-embeds every
   image body — tens of MB on a 396-page gallery — and I need none of it. The
   plain HAR keeps every URL and every header, which is the whole point.

**Capture flow — one HAR per site, one gallery each:**

1. Navigate to the gallery page **first** — e.g.
   `https://hentaiera.to/gallery/694132/`.
2. **Then** open DevTools (F12 → Network).
3. Tick **Disable cache** *and* **Preserve log**. Preserve log matters: the
   Network list clears on every navigation, and you are about to navigate from
   the gallery into the reader. Without it, the gallery's own HTML request
   vanishes before you save.
4. Press **F5**. This re-requests the gallery document *while DevTools is
   watching*, which is how its HTML gets into the HAR.
5. Open the reader, turn to pages 1, 2, 3.
6. Right-click the request list → **Save all as HAR (sanitized)**.

**Pick a gallery with at least 3 pages** — you need three page requests to see
whether the extension varies. Note that gallery *size* doesn't bloat the HAR:
only the pages you actually visit get requested, so a 396-page gallery and a
10-page one produce nearly the same file as long as you click three pages.
(`694109` was my earlier suggestion and it is wrong — it has only 2 pages.
`694132` has 10.)

**Separate HAR per site, not one combined.** Each site has its own CDN host,
path scheme, and possibly its own Referer requirement; a combined file mixes
them and I would have to untangle which request belonged where. It is barely
more work to save one at a time. The one deliberate pairing: use the *same
title* on imhentai and hentaienvy, so the two HARs are directly comparable.

**Any title works.** Specific ids are only a convenience — they let me
cross-check the media id / token in your HAR against the one I already
extracted from the listing, which catches a wrong assumption early. If those
galleries are gone by the time you get to them, pick any with 3+ pages and just
tell me which id you used.

**What HAR answers that three txt files cannot:**

- **Every** image URL and **every** `Content-Type`, not a sample of three. That
  settles the per-page extension question outright — the one unknown blocking
  item 53.
- **The `Referer` header the browser actually sent.** This is the one I had
  missed, and it is design-critical: no code path in this extension sets a
  Referer. The only custom header anywhere is `User-Agent`, from
  `descriptiveUserAgentHeaders()` in `apiAuth.ts:56` (plus `Authorization` for
  the optional nhentai API key). Every image fetch is a bare
  `fetch(url, { credentials: "include", cache: "no-store" })` —
  `Downloader.ts:692`, `tabImageFetch.ts:45`. If `hentaiera.site` hotlink-gates
  on Referer, those calls get a 403 and the whole adapter needs a header it
  currently has no way to send. Invisible in a URL list; free in a HAR.
- **Whether the reader fetches a JSON/XHR page list.** hentaienvy loads
  `/assets/js/image-loader.js?v=3`; if that pulls a JSON manifest, it replaces
  HTML scraping entirely. A HAR shows the request, a URL list never would.
- HTTP status codes and redirects, so a 403 or a CDN hop is visible rather
  than guessed.

**The one thing HAR does not replace:** the *rendered* DOM of a JS-driven page.
HAR records the raw document response — for hitomi that is the empty pre-JS
shell (0 galleries, 0 media paths, as measured in `SITE_CAPTURE_AUDIT.md`).
hitomi still needs DevTools → Elements → Copy outerHTML. The four mirror sites
are server-rendered, so for them HAR is genuinely sufficient.

**Your call, stated once and then dropped:** a HAR is a record of what you
browsed, on a repo that may end up public. You've said you're fine with that;
I'll take it at face value and won't raise it again.

### A5. One gotcha that applies to every site

Capture **after** the Cloudflare challenge resolves to the clean URL — the
`?__cf_chl_rt_tk=…` hop you already spotted. You did this correctly last time;
just keep doing it.

---

## Part B — what I need, per site

**One sanitized HAR per site, captured with A4's flow.** That replaces the
gallery HTML, the three image URLs and the content-type header in a single
file. Per-site extras and gotchas below.

*Known* = already extracted from `5 website page source`, so don't re-capture it.

### 1. hentaiera.to — **RESOLVED, no more capture needed**

Everything was pinned by the `694133` gallery page (on `origin/main`, fetched
via git) plus the DevTools screenshot. No HAR required. See `WORKLIST.md`
item 53 for the resolved facts. Summary:

- Gallery `https://hentaiera.to/gallery/<id>/`; reader page N `/gallery/<id>/N/`.
- `media_id` + `num_pages` from the `ld+json` ImageGallery block.
- Full-page N image read off reader page N's HTML; thumbs `<N>t.webp`, full
  `<N>.webp`. Host `hentaiera.site`. Image path passes the existing `cdnConfig`
  regex unmodified.

The remaining four sites still want captures (§2–§5 below).

### 2. imhentai.xxx — unlocks hentaienvy for free

*Known:* CDN `m11.imhentai.xxx`, path `/033/<token>/`, jpg thumbs, token in the
listing (**20/20** cards). Gallery `1738518` = token `w62za5o4v3`.

**RESOLVED (2026-09-15, `imhen xxx.zip`):** reader `/view/<id>/<n>/`, full image
`<img id="gimg" src="…/033/<token>/<n>.webp">`, thumbs `.jpg` but pages
`.webp`, **no Referer** sent. Facts in `ADAPTER_WIRING_PLAN.md` §1.

*Gotcha:* behind Cloudflare — carries `window.__CF$cv$params` and loads
Turnstile. Capture after the challenge clears.

### 3. hentaienvy.com — same content store as imhentai

*Known:* CDN `m11.hentaienvy.com`, path `/033/<token>/`, jpg thumbs, token in
the listing (**24/24** cards). Gallery `1606086` = token `w62za5o4v3` — the
**same token** as imhentai 1738518, different gallery id. Different frontend
(`hnv-gallery-card__*` BEM, Tailwind).

**RESOLVED (2026-09-15, `envy com.zip`):** reader `/g/<id>/<n>/`, full image
`<img id="readerImg" src="…/033/<token>/<n>.webp">`, plus `#readerPagesJson`
(a complete per-page `{page,ext,w,h}` map) and `data-reader-image-base`
(token). **Referer sent.** Confirms the shared store with imhentai (same
token, different id). Facts in `ADAPTER_WIRING_PLAN.md` §1.

*Two gotchas:*
- The reader is script-gated. Your note says you had to block all scripts to
  see `hentaienvy.com###readerImg`, and the page loads
  `/assets/js/image-loader.js?v=3` — almost certainly what populates it. **Do
  not block scripts for this capture**; the HAR needs the real request. Watch
  for an XHR in it — that's the JSON-manifest possibility from A4.
- This is the site that threw you the `__cf_chl_rt_tk` hop. Also loads
  `auth-modal.js` and `adult-verification.js`.

### 4. hentaifox.com

*Known:* CDN `i3.hentaifox.com`, jpg thumbs, media id in the listing (**20/20**
cards). Gallery `173098` = `media_id` 4190711 = "The Girllove Diary".

*Need:* one HAR from `https://hentaifox.com/gallery/173098/` → reader → pages
1–3, **plus one from an older gallery that uses the `/004/` prefix.**

*Two gotchas specific to hentaifox:*
- **The CDN prefix varies per gallery.** Your capture has both
  `i3.hentaifox.com/004/…` (3 thumbs, older ids like 4164177) and
  `i3.hentaifox.com/005/…` (39 thumbs). Must be **read, never assumed** — hence
  the second HAR.
- **The age modal does NOT fire for you.** It shows only when
  `allowedGeos.includes(window.__GEO__)`, and `__GEO__ = "ID"` is not in
  `['US','FR','IT','GB']` (an earlier draft had this inverted) — nothing to
  dismiss. It also loads Turnstile and ships `jszip` + `FileSaver`
  (client-side zip).

### 5. hitomi.la — last, and HAR alone is NOT enough here

*Known:* essentially nothing usable. The capture is a pre-JS shell:
`<title> | Hitomi.la</title>`, **0 gallery links, 0 media paths**. Assets come
from `ltn.gold-usergeneratedcontent.net` — **not** `ltn.hitomi.la` as
`MULTISITE_V4_PLAN.md` §2.1 still says. Not behind Cloudflare
(`185.165.169.231`), no login.

*Need — HAR plus three extras:*
1. **A HAR** from `https://hitomi.la/galleries/<id>.html` → reader → pages 1–3.
   Gets the image URLs, the content types, and the Referer question.
2. **The gallery page's rendered DOM** — HAR only records the raw document,
   which for hitomi is the empty shell. DevTools → Elements → right-click
   `<html>` → **Copy → Copy outerHTML**.
3. **The gallery data JS.** In the HAR (or Network → JS filter), find the
   request whose name contains the gallery id — historically
   `galleries/<id>.js`. Read the path off the HAR, don't guess it.
4. **`gg.js` contents.** Open `//ltn.gold-usergeneratedcontent.net/gg.js`
   directly and save the text. It maps image numbers to CDN subdomains and
   rotates — the "never hardcode subdomains" rule exists because of it.

*Noise to ignore:* an obfuscated inline script with an embedded WASM blob that
randomizes URL parameters, plus `glimmersmugglingsullen.com/on.js` and
`js.wpadmngr.com`. Ad network, not anti-bot.

---

## Part C — suggested order

| # | Site | Files | Why here |
|---:|---|---:|---|
| 1 | hentaiera | done | Adapter core landed + tested; resolved by `era to.zip` |
| 2 | imhentai | done | Resolved by `imhen xxx.zip` |
| 3 | hentaienvy | done | Resolved by `envy com.zip` (`#readerPagesJson`) |
| 4 | hentaifox | 2 HAR | Second one for the `/004/` prefix |
| 5 | hitomi | 1 HAR + 3 files | Client-rendered; HAR can't capture the rendered DOM |

Per your call, no cross-mirror fallback work — one site at a time.

**Hentaiera, imhentai and hentaienvy are done.** Next captures: hentaifox
(1–2 HARs) and hitomi (HAR + 3 files). Next code: the wiring in
`ADAPTER_WIRING_PLAN.md` §5.

## Part D — how to hand it over

Either works:

- **Re-attach** — and if it silently fails again, tell me; that's a platform
  issue, not you doing it wrong. (The `694133` file never arrived this way.)
- **Save into the repo**, and I'll read them directly:

```
captures/hentaiera-694132.har
captures/imhentai-1738518.har
captures/hentaienvy-1606086.har
captures/hentaifox-173098.har
captures/hentaifox-older-004.har
captures/hitomi-<id>.har
captures/hitomi-<id>-rendered.html      <- Copy outerHTML
captures/hitomi-gg.js
```

**`captures/` is in `.gitignore`, but that does not hide it from me** — the
ignore rule only keeps it out of git; I read the filesystem directly. Since
you're happy for the repo to be public, just say so and I'll drop the ignore
rule and commit the captures alongside the audit. Your call either way.

Plain `.har` / `.txt` / `.html` are all fine. Don't zip — I can't unpack
`.rar`, and the repo already carries enough of those.
