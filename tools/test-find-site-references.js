'use strict';
// Offline checks for tools/find-site-references.js. No network.
const assert = require('assert');
const { CATALOGS, siteTerms, groupResults, formatReport } = require('./find-site-references');

assert.deepStrictEqual(siteTerms('tailspace.com'), { domain: 'tailspace.com', name: 'tailspace' });
assert.deepStrictEqual(siteTerms('https://www.Tailspace.com/c/Scale%20Train'), { domain: 'tailspace.com', name: 'tailspace' });
assert.deepStrictEqual(siteTerms('mangak.io/home'), { domain: 'mangak.io', name: 'mangak' });
assert.deepStrictEqual(siteTerms('reader.example.co.uk'), { domain: 'reader.example.co.uk', name: 'example' });
for (const bad of ['', 'tailspace', 'http://', 'a b.com', 'ftp://x']) assert.strictEqual(siteTerms(bad), null, bad);

// Every catalog has a licence verdict, and GPL is never marked reusable.
for (const c of CATALOGS) {
    assert.ok(c.use === 'reuse' || c.use === 'facts', c.repo);
    assert.strictEqual(/GPL/.test(c.licence), c.use === 'facts', c.repo + ' licence/use mismatch');
}

const items = [
    { repository: { full_name: 'sjhgvr/oisd' }, path: 'abp_nsfw_small.txt' },
    { repository: { full_name: 'mikf/gallery-dl' }, path: 'gallery_dl/extractor/x.py' },
    { repository: { full_name: 'keiyoushi/extensions-source' }, path: 'src/en/tailspace/build.gradle.kts' },
    { repository: { full_name: 'keiyoushi/extensions-source' }, path: 'src/en/tailspace/src/Tailspace.kt' },
    { repository: { full_name: 'keiyoushi/extensions-source' }, path: 'src/en/tailspace/src/Tailspace.kt' },
    null, { repository: null, path: 'x' }
];
const grouped = groupResults(items);
assert.deepStrictEqual(grouped.known.map(h => h.repo), ['keiyoushi/extensions-source', 'mikf/gallery-dl'], 'catalog order, deduplicated');
assert.strictEqual(grouped.known[0].paths.length, 2);
assert.deepStrictEqual(grouped.other.map(h => h.repo), ['sjhgvr/oisd']);

const report = formatReport(siteTerms('tailspace.com'), grouped);
assert.match(report, /keiyoushi\/extensions-source  \[Apache-2\.0 - code may be adapted with attribution\]/);
assert.match(report, /mikf\/gallery-dl  \[GPL-2\.0 - facts only, do not paste code\]/);
assert.match(report, /blob\/HEAD\/src\/en\/tailspace\/build\.gradle\.kts/);
assert.match(report, /DRM-protected sites stay out of scope/);
assert.match(formatReport(siteTerms('nowhere.example'), groupResults([])), /none mention it \(yet\)/);
console.log('PASS: find-site-references offline checks');
