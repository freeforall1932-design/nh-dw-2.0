// Shared batch download loop (item 32).
//
// Worker fallback and the offscreen document used to each maintain a copy of
// downloadAllDoujinshisAsync. They drifted (HTML second-chance, tab refetch,
// Authorization on the direct fetch, queued progress). THIS module is the
// single storage-free core; both hosts inject IO.
//
// MUST NOT import chrome.storage or chrome.downloads: the offscreen document
// only exposes chrome.runtime. Hosts wrap storage reads (worker) and artifact
// saves (offscreen saveUrl) outside this file.

import AParsing from "../parsing/AParsing";
import ApiParsing from "../parsing/ApiParsing";
import { parseGalleryCardsFromHtml } from "../parsing/CardParsing";
import { coerceGallery, extractGalleryFromHtml, looksLikeGallery, requireGallery } from "../parsing/GalleryEmbed";
import { fetchNhentaiApi } from "./apiAuth";
import { artifactRecordFilename, BatchOutcome, FailedGallery } from "./downloadHistory";
import { DEFAULT_SITE, GALLERY_KEY_SEPARATOR, normalizeSite, toGalleryKey, splitGalleryKey } from "./siteKeys";
import { resolveJobFormat } from "./downloadFormats";
import { clearnetSource } from "../sources/GallerySource";
import { getSourceForSite } from "../sources/index";
import { utils, classifyError, errorMessage } from "./utils";

export interface BatchJobOptions {
    useZip?: string;
    downloadSeparately?: boolean;
    downloadName?: string;
    duplicateBehaviour?: string;
    replaceSpaces?: boolean;
    maxConcurrentDownloads?: string | number;
    rawMaxConcurrent?: string | number;
    rawMasterFolder?: string;
    archiveMasterFolder?: string;
    apiKey?: string | null;
    useServerArchive?: boolean;
    alreadyDownloadedIds?: string[];
    redownloadIds?: string[];
    /**
     * The site every gallery of THIS job belongs to (item 48).
     *
     * Absent (or "nhentai") means the default site, which is what every
     * caller before item 48 sends, so nothing changes for them. The Queue tab
     * splits a multi-site selection into **one job per site** before sending
     * (MULTISITE_V4_PLAN.md §4.2), which is what lets a job keep bare gallery
     * ids in its payload - file names, `{id}` tokens, titles and every
     * user-facing message read the bare id - while every *store* lookup in
     * this file composes the composite key with this site. Without the split,
     * two same-numbered galleries from different sites would collapse into one
     * `allDoujinshis` entry and a hitomi row would be skip-checked against
     * `nhentai:<id>` history records.
     */
    site?: string;
}

export interface GalleryDownloadJob {
    json: any;
    path: string;
    zipName: string | null;
    displayName: string;
    zip: any;
    gallerySettings: any;
    sourceTabId?: number | null;
}

export interface BatchHost {
    parsing: AParsing;
    getAbortSignal(): AbortSignal | null;
    wasAborted(): boolean;
    isGalleryCancelled?: (key: string) => boolean;
    /** Extra fields on broadcasts (offscreen: from + queued). */
    messageExtras(): Record<string, any>;
    sendMessage(payload: any): void;
    errorCallback: Function;
    progressCallback: Function;
    fetchUrlFromTab(tabId: number, url: string): Promise<{ ok: boolean; status: number; statusText: string; contentType: string | null; text: string | null } | null>;
    fetchImpl(url: string, init?: any): Promise<any>;
    newZip(): any;
    downloadGallery(job: GalleryDownloadJob): Promise<void>;
}

const cancelledGalleries = new Set<string>();

// Cancel marks are ALWAYS composite `<site>:<id>` keys (items 47/48): the
// same number on two sites is two different galleries, so cancelling the
// hitomi row must never touch an in-flight nhentai batch entry with the same
// number. A bare id composes with the default site exactly like every other
// store. Marks are CONSUMED - by the batch loop when it skips the gallery,
// and by the hosts' cancel handlers when the cancel is enforced directly
// (aborting the active Downloader, filtering queued jobs) or when nothing is
// running at all - so one cancel can never make a gallery undownloadable
// for the lifetime of the document/worker (PR #48 review: a stale mark made
// the row's Retry and "Retry failed" fail instantly, forever).
export function cancelGallery(id: string | number, site?: string): boolean {
    const rawKey = String(id === undefined || id === null ? "" : id);
    if (!rawKey) return false;
    cancelledGalleries.add(toGalleryKey(rawKey, site));
    return true;
}

export function isGalleryCancelled(id: string | number, site?: string): boolean {
    const rawKey = String(id === undefined || id === null ? "" : id);
    if (!rawKey) return false;
    return cancelledGalleries.has(toGalleryKey(rawKey, site));
}

export function consumeGalleryCancellation(id: string | number, site?: string): void {
    const rawKey = String(id === undefined || id === null ? "" : id);
    if (!rawKey) return;
    cancelledGalleries.delete(toGalleryKey(rawKey, site));
}

export function resetCancelledGalleries(): void {
    cancelledGalleries.clear();
}

export function tryParseGalleryText(text: string): any | null {
    if (!text) return null;
    const trimmed = String(text).trim();
    if (trimmed.startsWith("{")) {
        try {
            const j = coerceGallery(JSON.parse(trimmed));
            if (j) return j;
        } catch (_) { /* not JSON */ }
    }
    const fromHtml = extractGalleryFromHtml(text);
    if (looksLikeGallery(fromHtml)) return fromHtml;
    return null;
}

export async function getGalleryViaTab(
    tabId: number,
    galleryId: string,
    parsing: AParsing,
    host: BatchHost
): Promise<any | null> {
    const urlsToTry: string[] = [];
    try {
        urlsToTry.push(parsing.GetUrl(galleryId));
    } catch (_) { /* parser refused */ }
    if (typeof clearnetSource.getApiUrl === "function") {
        urlsToTry.push(clearnetSource.getApiUrl(galleryId));
    }
    urlsToTry.push(clearnetSource.getGalleryUrl(galleryId));
    if (typeof clearnetSource.getGalleryPageUrl === "function") {
        urlsToTry.push(clearnetSource.getGalleryPageUrl(galleryId));
    } else {
        urlsToTry.push("https://nhentai.net/g/" + encodeURIComponent(galleryId) + "/1/");
    }
    const seen = new Set<string>();
    for (const url of urlsToTry) {
        if (seen.has(url)) continue;
        seen.add(url);
        try {
            const via = await host.fetchUrlFromTab(tabId, url);
            if (via && via.ok && via.text) {
                const parsed = tryParseGalleryText(via.text);
                if (parsed) return parsed;
                try {
                    const j = coerceGallery(JSON.parse(via.text));
                    if (j) return j;
                } catch (_) { /* not JSON */ }
            }
        } catch (_) { /* next URL */ }
    }
    return null;
}

export function buildRetryJob(sourceTabId: number | null | undefined, options: BatchJobOptions): any {
    // The retry must carry the format the job ACTUALLY used: hosts resolve the
    // per-job override against the stored default before calling in, so this
    // is the same value that named the artifact and the history record.
    const format = resolveJobFormat(options ? options.useZip : undefined);
    const job: any = { formatOverride: format };
    if (typeof sourceTabId === "number") job.tabId = sourceTabId;
    if (options && typeof options.downloadName === "string") job.nameTemplate = options.downloadName;
    const masterFolder = format === "raw"
        ? (options && typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : undefined)
        : (options && typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : undefined);
    if (typeof masterFolder === "string") job.masterFolder = masterFolder;
    // Item 48: a retry must come back to the site it failed on, or a hitomi row
    // would be re-fetched through the nhentai path. Only written when it is not
    // the default, so an nhentai retry payload stays byte-identical to 3.9.0.
    if (options && typeof options.site === "string" && options.site !== "" && normalizeSite(options.site) !== DEFAULT_SITE) {
        job.site = normalizeSite(options.site);
    }
    return job;
}

type MetadataOk = { ok: true; json: any };
type MetadataFail = { ok: false; status: number; statusText: string; contentType: string | null };

function headerContentType(resp: any): string | null {
    if (resp && resp.headers && typeof resp.headers.get === "function") {
        return resp.headers.get("content-type");
    }
    return null;
}

function replayableResponse(resp: any, body: string): any {
    const contentType = headerContentType(resp);
    return {
        ok: !!resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        headers: {
            get: (name: string) => (String(name).toLowerCase() === "content-type" ? contentType : null)
        },
        text: () => Promise.resolve(body)
    };
}

async function parseResponseGallery(resp: any, parsing: AParsing): Promise<any> {
    const body = typeof resp.text === "function" ? await resp.text() : "";
    const replay = replayableResponse(resp, body);
    let json: any = null;
    let parseError: any = null;
    try {
        json = await parsing.GetJsonAsync(replay);
    } catch (error) {
        parseError = error;
    }
    json = coerceGallery(json) || json;
    if (!looksLikeGallery(json)) {
        try {
            const htmlParsed = extractGalleryFromHtml(body);
            if (looksLikeGallery(htmlParsed)) json = htmlParsed;
        } catch (_) { /* keep json / parseError */ }
    }
    if (!looksLikeGallery(json) && parseError) {
        throw parseError;
    }
    return requireGallery(json);
}

export async function resolveGalleryMetadata(
    key: string,
    args: {
        galleryMetadata: Record<string, any>;
        apiKey: string;
        sourceTabId?: number | null;
        host: BatchHost;
        /**
         * The site of the JOB the gallery belongs to (item 48). Only consulted
         * for a bare key: a composite key ("hitomi:1234") carries its own site
         * and always wins, because that is the whole point of the composite
         * form. A bare key with no job site is the default site, exactly as
         * before.
         */
        site?: string;
    }
): Promise<MetadataOk | MetadataFail> {
    const { galleryMetadata, apiKey, sourceTabId, host } = args;
    const signal = host.getAbortSignal();
    const parsing = host.parsing;

    const rawKey = String(key === undefined || key === null ? "" : key);
    const parts = splitGalleryKey(rawKey);
    const site = rawKey.indexOf(GALLERY_KEY_SEPARATOR) !== -1 ? parts.site : normalizeSite(args.site);
    const id = parts.id;
    const adapter = getSourceForSite(site) || clearnetSource;

    if (galleryMetadata && (galleryMetadata[key] || galleryMetadata[id])) {
        // Either key works: callers built the map from whichever id they had.
        const candidate = galleryMetadata[key] || galleryMetadata[id];
        const json = requireGallery(candidate);
        if (!json.site) json.site = adapter.site;
        return { ok: true, json: json };
    }

    // Non-nhentai sites use their adapter
    if (adapter.site !== "nhentai") {
        const targetUrl = adapter.getGalleryUrl(id);
        let htmlText: string | null = null;
        let status = 0;
        let statusText = "";

        if (typeof sourceTabId === "number") {
            const viaTab = await host.fetchUrlFromTab(sourceTabId, targetUrl);
            if (viaTab && viaTab.ok && viaTab.text !== null) {
                htmlText = viaTab.text;
                status = viaTab.status;
                statusText = viaTab.statusText;
            }
        }
        if (!htmlText) {
            try {
                const resp = await host.fetchImpl(targetUrl, {
                    credentials: "include",
                    cache: "no-store",
                    signal: signal || undefined
                });
                status = resp ? resp.status : 0;
                statusText = resp ? String(resp.statusText || "") : "";
                if (resp && resp.ok) {
                    htmlText = typeof resp.text === "function" ? await resp.text() : "";
                }
            } catch (e: any) {
                statusText = String(e && e.message ? e.message : e);
            }
        }
        if (htmlText && adapter.extractGallery) {
            const extracted = adapter.extractGallery(htmlText);
            if (extracted && looksLikeGallery(extracted)) {
                if (!extracted.site) extracted.site = adapter.site;
                return { ok: true, json: requireGallery(extracted) };
            }
        }
        return {
            ok: false,
            status: status || 0,
            statusText: statusText || "Failed to fetch gallery metadata for " + key,
            contentType: "text/html"
        };
    }

    // Keyed official API first for nhentai.
    if (apiKey) {
        try {
            const keyedParsing = new ApiParsing();
            const keyedResp = await fetchNhentaiApi(
                keyedParsing.GetUrl(id),
                { credentials: "include", cache: "no-store", signal: signal || undefined },
                apiKey,
                { fetchImpl: host.fetchImpl }
            );
            if (keyedResp.ok) {
                const jsonKeyed = await keyedParsing.GetJsonAsync(keyedResp);
                if (jsonKeyed) {
                    if (!jsonKeyed.site) jsonKeyed.site = "nhentai";
                    return { ok: true, json: requireGallery(jsonKeyed) };
                }
            }
        } catch (error) {
            if (error && /not gallery metadata/.test(String((error as any).message || error))) {
                throw error;
            }
            // Fall through to the tab-based routes.
        }
    }

    if (typeof sourceTabId === "number") {
        const jsonViaTab = await getGalleryViaTab(sourceTabId, id, parsing, host);
        if (jsonViaTab) {
            if (!jsonViaTab.site) jsonViaTab.site = "nhentai";
            return { ok: true, json: requireGallery(jsonViaTab) };
        }
    }

    let resp: any = null;
    if (typeof sourceTabId === "number") {
        const viaTab = await host.fetchUrlFromTab(sourceTabId, parsing.GetUrl(id));
        if (viaTab && viaTab.ok && viaTab.text !== null) {
            resp = replayableResponse({
                ok: true,
                status: viaTab.status,
                statusText: viaTab.statusText,
                headers: { get: (name: string) => (String(name).toLowerCase() === "content-type" ? viaTab.contentType : null) }
            }, viaTab.text);
        }
    }
    if (!resp) {
        const headers: Record<string, string> = {};
        if (apiKey && String(apiKey).trim()) {
            headers["Authorization"] = "Key " + String(apiKey).trim();
        }
        try {
            resp = await host.fetchImpl(parsing.GetUrl(id), {
                credentials: "include",
                cache: "no-store",
                headers: headers,
                signal: signal || undefined
            });
        } catch (e) {
            resp = { ok: false, status: 0, statusText: String(e), headers: { get: () => null } };
        }
    }

    if (!resp || !resp.ok) {
        return {
            ok: false,
            status: resp ? resp.status : 0,
            statusText: resp ? String(resp.statusText || "") : "",
            contentType: headerContentType(resp)
        };
    }
    const finalGallery = await parseResponseGallery(resp, parsing);
    if (finalGallery && !finalGallery.site) finalGallery.site = "nhentai";
    return { ok: true, json: finalGallery };
}

export async function runBatchDownload(args: {
    zip: any;
    allDoujinshis: Record<string, string>;
    finalName: string;
    downloadAtEnd: boolean;
    galleryMetadata?: Record<string, any>;
    sourceTabId?: number | null;
    options?: BatchJobOptions;
    host: BatchHost;
}): Promise<BatchOutcome> {
    const options: BatchJobOptions = args.options || {};
    const host = args.host;
    const allDoujinshis = args.allDoujinshis;
    const galleryMetadata = args.galleryMetadata || {};
    const sourceTabId = args.sourceTabId;
    const zip = args.zip;
    const finalName = args.finalName;
    const downloadAtEnd = args.downloadAtEnd;

    const downloadName: string = options.downloadName || "{pretty}";
    const duplicateBehaviour: string = options.duplicateBehaviour || "rename";
    const replaceSpaces: boolean = options.replaceSpaces !== undefined ? options.replaceSpaces : true;
    const downloadSeparately: boolean = !!options.downloadSeparately;
    // Resolved ONCE here and handed to the Downloader below (see
    // gallerySettings.useZip): the history record, the retry job and the
    // produced file are all derived from this single value, so a caller that
    // omits the per-job override can never get a record saying ".zip" for a
    // ".cbz"/".pdf"/raw artifact (backlog item 33).
    const format: string = resolveJobFormat(options.useZip);
    const effectiveSeparate: boolean = downloadSeparately || format === "raw";
    const rawMasterFolder: string = typeof options.rawMasterFolder === "string" ? options.rawMasterFolder : "NHDW";
    const archiveMasterFolder: string = typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : "";
    const apiKey: string = options.apiKey ? String(options.apiKey) : "";
    // Item 48: every gallery of this job belongs to ONE site (the Queue tab
    // splits a mixed selection before it gets here). `storeKey` is the identity
    // a persistent store must see - history records, bookmark rows, the failed
    // list - while `bareId` is what the pipeline has always put in file names,
    // `{id}` tokens and messages. For a default-site job the two differ only by
    // the "nhentai:" prefix that the stores add anyway.
    const jobSite: string = normalizeSite(options.site);
    const storeKey = (id: string | number) => toGalleryKey(id, jobSite);
    const bareId = (id: string | number) => splitGalleryKey(storeKey(id)).id;

    const gallerySettings: any = {
        // The already-resolved format, not the raw request: normalization
        // happens once, above, instead of again inside every Downloader.
        useZip: format,
        maxConcurrentDownloads: options.maxConcurrentDownloads,
        rawMaxConcurrent: options.rawMaxConcurrent,
        archiveLayout: downloadSeparately ? "flat" : "nested",
        apiKey: apiKey || null,
        useServerArchive: !!options.useServerArchive,
        rawMasterFolder: rawMasterFolder,
        archiveMasterFolder: archiveMasterFolder
    };

    const names: Array<string> = [];
    const allKeys = Object.keys(allDoujinshis);
    const length = allKeys.length;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const failedKinds: Record<string, number> = {};
    // Composite keys (siteKeys.ts): the relayed recorded list carries
    // "site:id" keys, while this pipeline's gallery keys are bare ids, so
    // both sets normalize through toGalleryKey before any comparison. A bare
    // entry ("366224") reads as the default site, exactly like the history
    // that produced it.
    const alreadySet = new Set<string>(
        Array.isArray(options.alreadyDownloadedIds) ? options.alreadyDownloadedIds.map((id: string) => toGalleryKey(id, jobSite)) : []
    );
    const redownloadSet = new Set<string>(
        Array.isArray(options.redownloadIds) ? options.redownloadIds.map((id: string) => toGalleryKey(id, jobSite)) : []
    );
    const records: Array<{ id: string; filename: string }> = [];
    const batchKeys: string[] = [];
    let finalSaveOk = false;
    const failedGalleries: FailedGallery[] = [];
    const batchRetryJob = buildRetryJob(sourceTabId, options);

    function countFailure(key: string, error: any) {
        failed++;
        const { kind } = classifyError(error);
        failedKinds[kind] = (failedKinds[kind] || 0) + 1;
        failedGalleries.push({
            // The id stays bare (it is what the user sees and what the retry
            // payload is keyed by); the site is what makes a retry - and the
            // row's status update - land on the right gallery when two sites
            // use the same number.
            id: String(key),
            name: String(allDoujinshis[key] || key),
            error: errorMessage(error),
            site: jobSite
        });
    }

    function broadcast(payload: any) {
        host.sendMessage(Object.assign({}, host.messageExtras(), payload));
    }

    for (let i = 0; i < length; i++) {
        if (host.wasAborted()) {
            break;
        }
        const key = allKeys[i];
        if (isGalleryCancelled(key, jobSite) || (host.isGalleryCancelled && host.isGalleryCancelled(storeKey(key)))) {
            // Consume the mark with the skip: the cancel belonged to THIS job.
            // Keeping it would make every later job containing the gallery -
            // the row's Retry, "Retry failed", a re-pasted id - skip it again
            // instantly for as long as this document/worker lives.
            consumeGalleryCancellation(key, jobSite);
            countFailure(key, "Download was aborted");
            continue;
        }
        // The guard composes with THIS job's site (item 48), so a hitomi row is
        // never skipped because a same-numbered nhentai gallery was recorded.
        // The payload key stays bare; the store key is what is compared, and a
        // key that is already composite passes through untouched.
        if (effectiveSeparate && alreadySet.has(storeKey(key)) && !redownloadSet.has(storeKey(key))) {
            skipped++;
            continue;
        }
        broadcast({
            action: "batchProgress",
            current: i + 1,
            total: length,
            galleryName: allDoujinshis[key],
            stage: "Downloading"
        });

        let resolved: MetadataOk | MetadataFail;
        try {
            resolved = await resolveGalleryMetadata(storeKey(key), {
                galleryMetadata: galleryMetadata,
                apiKey: apiKey,
                sourceTabId: sourceTabId,
                host: host,
                site: jobSite
            });
        } catch (error) {
            countFailure(key, error);
            host.errorCallback("Can't download " + key + " (" + errorMessage(error) + ").");
            continue;
        }

        if (resolved.ok) {
            const json = resolved.json;
            const galleryId = bareId(key);
            let title = utils.getDownloadName(
                downloadName,
                json.title.pretty === ""
                    ? json.title.english.replace(/\[[^\]]+\]/g, "").replace(/\([^\)]+\)/g, "")
                    : json.title.pretty,
                json.title.english,
                json.title.japanese,
                galleryId,
                json.tags
            );
            if (names.includes(title)) {
                if (duplicateBehaviour === "ignore" && effectiveSeparate) {
                    skipped++;
                    continue;
                }
                let tmp = title;
                while (names.includes(tmp)) {
                    tmp = title + " (" + galleryId + ")";
                }
                title = tmp;
            }
            names.push(title);
            let zipName: string | null = null;
            if (effectiveSeparate) {
                zipName = utils.cleanName(title, replaceSpaces, galleryId);
            } else if (downloadAtEnd && i === length - 1) {
                zipName = finalName;
            }
            const isFinalSave = !effectiveSeparate && downloadAtEnd && i === length - 1;
            try {
                await host.downloadGallery({
                    json: json,
                    path: utils.cleanName(title, replaceSpaces, galleryId),
                    zipName: zipName,
                    displayName: allDoujinshis[key],
                    zip: effectiveSeparate ? host.newZip() : zip,
                    gallerySettings: gallerySettings,
                    sourceTabId: sourceTabId
                });
                succeeded++;
                if (isFinalSave) {
                    finalSaveOk = true;
                }
                if (effectiveSeparate) {
                    records.push({
                        // Composite (item 48): the history must file a hitomi
                        // gallery under "hitomi:<id>", or the next run skip-checks
                        // it against - and records it as - an nhentai gallery.
                        id: storeKey(key),
                        filename: artifactRecordFilename({
                            format: format,
                            name: zipName || utils.cleanName(title, replaceSpaces, galleryId),
                            masterFolder: format === "raw" ? rawMasterFolder : archiveMasterFolder
                        })
                    });
                } else {
                    batchKeys.push(storeKey(key));
                }
            } catch (error) {
                countFailure(key, error);
            }
        } else {
            const isCf = resolved.status === 503 || resolved.status === 403;
            const ct = (resolved.contentType || "").toLowerCase();
            const isHtml = ct.indexOf("html") !== -1;
            if (isCf || isHtml) {
                host.errorCallback("Can't download " + key + " - Cloudflare blocked the request (HTTP " + resolved.status + "). Open the gallery in a tab, complete any challenge, then try again.");
            } else {
                host.errorCallback("Can't download " + key + " (Code " + resolved.status + ": " + resolved.statusText + ").");
            }
            countFailure(key, "Can't download " + key + " (Code " + resolved.status + ": " + resolved.statusText + ").");
        }
    }

    if (!host.wasAborted()) {
        broadcast({
            action: "batchSummary",
            succeeded: succeeded,
            failed: failed,
            skipped: skipped,
            total: length,
            failedKinds: failedKinds,
            failedGalleries: failedGalleries,
            retryJob: batchRetryJob
        });
    }

    const clean = effectiveSeparate
        ? true
        : (failed === 0 && batchKeys.length > 0 && (!downloadAtEnd || finalSaveOk));
    return {
        records: records,
        clean: clean,
        batchKeys: batchKeys,
        skipped: skipped,
        failedGalleries: failedGalleries
    } as BatchOutcome;
}

async function fetchListingPage(url: string, sourceTabId: number | null | undefined, host: BatchHost): Promise<string | null> {
    if (typeof sourceTabId === "number") {
        try {
            const viaTab = await host.fetchUrlFromTab(sourceTabId, url);
            if (viaTab && viaTab.ok && viaTab.text) {
                return viaTab.text;
            }
        } catch (_) { /* fall through */ }
    }
    try {
        const resp = await host.fetchImpl(url, {
            credentials: "include",
            cache: "no-store",
            signal: host.getAbortSignal() || undefined
        });
        if (resp && resp.ok) {
            return await resp.text();
        }
    } catch (_) { /* listing page unavailable */ }
    return null;
}

export async function runPagedBatchDownload(args: {
    allDoujinshis: Record<string, string>;
    pagesArr: Array<number>;
    path: string;
    url: string;
    sourceTabId?: number | null;
    options?: BatchJobOptions;
    host: BatchHost;
}): Promise<BatchOutcome> {
    const options: BatchJobOptions = args.options || {};
    const host = args.host;
    const downloadName: string = options.downloadName || "{pretty}";
    const format: string = resolveJobFormat(options.useZip);
    const effectiveSeparate: boolean = !!(options.downloadSeparately || format === "raw");
    const pagesArr = args.pagesArr;
    let url = args.url;

    const allRecords: Array<{ id: string; filename: string }> = [];
    const allBatchKeys: string[] = [];
    const allFailed: FailedGallery[] = [];
    let allClean = true;
    let skippedTotal = 0;
    let pagesFetched = 0;
    const zip = host.newZip();

    for (let i = 0; i < pagesArr.length; i++) {
        const curr = pagesArr[i];
        const m = /page=([0-9]+)/.exec(url);
        if (m !== null) {
            url = url.replace(m[0], "page=" + curr);
        } else if (url.indexOf("?") !== -1) {
            url += "&page=" + curr;
        } else {
            url += "?page=" + curr;
        }
        const pageText = await fetchListingPage(url, args.sourceTabId, host);
        if (pageText !== null) {
            const cards = parseGalleryCardsFromHtml(pageText);
            const allDoujinshis: Record<string, string> = {};
            for (const card of cards) {
                let tmpName: string;
                if (downloadName === "{pretty}") {
                    tmpName = card.title.replace(/\[[^\]]+\]/g, "").replace(/\([^\)]+\)/g, "").replace(/\{[^\}]+\}/g, "").trim();
                } else {
                    tmpName = card.title.trim();
                }
                allDoujinshis[card.id] = tmpName;
            }
            const outcome = await runBatchDownload({
                zip: zip,
                allDoujinshis: allDoujinshis,
                finalName: args.path + " (" + curr + ")",
                downloadAtEnd: i === pagesArr.length - 1,
                galleryMetadata: {},
                sourceTabId: args.sourceTabId,
                options: options,
                host: host
            });
            allRecords.push.apply(allRecords, outcome.records);
            allBatchKeys.push.apply(allBatchKeys, outcome.batchKeys);
            allFailed.push.apply(allFailed, outcome.failedGalleries || []);
            skippedTotal += outcome.skipped;
            if (!outcome.clean) {
                allClean = false;
            }
            pagesFetched++;
        } else {
            allClean = false;
        }
    }

    const clean = effectiveSeparate
        ? true
        : (allClean && pagesFetched === pagesArr.length && pagesArr.length > 0);
    if (!effectiveSeparate && clean) {
        const finalName = args.path + " (" + String(pagesArr[pagesArr.length - 1]) + ")";
        const filename = artifactRecordFilename({
            format: format,
            name: finalName,
            masterFolder: typeof options.archiveMasterFolder === "string" ? options.archiveMasterFolder : ""
        });
        return {
            records: allBatchKeys.map((id) => ({ id: id, filename: filename })),
            clean: true,
            batchKeys: [],
            skipped: skippedTotal,
            failedGalleries: allFailed
        } as BatchOutcome;
    }
    return {
        records: effectiveSeparate ? allRecords : [],
        clean: clean,
        batchKeys: [],
        skipped: skippedTotal,
        failedGalleries: allFailed
    } as BatchOutcome;
}
