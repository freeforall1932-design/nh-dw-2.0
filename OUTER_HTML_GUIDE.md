# Outer-HTML capture guide (per site)

The chapter tool can only read a reader it can describe: a CSS selector for the
page images, the attribute that actually holds the full-size URL, and the order
those images appear in. This guide is the hand-off for the next session — which
site needs a capture first, exactly where to go, what to click and what to paste.

Everything below is **unverified**. No site in this list has been captured or
tested live yet. The site details come from the owner's own browsing and earlier
research; the capture steps are the part that has to be done in a real browser.

## The rules (non-negotiable)

- Capture **one ordinary, publicly accessible chapter** — never a Premium/locked
  page, never a page behind a login.
- Capture **sanitized HTML only**. No cookies, no HAR, no signed URLs left in
  place, no image files, no screenshots of the reader with identifying content
  beyond what is needed to read the markup.
- Never paste a `blob:`/`data:` URL or a URL with a token query string. Trim them
  to `https://host/path` when you paste.
- Trim repeated page elements: keep the **first three** and the **last one**,
  plus the container's opening tag and its closing tag. Attributes must not be
  edited — removed repetition is fine, changed markup is not.
- One file per site, plain text, named `captures/<site>-<chapter>.txt`.
  `captures/` is scratch: it does not belong in Git, and nothing in it should be
  needed by the build.

## How to capture (Chromium)

1. Open the chapter page in a normal tab and **let it finish loading**. For a
   lazy/top-down reader, scroll to the bottom once, then back to the top.
2. `F12` (or `Ctrl+Shift+I`) → **Elements** tab.
3. Press `Ctrl+Shift+C` (inspect element mode), then hover the reader area and
   click the element that **contains** the page images — not the image itself.
   The correct node's children are the page images (or their wrappers).
4. In the Elements panel, right-click that node → **Copy** → **Copy outerHTML**.
5. Paste into a new text file. If it is very large, delete repeated page
   wrappers as described above.
6. Fill in the five answers in the checklist below while the page is still open.

### If you cannot tell which element to pick

Paste this in the **Console** while on the chapter page (it prints counts, it
changes nothing):

```js
document.querySelectorAll('img').length
```

Then, after clicking one page image with `Ctrl+Shift+C`, type `$0` to confirm you
selected an `<img>` and `$0.parentElement` to step up to the container. When the
container looks right, `copy($0.outerHTML)` puts it on the clipboard (DevTools
only — `copy()` does not exist on a normal page).

If `document.querySelectorAll('img').length` is 0 or 1 even after scrolling, the
reader is drawing pages some other way (canvas, `<picture>`, an iframe, or a
background image). Say so in the capture file — that is a finding, not a failure,
and it changes what the next session can do.

## Per-site instructions

### 1. `sasangeyou.net` — highest priority

- **Where to go:** the site home page → pick an ordinary series (one whose
  chapters are not marked Premium) → open **one** ordinary chapter.
- **What to pick:** the reader container that holds the chapter's page images
  (the earlier research suggests `#readerarea`; confirm it rather than assuming).
  Also record whether the reader shows a **server switch** ("Server 1 / 2 / 3").
- **What to paste:** the container's outerHTML, trimmed as above; plus the
  checklist answers.
- **Why:** the site is WordPress/MangaThemesia. The open question is whether its
  reader puts plain image URLs in the static chapter HTML (then *Inspect selected
  chapters* works on a whole title at once) or only builds them with JavaScript
  (then only *Use open chapter* works, one chapter at a time). That single answer
  decides the whole workflow for this site.
- **Do not:** include anything from a chapter that is marked Premium or that
  requires a login. If an ordinary chapter turns out to be gated, stop and say so.

### 2. `tailspace.com`

- **Where to go:** `https://tailspace.com/c/Scale%20Train`, then **scroll mode**
  (not gallery mode — gallery serves `-mini` thumbnails, scroll serves the
  full-size files per the owner's observation).
- **What to pick:** the container holding the page images in scroll mode. Open
  one chapter first (`?page=1` links were observed on the chapter list).
- **What to paste:** that container's outerHTML, plus: how many `<img>` elements
  exist after scrolling to the bottom, whether the image URLs contain `-mini`,
  and whether any page number exists anywhere (file names are hashed, so the
  only usable order may be DOM order).
- **Why:** this site is the test case for the **top-down reader** path: page 1 is
  simply the first image in DOM order, and hashed names must not be "sorted".

### 3. `doujin.desu.xxx`

- **Where to go:** `https://doujin.desu.xxx/manga/irodori-kazoku` and
  `https://doujin.desu.xxx/manga/stop-smoking`, one capture each if they differ.
- **What to pick:** open one chapter, **scroll to the bottom first** (the reader
  loads as you scroll), then pick the container holding all page images.
- **What to paste:** the container's outerHTML, plus: `<img>` count after
  scrolling versus how many pages you can actually see, whether a page total is
  stated on the page, and whether a batch/download link appears (and if it only
  appears once a chapter count is reached, say where it appears).
- **Why:** this site is both a reader case and the entry point to the
  `mirrored.to` batch directory. The reader is whole-image (not diced), and
  right-click/long-press gives no download option, so the tool has to read the
  markup.

### 4. `mirrored.to` — only if a Desu batch page is wanted

- **Where to go:** the `mirrored.to` link directory a Desu batch/download button
  leads to (via the site's own download page, not a guessed URL).
- **What to pick:** the **list of hosts/links** on that directory page — not a
  file, not a file page, not a mirror's interstitial.
- **What to paste:** the container's outerHTML with every host link trimmed to
  `https://mirrored.to/…` shape, plus the list of host names offered.
- **Why:** any helper in this area is required to **stop** at "here is the site's
  download page and these are the hosts" and let the owner choose. No mirror
  automation, no premium bypass, no captcha handling. This capture only tells the
  next session what that page looks like.

### 5. Yurilab — generic capture only

No tailored instructions are recorded here. If a capture is ever needed, use the
generic steps above on a page you are entitled to access, and keep the content
out of any example or test fixture.

## Checklist to fill in for each capture

1. `img` count on the page, and how many of them are page images.
2. Which attribute holds the **real** URL (`src`, `data-src`, `data-lazy-src`,
   `data-original`)? If more than one, say which is full-size.
3. Is there any reliable page number — in the URL, `data-page`, a caption, or the
   file name? If file names are hashes, say "none".
4. Does the reader state its own page total (`3 / 57`, "57 pages")?
5. Is the reader inside an `<iframe>`? If yes, the current probe cannot see it
   (it injects in the main frame only) and the capture should include the iframe
   URL shape trimmed to host + path.

## What the next session does with a capture

1. Choose the selector/attribute/order per site and record them in
   [UNIVERSAL_CHAPTER_TOOL.md](UNIVERSAL_CHAPTER_TOOL.md) as site defaults
   (currently every site uses the generic defaults in the panel).
2. Re-read the container with *Inspect selected chapters* and check the page
   count against the reader's advertised total.
3. Run the benchmark on the same page and save the log
   ([BENCHMARK_GUIDE.md](BENCHMARK_GUIDE.md)) — it confirms the fetch path, the
   scroll container and whether an iframe is in play.
4. Add a sanitized fixture built from the capture (element names and attribute
   shapes only, no real URLs) so the selected strategy is covered by a test.
