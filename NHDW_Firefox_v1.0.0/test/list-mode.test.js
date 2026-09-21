// List-mode download options: the shared format registry, the
// separate-vs-batch output mode, the PDF-merge guard and the list-mode
// filename template resolution.
//
// These are the rules that make list mode (homepage / search / artist / tag /
// genre windows) behave like the single-title popup instead of always
// producing one URL-named ZIP. No browser needed: the module under test is
// dependency-free and compiled into build/test by tsconfig.test.json.

const assert = require('assert');
const {
    DOWNLOAD_FORMATS,
    OUTPUT_MODES,
    LIST_MODE_DEFAULTS,
    LIST_TEMPLATE_INHERIT,
    PDF_MERGE_WARNING_KEY,
    effectiveOutputMode,
    formatExtension,
    formatLabel,
    isInheritedListTemplate,
    normalizeFormat,
    normalizeFormatOverride,
    normalizeOutputMode,
    outputModeToSeparate,
    resolveJobFormat,
    resolveListFormat,
    resolveListTemplate,
    shouldWarnPdfMerge,
    supportsBatchMerge
} = require('../build/test/utils/downloadFormats.js');
const { buildListSettings, readListSettings, resolveMasterFolder, saveListSettings } = require('../build/test/utils/listSettings.js');
const { readStorage } = require('../scripts/test-support/storage');
const { formatCases, formats } = require('../scripts/test-support/list-format-cases');

describe('shared download format registry', () => {
    it('exposes exactly the four formats offered on a title page', () => {
        assert.deepStrictEqual(Array.from(DOWNLOAD_FORMATS), ['zip', 'cbz', 'pdf', 'raw']);
    });

    it('maps the retired "folder" format to PDF everywhere', () => {
        assert.strictEqual(normalizeFormat('folder'), 'pdf');
    });

    it('falls back for unknown/empty values instead of inventing a format', () => {
        assert.strictEqual(normalizeFormat(undefined), 'zip');
        assert.strictEqual(normalizeFormat(''), 'zip');
        assert.strictEqual(normalizeFormat('rar'), 'zip');
        assert.strictEqual(normalizeFormat('rar', 'cbz'), 'cbz');
        assert.strictEqual(normalizeFormat(null, 'pdf'), 'pdf');
    });

    it('keeps every valid format untouched', () => {
        for (const format of DOWNLOAD_FORMATS) {
            assert.strictEqual(normalizeFormat(format), format);
        }
    });

    it('gives raw no extension and every archive format its own', () => {
        assert.strictEqual(formatExtension('zip'), '.zip');
        assert.strictEqual(formatExtension('cbz'), '.cbz');
        assert.strictEqual(formatExtension('pdf'), '.pdf');
        assert.strictEqual(formatExtension('raw'), '');
    });

    it('labels raw as the format still under test', () => {
        assert.strictEqual(formatLabel('zip'), 'ZIP');
        assert.ok(/testing/i.test(formatLabel('raw')),
            'raw must be visibly labelled as under test rather than silently missing');
    });
});

// Backlog item 33: one job, one format decision. Every consumer of a job -
// the Downloader settings, the history record, the retry job and the merged
// artifact name - must read the SAME resolved value, or "verify before skip"
// searches for a file that was never written and the gallery re-downloads on
// every listing run.
describe('job format resolution (item 33)', () => {
    it('lets a per-job override win over the stored default', () => {
        assert.strictEqual(resolveJobFormat('cbz', 'zip'), 'cbz');
        assert.strictEqual(resolveJobFormat('raw', 'cbz'), 'raw');
        assert.strictEqual(resolveJobFormat('pdf', 'raw'), 'pdf');
    });

    it('falls back to the stored default when no override is sent', () => {
        assert.strictEqual(resolveJobFormat(undefined, 'cbz'), 'cbz');
        assert.strictEqual(resolveJobFormat(null, 'pdf'), 'pdf');
        assert.strictEqual(resolveJobFormat('', 'raw'), 'raw');
        assert.strictEqual(resolveJobFormat('rar', 'cbz'), 'cbz',
            'an unrecognized override must not silently become zip');
    });

    it('maps the retired "folder" value on both sides', () => {
        assert.strictEqual(resolveJobFormat('folder', 'zip'), 'pdf');
        assert.strictEqual(resolveJobFormat(undefined, 'folder'), 'pdf');
    });

    it('ends at zip when neither side names a format', () => {
        assert.strictEqual(resolveJobFormat(undefined, undefined), 'zip');
        assert.strictEqual(resolveJobFormat(undefined), 'zip');
    });

    it('keeps an unusable override out of the resolution', () => {
        assert.strictEqual(normalizeFormatOverride(''), undefined);
        assert.strictEqual(normalizeFormatOverride(null), undefined);
        assert.strictEqual(normalizeFormatOverride('rar'), undefined);
        assert.strictEqual(normalizeFormatOverride('folder'), 'pdf');
        assert.strictEqual(normalizeFormatOverride('cbz'), 'cbz');
    });
});

describe('output mode (separate files vs one merged file)', () => {
    it('knows both modes', () => {
        assert.deepStrictEqual(Array.from(OUTPUT_MODES), ['separate', 'batch']);
    });

    it('defaults to separate files - batch is the opt-in', () => {
        assert.strictEqual(LIST_MODE_DEFAULTS.listOutputMode, 'separate');
        assert.strictEqual(normalizeOutputMode(undefined), 'separate');
        assert.strictEqual(normalizeOutputMode('nonsense'), 'separate');
        assert.strictEqual(normalizeOutputMode('batch'), 'batch');
    });

    it('never routes raw into the shared-archive branch (no container to merge into)', () => {
        assert.strictEqual(supportsBatchMerge('raw'), false);
        assert.strictEqual(effectiveOutputMode('raw', 'batch'), 'separate');
        assert.strictEqual(outputModeToSeparate('raw', 'batch'), true);
    });

    it('translates the UI mode into the pipeline flag', () => {
        assert.strictEqual(outputModeToSeparate('zip', 'separate'), true);
        assert.strictEqual(outputModeToSeparate('zip', 'batch'), false);
        assert.strictEqual(outputModeToSeparate('pdf', 'batch'), false);
    });
});

describe('PDF merge guard', () => {
    it('warns only for pdf + batch + more than one title', () => {
        assert.strictEqual(shouldWarnPdfMerge('pdf', 'batch', 2), true);
        assert.strictEqual(shouldWarnPdfMerge('pdf', 'batch', 12), true);
    });

    it('does not warn for a single title, separate files, or another format', () => {
        assert.strictEqual(shouldWarnPdfMerge('pdf', 'batch', 1), false);
        assert.strictEqual(shouldWarnPdfMerge('pdf', 'batch', 0), false);
        assert.strictEqual(shouldWarnPdfMerge('pdf', 'separate', 20), false);
        assert.strictEqual(shouldWarnPdfMerge('zip', 'batch', 20), false);
        assert.strictEqual(shouldWarnPdfMerge('cbz', 'batch', 20), false);
        // raw can never merge, so it can never trigger the tankoubon case.
        assert.strictEqual(shouldWarnPdfMerge('raw', 'batch', 20), false);
    });

    it('scopes the dismissal flag to this exact combination', () => {
        assert.strictEqual(PDF_MERGE_WARNING_KEY, 'pdfMergeWarnDismissed');
    });
});

describe('list-mode filename template', () => {
    it('follows the single-title template by default', () => {
        assert.strictEqual(LIST_MODE_DEFAULTS.listDownloadName, LIST_TEMPLATE_INHERIT);
        assert.strictEqual(isInheritedListTemplate(LIST_TEMPLATE_INHERIT), true);
        assert.strictEqual(isInheritedListTemplate(undefined), true);
        assert.strictEqual(isInheritedListTemplate(null), true);
        assert.strictEqual(resolveListTemplate(LIST_TEMPLATE_INHERIT, '{pretty} - {artist}'), '{pretty} - {artist}');
    });

    it('keeps a deliberately empty template distinguishable from "inherit"', () => {
        assert.strictEqual(isInheritedListTemplate(''), false);
        assert.strictEqual(resolveListTemplate('', '{pretty}'), '');
    });

    it('uses its own template once one is set', () => {
        assert.strictEqual(resolveListTemplate('{id}', '{pretty}'), '{id}');
    });
});

describe('list format inheritance', () => {
    it('follows the single-title format while list mode has no key of its own', () => {
        assert.strictEqual(resolveListFormat(undefined, 'cbz'), 'cbz');
        assert.strictEqual(resolveListFormat(undefined, 'pdf'), 'pdf');
    });

    it('prefers the list key once the user sets one', () => {
        assert.strictEqual(resolveListFormat('zip', 'cbz'), 'zip');
        assert.strictEqual(resolveListFormat('raw', 'raw'), 'raw');
    });

    it('falls back to zip when neither key is set', () => {
        assert.strictEqual(resolveListFormat(undefined, undefined), 'zip');
    });

    it('normalises the legacy "folder" alias before inheriting', () => {
        assert.strictEqual(resolveListFormat(undefined, 'folder'), 'pdf');
        assert.strictEqual(resolveListFormat('folder', 'zip'), 'pdf');
    });

    it('is what buildListSettings uses, so the panels and the worker agree', () => {
        assert.strictEqual(buildListSettings({ useZip: 'cbz' }).format, resolveListFormat(undefined, 'cbz'));
        assert.strictEqual(buildListSettings({ useZip: 'cbz', listFormat: 'zip' }).format,
            resolveListFormat('zip', 'cbz'));
    });
});

// Storage returns only the requested keys, never the whole store merged over
// defaults. Callbacks are async and data is cloned, as in the browser API.
function withSyncStore(store, fn, local = {}) {
    const previous = Object.getOwnPropertyDescriptor(global, 'chrome');
    const ctx = { sync: structuredClone(store), local: structuredClone(local), reads: [], writes: [] };
    function area(name) {
        return {
            get(keys, cb) {
                const request = structuredClone(keys);
                ctx.reads.push({ area: name, keys: request });
                queueMicrotask(() => cb(readStorage(ctx[name], request)));
            },
            set(items, cb) {
                const copy = structuredClone(items);
                ctx.writes.push({ area: name, items: copy });
                Object.assign(ctx[name], copy);
                if (cb) queueMicrotask(cb);
            }
        };
    }
    global.chrome = { storage: { sync: area('sync'), local: area('local') } };
    return Promise.resolve()
        .then(() => fn(ctx))
        .finally(() => {
            if (previous) Object.defineProperty(global, 'chrome', previous);
            else delete global.chrome;
        });
}

describe('key-scoped storage fixture contract', () => {
    it('object defaults do not return unrequested stored keys or mutable aliases', () => {
        const stored = { useZip: 'cbz', listFormat: 'pdf', nested: { enabled: true } };
        const result = readStorage(stored, { useZip: 'zip', absent: 3, nested: null });
        assert.deepStrictEqual(result, { useZip: 'cbz', absent: 3, nested: { enabled: true } });
        result.nested.enabled = false;
        assert.strictEqual(stored.nested.enabled, true);
        assert.deepStrictEqual(readStorage(stored, ['listFormat', 'missing']), { listFormat: 'pdf' });
        assert.deepStrictEqual(readStorage(stored, 'listFormat'), { listFormat: 'pdf' });
        assert.deepStrictEqual(readStorage(stored, null), stored);
    });

    it('does not invoke storage callbacks synchronously', () => withSyncStore({}, async () => {
        let called = false;
        chrome.storage.sync.get({ useZip: 'zip' }, () => { called = true; });
        assert.strictEqual(called, false);
        await Promise.resolve();
        assert.strictEqual(called, true);
    }));
});

describe('list format inheritance through the real reader', () => {
    it('LIST_MODE_DEFAULTS must not define listFormat', () => {
        assert.strictEqual(LIST_MODE_DEFAULTS.listFormat, undefined,
            'a listFormat default here is spread into storage.get and hides "never set"');
        assert.ok(!Object.prototype.hasOwnProperty.call(LIST_MODE_DEFAULTS, 'listFormat'));
    });

    it('readListSettings inherits the single-title format when list mode has none', () =>
        withSyncStore({ useZip: 'cbz' }, async () => {
            assert.strictEqual((await readListSettings()).format, 'cbz');
        }));

    it('readListSettings keeps an explicit list format over the single-title one', () =>
        withSyncStore({ useZip: 'cbz', listFormat: 'zip' }, async () => {
            assert.strictEqual((await readListSettings()).format, 'zip');
        }));

    it('readListSettings falls back to zip when neither key is stored', () =>
        withSyncStore({}, async () => {
            assert.strictEqual((await readListSettings()).format, 'zip');
        }));
});

describe('saved list formats through the real reader (item 59)', () => {
    for (const { label, stored, expected } of formatCases) {
        it(label + ' without writing or migrating storage', () => withSyncStore(stored, async (ctx) => {
            assert.strictEqual((await readListSettings()).format, expected);
            assert.deepStrictEqual(ctx.sync, stored);
            assert.deepStrictEqual(ctx.writes, []);
        }));
    }

    it('restores all other settings and keeps the PDF warning flag local', () => {
        const stored = {
            useZip: 'cbz', listFormat: 'pdf', listOutputMode: 'batch',
            rawMasterFolder: '', listMasterFolder: false, downloadName: '',
            listDownloadName: '@inherit', replaceSpaces: false,
            verifyDownloadedFiles: false, batchNameDate: false, unrelated: 'keep'
        };
        return withSyncStore(stored, async (ctx) => {
            assert.deepStrictEqual(await readListSettings(), {
                format: 'pdf', outputMode: 'batch', masterFolder: false, masterFolderName: '',
                storedTemplate: '@inherit', template: '', singleTemplate: '', replaceSpaces: false,
                pdfMergeWarnDismissed: true, verifyDownloadedFiles: false, batchNameDate: false
            });
            assert.deepStrictEqual(ctx.sync, stored);
            assert.deepStrictEqual(ctx.local, { pdfMergeWarnDismissed: true, listFormat: 'raw' });
            assert.deepStrictEqual(ctx.writes, []);
        }, { pdfMergeWarnDismissed: true, listFormat: 'raw' });
    });

    it('round-trips explicit saves without changing single-title or sibling preferences', () =>
        withSyncStore({ useZip: 'pdf', downloadName: '{id}', unrelated: 'keep' }, async (ctx) => {
            for (const format of formats) {
                ctx.writes.length = 0;
                saveListSettings({ listFormat: format });
                assert.strictEqual((await readListSettings()).format, format);
                assert.deepStrictEqual(ctx.writes, [{ area: 'sync', items: { listFormat: format } }]);
                assert.deepStrictEqual(ctx.sync, { useZip: 'pdf', downloadName: '{id}', unrelated: 'keep', listFormat: format });
            }
        }));

    it('continues inheriting after the single-title default changes, without creating an override', () =>
        withSyncStore({ useZip: 'cbz' }, async (ctx) => {
            assert.strictEqual((await readListSettings()).format, 'cbz');
            ctx.sync.useZip = 'raw';
            assert.strictEqual((await readListSettings()).format, 'raw');
            assert.strictEqual(Object.hasOwn(ctx.sync, 'listFormat'), false);
            assert.deepStrictEqual(ctx.writes, []);
        }));

    it('keeps the saved format even when the local warning preference cannot be read', () =>
        withSyncStore({ useZip: 'cbz', listFormat: 'raw' }, async (ctx) => {
            chrome.storage.local.get = () => { throw new Error('local unavailable'); };
            const result = await readListSettings();
            assert.strictEqual(result.format, 'raw');
            assert.strictEqual(result.pdfMergeWarnDismissed, false);
            assert.deepStrictEqual(ctx.writes, []);
        }));

    it('falls back read-only if sync storage throws', () => withSyncStore({}, async (ctx) => {
        chrome.storage.sync.get = () => { throw new Error('sync unavailable'); };
        assert.deepStrictEqual(await readListSettings(), buildListSettings({}));
        assert.deepStrictEqual(ctx.writes, []);
    }));
});

describe('list-mode settings resolution', () => {
    it('applies the documented defaults on a fresh profile', () => {
        const settings = buildListSettings({});
        assert.strictEqual(settings.format, 'zip');
        assert.strictEqual(settings.outputMode, 'separate');
        assert.strictEqual(settings.masterFolder, true);
        assert.strictEqual(settings.masterFolderName, 'NHDW');
        assert.strictEqual(settings.template, '{pretty}');
        assert.strictEqual(settings.replaceSpaces, true);
        assert.strictEqual(settings.pdfMergeWarnDismissed, false);
    });

    it('seeds the list format from the single-title format the first time', () => {
        const settings = buildListSettings({ useZip: 'cbz' });
        assert.strictEqual(settings.format, 'cbz');
    });

    it('keeps the list format independent once it has its own value', () => {
        const settings = buildListSettings({ useZip: 'cbz', listFormat: 'pdf' });
        assert.strictEqual(settings.format, 'pdf');
        // The single-title default must not be touched by list-mode reads.
        assert.strictEqual(normalizeFormat('cbz'), 'cbz');
    });

    it('inherits the single-title template unless list mode has its own', () => {
        assert.strictEqual(buildListSettings({ downloadName: '{pretty} - {artist}' }).template,
            '{pretty} - {artist}');
        assert.strictEqual(buildListSettings({
            downloadName: '{pretty}',
            listDownloadName: '{artist} - {pretty} ({id})'
        }).template, '{artist} - {pretty} ({id})');
    });

    it('makes the master-folder wrap optional instead of forced', () => {
        assert.strictEqual(resolveMasterFolder(buildListSettings({})), 'NHDW');
        assert.strictEqual(resolveMasterFolder(buildListSettings({ listMasterFolder: false })), '');
        assert.strictEqual(
            resolveMasterFolder(buildListSettings({ rawMasterFolder: 'Doujin/NHDW' })),
            'Doujin/NHDW');
        // An emptied folder name behaves like "no wrap" even when ticked.
        assert.strictEqual(resolveMasterFolder(buildListSettings({ rawMasterFolder: '' })), '');
    });

    it('carries the pdf-merge dismissal through unchanged', () => {
        assert.strictEqual(buildListSettings({}, true).pdfMergeWarnDismissed, true);
    });
});
