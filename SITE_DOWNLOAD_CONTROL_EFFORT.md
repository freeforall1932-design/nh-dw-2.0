# Archived effort — "use the site's own Download control" (dropped)

**Status: dropped by the owner on 2026-10-30.** Decision in the owner's words:
*if the site download button is too hard, drop it and keep the API keys.* This
file exists so the work is not quietly reopened or re-derived; no code for it was
ever written, and no site markup for a native download control was ever observed.

## What was proposed

A chapter-tool mode that would find a site's own "Download" affordance on the
page the owner is on, instead of fetching pages through the reader:

1. Locate an `<a>`/`<button>` on a **supported** site whose text or `href`
   matched `/download/i`.
2. Require the resulting URL to be `https:` and on that site's **own origin** —
   no synthesising, signing, or following it to a mirror.
3. Hand that URL to `chrome.downloads` with the existing strict completion
   tracking, and let the browser name the file.

## Why it was considered

The owner reported (a live observation, not something this project verified) that
nhentai's own Download control is an ordinary embedded link, that the delivered
ZIP's name carries the id, title and artist, and that the unpacked images are
byte-for-byte the same as reading mode. If that were true generally, it would be
the shortest path to a complete, correctly named archive.

## Why it was dropped

- **Not observable from here.** `https://nhentai.net/` renders gallery cards
  without a Download control in fetched content, and the old test gallery
  (`/g/177013/`) is now a 404. The uploaded "5 website page source" capture is a
  **hentaifox home page**, not a gallery or a reader, so it cannot answer the
  question. Every claim about the control's markup, label or click flow is
  therefore unconfirmed.
- **Guessing is forbidden by the project's own rules.** Text matching alone is
  unsafe: ad blocks on these sites routinely say "Download app"/"Download
  manager". The tool's standing rule is to refuse when markup is ambiguous
  rather than guess — so a text match would have to be backed by real markup on
  each supported site.
- **It would not generalise.** The mode would only ever work on sites whose
  download control the project has actually seen; on every other site it adds a
  button that cannot be trusted, which is worse than no button.
- **The API-key path already covers the owner's use.** The nhentai archive path
  (API key → `/api/v2/galleries/{id}/download?format=`) is implemented, gated and
  documented, and keeps working once a real key is supplied. The native-button
  mode would have competed with it for the same goal.

## What remains true

- Nothing in the extension changed for this idea. There is no hidden flag, no
  half-wired handler, no dead UI. `WORKLIST.md` no longer lists it as a task.
- The owner's observation is still recorded as **evidence, not verification**:
  equal file size and identical unpacked images are consistent with the API path
  being the same source, but they do not exercise delivery, CORS or the native
  click flow. Do not cite it as proof that the API archive is byte-identical.
- The API path stays **off by default** until real delivery is verified; that is
  a separate concern from this archived idea.

## What would reopen it

Only two things, together:

1. A sanitized capture of the actual control (tag, attributes, whether a script
   handler is required, whether the `href` is present before a click) — obtained
   with [CAPTURE_GUIDE.md](CAPTURE_GUIDE.md) / [SITE_CAPTURE_GUIDE.md](SITE_CAPTURE_GUIDE.md)
   rules, no cookies or signed URLs; **and**
2. An explicit owner decision to spend the effort, accepting that it would be
   per-site and refused by default everywhere else.

Without both, do not re-propose it. Do not run searches for third-party download
tools as a substitute — earlier searching found only third-party downloader
extensions, with no authoritative markup for any site's own control.

## Do not retry

- Do not re-fetch `https://nhentai.net/g/177013/` (404) or the nhentai home page
  expecting a Download control.
- Do not treat the hentaifox home-page source capture as evidence about a
  download button.
- Do not implement an anchor-text match and call it "the site's own download" —
  that is exactly the pattern the project rules reject.
