// Independent expected values for item 59; do NOT use the production resolver
// to calculate its own test oracle. Every case runs against the real reader /
// bundled UI. Reuse the matrix across surfaces to prevent coverage drift.
const formats = ["zip", "cbz", "pdf", "raw"];
const formatCases = formats.flatMap((useZip) => [
    ...formats.map((listFormat) => ({
        label: `single ${useZip}, explicit list ${listFormat}`,
        stored: { useZip, listFormat }, expected: listFormat
    })),
    { label: `unset list inherits ${useZip}`, stored: { useZip }, expected: useZip },
    { label: `invalid list inherits ${useZip}`, stored: { useZip, listFormat: "invalid" }, expected: useZip }
]);
formatCases.push(
    { label: "fresh profile", stored: {}, expected: "zip" },
    { label: "null list inherits CBZ", stored: { useZip: "cbz", listFormat: null }, expected: "cbz" },
    { label: "blank list inherits raw", stored: { useZip: "raw", listFormat: "" }, expected: "raw" },
    { label: "legacy single folder inherits PDF", stored: { useZip: "folder" }, expected: "pdf" },
    { label: "legacy list folder overrides CBZ with PDF", stored: { useZip: "cbz", listFormat: "folder" }, expected: "pdf" },
    { label: "explicit ZIP overrides legacy single PDF", stored: { useZip: "folder", listFormat: "zip" }, expected: "zip" },
    { label: "neither invalid string is usable", stored: { useZip: "invalid", listFormat: "invalid" }, expected: "zip" },
    { label: "neither null value is usable", stored: { useZip: null, listFormat: null }, expected: "zip" },
    { label: "neither blank value is usable", stored: { useZip: "", listFormat: "" }, expected: "zip" },
    { label: "neither non-string value is usable", stored: { useZip: 42, listFormat: {} }, expected: "zip" },
    { label: "explicit PDF with no single-title preference", stored: { listFormat: "pdf" }, expected: "pdf" },
    { label: "explicit CBZ overrides invalid single-title preference", stored: { useZip: "invalid", listFormat: "cbz" }, expected: "cbz" }
);

function previewSuffix(format) {
    return format === "raw" ? "/001.jpg" : "." + format;
}

module.exports = { formats, formatCases, previewSuffix };
