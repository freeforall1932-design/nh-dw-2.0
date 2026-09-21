// WebExtension StorageArea.get result semantics, shared by offline fixtures.
// Object-form defaults do NOT grant access to any other stored keys. Array /
// string requests omit absent keys. Returned objects are clones, not aliases.
// Scheduling and mutation/event behavior belong to each harness's area stub.
function readStorage(store, keys) {
    const defaults = keys !== null && typeof keys === "object" && !Array.isArray(keys);
    const names = keys == null ? Object.keys(store)
        : typeof keys === "string" ? [keys]
        : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(names.flatMap((key) => {
        if (Object.hasOwn(store, key)) return [[key, structuredClone(store[key])]];
        if (defaults) return [[key, structuredClone(keys[key])]];
        return [];
    }));
}

module.exports = { readStorage };
