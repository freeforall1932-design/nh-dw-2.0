# What open-source Mihon/Keiyoushi extensions tell us (and what to copy)

**Question asked:** since these sites already have Mihon (Tachiyomi fork) extensions,
should we pivot to downloading the extension's download link while bypassing the
ad-link shortener?

**Short answer: pivot the *evidence*, not the target.** The extensions never use a
site's download button and never touch a shortener — they read the site's reader
or its reader API directly. That is exactly the route this project already takes,
so their source code is the best evidence available for making it work per site.
Bypassing an ad-link/shortener stays out of scope.

This file records what was found in `keiyoushi/extensions-source` (the source repo
behind most Mihon extension repos, MIT/Apache-licensed, 4.8k stars) on 2026-10-31,
and what it changes here.

---

## 1. What the extensions actually do

Every extension implements a small interface: manga list, manga details, chapter
list, **page list**. The page list is built from the site's reader page or its
reader API. Not one of them:

- clicks a site's "Download" button,
- opens `mirrored.to` (or any file host / link directory),
- passes a shortener,
- solves a captcha or reuses a session cookie for a paywall.

So "someone already supports this site in Mihon" is evidence about **how to read
the pages**, not about a download endpoint we could shortcut to.

## 2. Site-by-site findings

### `sasangeyou.net` — MangaThemesia family (confirmed by its extension)

`src/id/sasangeyou/.../Sasangeyou.kt` is 8 lines: it inherits
`lib-multisrc/mangathemesia/MangaThemesia.kt` and only overrides the date pattern.
Everything else is the shared base. Two facts from that base matter:

1. `pageSelector = "div#readerarea img"` — the reader images live in `#readerarea`
   (the panel's default selector already covers this).
2. **When there are no `<img>` elements, the page list is inside a base64 script**:

   ```kotlin
   document.selectFirst("script[src^=data:text/javascript;base64,dHNfcmVhZGVyLnJ1bih7]")
   ```

   `dHNfcmVhZGVyLnJ1bih7` is base64 for `ts_reader.run({`. The decoded payload is
   JSON, and the URLs are pulled out with
   `["']?(?:images|imageUrls)["']?\s*[:=]\s*(\[.*?])` then parsed as a string array.
   The extension tries the DOM first and only falls back to this payload.

   **Implemented in this branch** (`readerScriptPayloads`, `readerScriptImageUrls`,
   `collectReaderScriptPages` in `src/utils/universalChapter.ts`, wired into the
   probe as a fallback): decode the payload as text, require `https` + public host
   for every URL, keep the site's own list order, and report
   "read from the reader's own embedded page list" in the review. Nothing is
   executed. 124 extension files in the same repo inherit this base, so the same
   fallback covers that whole family.

Chapter-list side of the same base: `chapterListSelector()` over
`a[href]`/`.lch a, .chapternum` rows with `.chapterdate`; chapter URLs come from
`<a href>`. Nothing exotic — the panel's generic scan already does this.

### `doujin.desu.xxx` — reader API, encrypted on purpose

`src/id/doujindesu/.../Doujindesu.kt` reads page lists from a REST endpoint:

```
GET {baseUrl}/api/chapters/{chapterId}   (+ header x-app-secret, response JSON EncryptedDto)
```

`Decryptor.kt` then decrypts that JSON with a key derived from the **current hour**
(salt + hour → LCG "key", XOR per byte), trying the previous/current/next hour.
`Dto.kt` gives `PageList(pages: List<String>)`, HTML-unescaped before use.

Read that for what it is: the site deliberately obfuscates its API, and the salt
is literally named `…-scrapers-cannot-read-this-…`. **We will not reproduce it.**
Two reasons, in order:

1. It is a technical measure aimed at exactly this kind of reading. Re-implementing
   it in a browser extension is circumvention, and it is brittle by design (hour
   keys).
2. We do not need it. The user's own browser loads the chapter page, the site's own
   JavaScript decrypts and renders the reader, and the images are then in the DOM.
   That is the *Use open chapter* path, which is already implemented and needs no
   key, no header and no decryption.

So for DoujinDesu the honest position is: **one open chapter at a time, read from
the rendered reader; no static whole-title inspection.** If a capture shows the
reader is canvas/background-image based, the answer is "not supported", not a
workaround.

### `tailspace.com` — no extension found

Code search over the same repo (and GitHub-wide) found no Tailspace source. This is
the site that needs a real capture: scroll mode vs gallery mode, whether page URLs
are in the HTML, and whether anything numbers the pages.

### `mirrored.to` — nothing to learn

No extension references it, because none of them go near a file host. The batch
directory stays out of the download path (see
[SITE_DOWNLOAD_CONTROL_EFFORT.md](SITE_DOWNLOAD_CONTROL_EFFORT.md)).

## 3. Why not "download the extension's link and bypass the ad-link"

- **There is no such link.** The "download" affordance on these sites leads to a
  link directory/shortener chain, and the extensions ignore it entirely — that is
  the strongest available evidence that the reader is the sane path.
- **Bypassing an ad-link or shortener is circumvention** of the mechanism a site
  uses to gate and monetise access, and it is the one thing every other part of
  this project deliberately avoids. It is also fragile: shorteners rotate, add
  interstitials/captchas, and change hosts monthly.
- **The reader path already yields the same bytes.** Pages served to the reader
  are the pages an archive should contain; nothing is lost by skipping the
  shortcut except a hostile middle step.
- **Legal/ToS position stays simple.** Reading the page the user is already viewing
  and saving their own accessible copy is a different act from defeating an access
  control. The project's standing rules (no login/paywall/Premium/captcha bypass,
  no wildcard hosts, no auto-injection) exist to keep it on the first side.

## 4. What changed in this branch

- **New:** MangaThemesia reader-script fallback (`ts_reader.run` base64 payload),
  covered by unit tests and an end-to-end fixture (chapter HTML with no `<img>`,
  only the script).
- **Panel:** a chapter inspected this way is labelled
  "read from the reader's own embedded page list" instead of presenting it as a
  translated order, and the log records it.
- **Unchanged on purpose:** no shortener/mirror resolution, no API decryption, no
  session/cookie reuse, no headers beyond what the browser already sends.

## 5. Using this instead of guessing

Using open-source parser source as evidence is better than a manual capture where
it exists, because someone already verified the selectors against the live site and
the code is reviewable. It is **not** a substitute for a live run here: the
execution paths are still synthetic until the benchmark is pressed in a real
Chromium profile.

Next best evidence, in order:

1. `keiyoushi/extensions-source` (and `lib-multisrc/*`) for any site in the list —
   it answers "how does the page list work?" without touching the site.
2. A sanitized capture per [DATA_COLLECTION_GUIDE.md](DATA_COLLECTION_GUIDE.md), for
   sites with no extension (Tailspace) or to confirm a variant.
3. The benchmark log from a real run.

## 6. How likely is each site now?

Asked directly ("how likely are Desu and Sasa to be implemented?"), and answered
with the work that is actually left. These are estimates, not guarantees, and all
of them still assume a real-browser run.

| Site | Estimate | Why | What is left |
| --- | --- | --- | --- |
| **sasangeyou** | **~75 %** for ordinary chapters on generic defaults | MangaThemesia base is well understood: `div#readerarea img` is inside the panel's default selector, and the `ts_reader.run` base64 fallback is now implemented. Chapter lists are plain `<a href>` rows. | A 2-minute confirmation run (does the review show images or "read from the reader's own embedded page list"). Premium chapters stay out; if a server switcher exists, that is a separate feature. |
| **doujin.desu** | **~35–45 %** for a whole-title static read, **~70 %** for one chapter at a time via the open page | The reader API is encrypted with an hour-derived key, which we deliberately do not reproduce, so the served HTML has no page URLs. The rendered DOM path works but requires *Use open chapter* per chapter and depends on CORS for the CDN. | A capture of the rendered reader, then confirm lazy-loading behaviour. Whole-title pseudo-batch is unlikely without the decryption we refuse to do. |
| **tailspace** | **~60–70 %** | Nothing conflicts: top-down scroll reader, hashed names, no numbering — the top-down path plus the new suffix rule is built for exactly this. | One live run (`TAILSPACE_PLAN.md`). Real blockers if it is canvas/iframe-based or the CDN has no CORS. |

**Decision taken (owner's instruction, 2026-10-31):** Desu and Sasa go on **hold**;
Tailspace is the focus. Nothing was removed — the MangaThemesia fallback stays in
the build because it is already written, tested and harmless, and it is what
sasangeyou will use when it is picked up again.
