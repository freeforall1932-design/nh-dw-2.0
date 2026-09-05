import Tag from "./tag"

// Classify a thrown error / error string into a stable failure kind so the UI
// can label failures consistently (metadata vs Cloudflare vs image vs ZIP vs
// user cancellation) instead of showing a raw string.
// Readable text for a thrown value: Error objects contribute their message
// (String(new Error("x")) gives "Error: x" and a structured clone of one is an
// empty object), strings pass through, anything else is stringified.
// Backported from the Chrome tree (3.6.4) - same implementation on purpose.
export function errorMessage(error: any): string {
    if (error === undefined || error === null) return "";
    if (typeof error === "string") return error;
    if (error.message !== undefined) return String(error.message);
    return String(error);
}

export function classifyError(error: any): { kind: string; label: string } {
    const message = String(error && error.message !== undefined ? error.message : error);
    const msg = message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel")) {
        return { kind: "cancelled", label: "Cancelled" };
    }
    if (msg.includes("cloudflare") || msg.includes("cf-challenge") || msg.includes("cf_challenge")) {
        return { kind: "cloudflare", label: "Cloudflare blocked" };
    }
    if (msg.includes("failed to fetch original image")
        || msg.includes("response too small")
        || msg.includes("unexpected content-type")
        || msg.includes("failed to download original image")
        || msg.includes("failed to save image")
        || msg.includes("gallery metadata was read")) {
        return { kind: "image", label: "Image fetch failed" };
    }
    if (msg.includes("unable to start download") || msg.includes("failed to start")) {
        return { kind: "zip", label: "Archive download failed" };
    }
    if (msg.includes("can't download") || msg.includes("unexpected response type") || msg.includes("unknown page format")) {
        return { kind: "metadata", label: "Metadata failed" };
    }
    return { kind: "unknown", label: "Error" };
}

export module utils
{
    // Clean a word, if replaceSpaces is true, all spaces are replaced by an underscore.
    // When the result would be empty, fallbackId (typically a gallery ID) is used
    // to produce "gallery-<id>" so the user can still identify the origin of the file.
    export function cleanName(name: string, replaceSpaces: boolean, fallbackId?: string): string {
        let newName = name.split('').filter(e => !invalidCharacter.includes(e)).join('');
        if (replaceSpaces) {
            newName = newName.trim().replace(/ +/g, '_');
        } else {
            newName = newName.trim();
        }
        // Windows reserves a handful of device names regardless of extension
        // (CON.zip, PRN.jpg, COM1.png, ...). Prefix them so Chrome can still
        // save the file instead of failing silently.
        if (reservedWindowsNames.has(newName.toUpperCase())) {
            newName = "_" + newName;
        }
        // A title made entirely of invalid characters (or spaces) would
        // produce an empty filename, which Chrome rejects. Fall back to a
        // safe placeholder so the download still starts; prefer the gallery
        // ID when one is available so the user can trace back the file.
        if (newName === "") {
            newName = fallbackId ? `gallery-${fallbackId}` : "untitled";
        }
        return newName;
    }

    export function getDownloadName(exampleString: string, prettyName: string, englishName: string, japaneseName: string, id: string, tags: Array<Tag>): string {
        exampleString = exampleString.replace(/{pretty}/g, prettyName);
        exampleString = exampleString.replace(/{english}/g, englishName);
        exampleString = exampleString.replace(/{japanese}/g, japaneseName);
        exampleString = exampleString.replace(/{id}/g, id);
        let language = "";
        let artists : Array<string> = [];
        let groups : Array<string> = [];
        let characters : Array<string> = [];
        tags.forEach(function(e) {
            if (e.type === "group") groups.push(e.name);
            else if (e.type === "character") characters.push(e.name);
            else if (e.type === "artist") artists.push(e.name);
            else if (e.type === "language" && e.name !== "translated") language = e.name;
        });
        exampleString = exampleString.replace(/{group}/g, groups.join(", "));
        exampleString = exampleString.replace(/{character}/g, characters.join(", "));
        exampleString = exampleString.replace(/{artist}/g, artists.join(", "));
        exampleString = exampleString.replace(/{language}/g, language);
        return exampleString;
    }

    let invalidCharacter: Array<string> = [
        '/', '\\', '?', '%', '*', ':', '|', '"', '<', '>', '.'
    ]

    // Windows device names that cannot be used as file/folder names even with
    // an extension. Kept uppercase for case-insensitive matching.
    let reservedWindowsNames: Set<string> = new Set([
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ])
}