'use strict';
// The indexer CLI (INDEXER_PLAN.md §3, Route A): walks nhentai's documented
// API v2 politely, appends gallery cards to a resumable job file, and maps
// them into the §2 index text the Library tab imports.
//
// Modes:
//   node crawl.js --all                       walk the whole catalog (newest first)
//   node crawl.js --tag-id 17                 walk one tag, sort=date (§6 pin)
//   node crawl.js --query "language:english"  walk any site query
//   node crawl.js --tags                      refresh the tag dictionary dump
//   node crawl.js --finish --job nhentai-all  build indexes/<site>.jsonl
//
// Every walk is RESUMABLE: state lands on disk after each page, so a 429, a
// Cloudflare challenge or a network failure stops the run cleanly (exit 2)
// and rerunning the same command continues where it stopped. A 404 past
// page 1 is reported as the listing-depth cap (§8.5) with the suggested
// --query slicing, never retried in a loop.
//
// Politeness defaults come from the documented rate limits (API_V2.md):
// ~4.2 s between requests anonymous, ~2.1 s with a key. --min-interval-ms
// can only slow this down further, never the default speed up beyond the
// documented limit.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
    ApiError,
    RateLimitedError,
    ChallengeError,
    NotFoundError,
    createClient,
    resultOf,
    numPagesOf,
} = require('./nhentaiApi');
const { mapCardsFile } = require('./mapCards');

const DEFAULT_OUT_DIR = path.join(__dirname, 'indexes');
const TAG_TYPES = ['tag', 'artist', 'group', 'character', 'parody', 'language']; // `category` has no §2 namespace

const USAGE = `nhentai indexer (INDEXER_PLAN.md phase 2, Route A)

Walk the API (one mode per run):
  --all                      walk the full catalog, newest first
  --tag-id <number>          walk one tag (sort=date, newest first)
  --query "<query>"          walk any site query string
  --tags                     fetch/refresh the tag dictionary (no walk)

Options:
  --key <key>                API key (Authorization: Key ...); or env NHENTAI_API_KEY
  --no-verify                skip the key check against /user
  --base-url <url>           default https://nhentai.net
  --per-page <n>             cards per page (default 100, the documented max)
  --max-pages <n>            stop after n pages this run (rerun to continue)
  --min-interval-ms <ms>     floor for the request gap (defaults follow the docs)
  --job <name>               job name (default derived from the mode)
  --out <dir>                output directory (default tools/indexer/indexes)
  --sort <sort>              tagged walks: date (default) | popular | popular-today |
                             popular-week | popular-month — watches must keep date
  --finish                   build indexes/<site>.jsonl from a finished walk
  --site <slug>              index site slug for --finish (default nhentai)
  --gz                       also write a gzip copy next to the index file

Exit codes: 0 complete · 1 usage/configuration · 2 stopped, resumable.

Examples:
  node crawl.js --tags
  node crawl.js --all --key MYKEY
  node crawl.js --tag-id 17 --max-pages 500
  node crawl.js --finish --job nhentai-all --gz
`;

// ------------------------------------------------------------------ args

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            args._.push(token);
            continue;
        }
        const name = token.slice(2);
        switch (name) {
            case 'all':
            case 'tags':
            case 'finish':
            case 'no-verify':
            case 'gz':
                args[name] = true;
                break;
            case 'key':
            case 'query':
            case 'base-url':
            case 'job':
            case 'out':
            case 'sort':
            case 'site':
                args[name] = argv[++i];
                break;
            case 'tag-id':
            case 'per-page':
            case 'max-pages':
            case 'min-interval-ms': {
                const value = Number(argv[++i]);
                if (!Number.isFinite(value) || value <= 0) {
                    throw new UsageError('--' + name + ' needs a positive number');
                }
                args[name] = value;
                break;
            }
            case 'help':
                args.help = true;
                break;
            default:
                throw new UsageError('unknown option --' + name);
        }
    }
    return args;
}

class UsageError extends Error {}

function jobNameFor(args) {
    if (args.job) return args.job;
    if (args.all) return 'nhentai-all';
    if (args['tag-id']) return 'nhentai-tag-' + args['tag-id'];
    if (args.query) {
        const slug = String(args.query).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        return 'nhentai-query-' + (slug || 'x');
    }
    throw new UsageError('pick a mode: --all, --tag-id, --query or --tags (see --help)');
}

function modeParams(args) {
    if (args.all) return { mode: 'all' };
    if (args['tag-id']) return { mode: 'tagged', tagId: args['tag-id'], sort: args.sort || 'date' };
    return { mode: 'query', query: args.query };
}

// ------------------------------------------------------------------ io

/** Real filesystem io rooted at `outDir`; state writes are atomic (tmp+rename). */
function makeFsIo(outDir, fsImpl) {
    const fsx = fsImpl || fs;
    fsx.mkdirSync(outDir, { recursive: true });
    return {
        outDir,
        cardsPath: (job) => path.join(outDir, job + '.cards.jsonl'),
        statePath: (job) => path.join(outDir, job + '.state.json'),
        tagsPath: () => path.join(outDir, 'nhentai-tags.json'),
        indexPath: (site, gz) => path.join(outDir, site + '.jsonl' + (gz ? '.gz' : '')),
        appendCards(job, cards) {
            const body = cards.map((card) => JSON.stringify(card)).join('\n') + '\n';
            fsx.appendFileSync(this.cardsPath(job), body);
        },
        readState(job) {
            try {
                return JSON.parse(fsx.readFileSync(this.statePath(job), 'utf8'));
            } catch (_) {
                return null;
            }
        },
        writeState(job, state) {
            const target = this.statePath(job);
            const tmp = target + '.tmp';
            fsx.writeFileSync(tmp, JSON.stringify(state, null, 2));
            fsx.renameSync(tmp, target);
        },
        writeTagsDump(dump) {
            fsx.writeFileSync(this.tagsPath(), JSON.stringify(dump, null, 2));
        },
        readTagsDump() {
            try {
                return JSON.parse(fsx.readFileSync(this.tagsPath(), 'utf8'));
            } catch (_) {
                return null;
            }
        },
        readCards(job) {
            try {
                return fsx.readFileSync(this.cardsPath(job), 'utf8');
            } catch (_) {
                return null;
            }
        },
        writeIndex(site, text, gz) {
            const target = this.indexPath(site, false);
            fsx.writeFileSync(target, text);
            if (gz) fsx.writeFileSync(this.indexPath(site, true), zlib.gzipSync(Buffer.from(text, 'utf8')));
            return target;
        },
    };
}

// ------------------------------------------------------------------ walk

function pageFetcher(client, params, perPage) {
    if (params.mode === 'all') return (page) => client.getGalleriesPage(page, perPage);
    if (params.mode === 'tagged') return (page) => client.getTaggedPage(params.tagId, page, perPage, params.sort);
    return (page) => client.getSearchPage(params.query, page, perPage);
}

/**
 * Walk one job to completion (or to a stop). Appends cards after every page
 * and saves state BEFORE the next fetch, so an interruption loses at most
 * one page of work and never skips ahead of its cards.
 */
async function walkJob({ client, io, job, params, perPage, maxPages, log }) {
    const say = log || console.log;
    let state = io.readState(job);
    if (state && state.params && JSON.stringify(state.params) !== JSON.stringify(params)) {
        throw new UsageError('job "' + job + '" exists with different parameters (' +
            JSON.stringify(state.params) + ') — use another --job name or delete ' + io.statePath(job));
    }
    if (!state) state = { job, params, nextPage: 1, pagesDone: 0, cardsDone: 0, done: false, updatedAt: null };
    if (state.done) {
        say('job "' + job + '" already walked ' + state.cardsDone + ' cards; run --finish --job ' + job + ' to build the index.');
        return { stopped: false, done: true, state };
    }

    const fetchPage = pageFetcher(client, params, perPage);
    const startedAt = Date.now();
    let numPages = null;

    while (true) {
        if (maxPages && state.pagesDone >= maxPages) {
            say('stopped at --max-pages ' + maxPages + ' for this run; rerun the same command to continue.');
            return { stopped: true, done: false, state, reason: 'max-pages' };
        }
        const page = state.nextPage;
        say('page ' + page + (numPages ? '/' + numPages : '') + ' …');
        let listing;
        try {
            listing = await fetchPage(page);
        } catch (error) {
            if (error instanceof NotFoundError && page > 1) {
                // Listing-depth cap (§8.5): the site refuses deeper pages.
                // Watches stay safe because they early-stop on known ids;
                // deep fills must slice by query.
                state.done = true;
                state.capped = true;
                io.writeState(job, state);
                say('the listing refused page ' + page + ' (404) — this source paginates only so deep. ' +
                    'The walk kept the first ' + state.pagesDone + ' pages; for more, slice with --query date ranges.');
                return { stopped: true, done: true, state, reason: 'cap' };
            }
            if (error instanceof RateLimitedError || error instanceof ChallengeError || error instanceof ApiError) {
                io.writeState(job, state);
                say(error.message);
                say('state saved after ' + state.pagesDone + ' pages / ' + state.cardsDone + ' cards — rerun the same command to resume.');
                return { stopped: true, done: false, state, reason: error.name };
            }
            throw error;
        }

        if (numPages === null) numPages = numPagesOf(listing, perPage);
        const cards = resultOf(listing);
        if (cards.length === 0) {
            state.done = true;
            io.writeState(job, state);
            say('walk complete: ' + state.pagesDone + ' pages, ' + state.cardsDone + ' cards. ' +
                'Run --finish --job ' + job + ' to build the index file.');
            return { stopped: false, done: true, state };
        }

        io.appendCards(job, cards);
        state.pagesDone += 1;
        state.cardsDone += cards.length;
        state.nextPage = page + 1;
        state.updatedAt = new Date().toISOString();
        io.writeState(job, state);

        if (numPages !== null && state.nextPage > numPages) {
            state.done = true;
            io.writeState(job, state);
            say('walk complete: ' + state.pagesDone + ' pages, ' + state.cardsDone + ' cards. ' +
                'Run --finish --job ' + job + ' to build the index file.');
            return { stopped: false, done: true, state };
        }
        const elapsedPages = state.pagesDone;
        const rate = (Date.now() - startedAt) / elapsedPages;
        if (numPages !== null) {
            const remaining = Math.max(0, numPages - state.nextPage + 1);
            say('  kept ' + state.cardsDone + ' cards; ' + remaining + ' pages left, roughly ' +
                Math.round((remaining * rate) / 60000) + ' min at the polite pace.');
        }
    }
}

// ------------------------------------------------------------------ finish

function finishJob({ io, job, site, gz, log }) {
    const say = log || console.log;
    const cardsText = io.readCards(job);
    if (cardsText === null) {
        throw new UsageError('no card file for job "' + job + '" at ' + io.cardsPath(job));
    }
    const tagsDump = io.readTagsDump();
    if (!tagsDump) {
        say('no tag dictionary at ' + io.tagsPath() + ' — run --tags first, or cards with bare tag_ids will lose those tags.');
    }
    const mapped = mapCardsFile(cardsText, tagsDump || [], site || 'nhentai');
    const target = io.writeIndex(site || 'nhentai', mapped.text, !!gz);
    say('wrote ' + target + ' (' + Buffer.byteLength(mapped.text, 'utf8') + ' bytes' +
        (gz ? ', gzip copy beside it' : '') + ')');
    say('mapped ' + mapped.stats.mappedRows + ' titles, ' + mapped.stats.tagCount + ' tags' +
        (mapped.stats.duplicateCards ? '; ' + mapped.stats.duplicateCards + ' duplicate card(s) dropped' : '') +
        (mapped.stats.skippedCards ? '; ' + mapped.stats.skippedCards + ' unusable card(s) skipped' : ''));
    if (mapped.stats.droppedTagIds.length > 0) {
        say(mapped.stats.droppedTagIds.length + ' tag id(s) on the cards are not in the dictionary and were dropped from those rows — refresh with --tags and re-run --finish.');
    }
    say('Import it in the Library tab: Settings → Index file.');
    return mapped;
}

// ------------------------------------------------------------------ tags dump

async function writeTagsDump({ client, io, log }) {
    const say = log || console.log;
    const dump = [];
    for (const type of TAG_TYPES) {
        const tags = await client.getTagsOfType(type);
        say(type + ': ' + tags.length + ' tags');
        for (const tag of tags) {
            if (tag && Number.isFinite(tag.id)) {
                dump.push({ id: tag.id, type, name: tag.name, count: tag.count });
            }
        }
    }
    io.writeTagsDump(dump);
    say('tag dictionary: ' + dump.length + ' tags at ' + io.tagsPath());
    return dump;
}

// ------------------------------------------------------------------ main

async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.log(USAGE);
        console.log('error: ' + error.message);
        return 1;
    }
    if (args.help || (args._.length === 0 && !args.all && !args['tag-id'] && !args.query && !args.tags && !args.finish)) {
        console.log(USAGE);
        return 0;
    }

    const outDir = args.out || DEFAULT_OUT_DIR;
    const io = makeFsIo(outDir);
    const log = console.log;
    const apiKey = args.key || process.env.NHENTAI_API_KEY || '';
    const perPage = args['per-page'] || 100;
    if (perPage > 100) throw new UsageError('--per-page caps at the documented 100');

    if (args.finish) {
        const job = jobNameFor(args);
        finishJob({ io, job, site: args.site, gz: args.gz, log });
        return 0;
    }

    const client = createClient({
        baseUrl: args['base-url'],
        apiKey,
        minIntervalMs: args['min-interval-ms'],
        log,
    });

    if (apiKey && !args['no-verify']) {
        const profile = await client.verifyKey();
        log('key OK — signed in as ' + profile.username);
    }

    if (args.tags) {
        await writeTagsDump({ client, io, log });
        return 0;
    }

    const job = jobNameFor(args);
    const params = modeParams(args);
    const outcome = await walkJob({
        client,
        io,
        job,
        params,
        perPage,
        maxPages: args['max-pages'],
        log,
    });
    if (outcome.done && !outcome.stopped) {
        log('now run: node crawl.js --finish ' + (args.job ? '--job ' + args.job : '') + (args.gz ? ' --gz' : ''));
        return 0;
    }
    return outcome.reason === 'max-pages' ? 0 : 2;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }).catch((error) => {
        console.log('error: ' + (error && error.message ? error.message : String(error)));
        process.exitCode = 1;
    });
}

module.exports = {
    parseArgs,
    UsageError,
    jobNameFor,
    modeParams,
    makeFsIo,
    walkJob,
    finishJob,
    writeTagsDump,
    DEFAULT_OUT_DIR,
    TAG_TYPES,
    USAGE,
};
