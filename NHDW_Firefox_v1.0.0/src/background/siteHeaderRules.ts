// Session header rules for sites whose image servers check the request's
// page context (hitomi: Referer/Origin https://hitomi.la). The extension's own
// fetch (service worker / offscreen document) cannot set those headers — fetch
// forbids them — so a declarativeNetRequest session rule adds them.
//
// Scope, deliberately narrow:
//   * initiatorDomains = this extension's own origin host: only requests the
//     extension itself makes. On Chrome that host IS the extension id; on
//     Firefox it is the per-install moz-extension UUID (runtime.id there is
//     the gecko id, which never appears as an initiator) - Firefox's
//     ExtensionDNR evaluates an extension's own requests by that UUID. Chrome never applies one extension's rules to another
//     extension's requests, and the user's own browsing (initiator hitomi.la or
//     any other site) does not match, so the site behaves exactly as before.
//   * requestDomains = the adapter's content domain only.
//   * fetch-type requests only (no navigations, no frames).
// Permission: "declarativeNetRequestWithHostAccess" — no install warning; it
// only acts where host permissions already exist (these domains are granted).
// Session rules vanish when the browser closes, so the worker installs them on
// every start; the call replaces the whole id range, so it is idempotent.

export const SITE_HEADER_RULE_ID_BASE = 48100;
export const SITE_HEADER_RULE_ID_MAX = 48199;

export type ImageRequestContext = { domains: string[]; referer: string; origin: string };

function isHttpsOrigin(value: string): boolean {
    return /^https:\/\/[a-z0-9.-]+$/i.test(value);
}

function isHttpsPageUrl(value: string): boolean {
    return /^https:\/\/[a-z0-9.-]+\/[^\s]*$/i.test(value);
}

function isPlainDomain(value: string): boolean {
    return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value);
}

/** Build the rules for every adapter that declares an image request context. */
export function buildSiteHeaderRules(adapters: any[], extensionId: string): any[] {
    const rules: any[] = [];
    if (typeof extensionId !== "string" || !/^[a-z0-9_-]{8,64}$/i.test(extensionId)) {
        return rules;
    }
    for (const adapter of adapters || []) {
        if (!adapter || typeof adapter.getImageRequestContext !== "function") continue;
        let context: ImageRequestContext | null = null;
        try { context = adapter.getImageRequestContext(); } catch (_) { context = null; }
        if (!context || !Array.isArray(context.domains)) continue;
        const domains = context.domains.filter((d) => typeof d === "string" && isPlainDomain(d));
        if (domains.length === 0 || !isHttpsPageUrl(context.referer) || !isHttpsOrigin(context.origin)) continue;
        const id = SITE_HEADER_RULE_ID_BASE + rules.length;
        if (id > SITE_HEADER_RULE_ID_MAX) break;
        rules.push({
            id,
            priority: 1,
            action: {
                type: "modifyHeaders",
                requestHeaders: [
                    { header: "referer", operation: "set", value: context.referer },
                    { header: "origin", operation: "set", value: context.origin }
                ]
            },
            condition: {
                requestDomains: domains,
                initiatorDomains: [extensionId],
                resourceTypes: ["xmlhttprequest", "other"]
            }
        });
    }
    return rules;
}

/**
 * The host of this extension's own origin, as it appears as a request
 * initiator: chrome-extension://<id>/ on Chrome, moz-extension://<uuid>/ on
 * Firefox. Falls back to runtime.id when getURL is unavailable (old stubs).
 */
export function extensionInitiatorHost(runtime: any): string | null {
    try {
        if (runtime && typeof runtime.getURL === "function") {
            const match = /^(?:chrome|moz)-extension:\/\/([a-z0-9_-]+)\//i.exec(String(runtime.getURL("")));
            if (match) {
                return match[1].toLowerCase();
            }
        }
    } catch (_) { /* fall through */ }
    return runtime && typeof runtime.id === "string" ? runtime.id : null;
}

/**
 * Install (or refresh) the rules. Never throws: a browser without the API or
 * the permission just keeps today's behaviour (the open-tab fetch still works).
 */
export async function installSiteHeaderRules(chromeApi: any, adapters: any[]): Promise<boolean> {
    try {
        const dnr = chromeApi && chromeApi.declarativeNetRequest;
        const initiator = extensionInitiatorHost(chromeApi && chromeApi.runtime);
        if (!dnr || typeof dnr.updateSessionRules !== "function" || typeof initiator !== "string") {
            return false;
        }
        const rules = buildSiteHeaderRules(adapters, initiator);
        const removeRuleIds: number[] = [];
        for (let id = SITE_HEADER_RULE_ID_BASE; id <= SITE_HEADER_RULE_ID_MAX; id++) removeRuleIds.push(id);
        await dnr.updateSessionRules({ removeRuleIds, addRules: rules });
        return true;
    } catch (_) {
        return false;
    }
}
