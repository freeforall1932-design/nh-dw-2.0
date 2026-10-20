// Cross-mirror fallback chains (item 72).
//
// The mirror network (imhentai / hentaienvy / hentaiera) facts this
// module encodes, all measured from the owner's captures and live
// tests (MULTISITE_V4_PLAN.md §2.2, "3 live testing note"):
//
//   * imhentai and hentaienvy share ONE content store: the same
//     /033/<token>/<n>.<ext> path is served from both sites' m-hosts
//     (token w62za5o4v3 appears on m11.imhentai.xxx AND
//     m11.hentaienvy.com in the captures; the owner's zip comparison
//     found the downloads byte-identical). Their gallery IDS are
//     disjoint (imhentai 1738518 = hentaienvy 1606086, same token),
//     so the imh<->envy route is a HOST SWAP on the token, never an
//     id lookup.
//   * hentaiera is a SEPARATE backend (hentaiera.site, numeric
//     media ids under /galleries/<media>/), so every route that
//     involves hentaiera is a TITLE MATCH: search the sibling for
//     the gallery's title and re-resolve the gallery there.
//   * Chain orders are the owner's recorded routing preferences
//     (live-testing note): era -> envy -> imh, envy -> era -> imh,
//     imh -> envy (token) -> era (title).
//
// The fallback is reactive: it only runs after a gallery's own
// mirrors have all failed to serve a real image, so it costs nothing
// while a site is healthy (the owner's "optional, and only if it
// doesn't affect performance" rule — hence the default-on setting).
//
// Pure module: no chrome.*, no fetch — runs in the service worker,
// the offscreen document and the plain-Node test sandboxes.

export type MirrorFallbackMode = "token" | "title";

export interface MirrorFallbackStep {
    site: string;
    mode: MirrorFallbackMode;
}

/** The throttle-routing chains, keyed by the site that is failing. */
export const MIRROR_FALLBACK_CHAINS: Record<string, MirrorFallbackStep[]> = {
    imhentai: [
        { site: "hentaienvy", mode: "token" },
        { site: "hentaiera", mode: "title" }
    ],
    hentaienvy: [
        { site: "hentaiera", mode: "title" },
        { site: "imhentai", mode: "token" }
    ],
    hentaiera: [
        { site: "hentaienvy", mode: "title" },
        { site: "imhentai", mode: "title" }
    ]
};

/** The chain for a site (empty for sites outside the mirror network). */
export function mirrorFallbackChainFor(site: string | null | undefined): MirrorFallbackStep[] {
    const key = String(site === undefined || site === null ? "" : site).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MIRROR_FALLBACK_CHAINS, key)) {
        return [];
    }
    return MIRROR_FALLBACK_CHAINS[key].slice();
}

// The shared /033/<token>/ content store, served from both twins'
// image hosts. Kept here (not in the adapters) so the twin lists
// live in ONE place; the test suite pins them against each
// adapter's own getImageUrls output.
export const MIRROR_STORE_HOSTS: Record<string, string[]> = {
    imhentai: [
        "https://m11.imhentai.xxx",
        "https://m1.imhentai.xxx",
        "https://m2.imhentai.xxx",
        "https://m3.imhentai.xxx",
        "https://m4.imhentai.xxx",
        "https://m5.imhentai.xxx"
    ],
    hentaienvy: [
        "https://m11.hentaienvy.com",
        "https://m1.hentaienvy.com",
        "https://m2.hentaienvy.com",
        "https://m3.hentaienvy.com",
        "https://m4.hentaienvy.com",
        "https://m5.hentaienvy.com"
    ]
};

/**
 * The shared-store URL list for a token on the named host site
 * ("imhentai" | "hentaienvy"). Same unpadded path, sibling hosts.
 */
export function sharedStoreImageUrls(token: string, filename: string, hostSite: string): string[] {
    const hosts = MIRROR_STORE_HOSTS[String(hostSite).trim().toLowerCase()];
    if (!hosts) return [];
    return hosts.map((server) => server + "/033/" + encodeURIComponent(String(token)) + "/" + filename);
}

// Page hosts of the mirror network, for the title-match search.
const MIRROR_PAGE_HOSTS: Record<string, string> = {
    imhentai: "https://imhentai.xxx",
    hentaienvy: "https://hentaienvy.com",
    hentaiera: "https://hentaiera.to"
};

/**
 * The mirror network's search URL. All three sites use the same
 * shape — <form action="/search/" method="get"> with an input
 * named "key" — measured from the three homepage captures.
 */
export function buildMirrorSearchUrl(site: string, title: string): string | null {
    const host = MIRROR_PAGE_HOSTS[String(site).trim().toLowerCase()];
    if (!host) return null;
    const query = String(title === undefined || title === null ? "" : title).trim();
    if (query === "") return null;
    return host + "/search/?key=" + encodeURIComponent(query);
}

/**
 * The query ladder for one title-match rung (item 73). The
 * owner's live note: hentaienvy's search answers like
 * nhentai's, but imhentai and hentaiera often return NOTHING
 * unless the query is worded like the full title — or searched
 * by tags instead. So the wording climbs: (1) the raw pretty
 * title (the best single shot — it is the full wording),
 * (2) the normalized title (when a bracketed group made the
 * raw wording land wrong), (3) the strongest tag term — an
 * artist name is the most distinctive query on this network,
 * then group/character, then any non-language tag. Each rung
 * is tried only when the previous search parses to zero
 * usable cards; duplicates are dropped so a bracket-free
 * title never searches twice.
 */
export function mirrorSearchQueryVariants(title: string | null | undefined, tags?: any[]): string[] {
    const raw = String(title === undefined || title === null ? "" : title).trim();
    // Without a title there is no ladder: the match picker
    // scores against the expected title, so a tag-only
    // query could never be accepted.
    if (raw === "") {
        return [];
    }
    const variants: string[] = [];
    const seen: string[] = [];
    const push = (query: string | null | undefined) => {
        const q = String(query === undefined || query === null ? "" : query).trim();
        // Search is case-insensitive, so a casing-only
        // variant is a wasted rung.
        if (q === "" || seen.indexOf(q.toLowerCase()) !== -1) {
            return;
        }
        seen.push(q.toLowerCase());
        variants.push(q);
    };
    // The owner's live note: envy search answers like
    // nhentai's, but imhentai and hentaiera often return
    // NOTHING unless the query is worded like the full
    // title — or searched by tags instead. So the wording
    // climbs: (1) the raw pretty title (the best single
    // shot — it is the full wording), (2) the normalized
    // title (when a bracketed group made the raw wording
    // land wrong), (3) the strongest tag term — an artist
    // name is the most distinctive query on this network,
    // then group/character, then any non-language tag.
    // Each rung is tried only when the previous search
    // parses to zero usable cards.
    push(raw);
    push(normalizeMirrorTitle(raw));
    const list = Array.isArray(tags) ? tags : [];
    const named = list
        .map((tag) => (typeof tag === "string" ? { name: tag } : tag))
        .filter((tag) => tag && typeof tag.name === "string" && (tag.name as string).trim() !== "");
    const term = named.find((tag) => tag.type === "artist")
        || named.find((tag) => tag.type === "group" || tag.type === "character" || tag.type === "parody")
        || named.find((tag) => tag.type !== "language");
    if (term) {
        push(term.name);
    }
    return variants;
}

/**
 * Normalize a gallery title for cross-site matching. The mirror
 * network's copies of one gallery carry the same title with cosmetic
 * differences (the owner's live note: underline instead of space,
 * differently placed translator groups), so normalization lowercases,
 * drops bracketed/parenthesized groups, unifies _- and whitespace to
 * single spaces and keeps CJK ranges intact.
 */
export function normalizeMirrorTitle(title: string | null | undefined): string {
    return String(title === undefined || title === null ? "" : title)
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/[_]+/g, " ")
        .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// One shared word is not a match (every title shares "the" with
// something); require either an exact normalized match or at least
// two shared tokens before scoring containment.
const MIN_SHARED_TOKENS = 2;

/**
 * Similarity of two titles, 0..1: 1 is an exact normalized match,
 * otherwise containment (shared tokens / the shorter side's tokens).
 * A shorter title fully contained in a longer one scores 1 — mirrors
 * routinely append "Vol. 2" or a translator group to the same title.
 */
export function mirrorTitleScore(titleA: string | null | undefined, titleB: string | null | undefined): number {
    const a = normalizeMirrorTitle(titleA as string);
    const b = normalizeMirrorTitle(titleB as string);
    if (a === "" || b === "") return 0;
    if (a === b) return 1;
    const tokensA = Array.from(new Set(a.split(" ").filter(Boolean)));
    const tokensB = Array.from(new Set(b.split(" ").filter(Boolean)));
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    const shared = tokensA.filter((token) => tokensB.indexOf(token) !== -1).length;
    if (shared < MIN_SHARED_TOKENS && Math.min(tokensA.length, tokensB.length) > 1) {
        return 0;
    }
    return shared / Math.min(tokensA.length, tokensB.length);
}

/**
 * A search-result card on a mirror site's listing. The search results
 * render the same card markup as the site's listings (the selectors
 * in utils/listCards.ts were measured from those captures).
 */
export interface MirrorSearchCard {
    id: string;
    title: string;
}

// Card containers, per site (measured from the captured homepages —
// the listing markup the search results reuse):
//   imhentai:  div.thumb        (cover link a[href="/gallery/<id>/"],
//                               title in h2.gallery_title > a)
//   hentaiera: div.thumb        (cover a.inner_thumb.img_box,
//                               title in h2.gallery_title > a)
//   hentaienvy: article.hnv-gallery-card (cover a.hnv-gallery-card__cover,
//                               title in h2.hnv-gallery-card__title > a)
const SEARCH_CARD_CONTAINER: Record<string, RegExp> = {
    // \s* before the closing quote: hentaiera's captured cards
    // carry a trailing space inside the class attribute
    // (<div class="thumb " >), imhentai's do not.
    imhentai: /<div class="thumb\s*"/gi,
    hentaiera: /<div class="thumb\s*"/gi,
    hentaienvy: /<article class="hnv-gallery-card"/gi
};

const SEARCH_CARD_TITLE: Record<string, RegExp> = {
    imhentai: /<h2 class="gallery_title">\s*<a[^>]*>([\s\S]*?)<\/a>/i,
    hentaiera: /<h2 class="gallery_title">\s*<a[^>]*>([\s\S]*?)<\/a>/i,
    hentaienvy: /<h2 class="hnv-gallery-card__title">\s*<a[^>]*>([\s\S]*?)<\/a>/i
};

const GALLERY_HREF_RE = /\/gallery\/([0-9]+)\//i;

const HTML_ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " "
};

function unescapeEntities(text: string): string {
    let out = text;
    for (const key of Object.keys(HTML_ENTITIES)) {
        out = out.split(key).join(HTML_ENTITIES[key]);
    }
    return out;
}

function cleanCardTitle(raw: string): string {
    return unescapeEntities(raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** Parse a mirror site's search-result (or listing) HTML into cards. */
export function parseMirrorSearchResults(html: string, site: string): MirrorSearchCard[] {
    const key = String(site === undefined || site === null ? "" : site).trim().toLowerCase();
    const container = SEARCH_CARD_CONTAINER[key];
    if (!container || typeof html !== "string" || html === "") {
        return [];
    }
    const starts: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = container.exec(html)) !== null) {
        starts.push(match.index);
    }
    container.lastIndex = 0;
    const cards: MirrorSearchCard[] = [];
    for (let i = 0; i < starts.length; i++) {
        const chunk = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length);
        const idMatch = GALLERY_HREF_RE.exec(chunk);
        if (idMatch === null) continue;
        const titleMatch = SEARCH_CARD_TITLE[key].exec(chunk);
        let title = titleMatch !== null ? cleanCardTitle(titleMatch[1]) : "";
        if (title === "") {
            // The cover's alt / aria-label carries the title too.
            const altMatch = /(?:alt|aria-label)=["']([^"']+)["']/i.exec(chunk);
            if (altMatch !== null) title = cleanCardTitle(altMatch[1]);
        }
        if (title === "") continue;
        cards.push({ id: idMatch[1], title: title });
    }
    return cards;
}

/**
 * The minimum containment score a search card must reach to be
 * accepted as the same gallery (below it, a "match" is a different
 * title that happens share a word or two).
 */
export const MIRROR_TITLE_MATCH_THRESHOLD = 0.9;

/**
 * Best title match among search-result cards, or null when nothing
 * clears the threshold. Scores tie-break in card order (the sites
 * rank relevance themselves, so the first card wins ties).
 */
export function pickMirrorTitleMatch(cards: MirrorSearchCard[], expectedTitle: string): MirrorSearchCard | null {
    let best: MirrorSearchCard | null = null;
    let bestScore = 0;
    for (const card of cards) {
        const score = mirrorTitleScore(expectedTitle, card.title);
        if (score > bestScore) {
            bestScore = score;
            best = card;
        }
    }
    if (best === null || bestScore < MIRROR_TITLE_MATCH_THRESHOLD) {
        return null;
    }
    return best;
}
