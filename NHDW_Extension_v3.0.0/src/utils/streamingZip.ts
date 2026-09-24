// Streaming ZIP Archive Writer (Item 51)
//
// Replaces in-memory ZIP assembly with an O(1)-RAM streaming pipeline targeting
// Origin Private File System (OPFS) when available in browser contexts
// (e.g. offscreen document), falling back to chunked memory when OPFS is absent
// (e.g. Node tests or non-supporting environments).
//
// By streaming each compressed page directly to an OPFS FileSystemWritableFileStream,
// peak memory during 1+ GB multi-gallery or 500-page archive compilation is bounded
// to a single page rather than accumulating the entire archive in RAM.

export interface ZipSink {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    getBlob(type?: string): Promise<Blob> | Blob;
    cleanup?(): Promise<void>;
}

export interface StreamingZipOptions {
    preferOpfs?: boolean;
    compression?: "STORE" | "DEFLATE";
}

export function encodeUtf8(str: string): Uint8Array {
    if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(str);
    }
    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(str, "utf8"));
    }
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0xd800 || code >= 0xe000) {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            i++;
            code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
            bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
    }
    return new Uint8Array(bytes);
}

// Precomputed CRC-32 table (IEEE 802.3 polynomial 0xEDB88320)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c >>> 0;
}

export function crc32(data: Uint8Array, previous: number = 0): number {
    let crc = (previous ^ -1) >>> 0;
    for (let i = 0; i < data.length; i++) {
        crc = (CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ -1) >>> 0;
}

// In-memory chunked sink used when OPFS is unavailable (e.g. Node test suite)
export class MemoryZipSink implements ZipSink {
    chunks: Uint8Array[] = [];
    bytesWritten: number = 0;

    async write(chunk: Uint8Array): Promise<void> {
        this.chunks.push(chunk);
        this.bytesWritten += chunk.length;
    }

    async close(): Promise<void> {
        // No-op for in-memory sink
    }

    getBlob(type: string = "application/zip"): Blob {
        return new Blob(this.chunks, { type });
    }

    getBuffer(): Uint8Array {
        const total = this.chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const c of this.chunks) {
            result.set(c, offset);
            offset += c.length;
        }
        return result;
    }

    async cleanup(): Promise<void> {
        this.chunks = [];
        this.bytesWritten = 0;
    }
}

// OPFS-backed sink writing directly to disk via Origin Private File System
export class OpfsZipSink implements ZipSink {
    private rootHandle: any;
    private fileHandle: any;
    private writable: any;
    private tempFilename: string;
    private cleanupDelayMs: number;

    constructor(rootHandle: any, fileHandle: any, writable: any, tempFilename: string, cleanupDelayMs: number = OPFS_CLEANUP_DELAY_MS) {
        this.rootHandle = rootHandle;
        this.fileHandle = fileHandle;
        this.writable = writable;
        this.tempFilename = tempFilename;
        this.cleanupDelayMs = cleanupDelayMs;
    }

    static async create(prefix: string = OPFS_TEMP_PREFIX, cleanupDelayMs: number = OPFS_CLEANUP_DELAY_MS): Promise<OpfsZipSink | null> {
        if (typeof navigator === "undefined" || !navigator.storage || typeof (navigator.storage as any).getDirectory !== "function") {
            return null;
        }
        try {
            const root = await (navigator.storage as any).getDirectory();
            // Sweep orphans from earlier sessions BEFORE creating this job's
            // file, so a run can never delete its own temp file.
            await sweepOpfsOrphans(root, prefix, cleanupDelayMs);
            const tempFilename = prefix + Date.now() + "_" + Math.random().toString(36).slice(2) + ".tmp";
            const fileHandle = await root.getFileHandle(tempFilename, { create: true });
            if (typeof fileHandle.createWritable !== "function") {
                return null;
            }
            const writable = await fileHandle.createWritable();
            return new OpfsZipSink(root, fileHandle, writable, tempFilename, cleanupDelayMs);
        } catch (_) {
            return null;
        }
    }

    async write(chunk: Uint8Array): Promise<void> {
        await this.writable.write(chunk);
    }

    async close(): Promise<void> {
        await this.writable.close();
    }

    async getBlob(type: string = "application/zip"): Promise<Blob> {
        const file = await this.fileHandle.getFile();
        if (file.type === type) {
            return file;
        }
        return file.slice(0, file.size, type);
    }

    async cleanup(): Promise<void> {
        const remove = async () => {
            try {
                if (this.rootHandle && typeof this.rootHandle.removeEntry === "function") {
                    await this.rootHandle.removeEntry(this.tempFilename);
                }
            } catch (_) { /* ignore already removed or locked */ }
        };
        if (this.cleanupDelayMs <= 0) {
            await remove();
            return;
        }
        // The finished archive is saved through an anchor click nobody awaits
        // (offscreen saveArtifactSmart), so Chrome's download manager may
        // still be reading the blob - which this file backs - when cleanup
        // runs. Unlink after a grace period instead of instantly, mirroring
        // the object-URL revoke delay in the Downloader. If the document dies
        // before the timer fires, the orphan is caught by the next sink's
        // sweep (create() above).
        setTimeout(() => { remove(); }, this.cleanupDelayMs);
    }
}

// Grace period before a finished archive's temp file may be unlinked, and the
// minimum age before the sweep treats a leftover as an orphan. Matches the
// Downloader's revokeObjectUrlDelayMs (60 s).
export const OPFS_CLEANUP_DELAY_MS = 60000;
export const OPFS_TEMP_PREFIX = "nhdw_archive_";

// Best-effort orphan sweep: an offscreen document killed between writing the
// archive and the delayed unlink leaves a temp file behind. Only files whose
// last modification is older than minAgeMs are removed, so a concurrent or
// just-finished writer's file (whose blob may still be downloading) is never
// touched. Never throws: an unreadable root must not block the archive.
export async function sweepOpfsOrphans(root: any, prefix: string = OPFS_TEMP_PREFIX, minAgeMs: number = OPFS_CLEANUP_DELAY_MS): Promise<void> {
    try {
        if (!root || typeof root.values !== "function" || typeof root.removeEntry !== "function") {
            return;
        }
        const iter = root.values();
        while (true) {
            const step = await iter.next();
            if (!step || step.done) {
                break;
            }
            const entry = step.value;
            const name = entry && typeof entry.name === "string" ? entry.name : "";
            if (name.indexOf(prefix) !== 0 || !/\.tmp$/i.test(name)) {
                continue;
            }
            try {
                const handle = typeof root.getFileHandle === "function" ? await root.getFileHandle(name) : null;
                const file = handle && typeof handle.getFile === "function" ? await handle.getFile() : null;
                const modified = file && typeof file.lastModified === "number" ? file.lastModified : 0;
                if (!file || Date.now() - modified >= minAgeMs) {
                    await root.removeEntry(name);
                }
            } catch (_) { /* locked or already gone - keep sweeping */ }
        }
    } catch (_) { /* the sweep is best-effort; never block an archive on it */ }
}

interface ZipEntryRecord {
    nameBytes: Uint8Array;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    localHeaderOffset: number;
}

export async function compressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const CompressionStreamCtor = (globalThis as any).CompressionStream;
    if (typeof CompressionStreamCtor === "undefined") {
        return data;
    }
    const cs = new CompressionStreamCtor("deflate-raw");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            totalLen += value.length;
        }
    }
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
    }
    return result;
}

export class StreamingZipWriter {
    private sink: ZipSink | null = null;
    private preferOpfs: boolean = true;
    private defaultCompression: "STORE" | "DEFLATE" = "STORE";
    private entries: ZipEntryRecord[] = [];
    private offset: number = 0;
    private filesMap: Record<string, boolean> = {};
    private writeChain: Promise<void> = Promise.resolve();

    constructor(sink?: ZipSink | null, options?: StreamingZipOptions) {
        this.sink = sink || null;
        this.preferOpfs = options?.preferOpfs !== false;
        this.defaultCompression = options?.compression || "STORE";
    }

    get files(): Record<string, boolean> {
        return this.filesMap;
    }

    folder(_name: string): this {
        // Zip archive entry paths encode directory hierarchies naturally (e.g. "path/file.jpg")
        return this;
    }

    private async getSink(): Promise<ZipSink> {
        if (!this.sink) {
            if (this.preferOpfs) {
                const opfs = await OpfsZipSink.create();
                if (opfs) {
                    this.sink = opfs;
                    return this.sink;
                }
            }
            this.sink = new MemoryZipSink();
        }
        return this.sink;
    }

    file(name: string, data: Uint8Array | ArrayBuffer | string, options?: { compression?: "STORE" | "DEFLATE" }): this {
        this.filesMap[name] = true;
        this.writeChain = this.writeChain.then(async () => {
            const sink = await this.getSink();

            let rawBytes: Uint8Array;
            if (typeof data === "string") {
                rawBytes = encodeUtf8(data);
            } else if (data instanceof Uint8Array) {
                rawBytes = data;
            } else {
                rawBytes = new Uint8Array(data);
            }

            const nameBytes = encodeUtf8(name);
            const crc = crc32(rawBytes);
            const uncompressedSize = rawBytes.length;

            const requestedCompression = options?.compression || this.defaultCompression;
            // Image formats (jpg, png, webp, avif) are already compressed; Deflate yields negligible gain.
            // Only apply DEFLATE if explicitly requested and CompressionStream is available.
            const isImage = /\.(jpe?g|png|webp|avif|gif)$/i.test(name);
            const CompressionStreamCtor = (globalThis as any).CompressionStream;
            const shouldDeflate = requestedCompression === "DEFLATE" && !isImage && typeof CompressionStreamCtor !== "undefined";

            let payloadBytes = rawBytes;
            let compressionMethod = 0; // STORE
            if (shouldDeflate) {
                try {
                    const compressed = await compressDeflateRaw(rawBytes);
                    if (compressed.length < uncompressedSize) {
                        payloadBytes = compressed;
                        compressionMethod = 8; // DEFLATE
                    }
                } catch (_) {
                    payloadBytes = rawBytes;
                    compressionMethod = 0;
                }
            }

            const compressedSize = payloadBytes.length;
            const localHeaderOffset = this.offset;

            // Local file header: 30 bytes + name length
            const header = new Uint8Array(30 + nameBytes.length);
            const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

            view.setUint32(0, 0x04034b50, true);          // Local file header signature (PK\x03\x04)
            view.setUint16(4, 20, true);                  // Version needed to extract (2.0)
            view.setUint16(6, 0x0800, true);              // General purpose bit flag (bit 11 = UTF-8)
            view.setUint16(8, compressionMethod, true);   // Compression method
            view.setUint16(10, 0, true);                  // Last mod file time
            view.setUint16(12, 0, true);                  // Last mod file date
            view.setUint32(14, crc, true);                // CRC-32
            view.setUint32(18, compressedSize, true);     // Compressed size
            view.setUint32(22, uncompressedSize, true);   // Uncompressed size
            view.setUint16(26, nameBytes.length, true);   // File name length
            view.setUint16(28, 0, true);                  // Extra field length
            header.set(nameBytes, 30);

            await sink.write(header);
            await sink.write(payloadBytes);
            this.offset += header.length + payloadBytes.length;

            this.entries.push({
                nameBytes: nameBytes,
                crc: crc,
                compressedSize: compressedSize,
                uncompressedSize: uncompressedSize,
                compressionMethod: compressionMethod,
                localHeaderOffset: localHeaderOffset
            });
        });
        return this;
    }

    // JSZip-compatible signature, deliberately partial (documented honestly):
    // `options` is accepted but ignored - a streaming writer decides
    // compression per entry at file() time and cannot retro-compress bytes
    // that already went to the sink. The Downloader's generateAsync({
    // compression: "DEFLATE", level 5 }) request therefore does NOT apply:
    // production archives are STORE (image payloads are already compressed;
    // PNG pages come out a few percent larger than the old JSZip deflate,
    // in exchange for O(one page) memory). `onProgress` fires once at 100%
    // after the central directory is written - page-level work already
    // happened during the fetches, so there is no slow "zipping" phase to
    // report on any more.
    async generateAsync(options?: any, onProgress?: (progress: { percent: number; currentFile: string | null }) => void): Promise<Blob> {
        await this.writeChain;
        const sink = await this.getSink();

        const cdStartOffset = this.offset;
        let cdSize = 0;

        // Write Central Directory headers for all entries
        for (const entry of this.entries) {
            const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
            const view = new DataView(cdHeader.buffer, cdHeader.byteOffset, cdHeader.byteLength);

            view.setUint32(0, 0x02014b50, true);                  // Central directory file header (PK\x01\x02)
            view.setUint16(4, 20, true);                          // Version made by (2.0)
            view.setUint16(6, 20, true);                          // Version needed to extract (2.0)
            view.setUint16(8, 0x0800, true);                      // General purpose bit flag (UTF-8)
            view.setUint16(10, entry.compressionMethod, true);    // Compression method
            view.setUint16(12, 0, true);                          // Last mod time
            view.setUint16(14, 0, true);                          // Last mod date
            view.setUint32(16, entry.crc, true);                  // CRC-32
            view.setUint32(20, entry.compressedSize, true);       // Compressed size
            view.setUint32(24, entry.uncompressedSize, true);     // Uncompressed size
            view.setUint16(28, entry.nameBytes.length, true);     // File name length
            view.setUint16(30, 0, true);                          // Extra field length
            view.setUint16(32, 0, true);                          // File comment length
            view.setUint16(34, 0, true);                          // Disk number start
            view.setUint16(36, 0, true);                          // Internal file attributes
            view.setUint32(38, 0, true);                          // External file attributes
            view.setUint32(42, entry.localHeaderOffset, true);    // Relative offset of local header
            cdHeader.set(entry.nameBytes, 46);

            await sink.write(cdHeader);
            cdSize += cdHeader.length;
        }

        // End of Central Directory record (22 bytes)
        const eocd = new Uint8Array(22);
        const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);

        eocdView.setUint32(0, 0x06054b50, true);          // End of central dir signature (PK\x05\x06)
        eocdView.setUint16(4, 0, true);                   // Number of this disk
        eocdView.setUint16(6, 0, true);                   // Disk where central directory starts
        eocdView.setUint16(8, this.entries.length, true); // Number of central directory records on this disk
        eocdView.setUint16(10, this.entries.length, true);// Total number of central directory records
        eocdView.setUint32(12, cdSize, true);             // Size of central directory
        eocdView.setUint32(16, cdStartOffset, true);      // Offset of start of central directory
        eocdView.setUint16(20, 0, true);                  // Comment length

        await sink.write(eocd);
        await sink.close();

        if (typeof onProgress === "function") {
            try { onProgress({ percent: 100, currentFile: null }); } catch (_) {}
        }

        const mimeType = (options && options.type === "blob") ? "application/zip" : "application/zip";
        return await sink.getBlob(mimeType);
    }

    async cleanup(): Promise<void> {
        if (this.sink && typeof this.sink.cleanup === "function") {
            await this.sink.cleanup();
        }
    }
}
