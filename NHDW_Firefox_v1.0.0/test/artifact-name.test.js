// Artifact-name regression tests.
//
// Guards the two functions that decide the final downloaded file name:
//   utils.cleanName            (popup turns the gallery title into the path)
//   sanitizeArtifactFilename   (Downloader hardens it before chrome.downloads)
//
// A UUID/hex file name instead of the gallery title means chrome.downloads
// ignored the requested name; these tests pin down that the name we request
// is always non-empty and valid for realistic nhentai titles, so a regression
// in name generation is caught here rather than in the user's Downloads folder.

const assert = require('assert');
const { utils } = require('../build/test/utils/utils.js');
const { sanitizeArtifactFilename } = require('../build/test/background/Downloader.js');

// Realistic nhentai-style titles (brackets, Unicode, separators, edge cases).
const TITLES = [
    "[Oyabe Ryo] Tonari no Ko | The Girl Next Door [English] [NudeSalad] [Digital]",
    "[Some Circle] Some Title (Series) [English]",
    "[Artist] Title 2 [English] [Decensored]",
    "\u3010Japanese\u3011\u30bf\u30a4\u30c8\u30eb\u3010\u82f1\u8a33\u3011",
    "[A] B [C] D very very very very very very very very very very long title",
    "Title With Trailing Space ",
    " Title With Leading Space",
    "...",
    "Title.With.Dots",
    'Title: With | Special * Chars? <Now> "Quoted"',
    "CON",
    "title (re vision) [ongoing]"
];

// chrome.downloads rejects these; a valid artifact name must avoid them.
const INVALID_CHARS = /[\\:*?"<>|\x00-\x1f\x7f]/;

function finalArtifactName(title, ext, replaceSpaces) {
    const id = "674496";
    const path = utils.cleanName(title, replaceSpaces, id); // popup path input
    const filename = path + ext;                             // Downloader appends ext
    return sanitizeArtifactFilename(filename, title);        // #saveArtifact
}

describe('artifact file naming', () => {
    for (const replaceSpaces of [true, false]) {
        it(`produces a non-empty, valid name for every realistic title (replaceSpaces=${replaceSpaces})`, () => {
            for (const title of TITLES) {
                const name = finalArtifactName(title, ".zip", replaceSpaces);
                assert.ok(typeof name === "string" && name.length > 0,
                    "artifact name must never be empty for: " + title);
                assert.ok(!INVALID_CHARS.test(name),
                    "artifact name must not contain download-invalid characters: " + name);
                assert.ok(!/^[. ]/.test(name),
                    "artifact name must not start with a dot or space: " + name);
                assert.ok(!/[. ]$/.test(name),
                    "artifact name must not end with a dot or space: " + name);
                assert.ok(!/^\/|^\\\\/.test(name),
                    "artifact name must be relative, not absolute: " + name);
            }
        });
    }

    it('keeps the extension in the final name', () => {
        for (const ext of [".zip", ".cbz", ".pdf"]) {
            const name = finalArtifactName("[Artist] Some Gallery [English]", ext, true);
            assert.ok(name.endsWith(ext), "expected " + ext + " suffix, got " + name);
        }
    });

    it('never yields a Windows reserved device name', () => {
        for (const reserved of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9"]) {
            const name = finalArtifactName(reserved, ".zip", true);
            const stem = name.replace(/\.zip$/, "").toUpperCase();
            assert.ok(!/^(_?)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) || stem.startsWith("_"),
                "reserved device name must be disambiguated: " + name);
        }
    });

    it('falls back to the gallery id when the title sanitizes to nothing', () => {
        const name = finalArtifactName("///", ".zip", true);
        assert.ok(/674496/.test(name) || /gallery/.test(name),
            "empty-sanitizing title must fall back to the gallery id, got " + name);
    });
});
