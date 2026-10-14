// Style budget law (ASSET_PLAN.md "Style budget", DESIGN_REFERENCE.md "UI
// styling"): the visual layer is ONE small token file, css/theme.css, with at
// most 15 custom properties and element-level primitives; the component
// stylesheet only references those tokens. "Artistic but not bloated" is a
// number here, not a feeling - this file keeps the next restyle honest.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { collectRuntimeFiles } = require("../scripts/package-chrome");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("style budget - css/theme.css is a token file, not a redesign", function () {
    const theme = read("css/theme.css");
    const style = read("css/style.css");

    it("defines at most 15 custom properties (dark mode re-values, never adds)", function () {
        const names = new Set();
        for (const match of stripComments(theme).matchAll(/(--[a-z0-9-]+)\s*:/g)) {
            names.add(match[1]);
        }
        assert.ok(names.size > 0, "theme.css must define the tokens");
        assert.ok(names.size <= 15, "token cap exceeded: " + names.size + " custom properties (" + [...names].join(", ") + ")");
    });

    it("stays small and self-contained: no fonts, images, imports or keyframes", function () {
        assert.ok(Buffer.byteLength(theme, "utf8") <= 6 * 1024, "theme.css grew past 6 KB");
        for (const banned of ["url(", "@import", "@font-face", "@keyframes"]) {
            assert.strictEqual(stripComments(theme).indexOf(banned), -1, "theme.css must not use " + banned);
        }
    });

    it("names no component: tokens and element primitives only", function () {
        const selectors = [];
        for (const match of stripComments(theme).matchAll(/([^{}]+)\{/g)) {
            const selector = match[1].trim();
            if (selector !== "" && !selector.startsWith("@")) {
                selectors.push(selector);
            }
        }
        assert.ok(selectors.length > 0);
        for (const selector of selectors) {
            assert.ok(!/\./.test(selector), "class selector in theme.css (belongs in style.css): " + selector);
            assert.ok(!/#(?!htmlDark\b)/.test(selector), "id selector in theme.css: " + selector);
        }
    });

    it("is linked before style.css by the panel and linked by the options page", function () {
        const index = read("index.html");
        const themeAt = index.indexOf('href="css/theme.css"');
        const styleAt = index.indexOf('href="css/style.css"');
        assert.ok(themeAt !== -1 && styleAt !== -1 && themeAt < styleAt, "index.html must link theme.css, then style.css");
        assert.ok(read("options.html").indexOf('href="css/theme.css"') !== -1, "options.html must link theme.css");
        assert.ok(collectRuntimeFiles(root).includes("css/theme.css"), "theme.css must ship in the runtime package");
    });

    it("keeps hard-coded theme colours out of style.css", function () {
        const body = stripComments(style).toLowerCase();
        assert.strictEqual(body.indexOf("#e31b53"), -1, "the accent pink must come from var(--accent) / var(--accent-ink)");
        // Per-theme override pairs are what the tokens replaced; the single
        // survivor is the toolbar-icon swatch, which is deliberately not a token.
        const darkOverrides = body.match(/#htmldark\b/g) || [];
        assert.ok(darkOverrides.length <= 1, "style.css grew " + darkOverrides.length + " #htmlDark overrides; re-value a token instead");
        // Remaining literals are white-on-accent text and the icon swatch only.
        const literals = [...body.matchAll(/#[0-9a-f]{3,6}\b/g)].map((m) => m[0]);
        const allowed = new Set(["#fff", "#202a34", "#0d1117"]);
        for (const literal of literals) {
            assert.ok(allowed.has(literal), "new colour literal in style.css: " + literal + " - add a token or reuse one");
        }
    });
});
