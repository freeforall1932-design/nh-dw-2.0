// Library index format (INDEXER_PLAN.md §2) — the three-tier offline index:
// a header line, a tag dictionary (tier 1), compact gallery rows (tier 2).
// Thumbnails are NEVER in the file (tier 3 is derived per source in the UI).
//
// Pure module: text in, structures out. No browser APIs — gzip sniffing and
// OPFS live in libraryStore.ts / library.ts so this file stays node-testable
// (test/library-index.test.js compiles it through tsconfig.test.json).
//
// File shape (one JSON value per line, .jsonl; optionally gzipped):
//   {"_meta":{"schema":1,"site":"nhentai","exported":"2026-11-26","count":2,"tagCount":3}}
//   {"_t":1,"id":17,"ns":"tag","n":"vanilla","c":98123}
//   ["366220","m123456","(C99) [Artist] Title",58,1672531200,[17,1223],"jpg"]
//
// Gallery rows are positional ARRAYS on purpose (§8.8): at six-figure row
// counts, one object per row re-hydrates hundreds of MB; arrays stay at the
// 50–100 MB scale. Never widen the arity casually — bump schema instead.

export const INDEX_SCHEMA = 1;

/** ns values (INDEXER_PLAN.md §2). Keys stay lowercase slugs. */
export const TAG_NAMESPACES = ["tag", "artist", "group", "character", "parody", "language"] as const;
export type TagNamespace = typeof TAG_NAMESPACES[number];

export interface IndexMeta {
    schema: number;
    /** Source slug (siteKeys.ts convention), e.g. "nhentai" or "sample". */
    site: string;
    /** ISO date of the export. */
    exported: string;
    count: number;
    tagCount: number;
}

export interface IndexTag {
    id: number;
    ns: TagNamespace;
    /** Display name. */
    n: string;
    /** Titles carrying this tag at export time (drives the chip counts). */
    c: number;
}

/** Positional gallery row: [id, media_id, title, pages, uploaded_unix, tag_ids[], thumb_ext?]. */
export type GalleryRow = [string, string, string, number, number, number[], string?];

/** Row field positions — the only place the arity is named. */
export const ROW = {
    ID: 0,
    MEDIA_ID: 1,
    TITLE: 2,
    PAGES: 3,
    UPLOADED: 4,
    TAG_IDS: 5,
    THUMB_EXT: 6,
} as const;

export interface ParsedIndex {
    meta: IndexMeta;
    tags: Map<number, IndexTag>;
    rows: GalleryRow[];
}

export class IndexFormatError extends Error {
    constructor(message: string, public line?: number) {
        super(line === undefined ? message : message + " (line " + line + ")");
        this.name = "IndexFormatError";
    }
}

function parseMeta(line: string, lineNo: number): IndexMeta {
    let value: any;
    try {
        value = JSON.parse(line);
    } catch (_) {
        throw new IndexFormatError("first line must be the _meta header JSON", lineNo);
    }
    if (!value || value._t !== undefined || typeof value._meta !== "object" || value._meta === null) {
        throw new IndexFormatError('first line must carry a "_meta" object', lineNo);
    }
    const meta = value._meta;
    if (meta.schema !== INDEX_SCHEMA) {
        throw new IndexFormatError("unsupported index schema " + JSON.stringify(meta.schema) + " (this build reads schema " + INDEX_SCHEMA + ")", lineNo);
    }
    if (typeof meta.site !== "string" || !meta.site) {
        throw new IndexFormatError('_meta.site must be a non-empty source slug', lineNo);
    }
    return {
        schema: meta.schema,
        site: meta.site,
        exported: typeof meta.exported === "string" ? meta.exported : "",
        count: typeof meta.count === "number" ? meta.count : 0,
        tagCount: typeof meta.tagCount === "number" ? meta.tagCount : 0,
    };
}

function parseTagRow(value: any, lineNo: number): IndexTag {
    if (!value || typeof value !== "object" || value._t !== 1) {
        throw new IndexFormatError("object rows before the galleries must be tag dictionary entries with \"_t\":1", lineNo);
    }
    if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id < 0) {
        throw new IndexFormatError("tag row needs a non-negative integer id", lineNo);
    }
    if (TAG_NAMESPACES.indexOf(value.ns) === -1) {
        throw new IndexFormatError("tag row has unknown namespace " + JSON.stringify(value.ns), lineNo);
    }
    if (typeof value.n !== "string" || !value.n) {
        throw new IndexFormatError("tag row needs a display name \"n\"", lineNo);
    }
    return { id: value.id, ns: value.ns, n: value.n, c: typeof value.c === "number" ? value.c : 0 };
}

function parseGalleryRow(value: any, lineNo: number): GalleryRow {
    if (!Array.isArray(value) || value.length < 6 || value.length > 7) {
        throw new IndexFormatError("gallery rows are [id, media_id, title, pages, uploaded, tag_ids[, thumb_ext]]", lineNo);
    }
    if (typeof value[0] !== "string" || !value[0]) throw new IndexFormatError("gallery id must be a string", lineNo);
    if (typeof value[1] !== "string" || !value[1]) throw new IndexFormatError("gallery media_id must be a string", lineNo);
    if (typeof value[2] !== "string") throw new IndexFormatError("gallery title must be a string", lineNo);
    if (typeof value[3] !== "number" || !Number.isInteger(value[3]) || value[3] < 0) {
        throw new IndexFormatError("gallery pages must be a non-negative integer", lineNo);
    }
    if (typeof value[4] !== "number" || !Number.isFinite(value[4]) || value[4] < 0) {
        throw new IndexFormatError("gallery uploaded must be a unix timestamp", lineNo);
    }
    if (!Array.isArray(value[5]) || value[5].some((t: any) => typeof t !== "number" || !Number.isInteger(t))) {
        throw new IndexFormatError("gallery tag_ids must be an array of integers", lineNo);
    }
    if (value.length === 7 && typeof value[6] !== "string") {
        throw new IndexFormatError("thumb_ext must be a string when given", lineNo);
    }
    return value.slice(0, 7) as GalleryRow;
}

/** Parse a whole .jsonl index payload (already decompressed if it was gzipped). */
export function parseIndexText(text: string): ParsedIndex {
    const lines = text.split("\n");
    // Tolerate CRLF exports and a trailing newline.
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, "");
    if (lines.length === 0 || lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) throw new IndexFormatError("index file is empty");

    const meta = parseMeta(lines[0], 1);
    const tags = new Map<number, IndexTag>();
    const rows: GalleryRow[] = [];
    let sawGallery = false;

    for (let i = 1; i < lines.length; i++) {
        const lineNo = i + 1;
        const line = lines[i];
        if (line === "") continue;
        let value: any;
        try {
            value = JSON.parse(line);
        } catch (_) {
            throw new IndexFormatError("line is not valid JSON", lineNo);
        }
        if (Array.isArray(value)) {
            sawGallery = true;
            rows.push(parseGalleryRow(value, lineNo));
        } else {
            if (sawGallery) {
                throw new IndexFormatError("tag dictionary rows must come before the gallery rows", lineNo);
            }
            const tag = parseTagRow(value, lineNo);
            if (tags.has(tag.id)) {
                throw new IndexFormatError("duplicate tag id " + tag.id, lineNo);
            }
            tags.set(tag.id, tag);
        }
    }

    if (meta.count !== 0 && meta.count !== rows.length) {
        throw new IndexFormatError("_meta.count says " + meta.count + " but the file holds " + rows.length + " gallery rows");
    }
    if (meta.tagCount !== 0 && meta.tagCount !== tags.size) {
        throw new IndexFormatError("_meta.tagCount says " + meta.tagCount + " but the file holds " + tags.size + " tag rows");
    }
    return { meta, tags, rows };
}

/** Serialize back to .jsonl text (header, tag dictionary, gallery rows). */
export function serializeIndex(index: ParsedIndex): string {
    const out: string[] = [];
    out.push(JSON.stringify({
        _meta: {
            schema: INDEX_SCHEMA,
            site: index.meta.site,
            exported: index.meta.exported || new Date().toISOString().slice(0, 10),
            count: index.rows.length,
            tagCount: index.tags.size,
        },
    }));
    const tagIds = Array.from(index.tags.keys()).sort((a, b) => a - b);
    for (const id of tagIds) out.push(JSON.stringify({ _t: 1, ...index.tags.get(id) }));
    for (const row of index.rows) out.push(JSON.stringify(row));
    return out.join("\n") + "\n";
}

/** Human label for a namespace (Browse sidebar group headings). */
export function namespaceLabel(ns: TagNamespace): string {
    switch (ns) {
        case "tag": return "Tags";
        case "artist": return "Artists";
        case "group": return "Groups";
        case "character": return "Characters";
        case "parody": return "Parodies";
        case "language": return "Languages";
    }
}
