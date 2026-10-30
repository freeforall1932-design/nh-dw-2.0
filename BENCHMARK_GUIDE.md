# Benchmark and log — how to run it, and what the result means

The chapter tool has two diagnostic controls in **step 04** of
[`chapters.html`](NHDW_Extension_v3.0.0/chapters.html):

- **Run benchmark and save log** — five read-only checks against the tab you have
  open, then saves a log file to your downloads folder.
- **Save log without benchmark** — saves the same file without touching the tab.

Both exist because "it didn't work" is not a bug report. The log records what the
extension itself saw, with secrets and page bytes removed, so a real-browser
session produces a file you can attach instead of a screenshot or a console copy
that disappears on reload.

Nothing here has been exercised in a real browser yet. It is built to be the
first thing you run when you do, and it is written to fail safely: it can report
a problem, but it cannot approve a host, start a download or build an archive.

## Before you press it

| You are on…                        | What the benchmark can tell you |
| ---------------------------------- | ------------------------------- |
| a chapter / reader page            | Everything: tab reach, reader page count, hosts, one real page image (if a host is already remembered), the scroll container, storage |
| a title page / homepage            | Tab reach and how many chapter links it can see; the reader steps report "no page images", which is expected and not a failure |
| a page behind a login/premium door | Only that the tool was refused the images. It cannot and will not sign in |
| a tab that was closed or reloaded  | Step 1 fails with a message telling you to reopen the source page and scan again |

Use the same tab you would use for a real save. The extension is injected into
that tab only when you press a button (never automatically).

## The five steps

1. **Reach the source tab.** Injects the probe (the same `activeTab` +
   `chrome.scripting` injection a normal scan uses) and reads the open page's
   origin, title and URL. Reports milliseconds. *No network.*
2. **Count chapter links.** Runs the same discovery as *Scan title page* with
   your current selector settings, and reports how many chapter links it sees
   and whether the 200-item list limit was hit. *No network.* A chapter page
   normally reports zero — that is the correct answer, not a bug.
3. **Read page images.** Runs the same inspection as *Inspect selected
   chapters* on the open page (DOM only, "Use open chapter" mode): image count,
   the reader's advertised page total if it states one, the hosts involved, the
   resolved order and a preview. *No network.*
4. **One page image + the scroll container.** Two jobs:
   - Fetches **one** page image, and only from a host you have already approved
     for this exact site. If nothing is remembered yet it says so and skips —
     the benchmark never approves hosts on your behalf. Reports KB, pixel
     dimensions, format, host and milliseconds, so a page that is actually a
     spacer or an HTML error page shows up here.
   - Sweeps the reader top to bottom twenty scroll steps, then puts the scroll
     position back. This is what reports which element actually scrolls
     (`window` or e.g. `div#reader`), the `<img>` count, the iframe count and
     whether the sweep reached the bottom.
5. **Storage round-trip.** Writes a single timestamp under a private key, reads
   it back and removes it. Confirms the extension can keep remembered hosts,
   saved-chapter records and the log itself.

Then the log is written.

## What it deliberately does not do

- No archive is built and no download starts.
- No host is approved; the page fetch only happens for an origin you already
  approved in a previous save.
- No batch link, mirror, shortener or premium chapter is touched.
- No cookie, credential or signed URL is read, and none is written to the log.
- It does not scroll a title page (only a page where step 3 found page images),
  and it restores the scroll position afterwards.

## The log file

- Saved to your normal downloads folder as `nhdw-log-<ISO timestamp>.txt`
  (colons replaced so the name is portable). The browser may add `(1)` if you
  save twice in the same second.
- The same entries are kept in `chrome.storage.local` under `nhdwExtensionLog`,
  capped at **500** entries, so the record survives closing the tool tab. The
  saved file and the stored buffer are the same content.
- Format: one header block, then one line per entry:

  ```
  NHDW extension log
  generated: 2026-10-30T04:12:55.031Z
  extension: 3.14.0
  page: chrome-extension://<id>/chapters.html
  userAgent: Mozilla/5.0 …
  rememberedApprovalOrigins: 2
  recordedTitles: 3
  entries: 19 (oldest first)

  2026-10-30T04:11:02Z INFO  [start]     Chapter tool opened {"tabId":7,"version":"3.14.0"}
  2026-10-30T04:11:02Z INFO  [benchmark] Source tab reached {"ms":42,"origin":"https://example.test/","page":"https://example.test/manga/x/chapter-3","title":"…"}
  2026-10-30T04:11:03Z INFO  [benchmark] Reader inspected {"pages":41,"advertised":41,"hosts":["cdn.example.test"],"order":"reader","differs":false}
  2026-10-30T04:11:04Z ERROR [benchmark] Page image fetch failed {"message":"…","code":"approval"}
  ```

- Levels: `INFO` (normal), `WARN` (something partial), `ERROR` (a step failed).
- Timestamps are UTC, shown to the second.
- A bare origin is written with its path, so `https://example.test` appears as
  `https://example.test/`. That is the redaction rule, not a different site.

### What is redacted, and why

Redaction happens on the way **in**, not on export, so a secret cannot sit in
storage waiting to be forgotten:

- URLs keep scheme, host and path; **query and fragment are dropped**, which is
  where signed URLs and tokens live.
- Keys named `cookie`, `authorization`, `token`, `key`, `secret`, `signature`,
  `body`, `bytes`, `content` and similar are replaced by `<redacted>`.
- `data:` and `blob:` URLs become `<data payload>`; long base64-looking strings
  become `<base64 N chars>`.
- Image bytes are never passed to the logger at all — only size, dimensions,
  format and host.
- Strings are truncated at 300 characters, and nesting stops at depth 4.

## How to read the result

| What you see | What it means |
| ------------ | ------------- |
| "Tab reached in 42 ms" | Injection works on this site |
| "Reader: 0 page image(s)" on a chapter page | The selector/attribute pair does not match this reader yet — see [OUTER_HTML_GUIDE.md](OUTER_HTML_GUIDE.md) |
| "Reader: 41 page image(s) of 41 advertised" | The reader states its own total and both agree |
| "Reader: 12 page image(s) of 57 advertised" | Lazy loading: press **Load all pages (top-down)** on the reader tab, then inspect again |
| "Page image: skipped, no host is remembered for this site yet" | Expected on a first run. Do one normal save, or approve hosts once, then re-run |
| "Page image: 180 KB, 1200×1800, jpg from cdn…" | A real page came through the full path |
| "Page image: failed (too-small)" | The site served a spacer/tracker for that index; `too-small` is the dimension gate working |
| "Scroll: 20 step(s) on div#reader, 41 image(s), 0 iframe(s), reached the bottom" | The inner scroll container was found and swept — this is the case that used to silently do nothing |
| "Scroll: … did not reach the bottom" | Either a very long reader (raise the step count) or content that grows faster than it scrolls |
| "Storage: round-trip ok" | Remembered hosts, saved-chapter records and this log can persist |
| "Benchmark stopped: Cannot reach the source tab" | That tab was closed or navigated away; reopen it and scan |

A "skipped" step is not a failure and does not count toward the problem total in
the status line. Only a real error (a failed fetch, a broken scroll sweep, a bad
storage round-trip) increments it.

## What to send back after a real-browser run

1. The `nhdw-log-….txt` file itself.
2. Which site and whether you were on a title page or a chapter page.
3. Your Chrome version and whether the build was loaded unpacked.
4. What you expected to happen versus what did.

Do not send cookies, a HAR export, signed image URLs or page images. The log is
already redacted; anything else you paste should be too. See
[SITE_CAPTURE_GUIDE.md](SITE_CAPTURE_GUIDE.md) for the rules on sanitized captures.
