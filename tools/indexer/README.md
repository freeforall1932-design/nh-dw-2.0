# nhentai indexer — Route A

Builds the offline library index ([INDEXER_PLAN.md](../../INDEXER_PLAN.md) §2)
by walking nhentai's **documented API v2** politely, then emits the
`.jsonl` file the Library tab imports. Nothing here scrapes HTML or bypasses
anything: the API is the site's own documented door
(`old deprecated source code/NHENTAI_API_V2.md`).

## First run

```bash
node tools/indexer/crawl.js --tags            # tag dictionary (~6 requests)
node tools/indexer/crawl.js --all             # full catalog, newest first
node tools/indexer/crawl.js --finish --gz     # build indexes/nhentai.jsonl(.gz)
```

Then in the extension: **Library → Settings → Index file**.

## Keyed vs anonymous

A key (nhentai account settings → API keys) doubles the documented listing
rate limit (30/min vs 15/min). The client spaces requests from the documented
limits automatically; `--key KEY` or `NHENTAI_API_KEY` env. The key never
leaves your machine and is only sent as `Authorization: Key …` to the API.

## What walks are available

| Mode | What it walks |
| --- | --- |
| `--all` | The whole catalog, newest first (`/galleries`) |
| `--tag-id 17` | One tag, `sort=date` — the shape watches need (§6) |
| `--query "…"` | Any site query — the slicing tool for tags deeper than the listing cap (§8.5) |
| `--tags` | Refreshes the tag dictionary only |

## Resume, caps, honesty

* Every page is appended to `indexes/<job>.cards.jsonl` and state is saved
  **before** the next fetch. A 429, a Cloudflare challenge or a network
  failure exits with code 2 and a message; **rerun the same command** to
  continue. Rerunning never refetches a saved page.
* A 404 past page 1 is the listing-depth cap: the walk keeps what it has and
  tells you to slice deeper fills with `--query` (date-range syntax).
* `--finish` maps cards → §2 rows, **recounts** every tag from the rows, drops
  duplicate cards, and reports (in words) any tag id that was not in the
  dictionary. It never guesses.
* Offline checks: `node tools/indexer/test-crawl.js` (fake fetch, no network;
  round-trips the produced file through the extension's real importer when
  `NHDW_Extension_v3.0.0/build/test` exists).

## Scale honesty (§2/§10)

The catalog walk is thousands of pages: at the polite pace roughly **2–3 h
keyed, 5–6 h anonymous** for `--all` (per_page=100). Overnight job; the output
is one 50–100 MB file. `vanilla + english`-scale *downloads* remain a
separate, much heavier conversation (multi-TB) — the index is only metadata.
