#!/usr/bin/env node
'use strict';
/*
 * Step 0 for any new or "undocumented" site: has an open-source project already
 * worked it out? (Tailspace had a keiyoushi source three weeks before we
 * looked again - see TAILSPACE_PLAN.md.)
 *
 *   node tools/find-site-references.js tailspace.com
 *
 * Runs two GitHub code searches through the GitHub CLI (`gh`, already signed in)
 * or, without it, the REST API with GITHUB_TOKEN. Code search needs a signed-in
 * user and allows about 10 searches a minute, so it makes exactly two:
 *   1. the domain anywhere on GitHub;
 *   2. the bare site name inside the known scraper catalogs below (some
 *      sources build the base URL from parts, so the domain is not always a
 *      literal).
 * It only reads public search results; it never visits the site itself.
 *
 * What may be reused depends on the licence - printed next to every hit:
 *   reuse  Apache-2.0 / MIT / Unlicense: code may be adapted with attribution
 *          (THIRD_PARTY_NOTICES if anything is copied).
 *   facts  GPL: read for facts (URLs, JSON field names, headers) and write our
 *          own code; never paste.
 * Findings still need one live confirmation: sites change, and a phone app is
 * not subject to the browser rules (CORS, referrer) that the extension is.
 * Sites behind DRM are out of scope however well documented elsewhere.
 */
const { execFileSync } = require('child_process');

// Licences checked 2026-11-25 via the GitHub API (archived repos still help).
const CATALOGS = [
    { repo: 'keiyoushi/extensions-source', licence: 'Apache-2.0', use: 'reuse', what: 'Mihon/Tachiyomi sources (Kotlin)' },
    { repo: 'manga-download/haruneko', licence: 'Unlicense', use: 'reuse', what: 'HaruNeko web connectors (TypeScript)' },
    { repo: 'Aidoku-Community/sources', licence: 'Apache-2.0', use: 'reuse', what: 'Aidoku sources (Rust)' },
    { repo: 'HDoujinDownloader/HDoujinDownloader', licence: 'MIT', use: 'reuse', what: 'HDoujinDownloader modules (Lua)' },
    { repo: 'kodjodevf/mangayomi-extensions', licence: 'Apache-2.0', use: 'reuse', what: 'Mangayomi sources (Dart/JS, archived)' },
    { repo: 'tachiyomiorg/extensions', licence: 'Apache-2.0', use: 'reuse', what: 'old Tachiyomi sources (archived)' },
    { repo: 'mikf/gallery-dl', licence: 'GPL-2.0', use: 'facts', what: 'gallery-dl extractors (Python)' },
    { repo: 'jbsparrow/CyberDropDownloader', licence: 'GPL-3.0', use: 'facts', what: 'Cyberdrop-DL crawlers (Python)' },
    { repo: 'KotatsuApp/kotatsu-parsers', licence: 'GPL-3.0', use: 'facts', what: 'Kotatsu parsers (Kotlin, archived)' }
];

/** "https://www.Tailspace.com/c/x" -> { domain: "tailspace.com", name: "tailspace" } */
function siteTerms(input) {
    let host = String(input || '').trim().toLowerCase();
    try { if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname; } catch (_) { host = ''; }
    host = host.replace(/^www\./, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    const labels = host.split('.');
    const name = labels.length > 2 && labels[labels.length - 2].length <= 3 ? labels[labels.length - 3] : labels[labels.length - 2];
    return { domain: host, name };
}

function catalogFor(repo) {
    return CATALOGS.find(c => c.repo.toLowerCase() === String(repo || '').toLowerCase()) || null;
}

/** Group raw search items: known catalogs first (with licence advice), the rest after. */
function groupResults(items) {
    const known = new Map(), other = new Map();
    for (const item of items || []) {
        if (!item || !item.repository || !item.path) continue;
        const repo = item.repository.full_name;
        const target = catalogFor(repo) ? known : other;
        if (!target.has(repo)) target.set(repo, new Set());
        target.get(repo).add(item.path);
    }
    const order = (map, rank) => Array.from(map.entries())
        .map(([repo, paths]) => ({ repo, paths: Array.from(paths).sort(), catalog: catalogFor(repo) }))
        .sort((a, b) => rank(a) - rank(b) || a.repo.localeCompare(b.repo));
    return {
        known: order(known, r => CATALOGS.indexOf(r.catalog)),
        other: order(other, r => -r.paths.length)
    };
}

function formatReport(terms, grouped) {
    const lines = [];
    lines.push('Site: ' + terms.domain + '  (also searched catalogs for "' + terms.name + '")', '');
    if (grouped.known.length) {
        lines.push('Known scraper projects:');
        for (const hit of grouped.known) {
            const c = hit.catalog;
            lines.push('  ' + hit.repo + '  [' + c.licence + ' - ' + (c.use === 'reuse' ? 'code may be adapted with attribution' : 'facts only, do not paste code') + ']');
            for (const p of hit.paths.slice(0, 8)) lines.push('      https://github.com/' + hit.repo + '/blob/HEAD/' + p.split('/').map(encodeURIComponent).join('/'));
            if (hit.paths.length > 8) lines.push('      ... ' + (hit.paths.length - 8) + ' more file(s)');
        }
    } else {
        lines.push('Known scraper projects: none mention it (yet). Next: website template / framework');
        lines.push('checks (UNIVERSAL_CHAPTER_TOOL.md), then the benchmark log, then a capture.');
    }
    lines.push('');
    const other = grouped.other.slice(0, 15);
    if (other.length) {
        lines.push('Other repositories (check each licence; block lists and unrelated matches are common):');
        for (const hit of other) lines.push('  ' + hit.repo + '  ' + hit.paths.slice(0, 2).join(', ') + (hit.paths.length > 2 ? ' ...' : ''));
        lines.push('');
    }
    lines.push('Before relying on a finding: confirm it once on the live site (sites change; phone apps');
    lines.push('ignore browser rules such as CORS). DRM-protected sites stay out of scope.');
    return lines.join('\n');
}

function search(query) {
    try {
        const out = execFileSync('gh', ['api', '-X', 'GET', 'search/code', '-f', 'q=' + query, '-f', 'per_page=100'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return Promise.resolve(JSON.parse(out).items || []);
    } catch (error) {
        if (error && error.code !== 'ENOENT') {
            return Promise.reject(new Error('gh search failed (signed in? rate limit is ~10/min): ' + String(error.stderr || error.message).trim()));
        }
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) return Promise.reject(new Error('Install/sign in to the GitHub CLI (gh) or set GITHUB_TOKEN: code search needs a signed-in user.'));
    const url = 'https://api.github.com/search/code?per_page=100&q=' + encodeURIComponent(query);
    return fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('GitHub API ' + r.status)))
        .then(j => j.items || []);
}

async function main(argv) {
    const terms = siteTerms(argv[0]);
    if (!terms) {
        console.error('Usage: node tools/find-site-references.js <domain or URL>   e.g. tailspace.com');
        process.exitCode = 2;
        return;
    }
    const anywhere = await search('"' + terms.domain + '"');
    const inCatalogs = await search(terms.name + ' ' + CATALOGS.map(c => 'repo:' + c.repo).join(' '));
    console.log(formatReport(terms, groupResults(anywhere.concat(inCatalogs))));
}

module.exports = { CATALOGS, siteTerms, groupResults, formatReport };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
