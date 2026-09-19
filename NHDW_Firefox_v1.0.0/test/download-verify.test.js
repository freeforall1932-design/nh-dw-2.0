// On-disk verification of recorded downloads: the tail-anchored filename regex
// used against chrome.downloads, and the "cannot verify -> never block" rule.
//
// The history record only stores a relative name ("NHDW/Title.zip") while
// chrome.downloads items carry the OS path, so matching is done with a regex
// anchored at the END of the path and requiring a separator (or the start of
// the string) before the first segment. No browser needed: the module is
// dependency-free and chrome.downloads is stubbed here.

const assert = require('assert');
const {
    recordedFilenameRegex,
    fileExistsOnDisk,
    verifyHistoryOnDisk,
    presentBatchFilenames
} = require('../build/test/utils/downloadVerify.js');

// Stub chrome.downloads.search over a fixed list of "downloaded" files.
function installDownloadsStub(items) {
    const searched = [];
    global.chrome = {
        downloads: {
            search(query, callback) {
                searched.push(query.filenameRegex);
                const re = new RegExp(query.filenameRegex);
                const matches = items.filter((it) => re.test(it.filename));
                callback(matches.slice(0, query.limit === undefined ? matches.length : query.limit));
            }
        }
    };
    return {
        searched,
        uninstall() { delete global.chrome; }
    };
}

describe('recordedFilenameRegex', () => {
    it('matches the recorded tail on both path separators', () => {
        const re = new RegExp(recordedFilenameRegex('NHDW/Title.zip'));
        assert.ok(re.test('/home/user/Downloads/NHDW/Title.zip'), 'posix path');
        assert.ok(re.test('C:\\Users\\me\\Downloads\\NHDW\\Title.zip'), 'windows path');
        assert.ok(re.test('NHDW/Title.zip'), 'bare relative name');
    });

    it('does not match a longer parent folder that merely ends the same way', () => {
        const re = new RegExp(recordedFilenameRegex('NHDW/Title.zip'));
        assert.ok(!re.test('/downloads/MyNHDW/Title.zip'), 'MyNHDW must not read as NHDW');
        assert.ok(!re.test('/downloads/NHDW-old/Title.zip'), 'NHDW-old must not read as NHDW');
    });

    it('is anchored, so a different file in the same folder does not match', () => {
        const re = new RegExp(recordedFilenameRegex('NHDW/Title.zip'));
        assert.ok(!re.test('/downloads/NHDW/Title.zip.bak'), 'trailing text must not match');
        assert.ok(!re.test('/downloads/NHDW/Other.zip'), 'another file must not match');
    });

    it('escapes regex metacharacters in the recorded name', () => {
        const re = new RegExp(recordedFilenameRegex('NHDW/Title (v2) [final]+1.zip'));
        assert.ok(re.test('/downloads/NHDW/Title (v2) [final]+1.zip'));
        // Unescaped, "(v2) [final]+1" would also accept other text.
        assert.ok(!re.test('/downloads/NHDW/Title v2 final1.zip'));
    });
});

describe('fileExistsOnDisk', () => {
    it('is true only for a recorded file the browser still has', async () => {
        const stub = installDownloadsStub([
            { filename: '/downloads/NHDW/Title.zip', exists: true },
            { filename: '/downloads/NHDW/Gone.zip', exists: false }
        ]);
        try {
            assert.strictEqual(await fileExistsOnDisk('NHDW/Title.zip'), true);
            assert.strictEqual(await fileExistsOnDisk('NHDW/Gone.zip'), false,
                'an item Chrome recorded but whose file is gone counts as missing');
            assert.strictEqual(await fileExistsOnDisk('NHDW/Never.zip'), false);
        } finally {
            stub.uninstall();
        }
    });

    it('resolves false instead of throwing when the downloads API is absent', async () => {
        global.chrome = {};
        try {
            assert.strictEqual(await fileExistsOnDisk('NHDW/Title.zip'), false);
        } finally {
            delete global.chrome;
        }
    });

    it('resolves false when search throws, so a broken API never blocks a download', async () => {
        global.chrome = {
            downloads: {
                search() { throw new Error('downloads API unavailable'); }
            }
        };
        try {
            assert.strictEqual(await fileExistsOnDisk('NHDW/Title.zip'), false);
        } finally {
            delete global.chrome;
        }
    });
});

describe('verifyHistoryOnDisk', () => {
    it('returns exactly the ids whose artifact is still on disk', async () => {
        const stub = installDownloadsStub([
            { filename: '/downloads/NHDW/Keep.zip', exists: true },
            { filename: '/downloads/NHDW/Deleted.zip', exists: true }
        ]);
        try {
            const present = await verifyHistoryOnDisk({
                '111': { filename: 'NHDW/Keep.zip', when: 1 },
                '222': { filename: 'NHDW/Deleted.zip', when: 2 },
                '333': { filename: 'NHDW/Nowhere.zip', when: 3 },
                '444': { filename: '', when: 4 },
                '555': { when: 5 }
            });
            assert.deepStrictEqual([...present].sort(), ['111', '222']);
        } finally {
            stub.uninstall();
        }
    });

    it('handles an empty history without touching the API', async () => {
        const stub = installDownloadsStub([]);
        try {
            const present = await verifyHistoryOnDisk({});
            assert.strictEqual(present.size, 0);
            assert.strictEqual(stub.searched.length, 0);
        } finally {
            stub.uninstall();
        }
    });
});

describe('presentBatchFilenames', () => {
    it('reports which merged-name candidates are already taken', async () => {
        const stub = installDownloadsStub([
            { filename: '/downloads/search_05092026.zip', exists: true }
        ]);
        try {
            const present = await presentBatchFilenames([
                'search_05092026.zip',
                'search_05092026_part2.zip',
                'search_05092026_part3.zip'
            ]);
            assert.deepStrictEqual([...present], ['search_05092026.zip']);
        } finally {
            stub.uninstall();
        }
    });
});
