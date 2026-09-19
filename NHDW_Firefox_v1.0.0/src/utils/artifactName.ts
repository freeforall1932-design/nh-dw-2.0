// Last-mile filename hardening shared by the save path (Downloader) and the
// history-record path (downloadHistory). chrome.downloads silently ignores
// invalid names (control characters, stray dots/edges), and the file then
// lands under the blob/CDN URL's own name. The same sanitizer MUST run on
// the recorded filename, or "verify before skip" (chrome.downloads.search)
// can never match and the gallery re-downloads with (1)/(2) growth.
//
// Keep the subfolder structure (a/b/c.jpg), strip control and reserved
// characters per segment, drop leading dots and trailing dots/spaces
// (Windows rejects those), bound segment length, and fall back to the
// gallery name when nothing usable is left.

export function sanitizeArtifactFilename(filename: string, fallbackStem: string): string {
    const segments = String(filename).split("/");
    const cleanedSegments: string[] = [];
    for (const segment of segments) {
        let cleaned = segment
            .replace(/[\x00-\x1f\x7f]/g, "")
            .replace(/[\\:*?"<>|]/g, "")
            .replace(/^\.+/, "")
            .replace(/[. ]+$/g, "");
        if (cleaned.length > 120) {
            cleaned = cleaned.slice(0, 120).replace(/[. ]+$/g, "");
        }
        if (cleaned !== "") {
            cleanedSegments.push(cleaned);
        }
    }
    let joined = cleanedSegments.join("/");
    if (joined === "" || joined === "/") {
        joined = sanitizeArtifactFilename(String(fallbackStem || "download"), "download");
    }
    return joined;
}
