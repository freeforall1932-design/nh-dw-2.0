# Tailspace — the current focus

DoujinDesu and Sasangeyou are on hold (see the likelihood table in
[EXTENSION_PARSER_RESEARCH.md](EXTENSION_PARSER_RESEARCH.md#6-how-likely-is-each-site-now)).
Tailspace is the site this build is aimed at, because it is the one whose known
shape already fits the tool: a top-down/scroll reader with hashed file names and
no page numbers anywhere.

Everything below is **unverified**. No Tailspace page has ever been fetched from
here (the sandbox cannot reach it), so this is a plan built from what the owner
reported plus what the code now does.

## What is known

| Fact | Source | Consequence |
| --- | --- | --- |
| `https://tailspace.com/c/Scale%20Train` is a title page with `?page=N` links, 7 pages | owner's earlier report | the title list can be scanned directly; `?page=N` also means the *list* is paginated |
| Scroll mode serves full-size files; gallery mode serves `-mini` thumbnails | owner | **prefer scroll mode**; the suffix rule exists for when gallery mode is the only option |
| File names are hashed (`…-mini.jpg`) with no page numbers | owner | no file-name ordering; DOM order is the only trustworthy order |
| No extension exists for it in `keiyoushi/extensions-source` | checked 2026-10-31 | nothing to copy; it needs a capture or a live run |

## What this build already does for it

1. **Top-down readers.** Page 1 is simply the first image in DOM order; an
   advertised page total is compared with what was found; a bounded scroll sweep
   forces lazy images in.
2. **Inner scroll containers.** If the reader scrolls an inner element instead of
   the window, that element is detected from measured overflow, swept, and the
   scroll position restored.
3. **Explicit thumbnail suffix rule** (new). When the reader only lists
   `…-mini.jpg`, typing `-mini` derives `….jpg` for **every** page or refuses the
   chapter. Nothing is inferred from the file name; it is off unless you type it;
   the review says how many URLs the rule changed; the log records it.
4. **Remembered reader settings per site** (new). Once you find the selector /
   attribute / order / suffix that works, "Remember these reader settings for this
   site" stores them against `https://tailspace.com` and fills the panel in next
   time. Re-validated on read; forgettable; capped at 50 sites.
5. **Spacer and thumbnail rejection.** A page under 128 px (or a non-image
   response) is refused at fetch time and again before zipping, so a lazy-loader
   placeholder can never end up in an archive.
6. **Resume.** Complete archives are recorded per title, so a 7-chapter title
   survives an interruption without re-downloading what is already on disk.

## What to do, in this order

1. Load the unpacked build, open a **title page** and one chapter in **scroll
   mode**, then press **Run benchmark and save log** (chapter tool, step 04).
   The log answers, in one file: how many chapter links the title page exposes,
   how many page images the reader has, the hosts, whether the reader states a
   total, **which element scrolls**, and whether an iframe is involved.
2. If the log says the reader has page images and the right count, scan the title,
   tick the chapters, choose *Reader order*, inspect, approve the image host, save.
3. If the log says the reader has **no** page images but does mention an iframe or
   says the count is far below the real one, stop and capture the reader
   ([DATA_COLLECTION_GUIDE.md](DATA_COLLECTION_GUIDE.md) Part 3). That is a
   different feature (iframe support or a different reader strategy), not a
   setting.
4. If only gallery mode is usable, put `-mini` in the suffix field and check the
   review line "full-size rule removed “-mini” from N URL(s)" — if that line
   appears, every page was converted; if the chapter is refused, some URLs do not
   carry the tail and the rule is wrong for that reader.
5. Save once, then press "Remember these reader settings for this site" so the
   rest of the title needs no setup.

## What is still unknown (and would be a real blocker)

- Whether the scroll-mode reader is plain `<img>` elements. If it is canvas or a
  background image, this tool cannot read it — that would need a different
  approach and an honest "not supported".
- Whether full-size images sit on a CDN that sends no CORS headers. The probe
  fetches with `credentials: "same-origin"`, no referrer and no forged headers;
  a CDN without CORS fails by design.
- Whether the title list is paginated beyond what was observed, and whether
  chapters also exist outside `/c/…` paths.
- Whether `?page=N` on the title page means "page N of the title list" or
  "chapter N". If both, the scan needs the right one and the review will show it.

## Deliberately not part of this

No mirror/shortener handling, no premium or logged-in material, no bypasses, and
no guessed URL patterns (no automatic `-mini` stripping, no synthesised page
numbers, no inferred chapter order beyond what the reader states).
