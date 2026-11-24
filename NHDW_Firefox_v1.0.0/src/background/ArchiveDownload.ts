// Experimental nhentai API-v2 archive path. This is NOT the website's own
// Download button. There is no live transfer or button-flow verification yet.
//
// Fail closed: never send a key to a delivery URL, follow a redirect carrying
// credentials, log signed URLs, or silently switch to page-by-page requests
// when this explicitly selected archive route fails. The restrictions below
// are deliberately conservative until the provider's real delivery hosts and
// browser completion behavior are independently observed.

var JSZip = require("jszip");
import { fetchNhentaiApi, descriptiveUserAgentHeaders, parseRetryAfterMs, NhentaiRateLimitError } from "../utils/apiAuth";
import { archiveGalleryId } from "../utils/archiveIdentity";
import { crc32 } from "../utils/streamingZip";

export interface ArchiveUrlResult {
    url: string;
    /** Unix seconds, as documented by DownloadResponse. */
    expiresAt: number;
}

export interface ArchiveRequestDeps {
    fetchImpl?: (url: string, init?: any) => Promise<Response>;
    sleepImpl?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    maxRetries?: number;
}

interface ArchiveLimits {
    maxBytes: number;
    maxExpandedBytes: number;
    maxEntryBytes: number;
    maxEntries: number;
}

const DEFAULT_LIMITS: ArchiveLimits = {
    maxBytes: 128 * 1024 * 1024,
    maxExpandedBytes: 256 * 1024 * 1024,
    maxEntryBytes: 64 * 1024 * 1024,
    maxEntries: 5000
};

export function getArchiveRequestUrl(galleryId: string | number, format: "zip" | "cbz"): string {
    return "https://nhentai.net/api/v2/galleries/" + encodeURIComponent(String(galleryId)) + "/download?format=" + format;
}

/** Temporary, conservative boundary; actual archive delivery hosts are unverified. */
export function isAllowedArchiveDeliveryUrl(value: unknown): value is string {
    if (typeof value !== "string" || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
            (host === "nhentai.net" || host.endsWith(".nhentai.net"));
    } catch (_) {
        return false;
    }
}

// No credential or signed URL is included in any error. Invalid local inputs
// return null without a request; an actual server/request failure throws.
export async function requestArchiveDownloadUrl(
    galleryId: string | number,
    format: "zip" | "cbz",
    apiKey: string | null,
    deps: ArchiveRequestDeps = {}
): Promise<ArchiveUrlResult | null> {
    if (apiKey === null || String(apiKey).trim().length === 0) return null;
    const validatedId = archiveGalleryId(galleryId);
    if (validatedId === null) return null;

    let resp: Response;
    try {
        resp = await fetchNhentaiApi(
            getArchiveRequestUrl(validatedId, format),
            { method: "POST", cache: "no-store", signal: deps.signal },
            apiKey,
            deps
        );
    } catch (_) {
        if (deps.signal && deps.signal.aborted) throw new Error("Download was aborted");
        throw new Error("Server archive request failed (network error or blocked redirect).");
    }
    if (!resp.ok) {
        if (resp.status === 429) {
            const retryAfter = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("Retry-After") : null;
            throw new NhentaiRateLimitError("Server archive request", parseRetryAfterMs(retryAfter));
        }
        const status = Number.isInteger(resp.status) ? " (HTTP " + resp.status + ")" : "";
        throw new Error("Server archive request was rejected or unavailable" + status + ".");
    }

    let body: any;
    try {
        body = await resp.json();
    } catch (_) {
        throw new Error("Server archive response was not valid JSON.");
    }
    if (!body || !isAllowedArchiveDeliveryUrl(body.url)) {
        throw new Error("Server archive delivery URL is missing or outside the currently allowed HTTPS hosts.");
    }
    // The documented value is a short-lived Unix timestamp, in seconds. Do
    // not invent an expiry, accept an already expired URL, or mistake a
    // millisecond timestamp for seconds. Seven days is a conservative bound,
    // not a claim about the provider's actual URL lifetime.
    const nowSeconds = Date.now() / 1000;
    if (!Number.isSafeInteger(body.expires_at) || body.expires_at <= nowSeconds || body.expires_at > nowSeconds + 7 * 86400) {
        throw new Error("Server archive expiry is missing, expired, or invalid.");
    }
    return { url: body.url, expiresAt: body.expires_at };
}

function read16(data: Uint8Array, at: number): number {
    return data[at] | (data[at + 1] << 8);
}

function read32(data: Uint8Array, at: number): number {
    return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

/** Validate the ZIP end record and bounded central directory before JSZip. */
function centralDirectoryCount(data: Uint8Array, maxEntries: number): number {
    let end = -1;
    for (let i = data.length - 22, min = Math.max(0, data.length - 65557); i >= min; i--) {
        if (read32(data, i) === 0x06054b50 && i + 22 + read16(data, i + 20) === data.length) {
            end = i;
            break;
        }
    }
    if (end < 0 || read16(data, end + 4) !== 0 || read16(data, end + 6) !== 0) throw new Error("Invalid ZIP directory");
    const count = read16(data, end + 10);
    const size = read32(data, end + 12);
    const offset = read32(data, end + 16);
    if (count === 0 || count === 0xffff || count > maxEntries || read16(data, end + 8) !== count ||
        size === 0xffffffff || offset === 0xffffffff || offset + size !== end) throw new Error("Invalid ZIP directory");
    let cursor = offset;
    for (let i = 0; i < count; i++) {
        if (cursor + 46 > end || read32(data, cursor) !== 0x02014b50 || (read16(data, cursor + 8) & 1) !== 0) {
            throw new Error("Invalid ZIP entry");
        }
        cursor += 46 + read16(data, cursor + 28) + read16(data, cursor + 30) + read16(data, cursor + 32);
        if (cursor > end) throw new Error("Invalid ZIP entry");
    }
    if (cursor !== end) throw new Error("Invalid ZIP directory");
    return count;
}

function safeEntryName(entry: any): boolean {
    const name = typeof entry.name === "string" ? entry.name : "";
    const original = typeof entry.unsafeOriginalName === "string" ? entry.unsafeOriginalName : name;
    if (!name || name.length > 512 || original !== name || /^[\/\\]|^[A-Za-z]:/.test(name) ||
        /[\\\u0000-\u001f\u007f]/.test(name) || name.split("/").some((part: string) => part === "." || part === "..")) return false;
    // Do not deliver symlinks that could escape an extraction directory.
    return !(typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0xf000) === 0xa000);
}

function validImageHeader(prefix: number[], extension: string): boolean {
    const ascii = (start: number, end: number) => String.fromCharCode.apply(null, prefix.slice(start, end));
    if (extension === "jpg" || extension === "jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
    if (extension === "png") return prefix.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => prefix[i] === byte);
    if (extension === "gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    if (extension === "webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    if (extension === "avif") return ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, 64));
    return false;
}

// Stream each expanded entry rather than accumulating decompressed content.
// The signatures and CRC detect common wrong/corrupt payloads, but do not
// prove that an image decodes, that all pages exist, or that bytes are original.
async function verifyEntry(entry: any, extension: string | null, maxBytes: number, signal?: AbortSignal): Promise<void> {
    if (signal && signal.aborted) throw new Error("Aborted");
    const data = entry._data;
    const expected = data && data.uncompressedSize;
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > maxBytes || !Number.isInteger(data.crc32)) throw new Error("Invalid ZIP entry size");
    await new Promise<void>((resolve, reject) => {
        let stream: any;
        let done = false;
        let count = 0;
        let checksum = 0;
        const prefix: number[] = [];
        const finish = (error?: Error) => {
            if (done) return;
            done = true;
            if (signal) signal.removeEventListener("abort", abort);
            if (error && stream) stream.pause();
            if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error("Aborted"));
        if (signal) signal.addEventListener("abort", abort, { once: true });
        if (signal && signal.aborted) { abort(); return; }
        try {
            stream = entry.internalStream("uint8array");
            stream.on("data", (chunk: Uint8Array) => {
                count += chunk.length;
                if (count > maxBytes || count > expected) { finish(new Error("ZIP entry exceeds limits")); return; }
                checksum = crc32(chunk, checksum);
                for (let i = 0; i < chunk.length && prefix.length < 64; i++) prefix.push(chunk[i]);
            }).on("error", () => finish(new Error("Corrupt ZIP entry"))).on("end", () => {
                if (count !== expected || (checksum >>> 0) !== (data.crc32 >>> 0) ||
                    (extension !== null && !validImageHeader(prefix, extension))) {
                    finish(new Error("Corrupt ZIP entry"));
                } else finish();
            });
            stream.resume();
        } catch (_) {
            finish(new Error("Invalid ZIP entry"));
        }
    });
}

async function validateArchive(blob: Blob, limits: ArchiveLimits, expectedImageCount?: number, signal?: AbortSignal): Promise<void> {
    if (signal && signal.aborted) throw new Error("Download was aborted");
    try {
        // Construct a local-realm Uint8Array: worker test VMs and their Blob
        // implementations may otherwise supply an ArrayBuffer from another realm.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const count = centralDirectoryCount(bytes, limits.maxEntries);
        const zip = await JSZip.loadAsync(bytes, { createFolders: false });
        const names = Object.keys(zip.files);
        // JSZip overwrites duplicate/sanitized names; do not accept a ZIP if
        // some entries disappeared during parsing.
        if (names.length !== count) throw new Error("Duplicate ZIP entries");
        let expanded = 0;
        let images = 0;
        for (const name of names) {
            const entry = zip.files[name];
            if (!safeEntryName(entry)) throw new Error("Unsafe ZIP name");
            if (entry.dir) continue;
            const match = /\.([A-Za-z0-9]+)$/.exec(name);
            const extension = match ? match[1].toLowerCase() : "";
            const image = ["jpg", "jpeg", "png", "gif", "webp", "avif"].indexOf(extension) !== -1;
            if (!image && ["json", "xml", "txt"].indexOf(extension) === -1) throw new Error("Unsupported ZIP entry");
            if (image) images++;
            const size = entry._data && entry._data.uncompressedSize;
            if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxEntryBytes) throw new Error("Invalid ZIP size");
            expanded += size;
            if (!Number.isSafeInteger(expanded) || expanded > limits.maxExpandedBytes) throw new Error("ZIP exceeds expansion limit");
            await verifyEntry(entry, image ? extension : null, limits.maxEntryBytes, signal);
        }
        if (images === 0 || (expectedImageCount !== undefined && images !== expectedImageCount)) {
            throw new Error("ZIP image count does not match gallery metadata");
        }
    } catch (_) {
        if (signal && signal.aborted) throw new Error("Download was aborted");
        // Do not echo untrusted filenames, parser exceptions, or signed URLs.
        throw new Error("Server archive is invalid, corrupt, unsupported, or exceeds safety limits.");
    }
}

// Fetch without credentials or redirects; consume a bounded stream before
// validating its ZIP structure, entry CRCs and image signatures. This is not
// a complete image decoder or proof of page completeness/original quality.
export async function fetchArchiveBytes(
    url: string,
    deps: { fetchImpl?: (url: string, init?: any) => Promise<Response>; signal?: AbortSignal; limits?: Partial<ArchiveLimits>; expectedImageCount?: number } = {}
): Promise<Blob> {
    if (!isAllowedArchiveDeliveryUrl(url)) throw new Error("Server archive delivery URL is outside the currently allowed HTTPS hosts.");
    if (deps.expectedImageCount !== undefined && (!Number.isSafeInteger(deps.expectedImageCount) || deps.expectedImageCount <= 0)) {
        throw new Error("Invalid expected server archive page count.");
    }
    const limits: ArchiveLimits = Object.assign({}, DEFAULT_LIMITS, deps.limits || {});
    if (Object.keys(limits).some(key => !Number.isSafeInteger((limits as any)[key]) || (limits as any)[key] <= 0)) {
        throw new Error("Invalid server archive safety limits.");
    }
    const fetchImpl = deps.fetchImpl || fetch;
    const headers: Record<string, string> = Object.assign({}, descriptiveUserAgentHeaders());
    let resp: Response;
    try {
        resp = await fetchImpl(url, { cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deps.signal, headers });
    } catch (_) {
        if (deps.signal && deps.signal.aborted) throw new Error("Download was aborted");
        throw new Error("Server archive transfer failed (network error or blocked redirect).");
    }
    if (resp.redirected) throw new Error("Server archive redirects are not allowed.");
    if (!resp.ok) {
        if (resp.status === 429) {
            const retryAfter = resp.headers && resp.headers.get ? resp.headers.get("Retry-After") : null;
            throw new NhentaiRateLimitError("Server archive delivery", parseRetryAfterMs(retryAfter));
        }
        throw new Error("Failed to fetch server archive (HTTP " + resp.status + ").");
    }
    const type = resp.headers && resp.headers.get ? (resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() : "";
    if (type && ["application/zip", "application/x-zip-compressed", "application/octet-stream", "application/x-cbz", "application/vnd.comicbook+zip"].indexOf(type) === -1) {
        if (resp.body) try { await resp.body.cancel(); } catch (_) {}
        throw new Error("Server archive response has an unexpected content type.");
    }
    const lengthHeader = resp.headers && resp.headers.get ? resp.headers.get("Content-Length") : null;
    if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > limits.maxBytes) {
        if (resp.body) try { await resp.body.cancel(); } catch (_) {}
        throw new Error("Server archive exceeds the transfer size limit.");
    }
    if (!resp.body || typeof resp.body.getReader !== "function") throw new Error("Server archive response cannot be read safely.");
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            if (deps.signal && deps.signal.aborted) throw new Error("Aborted");
            const next = await reader.read();
            if (next.done) break;
            if (!next.value || typeof next.value.byteLength !== "number") throw new Error("Invalid body chunk");
            total += next.value.byteLength;
            if (total > limits.maxBytes) throw new Error("Transfer size limit");
            chunks.push(next.value);
        }
    } catch (_) {
        try { await reader.cancel(); } catch (_) {}
        if (deps.signal && deps.signal.aborted) throw new Error("Download was aborted");
        throw new Error("Server archive transfer failed or exceeded the size limit.");
    } finally {
        try { reader.releaseLock(); } catch (_) {}
    }
    const blob = new Blob(chunks, { type: "application/zip" });
    await validateArchive(blob, limits, deps.expectedImageCount, deps.signal);
    return blob;
}
