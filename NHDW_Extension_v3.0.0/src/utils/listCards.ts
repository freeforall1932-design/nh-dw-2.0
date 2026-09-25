// ============================================================================
// STUB — item 63 (NOT IMPLEMENTED). Do not treat this as real logic.
//
// This file exists ONLY so the red-first suite in test/list-cards.test.js
// compiles and fails on purpose (a clean "not implemented" red) instead of
// crashing with MODULE_NOT_FOUND. The next session replaces it with the real
// per-site listing-card selector table. Contract the real module must satisfy
// (see test/list-cards.test.js for the exact expectations):
//
//   * LIST_CARD_TARGETS: one row per supported site, each with
//       mode:            'link' | 'card' | 'content'
//       linkSelector:    string            (cover-link selector)
//       linkPattern:     RegExp            (id extraction from the href)
//       containerSelector?: string         (card container; 'card' mode)
//       titleSelector?:  string            (caption/title; link+card mode)
//       captionSelector?: string           (caption inside the link; 'link' mode)
//       containerAncestorClass?: string    (hitomi '.gallery-content')
//   * listCardTargetForSite(site?: string) -> row | null
//   * resolveListCardPage(url) -> { site, target } | null  (LISTING urls only;
//     single-gallery / reader urls return null)
//   * cardIdFromHref(row, href) -> bare gallery id | null
//
// The rows must mirror the captured markup (see SESSION_HANDOFF "Next session
// — 63 card selector table"): nhentai caption-inside-link; hentaifox /
// imhentai / hentaiera card containers; hentaienvy article.hnv-gallery-card;
// hitomi .gallery-content heading blocks.
// ============================================================================

export const LIST_CARD_TARGETS: Record<string, any> = {
    nhentai: {},
    hentaiera: {},
    imhentai: {},
    hentaienvy: {},
    hentaifox: {},
    hitomi: {}
};

const notImplemented = (what: string): never => {
    throw new Error("listCards: " + what + " is NOT IMPLEMENTED (item 63 stub)");
};

export function listCardTargetForSite(_site?: string): any {
    return notImplemented("listCardTargetForSite");
}

export function resolveListCardPage(_url: string): any {
    return notImplemented("resolveListCardPage");
}

export function cardIdFromHref(_row: any, _href: string): string | null {
    return notImplemented("cardIdFromHref");
}
