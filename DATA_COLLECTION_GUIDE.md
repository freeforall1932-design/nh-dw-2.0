# Website data collection guide (what I need, step by step)

This is the manual extraction task. I cannot open these sites from where I run:
the sandbox only reaches a handful of developer hosts, so every site URL you sent
before is unreadable to me. Instead of guessing at markup, this page tells you
exactly what to copy, where to click, and what to send back — and how to do it
without leaking a login, a cookie or a signed image URL.

Two things come out of a session:

1. **Captures** — one small text file per site (and later one per reader type).
2. **The log file** — press the benchmark button once and attach the file it
   saves. No guide needed for that part; everything is logged for you.

Nothing here requires an account, a premium chapter or a paid tool.

---

## Part 1 — Set up (once per session, 2 minutes)

1. Make a folder anywhere outside the repository, e.g. `nhdw-captures/`.
   Captures are scratch data: they do not belong in Git and the build never
   reads them.
2. Load the unpacked extension in Chromium (`chrome://extensions` → Developer
   mode → Load unpacked → the `NHDW_Extension_v3.0.0` folder).
3. Open the chapter tool once from the extension (`Chapters ↗`) so you know where
   the **Run benchmark and save log** button is (step 04). You will press it at
   the end.
4. Use a **normal** browser window, not Incognito: captures must reflect what an
   ordinary visitor sees.

Never include in a capture: a password, a cookie, an `Authorization` header, a
signed URL (one with `?token=`, `?expires=`, `?sig=`, `?hash=`), a full HAR, or
any image file. The snippets below strip query strings for you.

---

## Part 2 — Capture the chapter list (the "title page")

This is what the *pseudo-batch* path reads: one page that links every chapter, so
one scan can list a whole title without touching a mirror or a shortener.

1. Open the title page — the series/chapter list, not a chapter.
2. Let it finish loading. If the list has pages (`?page=2`), start on page 1; you
   can mention later pages instead of capturing them.
3. `F12` → **Elements**.
4. `Ctrl+Shift+C`, hover over the list of chapters, click the element that
   **contains all the chapter links** (usually a `<div>`/`<ul>`), not one link.
5. Check the count in the Console first:

   ```js
   document.querySelectorAll('a[href]').length
   ```

   If your selection contains far fewer links than that, step up one level: click
   the parent in the Elements breadcrumb, or type `$0.parentElement` in the
   Console and press Enter to check what it is.

6. Copy it with query strings stripped:

   ```js
   copy($0.outerHTML.replace(/(src|href|data-src|data-lazy-src|data-original)="([^"]*)[?#][^"]*"/g, '$1="$2"'))
   ```

   If `copy()` is rejected because the node is huge, copy the plain outerHTML
   (right-click → Copy → Copy outerHTML) and trim the repeated `<li>` rows down to
   the first three and the last one.

7. Paste into `nhdw-captures/<site>-list.txt`.

**Also write down** (in the same file, at the top): how many chapter links the
page shows, whether the list is paginated and how the next page is linked
(`?page=2`, `/page/2/`, a "load more" button), and whether the chapter rows carry
a date, a volume number or a page count.

---

## Part 3 — Capture the reader (the "chapter page")

This is what decides whether a whole title can be inspected at once (page URLs
present in the HTML) or only one open chapter at a time (built by JavaScript).

1. Open **one ordinary chapter**. Not a Premium/locked chapter, not one behind a
   login.
2. If the reader loads as you scroll (top-down / lazy), scroll to the bottom once,
   then back to the top. This forces the images into the page.
3. `F12` → Elements → `Ctrl+Shift+C` → click the element that **contains all the
   page images** (usually the reader area; the images may sit inside `<a>` or
   `<p>` wrappers, which is fine — pick their common parent).
4. In the Console, confirm you picked the container, not one image:

   ```js
   $0.tagName + ' imgs=' + $0.querySelectorAll('img').length
   ```

   The number must match the pages you can see. If it is 1, you picked a wrapper
   around a single page — step up with `$0.parentElement` and repeat.
5. Copy it with query strings stripped:

   ```js
   copy($0.outerHTML.replace(/(src|href|data-src|data-lazy-src|data-original)="([^"]*)[?#][^"]*"/g, '$1="$2"'))
   ```

6. If the element is enormous (hundreds of pages), keep the first three image
   wrappers and the last one, plus the container's opening and closing tags.
7. Paste into `nhdw-captures/<site>-reader.txt`.

**Then answer these six questions in the same file.** These are what actually
turn a capture into working settings:

```
Site:                     (e.g. example.test)
Page type:                reader
URL shape:                https://example.test/<path-without-query>
Images on the page:       57   (from document.querySelectorAll('img').length)
Images inside container:  57   (from step 4)
Full-size URL attribute:  src | data-src | data-lazy-src | data-original | ? (say which attribute holds the big file)
Thumbnail attribute:      (the attribute that holds a small/`-mini` version, or "none")
Page numbers:             in the link (?page=N) | data-page | caption text | file name | none
Reader states a total:    yes, it says "3 / 57" | no
Server switcher:          yes, labels are "Server 1, Server 2, …" | no
Inside an iframe:         yes (iframe URL shape: https://cdn.example.test/embed/…) | no
Needs scrolling to load:  yes, before scrolling there were 12 images | no
Filenames look like:      hashed (a1B2c3D4e5F6g7H8-mini.jpg) | numbered (001.jpg) | other
Odds and ends:            anything that looked wrong
```

If `document.querySelectorAll('img').length` is 0 or 1 even after scrolling, the
reader is not using `<img>` at all (canvas, background image, `<picture>` or an
iframe). Say so — that is a finding, and it changes what can be supported.

---

## Part 4 — Per-site walkthrough (where to go, what to pick)

Do them in this order. Each one is the same four moves as Part 2/3; only the
location differs.

### 1. `sasangeyou.net` — first

- Go to the home page, choose an **ordinary series** (any chapter marked Premium
  stays out of this entirely), open its **title page**. Capture the chapter list.
- Then open **one ordinary chapter**, let it load, capture the reader container.
- In the answers, the important ones are *Full-size URL attribute*, *Page numbers*
  and *Server switcher*. WordPress manga themes often keep the image URLs in the
  static HTML (then a whole title can be inspected at once) and sometimes need a
  server choice (then it is one server, one chapter at a time).
- If the chapter says Premium or sends you to a paywall/login, stop that capture
  and note it; do not include it.

### 2. `tailspace.com`

- Go to `https://tailspace.com/c/Scale%20Train` (the title page) and capture the
  chapter list.
- Open one chapter. Choose **scroll mode**, not gallery mode — the owner's
  observation is that scroll mode serves full-size files and gallery mode uses
  `-mini` thumbnails. Capture the reader after scrolling to the bottom.
- The answers that matter: *Thumbnail attribute*, *Page numbers* (expect "none";
  file names are hashed), and *Needs scrolling*.

### 3. `doujin.desu.xxx`

- Go to `https://doujin.desu.xxx/manga/irodori-kazoku`, capture the chapter list.
  If `https://doujin.desu.xxx/manga/stop-smoking` looks different, capture that
  list too.
- Open one chapter, scroll to the bottom, capture the reader.
- The answers that matter: *Images inside container* versus pages you can actually
  see (the reader loads as you scroll), *Page numbers*, and whether a
  batch/download button appears on the title page, and if it only appears once a
  chapter count is reached.

### 4. `mirrored.to` — only if you want the site's own batch path mapped

- Reach it through the site's own download button on a Desu batch page, not by
  guessing a URL.
- Capture the **list of hosts/links** on that directory page (trim each link to
  `https://mirrored.to/…`). Do not open a mirror, do not solve anything.
- This capture is only so I can describe the directory. There is no automation of
  mirrors or shorteners in the plan — see
  [SITE_DOWNLOAD_CONTROL_EFFORT.md](SITE_DOWNLOAD_CONTROL_EFFORT.md).

### 5. Yurilab

No tailored steps are recorded here. If a capture is ever needed, use Parts 2 and
3 on a page you are entitled to access and keep the content out of any example or
test fixture.

---

## Part 5 — The log file (press once, attach the file)

At the end of the session, with the source tab open on a chapter page:

1. Chapter tool → step 04 → **Run benchmark and save log**.
2. It presses the page's own controls and puts them back (that is the extension
   testing itself), answers three site questions, and writes
   `nhdw-log-<timestamp>.txt` to your downloads folder.
3. Attach that file. It already has URL queries, cookies, tokens and image data
   removed, so it is safe to share as-is.

If the log shows `FAILED` for a control or for the download service, that is a
real finding — say which site you were on when you pressed it.

---

## Part 6 — What I do with the captures

1. Choose the selector, the URL attribute and the page-order strategy per site,
   and record them as documented defaults (today every site uses the generic
   defaults).
2. Decide pseudo-batch or one-chapter-at-a-time per site: static HTML with real
   image URLs → whole title works; JavaScript-only reader → *Use open chapter*,
   one chapter at a time.
3. Add a sanitized test fixture from the capture (element names, attribute shapes,
   no real URLs) so the strategy stays covered by tests.
4. Tell you exactly what is still unverified, and what the run's log showed.

What I will not do with them: open the site, bypass anything, or automate a
mirror/shortener. If a capture shows the reader is canvas- or iframe-based, the
honest answer is "not supported yet", not a workaround.
