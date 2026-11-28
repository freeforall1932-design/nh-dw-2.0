// OPFS persistence for imported library indexes (INDEXER_PLAN.md §8.1): the
// index never goes into chrome.storage.local — that store has a ~10 MB cap
// and the manifest (deliberately) has no unlimitedStorage yet. One file per
// source slug, named by that slug: a re-import replaces the file wholesale
// (per-source snapshot policy, §2 merge rules).
//
// Browser-only module (Origin Private File System). Every failure is a named
// Error the UI can print in words, per house style.

const LIBRARY_DIR = "library";

function storageRoot(): FileSystemDirectoryHandle {
    const navAny = navigator as any;
    if (!navAny || !navAny.storage || typeof navAny.storage.getDirectory !== "function") {
        throw new Error("This browser has no OPFS root; imported indexes cannot be stored.");
    }
    return navAny.storage.getDirectory();
}

function fileNameForSite(site: string): string {
    const slug = site.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error('Source slug "' + site + '" cannot name an index file.');
    return slug + ".jsonl";
}

async function libraryDirectory(): Promise<FileSystemDirectoryHandle> {
    const root = await storageRoot();
    return root.getDirectoryHandle(LIBRARY_DIR, { create: true });
}

/** Persist one source's index text. Replaces any previous file for the slug. */
export async function saveIndexFile(site: string, text: string): Promise<void> {
    const dir = await libraryDirectory();
    const handle = await dir.getFileHandle(fileNameForSite(site), { create: true });
    // createWritable postdates the DOM lib this build compiles against.
    const writable = await (handle as any).createWritable();
    try {
        await writable.write(text);
    } finally {
        await writable.close();
    }
}

/** All persisted indexes, best-effort order (slug asc). */
export async function loadAllIndexes(): Promise<{ site: string; text: string }[]> {
    const dir = await libraryDirectory();
    const out: { site: string; text: string }[] = [];
    // async iterator support varies; wrap defensively and degrade to empty.
    let names: string[] = [];
    try {
        for await (const name of (dir as any).keys()) names.push(name);
    } catch (_) {
        return out;
    }
    names.sort();
    for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        try {
            const handle = await dir.getFileHandle(name);
            const file = await handle.getFile();
            const text = await file.text();
            out.push({ site: name.slice(0, -".jsonl".length), text });
        } catch (_) {
            // A single unreadable file must not kill the whole library load.
        }
    }
    return out;
}

/** Remove one source's index file. Returns whether a file was removed. */
export async function deleteIndexFile(site: string): Promise<boolean> {
    const dir = await libraryDirectory();
    try {
        await dir.removeEntry(fileNameForSite(site));
        return true;
    } catch (_) {
        return false;
    }
}

/** Bytes used by the library directory (for the Settings readout). Best-effort. */
export async function libraryUsageEstimate(): Promise<{ usage: number; quota: number } | null> {
    try {
        const navAny = navigator as any;
        if (!navAny || !navAny.storage || typeof navAny.storage.estimate !== "function") return null;
        const est = await navAny.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0 };
    } catch (_) {
        return null;
    }
}
