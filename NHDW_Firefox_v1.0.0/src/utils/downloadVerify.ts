// Worker-side verification that a recorded download still exists on disk.
//
// The persistent history is intentionally compact (id -> {filename, when}) to
// save space, so it cannot know whether the user deleted/moved the file. The
// worker — which owns chrome.storage AND chrome.downloads — asks the browser's
// download history whether the artifact is still there. The offscreen document
// never imports this module (it only imports the pure helpers and touches
// chrome.runtime alone).
//
// Known limits (deliberate, see SESSION_HANDOFF "Download history"):
//  * chrome.downloads only knows files this profile downloaded. A file copied
//    in by hand, or moved after Chrome recorded its path, counts as missing
//    and is downloaded again — the user then keeps the newest copy.
//  * Clearing the browser's download history also counts as missing.
import { DownloadHistory } from "./downloadHistory";

function escapeRegex(value: string): string {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Recorded filenames are relative ("NHDW/Title.zip"); chrome.downloads items
// carry the OS path. Match the recorded tail so it works on Windows backslashes
// and POSIX slashes, anchored at the end, with a path separator (or the start
// of the string) before the first segment — "MyNHDW/Title.zip" must not be
// mistaken for "NHDW/Title.zip".
export function recordedFilenameRegex(filename: string): string {
    const parts = String(filename).split("/").map(escapeRegex);
    return "(?:^|[\\\\/])" + parts.join("[\\\\/]") + "$";
}

export function fileExistsOnDisk(filename: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const downloads = (chrome as any).downloads;
            if (!downloads || typeof downloads.search !== "function") {
                // No downloads API (or a test stub without it): never block a
                // download on a verification we cannot perform.
                resolve(false);
                return;
            }
            downloads.search({ filenameRegex: recordedFilenameRegex(filename), limit: 1 }, (items: any[]) => {
                const item = Array.isArray(items) ? items[0] : undefined;
                resolve(!!(item && item.exists === true));
            });
        } catch (_) {
            resolve(false);
        }
    });
}

// Which recorded ids still have their artifact on disk. Used by the history
// guard: only these are skipped when the "verify" setting is on; the rest are
// downloaded again (a record is not proof the file survived).
export async function verifyHistoryOnDisk(history: DownloadHistory): Promise<Set<string>> {
    const present = new Set<string>();
    const ids = Object.keys(history);
    await Promise.all(ids.map(async (id) => {
        const filename = history[id] && history[id].filename;
        if (filename && await fileExistsOnDisk(filename)) {
            present.add(id);
        }
    }));
    return present;
}

// Which merged-name candidates already exist on disk (for _part2/_part3...).
export async function presentBatchFilenames(candidates: string[]): Promise<Set<string>> {
    const present = new Set<string>();
    await Promise.all(candidates.map(async (candidate) => {
        if (await fileExistsOnDisk(candidate)) {
            present.add(candidate);
        }
    }));
    return present;
}
