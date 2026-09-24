const assert = require('assert');
const JSZip = require('jszip');
const {
    crc32,
    MemoryZipSink,
    OpfsZipSink,
    StreamingZipWriter,
    compressDeflateRaw
} = require('../build/test/utils/streamingZip.js');

describe('StreamingZip (item 51)', () => {
    describe('crc32 calculation', () => {
        it('calculates correct CRC-32 for empty buffer', () => {
            const buf = new Uint8Array(0);
            assert.strictEqual(crc32(buf), 0);
        });

        it('calculates correct CRC-32 for standard vector "123456789"', () => {
            // Standard check value for CRC-32/ISO-HDLC is 0xCBF43926
            const buf = Buffer.from('123456789', 'utf8');
            assert.strictEqual((crc32(buf) >>> 0).toString(16).toUpperCase(), 'CBF43926');
        });

        it('calculates correct CRC-32 for text string', () => {
            const buf = Buffer.from('Hello World', 'utf8');
            assert.strictEqual((crc32(buf) >>> 0).toString(16).toLowerCase(), '4a17b156');
        });
    });

    describe('MemoryZipSink', () => {
        it('writes and collects chunks into buffer', async () => {
            const sink = new MemoryZipSink();
            await sink.write(new Uint8Array([1, 2, 3]));
            await sink.write(new Uint8Array([4, 5]));
            assert.strictEqual(sink.bytesWritten, 5);
            const buf = sink.getBuffer();
            assert.deepStrictEqual(Array.from(buf), [1, 2, 3, 4, 5]);
            await sink.cleanup();
            assert.strictEqual(sink.bytesWritten, 0);
        });
    });

    describe('StreamingZipWriter', () => {
        it('assembles a standard ZIP archive readable by JSZip', async () => {
            const zip = new StreamingZipWriter();
            zip.file('001.jpg', Buffer.from('image data 1'));
            zip.file('002.jpg', Buffer.from('image data 2'));
            zip.folder('subfolder');
            zip.file('subfolder/003.jpg', Buffer.from('image data 3'));

            assert.strictEqual(Object.keys(zip.files).length, 3);
            assert.strictEqual(zip.files['001.jpg'], true);
            assert.strictEqual(zip.files['subfolder/003.jpg'], true);

            let progressNotified = false;
            const blob = await zip.generateAsync({ type: 'blob' }, (p) => {
                if (p.percent === 100) progressNotified = true;
            });

            assert.strictEqual(progressNotified, true);
            assert.ok(blob);

            // Verify with JSZip reader
            const arrayBuffer = await blob.arrayBuffer();
            const loaded = await JSZip.loadAsync(arrayBuffer);
            assert.strictEqual(Object.keys(loaded.files).length, 3);

            const content1 = await loaded.file('001.jpg').async('string');
            const content2 = await loaded.file('002.jpg').async('string');
            const content3 = await loaded.file('subfolder/003.jpg').async('string');

            assert.strictEqual(content1, 'image data 1');
            assert.strictEqual(content2, 'image data 2');
            assert.strictEqual(content3, 'image data 3');

            await zip.cleanup();
        });

        it('supports text and Uint8Array inputs', async () => {
            const zip = new StreamingZipWriter();
            zip.file('text.txt', 'Hello streaming zip!');
            zip.file('bytes.bin', new Uint8Array([10, 20, 30]));

            const blob = await zip.generateAsync();
            const loaded = await JSZip.loadAsync(await blob.arrayBuffer());

            assert.strictEqual(await loaded.file('text.txt').async('string'), 'Hello streaming zip!');
            const bytesOut = await loaded.file('bytes.bin').async('uint8array');
            assert.deepStrictEqual(Array.from(bytesOut), [10, 20, 30]);
        });

        it('supports DEFLATE compression when CompressionStream is present', async () => {
            if (typeof CompressionStream === 'undefined') {
                return; // skip in environments without CompressionStream
            }
            const zip = new StreamingZipWriter(null, { compression: 'DEFLATE' });
            const repeatedText = 'This is repetitive text that compresses very well. '.repeat(50);
            zip.file('data.txt', repeatedText);

            const blob = await zip.generateAsync();
            const loaded = await JSZip.loadAsync(await blob.arrayBuffer());
            const uncompressed = await loaded.file('data.txt').async('string');
            assert.strictEqual(uncompressed, repeatedText);
        });

        it('preserves UTF-8 filenames in archive headers', async () => {
            const zip = new StreamingZipWriter();
            const utf8Name = '日本語タイトル/001_テスト.jpg';
            zip.file(utf8Name, Buffer.from('japanese filename payload'));

            const blob = await zip.generateAsync();
            const loaded = await JSZip.loadAsync(await blob.arrayBuffer());
            assert.ok(loaded.file(utf8Name));
            assert.strictEqual(await loaded.file(utf8Name).async('string'), 'japanese filename payload');
        });
    });

    describe('OpfsZipSink mock and lifecycle', () => {
        it('cleans up temporary file handles on cleanup()', async () => {
            let removedEntry = null;
            const mockRoot = {
                removeEntry: async (name) => { removedEntry = name; }
            };
            const mockFileHandle = {
                getFile: async () => new Blob(['mock file'])
            };
            const mockWritable = {
                write: async () => {},
                close: async () => {}
            };
            const sink = new OpfsZipSink(mockRoot, mockFileHandle, mockWritable, 'test_temp.tmp', 0);
            await sink.write(new Uint8Array([1, 2]));
            await sink.close();
            await sink.cleanup();
            assert.strictEqual(removedEntry, 'test_temp.tmp');
        });
    });

    // PR #48 review: the offscreen document saves finished archives through an
    // anchor click that is NOT awaited, so cleanup() must not unlink the OPFS
    // file while Chrome's download manager may still be reading the blob - and
    // a document killed before the delayed unlink must not leak the orphan
    // forever (the next archive sweeps stale temp files before it starts).
    describe('OpfsZipSink orphan sweep and delayed cleanup (PR #48 review)', () => {
        // Node 21+ ships a getter-only global `navigator`, so a plain
        // assignment silently fails there (that is exactly how this suite
        // broke CI on Node 22 while passing locally on Node 20). Install and
        // restore through the property descriptor instead.
        const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

        afterEach(() => {
            if (navigatorDescriptor) {
                Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
            } else {
                delete globalThis.navigator;
            }
        });

        function mockOpfs(existingNames) {
            const removed = [];
            const root = {
                values: async function* () {
                    for (const name of existingNames) yield { name: name, kind: 'file' };
                },
                removeEntry: async (name) => { removed.push(name); },
                getFileHandle: async () => ({
                    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
                    getFile: async () => new Blob(['mock'])
                })
            };
            Object.defineProperty(globalThis, 'navigator', {
                value: { storage: { getDirectory: async () => root } },
                configurable: true,
                writable: true
            });
            return removed;
        }

        it('create() sweeps stale temp archives left behind by an earlier session', async () => {
            const removed = mockOpfs([
                'nhdw_archive_1_aaa.tmp',
                'nhdw_archive_2_bbb.tmp',
                'keepme.bin'
            ]);
            const sink = await OpfsZipSink.create('nhdw_archive_', 0);
            assert.ok(sink, 'create() succeeds against a mock OPFS root');
            assert.deepStrictEqual(removed.slice().sort(), [
                'nhdw_archive_1_aaa.tmp',
                'nhdw_archive_2_bbb.tmp'
            ], 'only stale nhdw_archive_*.tmp orphans are removed, nothing else');
        });

        it('cleanup() unlinks after the grace delay, never while the download may still read', async () => {
            const removed = mockOpfs([]);
            const sink = await OpfsZipSink.create('nhdw_archive_', 30);
            await sink.write(new Uint8Array([1]));
            await sink.close();
            await sink.cleanup();
            assert.strictEqual(removed.length, 0,
                'cleanup() must not unlink synchronously: the anchor save is not awaited');
            await new Promise((resolve) => setTimeout(resolve, 250));
            assert.strictEqual(removed.length, 1, 'the temp file is removed once the grace delay passed');
            assert.ok(/^nhdw_archive_.*\.tmp$/.test(removed[0]), 'the removed entry is the sink temp file');
        });

        it('cleanup() with a zero delay removes immediately (harness contexts)', async () => {
            const removed = mockOpfs([]);
            const sink = await OpfsZipSink.create('nhdw_archive_', 0);
            await sink.cleanup();
            assert.strictEqual(removed.length, 1);
        });
    });
});
