/*
 * turbo-stream v2 decoder (the wire format of React Router 7 / Remix "single
 * fetch" page data, `<path>.data`) - dependency-free on purpose, so the site
 * adapters (popup, service worker, offscreen document) can read page data
 * without pulling the chapter tool's HTML parser into their bundles.
 *
 * Format (from react-router 7's bundled turbo-stream, MIT; re-implemented):
 *   line 1      JSON array of flattened values (or a bare number for a
 *               primitive root); index 0 is the root
 *   P<id>:<v>   deferred value <id> resolved; <v> is an index or an array of
 *               new values appended to the same index space
 *   E<id>:<v>   deferred value <id> rejected (read here as null)
 *   objects     {"_<keyIndex>": valueIndex, ...}
 *   arrays      [valueIndex, ...] (-1 = hole)
 *   negatives   -2 NaN, -3 -Infinity, -4 -0, -5 null, -6 Infinity, -7 undefined
 *   tags        ["D",ms] date, ["U",s] url, ["B",s] bigint, ["R",src,flags],
 *               ["Y",s] symbol, ["S",...] set, ["M",k,v,...] map,
 *               ["N",{...}] null-prototype object, ["P",id] promise,
 *               ["Z",index] previously resolved, ["E",msg,type] error, and
 *               react-router's plugin types (SingleFetchClassInstance, ...).
 *
 * Text is parsed, never executed; size, value count and depth are bounded;
 * objects are built without a prototype, so page data cannot pollute
 * Object.prototype.
 */

export const TURBO_STREAM_MAX_BYTES = 5 * 1024 * 1024;

export const ROUTE_DATA_MAX_VALUES = 250000;
const ROUTE_DATA_MAX_DEPTH = 256;
const HOLE = -1, NAN = -2, NEGATIVE_INFINITY = -3, NEGATIVE_ZERO = -4, NULL = -5, POSITIVE_INFINITY = -6, UNDEFINED = -7;

/** Thrown for anything that is not a well-formed, bounded turbo-stream body. */
export class TurboStreamError extends Error {
    readonly code = "format";
    constructor(detail: string) {
        super("The site's page data could not be read (" + detail + ").");
        this.name = "TurboStreamError";
    }
}

function formatError(detail: string): TurboStreamError {
    return new TurboStreamError(detail);
}

/**
 * Decode a complete turbo-stream v2 body into plain values. Dates become epoch
 * milliseconds, URLs/bigints/symbols/regexps strings, sets arrays, maps and
 * null-prototype objects plain (prototype-free) objects, errors null, and
 * deferred values whatever their resolution line carried (undefined if none).
 */
export function decodeTurboStream(text: string): any {
    const body = String(text === undefined || text === null ? "" : text);
    if (!body.trim()) throw formatError("empty response");
    if (body.length > TURBO_STREAM_MAX_BYTES) throw formatError("too large");
    const lines = body.split("\n");
    const values: any[] = [];
    let first: any;
    try { first = JSON.parse(lines[0]); } catch (_) { throw formatError("not turbo-stream text"); }
    let rootIndex: number;
    if (typeof first === "number") rootIndex = first;
    else if (Array.isArray(first) && first.length) {
        for (const value of first) values.push(value);
        rootIndex = 0;
    } else throw formatError("not turbo-stream text");

    const deferred = new Map<number, number>();
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (!line) continue;
        const kind = line.charAt(0);
        const colon = line.indexOf(":");
        if ((kind !== "P" && kind !== "E") || colon < 2) throw formatError("unexpected stream line");
        const id = Number(line.slice(1, colon));
        if (!Number.isSafeInteger(id) || id < 0) throw formatError("bad deferred id");
        let parsed: any;
        try { parsed = JSON.parse(line.slice(colon + 1)); } catch (_) { throw formatError("bad deferred value"); }
        let index: number;
        if (typeof parsed === "number") index = parsed;
        else if (Array.isArray(parsed) && parsed.length) {
            index = values.length;
            for (const value of parsed) values.push(value);
        } else throw formatError("bad deferred value");
        if (values.length > ROUTE_DATA_MAX_VALUES) throw formatError("too many values");
        deferred.set(id, kind === "P" ? index : NULL);
    }
    if (values.length > ROUTE_DATA_MAX_VALUES) throw formatError("too many values");

    const hydrated = new Map<number, any>();
    const hydrate = (index: any, depth: number): any => {
        switch (index) {
            case UNDEFINED: return undefined;
            case NULL: return null;
            case NAN: return NaN;
            case POSITIVE_INFINITY: return Infinity;
            case NEGATIVE_INFINITY: return -Infinity;
            case NEGATIVE_ZERO: return -0;
        }
        if (!Number.isInteger(index) || index < 0 || index >= values.length) throw formatError("reference out of range");
        if (hydrated.has(index)) return hydrated.get(index);
        if (depth > ROUTE_DATA_MAX_DEPTH) throw formatError("nested too deeply");
        const value = values[index];
        if (value === null || typeof value !== "object") {
            hydrated.set(index, value);
            return value;
        }
        const objectFrom = (entries: any): any => {
            const out: any = Object.create(null);
            hydrated.set(index, out);
            if (!entries || typeof entries !== "object" || Array.isArray(entries)) return out;
            for (const key of Object.keys(entries)) {
                if (!/^_\d+$/.test(key)) throw formatError("bad object key");
                out[String(hydrate(Number(key.slice(1)), depth + 1))] = hydrate(entries[key], depth + 1);
            }
            return out;
        };
        if (!Array.isArray(value)) return objectFrom(value);
        if (typeof value[0] !== "string") {
            const out: any[] = [];
            hydrated.set(index, out);
            for (let i = 0; i < value.length; i++) {
                if (value[i] !== HOLE) out[i] = hydrate(value[i], depth + 1);
            }
            return out;
        }
        let result: any;
        switch (value[0]) {
            case "D": result = Number(value[1]); break;
            case "U": case "B": case "Y": result = String(value[1]); break;
            case "R": result = String(value[1]); break;
            case "E": result = null; break;
            case "Z": result = hydrate(value[1], depth + 1); break;
            case "P": result = deferred.has(value[1]) ? hydrate(deferred.get(value[1]), depth + 1) : undefined; break;
            case "N": return objectFrom(value[1]);
            case "S": {
                const out: any[] = [];
                hydrated.set(index, out);
                for (let i = 1; i < value.length; i++) out.push(hydrate(value[i], depth + 1));
                return out;
            }
            case "M": {
                const out: any = Object.create(null);
                hydrated.set(index, out);
                for (let i = 1; i + 1 < value.length; i += 2) {
                    out[String(hydrate(value[i], depth + 1))] = hydrate(value[i + 1], depth + 1);
                }
                return out;
            }
            // react-router's turbo-stream plugins (single-fetch.ts).
            case "SingleFetchClassInstance": result = hydrate(value[1], depth + 1); break;
            case "SingleFetchRedirect": result = { redirect: hydrate(value[1], depth + 1) }; break;
            case "SingleFetchFallback": result = undefined; break;
            case "SanitizedError": case "ErrorResponse": result = null; break;
            default: result = null; // unknown extension type: no data, never a guess
        }
        hydrated.set(index, result);
        return result;
    };
    return hydrate(rootIndex, 0);
}

/** `{ routeId: loaderData }` for every route that returned data. */
export function routeLoaderData(decoded: any): Record<string, any> {
    const out: Record<string, any> = Object.create(null);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return out;
    for (const key of Object.keys(decoded)) {
        const entry = decoded[key];
        if (entry && typeof entry === "object" && !Array.isArray(entry) && "data" in entry) out[key] = entry.data;
    }
    return out;
}

/**
 * The turbo-stream text a React Router server render streams into its HTML:
 *   window.__reactRouterContext.streamController.enqueue("<chunk>");
 * Every chunk is a JSON string literal; they are read in document order and
 * joined. Parsed with JSON.parse (string literals only), never evaluated.
 * Returns null when the HTML carries no such chunk.
 */
export function routerStreamFromHtml(html: string): string | null {
    const text = String(html === undefined || html === null ? "" : html);
    if (text.length > TURBO_STREAM_MAX_BYTES * 2) return null;
    const marker = /streamController\.enqueue\(\s*"/g;
    const chunks: string[] = [];
    let total = 0;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(text)) !== null) {
        const open = match.index + match[0].length - 1;
        let i = open + 1;
        while (i < text.length) {
            const c = text.charAt(i);
            if (c === "\\") { i += 2; continue; }
            if (c === "\"" || c === "\n") break;
            i++;
        }
        if (text.charAt(i) !== "\"") return null;
        let chunk: any;
        try { chunk = JSON.parse(text.slice(open, i + 1)); } catch (_) { return null; }
        if (typeof chunk !== "string") return null;
        total += chunk.length;
        if (total > TURBO_STREAM_MAX_BYTES) return null;
        chunks.push(chunk);
        marker.lastIndex = i + 1;
    }
    return chunks.length ? chunks.join("") : null;
}
