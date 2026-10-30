/*
 * Remembered image-host approvals for the chapter tool.
 *
 * Approval is per site (exact HTTPS origin), never global: a host approved for
 * one site must not silently authorize a request from another. The stored value
 * is only a hostname, never a URL, path or query, so nothing signed is kept.
 */

export const MAX_HOSTS_PER_ORIGIN = 30;
export type HostApprovalMap = Record<string, string[]>;

function validOrigin(origin: string): string | null {
    const value = String(origin || "").trim();
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(value)) return null;
    return value;
}

function validHost(host: string): string | null {
    const value = String(host || "").trim().toLowerCase();
    return /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value) ? value : null;
}

/** Hosts previously approved on this exact origin, in stored order. */
export function approvedHostsFor(map: HostApprovalMap | null | undefined, origin: string): string[] {
    const key = validOrigin(origin);
    if (!key || !map || typeof map !== "object") return [];
    const list = map[key];
    if (!Array.isArray(list)) return [];
    const result: string[] = [];
    for (const host of list) {
        const clean = validHost(host);
        if (clean && result.indexOf(clean) === -1) result.push(clean);
    }
    return result;
}

/** Return a new map with `hosts` remembered for `origin` (deduped, bounded). */
export function rememberHosts(map: HostApprovalMap | null | undefined, origin: string, hosts: string[]): HostApprovalMap {
    const key = validOrigin(origin);
    const next: HostApprovalMap = {};
    if (map && typeof map === "object") {
        for (const existing of Object.keys(map)) {
            const originKey = validOrigin(existing);
            if (!originKey) continue;
            const list = approvedHostsFor(map, originKey);
            if (list.length) next[originKey] = list;
        }
    }
    if (!key) return next;
    const merged = approvedHostsFor(next, key).slice();
    for (const host of Array.isArray(hosts) ? hosts : []) {
        const clean = validHost(host);
        if (clean && merged.indexOf(clean) === -1) merged.push(clean);
    }
    next[key] = merged.slice(0, MAX_HOSTS_PER_ORIGIN);
    return next;
}

/** Forget one origin only; other sites keep their approvals. */
export function forgetOrigin(map: HostApprovalMap | null | undefined, origin: string): HostApprovalMap {
    const key = validOrigin(origin);
    const next: HostApprovalMap = {};
    if (map && typeof map === "object") {
        for (const existing of Object.keys(map)) {
            const originKey = validOrigin(existing);
            if (!originKey || originKey === key) continue;
            const list = approvedHostsFor(map, originKey);
            if (list.length) next[originKey] = list;
        }
    }
    return next;
}
