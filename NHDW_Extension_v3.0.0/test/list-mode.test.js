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
    normalizeOutputMode,
    outputModeToSeparate,
    resolveListTemplate,
    shouldWarnPdfMerge,
    supportsBatchMerge
} = require('../build/test/utils/downloadFormats.js');
const { buildListSettings, resolveMasterFolder } = require('../build/test/utils/listSettings.js');

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
