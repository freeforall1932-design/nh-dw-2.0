// Dummy-data mode (INDEXER_PLAN.md §5): the tab renders from this bundled
// sample until a real import exists, so the Browse UI is testable before any
// crawl. Site slug "sample" renders placeholder covers — no remote URLs, so
// the sample works fully offline (and the manifest test's no-hardcoded-URL
// rule holds for the built page).
//
// The tag ids here collide with nothing: they live in this source's own
// dictionary (per-source id spaces, per §2).

import { GalleryRow, IndexTag, ParsedIndex } from "./indexFormat";

const SAMPLE_TAGS: Array<Omit<IndexTag, "c">> = [
    { id: 17, ns: "tag", n: "vanilla" },
    { id: 385, ns: "tag", n: "comedy" },
    { id: 399, ns: "tag", n: "fantasy" },
    { id: 1403, ns: "tag", n: "school life" },
    { id: 2017, ns: "tag", n: "romance" },
    { id: 506, ns: "artist", n: "A. Kari" },
    { id: 869, ns: "artist", n: "M. Sora" },
    { id: 921, ns: "artist", n: "T. Hoshino" },
    { id: 199, ns: "parody", n: "original" },
    { id: 1223, ns: "language", n: "english" },
    { id: 637, ns: "language", n: "japanese" },
];

type SampleSpec = [string, string, string, number, number, number[]];

const SAMPLE_SPECS: SampleSpec[] = [
    ["900001", "m900001", "Sample Café [A. Kari]", 24, 1735689600, [17, 2017, 506, 1223, 199]],
    ["900002", "m900002", "Winter Letter [M. Sora]", 16, 1738368000, [17, 385, 869, 1223, 199]],
    ["900003", "m900003", "Dragon Wedding [T. Hoshino]", 210, 1740787200, [399, 2017, 921, 1223, 199]],
    ["900004", "m900004", "After-school Notes [A. Kari]", 20, 1743465600, [1403, 2017, 506, 1223, 199]],
    ["900005", "m900005", "Moonlit errand [M. Sora]", 12, 1746057600, [399, 385, 869, 1223, 199]],
    ["900006", "m900006", "Study group of five [A. Kari]", 32, 1748736000, [1403, 385, 506, 1223, 199]],
    ["900007", "m900007", "The baker's promise [T. Hoshino]", 28, 1751328000, [17, 2017, 921, 1223, 199]],
    ["900008", "m900008", "Sky garden [A. Kari]", 36, 1754006400, [399, 17, 506, 1223, 199]],
    ["900009", "m900009", "Rainy stopover [M. Sora]", 18, 1756684800, [385, 2017, 869, 1223, 199]],
    ["900010", "m900010", "Clay kingdoms [T. Hoshino]", 148, 1759363200, [399, 1403, 921, 1223, 199]],
    ["900011", "m900011", "Sunroom [A. Kari]", 8, 1762041600, [17, 385, 506, 1223, 199]],
    ["900012", "m900012", "Night market walk [M. Sora]", 22, 1764633600, [2017, 385, 869, 1223, 199]],
    ["900013", "m900013", "Petit fortune teller [T. Hoshino]", 26, 1767312000, [399, 385, 921, 1223, 199]],
    ["900014", "m900014", "Second half of spring [A. Kari]", 40, 1769990400, [17, 1403, 506, 1223, 199]],
    ["900015", "m900015", "Glass bells [M. Sora]", 14, 1772668800, [2017, 399, 869, 1223, 199]],
    ["900016", "m900016", "Hoshino sakura hon [T. Hoshino]", 96, 1775347200, [17, 2017, 921, 637, 199]],
    ["900017", "m900017", "Kari tanpenshuu [A. Kari]", 120, 1778025600, [385, 2017, 506, 637, 199]],
    ["900018", "m900018", "Sora no kiji [M. Sora]", 64, 1780617600, [399, 1403, 869, 637, 199]],
];

export function buildSampleIndex(): ParsedIndex {
    const rows: GalleryRow[] = SAMPLE_SPECS.map((spec) => [spec[0], spec[1], spec[2], spec[3], spec[4], spec[5]]);
    // Counts are computed from the rows, never hand-maintained: the sidebar
    // chip numbers and the dictionary stay honest if specs change.
    const usage = new Map<number, number>();
    for (const row of rows) {
        for (const tagId of row[5]) usage.set(tagId, (usage.get(tagId) || 0) + 1);
    }
    const tags = new Map<number, IndexTag>();
    for (const tag of SAMPLE_TAGS) tags.set(tag.id, { ...tag, c: usage.get(tag.id) || 0 });
    return {
        meta: { schema: 1, site: "sample", exported: "2026-11-26", count: rows.length, tagCount: tags.size },
        tags,
        rows,
    };
}

export const SAMPLE_LIBRARY: ParsedIndex = buildSampleIndex();
