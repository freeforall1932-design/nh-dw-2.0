// Pure listing page-range helpers for item 61 (Download-tab range block).
// No DOM, no chrome.* — unit-tested under Node like the other utils.

export interface PageRangeResult {
    /** True when `pages` holds a usable, de-duplicated list. */
    ok: boolean;
    pages: number[];
    /** "" when ok; otherwise "syntax" | "pageNumber" | "bounds". */
    error: "" | "syntax" | "pageNumber" | "bounds";
    /** Echo of the maxPage bound for the UI messages. */
    maxPage: number;
}

/**
 * Parse a listing page-range expression against a known max page.
 * Accepts comma-separated singles and inclusive dash ranges: `1-5`, `2,4,6-10`.
 * Same rules the old #parseDownloadAll used (and the help text still documents).
 */
export function parsePageRange(text: string, maxPage: number): PageRangeResult {
    const pages: number[] = [];
    const fail = (error: PageRangeResult["error"]): PageRangeResult => ({
        ok: false,
        pages: [],
        error: error,
        maxPage: maxPage
    });

    if (!Number.isFinite(maxPage) || maxPage <= 0) {
        return fail("pageNumber");
    }

    const raw = typeof text === "string" ? text : "";
    if (raw.trim() === "") {
        return fail("syntax");
    }

    for (const part of raw.split(",")) {
        const elem = part.trim();
        if (elem === "") {
            return fail("syntax");
        }
        const dash = elem.split("-");
        if (dash.length > 1) {
            const lower = dash[0].trim();
            const upper = dash[1].trim();
            const lowerNb = parseInt(lower, 10);
            const upperNb = parseInt(upper, 10);
            if (lower !== String(lowerNb) || upper !== String(upperNb)) {
                return fail("syntax");
            }
            if (lowerNb < 0 || upperNb < 0 || lowerNb > maxPage || upperNb > maxPage) {
                return fail("pageNumber");
            }
            if (upperNb <= lowerNb) {
                return fail("bounds");
            }
            for (let i = lowerNb; i <= upperNb; i++) {
                if (pages.indexOf(i) === -1) {
                    pages.push(i);
                }
            }
        } else {
            const pageNb = parseInt(elem, 10);
            if (elem !== String(pageNb)) {
                return fail("syntax");
            }
            if (pageNb < 0 || pageNb > maxPage) {
                return fail("pageNumber");
            }
            if (pages.indexOf(pageNb) === -1) {
                pages.push(pageNb);
            }
        }
    }

    if (pages.length === 0) {
        return fail("syntax");
    }
    return { ok: true, pages: pages, error: "", maxPage: maxPage };
}

/**
 * Rewrite a listing URL onto page N. Matches the batchPipeline walk so the
 * range block and the download job always request the same URLs:
 * replace an existing page= param, else append with & or ?.
 */
export function listingUrlForPage(baseUrl: string, page: number): string {
    const url = typeof baseUrl === "string" ? baseUrl : "";
    const m = /page=([0-9]+)/.exec(url);
    if (m !== null) {
        return url.replace(m[0], "page=" + page);
    }
    if (url.indexOf("?") !== -1) {
        return url + "&page=" + page;
    }
    return url + "?page=" + page;
}
