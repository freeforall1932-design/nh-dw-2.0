/*
 * Small, self-contained diagnostic log for the extension.
 *
 * Why: a user reporting "it failed" only has the browser console, which is gone
 * after a reload and full of unrelated extension noise. This keeps a bounded,
 * redacted, exportable record of what the extension itself did — which URL was
 * inspected, how many pages were found, why a page failed — so a bug report can
 * include a file instead of a screenshot.
 *
 * Privacy rules are enforced on the way IN, not on export:
 *   * a URL keeps only scheme + host + path (query and fragment are dropped, so
 *     signed URLs and tokens never enter the log);
 *   * strings that look like base64 payloads are replaced by a length marker;
 *   * cookies, tokens, authorization headers and data URLs are dropped wholesale;
 *   * media bytes are never passed here at all.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
    at: number;
    level: LogLevel;
    area: string;
    message: string;
    data?: any;
}

export const LOG_CAP = 500;
export const LOG_STORAGE_KEY = "nhdwExtensionLog";
const MAX_STRING = 300;
const SENSITIVE_KEY = /^(?:cookie|cookies|set-cookie|authorization|auth|token|apikey|api_key|key|secret|password|signature|sig|base64|body|bytes|content)$/i;

function truncate(text: string): string {
    return text.length > MAX_STRING ? text.slice(0, MAX_STRING - 1) + "…" : text;
}

/** Keep origin + path of an absolute URL; discard query and fragment. */
export function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "<" + url.protocol + ">";
        return url.origin + url.pathname;
    } catch (_) {
        return truncate(value);
    }
}

function looksLikeBase64(value: string): boolean {
    return value.length >= 60 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

/** Recursively redact a value so it is safe to store and hand to the user. */
export function redactLogValue(value: any, depth: number = 0): any {
    if (value === null || value === undefined) return value;
    if (depth > 4) return "<depth>";
    if (typeof value === "string") {
        if (/^(?:data|blob):/i.test(value)) return "<" + value.slice(0, 5) + " payload>";
        if (/^https?:\/\//i.test(value)) return redactUrl(value);
        if (looksLikeBase64(value)) return "<base64 " + value.length + " chars>";
        return truncate(value);
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "function") return "<function>";
    if (Array.isArray(value)) return value.slice(0, 30).map(item => redactLogValue(item, depth + 1));
    if (typeof value === "object") {
        if (value instanceof Error) return { name: value.name, message: truncate(value.message), code: (value as any).code };
        const result: Record<string, any> = {};
        let count = 0;
        for (const key of Object.keys(value)) {
            if (count++ >= 40) break;
            if (SENSITIVE_KEY.test(key)) { result[key] = "<redacted>"; continue; }
            result[key] = redactLogValue(value[key], depth + 1);
        }
        return result;
    }
    return String(value);
}

export function makeLogEntry(level: LogLevel, area: string, message: string, data?: any, now: number = Date.now()): LogEntry {
    const entry: LogEntry = {
        at: now,
        level: level === "error" || level === "warn" ? level : "info",
        area: String(area || "general").slice(0, 40),
        message: truncate(String(message || ""))
    };
    if (data !== undefined) entry.data = redactLogValue(data);
    return entry;
}

/** Append to a buffer, dropping the oldest entries beyond the cap. */
export function appendLog(buffer: LogEntry[], entry: LogEntry, cap: number = LOG_CAP): LogEntry[] {
    const next = buffer.concat([entry]);
    return next.length > cap ? next.slice(next.length - cap) : next;
}

export function summarizeError(error: any): { message: string; code?: string; name?: string } {
    if (error === null || error === undefined) return { message: "Unknown error" };
    if (typeof error === "string") return { message: truncate(error) };
    const message = typeof error.message === "string" && error.message !== "" ? truncate(error.message) : String(error);
    const summary: { message: string; code?: string; name?: string } = { message };
    if (typeof error.code === "string" && error.code !== "") summary.code = error.code;
    if (typeof error.name === "string" && error.name !== "") summary.name = error.name;
    return summary;
}

function pad(value: number, width: number = 2): string {
    return String(value).padStart(width, "0");
}

export function formatLog(entries: LogEntry[], header?: Record<string, string>): string {
    const lines: string[] = [];
    lines.push("NHDW extension log");
    lines.push("generated: " + new Date().toISOString());
    if (header) {
        for (const key of Object.keys(header)) lines.push(key + ": " + header[key]);
    }
    lines.push("entries: " + entries.length + " (oldest first)");
    lines.push("");
    for (const entry of entries) {
        const when = new Date(entry.at);
        const stamp = when.getUTCFullYear() + "-" + pad(when.getUTCMonth() + 1) + "-" + pad(when.getUTCDate()) +
            "T" + pad(when.getUTCHours()) + ":" + pad(when.getUTCMinutes()) + ":" + pad(when.getUTCSeconds()) + "Z";
        let line = stamp + " " + entry.level.toUpperCase().padEnd(5) + " [" + entry.area + "] " + entry.message;
        if (entry.data !== undefined) {
            try { line += " " + JSON.stringify(entry.data); }
            catch (_) { line += " <unserialisable data>"; }
        }
        lines.push(line);
    }
    lines.push("");
    return lines.join("\n");
}
