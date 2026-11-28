'use strict';
// Pure mapping: API v2 gallery cards + tag dictionary -> INDEXER_PLAN.md §2
// index text (schema 1). No network, no fs — test-crawl.js drives every
// branch offline.
//
// Two card shapes exist in the wild (API_V2.md): listing cards may carry
// full tag objects (cards build the dictionary themselves) or bare
// `tag_ids` (the dictionary must come from the --tags dump). Both are
// mapped, and an unresolved tag id is dropped WITH a count, never guessed.

const INDEX_SCHEMA = 1;

// API tag type -> §2 namespace. `category` (manga/doujinshi) has no §2
// namespace yet (schema 1); its tag ids are mapped but the tag rows are
// skipped, so cards keep the ids and the dictionary stays honest.
const TAG_TYPE_TO_NS = {
    tag: 'tag',
    artist: 'artist',
    group: 'group',
    character: 'character',
    parody: 'parody',
    language: 'language',
    category: null,
};

const NS_RANK = { tag: 0, artist: 1, group: 2, character: 3, parody: 4, language: 5 };

function titleOf(card) {
    const t = card && card.title ? card.title : {};
    return card.english_title ||
        card.title_english ||
        (t && (t.english || t.pretty || t.japanese)) ||
        card.japanese_title ||
        card.title_japanese ||
        (typeof card.title === 'string' && card.title) ||
        String(card.id);
}

function pagesOf(card) {
    const n = card.num_pages !== undefined ? card.num_pages : card.page_count;
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function uploadedOf(card) {
    const n = card.upload_date !== undefined ? card.upload_date : card.uploaded;
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Thumbnail extension from a path string or a {path} object; null if unknown. */
function thumbExtOf(card) {
    const thumb = card && card.thumbnail;
    let path = '';
    if (typeof thumb === 'string') path = thumb;
    else if (thumb && typeof thumb.path === 'string') path = thumb.path;
    const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(path);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Map one card to a §2 row. Tag objects on the card are merged into `tags`
 * (first-wins on type conflicts). Bare tag ids not present in `tags` are
 * counted in `dropped` — the row carries only resolvable ids so the Browse
 * sidebar never shows a ghost chip.
 */
function cardToRow(card, tags, stats) {
    if (!card || card.id === undefined || card.id === null) {
        stats.skippedCards++;
        return null;
    }
    const id = String(card.id);
    if (stats.seenIds.has(id)) {
        stats.duplicateCards++;
        return null;
    }
    stats.seenIds.add(id);

    const mediaId = String(card.media_id !== undefined && card.media_id !== null ? card.media_id : id);

    let tagIds = [];
    if (Array.isArray(card.tags) && card.tags.length > 0 && typeof card.tags[0] === 'object') {
        for (const tag of card.tags) {
            if (!tag || !Number.isFinite(tag.id)) continue;
            const ns = TAG_TYPE_TO_NS[tag.type];
            if (!ns) continue; // unknown or namespace-less type (`category`): skip the tag, keep the card
            if (!tags.has(tag.id)) {
                tags.set(tag.id, { id: tag.id, ns, n: String(tag.name || ('tag ' + tag.id)), c: 0 });
            }
            tagIds.push(tag.id);
        }
    } else if (Array.isArray(card.tag_ids)) {
        for (const tagId of card.tag_ids) {
            if (!Number.isFinite(tagId)) continue;
            if (tags.has(tagId)) tagIds.push(tagId);
            else stats.droppedTagIds.add(tagId);
        }
    }
    tagIds = Array.from(new Set(tagIds)).sort((a, b) => a - b);

    const thumbExt = thumbExtOf(card);
    const row = [id, mediaId, titleOf(card), pagesOf(card), uploadedOf(card), tagIds];
    if (thumbExt) row.push(thumbExt);
    stats.mappedRows++;
    return row;
}

/** Recount `c` from the mapped rows — dictionary counts are computed, never trusted. */
function recountTags(tags, rows) {
    const usage = new Map();
    for (const row of rows) {
        for (const tagId of row[5]) usage.set(tagId, (usage.get(tagId) || 0) + 1);
    }
    const out = new Map();
    for (const [id, tag] of tags) {
        const ns = TAG_TYPE_TO_NS[tag.type] || tag.ns || null;
        if (!ns) continue; // `category` has no §2 namespace in schema 1
        out.set(id, { id, ns, n: tag.n, c: usage.get(id) || 0 });
    }
    return out;
}

function serializeIndexText(site, tags, rows) {
    const tagIds = Array.from(tags.keys()).sort((a, b) => a - b);
    const lines = [];
    lines.push(JSON.stringify({
        _meta: {
            schema: INDEX_SCHEMA,
            site,
            exported: new Date().toISOString().slice(0, 10),
            count: rows.length,
            tagCount: tagIds.length,
        },
    }));
    for (const id of tagIds) lines.push(JSON.stringify(Object.assign({ _t: 1 }, tags.get(id))));
    for (const row of rows) lines.push(JSON.stringify(row));
    return lines.join('\n') + '\n';
}

/**
 * Map a card JSONL file (one card object per line, as appended by the walk)
 * against a tag dictionary dump into the final §2 index text.
 */
function mapCardsFile(cardsText, tagsDump, site) {
    const stats = {
        skippedCards: 0,
        duplicateCards: 0,
        mappedRows: 0,
        droppedTagIds: new Set(),
        seenIds: new Set(),
    };
    const tags = new Map();
    for (const tag of tagsDump || []) {
        if (tag && Number.isFinite(tag.id)) {
            tags.set(tag.id, { id: tag.id, type: tag.type, ns: TAG_TYPE_TO_NS[tag.type] || null, n: String(tag.name || ('tag ' + tag.id)), c: Number.isFinite(tag.count) ? tag.count : 0 });
        }
    }

    const rows = [];
    for (const line of cardsText.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let card;
        try {
            card = JSON.parse(trimmed);
        } catch (_) {
            stats.skippedCards++;
            continue;
        }
        const row = cardToRow(card, tags, stats);
        if (row) rows.push(row);
    }

    const finalTags = recountTags(tags, rows);
    const text = serializeIndexText(site || 'nhentai', finalTags, rows);
    return {
        text,
        stats: {
            mappedRows: stats.mappedRows,
            skippedCards: stats.skippedCards,
            duplicateCards: stats.duplicateCards,
            droppedTagIds: Array.from(stats.droppedTagIds).sort((a, b) => a - b),
            tagCount: finalTags.size,
        },
    };
}

module.exports = {
    INDEX_SCHEMA,
    TAG_TYPE_TO_NS,
    titleOf,
    pagesOf,
    uploadedOf,
    thumbExtOf,
    cardToRow,
    recountTags,
    serializeIndexText,
    mapCardsFile,
};
