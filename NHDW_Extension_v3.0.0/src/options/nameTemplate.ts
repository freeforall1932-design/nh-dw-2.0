// Name-template helpers for the options page.
//
// The download engine (utils.getDownloadName) consumes a placeholder string
// like "{pretty} - {id}". Historically users typed that string by hand, which
// is slow and error-prone; the options page now offers one checkbox per
// placeholder and rebuilds the string from the checked boxes. These helpers
// keep the stored format unchanged, so old templates keep working and the
// download engine is untouched.

export const TEMPLATE_TOKENS = [
    "pretty",
    "english",
    "japanese",
    "id",
    "group",
    "artist",
    "character",
    "language"
] as const;

export type TemplateToken = (typeof TEMPLATE_TOKENS)[number];

// Which tokens the stored template uses (order-insensitive detection).
export function templateTokensInUse(template: string): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    const text = String(template || "");
    for (const token of TEMPLATE_TOKENS) {
        result[token] = text.indexOf("{" + token + "}") !== -1;
    }
    return result;
}

// True when the stored template is fully representable by the checkboxes:
// only known placeholders plus whitespace / simple separators. Anything else
// (literal words, custom ordering tricks) is a "custom" template and the
// options page falls back to the manual input so nothing is lost.
export function isTokenOnlyTemplate(template: string): boolean {
    const stripped = String(template || "").replace(
        /\{(pretty|english|japanese|id|group|artist|character|language)\}/g,
        ""
    );
    return /^[\s\-_,.()]*$/.test(stripped);
}

// True only when the stored template is EXACTLY what buildTemplate would
// produce for the tokens it contains: canonical token order AND the canonical
// separator. An empty template counts (that is what the boxes produce when
// nothing is ticked).
//
// Why this exists on top of isTokenOnlyTemplate (item 41): that function only
// answers "can these tokens be represented by the checkboxes at all?", and it
// accepts any simple separator. A template like "{pretty}_{id}" therefore
// passed it, and the first tick of ANY checkbox silently rewrote the
// separator to " - " ("{pretty}_{id}" -> "{pretty} - {id} - {artist}"). The
// checkbox builder may only be offered when building cannot change what the
// user already had.
export function isCanonicalTemplate(template: string, separator: string = " - "): boolean {
    const text = String(template || "");
    if (!isTokenOnlyTemplate(text)) {
        return false;
    }
    return buildTemplate(templateTokensInUse(text), separator) === text;
}

// Rebuild the placeholder string from the checked boxes, in the canonical
// display order, joined by the given separator. No boxes checked = empty
// template (the download engine then falls back to the gallery id name).
export function buildTemplate(checked: Record<string, boolean>, separator: string = " - "): string {
    const parts: Array<string> = [];
    for (const token of TEMPLATE_TOKENS) {
        if (checked && checked[token]) {
            parts.push("{" + token + "}");
        }
    }
    return parts.join(separator);
}
