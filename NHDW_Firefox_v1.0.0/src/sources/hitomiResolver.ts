// Hitomi image URL resolver (pure functions + a small cache).
//
// Source of truth: Hitomi's own common.js and gg.js, served from
// ltn.gold-usergeneratedcontent.net. Verified against the owner's sanitized
// capture (captures/hitomi-gg.js + the 2026-09-22 network HAR): every
// full-size page request in that capture is reproduced exactly.
//
//   https://{a|w}{1 + gg.m(g)}.gold-usergeneratedcontent.net/{gg.b}{g}/{hash}.{avif|webp}
//
//   * g     = parseInt(hash[-1] + hash[-3..-2], 16)   (gg.s(hash), decimal)
//   * gg.m  = a lookup table in gg.js ("case N: … o = V; break;", default "var o = D")
//   * gg.b  = a rotating path prefix such as "1790046002/"
//   * a = avif, w = webp (the extension letter picks the server family)
//
// gg.js changes regularly (the prefix and the table rotate), so it is read as
// TEXT and parsed with regular expressions — never executed — and re-read when
// the cached copy is older than HITOMI_GG_TTL_MS. If its shape ever changes in a
// way this parser does not recognise, parsing fails loudly instead of
// producing addresses that would quietly 404.

export const HITOMI_CONTENT_DOMAIN = "gold-usergeneratedcontent.net";
export const HITOMI_GG_URL = "https://ltn." + HITOMI_CONTENT_DOMAIN + "/gg.js";
/** Re-read gg.js after this long (it is served with max-age=3600). */
export const HITOMI_GG_TTL_MS = 10 * 60 * 1000;
const MAX_GG_BYTES = 1024 * 1024;

export interface HitomiImageFile {
    hash: string;
    haswebp?: number | boolean;
    hasavif?: number | boolean;
    name: string;
    width?: number;
    height?: number;
    single?: number;
}

export interface HitomiGg {
    /** Rotating path prefix, always digits followed by "/". */
    b: string;
    /** g -> server offset for every listed case. */
    m: { [g: number]: number };
    /** Offset for any g not listed. */
    defaultM: number;
}

/**
 * Parse gg.js as text. Returns null unless every part is recognised:
 * the switch table, its default, the prefix, and the expected s() formula
 * (the URL math below depends on it).
 */
export function parseHitomiGg(text: string): HitomiGg | null {
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_GG_BYTES) return null;
    const mStart = text.search(/\bm\s*:\s*function\s*\(\s*g\s*\)/);
    const sStart = text.search(/\bs\s*:\s*function\s*\(\s*h\s*\)/);
    if (mStart === -1 || sStart === -1 || sStart < mStart) return null;
    const mBody = text.slice(mStart, sStart);
    const sBody = text.slice(sStart, sStart + 300);
    // s(h) must be the known formula: parseInt(last + two-before-last, 16).
    if (!/\/\(\.\.\)\(\.\)\$\//.test(sBody) || !/parseInt\(\s*m\[2\]\s*\+\s*m\[1\]\s*,\s*16\s*\)/.test(sBody)) return null;
    if (!/switch\s*\(\s*g\s*\)/.test(mBody)) return null;
    const defaultMatch = /var\s+o\s*=\s*(\d)\s*;/.exec(mBody);
    if (!defaultMatch) return null;
    const m: { [g: number]: number } = {};
    let pending: number[] = [];
    let listed = 0;
    const token = /case\s+(\d{1,5})\s*:|o\s*=\s*(\d)\s*;\s*break\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = token.exec(mBody)) !== null) {
        if (match[1] !== undefined) {
            pending.push(Number(match[1]));
        } else {
            const value = Number(match[2]);
            for (const g of pending) { m[g] = value; listed++; }
            pending = [];
        }
    }
    // Cases with no assignment would be a shape this parser does not know.
    if (pending.length > 0 || listed === 0) return null;
    const bMatch = /\bb\s*:\s*['"](\d{1,16}\/)['"]/.exec(text);
    if (!bMatch) return null;
    return { b: bMatch[1], m: m, defaultM: Number(defaultMatch[1]) };
}

/** gg.s(hash) as a number: last hex digit, then the two before it. */
export function hitomiImageNumber(hash: string): number | null {
    const clean = String(hash || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) return null;
    return parseInt(clean.slice(-1) + clean.slice(-3, -1), 16);
}

function serverOffset(gg: HitomiGg, g: number): number {
    return Object.prototype.hasOwnProperty.call(gg.m, g) ? gg.m[g] : gg.defaultM;
}

/**
 * Full-size page URLs for one file, best first: the server gg.js assigns,
 * then the other server of the same family as a fallback.
 */
export function buildHitomiImageUrls(file: HitomiImageFile, gg: HitomiGg | null, preferAvif: boolean = true): string[] {
    if (!file || !gg) return [];
    const g = hitomiImageNumber(file.hash);
    if (g === null) return [];
    const hash = file.hash.trim().toLowerCase();
    const ext = preferAvif && file.hasavif ? "avif" : "webp";
    const letter = ext === "avif" ? "a" : "w";
    const primary = 1 + serverOffset(gg, g);
    const alternate = primary === 1 ? 2 : 1;
    const path = "/" + gg.b + g + "/" + hash + "." + ext;
    return [
        "https://" + letter + primary + "." + HITOMI_CONTENT_DOMAIN + path,
        "https://" + letter + alternate + "." + HITOMI_CONTENT_DOMAIN + path
    ];
}

// ---- cache --------------------------------------------------------------

let cachedGg: HitomiGg | null = null;
let cachedAt = 0;
let inFlight: Promise<HitomiGg> | null = null;

export function getHitomiGg(): HitomiGg | null {
    return cachedGg;
}

/** Test seam and manual override. */
export function setHitomiGg(gg: HitomiGg | null, at: number = Date.now()): void {
    cachedGg = gg;
    cachedAt = gg ? at : 0;
}

export type GgFetch = (url: string, init?: any) => Promise<any>;

/**
 * Make sure a fresh gg.js is loaded. Concurrent callers share one request.
 * A failed refresh keeps a previously good copy (and reports nothing); with no
 * copy at all it throws a message that names the problem.
 */
export async function ensureHitomiGg(fetchImpl: GgFetch, now: number = Date.now(), signal?: AbortSignal | null): Promise<HitomiGg> {
    if (cachedGg && now - cachedAt < HITOMI_GG_TTL_MS) return cachedGg;
    if (!inFlight) {
        inFlight = (async (): Promise<HitomiGg> => {
            let reason = "";
            try {
                const resp = await fetchImpl(HITOMI_GG_URL, {
                    credentials: "omit", cache: "no-store", redirect: "error", signal: signal || undefined
                });
                if (resp && resp.ok) {
                    const parsed = parseHitomiGg(await resp.text());
                    if (parsed) {
                        setHitomiGg(parsed, now);
                        return parsed;
                    }
                    reason = "its format was not recognised (Hitomi may have changed it; the adapter needs an update)";
                } else {
                    reason = "HTTP " + (resp ? resp.status : 0);
                }
            } catch (error: any) {
                if (signal && signal.aborted) throw error;
                reason = error && error.message ? error.message : "network error";
            }
            if (cachedGg) return cachedGg;
            throw new Error("Could not read Hitomi's image server map (gg.js): " + reason + ".");
        })();
        inFlight.then(() => { inFlight = null; }, () => { inFlight = null; });
    }
    return inFlight;
}
