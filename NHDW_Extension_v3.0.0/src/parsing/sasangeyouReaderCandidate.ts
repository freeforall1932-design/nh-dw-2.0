/*
 * Offline candidate reader-data parser, NOT an installed Sasangeyou adapter.
 *
 * A third-party MangaReader example suggests `ts_reader.run({sources: ...})`;
 * current Sasangeyou DOM and use of this pattern have NOT been verified. This
 * module never executes JavaScript, requests URLs, checks entitlement, chooses
 * a mirror, or removes possible inserts. Its locators are transient and must
 * not be logged or persisted. The eventual executor still needs observed DOM,
 * explicit host/redirect and byte validation, and permission/access checks.
 */

import { ReaderPagePlan, planReaderPages } from "../utils/chapterPlan";

export interface ReaderServerCandidate {
    /** Local to this parsed snapshot; select from the same snapshot. */
    id: string;
    label: string;
    /** Ordered candidate locators, including duplicates and ambiguous inserts. */
    locators: string[];
}

export type ReaderCandidateResult =
    | { kind: "candidates"; servers: ReaderServerCandidate[] }
    | { kind: "review"; reason: "no-marker" | "ambiguous-markers" | "invalid-data" | "invalid-locator" };

const MAX_SCRIPT_LENGTH = 4 * 1024 * 1024;
const MAX_SERVERS = 20;
const MAX_PAGES = 5000;

// Extract a single balanced JSON object beginning at `start`. Braces inside a
// JSON string are ignored; no eval, Function constructor, or site script runs.
function balancedJsonObject(text: string, start: number): string | null {
    if (text[start] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                // Reject extra arguments and expressions, not merely a JSON
                // prefix embedded in executable JavaScript.
                if (!/^\s*\)/.test(text.slice(i + 1))) return null;
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
}

function candidateLocator(value: unknown, baseUrl: string): string | null {
    if (typeof value !== "string" || value.length === 0 || value.length > 8192 ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
        const url = new URL(value, baseUrl);
        const host = url.hostname.toLowerCase();
        // This is only syntactic filtering, not a transfer allowlist or DNS
        // safety check. The unknown real image hosts must be reviewed later.
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
            host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
            /^\d+(?:\.\d+){3}$/.test(host) || host.indexOf(":") !== -1) return null;
        return url.href;
    } catch (_) {
        return null;
    }
}

/**
 * Parse one inline script in memory. A source is never selected implicitly;
 * selectReaderServer() consumes one of the returned objects from this exact
 * snapshot, so a reordered/reloaded page cannot silently change the choice.
 */
export function inspectSasangeyouReaderCandidate(script: string, readerUrl: string): ReaderCandidateResult {
    if (typeof script !== "string" || script.length > MAX_SCRIPT_LENGTH) return { kind: "review", reason: "invalid-data" };
    let base: URL;
    try {
        base = new URL(readerUrl);
        if (base.protocol !== "https:" || base.hostname.toLowerCase() !== "sasangeyou.net" || base.username || base.password || base.port) {
            return { kind: "review", reason: "invalid-data" };
        }
    } catch (_) {
        return { kind: "review", reason: "invalid-data" };
    }
    const marker = /\bts_reader\s*\.\s*run\s*\(/g;
    const first = marker.exec(script);
    if (!first) return { kind: "review", reason: "no-marker" };
    if (marker.exec(script)) return { kind: "review", reason: "ambiguous-markers" };
    let start = first.index + first[0].length;
    while (start < script.length && /\s/.test(script[start])) start++;
    const json = balancedJsonObject(script, start);
    if (json === null) return { kind: "review", reason: "invalid-data" };
    let data: any;
    try { data = JSON.parse(json); } catch (_) { return { kind: "review", reason: "invalid-data" }; }
    if (!data || !Array.isArray(data.sources) || data.sources.length === 0 || data.sources.length > MAX_SERVERS) {
        return { kind: "review", reason: "invalid-data" };
    }
    const servers: ReaderServerCandidate[] = [];
    for (let i = 0; i < data.sources.length; i++) {
        const source = data.sources[i];
        if (!source || !Array.isArray(source.images) || source.images.length === 0 || source.images.length > MAX_PAGES) {
            return { kind: "review", reason: "invalid-data" };
        }
        const rawLabel = typeof source.source === "string" ? source.source : (typeof source.name === "string" ? source.name : "");
        const label = rawLabel.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "Server " + (i + 1);
        const locators: string[] = [];
        for (const image of source.images) {
            const locator = candidateLocator(image, base.href);
            if (locator === null) return { kind: "review", reason: "invalid-locator" };
            locators.push(locator);
        }
        servers.push({ id: "server-" + (i + 1), label, locators });
    }
    return { kind: "candidates", servers };
}

/**
 * Convert an explicitly chosen candidate from the *same in-memory snapshot*
 * into the existing reader planner. Page references retain order and count
 * discrepancies. Selecting a candidate does not authorize downloading it.
 */
export function selectReaderServer(
    snapshot: ReaderCandidateResult,
    serverId: string,
    identity: { seriesId: string; chapterId: string; advertisedPageCount?: number | null }
): ReaderPagePlan {
    if (!snapshot || snapshot.kind !== "candidates") throw new Error("Reader candidates require review");
    const server = snapshot.servers.find(item => item.id === serverId);
    if (!server) throw new Error("Selected reader server is not in this snapshot");
    return planReaderPages({
        source: "sasangeyou",
        seriesId: identity.seriesId,
        chapterId: identity.chapterId,
        serverId: server.id,
        advertisedPageCount: identity.advertisedPageCount,
        pages: server.locators.map((url, index) => ({ id: "page-" + (index + 1), url, serverId: server.id }))
    });
}
